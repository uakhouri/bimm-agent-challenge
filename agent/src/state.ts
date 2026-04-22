/**
 * Agent state schemas
 *
 * This file defines the vocabulary of the agent as a set of zod schemas.
 * Every node reads from and writes to these shapes. Every LLM output is
 * parsed through one of these schemas at the node boundary. TypeScript types
 * are inferred from the schemas, so compile-time types and runtime validation
 * never drift.
 *
 * Organizing principle: smallest pieces first (Task), composed into larger
 * shapes (Plan), with AgentState at the bottom as the container for everything.
 */

import path from "path";
import { z } from "zod";

//---------------------------------------------------------------------------
// Task - the atomic unit of work emitted by the Planner.
//---------------------------------------------------------------------------
//
// A task produces exaclty one file. The 'kind' field classifies the file so downstream nodes can specialize (e.g the Generator uses different
// few-shot examples for "hook" vs "component") 'depends_on' holds the IDs of other tasks whose output files must exist before this task runs,
// That's the DAG edge set 'acceptance' is plain-english criteria a reviewer (or the Judge) can check against the generated file.
//---------------------------------------------------------------------------

export const TaskKindSchema = z.enum([
  "hook",
  "component",
  "test",
  "config",
  "entry",
]);

export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1), // non-empty string
  title: z.string().min(1), // non-empty string
  kind: TaskKindSchema,
  path: z.string().min(1), // non-empty string
  depends_on: z.array(z.string()), // array of task IDs
  acceptance: z.array(z.string().min(1)).min(1), // non-empty array of non-empty strings
});

export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// Plan — the Planner's full output.
// ---------------------------------------------------------------------------
//
// `reasoning` is a short prose explanation from the Planner about how it
// decomposed the spec. It's not used by any downstream node — it exists so a
// human reading the trace can understand the Planner's thinking. Including
// it in the schema forces the Planner to produce a rationale it stands behind.
// ---------------------------------------------------------------------------

export const PlanSchema = z.object({
  tasks: z.array(TaskSchema).min(1), // non-empty array of tasks
  reasoning: z.string().min(1), // non-empty string
});

export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// FileArtifact — one generated file.
// ---------------------------------------------------------------------------
//
// The Generator (and the Fixer on retries) produce these. `attempt` tracks
// which retry produced this artifact — attempt 1 is the first generation,
// attempt 2+ are Fixer outputs. This lets the trace show retry history.
// ---------------------------------------------------------------------------

export const FileArtifactSchema = z.object({
  task_id: z.string().min(1), // non-empty string
  path: z.string().min(1), // non-empty string
  contents: z.string(), // can be empty
  attempt: z.number().int().min(1).positive(), // 1 for first generation, 2+ for retries
});

export type FileArtifact = z.infer<typeof FileArtifactSchema>;

// ---------------------------------------------------------------------------
// ValidationError — structured output from the Validator.
// ---------------------------------------------------------------------------
//
// Discriminated union by `kind` so the Fixer can route different error types
// to different handling later if we add that optimization. `raw` keeps the
// original tool output so we can debug parsers when they miss something.
// Nothing in the agent loop parses free-form tool output — it always goes
// through this structured form first.
// ---------------------------------------------------------------------------

export const ValidationErrorKindSchema = z.enum([
  "typecheck",
  "test",
  "lint",
  "runtime",
]);
export type ValidationErrorKind = z.infer<typeof ValidationErrorKindSchema>;

export const ValidationErrorSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().min(0).optional(),
  kind: ValidationErrorKindSchema,
  message: z.string().min(1),
  raw: z.string(),
});
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

// ---------------------------------------------------------------------------
// JudgeVerdict — the LLM-as-judge output.
// ---------------------------------------------------------------------------
//
// Three rubric dimensions scored 0–5. The Judge LLM returns the numbers.
// `passed` is computed in code from the scores — we deliberately don't ask
// the LLM for a boolean because numeric output is more stable than binary
// output, and the pass threshold is a policy decision that belongs in code,
// not in a prompt.
// ---------------------------------------------------------------------------

export const JudgeScoresSchema = z.object({
  spec_coverage: z.number().min(0).max(5),
  code_quality: z.number().min(0).max(5),
  convention_match: z.number().min(0).max(5),
});
export type JudgeScores = z.infer<typeof JudgeScoresSchema>;

