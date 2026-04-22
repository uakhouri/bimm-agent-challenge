# Tickets — BIMM Agentic Workflow

Planning artifact created before implementation began. Tickets are grouped by
milestone and ordered by dependency within each milestone. Each ticket has a
clear exit criterion so it's obvious when the ticket is done.

Tickets marked **[MUST]** are required for the submission. **[SHOULD]** are
high-value additions that demonstrate the architectural thinking called out in
the rubric. **[NICE]** is deferred work noted here for completeness.

---

## Milestone 0 — Repo & Workspace Setup

**Goal:** Clean repo, verified boilerplate, agent workspace scaffolded, plan and
architecture documented before a line of agent logic is written.

- [x] **T-001 [MUST]** — Import the BIMM boilerplate as the initial commit so
      the git log starts from a known-good baseline.
      *Exit:* repo contains unmodified boilerplate, `npm install` + `npm test` pass.
- [x] **T-002 [MUST]** — Pin Node version with `.nvmrc` for reviewer reproducibility.
      *Exit:* `.nvmrc` committed and matches local `node -v`.
- [x] **T-003 [MUST]** — Extend `.gitignore` for the agent workspace and runtime artifacts.
      *Exit:* `agent/node_modules`, `sample-traces/*.json`, and `.env` are ignored.
- [x] **T-004 [MUST]** — Scaffold `agent/` as its own TypeScript project.
      *Exit:* `agent/package.json`, `agent/tsconfig.json`, empty folder structure, `npm run agent` prints a stub message.
- [ ] **T-005 [MUST]** — Write `TICKETS.md` (this document).
- [ ] **T-006 [MUST]** — Write `ARCHITECTURE.md` with the full decision log and a diagram.

---

## Milestone 1 — Typed Contracts & Tool Layer

**Goal:** Define the vocabulary of the agent (state, plan, errors, traces) and
the deterministic tools it operates with. No LLM calls yet.

- [ ] **T-010 [MUST]** — `agent/src/state.ts`: zod schemas for `AgentState`, `Plan`, `Task`, `FileArtifact`, `ValidationError`, `JudgeVerdict`, `TraceSpan`.
      *Exit:* schemas exported, types inferred, file typechecks clean.
- [ ] **T-011 [MUST]** — `agent/src/tools/fs.ts`: safe read/write wrappers that return structured errors rather than throwing.
      *Exit:* `readFile`, `writeFile`, `copyDir` wrappers with discriminated-union returns.
- [ ] **T-012 [MUST]** — `agent/src/tools/shell.ts`: shell exec wrapper that captures stdout/stderr/exitCode as structured objects.
      *Exit:* `exec(command, opts)` returns `{ stdout, stderr, exitCode, durationMs }`.
- [ ] **T-013 [MUST]** — `agent/src/tools/llm.ts`: thin Anthropic SDK wrapper with token/cost accounting and JSON-mode helper.
      *Exit:* `callLLM({ model, system, user, schema? })` returns typed output + span metadata.
- [ ] **T-014 [SHOULD]** — `agent/src/tracing/tracer.ts`: OpenTelemetry-shaped span writer for every node.
      *Exit:* spans serialize to `sample-traces/<run-id>.json` with input/output/latency/tokens/cost/status.

---

## Milestone 2 — Agent Nodes

**Goal:** Implement each node as a pure function over `AgentState`. No node
calls another directly — the orchestrator routes between them.

- [ ] **T-020 [MUST]** — `agent/src/prompts/planner.ts`: planner prompt template with JSON Schema enforcement and anti-hardcoding rule.
      *Exit:* prompt renders with spec input and returns a string template function.
- [ ] **T-021 [MUST]** — `agent/src/nodes/planner.ts`: spec → validated `Plan`. Uses Sonnet.
      *Exit:* given a spec, produces a zod-valid `Plan` with at least one task and a coherent dependency order.
- [ ] **T-022 [MUST]** — `agent/src/prompts/generator.ts`: generator prompt with few-shot examples pulled from the boilerplate at runtime.
      *Exit:* prompt includes `Example.tsx` and `Example.test.tsx` as few-shot when relevant.
- [ ] **T-023 [MUST]** — `agent/src/nodes/generator.ts`: task → single file artifact. Uses Sonnet.
      *Exit:* given a task and its dependency files, returns `FileArtifact` whose contents compile against the boilerplate.
- [ ] **T-024 [MUST]** — `agent/src/nodes/validator.ts`: deterministic check that runs `tsc --noEmit` and `vitest run`, parses output into `ValidationError[]`.
      *Exit:* no LLM call inside; returns structured error list even on pass (empty array).
