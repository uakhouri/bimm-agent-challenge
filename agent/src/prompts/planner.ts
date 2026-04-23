/**
 * Planner prompt — spec → typed task DAG.
 *
 * This file is a pure function. No I/O, no LLM call. It builds the system
 * and user messages that the Planner node sends to the LLM. Keeping the
 * prompt construction here (not inside the node) means the prompt is a
 * versionable artifact: every change to the prompt is a visible commit
 * separate from changes to the wiring.
 *
 * Three design points baked into the prompt:
 *
 *   1. Anti-memorization rule. The model must derive task names from the
 *      spec, not from patterns in training data. This is the defense
 *      against the "car → CarCard" failure mode.
 *
 *   2. Boilerplate anchoring. The Planner is given the actual boilerplate
 *      file listing. Tasks reference real paths, not imagined ones.
 *
 *   3. Schema-first output. The prompt includes the JSON Schema derived
 *      from PlanSchema. The LLM returns JSON that's schema-validated at
 *      the node boundary, not text that we parse heuristically.
 */

import { z } from "zod";
import type { PlanSchema } from "../state.js";

// ---------------------------------------------------------------------------
// Public builder — returns { system, user } ready to pass to callLLMJson.
// ---------------------------------------------------------------------------

export interface PlannerPromptArgs {
  spec: string;
  boilerplate_files: string[];
  boilerplate_excerpts: Record<string, string>;
}

export interface PlannerPromptResult {
  system: string;
  user: string;
}

export function buildPlannerPrompt(
  args: PlannerPromptArgs,
): PlannerPromptResult {
  return {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(args),
  };
}

// ---------------------------------------------------------------------------
// System prompt — sets role, rules, and output contract.
// ---------------------------------------------------------------------------
//
// Written as a single constant because this is the stable part. Changes
// here are rare and intentional; changes to the user prompt are per-spec.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior React/TypeScript architect decomposing a product specification into an ordered, dependency-aware task graph for a code-generation agent.

The target project is already scaffolded with React 19, TypeScript, Vite, Apollo Client, Material UI, and MSW for mocked GraphQL. The agent will generate files into the existing boilerplate — it does not scaffold from scratch.

YOUR JOB
Read the specification and emit a plan: a list of tasks, each producing exactly one file, ordered so dependencies are generated before dependents.

RULES
1. One file per task. If two concerns belong in one file, they are one task. If they belong in separate files, they are separate tasks.
2. Dependencies are explicit. For every task, list the task IDs whose output files must exist first. A component that imports a hook depends on the task that creates the hook. A test that imports a component depends on the task that creates the component.
3. Use only file paths that fit the provided boilerplate layout. If the boilerplate has \`src/components/\`, new components go there. Do not invent directory structures.
4. Do not create tasks for files that already exist in the boilerplate unless the spec requires modifying them. The boilerplate includes App.tsx, main.tsx, GraphQL queries, MSW handlers, seed data, and an Example component — these are not tasks.
5. Derive task names from the specification text. Do not assume this is a car inventory, or a book library, or any other specific domain because you have seen many such examples. Read the spec and extract its actual domain.
6. Every task has at least one acceptance criterion — a plain-English checkable statement. "Renders a list of items from GraphQL" is a criterion. "Good code" is not.
7. Task kinds: "hook" for custom hooks, "component" for React components, "test" for tests, "entry" for App.tsx replacement or main.tsx modifications, "config" for non-source configuration changes.

OUTPUT FORMAT
Return ONLY a JSON object matching this schema:

{
  "tasks": [
    {
      "id": "T-001",
      "title": "short human-readable title",
      "kind": "hook" | "component" | "test" | "entry" | "config",
      "path": "src/path/to/file.ext",
      "depends_on": ["T-002", "T-003"],
      "acceptance": ["criterion 1", "criterion 2"]
    }
  ],
  "reasoning": "One paragraph explaining the decomposition strategy."
}

No prose before or after the JSON. No markdown fences. No commentary.`;

// ---------------------------------------------------------------------------
// User prompt builder — injects the spec and boilerplate context.
// ---------------------------------------------------------------------------

function buildUserPrompt(args: PlannerPromptArgs): string {
  const fileListing = args.boilerplate_files.map((f) => `  ${f}`).join("\n");

  const excerpts = Object.entries(args.boilerplate_excerpts)
    .map(([path, contents]) => buildExcerpt(path, contents))
    .join("\n\n");

  return `## SPECIFICATION

${args.spec}

## BOILERPLATE FILE LAYOUT

${fileListing}

## BOILERPLATE CONVENTIONS

The following excerpts show the conventions the generated code must match.

${excerpts}

## YOUR TASK

Emit a plan as JSON matching the schema in the system prompt. Derive task names from the specification above.`;
}

function buildExcerpt(filePath: string, contents: string): string {
  return `### ${filePath}

\`\`\`
${contents.trim()}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Schema alias — re-exported so the node imports from one place.
// ---------------------------------------------------------------------------

export type { PlanSchema };
