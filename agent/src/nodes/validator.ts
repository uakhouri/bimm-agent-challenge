/**
 * Validator node — mechanical correctness check, no LLM.
 *
 * Runs `tsc --noEmit` and `vitest run` against the output directory. Parses
 * their output into structured ValidationError objects that downstream nodes
 * (Fixer, Router) can reason about without seeing raw stdout.
 *
 * Why no LLM here: compilation and test results are deterministic facts.
 * An LLM would add cost, latency, and probabilistic noise to a task that
 * has ground-truth answers. The two-layer validation design keeps this
 * node purely mechanical; the semantic judgment happens in the Judge node
 * after this one passes.
 */

import * as path from "node:path";
import {
  AgentState,
  AgentStateSchema,
  ValidationError,
  ValidationErrorSchema,
} from "../state.js";
import { writeFile } from "../tools/fs.js";
import { exec } from "../tools/shell.js";
import type { Tracer } from "../tracing/tracer.js";

// ---------------------------------------------------------------------------
// Dependencies.
// ---------------------------------------------------------------------------

export interface ValidatorDeps {
  tracer: Tracer;
  output_root: string;
}

// ---------------------------------------------------------------------------
// Public: runValidator.
// ---------------------------------------------------------------------------
//
// Orchestration:
//   1. Flush the latest artifacts to disk so the tools see current code.
//   2. Run typecheck and tests concurrently — they're independent and
//      running in parallel cuts wall-clock time roughly in half.
//   3. Parse each tool's output into ValidationError objects.
//   4. Merge and return.
//
// Side effect worth calling out: this node writes artifacts to disk. That's
// unavoidable — the tools need files to analyze. Every other node keeps
// artifacts in-memory, but validation has to materialize them. The write is
// idempotent: the same artifact written twice produces the same file.
// ---------------------------------------------------------------------------

