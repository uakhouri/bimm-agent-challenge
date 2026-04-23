/**
 * Router — deterministic, pure-function control flow.
 *
 * Takes an AgentState and returns the next action the orchestrator should
 * take. No LLM, no I/O, no mutation. Given the same state, always returns
 * the same action.
 *
 * This is the most important file in the agent. Every transition passes
 * through here. Every retry is a decision made here. Every escalation is
 * a decision made here. Because it's pure, it's trivially testable —
 * feed it fixture states, assert on the returned action — and because
 * it's deterministic, any captured failing state is a complete bug report.
 *
 * Policy concentration: retry budgets, escalation thresholds, verdict
 * interpretation — all the "when does the agent do what" rules live in
 * this file and only this file. Other nodes execute; this one decides.
 */

import { AgentState, NextAction, isJudgeVerdictPassing } from "../state.js";
import { findNextPendingTask } from "./generator.js";

// ---------------------------------------------------------------------------
// Public: route.
// ---------------------------------------------------------------------------
//
// The one function the orchestrator calls. Reads state, returns action.
// Every branch is explicit; there is no default or catch-all. The order
// of branches is the priority order — escalation first (terminal states
// short-circuit everything), then planning, then generation, then
// validation-driven decisions, then judge-driven decisions, then done.
// ---------------------------------------------------------------------------

export function route(state: AgentState): NextAction {
  if (state.status === "escalated") {
    return { next: "escalate", reason: "state.status is escalated" };
  }

  if (state.status === "done") {
    return { next: "done" };
  }

  if (!state.plan) {
    return { next: "plan" };
  }

  const pending = findNextPendingTask(state);
  if (pending !== null && state.status === "generating") {
    return { next: "generate", task_id: pending };
  }

  if (state.errors.length > 0) {
    return routeForErrors(state);
  }

  if (allTasksHaveArtifacts(state) && state.status === "generating") {
    return { next: "validate" };
  }

  if (state.status === "validating") {
    return { next: "validate" };
  }

  if (state.status === "fixing") {
    return { next: "validate" };
  }

  if (state.status === "judging" || readyForJudgment(state)) {
    const verdictDecision = routeForJudgment(state);
    if (verdictDecision) return verdictDecision;
  }

  return { next: "done" };
}

// ---------------------------------------------------------------------------
// Error routing — which task does the Fixer handle next?
// ---------------------------------------------------------------------------
//
// Policy:
//   1. Pick the task whose file has the most errors. More errors mean
//      more signal for the Fixer, and fixing the densest failure tends
//      to cascade into resolving related failures on other files.
//   2. If multiple tasks tie, pick the earliest one in plan order.
//      Earlier tasks are closer to the root of the DAG, and fixing them
//      often unblocks dependents.
//   3. If the selected task has zero budget remaining, escalate.
// ---------------------------------------------------------------------------

function routeForErrors(state: AgentState): NextAction {
  if (!state.plan) {
    return {
      next: "escalate",
      reason: "errors present but no plan exists",
    };
  }

  const errorsByTask = groupErrorsByTaskId(state);
  const candidates = [...errorsByTask.entries()]
    .filter(([taskId]) => taskExists(state, taskId))
    .sort(([aId, aErrors], [bId, bErrors]) => {
      if (bErrors.length !== aErrors.length) {
        return bErrors.length - aErrors.length;
      }
      return planOrderOf(state, aId) - planOrderOf(state, bId);
    });

  const target = candidates[0];
  if (!target) {
    return {
      next: "escalate",
      reason: "errors reference tasks that do not exist in the plan",
    };
  }

  const [taskId, taskErrors] = target;
  const budget = state.retry_budget[taskId] ?? 0;

  if (budget <= 0) {
    return {
      next: "escalate",
      reason: `retry budget exhausted for task ${taskId}`,
    };
  }

  const primaryKind = taskErrors[0]?.kind ?? "runtime";
  return {
    next: "fix",
    task_id: taskId,
    reason: `${taskErrors.length} ${primaryKind} error(s), budget=${budget}`,
  };
}

// ---------------------------------------------------------------------------
// Judgment routing — what to do with Judge verdicts.
// ---------------------------------------------------------------------------
//
// The Judge runs only after mechanical validation passes. Its verdicts are
// numeric scores; we derive pass/fail deterministically via
// isJudgeVerdictPassing from state.ts. A failing verdict becomes a
// fictitious ValidationError the Fixer can consume, so the repair loop
// uses the same path for mechanical and semantic failures.
//
// For the current scope we treat a failing verdict as an escalation
// trigger rather than a fix trigger — the Fixer prompt is tuned for
// compilation/test errors, not rubric misses. Extending to fix-on-verdict
// is a future enhancement noted in ARCHITECTURE.md.
// ---------------------------------------------------------------------------

function routeForJudgment(state: AgentState): NextAction | null {
  if (state.verdicts.length === 0) {
    return { next: "judge" };
  }

  const failing = state.verdicts.filter(
    (v) => !isJudgeVerdictPassing(v.scores),
  );

  if (failing.length === 0) {
    return { next: "done" };
  }

  return {
    next: "escalate",
    reason: `${failing.length} task(s) failed Judge verdicts: ${failing
      .map((v) => v.task_id)
      .join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function groupErrorsByTaskId(
  state: AgentState,
): Map<string, typeof state.errors> {
  const byTask = new Map<string, typeof state.errors>();
  if (!state.plan) return byTask;

  for (const err of state.errors) {
    const task = state.plan.tasks.find(
      (t) => err.file === t.path || err.file.endsWith(t.path),
    );
    const key = task?.id ?? err.file;
    const existing = byTask.get(key) ?? [];
    existing.push(err);
    byTask.set(key, existing);
  }

  return byTask;
}

function taskExists(state: AgentState, taskId: string): boolean {
  if (!state.plan) return false;
  return state.plan.tasks.some((t) => t.id === taskId);
}

function planOrderOf(state: AgentState, taskId: string): number {
  if (!state.plan) return Number.MAX_SAFE_INTEGER;
  const index = state.plan.tasks.findIndex((t) => t.id === taskId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function allTasksHaveArtifacts(state: AgentState): boolean {
  if (!state.plan) return false;
  const taskIds = new Set(state.plan.tasks.map((t) => t.id));
  const generatedIds = new Set(state.artifacts.map((a) => a.task_id));
  for (const id of taskIds) {
    if (!generatedIds.has(id)) return false;
  }
  return true;
}

function readyForJudgment(state: AgentState): boolean {
  return (
    state.errors.length === 0 &&
    allTasksHaveArtifacts(state) &&
    state.status !== "planning"
  );
}
