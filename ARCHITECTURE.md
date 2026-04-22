# Architecture

This document covers the design of the agentic workflow: what the system does,
how it's shaped, and why each piece exists. Decisions are named, tradeoffs are
explicit, and alternatives that were considered and rejected are noted.

---

## 1. What the Agent Does

Given a natural-language product specification, the agent:

1. Reads the spec and decomposes it into a dependency-ordered task graph.
2. Copies the provided boilerplate into a fresh output directory.
3. Generates the target application file-by-file into that directory.
4. Validates each file mechanically (typecheck, tests) and semantically (LLM judge).
5. Repairs failures inside a bounded retry budget, escalating to a human-in-the-loop
   hook when the budget is exhausted.
6. Emits structured traces for every node so any run is inspectable after the fact.

The scope is deliberately narrow: the agent builds one React + TypeScript app
into one known boilerplate. The architecture, however, is the kind used in
production — typed state machines with deterministic routing and observable
transitions — so the same pattern would extend to other tasks with minimal
restructuring.

---

## 2. Topology

Six nodes over a shared, typed state object. Transitions between nodes are
decided by a pure-function router. The orchestrator is a loop that calls the
router, dispatches to the named node, writes a trace span, and repeats until
the terminal state is reached.

                 ┌────────────────────────────────────────┐
                 │        SHARED STATE (typed zod)        │
                 │  spec · plan · files · errors · traces │
                 └────────────────────────────────────────┘
                                   ▲
                                   │ (read/write via typed contracts)
                                   │
spec ──►  
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ PLANNER  │──► │  GENERATOR   │──► │  VALIDATOR   │──► │  JUDGE   │
│  Sonnet  │    │    Sonnet    │    │  tools only  │    │  Haiku   │
└──────────┘    └──────────────┘    └──────────────┘    └──────────┘
│                 ▲                   │                  │
│                 │                   ▼                  ▼
│           ┌──────────┐     ┌────────────────────────────────┐
│           │  FIXER   │ ◄───│   ROUTER (deterministic func)  │
│           │  Sonnet  │     │  pass → next · fail → fix      │
│           └──────────┘     │  budget exceeded → escalate    │
│                            └────────────────────────────────┘
▼
┌──────────────┐
│ GOLDEN EVAL  │  — offline harness running ≥2 specs
│   harness    │    against expected structural outcomes
└──────────────┘

══════════ OpenTelemetry-shaped spans wrap every node ══════════
     input · output · latency · tokens · tool_calls · cost · status

Each node is a pure function over `AgentState`. No node invokes another
directly. The orchestrator is the only component that knows the graph; nodes
only know themselves. This separation is what makes the system testable and
replayable: a captured `AgentState` is a complete bug report.

---

## 3. Key Decisions

Each subsection covers: what was chosen, what was considered and rejected, and
the tradeoff that makes the choice defensible.

### 3.1 State Machine Over an Agent Framework

**Chose:** A hand-rolled graph of pure-function nodes over a single immutable
state object, with explicit transitions.

**Considered and rejected:** LangGraph, LangChain agents, CrewAI, ReAct-style
free-form loops.

**Why:** Agent frameworks are optimal when the control flow is unknown or
dynamic. Here it isn't. The stages are fixed: plan, generate, validate, judge,
route, fix. Introducing a framework in that case adds a layer of indirection
that hides the thing being evaluated — the agentic loop itself.

A framework also shifts debugging from reading your own code to reading the
framework's internals. For a production system with heterogeneous agents and a
dynamic tool catalog, that shift is worth it. For a system with well-defined
stages, it isn't.

**Tradeoff:** Rolling our own means writing ~200 lines of orchestration we
could have avoided. We accept that cost in exchange for a system where any
behavior is directly attributable to code in this repo.

**When the other choice would win:** Multi-agent systems with dynamic agent
spawning, heterogeneous tool catalogs per agent, or graph structures that are
themselves data. None of that applies here.

---

### 3.2 Determinism as a Load-Bearing Property