export async function runValidator(
  state: AgentState,
  deps: ValidatorDeps,
): Promise<AgentState> {
  const span = deps.tracer.startSpan({ node: "validator" });

  try {
    await flushArtifactsToDisk(state, deps.output_root);

    const [typecheckErrors, testErrors] = await Promise.all([
      runTypecheck(deps.output_root, span, deps.tracer),
      runTests(deps.output_root, span, deps.tracer),
    ]);

    const errors: ValidationError[] = [...typecheckErrors, ...testErrors];

    const finishArgs: {
      status: "ok" | "error" | "escalated";
      error_message?: string;
    } = {
      status: errors.length === 0 ? "ok" : "error",
    };

    if (errors.length > 0) {
      finishArgs.error_message = `${errors.length} validation error(s)`;
    }

    span.finish(finishArgs);

    return AgentStateSchema.parse({
      ...state,
      errors,
      status: errors.length === 0 ? "judging" : "fixing",
    });
  } catch (caught) {
    const e = caught as Error;
    span.finish({ status: "error", error_message: e.message });
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// Materialize artifacts to disk.
// ---------------------------------------------------------------------------
//
// Uses the latest attempt per task — if the Fixer produced a new artifact
// for task T-005, we write that one, not the original Generator output.
// ---------------------------------------------------------------------------

async function flushArtifactsToDisk(
  state: AgentState,
  outputRoot: string,
): Promise<void> {
  const latestByTask = new Map<string, (typeof state.artifacts)[number]>();
  for (const artifact of state.artifacts) {
    const existing = latestByTask.get(artifact.task_id);
    if (!existing || artifact.attempt > existing.attempt) {
      latestByTask.set(artifact.task_id, artifact);
    }
  }

  for (const artifact of latestByTask.values()) {
    const writeResult = await writeFile({
      root: outputRoot,
      relativePath: artifact.path,
      contents: artifact.contents,
    });
    if (!writeResult.ok) {
      throw new Error(
        `Failed to write ${artifact.path}: ${writeResult.error.message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Typecheck — `tsc --noEmit` with structured output parsing.
// ---------------------------------------------------------------------------

async function runTypecheck(
  outputRoot: string,
  span: ReturnType<Tracer["startSpan"]>,
  tracer: Tracer,
): Promise<ValidationError[]> {
  span.recordToolCall("tsc");
  const shellResult = await exec("npm run typecheck", {
    cwd: outputRoot,
    timeout_ms: 2 * 60 * 1000,
  });

  if (!shellResult.ok) {
    return [
      validationError({
        file: "agent://validator",
        kind: "typecheck",
        message: `Typecheck command failed to run: ${shellResult.error.message}`,
        raw: shellResult.error.message,
      }),
    ];
  }

  if (shellResult.value.exit_code === 0) return [];

  return parseTypecheckOutput(
    shellResult.value.stdout + "\n" + shellResult.value.stderr,
  );
}
// ---------------------------------------------------------------------------
// Typecheck output parser.
// ---------------------------------------------------------------------------
//
// Format examples:
//   src/components/CarCard.tsx(12,5): error TS2322: Type 'X' is not...
//   src/hooks/useCars.ts(3,1): error TS2307: Cannot find module 'foo'...
//
// We capture path, line, code, and message. Anything that doesn't match
// this shape is skipped — it's usually noise like "Found N errors." or
// blank lines. If the parser misses a real error we notice downstream:
// the Fixer has nothing to fix and the retry budget exhausts, surfacing
// the gap as an escalation.
// ---------------------------------------------------------------------------

const TSC_ERROR_PATTERN =
  /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+?)$/gm;

function parseTypecheckOutput(raw: string): ValidationError[] {
  const errors: ValidationError[] = [];
  let match: RegExpExecArray | null;

  while ((match = TSC_ERROR_PATTERN.exec(raw)) !== null) {
    const [, file, lineStr, , code, message] = match;
    if (!file || !lineStr || !code || !message) continue;
    errors.push(
      validationError({
        file,
        line: Number.parseInt(lineStr, 10),
        kind: "typecheck",
        message: `${code}: ${message.trim()}`,
        raw: match[0],
      }),
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Tests — `vitest run --reporter=json` for structured output.
// ---------------------------------------------------------------------------

async function runTests(
  outputRoot: string,
  span: ReturnType<Tracer["startSpan"]>,
  tracer: Tracer,
): Promise<ValidationError[]> {
  span.recordToolCall("vitest");
  const shellResult = await exec("npx vitest run --reporter=json", {
    cwd: outputRoot,
    timeout_ms: 5 * 60 * 1000,
  });

  if (!shellResult.ok) {
    return [
      validationError({
        file: "agent://validator",
        kind: "test",
        message: `Test runner failed to start: ${shellResult.error.message}`,
        raw: shellResult.error.message,
      }),
    ];
  }

  if (shellResult.value.exit_code === 0) return [];

  return parseVitestOutput(shellResult.value.stdout, shellResult.value.stderr);
}

// ---------------------------------------------------------------------------
// Vitest JSON reporter parser.
// ---------------------------------------------------------------------------
//
// Vitest --reporter=json emits one JSON object at the end of stdout. The
// shape is documented in vitest.dev but the relevant fields for us are:
//   testResults[].testFilePath
//   testResults[].assertionResults[].status ("failed"|"passed"|"skipped")
//   testResults[].assertionResults[].fullName
//   testResults[].assertionResults[].failureMessages
//
// We extract failures only. Vitest's output can contain informational
// text before the JSON object — we locate the JSON by finding the last '{'
// that starts a valid JSON parse. If extraction fails we fall back to a
// single error pointing at the test runner, which the Fixer will surface.
// ---------------------------------------------------------------------------

interface VitestReport {
  testResults?: Array<{
    // Vitest JSON reporter puts the file path in `name`, not `testFilePath`.
    // `testFilePath` is kept for compatibility in case the format shifts back.
    name?: string;
    testFilePath?: string;
    assertionResults?: Array<{
      status?: string;
      fullName?: string;
      failureMessages?: string[];
    }>;
  }>;
}

function parseVitestOutput(stdout: string, stderr: string): ValidationError[] {
  const report = extractVitestReport(stdout);
  if (!report) {
    return [
      validationError({
        file: "agent://validator",
        kind: "test",
        message: `Vitest reported failures but output could not be parsed`,
        raw: stderr || stdout.slice(-800),
      }),
    ];
  }

  const errors: ValidationError[] = [];
  for (const tr of report.testResults ?? []) {
    const filePath = normalizeTestFilePath(tr.name ?? tr.testFilePath);
    for (const ar of tr.assertionResults ?? []) {
      if (ar.status !== "failed") continue;
      const failureText = (ar.failureMessages ?? []).join("\n");
      errors.push(
        validationError({
          file: filePath,
          kind: "test",
          message: `${ar.fullName ?? "unnamed test"}: ${firstLine(failureText)}`,
          raw: failureText || "(no failure message)",
        }),
      );
    }
  }

  if (errors.length === 0) {
    return [
      validationError({
        file: "agent://validator",
        kind: "test",
        message:
          "Vitest exited non-zero but no failing assertions were found in the report",
        raw: stderr.slice(-800),
      }),
    ];
  }

  return errors;
}

function extractVitestReport(stdout: string): VitestReport | null {
  const firstBrace = stdout.indexOf("{");
  if (firstBrace === -1) return null;
  const candidate = stdout.slice(firstBrace).trim();
  try {
    return JSON.parse(candidate) as VitestReport;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 200 ? line.slice(0, 200) + "..." : line;
}

// ---------------------------------------------------------------------------
// normalizeTestFilePath — convert absolute test file paths to relative.
// ---------------------------------------------------------------------------

function normalizeTestFilePath(absolute: string | undefined): string {
  if (!absolute) return "unknown.test.ts";
  const normalized = absolute.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/src/");
  if (idx === -1) return normalized;
  return normalized.slice(idx + 1); // drop leading "/" after src
}
// ---------------------------------------------------------------------------
// Validation error constructor — single place to validate the shape.
// ---------------------------------------------------------------------------

function validationError(args: {
  file: string;
  line?: number;
  kind: ValidationError["kind"];
  message: string;
  raw: string;
}): ValidationError {
  return ValidationErrorSchema.parse(args);
}
