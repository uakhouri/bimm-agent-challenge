/**
 * Result type — explicit success/failure without exceptions.
 *
 * The tool layer never throws. Every operation returns a Result, forcing
 * callers to acknowledge failure explicitly at the call site.
 *
 * Why not just throw?
 * - Thrown errors are invisible at the call site. A reviewer reading the
 *   code can't see which calls might fail without following every function.
 * - The type system can't track what kind of error a throw produces.
 *   Result<T, E> carries the error type, so TypeScript forces handling.
 * - Composing operations that might fail becomes a match-on-Result pattern,
 *   which reads more linearly than try/catch nesting.
 */

export type Result<T,E=Error>=
| { ok: true; value: T }
| { ok: false; error: E };

export function ok<T>(value: T): Result<T,never> {
  return { ok: true, value };
} 

export function err<E>(error: E): Result<never,E> {
  return { ok: false, error };
} 

/**
 * Structured error shape for tool-layer failures.
 *
 * `kind` is a discriminator so callers can handle different failure modes
 * differently (e.g. "file_not_found" might trigger a create, while
 * "permission_denied" should escalate). `raw` preserves the original error
 * object or message for debugging.
 */
export interface ToolError {
  kind:
    | "file_not_found"
    | "permission_denied"
    | "write_failed"
    | "copy_failed"
    | "invalid_path"
    | "command_failed"
    | "timeout"
    | "unknown";
  message: string;
  path?: string;
  raw?: unknown;
}

export function toolError(args: {
  kind: ToolError["kind"];
  message: string;
  path?: string;
  raw?: unknown;
}): ToolError {
  return args;
}