**Chose:** The router is a pure function. Given a state, it returns a
transition. No LLM call, no randomness, no I/O.

**Why:** Non-determinism in agent systems compounds. One non-deterministic
decision per run is tolerable. One per node per run means failures can't be
reproduced. The agents that survive production are the ones where the
orchestration layer is deterministic and only the leaf operations are
probabilistic.

This is a generalization of a pattern from build systems: keep the scheduler
deterministic, let the work units be expensive. Make allows any build rule,
but DAG evaluation is deterministic. Same idea here. LLM calls are the
arbitrary work; routing between them is the DAG evaluation.

The practical payoff is that a captured `AgentState` is a complete bug report.
We can take the exact state that preceded a failure, feed it to the router in
a unit test, and get the same decision back. That isn't possible if the router
itself calls an LLM.

**Tradeoff:** Novel failure modes require code changes to handle. A
ReAct-style agent can "figure out" a new error category on the fly. A
deterministic router hits an unknown case and has to escalate. We treat that
as correct behavior — novel errors are exactly the thing a human should see —
but it's a real constraint.

---

### 3.3 Two Layers of Validation: Mechanical Before Semantic

**Chose:** A `Validator` node runs `tsc` and `vitest` and returns structured
errors. A separate `Judge` node runs an LLM against a scoring rubric. The
Validator gates the Judge: semantic validation only runs on code that already
compiles and passes tests.

**Why:** These are different failure modes with different costs. Mechanical
failure is free to detect (exit codes, zero LLM cost) and has a ground-truth
answer. Semantic failure requires an LLM call and is a judgment. Conflating
them means either using an LLM for things a compiler answers for free, or
using a compiler for things it can't express (spec coverage, convention match).

Ordering matters. Running the Judge first would mean paying for LLM calls on
code that was going to fail `tsc` anyway. Running the Validator first means
the Judge's input distribution is cleaner — it only ever sees compilable
code, which tightens its prompt and sharpens its verdicts.

The underlying principle: when you have a cheap deterministic oracle and an
expensive probabilistic one, run them in that order and let the cheap one
short-circuit the expensive one. This is a cache-hierarchy argument applied
to validation.

**Tradeoff:** The Judge is slightly coupled to the Validator — it assumes
valid code. The assumption is enforced by the router, not by the Judge
itself, which is a small piece of non-local reasoning. We accept it because
it's stated in one place (the router) and the router is tight and readable.

---

### 3.4 Generator Receives Dependencies, Not Global State

**Chose:** When the Generator produces a file, its prompt contains only the
contents of files that file depends on, as specified by the Planner's DAG
edges. It does not see the full project state.

**Why:** Context window size isn't the real limit. Attention is. An LLM given
50K tokens of context and asked to write one 200-line file performs
measurably worse than the same LLM given the three files that actually
matter. Irrelevant context doesn't just waste tokens; it degrades the signal.

Good interfaces are defined by what they hide. The Planner's responsibility
is to produce a DAG where each node's dependency set is the minimal context
needed to generate that node. If the Planner does this well, every downstream
Generator call is focused. If it does this poorly, every downstream call has
to compensate.

It also makes retries cheap. If a file fails validation, the Generator
re-runs with the same focused context plus the structured error. No need to
reason about global-state changes.

**Tradeoff:** The Planner has to be good. A lazy Planner that outputs
`depends_on: []` everywhere gets free global context and the whole property
collapses. So the Planner prompt is structured to make dependency analysis a
first-class output, not an afterthought. That's more work on the Planner in
exchange for less work on everything downstream.

---

### 3.5 Typed State at Every Boundary

**Chose:** A single zod schema for the whole agent state. Every node validates
its input on entry and its output before writing back. Runtime validation,
not just compile-time.

**Why:** LLMs return structured data by request, not by contract. You get
valid JSON most of the time. A parse failure three nodes downstream is
painful to trace; a parse failure at the node boundary is a one-line error
pointing directly at the misbehaving LLM call.

