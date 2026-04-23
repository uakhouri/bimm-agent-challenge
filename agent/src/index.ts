#!/usr/bin/env node
/**
 * Agent CLI — the executable surface.
 *
 * Parses command-line arguments, loads the spec file, generates a run ID,
 * invokes runAgent, and prints a summary.
 *
 * This file is deliberately thin. Argument parsing, env setup, result
 * formatting — nothing else. The real work is in graph.ts and the nodes it
 * calls. If the interface ever changes (REST endpoint, web UI, VS Code
 * extension), only this file changes.
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { runAgent, RunAgentResult } from "./graph.js";
import { readFile as fsReadFile, exists } from "./tools/fs.js";

// ---------------------------------------------------------------------------
// Load .env before anything imports env-dependent modules.
// ---------------------------------------------------------------------------

loadDotenv({ path: resolveDotenvPath() });

// ---------------------------------------------------------------------------
// CLI argument parsing.
// ---------------------------------------------------------------------------

interface CliArgs {
  specPath: string;
  outputDir: string;
  boilerplateDir: string;
  tracesDir: string;
  fresh: boolean;
  maxIterations: number | undefined;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      output: { type: "string" },
      boilerplate: { type: "string" },
      traces: { type: "string" },
      fresh: { type: "boolean", default: false },
      "max-iterations": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const specPath = values.spec;
  if (!specPath) {
    printHelp();
    console.error("\nERROR: --spec <path> is required");
    process.exit(2);
  }

  const repoRoot = findRepoRoot();

  return {
    specPath: path.resolve(specPath),
    outputDir: path.resolve(
      values.output ?? path.join(repoRoot, "generated-app"),
    ),
    boilerplateDir: path.resolve(values.boilerplate ?? repoRoot),
    tracesDir: path.resolve(
      values.traces ?? path.join(repoRoot, "sample-traces"),
    ),
    fresh: values.fresh ?? false,
    maxIterations: values["max-iterations"]
      ? Number.parseInt(values["max-iterations"], 10)
      : undefined,
  };
}

function printHelp(): void {
  const lines = [
    "Agent — generates a React + TypeScript application from a spec",
    "",
    "USAGE",
    "  npm run agent -- --spec <path> [options]",
    "",
    "OPTIONS",
    "  --spec <path>         Path to the natural-language spec file (required)",
    "  --output <path>       Output directory for the generated app",
    "                        (default: <repo>/generated-app)",
    "  --boilerplate <path>  Path to the boilerplate template",
    "                        (default: repo root)",
    "  --traces <path>       Directory to write trace JSON",
    "                        (default: <repo>/sample-traces)",
    "  --fresh               Clear the output directory before running",
    "  --max-iterations <n>  Override the orchestrator iteration cap",
    "  --help                Print this help and exit",
    "",
    "EXAMPLE",
    "  npm run agent -- --spec agent/specs/car-inventory.md --fresh",
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Spec loading.
// ---------------------------------------------------------------------------

async function loadSpec(specPath: string): Promise<string> {
  if (!(await exists(specPath))) {
    console.error(`ERROR: spec file not found: ${specPath}`);
    process.exit(2);
  }
  const result = await fsReadFile(specPath);
  if (!result.ok) {
    console.error(`ERROR: failed to read spec: ${result.error.message}`);
    process.exit(2);
  }
  if (result.value.trim().length === 0) {
    console.error(`ERROR: spec file is empty: ${specPath}`);
    process.exit(2);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Run ID.
// ---------------------------------------------------------------------------
//
// Sortable timestamp plus a short suffix. Trace files named with this ID
// sort chronologically when listed, and two runs started in the same second
// don't collide.
// ---------------------------------------------------------------------------

function generateRunId(): string {
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}` +
    `${pad2(now.getUTCMonth() + 1)}` +
    `${pad2(now.getUTCDate())}` +
    `-${pad2(now.getUTCHours())}` +
    `${pad2(now.getUTCMinutes())}` +
    `${pad2(now.getUTCSeconds())}`;
  const suffix = randomUUID().slice(0, 6);
  return `${stamp}-${suffix}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// ---------------------------------------------------------------------------
// Result summary.
// ---------------------------------------------------------------------------

function printSummary(result: RunAgentResult): void {
  const totalCost = result.state.traces.reduce(
    (sum, span) => sum + (span.cost_usd ?? 0),
    0,
  );
  const totalDurationMs = result.state.traces.reduce(
    (sum, span) => sum + span.duration_ms,
    0,
  );
  const llmCalls = result.state.traces.filter(
    (span) => span.input_tokens !== undefined,
  ).length;

  const lines = [
    "",
    "═══ RUN SUMMARY ═══",
    `  Status:         ${result.state.status}`,
    `  Iterations:     ${result.iterations}`,
    `  Tasks planned:  ${result.state.plan?.tasks.length ?? 0}`,
    `  Artifacts:      ${result.state.artifacts.length}`,
    `  Errors:         ${result.state.errors.length}`,
    `  Verdicts:       ${result.state.verdicts.length} (${countPassingVerdicts(result)} passing)`,
    `  LLM calls:      ${llmCalls}`,
    `  Total cost:     $${totalCost.toFixed(4)}`,
    `  Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
    `  Trace file:     ${result.trace_file}`,
    "",
  ];
  console.log(lines.join("\n"));

  if (result.state.status === "escalated" && result.state.errors.length > 0) {
    console.log("ESCALATION DETAILS:");
    for (const err of result.state.errors.slice(-5)) {
      console.log(`  [${err.kind}] ${err.file}: ${err.message}`);
    }
    console.log("");
  }
}

function countPassingVerdicts(result: RunAgentResult): number {
  return result.state.verdicts.filter((v) => v.passed).length;
}

// ---------------------------------------------------------------------------
// Helpers for path resolution.
// ---------------------------------------------------------------------------
//
// The CLI can be invoked from anywhere. findRepoRoot walks upward from the
// current module's location looking for a marker (the agent's package.json
// sits in agent/, the repo root is one level above). Using the module's
// path (not process.cwd()) makes the defaults stable regardless of where
// the user runs npm from.
// ---------------------------------------------------------------------------

function findRepoRoot(): string {
  // import.meta.url is the URL of this source file. Its dirname is
  // agent/src; two parents up is the repo root.
  const here = new URL(".", import.meta.url).pathname;
  // On Windows, pathname starts with "/D:/..." — strip the leading slash.
  const normalized =
    process.platform === "win32" && here.match(/^\/[A-Za-z]:/)
      ? here.slice(1)
      : here;
  return path.resolve(normalized, "..", "..");
}

function resolveDotenvPath(): string {
  const here = new URL(".", import.meta.url).pathname;
  const normalized =
    process.platform === "win32" && here.match(/^\/[A-Za-z]:/)
      ? here.slice(1)
      : here;
  return path.resolve(normalized, "..", "..", ".env");
}

// ---------------------------------------------------------------------------
// main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCliArgs();

  console.log("═══ AGENT START ═══");
  console.log(`  Spec:        ${cli.specPath}`);
  console.log(`  Boilerplate: ${cli.boilerplateDir}`);
  console.log(`  Output:      ${cli.outputDir}`);
  console.log(`  Traces:      ${cli.tracesDir}`);
  console.log(`  Fresh start: ${cli.fresh}`);
  console.log("");

  const spec = await loadSpec(cli.specPath);
  const runId = generateRunId();

  const runAgentArgs: {
    spec: string;
    boilerplate_root: string;
    output_root: string;
    traces_dir: string;
    run_id: string;
    fresh: boolean;
    max_iterations?: number;
  } = {
    spec,
    boilerplate_root: cli.boilerplateDir,
    output_root: cli.outputDir,
    traces_dir: cli.tracesDir,
    run_id: runId,
    fresh: cli.fresh,
  };

  if (cli.maxIterations !== undefined) {
    runAgentArgs.max_iterations = cli.maxIterations;
  }

  const result = await runAgent(runAgentArgs);

  printSummary(result);

  if (result.state.status === "done") {
    process.exit(0);
  }
  if (result.state.status === "escalated") {
    process.exit(1);
  }
  process.exit(2);
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error("UNHANDLED ERROR:", e.message);
  if (e.stack) console.error(e.stack);
  process.exit(2);
});
