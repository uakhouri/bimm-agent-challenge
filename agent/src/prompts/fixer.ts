/**
 * Fixer prompt — failing file + structured errors → corrected file.
 *
 * Pure function, no I/O. Same separation-of-concerns as the Planner and
 * Generator prompts. This file produces messages; the node handles the LLM
 * call and state mutation.
 *
 * Three design points baked in:
 *
 *   1. The prompt emphasizes "fix the errors without losing the intent."
 *      A fix that deletes the problematic requirement isn't a fix.
 *
 *   2. Errors arrive as structured objects with file paths and line numbers.
 *      The LLM never sees raw stdout — it sees "TS2322 on line 12: ..."
 *      formatted for readability.
 *
 *   3. The full file is included as context. Full-file in, full-file out.
 *      No diff mode.
 */

import type { Task, ValidationError } from "../state.js";

export interface FixerPromptArgs {
  task: Task;
  spec: string;
  current_contents: string;
  errors: ValidationError[];
  attempt_number: number;
  max_attempts: number;
  dependency_files: Array<{ path: string; contents: string }>;
}

export interface FixerPromptResult {
  system: string;
  user: string;
}

export function buildFixerPrompt(args: FixerPromptArgs): FixerPromptResult {
  return {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(args),
  };
}

// ---------------------------------------------------------------------------
// System prompt.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior React/TypeScript engineer repairing a single failing file.

Another node generated a file that failed validation — either TypeScript complained, or tests failed, or both. Your job is to produce a corrected version of the file that resolves the reported errors WITHOUT abandoning the file's original purpose.

RULES
1. Read the acceptance criteria. The fix must still satisfy them. If a test expects certain behavior, don't delete the behavior to silence the test.
2. Return the COMPLETE corrected file contents. No diffs, no partial edits, no "unchanged sections" comments. The full file.
3. Match the conventions visible in the current file and the dependencies. Don't change import styles or file layout beyond what the errors require.
4. Address every error you were given. If an error cannot be fixed without changing the task's intent, prefer the minimal change — but fix it.
5. Do not introduce new functionality that wasn't there before. Your scope is repair, not extension.
6. Do not add comments apologizing for the fix or explaining what was wrong. Clean code only.

OUTPUT FORMAT
Return ONLY JSON matching this shape:

{
  "path": "the file path you are correcting",
  "contents": "the full corrected file contents"
}

No prose. No fences. No commentary.`;

// ---------------------------------------------------------------------------
// User prompt.
// ---------------------------------------------------------------------------

function buildUserPrompt(args: FixerPromptArgs): string {
  const errorBlock = args.errors.map((e) => renderError(e)).join("\n\n");

  const depBlock =
    args.dependency_files.length > 0
      ? args.dependency_files
          .map((f) => renderFile(f.path, f.contents, "dependency"))
          .join("\n\n")
      : "(none — this file has no local dependencies)";

  return `## ORIGINAL SPECIFICATION

${args.spec}

## TASK BEING CORRECTED

- Task ID: ${args.task.id}
- Title: ${args.task.title}
- Target path: ${args.task.path}
- Kind: ${args.task.kind}
- Acceptance criteria:
${args.task.acceptance.map((c) => `  - ${c}`).join("\n")}

## ATTEMPT HISTORY

This is attempt ${args.attempt_number} of ${args.max_attempts}. Previous attempts failed validation and produced the errors below.

## CURRENT FILE (failing)

${renderFile(args.task.path, args.current_contents, "current — needs correction")}

## DEPENDENCY FILES

${depBlock}

## VALIDATION ERRORS TO FIX

${errorBlock}

## YOUR OUTPUT

Return the corrected file as JSON with path and contents. Address every error. Preserve the task's intent. No prose.`;
}

function renderError(e: ValidationError): string {
  const location = e.line !== undefined ? `line ${e.line}` : "file-level";
  return `### [${e.kind.toUpperCase()}] ${e.file} (${location})

${e.message}

Raw output:
\`\`\`
${e.raw.trim()}
\`\`\``;
}

function renderFile(filePath: string, contents: string, label: string): string {
  return `### ${filePath} (${label})

\`\`\`
${contents.trim()}
\`\`\``;
}
