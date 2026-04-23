/**
 * Planner node — invokes the Planner prompt, validates the response, writes
 * the plan into state. Also initializes the per-task retry budget.
 *
 * Signature shape (same for every node): (state, deps) -> state. Pure from
 * the outside even though it calls the LLM inside. Every input is captured
 * in state; every output is captured in state; the tracer records what
 * happened between.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  AgentState,
  AgentStateSchema,
  PlanSchema,
  DEFAULT_RETRY_BUDGET,
} from "../state.js";
import { buildPlannerPrompt } from "../prompts/planner.js";
import { callLLMJson } from "../tools/llm.js";
import { readFile, exists } from "../tools/fs.js";
import type { Tracer } from "../tracing/tracer.js";

// ---------------------------------------------------------------------------
// Dependencies — the node accepts collaborators instead of importing them
// directly. Makes testing straightforward: substitute fakes when needed.
// ---------------------------------------------------------------------------

export interface PlannerDeps {
  tracer: Tracer;
  boilerplate_root: string;
}

// ---------------------------------------------------------------------------
// Boilerplate discovery — what files and excerpts does the planner see?
// ---------------------------------------------------------------------------
//
// The excerpt list is the "conventions anchor" — actual contents of the
// example files so the planner emits tasks that align with real code, not
// imagined code. The file listing is the structural anchor — the planner
// can only plan against files that exist or plausibly belong in the layout.
// ---------------------------------------------------------------------------

const EXCERPT_PATHS = [
  "src/components/Example.tsx",
  "src/__tests__/Example.test.tsx",
  "src/graphql/queries.ts",
  "src/types.ts",
] as const;

async function listBoilerplateFiles(root: string): Promise<string[]> {
  const entries: string[] = [];
  await walk(root, root, entries);
  return entries.sort();
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name === "node_modules" || item.name.startsWith(".")) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      await walk(root, full, out);
    } else {
      out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
}

async function gatherExcerpts(root: string): Promise<Record<string, string>> {
  const excerpts: Record<string, string> = {};
  for (const relative of EXCERPT_PATHS) {
    const full = path.join(root, relative);
    if (!(await exists(full))) continue;
    const readResult = await readFile(full);
    if (!readResult.ok) continue;
    excerpts[relative] = readResult.value;
  }
  return excerpts;
}

// ---------------------------------------------------------------------------
// Public: runPlanner.
// ---------------------------------------------------------------------------

export async function runPlanner(
  state: AgentState,
  deps: PlannerDeps,
): Promise<AgentState> {
  const span = deps.tracer.startSpan({ node: "planner" });

  try {
    const [files, excerpts] = await Promise.all([
      listBoilerplateFiles(deps.boilerplate_root),
      gatherExcerpts(deps.boilerplate_root),
    ]);

    const prompt = buildPlannerPrompt({
      spec: state.spec,
      boilerplate_files: files,
      boilerplate_excerpts: excerpts,
    });

    const result = await callLLMJson({
      role: "planner",
      system: prompt.system,
      user: prompt.user,
      schema: PlanSchema,
      schema_name: "Plan",
      max_tokens: 4096,
      temperature: 0,
    });

    if (!result.ok) {
      span.finish({
        status: "error",
        error_message: result.error.message,
      });
      return AgentStateSchema.parse({
        ...state,
        status: "escalated",
        errors: [
          ...state.errors,
          {
            file: "agent://planner",
            kind: "runtime",
            message: result.error.message,
            raw: JSON.stringify(result.error.raw ?? null),
          },
        ],
      });
    }

    span.attachLLMMetadata(result.value.meta);
    span.finish({ status: "ok" });

    const retry_budget: Record<string, number> = {};
    for (const task of result.value.value.tasks) {
      retry_budget[task.id] = DEFAULT_RETRY_BUDGET;
    }

    return AgentStateSchema.parse({
      ...state,
      plan: result.value.value,
      retry_budget,
      status: "generating",
    });
  } catch (caught) {
    const e = caught as Error;
    span.finish({ status: "error", error_message: e.message });
    throw caught;
  }
}
