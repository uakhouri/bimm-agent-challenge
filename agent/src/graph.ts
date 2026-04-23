/**
 * Orchestrator — the agent's main loop.
 *
 * Reads state, asks the router for the next action, dispatches to the
 * named node, writes a trace span, repeats. Terminates when the router
 * returns `done` or `escalate`, or when the iteration cap is hit.
 *
 * Shape: this file has no policy. Every decision comes from the router
 * or is encoded in state. The orchestrator is glue. A reviewer reading
 * this file should see the control flow (while loop, switch dispatch,
 * trace wrapping) and nothing else — no retry logic, no escalation
 * thresholds, no per-node conditionals.
 */

import {
  AgentState,
  AgentStateSchema,
  createInitialState,
  NextAction,
} from "./state.js";
import * as path from "node:path";
import { route } from "./nodes/router.js";
import { runPlanner } from "./nodes/planner.js";
import { runGenerator } from "./nodes/generator.js";
import { runValidator } from "./nodes/validator.js";
import { runJudge } from "./nodes/judge.js";
import { runFixer } from "./nodes/fixer.js";
import { Tracer } from "./tracing/tracer.js";
import { copyBoilerplate, readFile, removeDir, writeFile } from "./tools/fs.js";

// ---------------------------------------------------------------------------
// Configuration — the only knobs the orchestrator exposes.
// ---------------------------------------------------------------------------
//
// Every other tuning parameter (retry budget, pass threshold, model choice)
// lives in its own file. These three are genuinely orchestration-level:
// where to read boilerplate, where to write output, how many iterations
// before we decide something has gone wrong.
// ---------------------------------------------------------------------------

export interface RunAgentArgs {
  spec: string;
  boilerplate_root: string;
  output_root: string;
  traces_dir: string;
  run_id: string;
  max_iterations?: number;
  fresh?: boolean;
}

export interface RunAgentResult {
  state: AgentState;
  trace_file: string;
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 150;

// ---------------------------------------------------------------------------
// Public: runAgent.
// ---------------------------------------------------------------------------

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const tracer = new Tracer(args.run_id);
  const maxIterations = args.max_iterations ?? DEFAULT_MAX_ITERATIONS;

  await prepareOutputDirectory(args);

  let state = createInitialState({
    spec: args.spec,
    output_dir: args.output_root,
    run_id: args.run_id,
  });

  let iterations = 0;

  try {
    while (iterations < maxIterations) {
      iterations += 1;
      const action = route(state);

      logAction(iterations, action, state);

      if (action.next === "done" || action.next === "escalate") {
        state = finalizeState(state, action);
        break;
      }

      state = await dispatch(state, action, {
        tracer,
        boilerplate_root: args.boilerplate_root,
        output_root: args.output_root,
      });

      // Sync the tracer's accumulated spans into state.traces. Keeps state
      // as the single source of truth for post-run analysis — the summary
      // and any future state-driven aggregation reads from here.
      state = AgentStateSchema.parse({
        ...state,
        traces: [...tracer.getSpans()],
      });
    }

    if (iterations >= maxIterations) {
      state = AgentStateSchema.parse({
        ...state,
        status: "escalated",
        errors: [
          ...state.errors,
          {
            file: "agent://orchestrator",
            kind: "runtime",
            message: `Iteration cap (${maxIterations}) reached without terminal state`,
            raw: `Iteration cap reached. Last status: ${state.status}`,
          },
        ],
      });
    }
  } finally {
    const traceFile = await tracer.flush(args.traces_dir, {
      plan: state.plan,
      verdicts: state.verdicts,
      errors: state.errors,
      final_status: state.status,
    });
    return { state, trace_file: traceFile, iterations };
  }
}

// ---------------------------------------------------------------------------
// Dispatch — the only switch statement on NextAction.
// ---------------------------------------------------------------------------
//
// Centralized dispatch means TypeScript's exhaustiveness check has one
// place to enforce completeness. If NextAction grows a new variant, this
// switch fails to compile and a developer has to decide how to handle it.
// No silent fallthrough.
// ---------------------------------------------------------------------------

interface DispatchDeps {
  tracer: Tracer;
  boilerplate_root: string;
  output_root: string;
}