Runtime validation also acts as documentation. A reviewer opens `state.ts`
and sees the entire vocabulary of the system in one file. Every node's
behavior is constrained to produce outputs that match that schema. The
schemas are the API of the agent.

There's a discipline point here. Typed boundaries force decisions about what
goes in the state and what doesn't. Without them, state objects grow
unboundedly — every node adds a field "just in case." With them, adding a
field is a schema change, which is a visible commit, which is a decision
with a paper trail.

**Tradeoff:** ~10 lines of schema plumbing per node that a dynamically-typed
version wouldn't have. A bargain for the property that malformed LLM output
can't silently corrupt state.

---

### 3.6 Two Models, Chosen by Task Shape

**Chose:** Claude Sonnet 4.5 for Planner, Generator, and Fixer. Claude Haiku 4.5
for Judge.

**Why:** Model selection should follow task shape, not default to "the best
one available."

Judging against a rubric is a classification task: read code, check checklist
items, output scores. It's bounded. The model doesn't need to reason about
novel code structure or invent solutions. Haiku handles bounded classification
at ~20% of Sonnet's cost with no measurable quality drop.

Planning, generating, and fixing are open-ended. The Planner has to decompose
an arbitrary spec into a sensible DAG. The Generator has to produce correct
code. The Fixer has to reason about errors in context. All three are
reasoning-bound, and the quality gap between Sonnet and Haiku on reasoning
tasks is large enough to matter — it surfaces as fewer retries, which is the
real cost driver.

The meta-point: the right cost optimization isn't "use the cheaper model,"
it's "use the right model and reduce wasted calls." A Haiku-everywhere agent
is cheaper per call but produces more Fixer cycles, which erases the savings
and degrades output.

**Tradeoff:** Two models means two prompt styles to maintain and two
failure-mode catalogs. The per-run savings and the cognitive clarity of
"Sonnet writes, Haiku checks" more than pays for it.

**Provider choice:** Anthropic's API has the cleanest structured-output
story for our needs — tool-use with schema enforcement, prompt caching, and
reliable JSON mode. The `tools/llm.ts` wrapper is thin enough that a switch
to OpenAI or Gemini would be a one-file change.

---

### 3.7 The Planner Is the Highest-Leverage Prompt

**Chose:** Disproportionate effort on the Planner prompt. Explicit rules
against name-memorization, explicit dependency-ordering requirements, zod
schema enforcement on the output.

**Why:** In a pipeline, errors compound downstream. A bad plan produces bad
tasks produces bad files produces expensive Fixer cycles. A good plan makes
every other node's job easier.

The subtle failure mode is name-memorization. The Planner sees "Car
Inventory" and emits `CarCard.tsx`, `useCars.ts` — which happen to be
correct, but only because they match the reviewer's expectations for *this*
spec. Feed it a book library spec and it may still emit car-shaped task
names because "hook + list + form + search" rhymes with what it has seen.
The defense is an explicit prompt rule — *derive names from the spec, not
from memory* — plus a second test spec in the eval harness that exposes the
failure if the rule is ignored.

**Tradeoff:** Heavy prompt engineering is hard to test and easy to overfit.
The second spec (book-library) in the eval harness is the mitigation. If the
Planner degrades on that spec, the prompt is too tuned to cars.

---

### 3.8 Few-Shot Examples Pulled From the Codebase

**Chose:** The Generator's few-shot examples are extracted from the boilerplate
at runtime — the real `Example.tsx` and `Example.test.tsx` files — not hand-written.

**Why:** Hand-written few-shot drifts from the target codebase. It encodes
assumptions about "good React code" rather than the conventions the generated
code has to match. Pulling examples from the boilerplate at runtime means the
Generator's output style tracks whatever conventions exist in the target
project. If the boilerplate changes — different imports, different test style —
the few-shots change with it.

It's a small move with a big generalization implication: the agent's "style"
isn't in its prompts, it's in the codebase it's targeting. The same agent
produces idiomatic code for codebases with very different conventions without
re-tuning the prompts. That's the property that would matter in a real
deployment.