export const JudgeVerdictSchema = z.object({
  task_id: z.string().min(1),
  passed: z.boolean(),
  scores: JudgeScoresSchema,
  issues: z.array(z.string().min(1)), // non-empty array of non-empty strings
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

// ---------------------------------------------------------------------------
// TraceSpan — one observation written to the trace file.
// ---------------------------------------------------------------------------
//
// Follows the OpenTelemetry span shape without pulling the OTel SDK. Fields
// are chosen so per-node success rate and p95 latency are computable with a
// trivial aggregation script.
// ---------------------------------------------------------------------------

export const SpanStatusSchema = z.enum(["ok", "error", "escalated"]);
export type SpanStatus = z.infer<typeof SpanStatusSchema>;

export const TraceSpanSchema = z.object({
  span_id: z.string().min(1),
  parent_id: z.string().optional(),
  node: z.string().min(1),
  started_at: z.string().datetime(),
  duration_ms: z.number().int().min(0),
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  cost_usd: z.number().min(0).optional(),
  tool_calls: z.array(z.string()).optional(),
  status: SpanStatusSchema,
  error_message: z.string().optional(),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

// ---------------------------------------------------------------------------
// NextAction — the Router's output.
// ---------------------------------------------------------------------------
//
// The Router reads state and returns one of these. The orchestrator
// dispatches based on the `next` discriminant. Including the reason makes
// traces self-explaining — reading a trace you can see not just what happened
// but why the router decided it.
// ---------------------------------------------------------------------------

export const NextActionSchema = z.discriminatedUnion("next", [
  z.object({ next: z.literal("plan") }),
  z.object({ next: z.literal("generate"), task_id: z.string().min(1) }),
  z.object({ next: z.literal("validate") }),
  z.object({ next: z.literal("judge") }),
  z.object({
    next: z.literal("fix"),
    task_id: z.string().min(1),
    reason: z.string(),
  }),
  z.object({ next: z.literal("done") }),
  z.object({ next: z.literal("escalate"), reason: z.string() }),
]);
export type NextAction = z.infer<typeof NextActionSchema>;

// ---------------------------------------------------------------------------
// AgentStatus — the current stage of the state machine.
// ---------------------------------------------------------------------------
//
// The machine starts in `planning` and ends in either `done` or `escalated`.
// Intermediate statuses let the router reason about "what were we in the
// middle of doing" which matters for deciding whether to advance or retry.
// ---------------------------------------------------------------------------

export const AgentStatusSchema = z.enum([
  "planning",
  "generating",
  "validating",
  "judging",
  "fixing",
  "done",
  "escalated",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// ---------------------------------------------------------------------------
// AgentState — the single source of truth passed between nodes.
// ---------------------------------------------------------------------------
//
// Every node reads the state, does its work, and returns a new state. Nothing
// mutates — each transition produces a new object. This makes the state
// inspectable at every point in the run and makes replaying a captured state
// trivial.
//
// `retry_budget` is a per-task counter. Decremented on each Fixer pass.
// When a task's counter hits 0, the router escalates.
// ---------------------------------------------------------------------------

export const AgentStateSchema = z.object({
  spec: z.string().min(1),
  output_dir: z.string().min(1),
  plan: PlanSchema.nullable(),
  artifacts: z.array(FileArtifactSchema),
  errors: z.array(ValidationErrorSchema),
  verdicts: z.array(JudgeVerdictSchema),
  traces: z.array(TraceSpanSchema),
  retry_budget: z.record(z.string(), z.number().int().min(0)),
  status: AgentStatusSchema,
  run_id: z.string().min(1),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

// ---------------------------------------------------------------------------
// Factory — build a fresh initial state.
// ---------------------------------------------------------------------------
//
// Centralizing this in one place means the orchestrator never builds state
// manually. If we add a field to AgentState later, we update this factory
// and the whole system picks up the default.
// ---------------------------------------------------------------------------

export function createInitialState(args: {
  spec: string;
  output_dir: string;
  run_id: string;
}): AgentState {
  return {
    spec: args.spec,
    output_dir: args.output_dir,
    plan: null,
    artifacts: [],
    errors: [],
    verdicts: [],
    traces: [],
    retry_budget: {},
    status: "planning",
    run_id: args.run_id,
  };
}

// ---------------------------------------------------------------------------
// Constants — tunables surfaced in one place.
// ---------------------------------------------------------------------------

/**
 * Default retry attempts allowed per task before escalation.
 * Three is a heuristic — in production this would be tuned per task kind
 * based on historical trace data.
 */
export const DEFAULT_RETRY_BUDGET = 3;

/**
 * Threshold used to derive `passed` from JudgeScores.
 * A task passes if every rubric dimension is at or above this score.
 * Set deliberately low (3/5) — the Validator already caught mechanical
 * failures, so we're only guarding against severe semantic misses.
 */
export const JUDGE_PASS_THRESHOLD = 3;

/**
 * Derive a pass/fail boolean from the LLM's numeric scores.
 * Kept deterministic and in code so the policy is auditable.
 */
export function isJudgeVerdictPassing(scores: JudgeScores): boolean {
  return (
    scores.spec_coverage >= JUDGE_PASS_THRESHOLD &&
    scores.code_quality >= JUDGE_PASS_THRESHOLD &&
    scores.convention_match >= JUDGE_PASS_THRESHOLD
  );
}