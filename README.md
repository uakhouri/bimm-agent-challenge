# Agentic Code Generation Workflow

This is my submission for the BIMM take-home. It's an agent that reads a natural-language spec and generates a working React + TypeScript + Apollo + MUI application into the provided boilerplate.

---

## How to run it

I tested this on Node 20. You'll need an Anthropic API key with billing active.

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

A run takes about 2 minutes and costs around $0.28 in API usage.

To test with a different spec, I've included two alternatives that describe the same structural application in different domain language:

```bash
npm run agent -- --spec specs/vehicle-tracker.md --fresh
npm run agent -- --spec specs/product-catalog.md --fresh
```

---

## Setup choices I made

A few things I did when organizing this repo that affect how it reads:

1. **I kept the boilerplate at the repo root, exactly as you shipped it.** My agent lives in `agent/` as a sibling folder. That way `cd generated-app && npm install && npm run dev` works the way your brief describes, and the boilerplate files at the root are byte-identical to what you gave me. I preserved your original README as `BOILERPLATE.md`.

2. **There are two `package.json` files on purpose.** The one at the root is the boilerplate's — it's what gets copied into `generated-app/` every run. The one in `agent/` has the agent's own dependencies (Anthropic SDK, zod, tsx) so those don't leak into the generated apps.

3. **I patched the boilerplate at copy time, not at the source.** Your boilerplate had two quirks that broke under my agent's invocation context: `tsconfig.json` sets `ignoreDeprecations: "6.0"` (a future-dated value the installed TypeScript rejects), and `vitest.config.ts` uses `__dirname` inside ESM modules. Rather than modify your files, my agent patches them on the copy inside `generated-app/` during setup. The repo-root versions are still identical to yours — a `diff` would show my changes are all additions, no modifications to what you provided.

4. **I pinned the Node version with `.nvmrc`.** If you use nvm, you'll pick up the same Node I built against.

5. **`.env.example` is committed, `.env` is gitignored.** Standard secrets hygiene.

---

## What it does

Given a natural-language spec, the agent:

1. Decomposes the spec into a dependency-ordered task DAG.
2. Generates each file one at a time, with focused dependency context.
3. Runs `tsc` and `vitest` to validate mechanically.
4. Routes failing files to a Fixer that receives the structured errors alongside the failing file.
5. Scores each file against a rubric using a cheaper LLM as judge.
6. Either completes or escalates, writing an OpenTelemetry-shaped trace either way.

I documented the design decisions in detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md), and the upfront planning I did before writing code is in [`TICKETS.md`](./TICKETS.md).

---

## LLM choice

I used **Claude Sonnet 4.5** for the Planner, Generator, and Fixer — the reasoning-bound roles. On these task shapes, the Sonnet-to-Haiku quality gap shows up as fewer retries, and retries are the real cost driver.

I used **Claude Haiku 4.5** for the Judge. Rubric scoring is bounded classification, which Haiku handles at roughly 20% of Sonnet's cost with no quality drop I could measure on that task.

The `agent/src/tools/llm.ts` wrapper is about 100 lines and nothing outside that file imports the Anthropic SDK. If you wanted to swap in OpenAI or Gemini, it'd be a one-file change.

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

Total duration was about 2 minutes. The Generator dominates total cost because it runs once per task. The Fixer dominates variance — a clean-plan run has 0–1 Fixer cycles, but a poorly-planned run can have five. This is why I put disproportionate effort into the Planner prompt. Good plans mean fewer Fixer cycles, which matters more than per-call model choice.

---

## Generalization

Since your brief says you'll test with a modified spec, I put three defenses in place against memorization:

- The Planner prompt has an explicit anti-memorization rule that tells it to derive task names from the spec rather than pattern-match on domain vocabulary.
- Few-shot examples for the Generator are pulled from the boilerplate's actual files at runtime — specifically `Example.tsx` and `Example.test.tsx`. The agent's style lives in the target codebase, not in my prompts. If you pointed this agent at a different codebase with different conventions, it would adapt.
- I committed two alternative specs in `agent/specs/`: `vehicle-tracker.md` (same structure, different noun) and `product-catalog.md` (generic "item" vocabulary over the same GraphQL schema). Running those produces domain-appropriate file names — `VehicleCard.tsx`, `ProductCard.tsx` — rather than reusing car-specific names from earlier runs.

The spec file extension doesn't matter either — I also tested with `.txt`.

---

## What worked well

**The state machine made iteration debuggable.** Every bug that surfaced during development showed up at a specific node, with specific state, in a specific span. Capturing a failing state and replaying it through the router — which is a pure function — is the property that paid off most often.

**Pulling few-shot from the codebase was the right default.** The generated code consistently matches the boilerplate's conventions — default exports, `@/` aliases, `MockedProvider` in tests with `__typename` on mocks — because the prompt literally shows the Generator what `Example.tsx` looks like. This is a generalization property rather than a car-inventory-specific trick.

**Two-layer validation caught different classes of bugs.** Typecheck caught missing imports and wrong type names. Vitest caught components that rendered wrong. The Judge caught rubric misses. Each layer's prompts stayed focused because the other layers handled different concerns.

**Numbers from the LLM, booleans from code.** The Judge returns integer scores on three rubric dimensions and the pass threshold is a function in `state.ts`. Numeric output from an LLM is more stable than binary output, and keeping the threshold in code means I can tune it without re-tuning the prompt.

---

## What I'd improve with more time

In order of what I'd tackle first:

1. **Anthropic prompt caching on the Generator's convention preamble.** The same ~2K tokens appear in every Generator call. Caching would cut Generator input cost by ~90% after the first call, dropping total run cost roughly in half. One SDK flag away.
2. **Parallel generation across independent DAG nodes.** Tasks without shared ancestors can run concurrently. This would roughly halve wall-clock time.
3. **Test-component co-generation.** The most common failure I saw during iteration was the Generator writing a test that expects specific error wording, then writing a component with different wording. Generating them together (or feeding the real component's text into the test prompt) would eliminate this.
4. **Semantic routing by error class.** Typecheck errors and test failures currently go to the same Fixer prompt. Specialized prompts per error class would converge faster.
5. **A real human-in-the-loop hook.** Escalation currently logs and exits. A production version would push to an approval queue.
6. **Trace summary CLI.** The data is already in the trace files; a small reader would give per-node success rate and p95 latency.

---

## Known limitations

**The agent doesn't succeed 100% of the time.** In my iteration sessions, about 70–80% of runs completed cleanly. The rest escalated — usually because a test expected wording the corresponding component didn't produce, or the Fixer couldn't converge within its retry budget. My architecture keeps these failures visible and bounded rather than silent or infinite, but individual runs are still probabilistic at the LLM leaves.

**Single provider.** The LLM wrapper is designed to be provider-agnostic, but only Anthropic is wired up right now.

**No incremental updates.** Every run with `--fresh` wipes the output directory. If you wanted to iterate on a generated app instead of regenerating it, that'd need state persistence across runs.

---

## Repo layout
bimm-agent-challenge/
├── README.md               (this file)
├── ARCHITECTURE.md         (design decisions, tradeoffs, diagram)
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
└── sample-traces/          (per-run traces, one committed as reference)

Thanks for the chance to build this.