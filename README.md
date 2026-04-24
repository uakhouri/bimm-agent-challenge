# Agentic Code Generation Workflow

This is my submission for the BIMM take-home. It's an agent that reads a natural-language spec and generates a working React + TypeScript + Apollo + MUI application into the provided boilerplate.

---

## How to run it

### Quickest path — see the sample output

If you just want to run the app my agent produced, skip the API key and agent setup:

```bash
cd sample-output
npm install
npm run dev    # opens at http://localhost:5173
```

This is committed, working output from a successful car-inventory run.

### Full path — run the agent yourself

You'll need an Anthropic API key with billing active. I tested this on Node 20.

```bash
# 1. Install the boilerplate's dependencies
npm install

# 2. Install the agent's dependencies
cd agent
npm install

# 3. Add your API key
cd ..
cp .env.example .env
# Open .env and set ANTHROPIC_API_KEY

# 4. Run the agent against the car inventory spec
cd agent
npm run agent -- --spec specs/car-inventory.md --fresh

# 5. Run the generated app
cd ../generated-app
npm install
npm run dev   # opens at http://localhost:5173
```

A run takes about 2 minutes and costs around $0.28 in API usage. When it succeeds, the final summary looks like this:

```text
═══ RUN SUMMARY ═══
Status:         done
Iterations:     18
Tasks planned:  10
Artifacts:      12
Errors:         0
Verdicts:       10 (10 passing)
LLM calls:      14
Total cost:     $0.3196
Total duration: 154.5s
```

To test with a different spec, I've included two alternatives that describe the same structural application in different domain language:

```bash
npm run agent -- --spec specs/vehicle-tracker.md --fresh
npm run agent -- --spec specs/product-catalog.md --fresh
```

---

## Setup choices I made

A few things I did when organizing this repo that affect how it reads:

1. **I kept the boilerplate at the repo root, exactly as you shipped it.** My agent lives in `agent/` as a sibling folder. That way `cd generated-app && npm install && npm run dev` works the way your brief describes, and the boilerplate files at the root are byte-identical to what you gave me. I preserved your original README as `BOILERPLATE.md` so it's still in the repo.

2. **There are two `package.json` files on purpose.** The one at the root is the boilerplate's — it's what gets copied into `generated-app/` every run. The one in `agent/` has the agent's own dependencies (Anthropic SDK, zod, tsx) so those don't leak into the generated apps.

3. **I patched the boilerplate at copy time, not at the source.** Your boilerplate had a few quirks that broke under my agent's invocation context — the `tsconfig.json` was configured for a future TypeScript version the installed one rejected, the path aliases cascaded once I resolved that, and `vitest.config.ts` used `__dirname` inside ESM modules. Rather than modify your files, my agent applies all these patches on the copy inside `generated-app/` during setup. The repo-root versions remain byte-identical to what you shipped.

4. **I pinned the Node version with `.nvmrc`.** If you use nvm, you'll pick up the same Node I built against.

5. **`.env.example` is committed, `.env` is gitignored.** Standard secrets hygiene.

---

## How it works

```mermaid
flowchart LR
    spec([natural-language<br/>spec]) --> P

    P[Planner<br/>Sonnet<br/><i>spec → task DAG</i>]
    P -->|tasks with<br/>depends_on edges| G

    G[Generator<br/>Sonnet<br/><i>one file per task</i>]
    G -->|file artifact| V

    V[Validator<br/>tools only<br/><i>tsc + vitest</i>]
    V -->|no errors| J
    V -->|structured<br/>errors| R

    J[Judge<br/>Haiku<br/><i>rubric scoring</i>]
    J -->|numeric<br/>verdicts| R

    R{Router<br/>pure function<br/><i>deterministic</i>}
    R -->|has errors<br/>+ budget left| F
    R -->|all pass| DONE([done])
    R -->|budget<br/>exhausted| ESC([escalated])

    F[Fixer<br/>Sonnet<br/><i>full-file rewrite</i>]
    F -->|revised file| V

    state[(Shared State<br/>zod-validated<br/>every boundary)]

    P -.-> state
    G -.-> state
    V -.-> state
    J -.-> state
    F -.-> state
    R -.-> state

    classDef sonnet fill:#fef3c7,stroke:#f59e0b,color:#000,stroke-width:2px
    classDef haiku fill:#dbeafe,stroke:#3b82f6,color:#000,stroke-width:2px
    classDef tools fill:#dcfce7,stroke:#16a34a,color:#000,stroke-width:2px
    classDef router fill:#fce7f3,stroke:#ec4899,color:#000,stroke-width:2px
    classDef terminal fill:#f3f4f6,stroke:#6b7280,color:#000,stroke-width:2px
    classDef stateStyle fill:#e0e7ff,stroke:#6366f1,color:#000,stroke-width:2px

    class P,G,F sonnet
    class J haiku
    class V tools
    class R router
    class DONE,ESC terminal
    class state stateStyle
```

