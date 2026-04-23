/**
 * Judge node — semantic verdict on every generated file.
 *
 * Runs after the Validator passes. Scores each task's latest artifact
 * against the rubric, using Haiku because rubric classification is bounded
 * and doesn't require the reasoning depth Sonnet offers. One LLM call per
 * task. Pass/fail is derived in code from the numeric scores — the LLM
 * returns numbers only.
 *
 * The Judge writes JudgeVerdict objects into state.verdicts. It does not
 * fix code, does not re-run generation, does not decide what to do next
 * with a failing verdict. Those are the Router's concerns.
 */

import * as path from "node:path";
import { z } from "zod";
import {
  AgentState,
  AgentStateSchema,
  JudgeScores,
  JudgeScoresSchema,
  JudgeVerdict,
  JudgeVerdictSchema,
  Task,
  isJudgeVerdictPassing,
} from "../state.js";
import { buildJudgePrompt } from "../prompts/judge.js";
import { callLLMJson } from "../tools/llm.js";
import { readFile, exists } from "../tools/fs.js";
import type { Tracer } from "../tracing/tracer.js";

// ---------------------------------------------------------------------------
// Dependencies.
// ---------------------------------------------------------------------------

export interface JudgeDeps {
  tracer: Tracer;
  output_root: string;
}

// ---------------------------------------------------------------------------
// LLM response schema.
// ---------------------------------------------------------------------------
//
// Scores plus a short issues list. Pass/fail is NOT in the LLM response.
// That boolean is derived in code below, via isJudgeVerdictPassing from
// state.ts. Keeping the derivation in code (not in prompt) makes the
// threshold tunable without re-tuning the prompt.
// ---------------------------------------------------------------------------

const JudgeResponseSchema = JudgeScoresSchema.extend({
  issues: z.array(z.string().min(1)).max(10),
});
type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

// ---------------------------------------------------------------------------
// Public: runJudge.
// ---------------------------------------------------------------------------
//
// Iterates over tasks in plan order. For each task's latest artifact,
// calls the LLM with the rubric prompt, derives pass/fail in code,
// appends a JudgeVerdict to state. Continues on individual failures —
// one bad judge call shouldn't abort the whole pass.
// ---------------------------------------------------------------------------

export async function runJudge(
  state: AgentState,
  deps: JudgeDeps,
): Promise<AgentState> {
  if (!state.plan) {
    throw new Error("runJudge called before plan exists");
  }

  const span = deps.tracer.startSpan({ node: "judge" });
  const verdicts: JudgeVerdict[] = [];

  try {
    for (const task of state.plan.tasks) {
      const latest = latestArtifactFor(state, task.id);
      if (!latest) continue;

      const dependencyFiles = await resolveDependencyFiles(
        task,
        state,
        deps.output_root,
      );

      const prompt = buildJudgePrompt({
        task,
        spec: state.spec,
        generated_contents: latest.contents,
        dependency_files: dependencyFiles,
      });

      const result = await callLLMJson<JudgeResponse>({
        role: "judge",
        system: prompt.system,
        user: prompt.user,
        schema: JudgeResponseSchema,
        schema_name: "JudgeResponse",
        max_tokens: 1024,
        temperature: 0,
      });

      if (!result.ok) {
        // Individual judge call failed — record a neutral verdict
        // leaning fail, but don't abort the batch. The router will
        // see a failing verdict and escalate.
        verdicts.push(
          JudgeVerdictSchema.parse({
            task_id: task.id,
            passed: false,
            scores: { spec_coverage: 0, code_quality: 0, convention_match: 0 },
            issues: [`judge call failed: ${result.error.message}`],
          }),
        );
        continue;
      }

      span.attachLLMMetadata(result.value.meta);

      const scores: JudgeScores = {
        spec_coverage: result.value.value.spec_coverage,
        code_quality: result.value.value.code_quality,
        convention_match: result.value.value.convention_match,
      };

      verdicts.push(
        JudgeVerdictSchema.parse({
          task_id: task.id,
          passed: isJudgeVerdictPassing(scores),
          scores,
          issues: result.value.value.issues,
        }),
      );
    }

    const anyFailing = verdicts.some((v) => !v.passed);
    const finishArgs: { status: "ok" | "error" | "escalated"; error_message?: string } = {
      status: anyFailing ? "error" : "ok",
    };
    
    if (anyFailing) {
      finishArgs.error_message = `${verdicts.filter((v) => !v.passed).length} task(s) failed judge`;
    }
    
    span.finish(finishArgs);

    return AgentStateSchema.parse({
      ...state,
      verdicts,
      status: anyFailing ? "judging" : "done",
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

function latestArtifactFor(
  state: AgentState,
  taskId: string,
): ReturnType<typeof findLatest> {
  return findLatest(state, taskId);
}

function findLatest(
  state: AgentState,
  taskId: string,
): (typeof state.artifacts)[number] | null {
  const filtered = state.artifacts.filter((a) => a.task_id === taskId);
  if (filtered.length === 0) return null;
  return filtered.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
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

    const fromArtifact = findLatest(state, depId);
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
