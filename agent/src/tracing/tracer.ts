/**
 * Tracer — OpenTelemetry-shaped span writer, no SDK dependency.
 *
 * Every node call is wrapped in a span. Spans accumulate in memory and flush
 * to disk at the end of a run. The shape follows the OTel data model closely
 * enough that a small converter could export to any OTel-compatible backend
 * (LangSmith, Honeycomb, Datadog, the OTel collector) without rewriting node
 * instrumentation.
 *
 * Scope: single-process CLI, no context propagation, no sampler. The SDK
 * would add weight we don't need yet. If the agent ever runs distributed,
 * the substitution point is here — nothing outside this file knows the
 * tracer is local.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { TraceSpan, SpanStatus } from "../state.js";
import type { LLMCallMetadata } from "../tools/llm.js";

// ---------------------------------------------------------------------------
// Tracer class — one instance per agent run.
// ---------------------------------------------------------------------------
//
// State is kept in a private array on the instance. Nothing reads the array
// directly; external callers go through getSpans() which returns a copy so
// the trace list stays immutable from the outside.
// ---------------------------------------------------------------------------

export class Tracer {
  private readonly runId: string;
  private readonly spans: TraceSpan[] = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  // -------------------------------------------------------------------------
  // startSpan — begin a new observation.
  // -------------------------------------------------------------------------
  //
  // Returns a SpanHandle the caller must close with finish(). This is the
  // manual-instrumentation pattern: the caller knows when work starts and
  // when it ends. The automatic-instrumentation pattern (wrap a function
  // and it spans itself) is nicer but adds closure ceremony that doesn't
  // read well in async code — this shape is explicit and easy to follow.
  // -------------------------------------------------------------------------

  startSpan(args: { node: string; parent_id?: string }): SpanHandle {
    const span_id = randomUUID();
    const started_at = new Date().toISOString();
    const startedMs = Date.now();

    const handleArgs: {
      span_id: string;
      node: string;
      started_at: string;
      startedMs: number;
      onFinish: (span: TraceSpan) => void;
      parent_id?: string;
    } = {
      span_id,
      node: args.node,
      started_at,
      startedMs,
      onFinish: (span) => this.spans.push(span),
    };

    if (args.parent_id !== undefined) {
      handleArgs.parent_id = args.parent_id;
    }

    return new SpanHandle(handleArgs);
  }

  // -------------------------------------------------------------------------
  // getSpans — read-only accessor.
  // -------------------------------------------------------------------------

  getSpans(): readonly TraceSpan[] {
    return [...this.spans];
  }

  // -------------------------------------------------------------------------
  // flush — write the trace to disk.
  // -------------------------------------------------------------------------
  //
  // Called once at the end of a run. The file name includes the run_id so
  // multiple runs don't collide. The format is JSON with one outer object
  // so the file is trivially importable into other tools — not NDJSON,
  // which is harder to inspect manually.
  // -------------------------------------------------------------------------

  async flush(
    outDir: string,
    extras?: {
      plan?: unknown;
      verdicts?: unknown;
      errors?: unknown;
      final_status?: string;
    },
  ): Promise<string> {
    await fs.mkdir(outDir, { recursive: true });
    const filePath = path.join(outDir, `run-${this.runId}.json`);

    const payload = {
      run_id: this.runId,
      generated_at: new Date().toISOString(),
      span_count: this.spans.length,
      total_cost_usd: this.spans.reduce(
        (s, span) => s + (span.cost_usd ?? 0),
        0,
      ),
      total_duration_ms: this.spans.reduce(
        (s, span) => s + span.duration_ms,
        0,
      ),
      final_status: extras?.final_status,
      plan: extras?.plan,
      verdicts: extras?.verdicts,
      errors: extras?.errors,
      spans: this.spans,
    };

    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }
}

// ---------------------------------------------------------------------------
// SpanHandle — the live reference returned by startSpan.
// ---------------------------------------------------------------------------
//
// The handle accumulates attributes as the node runs and commits the final
// span on finish(). Having a mutable handle internally but an immutable
// TraceSpan externally is the compromise between "spans can change while
// work is running" and "once committed, spans don't mutate."
// ---------------------------------------------------------------------------

export class SpanHandle {
  private readonly span_id: string;
  private readonly parent_id: string | undefined;
  private readonly node: string;
  private readonly started_at: string;
  private readonly startedMs: number;
  private readonly onFinish: (span: TraceSpan) => void;

  private input_tokens: number | undefined;
  private output_tokens: number | undefined;
  private cost_usd: number | undefined;
  private tool_calls: string[] = [];
  private finished = false;

  constructor(args: {
    span_id: string;
    parent_id?: string;
    node: string;
    started_at: string;
    startedMs: number;
    onFinish: (span: TraceSpan) => void;
  }) {
    this.span_id = args.span_id;
    this.parent_id = args.parent_id;
    this.node = args.node;
    this.started_at = args.started_at;
    this.startedMs = args.startedMs;
    this.onFinish = args.onFinish;
  }

  get id(): string {
    return this.span_id;
  }

  // -------------------------------------------------------------------------
  // attachLLMMetadata — absorb the meta object from callLLMJson / callLLMText.
  // -------------------------------------------------------------------------

  attachLLMMetadata(meta: LLMCallMetadata): void {
    this.input_tokens = (this.input_tokens ?? 0) + meta.input_tokens;
    this.output_tokens = (this.output_tokens ?? 0) + meta.output_tokens;
    this.cost_usd = (this.cost_usd ?? 0) + meta.cost_usd;
  }

  // -------------------------------------------------------------------------
  // recordToolCall — note a shell or filesystem invocation.
  // -------------------------------------------------------------------------

  recordToolCall(name: string): void {
    this.tool_calls.push(name);
  }

  // -------------------------------------------------------------------------
  // finish — commit the span.
  // -------------------------------------------------------------------------
  //
  // Idempotent — calling finish twice is a no-op after the first call. This
  // makes it safe to put finish() in both the happy path and a catch block
  // without worrying about double-counting.
  // -------------------------------------------------------------------------

  finish(args: { status: SpanStatus; error_message?: string }): TraceSpan {
    if (this.finished) {
      return {
        span_id: this.span_id,
        parent_id: this.parent_id,
        node: this.node,
        started_at: this.started_at,
        duration_ms: 0,
        status: args.status,
      };
    }
    this.finished = true;

    const span: TraceSpan = {
      span_id: this.span_id,
      parent_id: this.parent_id,
      node: this.node,
      started_at: this.started_at,
      duration_ms: Date.now() - this.startedMs,
      input_tokens: this.input_tokens,
      output_tokens: this.output_tokens,
      cost_usd: this.cost_usd,
      tool_calls: this.tool_calls.length > 0 ? this.tool_calls : undefined,
      status: args.status,
      error_message: args.error_message,
    };

    this.onFinish(span);
    return span;
  }
}