A full run looks like this: the CLI reads the spec and copies the boilerplate into `generated-app/`. The Planner decomposes the spec into a DAG of ordered tasks. The Generator produces one file per task, seeing only the dependency files it needs — not the whole project. The Validator runs `tsc` and `vitest` and emits structured errors. If errors exist, the Router picks the task with the most errors and sends it to the Fixer with the failing file and error context; the Fixer returns a full-file replacement. When all files pass mechanical validation, the Judge scores each on a three-dimension rubric. If the pass rate is acceptable (80%+), the run completes. Otherwise, it escalates. Every node emits an OTel-shaped trace span.

Nodes don't call each other. They read state, write state, return. The orchestrator is the only component that knows the graph exists — nodes just know themselves. That's the whole point: a captured state is a complete bug report.

The upfront planning I did before writing code is in [`TICKETS.md`](./TICKETS.md).

---

## Decisions and tradeoffs

The ten choices that most shaped the system.

- **Router is a pure function.** Deterministic control flow is the property that makes failed runs replayable — feed the captured state back in, get the same decision. Escalation on novel errors is deliberate; I'd rather surface the unknown than pattern-match around it.

- **Hand-rolled state machine rather than LangGraph or LangChain.** Frameworks earn their weight when control flow is dynamic. Mine isn't. Adding a framework would have obscured the loop I was being evaluated on.

- **Mechanical validation gates the LLM judge.** `tsc` and `vitest` are ground truth and cost nothing. Running them first keeps the Judge's input distribution clean, which sharpens its prompt and cuts wasted calls on code that was never going to pass.

- **Sonnet for reasoning, Haiku for classification.** Judge scoring is bounded; Haiku handles it at ~20% of Sonnet's cost with no measurable quality drop. The work everywhere else is open-ended, and the Sonnet/Haiku gap there shows up as retries — the variable cost, not the per-call cost.

- **Generator sees dependency files only, not the whole project.** Attention is the limit that matters, not context size. Focused context produces better output than exhaustive context, measurably. This shifts effort onto the Planner's dependency analysis, which I consider correctly placed.

- **Zod validation at every node boundary.** LLM outputs are probabilistic; typed contracts make them auditable. A malformed response surfaces at the exact node that misbehaved instead of propagating as a weird crash downstream.

- **Judge emits scores; code derives pass/fail.** Numeric output from an LLM is measurably more stable than binary. Keeping the threshold in code means I can calibrate policy without touching the prompt. The current threshold (3 of 5 on each rubric dimension) is tuned by eye, not against historical run data — a production version would calibrate it from real runs.

- **Retry budget is state, not an exception.** Escalation is observable, replayable, and a clean integration point for a future approval queue. Exceptions would be none of those things.

- **Few-shot examples are read from the boilerplate at runtime, not written into prompts.** The agent's conventions track the target codebase rather than my assumptions about it. Point this at a different React project and it adapts — that's the generalization property, not a side effect.

- **OTel-shaped spans without the OTel SDK.** The shape is what matters for backend compatibility; the SDK adds distributed-tracing machinery a single-process CLI doesn't use. If this ever runs distributed, the tracer is the single substitution point.

---

## LLM choice

I used **Claude Sonnet 4.5** for the Planner, Generator, and Fixer — the reasoning-bound roles.

I used **Claude Haiku 4.5** for the Judge. Rubric scoring is bounded classification; Haiku handles it at ~20% of Sonnet's cost with no measurable quality drop on that task shape.

The `agent/src/tools/llm.ts` wrapper is about 100 lines and nothing outside it imports the Anthropic SDK. Swapping providers would be a one-file change.

---

## Prompt engineering

A few deliberate techniques went into the prompts:

- **Schema enforcement on structured outputs.** Every prompt that returns structured data (Planner's plan, Judge's verdicts) asks for JSON matching an explicit shape, and the response is zod-validated before being written to state. A malformed response fails fast at the node that produced it.
- **Few-shot from the target codebase.** Rather than hand-writing examples, the Generator's prompt loads the boilerplate's real `Example.tsx` and `Example.test.tsx` at runtime and includes them inline. Conventions track the codebase, not my opinions.
- **Explicit anti-memorization rule in the Planner.** One sentence telling it to derive task names from the spec rather than pattern-match on the domain — the defense against the "spec says cars, Planner emits CarCard" failure mode.
- **Focused dependency context for the Generator.** Each task is generated with only its dependency files visible, not the whole project. Less noise, better attention.
- **Separate prompts for Generator and Fixer** even though both write files. The Fixer gets the failing file and structured errors as first-class inputs; the Generator starts from a task description. Different inputs, different prompts.

The full prompts are in `agent/src/prompts/` as plain TypeScript — version-controlled, diffable, reviewable in the commit history.

---

## Cost per run

These numbers are from a real run against the car inventory spec, not estimates:

| Node | Calls | Cost | Share |
|---|---|---|---|
| Planner | 1 | $0.036 | 13% |
| Generator | 10 | $0.180 | 64% |
| Fixer | 2 | $0.034 | 12% |
| Judge | 1 | $0.030 | 11% |
| **Total** | **14** | **$0.28** | |

Total tokens: approximately 35K input, 7K output. Total duration: ~2 minutes.

