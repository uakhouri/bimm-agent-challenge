/**
 * Shell execution tool — run a command, capture structured output.
 *
 * Used primarily by the Validator to run `tsc` and `vitest`. Every result
 * is a structured object — the LLM downstream never sees raw stdout or
 * stderr, only parsed ValidationError objects.
 *
 * Why spawn over exec: exec buffers output in memory and has a default
 * limit that silently truncates. spawn streams output, which is safer for
 * long-running builds and test suites.
 *
 * Why a timeout: without one, a hung vitest process would hang the agent.
 * Ten minutes is generous for a small generated app but bounded.
 */

import { spawn } from "node:child_process";
import { Result, ok, err, ToolError, toolError } from "./result.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  command: string;
  cwd: string;
}

export interface ShellOptions {
  cwd: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// exec — run a command string, return stdout/stderr/exit_code.
// ---------------------------------------------------------------------------
//
// Uses shell: true so commands like "npm run typecheck" work as a single
// string. On Windows this invokes cmd.exe; on Unix it invokes sh. Both are
// intentional — we want the same syntax to work across platforms.
//
// Non-zero exit codes are NOT errors from this function's perspective. A
// failing test suite exits with code 1; that's the expected behavior we
// want to capture in structured form. We only return err() for failures
// of the shell mechanism itself (process couldn't start, timed out, etc.).
// ---------------------------------------------------------------------------

export async function exec(
  command: string,
  options: ShellOptions,
): Promise<Result<ShellResult, ToolError>> {
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: { ...process.env, ...options.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(
        err(
          toolError({
            kind: "command_failed",
            message: `Failed to spawn command: ${error.message}`,
            raw: error,
          }),
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - startedAt;

      if (timedOut) {
        resolve(
          err(
            toolError({
              kind: "timeout",
              message: `Command timed out after ${timeout}ms: ${command}`,
              raw: { stdout, stderr, command, timeout },
            }),
          ),
        );
        return;
      }

      resolve(
        ok({
          stdout,
          stderr,
          exit_code: code ?? -1,
          duration_ms,
          command,
          cwd: options.cwd,
        }),
      );
    });
  });
}
