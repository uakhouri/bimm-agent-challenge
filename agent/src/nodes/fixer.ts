/**
 * Fixer node — takes a failing file and its errors, produces a corrected
 * version. Decrements the retry budget for the task.
 *
 * The router decides which task gets fixed next. This node handles ONE task
 * per invocation. Separating "which task to fix" (router) from "how to fix
 * it" (this node) keeps retry policy visible in the router and generation
 * mechanics visible here.
 */

import * as path from "node:path";
import { z } from "zod";
import {
  AgentState,
  AgentStateSchema,
  FileArtifact,
  FileArtifactSchema,
  Task,
  ValidationError,
  DEFAULT_RETRY_BUDGET,
} from "../state.js";
import { buildFixerPrompt } from "../prompts/fixer.js";
import { callLLMJson } from "../tools/llm.js";
import { readFile, exists } from "../tools/fs.js";
import type { Tracer } from "../tracing/tracer.js";

// ---------------------------------------------------------------------------
// Dependencies.
// ---------------------------------------------------------------------------

export interface FixerDeps {
  tracer: Tracer;
  boilerplate_root: string;
  output_root: string;
}

// ---------------------------------------------------------------------------
// LLM response schema.
// ---------------------------------------------------------------------------

const FixerResponseSchema = z.object({
  path: z.string().min(1),
  contents: z.string().min(1),
});
type FixerResponse = z.infer<typeof FixerResponseSchema>;

// ---------------------------------------------------------------------------
// Public: runFixer — fix the given task's file.
// ---------------------------------------------------------------------------
//
// The router supplies the task_id. We gather the errors for that file, load
// the current contents, build the prompt, call the LLM, and append a new
// artifact with an incremented attempt number. The retry budget decrements
// by one.
// ---------------------------------------------------------------------------

export async function runFixer(
  state: AgentState,
  taskId: string,
  deps: FixerDeps,
): Promise<AgentState> {
  if (!state.plan) {
    throw new Error("runFixer called before plan exists");
  }

  const task = state.plan.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`runFixer: task ${taskId} not found in plan`);
  }

  const span = deps.tracer.startSpan({ node: "fixer" });

  try {
    const currentContents = await loadCurrentContents(state, task, deps);
    if (currentContents === null) {
      span.finish({
        status: "error",
        error_message: `Could not load current contents for ${task.path}`,
      });
      return appendRuntimeError(
        state,
        task.path,
        `Fixer could not locate current contents for ${task.path}`,
      );
    }

    const errorsForFile = filterErrorsForTask(state.errors, task);
    if (errorsForFile.length === 0) {
      span.finish({
        status: "error",
        error_message: `Fixer invoked but no errors apply to task ${taskId}`,
      });
      return state;
    }

    const [declaredDeps, ambientDeps] = await Promise.all([
      resolveDependencyFiles(task, state, deps.output_root),
      loadAmbientFilesForFixer(deps.boilerplate_root, deps.output_root),
    ]);

    const dependencyFiles = mergeDependenciesForFixer(
      declaredDeps,
      ambientDeps,
    );

    const attemptNumber = currentAttemptNumber(state, task.id) + 1;
    const budget = state.retry_budget[task.id] ?? DEFAULT_RETRY_BUDGET;

    const prompt = buildFixerPrompt({
      task,
      spec: state.spec,
      current_contents: currentContents,
      errors: errorsForFile,
      attempt_number: attemptNumber,
      max_attempts: DEFAULT_RETRY_BUDGET,
      dependency_files: dependencyFiles,
    });

    const result = await callLLMJson<FixerResponse>({
      role: "fixer",
      system: prompt.system,
      user: prompt.user,
      schema: FixerResponseSchema,
      schema_name: "FixerResponse",
      max_tokens: 4096,
      temperature: 0,
    });

    if (!result.ok) {
      span.finish({
        status: "error",
        error_message: result.error.message,
      });
      return appendRuntimeError(state, task.path, result.error.message);
    }

    span.attachLLMMetadata(result.value.meta);
    span.finish({ status: "ok" });

    const artifact: FileArtifact = FileArtifactSchema.parse({
      task_id: task.id,
      path: task.path,
      contents: result.value.value.contents,
      attempt: attemptNumber,
    });

    const nextBudget: Record<string, number> = {
      ...state.retry_budget,
      [task.id]: Math.max(0, budget - 1),
    };

    return AgentStateSchema.parse({
      ...state,
      artifacts: [...state.artifacts, artifact],
      errors: [],
      retry_budget: nextBudget,
      status: "validating",
    });
  } catch (caught) {
    const e = caught as Error;
    span.finish({ status: "error", error_message: e.message });
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function loadCurrentContents(
  state: AgentState,
  task: Task,
  deps: FixerDeps,
): Promise<string | null> {
  const latest = state.artifacts
    .filter((a) => a.task_id === task.id)
    .sort((a, b) => b.attempt - a.attempt)[0];
  if (latest) return latest.contents;

  const diskPath = path.join(deps.output_root, task.path);
  if (await exists(diskPath)) {
    const readResult = await readFile(diskPath);
    if (readResult.ok) return readResult.value;
  }

  return null;
}

function filterErrorsForTask(
  errors: ValidationError[],
  task: Task,
): ValidationError[] {
  return errors.filter((e) => {
    if (e.file === task.path) return true;
    // Typecheck paths can be relative to the output root; match by suffix.
    return e.file.endsWith(task.path);
  });
}

async function resolveDependencyFiles(
  task: Task,
  state: AgentState,
  outputRoot: string,
): Promise<Array<{ path: string; contents: string }>> {
  if (!state.plan) return [];
  const deps: Array<{ path: string; contents: string }> = [];

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

function currentAttemptNumber(state: AgentState, taskId: string): number {
  const priors = state.artifacts.filter((a) => a.task_id === taskId);
  if (priors.length === 0) return 0;
  return Math.max(...priors.map((a) => a.attempt));
}

function appendRuntimeError(
  state: AgentState,
  filePath: string,
  message: string,
): AgentState {
  return AgentStateSchema.parse({
    ...state,
    errors: [
      ...state.errors,
      {
        file: filePath,
        kind: "runtime",
        message,
        raw: message,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Ambient dependencies for the Fixer.
// ---------------------------------------------------------------------------

const FIXER_AMBIENT_PATHS = ["src/types.ts", "src/graphql/queries.ts"] as const;

async function loadAmbientFilesForFixer(
  boilerplateRoot: string,
  outputRoot: string,
): Promise<Array<{ path: string; contents: string }>> {
  const ambient: Array<{ path: string; contents: string }> = [];
  for (const relative of FIXER_AMBIENT_PATHS) {
    const fromOutput = path.join(outputRoot, relative);
    const fromBoilerplate = path.join(boilerplateRoot, relative);

    const target = (await exists(fromOutput)) ? fromOutput : fromBoilerplate;
    if (!(await exists(target))) continue;

    const readResult = await readFile(target);
    if (!readResult.ok) continue;

    ambient.push({ path: relative, contents: readResult.value });
  }
  return ambient;
}

function mergeDependenciesForFixer(
  declared: Array<{ path: string; contents: string }>,
  ambient: Array<{ path: string; contents: string }>,
): Array<{ path: string; contents: string }> {
  const seen = new Set(declared.map((d) => d.path));
  const merged = [...declared];
  for (const a of ambient) {
    if (!seen.has(a.path)) merged.push(a);
  }
  return merged;
}