- [ ] **T-025 [SHOULD]** — `agent/src/prompts/judge.ts`: judge prompt with scoring rubric (spec coverage, convention match, code quality).
      *Exit:* prompt outputs a schema-constrained verdict.
- [ ] **T-026 [SHOULD]** — `agent/src/nodes/judge.ts`: validated code → `JudgeVerdict`. Uses Haiku.
      *Exit:* verdict has scores in [0,5] and a pass/fail boolean derived deterministically from scores.
- [ ] **T-027 [MUST]** — `agent/src/prompts/fixer.ts`: fixer prompt that receives structured errors + failing file + original task spec.
      *Exit:* prompt format constrains output to "full file contents" not "diff".
- [ ] **T-028 [MUST]** — `agent/src/nodes/fixer.ts`: error-driven patch. Uses Sonnet.
      *Exit:* given a `ValidationError[]` and the failing artifact, returns a new `FileArtifact`.
- [ ] **T-029 [MUST]** — `agent/src/nodes/router.ts`: pure function mapping `AgentState` → next action.
      *Exit:* deterministic (same input → same output), handles retry budget exhaustion by transitioning to `escalated`.

---

## Milestone 3 — Orchestrator & End-to-End

**Goal:** Wire nodes into a state machine, run against the car spec, iterate
prompts until the generated app compiles and runs.

- [ ] **T-030 [MUST]** — `agent/src/graph.ts`: the orchestrator loop. Reads router output, dispatches to the named node, writes span, repeats until `done` or `escalated`.
      *Exit:* terminates cleanly on both success and escalation paths.
- [ ] **T-031 [MUST]** — `agent/src/index.ts`: CLI entry point that accepts `--spec` and `--output`, copies the boilerplate to the output path, runs the graph.
      *Exit:* `npm run agent -- --spec ./specs/car-inventory.md --output ../generated-app` completes.
- [ ] **T-032 [MUST]** — Car-inventory sample spec in `agent/specs/car-inventory.md`.
      *Exit:* spec is plain natural language, no code, readable in under two minutes.
- [ ] **T-033 [MUST]** — First successful end-to-end run: agent generates a working Car Inventory app.
      *Exit:* `cd generated-app && npm install && npm run dev` renders cars; `npm run test` passes.
- [ ] **T-034 [MUST]** — Retry-budget wiring: failed validation triggers at least one fixer pass before advancing or escalating.
      *Exit:* trace shows a retry cycle when we seed a deliberate error.

---

## Milestone 4 — Generalization & Evaluation

**Goal:** Prove the agent isn't hardcoded to the car spec. Demonstrate the
evaluation harness.

- [ ] **T-040 [MUST]** — Second sample spec (`agent/specs/book-library.md`) for an analogous but structurally different domain.
      *Exit:* no shared nouns with the car spec; plan, generated files, and acceptance criteria differ meaningfully.
- [ ] **T-041 [SHOULD]** — Golden expectations for each spec: `agent/golden/car-inventory.json`, `agent/golden/book-library.json`.
      *Exit:* JSON documents list expected file paths and structural assertions (not literal diffs).
- [ ] **T-042 [SHOULD]** — `agent/src/eval/run.ts`: eval harness that runs each spec end-to-end and compares against golden expectations.
      *Exit:* `npm run eval` prints a per-spec pass/fail summary.

---

## Milestone 5 — Documentation & Submission Polish

**Goal:** The README makes the architectural thinking legible without the
reviewer having to read code.

- [ ] **T-050 [MUST]** — Final `README.md`: architecture summary, quick start, cost analysis from a real run, "what I'd do with more time" section.
      *Exit:* a reviewer who reads only the README understands the design.
- [ ] **T-051 [SHOULD]** — Commit a sample generated-app alongside a sample trace for offline review.
      *Exit:* `sample-output/` and `sample-traces/latest.json` committed.
- [ ] **T-052 [NICE]** — ADR-style notes in `docs/adr/` explaining any non-obvious decisions in more detail.
      *Exit:* one ADR per decision where "why" is more interesting than "what".

---

## Deferred (would add with more time)

- **T-060 [NICE]** — Parallel generation across independent DAG nodes.
- **T-061 [NICE]** — Anthropic prompt caching on the boilerplate-conventions prefix.
- **T-062 [NICE]** — Semantic routing by error class (typecheck errors vs test failures vs runtime errors route to different fixer prompts).
- **T-063 [NICE]** — Real HITL hook (approval queue, not just a log-and-exit).
- **T-064 [NICE]** — Trace aggregator CLI (`npm run trace:summary`) that computes per-node success rate and p95 latency.
- **T-065 [NICE]** — OpenAI provider fallback behind a feature flag to prove the LLM layer is swappable.