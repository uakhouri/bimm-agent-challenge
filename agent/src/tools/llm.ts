/**
 * LLM wrapper — the single entry point for every Anthropic API call.
 *
 * Every node in the agent talks to the LLM through this file. The wrapper
 * handles four concerns so the nodes don't have to:
 *
 *   1. Model selection by role (planner/generator/judge/fixer).
 *   2. Schema-validated structured output via zod.
 *   3. Token and cost accounting for the tracer.
 *   4. One cheap retry on malformed JSON.
 *
 * Keeping this layer thin and focused is deliberate — the provider could be
 * swapped (OpenAI, Gemini) with a ~30 line change because nothing outside
 * this file imports the Anthropic SDK directly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Result, ok, err, ToolError, toolError } from "./result.js";

// ---------------------------------------------------------------------------
// Model registry.
// ---------------------------------------------------------------------------
//
// Roles are semantic; models are physical. The registry maps roles to
// specific model strings so if Anthropic releases Sonnet 5 we change one
// line here and the whole agent picks it up. Nodes never reference model
// strings directly — they ask for a role.
// ---------------------------------------------------------------------------

export type LLMRole = "planner" | "generator" | "judge" | "fixer";

const MODEL_REGISTRY: Record<LLMRole, string> = {
  planner: "claude-sonnet-4-5",
  generator: "claude-sonnet-4-5",
  fixer: "claude-sonnet-4-5",
  judge: "claude-haiku-4-5",
};

// ---------------------------------------------------------------------------
// Price table for cost accounting.
// ---------------------------------------------------------------------------
//
// Prices are per-million-tokens, in USD. Separate input and output rates
// reflect Anthropic's pricing. Updating this table is the only way cost
// calculations change.
// ---------------------------------------------------------------------------

interface PriceRow {
  input_per_mtok: number;
  output_per_mtok: number;
}

const PRICE_TABLE: Record<string, PriceRow> = {
  "claude-sonnet-4-5": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "claude-haiku-4-5": { input_per_mtok: 1.0, output_per_mtok: 5.0 },
};

function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const row = PRICE_TABLE[model];
  if (!row) return 0;
  return (
    (inputTokens * row.input_per_mtok) / 1_000_000 +
    (outputTokens * row.output_per_mtok) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// Call metadata — the observability payload.
// ---------------------------------------------------------------------------

export interface LLMCallMetadata {
  model: string;
  role: LLMRole;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  retries: number;
}

// ---------------------------------------------------------------------------
// Text call — plain request, plain response.
// ---------------------------------------------------------------------------
//
// Used for diagnostic prompts and any call that doesn't need structured
// output. Returns the raw text plus metadata.
// ---------------------------------------------------------------------------

export interface TextCallArgs {
  role: LLMRole;
  system: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
}

export interface TextCallResult {
  text: string;
  meta: LLMCallMetadata;
}

// ---------------------------------------------------------------------------
// JSON call — schema-validated structured output.
// ---------------------------------------------------------------------------
//
// The important one. Caller passes a zod schema; we handle prompt-level
// "return only JSON" instruction, parsing, validation, and one retry on
// failure. Returns either a typed T or a structured error the caller can
// push into state.
// ---------------------------------------------------------------------------

export interface JsonCallArgs<T> {
  role: LLMRole;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schema_name: string;
  max_tokens?: number;
  temperature?: number;
}

export interface JsonCallResult<T> {
  value: T;
  meta: LLMCallMetadata;
}

// ---------------------------------------------------------------------------
// Client singleton — lazy so imports don't fail without API key.
// ---------------------------------------------------------------------------

let clientSingleton: Anthropic | null = null;

function getClient(): Result<Anthropic, ToolError> {
  if (clientSingleton) return ok(clientSingleton);

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.startsWith("sk-ant-...")) {
    return err(
      toolError({
        kind: "command_failed",
        message:
          "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.",
      }),
    );
  }

  clientSingleton = new Anthropic({ apiKey });
  return ok(clientSingleton);
}

// ---------------------------------------------------------------------------
// Public: callLLMText.
// ---------------------------------------------------------------------------

export async function callLLMText(
  args: TextCallArgs,
): Promise<Result<TextCallResult, ToolError>> {
  const clientResult = getClient();
  if (!clientResult.ok) return clientResult;

  const model = MODEL_REGISTRY[args.role];
  const startedAt = Date.now();

  try {
    const response = await clientResult.value.messages.create({
      model,
      max_tokens: args.max_tokens ?? 4096,
      temperature: args.temperature ?? 0,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    });

    const duration_ms = Date.now() - startedAt;
    const text = extractText(response);
    const input_tokens = response.usage.input_tokens;
    const output_tokens = response.usage.output_tokens;

    return ok({
      text,
      meta: {
        model,
        role: args.role,
        input_tokens,
        output_tokens,
        cost_usd: computeCostUsd(model, input_tokens, output_tokens),
        duration_ms,
        retries: 0,
      },
    });
  } catch (caught) {
    const e = caught as Error;
    return err(
      toolError({
        kind: "command_failed",
        message: `LLM call failed (${args.role}): ${e.message ?? e}`,
        raw: e,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Public: callLLMJson.
// ---------------------------------------------------------------------------

export async function callLLMJson<T>(
  args: JsonCallArgs<T>,
): Promise<Result<JsonCallResult<T>, ToolError>> {
  const clientResult = getClient();
  if (!clientResult.ok) return clientResult;

  const model = MODEL_REGISTRY[args.role];
  const startedAt = Date.now();

  // First attempt.
  const firstAttempt = await callOnce(clientResult.value, model, args, null);
  if (!firstAttempt.ok) return firstAttempt;

  const parsedFirst = tryParseAndValidate(firstAttempt.value.text, args.schema);
  if (parsedFirst.ok) {
    return ok({
      value: parsedFirst.value,
      meta: {
        model,
        role: args.role,
        input_tokens: firstAttempt.value.input_tokens,
        output_tokens: firstAttempt.value.output_tokens,
        cost_usd: computeCostUsd(
          model,
          firstAttempt.value.input_tokens,
          firstAttempt.value.output_tokens,
        ),
        duration_ms: Date.now() - startedAt,
        retries: 0,
      },
    });
  }

  // Retry with the validation error included in the prompt.
  const secondAttempt = await callOnce(
    clientResult.value,
    model,
    args,
    parsedFirst.error,
  );
  if (!secondAttempt.ok) return secondAttempt;

  const parsedSecond = tryParseAndValidate(
    secondAttempt.value.text,
    args.schema,
  );
  if (!parsedSecond.ok) {
    return err(
      toolError({
        kind: "command_failed",
        message: `LLM returned invalid JSON after retry (${args.role}, schema=${args.schema_name}): ${parsedSecond.error}`,
        raw: {
          first_response: firstAttempt.value.text,
          second_response: secondAttempt.value.text,
          validation_error: parsedSecond.error,
        },
      }),
    );
  }

  const total_input =
    firstAttempt.value.input_tokens + secondAttempt.value.input_tokens;
  const total_output =
    firstAttempt.value.output_tokens + secondAttempt.value.output_tokens;

  return ok({
    value: parsedSecond.value,
    meta: {
      model,
      role: args.role,
      input_tokens: total_input,
      output_tokens: total_output,
      cost_usd: computeCostUsd(model, total_input, total_output),
      duration_ms: Date.now() - startedAt,
      retries: 1,
    },
  });
}

// ---------------------------------------------------------------------------
// Internal: one raw call to the API.
// ---------------------------------------------------------------------------
//
// If previousError is provided, we tack a correction block onto the user
// message telling the model exactly what went wrong last time. This is the
// targeted retry — tiny context cost, usually fixes format drift immediately.
// ---------------------------------------------------------------------------

interface RawCallResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
}

async function callOnce<T>(
  client: Anthropic,
  model: string,
  args: JsonCallArgs<T>,
  previousError: string | null,
): Promise<Result<RawCallResult, ToolError>> {
  const userMessage = previousError
    ? `${args.user}\n\nYour previous response failed schema validation:\n${previousError}\n\nReturn valid JSON matching the requested schema. No prose, no markdown fences.`
    : args.user;

  const systemMessage = `${args.system}\n\nIMPORTANT: Respond with valid JSON only. No prose, no markdown fences, no commentary.`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: args.max_tokens ?? 4096,
      temperature: args.temperature ?? 0,
      system: systemMessage,
      messages: [{ role: "user", content: userMessage }],
    });

    return ok({
      text: extractText(response),
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
  } catch (caught) {
    const e = caught as Error;
    return err(
      toolError({
        kind: "command_failed",
        message: `LLM call failed: ${e.message ?? e}`,
        raw: e,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Internal: extract text content from an Anthropic message response.
// ---------------------------------------------------------------------------

function extractText(response: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Internal: strip markdown fences if the model added them despite being told
// not to, then parse as JSON, then validate against zod. Returns the parsed
// T or a string description of what failed.
// ---------------------------------------------------------------------------

function tryParseAndValidate<T>(
  raw: string,
  schema: z.ZodType<T>,
): Result<T, string> {
  const stripped = stripFences(raw).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return err(
      `JSON parse error: ${(e as Error).message}. Raw: ${stripped.slice(0, 200)}`,
    );
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return err(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return ok(validated.data);
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const withoutOpening = trimmed.replace(/^```(json|JSON)?\s*/, "");
    return withoutOpening.replace(/\s*```$/, "");
  }
  return trimmed;
}