Generator dominates total cost; Fixer dominates variance. A clean-plan run has 0–1 Fixer cycles; a poorly-planned run can have five. That's why the Planner prompt got disproportionate attention — good plans reduce Fixer cycles, which is where cost scales non-linearly.

---

## Generalization

Since your brief says you'll test with a modified spec, I put three defenses in place against memorization:

- The Planner prompt has an explicit anti-memorization rule that tells it to derive task names from the spec rather than pattern-match on domain vocabulary.
- Few-shot examples for the Generator come from the boilerplate's real files at runtime. The agent's style lives in the target codebase, not in my prompts.
- I committed two alternative specs in `agent/specs/`: `vehicle-tracker.md` (same structure, different noun) and `product-catalog.md` (generic "item" vocabulary over the same GraphQL schema). Running those produces domain-appropriate file names — `VehicleCard.tsx`, `ProductCard.tsx` — rather than reusing car-specific names from earlier runs.

The spec file extension doesn't matter either — the agent also accepts `.txt`.

---

## Observability

Every agent run writes a JSON trace file to `sample-traces/` with OpenTelemetry-shaped spans. Each span captures per-node timing, input/output tokens, cost, tool calls made, and status (`ok`, `error`, `escalated`). The trace also includes the final plan, verdicts, errors, and overall status — enough to reconstruct a full run without re-running.

Every node emits one span. A typical run produces 14–19 spans and about 20KB of trace JSON. Reference traces from successful runs can be made available on request.

---

## What worked well

The state machine made iteration debuggable. Every bug that surfaced during development showed up at a specific node, with specific state, in a specific span. Capturing a failing state and replaying it through the pure-function router was the property that paid off most often during the build.

Pulling few-shot from the boilerplate was the right default. The generated code consistently matches conventions — default exports, `@/` aliases, `MockedProvider` tests with `__typename` on mocks — because the prompt shows the Generator what `Example.tsx` looks like.

Two-layer validation caught different classes of bugs. Typecheck caught missing imports. Vitest caught components that rendered wrong. The Judge caught rubric misses. Each layer stayed focused because the others handled different concerns.

LLM-as-judge with numeric scores and in-code pass thresholds turned out much more stable than asking for a boolean verdict.

---

## What I'd improve with more time

1. **Anthropic prompt caching on the Generator's convention preamble.** Same ~2K tokens on every call × 10 calls. One SDK flag, ~90% reduction on Generator input cost, ~50% reduction on total run cost.
2. **Parallel generation across independent DAG nodes.** Roughly halves wall-clock time.
3. **Test-component co-generation.** The most common failure I saw: Generator writes a test expecting specific error wording, then writes a component with different wording. Generating them together — or feeding the real component's text into the test prompt — fixes this.
4. **Semantic routing by error class.** Typecheck errors and test failures currently use the same Fixer prompt; specialized prompts per error class would converge faster.
5. **Trace summary CLI.** The data is already captured; a small reader would give per-node success rate and p95 latency.
6. **Unit tests for the agent code itself.** The router is a pure function and trivial to test — fixture states in, assert on returned action. I didn't write these because I was iterating on prompts, not routing logic, but a production system would have them.

---

## Known limitations

**The agent doesn't succeed 100% of the time.** In iteration, about 70–80% of my runs completed cleanly. The rest escalated — usually because a test expected wording the component didn't produce, or the Fixer couldn't converge within its retry budget. My architecture keeps those failures visible and bounded rather than silent or infinite, but individual runs are still probabilistic at the LLM leaves.

**Single provider.** The LLM wrapper is designed to be provider-agnostic but only Anthropic is wired up.

**No incremental updates.** Every run with `--fresh` wipes the output directory. No file renames, no diff-based updates.

**Cost per run varies.** The $0.28 figure is a typical clean run. Runs with more Fixer cycles cost more — I've seen as high as $0.55 on pathological plans. Budget up to roughly $0.60 if you test multiple runs.

---

## A note on scope

The brief suggested 4–6 hours. This submission took me longer — closer to 12 hours across two days. The core agent loop and a passing car-inventory run were about 6 hours of work. The rest — the generalization specs, the OTel-shaped traces with cost accounting, the compatibility patches, the sample-output, and iterating until I had a clean end-to-end run — was the second half. I'd rather over-invest on a real submission than ship something rough.

My commit history on GitHub reflects this as small focused commits that tell the story of how the build evolved — from initial scaffolding through iteration on specific failures.

---

## Repo layout

```text
bimm-agent-challenge/
├── README.md               (this file)
├── TICKETS.md              (upfront planning I did before coding)
├── BOILERPLATE.md          (your original boilerplate README)
├── .env.example
│
├── src/ public/ index.html (your boilerplate, unchanged)
├── package.json            (your boilerplate package.json)
│
├── agent/                  (the actual deliverable)
│   ├── src/                (nodes, prompts, tools, tracing, graph, state)
│   ├── specs/              (sample natural-language inputs)
│   └── package.json
│
├── generated-app/          (agent output, gitignored, regenerated each run)
├── sample-output/          (a committed example produced by a clean run)
└── sample-traces/          (per-run traces, with one committed for reference)
```

Thanks for the chance to build this.