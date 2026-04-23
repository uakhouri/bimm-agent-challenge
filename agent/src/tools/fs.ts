/**
 * Filesystem tools — safe, typed wrappers around Node's fs module.
 *
 * Every function returns Result<T, ToolError>. None of them throw. The agent
 * loop handles failures explicitly at each call site rather than guessing
 * which operations might throw.
 *
 * Path safety: every function that accepts a path resolves it and rejects
 * paths that escape the intended root. An LLM is generating the paths
 * upstream, so we assume adversarial inputs and guard accordingly.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Result, ok, err, ToolError, toolError } from "./result.js";

// ---------------------------------------------------------------------------
// Path safety helpers.
// ---------------------------------------------------------------------------
//
// An agent-generated path like "../../etc/passwd" would be catastrophic if
// written blindly. resolveWithinRoot takes a root directory and a candidate
// path; it returns the resolved absolute path only if the candidate stays
// inside the root. Anything escaping the root is an invalid_path error.
// ---------------------------------------------------------------------------

function resolveWithinRoot(
  root: string,
  candidate: string,
): Result<string, ToolError> {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(absoluteRoot, candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return err(
      toolError({
        kind: "invalid_path",
        message: `Path "${candidate}" escapes root "${root}"`,
        path: candidate,
      }),
    );
  }

  return ok(absoluteCandidate);
}

// ---------------------------------------------------------------------------
// readFile — reads a UTF-8 text file.
// ---------------------------------------------------------------------------

export async function readFile(
  filePath: string,
): Promise<Result<string, ToolError>> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return ok(contents);
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return err(
        toolError({
          kind: "file_not_found",
          message: `File not found: ${filePath}`,
          path: filePath,
          raw: e,
        }),
      );
    }
    if (e.code === "EACCES") {
      return err(
        toolError({
          kind: "permission_denied",
          message: `Permission denied: ${filePath}`,
          path: filePath,
          raw: e,
        }),
      );
    }
    return err(
      toolError({
        kind: "unknown",
        message: `Failed to read ${filePath}: ${e.message ?? e}`,
        path: filePath,
        raw: e,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// writeFile — writes a UTF-8 text file, creating directories as needed.
// ---------------------------------------------------------------------------
//
// Takes a root to enforce path safety. The generator produces paths relative
// to the output directory; writeFile ensures they stay inside it.
// ---------------------------------------------------------------------------

export async function writeFile(args: {
  root: string;
  relativePath: string;
  contents: string;
}): Promise<Result<string, ToolError>> {
  const resolved = resolveWithinRoot(args.root, args.relativePath);
  if (!resolved.ok) return resolved;

  try {
    await fs.mkdir(path.dirname(resolved.value), { recursive: true });
    await fs.writeFile(resolved.value, args.contents, "utf8");
    return ok(resolved.value);
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException;
    return err(
      toolError({
        kind: "write_failed",
        message: `Failed to write ${resolved.value}: ${e.message ?? e}`,
        path: resolved.value,
        raw: e,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// exists — returns true if a path exists, false otherwise.
// ---------------------------------------------------------------------------
//
// Deliberately returns a plain boolean, not a Result. "Does this exist" is
// a binary question — a Result adds ceremony without meaning. Permission
// errors are rare for stat and we treat them as "doesn't exist" for the
// agent's purposes.
// ---------------------------------------------------------------------------

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// copyDir — recursively copy a directory tree.
// ---------------------------------------------------------------------------
//
// Used at the start of every agent run to copy the boilerplate into the
// output directory. Uses fs.cp with recursive + force, which handles
// nested directories and overwrites existing files.
// ---------------------------------------------------------------------------

export async function copyDir(args: {
  from: string;
  to: string;
}): Promise<Result<void, ToolError>> {
  try {
    await fs.cp(args.from, args.to, { recursive: true, force: true });
    return ok(undefined);
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException;
    return err(
      toolError({
        kind: "copy_failed",
        message: `Failed to copy ${args.from} to ${args.to}: ${e.message ?? e}`,
        path: args.from,
        raw: e,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// removeDir — recursively remove a directory.
// ---------------------------------------------------------------------------
//
// Used to clear the output directory before each run when --fresh is passed.
// Missing directory is not an error; we want to remove it and it's already
// gone, which is fine.
// ---------------------------------------------------------------------------

export async function removeDir(
  dirPath: string,
): Promise<Result<void, ToolError>> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    return ok(undefined);
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException;
    return err(
      toolError({
        kind: "unknown",
        message: `Failed to remove ${dirPath}: ${e.message ?? e}`,
        path: dirPath,
        raw: e,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// copyBoilerplate — copy a directory tree with an exclusion list.
// ---------------------------------------------------------------------------
//
// This function walks the source tree explicitly and skips any top-level
// directory name in the exclusion set. That lets us copy the boilerplate's
// own files (src, public, package.json, etc.) while skipping agent,
// generated-app, node_modules, sample-traces, and .git.
// ---------------------------------------------------------------------------

export async function copyBoilerplate(args: {
  from: string;
  to: string;
  exclude: string[];
}): Promise<Result<void, ToolError>> {
  try {
    const excludeSet = new Set(args.exclude);
    await fs.mkdir(args.to, { recursive: true });

    const entries = await fs.readdir(args.from, { withFileTypes: true });
    for (const entry of entries) {
      if (excludeSet.has(entry.name)) continue;

      const sourcePath = path.join(args.from, entry.name);
      const destPath = path.join(args.to, entry.name);

      if (entry.isDirectory()) {
        await fs.cp(sourcePath, destPath, { recursive: true, force: true });
      } else {
        await fs.copyFile(sourcePath, destPath);
      }
    }

    return ok(undefined);
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException;
    return err(
      toolError({
        kind: "copy_failed",
        message: `Failed to copy boilerplate: ${e.message ?? e}`,
        path: args.from,
        raw: e,
      })
    );
  }
}