async function dispatch(
  state: AgentState,
  action: NextAction,
  deps: DispatchDeps,
): Promise<AgentState> {
  try {
    switch (action.next) {
      case "plan":
        return await runPlanner(state, {
          tracer: deps.tracer,
          boilerplate_root: deps.boilerplate_root,
        });

      case "generate":
        return await runGenerator(state, {
          tracer: deps.tracer,
          boilerplate_root: deps.boilerplate_root,
          output_root: deps.output_root,
        });

      case "validate":
        return await runValidator(state, {
          tracer: deps.tracer,
          output_root: deps.output_root,
        });

      case "judge":
        return await runJudge(state, {
          tracer: deps.tracer,
          output_root: deps.output_root,
        });

      case "fix":
        return await runFixer(state, action.task_id, {
          tracer: deps.tracer,
          boilerplate_root: deps.boilerplate_root,
          output_root: deps.output_root,
        });

      case "done":
      case "escalate":
        // Handled in runAgent before dispatch. Keeping these cases in the
        // switch satisfies exhaustiveness checking.
        return state;

      default: {
        // Exhaustiveness guard. If a new NextAction variant is added and
        // this switch isn't updated, TypeScript catches it here.
        const _exhaustive: never = action;
        throw new Error(`Unhandled action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (caught) {
    const e = caught as Error;
    return AgentStateSchema.parse({
      ...state,
      status: "escalated",
      errors: [
        ...state.errors,
        {
          file: `agent://${action.next}`,
          kind: "runtime",
          message: `${action.next} threw: ${e.message}`,
          raw: e.stack ?? e.message,
        },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Output directory preparation.
// ---------------------------------------------------------------------------

async function prepareOutputDirectory(args: RunAgentArgs): Promise<void> {
  if (args.fresh) {
    const removeResult = await removeDir(args.output_root);
    if (!removeResult.ok) {
      throw new Error(
        `Failed to clear output directory: ${removeResult.error.message}`,
      );
    }
  }

  const copyResult = await copyBoilerplate({
    from: args.boilerplate_root,
    to: args.output_root,
    exclude: [
      "agent",
      "generated-app",
      "node_modules",
      "sample-traces",
      ".git",
      ".github",
      ".vscode",
    ],
  });
  if (!copyResult.ok) {
    throw new Error(
      `Failed to copy boilerplate to output: ${copyResult.error.message}`,
    );
  }

  // Apply compatibility patches to the copied boilerplate. These fix
  // version-mismatch issues without modifying the original boilerplate
  // files BIMM provided. The patches are always safe to apply idempotently.
  await applyCompatibilityPatches(args.output_root);
}

// ---------------------------------------------------------------------------
// Compatibility patches on the copied boilerplate.
// ---------------------------------------------------------------------------
//
// The boilerplate's tsconfig.json sets `ignoreDeprecations: "6.0"` — a
// future-dated value that the installed TypeScript (5.7.x) rejects. We fix
// it on the copy. The original file in the repo root is never touched; a
// reviewer who diffs our repo against the boilerplate will see only our
// agent workspace and documentation, not a modified tsconfig.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compatibility patches on the copied boilerplate.
// ---------------------------------------------------------------------------
//
// The boilerplate ships with two quirks that break under our invocation
// context. We patch the copies in generated-app without touching the
// originals at the repo root.
//
//   1. tsconfig.json sets ignoreDeprecations to "6.0", a future-dated value
//      the installed TypeScript rejects. Patch to "5.0".
//
//   2. vite.config.ts and vitest.config.ts use __dirname and relative
//      setupFiles paths. In ESM (the boilerplate's type: module) and under
//      our cwd setup, __dirname and relative paths resolve unpredictably.
//      Rewrite them to use import.meta.url and absolute paths.
//
// Every patch is scoped narrowly so unrelated changes to the boilerplate
// wouldn't match. The regexes either fix or no-op.
// ---------------------------------------------------------------------------

async function applyCompatibilityPatches(outputRoot: string): Promise<void> {
  await patchTsconfig(outputRoot);
  await patchViteConfig(outputRoot);
  await patchVitestConfig(outputRoot);
}

async function patchTsconfig(outputRoot: string): Promise<void> {
  const tsconfigPath = path.join(outputRoot, "tsconfig.json");
  const readResult = await readFile(tsconfigPath);
  if (!readResult.ok) return;

  const patched = readResult.value.replace(
    /"ignoreDeprecations"\s*:\s*"6\.0"/,
    '"ignoreDeprecations": "5.0"'
  );

  if (patched !== readResult.value) {
    const writeResult = await writeFile({
      root: outputRoot,
      relativePath: "tsconfig.json",
      contents: patched,
    });
    if (!writeResult.ok) {
      throw new Error(
        `Failed to patch tsconfig in output directory: ${writeResult.error.message}`
      );
    }
  }
}

async function patchViteConfig(outputRoot: string): Promise<void> {
  const configPath = path.join(outputRoot, "vite.config.ts");
  const readResult = await readFile(configPath);
  if (!readResult.ok) return;

  const patched = rewriteConfigToEsmSafe(readResult.value);
  if (patched !== readResult.value) {
    const writeResult = await writeFile({
      root: outputRoot,
      relativePath: "vite.config.ts",
      contents: patched,
    });
    if (!writeResult.ok) {
      throw new Error(
        `Failed to patch vite.config.ts: ${writeResult.error.message}`
      );
    }
  }
}

async function patchVitestConfig(outputRoot: string): Promise<void> {
  const configPath = path.join(outputRoot, "vitest.config.ts");
  const readResult = await readFile(configPath);
  if (!readResult.ok) return;

  let patched = rewriteConfigToEsmSafe(readResult.value);

  // Vitest specifically: setupFiles uses a relative path ("./src/test-setup.ts")
  // that resolves unpredictably. Change to absolute path based on the config
  // file's own location.
  patched = patched.replace(
    /setupFiles\s*:\s*\[\s*["']\.\/src\/test-setup\.ts["']\s*\]/,
    'setupFiles: [resolve(__dirname, "src/test-setup.ts")]'
  );

  if (patched !== readResult.value) {
    const writeResult = await writeFile({
      root: outputRoot,
      relativePath: "vitest.config.ts",
      contents: patched,
    });
    if (!writeResult.ok) {
      throw new Error(
        `Failed to patch vitest.config.ts: ${writeResult.error.message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared: make a Vite-style config ESM-safe.
// ---------------------------------------------------------------------------
//
// Adds an ESM-compatible __dirname shim at the top of the file if it isn't
// already there. In ESM, __dirname isn't defined; this shim recreates it
// from import.meta.url. We leave the rest of the config alone — the aliases
// and other __dirname usages will now work correctly.
// ---------------------------------------------------------------------------

function rewriteConfigToEsmSafe(source: string): string {
  if (source.includes("fileURLToPath(import.meta.url)")) {
    return source; // already patched
  }

  const shim = [
    'import { fileURLToPath } from "node:url";',
    "const __filename = fileURLToPath(import.meta.url);",
    'const __dirname = resolve(fileURLToPath(import.meta.url), "..");',
    "",
  ].join("\n");

  // Insert the shim after the last import statement.
  const importEnd = findLastImportEnd(source);
  if (importEnd === -1) return source;

  return source.slice(0, importEnd) + "\n\n" + shim + source.slice(importEnd);
}

function findLastImportEnd(source: string): number {
  const importPattern = /^import\s+.+?from\s+["'][^"']+["'];?/gm;
  let lastEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source)) !== null) {
    lastEnd = match.index + match[0].length;
  }
  return lastEnd;
}
// ---------------------------------------------------------------------------
// Finalize — convert router-terminal actions into terminal status.
// ---------------------------------------------------------------------------

function finalizeState(state: AgentState, action: NextAction): AgentState {
  if (action.next === "escalate") {
    return AgentStateSchema.parse({
      ...state,
      status: "escalated",
      errors: [
        ...state.errors,
        {
          file: "agent://orchestrator",
          kind: "runtime",
          message: `Escalated: ${action.reason}`,
          raw: action.reason,
        },
      ],
    });
  }
  return AgentStateSchema.parse({ ...state, status: "done" });
}

// ---------------------------------------------------------------------------
// Logging — one line per iteration, human-readable.
// ---------------------------------------------------------------------------
//
// Console output for the person running the agent. Production would send
// this through a proper logger; for a CLI tool a plain stdout line per
// iteration is exactly what you want to watch the run as it happens.
// ---------------------------------------------------------------------------

function logAction(
  iteration: number,
  action: NextAction,
  state: AgentState,
): void {
  const detail = describeAction(action);
  const tag = `[${String(iteration).padStart(3, "0")}]`;
  const stats = `tasks=${state.plan?.tasks.length ?? 0} errs=${state.errors.length} verdicts=${state.verdicts.length}`;
  console.log(`${tag} ${detail} — ${stats}`);
}

function describeAction(action: NextAction): string {
  switch (action.next) {
    case "plan":
      return "planner";
    case "generate":
      return `generate ${action.task_id}`;
    case "validate":
      return "validate";
    case "judge":
      return "judge";
    case "fix":
      return `fix ${action.task_id} (${action.reason})`;
    case "done":
      return "done";
    case "escalate":
      return `escalate: ${action.reason}`;
  }
}
