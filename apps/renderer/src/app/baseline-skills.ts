import type { RuntimeSkill } from '../services/api.js';
import type { ExecutionLevel } from './capabilities.js';
import { defaultSkillExecution } from './capabilities.js';

/** Stable id for the platform-injected workspace harness (not user-editable). */
export const BASELINE_WORKSPACE_SKILL_ID = 'opcai-workspace';

const BASELINE_INSTRUCTIONS = `---
name: opcai-workspace
description: OPCAI platform workspace harness for isolated read/write and script execution in the current run directory, plus optional publish into a shared project workspace.
---

You are using the **OPCAI workspace harness** (\`opcai-workspace\`). It is always authorized for this run.

## Two directories (do not confuse them)

1. **Run workspace** (isolated, per attempt) — write generators, \`.py\`/\`.sh\` scripts, scratch files here with \`write_workspace_file\`. Users do **not** browse this tree in the project UI.
2. **Project workspace** (shared deliverables) — only when this run is bound to a project. Call \`publish_to_project\` to copy finished user-facing assets into the directory shown in the left **项目文件** tree. The platform also auto-promotes remaining deliverables when the run completes successfully.

## Tools (always pass skillId \`opcai-workspace\` unless noted)

- \`read_workspace_file\` — read text artifacts already in the **run** workspace (no skillId).
- \`write_workspace_file\` — create/replace/append text under the **run** workspace (requires workspace-write).
- \`run_workspace_script\` — execute a \`.py\`, \`.sh\`, or \`.js\` script **you wrote into the run workspace** (requires script permission).
- \`install_python_dependency\` — install a PyPI package into \`.python-packages\` for workspace scripts only.
- \`publish_to_project\` — promote a finished deliverable from the run workspace into the **shared project workspace** (requires workspace-write + project-bound run). Rejects process scripts.

### write_workspace_file contract

- Args: \`skillId\`, \`path\`, and either \`content\` (≤12KB) or \`chunks\` (each ≤4KB), optional \`mode\`: \`replace\` (default) | \`append\`.
- **Keep each call small** (ideally ≤6KB). Huge single-call HTML/CSS often fails with JSON parse errors before the file is saved.
- For a website: write \`index.html\`, then CSS/JS as separate files. If one file is long, write the first part with \`mode: replace\`, then continue with \`mode: append\`.
- After a failed oversized write, shrink the payload and retry — still deliver HTML, not only CSS/Markdown.
- Do not claim a file was saved unless the tool returned \`ok: true\`.

### publish_to_project contract

- Args: \`skillId\`, \`path\` (run-workspace relative), optional \`destPath\` (project relative; defaults to same path).
- Allowed: HTML/CSS/JS/Markdown/images/data (and similar deliverables).
- Forbidden: \`.py\` / \`.sh\` / \`scripts/\` / \`tools/\` / \`tmp/\` and other process paths — they stay in the run workspace.
- The left project file tree updates after a successful publish, end-of-run auto-promote, or client deliverable sync.

## Rules

1. Prefer \`write_workspace_file\` while building; call \`publish_to_project\` for each user-facing asset when a project is bound (auto-promote also runs at the end).
2. Skill packages from the library are optional extras; this harness covers basic workspace I/O without loading another Skill.
3. Respect the run permission tier: read-only runs cannot write, execute scripts, or publish.
4. Missing files on \`read_workspace_file\` simply mean they are not created yet — write them; do not treat ENOENT as a hard stop.
`;

export const baselineWorkspaceSkillMeta = {
  id: BASELINE_WORKSPACE_SKILL_ID,
  name: 'OPCAI Workspace',
  description: 'Platform harness: isolated run workspace I/O/scripts, plus publish_to_project for shared project deliverables.',
  source: 'builtin' as const,
  status: 'ready' as const,
  risk: 'medium' as const,
  tags: ['platform', 'workspace'],
  systemOnly: true,
};

/** Maps UI permission tier to harness execution flags (single policy surface). */
export function baselineExecutionForTier(tier: ExecutionLevel) {
  const base = defaultSkillExecution(tier);
  return {
    allowWorkspaceWrite: tier !== 'read-only' && base.allowWorkspaceWrite,
    allowScriptExecution: tier !== 'read-only' && base.allowScriptExecution,
    allowedNetworkHosts: [] as string[],
    allowAllNonDestructive: tier === 'full' && base.allowAllNonDestructive,
  };
}

/** Runtime Skill payload merged into every agent run before user-selected Skills. */
export function buildBaselineWorkspaceRuntimeSkill(tier: ExecutionLevel): RuntimeSkill {
  return {
    id: BASELINE_WORKSPACE_SKILL_ID,
    name: baselineWorkspaceSkillMeta.name,
    description: baselineWorkspaceSkillMeta.description,
    mode: 'default',
    instructions: BASELINE_INSTRUCTIONS,
    resources: [],
    execution: baselineExecutionForTier(tier),
  };
}

export function mergeRuntimeSkills(tier: ExecutionLevel, userSkills: RuntimeSkill[]): RuntimeSkill[] {
  const baseline = buildBaselineWorkspaceRuntimeSkill(tier);
  const rest = userSkills.filter((skill) => skill.id !== BASELINE_WORKSPACE_SKILL_ID);
  return [baseline, ...rest];
}