**Tradeoff:** Depends on the boilerplate being consistent. If the boilerplate
is messy, the few-shots are messy. In a real engagement, you'd clean up the
boilerplate before pointing an agent at it anyway.

---

### 3.9 Retry Budget Is a First-Class State

**Chose:** Per-task retry budget tracked in state. When exhausted, the router
transitions the system to an `escalated` terminal state. Escalation is a
normal state, not an exception.

**Why:** The failure mode we defend against is the infinite-loop Fixer: the
Fixer produces a patch, the Validator rejects it, the Fixer produces a
slightly different patch, the Validator rejects it, forever. Without a budget
this burns money and never converges.

Making escalation a first-class state — rather than an uncaught exception —
means escalation is visible in traces, has a known contract, and is the
natural place to plug an approval queue in production. For the submission
it's a stub (logs the escalation, writes the state to disk, exits with a
specific code) because the architectural point lands either way.

**Tradeoff:** Budget tuning is a guess. Three is a reasonable default backed
by nothing. In production you'd tune per-task-kind based on trace data —
typecheck errors might have a higher budget than runtime errors, for
instance. The architecture supports that; the defaults are placeholders.

---

### 3.10 OpenTelemetry-Shaped Traces Without the SDK

**Chose:** Every node emits a JSON span with OTel-compatible fields
(`span_id`, `parent_id`, `started_at`, `duration_ms`, `input_tokens`,
`output_tokens`, `cost_usd`, `status`). Written to a local file. No OTel
SDK dependency.

**Why:** Shape matters more than the library. Following the OTel span model
means the output is trivially exportable to any OTel-compatible backend
(LangSmith, Honeycomb, Datadog) without rewrites. Not pulling the SDK keeps
the dependency tree small and the code readable.

The span fields to capture are chosen deliberately: input/output tokens for
cost, latency for SLO tracking, tool_calls for debugging, status for success
rate aggregation. With those five, you can compute per-node success rate and
p95 latency — the data needed to define SLOs on agent task success.

**Tradeoff:** No automatic propagation, no distributed context. Overkill for
a single-process CLI agent; would be added back if this ran in a distributed
system.

---

## 4. Component Responsibilities

### Planner (Sonnet)

**Reads:** the raw spec.
**Writes:** `state.plan` — a validated `Plan` with ordered tasks.
**Does not:** generate code, run tools, make decisions that aren't about
task structure.

The Planner's prompt forces three things: JSON-only output matching the
`Plan` schema, explicit `depends_on` edges on every task, and a rule to
derive task names from the spec rather than from memory.

### Generator (Sonnet)

**Reads:** one `Task`, plus the contents of that task's dependency files.
**Writes:** one `FileArtifact` with the generated file contents.
**Does not:** see the full state, see other tasks, or decide what to build
next.

The Generator is stateless across tasks. Every call receives a focused
context and returns a single file. Retries reuse the same context with an
added error block.

### Validator (tools only, no LLM)

**Reads:** the current file artifacts in the output directory.
**Writes:** `state.errors` — a structured `ValidationError[]`.
**Does not:** judge quality, interpret errors, or make routing decisions.

The Validator runs `tsc --noEmit` and `vitest run`. It parses stdout into
discriminated-union error objects (kind: "typecheck" | "test" | "lint" |
"runtime"). An empty array means success. An LLM never interprets raw tool
output — it always receives the parsed, structured form.

### Judge (Haiku)

**Reads:** the set of generated artifacts and the original spec.
**Writes:** `state.verdicts` — one `JudgeVerdict` per task or one overall,
depending on configuration.
**Does not:** fix code, mutate artifacts, or assert correctness beyond the
rubric.

The Judge scores against a fixed rubric (spec coverage, convention match,
code quality), each on a 0–5 scale. Pass/fail is derived deterministically
from the scores, not asked of the LLM directly. This keeps the Judge's job
bounded and its output schema-stable.

### Fixer (Sonnet)

**Reads:** one `ValidationError`, the failing `FileArtifact`, the original
`Task`.
**Writes:** a new `FileArtifact` (full file contents, not a diff).
**Does not:** see unrelated files, decide whether to retry, or skip past
errors it can't handle.

