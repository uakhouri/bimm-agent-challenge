/**
 * Judge prompt — generated code + original spec → rubric scores.
 *
 * Pure function, no I/O. Returns system and user messages for the Judge
 * node to send to the LLM.
 *
 * The prompt is intentionally minimal. The Judge's job is narrow: read the
 * task, read the generated file, produce scores on three named rubric
 * dimensions. Anything beyond that — suggesting fixes, weighting criteria,
 * computing pass/fail — lives outside the prompt. Narrow prompts are
 * stabler prompts.
 */

import type { Task } from "../state.js";

export interface JudgePromptArgs {
  task: Task;
  spec: string;
  generated_contents: string;
  dependency_files: Array<{ path: string; contents: string }>;
}

export interface JudgePromptResult {
  system: string;
  user: string;
}

export function buildJudgePrompt(args: JudgePromptArgs): JudgePromptResult {
  return {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(args),
  };
}

// ---------------------------------------------------------------------------
// System prompt.
// ---------------------------------------------------------------------------
//
// Three rubric dimensions, each anchored with enough description that a
// 3-score has a consistent meaning across runs. Anchoring is the difference
// between a rubric that produces stable numbers and one that drifts.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior code reviewer scoring a generated file against a specification on three rubric dimensions.

You will receive:
  - The original product specification (for context)
  - The task this file was supposed to satisfy (ID, title, acceptance criteria)
  - The generated file contents
  - The contents of any files this one depends on (for import/convention context)

YOUR JOB
Score the generated file on three dimensions, 0–5 each. Return JSON only.

RUBRIC

1. spec_coverage — how well does the file satisfy the task's acceptance criteria?
   0 = misses most criteria. 3 = satisfies all criteria. 5 = satisfies all criteria thoroughly with clear intent.

2. code_quality — readability, structure, absence of unnecessary complexity.
   0 = hard to read, unclear structure. 3 = clear and idiomatic. 5 = clear, idiomatic, and notably well-structured for its scope.

3. convention_match — does the file match the conventions visible in its dependencies?
   0 = clashes with nearby files (import style, naming, patterns). 3 = matches conventions. 5 = matches conventions exactly, including subtle ones.

RULES
- Score whole integers 0 through 5.
- The model must not produce a pass/fail verdict. That is computed outside this prompt.
- "issues" is a short list of specific things that held the score below 5 on any dimension. One issue per observation. Keep each under 15 words. If the file is excellent, return an empty array.

OUTPUT FORMAT
Return ONLY JSON matching this shape:

{
  "spec_coverage": 0,
  "code_quality": 0,
  "convention_match": 0,
  "issues": ["short observation", "another short observation"]
}

No prose. No fences. No commentary.`;

// ---------------------------------------------------------------------------
// User prompt builder.
// ---------------------------------------------------------------------------

function buildUserPrompt(args: JudgePromptArgs): string {
  const depBlock =
    args.dependency_files.length > 0
      ? args.dependency_files
          .map((f) => renderFile(f.path, f.contents, "dependency"))
          .join("\n\n")
      : "(none)";

  return `## ORIGINAL SPECIFICATION

${args.spec}

## TASK BEING SCORED

- Task ID: ${args.task.id}
- Title: ${args.task.title}
- Kind: ${args.task.kind}
- Target path: ${args.task.path}
- Acceptance criteria:
${args.task.acceptance.map((c) => `  - ${c}`).join("\n")}

## GENERATED FILE

${renderFile(args.task.path, args.generated_contents, "generated output")}

## DEPENDENCY FILES (for convention context)

${depBlock}

## YOUR OUTPUT

Score the generated file on the three rubric dimensions. Return JSON only.`;
}

function renderFile(filePath: string, contents: string, label: string): string {
  return `### ${filePath} (${label})

\`\`\`
${contents.trim()}
\`\`\``;
}
