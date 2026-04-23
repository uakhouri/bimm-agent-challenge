/**
 * Generator node — one task in, one file out.
 *
 * The generator is called once per task, in dependency order. It reads the
 * task's dependency files from disk (previous generator outputs), pulls few-
 * shot examples from the boilerplate, builds the prompt, calls the LLM,
 * validates the response, and returns new state with the artifact appended.
 *
 * It does not write the file to disk — that's the orchestrator's job, after
 * the validator has had a chance to catch mechanical failures. Keeping the
 * generator pure in that sense means retry cycles don't leave stale files
 * behind.
 */

import * as path from "node:path";
import { z } from "zod";
import {
  AgentState,
  AgentStateSchema,
  FileArtifact,
  FileArtifactSchema,
  Task,
} from "../state.js";
import {
  buildGeneratorPrompt,
  DependencyFile,
  FewShotExample,
  FEW_SHOT_BY_KIND,
} from "../prompts/generator.js";
import { callLLMJson } from "../tools/llm.js";
import { readFile, exists } from "../tools/fs.js";
import type { Tracer } from "../tracing/tracer.js";

// ---------------------------------------------------------------------------
// Dependencies.
// ---------------------------------------------------------------------------

export interface GeneratorDeps {
  tracer: Tracer;
  boilerplate_root: string;
  output_root: string;
}

// ---------------------------------------------------------------------------
// Schema for the LLM's JSON response.
// ---------------------------------------------------------------------------
//
// The LLM returns a shape simpler than FileArtifact — just path + contents.
// We wrap that into a full FileArtifact with task_id and attempt at the
// node level. Keeps the LLM's output schema minimal, which makes the
// prompt simpler and failure modes fewer.
// ---------------------------------------------------------------------------

const GeneratorResponseSchema = z.object({
  path: z.string().min(1),
  contents: z.string().min(1),
});
type GeneratorResponse = z.infer<typeof GeneratorResponseSchema>;

// ---------------------------------------------------------------------------
// Boilerplate conventions — hand-picked rules that the prompt emphasizes.
// ---------------------------------------------------------------------------
//
// These are rules that are easy to miss from examples alone. The path alias
// rule, for instance — an LLM looking at Example.tsx might write relative
// imports anyway because that's the pattern it sees most in training. The
// explicit conventions list pins the rules that matter.
// ---------------------------------------------------------------------------

const BOILERPLATE_CONVENTIONS = [
  "Imports inside src/ use the @/ alias: @/graphql/queries, @/types, @/components/Foo",
  "Components default-export; hooks and helpers are named exports",
  "Tests use @apollo/client/testing's MockedProvider; mock data includes __typename: 'X' as const",
  "MUI imports are flat: import { Card, CardContent } from '@mui/material'",
  "Every generated file is TypeScript — .ts for hooks/helpers, .tsx for components/tests",
];

// ---------------------------------------------------------------------------
// Dependency file resolution.
// ---------------------------------------------------------------------------
//
// For each depends_on entry, we find the corresponding task, read the file
// from either previous artifacts (in-memory) or the output directory
// (written by the orchestrator after validation). Previous artifacts take
// precedence because they're more recent.
// ---------------------------------------------------------------------------