Full-file output rather than diffs is deliberate: diffs compound errors
(wrong patch line numbers), full files are validated identically to
generator output.

### Router (pure function, no LLM)

**Reads:** `AgentState`.
**Writes:** a `NextAction` — one of `{ plan, generate, validate, judge,
fix, done, escalate }`.
**Does not:** mutate state, make LLM calls, or handle errors.

The router is the single source of truth for "what happens next." It has
unit tests with fixture states. Changing agent behavior means changing the
router (visible) rather than changing node internals (invisible).

### Orchestrator (graph.ts)

The loop: `while state.status !== terminal, call router, dispatch to named
node, write trace span, update state`. No business logic lives here. Its
only job is wiring.

---

## 5. Data Contracts

The full shapes live in `agent/src/state.ts`. The summary:

- `Task`: `{ id, title, kind, path, depends_on: string[], acceptance: string[] }`
- `Plan`: `{ tasks: Task[], reasoning: string }`
- `FileArtifact`: `{ task_id, path, contents, attempt }`
- `ValidationError`: `{ file, line?, kind, message, raw }`
- `JudgeVerdict`: `{ task_id, passed, scores: { spec_coverage, code_quality, convention_match }, issues }`
- `TraceSpan`: `{ span_id, parent_id?, node, started_at, duration_ms, input_tokens?, output_tokens?, cost_usd?, status }`
- `AgentState`: `{ spec, plan, artifacts, errors, verdicts, traces, retry_budget, status }`

Every transition in the graph is a pure function over `AgentState`.

---

## 6. What's Not in Scope

Scoped out deliberately; listed here because absence is a design decision.

- **Real backend.** The boilerplate uses MSW. We don't add a server.
- **Authentication / deployment / CI/CD.** Assessment explicitly excludes these.
- **UI polish on the generated app.** Functional correctness over aesthetics.
- **Multi-agent collaboration.** Single agent with one loop. Multi-agent
  would make sense if different nodes had fundamentally different skill
  profiles; here they don't.
- **Dynamic tool discovery.** Tools are known at compile time. This is a
  code-generation agent, not a general-purpose assistant.

---

## 7. What I'd Do With More Time

Ordered by value-per-hour.

1. **Anthropic prompt caching** on the boilerplate-conventions block. The
   same ~2K tokens appear in every Generator call. Caching cuts Generator
   input cost by ~90% with one SDK flag.
2. **Parallel generation across independent DAG nodes.** Tasks with no
   shared ancestors can run concurrently. Requires reworking the
   orchestrator's loop into a topological scheduler. Would roughly halve
   wall-clock time on typical plans.
3. **Semantic routing by error class.** Typecheck errors route to a fixer
   prompt optimized for type reasoning; test failures route to one
   optimized for behavior. Currently one fixer prompt handles both.
4. **Real HITL hook.** Promote the escalation stub to an actual approval
   queue (webhook, file-based queue, or a tiny REST endpoint).
5. **Trace aggregator CLI.** `npm run trace:summary` that reads the trace
   files and prints per-node success rate, p95 latency, and cost
   distribution. The data is already there; it just needs a reader.
6. **OpenAI provider fallback** behind a feature flag to prove the LLM layer
   is swappable.

---

## 8. Cost Profile

Captured from a sample car-inventory run. See README for current numbers;
this section describes the shape of the cost.

| Node | Model | Calls per run | Share of cost |
|---|---|---|---|
| Planner | Sonnet 4.5 | 1 | ~5% |
| Generator | Sonnet 4.5 | ~8–12 | ~55% |
| Judge | Haiku 4.5 | ~8–12 | ~10% |
| Fixer | Sonnet 4.5 | 0–5 | ~30% |

Fixer is the variable. A clean run has zero Fixer calls; a bad planning pass
can produce three or four. This is why Planner quality is the dominant cost
lever — good plans lower Fixer cycles by more than any per-call optimization.