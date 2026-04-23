/**
 * Generator prompt — task + dependencies → one file.
 *
 * Pure function, no I/O. Builds the system and user messages that the
 * Generator node sends to the LLM. Three design points baked into the prompt:
 *
 *   1. Few-shot from the codebase. Example files are pulled from the
 *      boilerplate at runtime (by the node, passed in here as arguments),
 *      not hand-written. The Generator's "style" tracks whatever conventions
 *      exist in the target project.
 *
 *   2. Dependency context, not global context. The Generator sees only the
 *      files the current task depends on — attention over tokens.
 *
 *   3. Full-file output. The model returns the complete file contents as a
 *      string. No diffs, no partial edits. Simpler to validate, simpler to
 *      retry, no class of patch-application bugs.
 */

import type { Task, TaskKind } from "../state.js";

// ---------------------------------------------------------------------------
// Public builder.
// ---------------------------------------------------------------------------

export interface GeneratorPromptArgs {
  task: Task;
  spec: string;
  dependency_files: DependencyFile[];
  few_shot_examples: FewShotExample[];
  boilerplate_conventions: string[];
}

export interface DependencyFile {
  path: string;
  contents: string;
}

export interface FewShotExample {
  description: string;
  path: string;
  contents: string;
}

export interface GeneratorPromptResult {
  system: string;
  user: string;
}

export function buildGeneratorPrompt(
  args: GeneratorPromptArgs,
): GeneratorPromptResult {
  return {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(args),
  };
}

// ---------------------------------------------------------------------------
// Few-shot selection by task kind.
// ---------------------------------------------------------------------------
//
// Different task kinds need different example files. A component task
// benefits from seeing an example component. A test task needs to see a
// test. The node passes us the excerpts; this table tells the node which
// ones to include. Centralizing it here keeps selection logic visible.
// ---------------------------------------------------------------------------

export const FEW_SHOT_BY_KIND: Record<TaskKind, string[]> = {
  hook: ["src/components/Example.tsx", "src/graphql/queries.ts"],
  component: ["src/components/Example.tsx"],
  test: ["src/__tests__/Example.test.tsx"],
  entry: ["src/components/Example.tsx"],
  config: [],
};

// ---------------------------------------------------------------------------
// System prompt — role, rules, output contract.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior React/TypeScript engineer generating ONE file at a time for an existing project.

The project uses React 19, TypeScript, Vite, Apollo Client, Material UI, MSW for mocked GraphQL, and Vitest with @testing-library/react for tests. The project is already scaffolded — you are adding files that fit into it, not scaffolding from scratch.

YOUR JOB
Generate the complete contents of ONE file matching the given task. Return the file contents as a raw string, nothing else.

RULES
1. Match the conventions shown in the example files exactly. Import paths, export style, naming, formatting — if the examples show it, follow it.
2. Use the path alias "@/" for imports inside src/. The boilerplate is configured for it. Example: \`import { GET_SOMETHING } from "@/graphql/queries"\`, not relative paths.
3. Default-export React components (\`export default function MyComponent() {}\`). Named-export hooks, helpers, and everything else.
4. Flat MUI imports: \`import { Card, CardContent } from "@mui/material"\`.
5. Tests use Apollo's MockedProvider, not MSW. Include the \`__typename\` field in test mock data for Apollo cache compatibility.
6. Components use function syntax with hooks. No class components.
7. Do not repeat imports. Do not include unused imports. Do not use \`any\` unless the LLM cannot avoid it — prefer narrowing over escape hatches.
8. Do not include explanatory comments about what the code does. Minimal comments only where intent is genuinely non-obvious.

OUTPUT FORMAT
Return ONLY a JSON object with this shape:

{
  "path": "exact path of the file you are generating",
  "contents": "the full file contents as a string"
}

No prose before or after. No markdown fences. No commentary. The contents field is the raw file — TypeScript/TSX/TS as appropriate — as it would be saved to disk.`;

// ---------------------------------------------------------------------------
// User prompt — task, spec, dependencies, conventions, few-shot.
// ---------------------------------------------------------------------------

function buildUserPrompt(args: GeneratorPromptArgs): string {
  const depBlock =
    args.dependency_files.length > 0
      ? args.dependency_files
          .map((f) => renderFile(f.path, f.contents, "dependency"))
          .join("\n\n")
      : "(none — this file has no dependencies within the generated code)";

  const fewShotBlock =
    args.few_shot_examples.length > 0
      ? args.few_shot_examples
          .map((e) => renderFile(e.path, e.contents, e.description))
          .join("\n\n")
      : "(none)";

  const conventionsBlock =
    args.boilerplate_conventions.length > 0
      ? args.boilerplate_conventions.map((c) => `- ${c}`).join("\n")
      : "(none beyond what is shown in examples)";

  return `## SPECIFICATION (for context)

${args.spec}

## THIS TASK

- Task ID: ${args.task.id}
- Title: ${args.task.title}
- Kind: ${args.task.kind}
- Target path: ${args.task.path}
- Acceptance criteria:
${args.task.acceptance.map((c) => `  - ${c}`).join("\n")}

## DEPENDENCY FILES (already generated)

${depBlock}

## FEW-SHOT EXAMPLES (conventions to match)

${fewShotBlock}

## PROJECT CONVENTIONS

${conventionsBlock}

## YOUR OUTPUT

Generate the complete contents of ${args.task.path}. Return as JSON with path and contents fields. No prose.`;
}

function renderFile(filePath: string, contents: string, label: string): string {
  return `### ${filePath} (${label})

\`\`\`
${contents.trim()}
\`\`\``;
}