async function resolveDependencies(
  task: Task,
  state: AgentState,
  outputRoot: string,
): Promise<DependencyFile[]> {
  if (!state.plan) return [];
  const deps: DependencyFile[] = [];

  for (const depId of task.depends_on) {
    const depTask = state.plan.tasks.find((t) => t.id === depId);
    if (!depTask) continue;

    const fromArtifact = state.artifacts
      .filter((a) => a.task_id === depId)
      .sort((a, b) => b.attempt - a.attempt)[0];

    if (fromArtifact) {
      deps.push({ path: depTask.path, contents: fromArtifact.contents });
      continue;
    }

    const diskPath = path.join(outputRoot, depTask.path);
    if (await exists(diskPath)) {
      const readResult = await readFile(diskPath);
      if (readResult.ok) {
        deps.push({ path: depTask.path, contents: readResult.value });
      }
    }
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Few-shot loading.
// ---------------------------------------------------------------------------

async function loadFewShotExamples(
  task: Task,
  boilerplateRoot: string,
): Promise<FewShotExample[]> {
  const paths = FEW_SHOT_BY_KIND[task.kind] ?? [];
  const examples: FewShotExample[] = [];

  for (const relative of paths) {
    const full = path.join(boilerplateRoot, relative);
    if (!(await exists(full))) continue;
    const readResult = await readFile(full);
    if (!readResult.ok) continue;
    examples.push({
      description: describeExample(relative),
      path: relative,
      contents: readResult.value,
    });
  }

  return examples;
}

function describeExample(relativePath: string): string {
  if (relativePath.endsWith(".test.tsx")) return "reference test";
  if (relativePath.includes("components/")) return "reference component";
  if (relativePath.includes("graphql/")) return "GraphQL operations";
  return "reference file";
}

// ---------------------------------------------------------------------------
// Attempt counter.
// ---------------------------------------------------------------------------

function nextAttemptNumber(state: AgentState, taskId: string): number {
  const priors = state.artifacts.filter((a) => a.task_id === taskId);
  return priors.length + 1;
}

// ---------------------------------------------------------------------------
// Public: runGenerator — produce the next pending task's file.
// ---------------------------------------------------------------------------
//
// "Next pending task" = the first task in the plan with no current-attempt
// artifact. Order of the plan is dependency order, so this is straight
// iteration. When every task has a current attempt, the generator phase is
// complete and the router transitions to validation.
// ---------------------------------------------------------------------------

export async function runGenerator(
  state: AgentState,
  deps: GeneratorDeps,
): Promise<AgentState> {
  if (!state.plan) {
    throw new Error("runGenerator called before plan exists");
  }

  const taskIdArg = findNextPendingTask(state);
  if (!taskIdArg) {
    return AgentStateSchema.parse({ ...state, status: "validating" });
  }

  const task = state.plan.tasks.find((t) => t.id === taskIdArg);
  if (!task) {
    throw new Error(`Task ${taskIdArg} not found in plan`);
  }

  const span = deps.tracer.startSpan({ node: "generator" });

  try {
    const [dependencyFiles, fewShot] = await Promise.all([
      resolveDependencies(task, state, deps.output_root),
      loadFewShotExamples(task, deps.boilerplate_root),
    ]);

    const prompt = buildGeneratorPrompt({
      task,
      spec: state.spec,
      dependency_files: dependencyFiles,
      few_shot_examples: fewShot,
      boilerplate_conventions: BOILERPLATE_CONVENTIONS,
    });

    const result = await callLLMJson<GeneratorResponse>({
      role: "generator",
      system: prompt.system,
      user: prompt.user,
      schema: GeneratorResponseSchema,
      schema_name: "GeneratorResponse",
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
        errors: [
          ...state.errors,
          {
            file: task.path,
            kind: "runtime",
            message: result.error.message,
            raw: JSON.stringify(result.error.raw ?? null),
          },
        ],
      });
    }

    span.attachLLMMetadata(result.value.meta);
    span.finish({ status: "ok" });

    const artifact: FileArtifact = FileArtifactSchema.parse({
      task_id: task.id,
      path: task.path,
      contents: result.value.value.contents,
      attempt: nextAttemptNumber(state, task.id),
    });

    return AgentStateSchema.parse({
      ...state,
      artifacts: [...state.artifacts, artifact],
    });
  } catch (caught) {
    const e = caught as Error;
    span.finish({ status: "error", error_message: e.message });
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// Public helper — used by the router to know when generation is complete.
// ---------------------------------------------------------------------------

export function findNextPendingTask(state: AgentState): string | null {
  if (!state.plan) return null;
  const completed = new Set(state.artifacts.map((a) => a.task_id));
  for (const task of state.plan.tasks) {
    if (!completed.has(task.id)) return task.id;
  }
  return null;
}
