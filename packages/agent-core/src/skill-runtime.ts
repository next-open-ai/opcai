import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { AgentSkillRuntime } from '@opcai/contracts';

const MAX_FILE_BYTES = 96_000;
/** Soft cap per tool-call body so models do not emit fragile multi‑10KB JSON strings. */
const MAX_WRITE_CHUNK = 4_000;
const MAX_WRITE_CONTENT = 12_000;
const MAX_WRITE_CHUNKS = 12;
const MAX_NETWORK_BYTES = 256_000;
const MAX_SCRIPT_OUTPUT = 32_000;
const SCRIPT_TIMEOUT_MS = 30_000;
const textFilePattern = /\.(md|txt|json|ya?ml|csv|html?|css|ts|js|mjs|cjs|py|sh)$/i;
const executablePattern = /^scripts\/.+\.(sh|js|mjs|cjs|py)$/i;

/** Canonical directory for finished business deliverables inside a run workspace. */
export const WORKSPACE_OUTPUT_DIR = 'output';

/** Process / cache directories — never auto-archived or promoted. */
const PROCESS_ONLY_DIRS = new Set(['tools', 'scripts', 'tmp', 'deps', '.python-packages', '__pycache__', 'node_modules']);

/** Bytecode / native objects — never deliverables, even under output/. */
const NEVER_DELIVERABLE_EXT = new Set([
  'pyc', 'pyo', 'pyd', 'class', 'o', 'obj', 'exe', 'dll', 'so', 'dylib', 'map',
]);

/**
 * Document-like files that LLMs often write at workspace root by mistake.
 * After a script run we stage these into output/ so they still reach the asset library,
 * without treating generator sources (.py/.sh/…) as deliverables.
 */
const STAGEABLE_ROOT_DOCUMENT_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
  'html', 'htm', 'css', 'md', 'markdown', 'txt', 'csv', 'json',
  'zip', 'gz', 'tgz', 'mp3', 'mp4', 'webm', 'wav',
]);

function normalizeWorkspacePath(relative: string) {
  return relative.replace(/\\/g, '/').replace(/^\/+/, '');
}

function pathParts(relative: string) {
  return normalizeWorkspacePath(relative).split('/').filter(Boolean);
}

function safeRelative(value: string) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Path must be a safe relative path.');
  }
  return normalized;
}

function isNeverDeliverableFile(base: string) {
  if (!base || (base.startsWith('.') && base !== '.gitkeep')) return true;
  const ext = path.extname(base).slice(1).toLowerCase();
  return !ext || NEVER_DELIVERABLE_EXT.has(ext);
}

/** True when the path is under the canonical business-output directory. */
export function isUnderWorkspaceOutput(relative: string) {
  const parts = pathParts(relative);
  return parts[0] === WORKSPACE_OUTPUT_DIR && parts.length >= 2;
}

/**
 * True when a run-workspace relative path is a finished business deliverable.
 * Policy (intent, not extension guesswork):
 * - Must live under `output/` (or be placed there via register_deliverable).
 * - Process trees (scripts/tools/tmp/…) are never deliverables.
 * - Bytecode/cache files are never deliverables even under output/.
 * - Under output/, source files such as .py/.js ARE allowed (they can be the product).
 */
export function isBusinessDeliverablePath(relative: string) {
  const normalized = normalizeWorkspacePath(relative);
  const parts = pathParts(normalized);
  if (!normalized || parts.some((part) => part === '.' || part === '..')) return false;
  if (parts.some((part) => PROCESS_ONLY_DIRS.has(part))) return false;
  if (!isUnderWorkspaceOutput(normalized)) return false;
  return !isNeverDeliverableFile(parts[parts.length - 1] || '');
}

/** @deprecated Use isBusinessDeliverablePath — kept for call-site compatibility. */
export function isProjectDeliverablePath(relative: string) {
  return isBusinessDeliverablePath(relative);
}

function toOutputPath(relative: string, destName?: string) {
  const normalized = safeRelative(relative);
  if (isUnderWorkspaceOutput(normalized) && !destName) return normalized;
  const base = destName ? path.basename(safeRelative(destName)) : path.basename(normalized);
  if (!base || base === '.' || base === '..') throw new Error('Invalid deliverable file name.');
  return `${WORKSPACE_OUTPUT_DIR}/${base}`;
}

/**
 * Copy every deliverable under output/ from an isolated run workspace into the
 * shared project workspace. End-of-run safety net; prefer explicit publish.
 */
export async function promoteWorkspaceDeliverablesToProject(
  workspaceRoot: string,
  projectRoot: string,
): Promise<Array<{ path: string; projectPath: string }>> {
  const published: Array<{ path: string; projectPath: string }> = [];
  const root = path.resolve(workspaceRoot);
  const destRoot = path.resolve(projectRoot);
  const outputRoot = path.join(root, WORKSPACE_OUTPUT_DIR);

  async function walk(folder: string, depth = 0) {
    if (depth > 8 || published.length >= 200) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (!isBusinessDeliverablePath(relative)) continue;
      // Promote as output-relative path without forcing the "output/" prefix into the project tree.
      const projectPath = relative.startsWith(`${WORKSPACE_OUTPUT_DIR}/`)
        ? relative.slice(WORKSPACE_OUTPUT_DIR.length + 1)
        : relative;
      if (!projectPath || projectPath.split('/').some((part) => !part || part === '.' || part === '..')) continue;
      const dest = path.join(destRoot, ...projectPath.split('/'));
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await copyFile(target, dest);
      published.push({ path: relative, projectPath });
      if (published.length >= 200) return;
    }
  }

  try {
    await walk(outputRoot);
  } catch {
    /* best-effort */
  }
  return published;
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
}

async function pathInside(root: string, relative: string) {
  const resolvedRoot = await realpath(root);
  const candidate = path.resolve(resolvedRoot, safeRelative(relative));
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Path escapes its permitted root.');
  return candidate;
}

async function listSkillFiles(root: string, folder = root, depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 80) return entries;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = path.join(folder, entry.name);
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (entry.isDirectory()) await listSkillFiles(root, target, depth + 1, entries);
    else if (entry.isFile() && textFilePattern.test(entry.name)) entries.push(relative);
    if (entries.length >= 80) break;
  }
  return entries;
}

/**
 * List finished deliverables under output/ only.
 */
async function listOutputDeliverables(root: string, folder = path.join(root, WORKSPACE_OUTPUT_DIR), depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 40) return entries;
  let listing: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    listing = await readdir(folder, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of listing) {
    if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      await listOutputDeliverables(root, target, depth + 1, entries);
    } else if (entry.isFile()) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (isBusinessDeliverablePath(relative)) entries.push(relative);
    }
    if (entries.length >= 40) break;
  }
  return entries;
}

function isStageableRootDocument(relative: string) {
  const parts = pathParts(relative);
  if (parts.length !== 1) return false;
  if (isNeverDeliverableFile(parts[0])) return false;
  const ext = path.extname(parts[0]).slice(1).toLowerCase();
  return STAGEABLE_ROOT_DOCUMENT_EXT.has(ext);
}

/**
 * After a generator script runs:
 * 1) collect new/changed files under output/
 * 2) stage accidental root documents (pdf/html/…) into output/ (generators stay put)
 */
async function collectScriptDeliverables(root: string, before: Set<string>, startedAtMs: number): Promise<string[]> {
  const staged = new Set<string>();

  // Walk whole tree lightly for root-document staging + output discovery.
  async function walk(folder: string, depth = 0) {
    if (depth > 5) return;
    let listing: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      listing = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of listing) {
      if (entry.name.startsWith('.') || PROCESS_ONLY_DIRS.has(entry.name)) continue;
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, target).split(path.sep).join('/');
      let info: { mtimeMs: number };
      try {
        info = await stat(target);
      } catch {
        continue;
      }
      const isNewOrTouched = !before.has(relative) || info.mtimeMs >= startedAtMs - 1_000;
      if (!isNewOrTouched) continue;

      if (isBusinessDeliverablePath(relative)) {
        staged.add(relative);
        continue;
      }
      if (!isStageableRootDocument(relative)) continue;
      const destRel = toOutputPath(relative);
      const destAbs = path.join(root, ...destRel.split('/'));
      await mkdir(path.dirname(destAbs), { recursive: true, mode: 0o700 });
      await copyFile(target, destAbs);
      staged.add(destRel);
    }
  }

  await walk(root);
  // Also pick up anything already under output/ that may have been missed if walk skipped.
  for (const item of await listOutputDeliverables(root).catch(() => [])) {
    if (!before.has(item)) staged.add(item);
  }
  return [...staged];
}

function approvedSkillRoot(skill: AgentSkillRuntime) {
  const configuredRoot = process.env.OPCAI_SKILLS_DIR;
  if (!configuredRoot || !skill.rootPath) return null;
  const root = path.resolve(configuredRoot);
  const candidate = path.resolve(skill.rootPath);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function approval(skillId: string, capability: 'workspace-write' | 'script-execution' | 'network-access', error: string) {
  return { ok: false, error, approval: { skillId, capability } };
}

function runProcess(command: string, args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout = truncate(stdout + String(chunk), MAX_SCRIPT_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = truncate(stderr + String(chunk), MAX_SCRIPT_OUTPUT); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
  });
}

/**
 * The local execution boundary for Agent Skills. Skill packages are immutable
 * at runtime; generated artifacts belong in a separate, run-scoped workspace.
 * When `projectRoot` is set (project tasks), deliverables may be promoted into
 * the shared project directory via `publish_to_project`.
 */
export function createSkillExecutionTools(input: {
  skills: AgentSkillRuntime[];
  runId: string;
  projectRoot?: string;
}): Record<string, Tool<any, any, any>> {
  const packages = new Map(input.skills.map((skill) => [skill.id, skill]));
  const workspaceRoot = path.join(process.env.OPCAI_WORKSPACES_DIR || path.join(process.cwd(), '.opcai-workspaces'), input.runId);
  const projectRoot = input.projectRoot?.trim() ? path.resolve(input.projectRoot.trim()) : '';
  const loaded = new Set(input.skills.filter((skill) => skill.mode === 'default' && skill.instructions).map((skill) => skill.id));
  const getSkill = (skillId: string) => {
    const skill = packages.get(skillId);
    if (!skill) throw new Error('Skill is not authorized for this run.');
    return skill;
  };
  const ensureLoaded = (skillId: string) => { if (!loaded.has(skillId)) throw new Error('Load the Skill before accessing its files or execution capabilities.'); };
  const workspacePath = async (relative: string) => {
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    return pathInside(workspaceRoot, relative);
  };
  const projectPath = async (relative: string) => {
    if (!projectRoot) throw new Error('Current run is not bound to a project workspace.');
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    return pathInside(projectRoot, relative);
  };
  const runWorkspaceScript = async (skillId: string, relative: string, args: string[]) => {
    ensureLoaded(skillId);
    const skill = getSkill(skillId);
    if (!skill.execution.allowWorkspaceWrite) return approval(skillId, 'workspace-write', 'Writing the generator into this run workspace requires your approval.');
    if (!skill.execution.allowScriptExecution) return approval(skillId, 'script-execution', 'Running the generated script requires your approval.');
    const normalized = safeRelative(relative);
    if (!/\.(sh|js|mjs|cjs|py)$/i.test(normalized)) return { ok: false, error: 'Only .sh, .js, .mjs, .cjs, or .py workspace scripts may run.' };
    let script: string;
    try {
      script = await workspacePath(normalized);
      if (!(await stat(script)).isFile()) throw new Error('Not a file');
    } catch (_) { return { ok: false, error: `Workspace script is unavailable: ${normalized}. Write it first with write_workspace_file.` }; }
    const extension = path.extname(script).toLowerCase();
    const command = extension === '.py' ? 'python3' : extension === '.sh' ? 'bash' : process.execPath;
    const dependencyRoot = path.join(workspaceRoot, '.python-packages');
    const before = new Set(await listOutputDeliverables(workspaceRoot).catch(() => []));
    const startedAtMs = Date.now();
    const result = await runProcess(command, [script, ...args], workspaceRoot, { env: { ...process.env, PYTHONPATH: dependencyRoot } });
    const artifacts = await collectScriptDeliverables(workspaceRoot, before, startedAtMs).catch(() => []);
    return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, artifacts };
  };

  return {
    load_skill: tool({
      description: 'Load the full SKILL.md instructions for a relevant authorized Skill. Use only exact ids listed in the Skill catalog.',
      inputSchema: z.object({ skillId: z.string().min(1) }),
      execute: async ({ skillId }) => {
        const skill = getSkill(skillId);
        if (!skill.instructions) return { ok: false, error: 'This Skill has metadata only; portable instructions are unavailable.' };
        loaded.add(skillId);
        const root = approvedSkillRoot(skill);
        const files = root ? await listSkillFiles(root).catch(() => []) : [];
        return {
          ok: true,
          skill: { id: skill.id, name: skill.name, instructions: skill.instructions },
          files: [...new Set([...files, ...skill.resources.map((resource) => resource.path)])],
          note: 'Only open a file listed in files. Do not guess scripts or paths that are not listed.',
        };
      },
    }),
    read_skill_file: tool({
      description: 'Read a text file belonging to a loaded Skill. Path must be relative to that Skill directory; binary files and paths outside the Skill are blocked.',
      inputSchema: z.object({ skillId: z.string().min(1), path: z.string().min(1).max(240) }),
      execute: async ({ skillId, path: relative }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text resource formats can be read.' };
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'Local Skill filesystem access is unavailable for this package.' };
        try {
          const file = await pathInside(root, relative);
          return { ok: true, path: safeRelative(relative), content: truncate(await readFile(file, 'utf8'), MAX_FILE_BYTES) };
        } catch {
          return { ok: false, error: `Skill file is unavailable: ${safeRelative(relative)}. Load the Skill and use only a path returned in its files list.` };
        }
      },
    }),
    read_workspace_file: tool({
      description: 'Read a text artifact from this run\'s isolated workspace. Use only a relative path.',
      inputSchema: z.object({ path: z.string().min(1).max(240) }),
      execute: async ({ path: relative }) => {
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text formats can be read from the workspace.' };
        const file = await workspacePath(relative);
        return { ok: true, path: safeRelative(relative), content: truncate(await readFile(file, 'utf8'), MAX_FILE_BYTES) };
      },
    }),
    write_workspace_file: tool({
      description: 'Write a text file to this run\'s isolated workspace. Process files stay outside output/. Finished business deliverables must use path under output/ or pass deliverable=true (auto-places under output/). Keep each call small.',
      inputSchema: z.object({
        skillId: z.string().min(1).default('opcai-workspace'),
        path: z.string().min(1).max(240),
        content: z.string().max(MAX_WRITE_CONTENT).optional(),
        chunks: z.array(z.string().max(MAX_WRITE_CHUNK)).max(MAX_WRITE_CHUNKS).optional(),
        mode: z.enum(['replace', 'append']).default('replace'),
        deliverable: z.boolean().optional(),
      }).superRefine((value, ctx) => {
        const hasContent = typeof value.content === 'string' && value.content.length > 0;
        const hasChunks = Array.isArray(value.chunks) && value.chunks.length > 0;
        if (!hasContent && !hasChunks) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide content or chunks.' });
      }),
      execute: async ({ skillId, path: relative, content, chunks, mode, deliverable }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowWorkspaceWrite) return approval(skillId, 'workspace-write', 'Writing an artifact to this run workspace requires your approval.');
        const requested = safeRelative(relative);
        const asDeliverable = Boolean(deliverable) || isUnderWorkspaceOutput(requested);
        const targetRel = asDeliverable ? toOutputPath(requested) : requested;
        if (!textFilePattern.test(targetRel)) return { ok: false, error: 'Only approved text formats can be written.' };
        if (asDeliverable && !isBusinessDeliverablePath(targetRel)) {
          return { ok: false, error: 'Deliverable path is invalid. Use output/<filename> and avoid cache/bytecode names.' };
        }
        const body = typeof content === 'string' && content.length ? content : (chunks ?? []).join('');
        if (!body) return { ok: false, error: 'Write body is empty. Pass content or chunks.' };
        if (Buffer.byteLength(body) > MAX_FILE_BYTES) return { ok: false, error: `Single write exceeds ${MAX_FILE_BYTES} bytes. Split with mode "append".` };
        const file = await workspacePath(targetRel);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        if (mode === 'append') await writeFile(file, body, { encoding: 'utf8', flag: 'a', mode: 0o600 });
        else await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
        const size = (await stat(file)).size;
        return { ok: true, path: targetRel, bytes: Buffer.byteLength(body), totalBytes: size, mode, deliverable: asDeliverable };
      },
    }),
    register_deliverable: tool({
      description: 'Mark an existing run-workspace file as a finished business deliverable. Copies it into output/ (if needed) so it can be archived. Use for final products of any type (including .py/.js) — never for throwaway generators.',
      inputSchema: z.object({
        skillId: z.string().min(1).default('opcai-workspace'),
        path: z.string().min(1).max(240),
        destName: z.string().min(1).max(180).optional(),
      }),
      execute: async ({ skillId, path: relative, destName }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowWorkspaceWrite) return approval(skillId, 'workspace-write', 'Registering a deliverable requires your approval.');
        const sourceRel = safeRelative(relative);
        if (PROCESS_ONLY_DIRS.has(pathParts(sourceRel)[0] || '')) {
          return { ok: false, error: 'Files under scripts/tools/tmp/… are process files and cannot be registered as deliverables.' };
        }
        let source: string;
        try {
          source = await workspacePath(sourceRel);
          if (!(await stat(source)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: `Run workspace file is unavailable: ${sourceRel}.` };
        }
        const destRel = toOutputPath(sourceRel, destName);
        if (!isBusinessDeliverablePath(destRel)) return { ok: false, error: 'Deliverable name is invalid (cache/bytecode names are blocked).' };
        const dest = await workspacePath(destRel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        if (path.resolve(source) !== path.resolve(dest)) await copyFile(source, dest);
        const bytes = (await stat(dest)).size;
        return { ok: true, path: destRel, sourcePath: sourceRel, bytes, deliverable: true };
      },
    }),
    run_skill_script: tool({
      description: 'Run a bundled script under scripts/ for a loaded Skill, in the isolated run workspace. No shell expressions are accepted. Requires explicit execution permission.',
      inputSchema: z.object({ skillId: z.string().min(1), path: z.string().min(1).max(240), args: z.array(z.string().max(500)).max(16).default([]) }),
      execute: async ({ skillId, path: relative, args }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowScriptExecution) return approval(skillId, 'script-execution', 'Running this Skill script requires your approval.');
        const normalized = safeRelative(relative);
        if (!executablePattern.test(normalized)) return { ok: false, error: 'Only script files under scripts/ with an approved extension may run.' };
        const root = approvedSkillRoot(skill);
        if (!root) return { ok: false, error: 'Local Skill script execution is unavailable for this package.' };
        let script: string;
        try {
          script = await pathInside(root, normalized);
          if (!(await stat(script)).isFile()) throw new Error('Not a file');
        } catch {
          return { ok: false, error: `Script is unavailable: ${normalized}. Use only a script listed by load_skill.` };
        }
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const extension = path.extname(script).toLowerCase();
        const command = extension === '.py' ? 'python3' : extension === '.sh' ? 'bash' : process.execPath;
        const result = await runProcess(command, [script, ...args], workspaceRoot);
        return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    }),
    run_workspace_script: tool({
      description: 'Run a script previously written to this isolated run workspace. Prefer scripts under scripts/; finals should be written to output/.',
      inputSchema: z.object({ skillId: z.string().min(1).default('opcai-workspace'), path: z.string().min(1).max(240), args: z.array(z.string().max(500)).max(16).default([]) }),
      execute: async ({ skillId, path: relative, args }) => runWorkspaceScript(skillId, relative, args),
    }),
    publish_to_project: tool({
      description: 'Promote a finished business deliverable from this run workspace into the shared project workspace. Source must be under output/ (or already registered). Requires a project-bound run.',
      inputSchema: z.object({
        skillId: z.string().min(1).default('opcai-workspace'),
        path: z.string().min(1).max(240),
        destPath: z.string().min(1).max(240).optional(),
      }),
      execute: async ({ skillId, path: relative, destPath }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowWorkspaceWrite) {
          return approval(skillId, 'workspace-write', 'Publishing a deliverable into the project workspace requires your approval.');
        }
        if (!projectRoot) {
          return { ok: false, error: 'Current run is not bound to a project workspace. publish_to_project is only available for project tasks.' };
        }
        const sourceRel = safeRelative(relative);
        const stagedRel = isBusinessDeliverablePath(sourceRel) ? sourceRel : toOutputPath(sourceRel);
        const destRel = safeRelative(destPath || (isUnderWorkspaceOutput(sourceRel)
          ? sourceRel.slice(WORKSPACE_OUTPUT_DIR.length + 1)
          : path.basename(sourceRel)));
        if (!isBusinessDeliverablePath(stagedRel)) {
          return { ok: false, error: 'Only files under output/ may be published. Write/register the finished product with deliverable=true or register_deliverable first.' };
        }
        let source: string;
        try {
          source = await workspacePath(isBusinessDeliverablePath(sourceRel) ? sourceRel : stagedRel);
          if (!(await stat(source)).isFile()) throw new Error('Not a file');
        } catch {
          try {
            const raw = await workspacePath(sourceRel);
            if (!(await stat(raw)).isFile()) throw new Error('Not a file');
            const stagedAbs = await workspacePath(stagedRel);
            await mkdir(path.dirname(stagedAbs), { recursive: true, mode: 0o700 });
            await copyFile(raw, stagedAbs);
            source = stagedAbs;
          } catch {
            return { ok: false, error: `Run workspace file is unavailable: ${sourceRel}. Write it with write_workspace_file first.` };
          }
        }
        const dest = await projectPath(destRel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(source, dest);
        const bytes = (await stat(dest)).size;
        return { ok: true, path: stagedRel, projectPath: destRel, bytes, projectRoot, deliverable: true };
      },
    }),
    install_python_dependency: tool({
      description: 'Install a Python package needed by a loaded Skill into this run workspace only. This is allowed by default work permission; it never modifies system Python.',
      inputSchema: z.object({ skillId: z.string().min(1).default('opcai-workspace'), package: z.string().min(1).max(120) }),
      execute: async ({ skillId, package: dependency }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowScriptExecution) return approval(skillId, 'script-execution', 'Installing an isolated dependency requires default work permission.');
        if (!/^[a-zA-Z0-9_.-]+(?:==[a-zA-Z0-9_.+-]+)?$/.test(dependency)) return { ok: false, error: 'Only a simple PyPI package name with an optional exact version is permitted.' };
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const dependencyRoot = path.join(workspaceRoot, '.python-packages');
        const result = await runProcess('python3', ['-m', 'pip', 'install', '--disable-pip-version-check', '--target', dependencyRoot, dependency], workspaceRoot, { timeoutMs: 120_000 });
        return { ok: result.exitCode === 0, package: dependency, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    }),
    fetch_skill_url: tool({
      description: 'Fetch a public HTTPS URL for a loaded Skill. The URL host must be explicitly allowlisted by that Skill. This tool only performs GET requests and returns bounded text.',
      inputSchema: z.object({ skillId: z.string().min(1), url: z.string().url().max(2_000) }),
      execute: async ({ skillId, url }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        const target = new URL(url);
        if (target.protocol !== 'https:') return { ok: false, error: 'Only HTTPS network requests are permitted.' };
        if (!skill.execution.allowAllNonDestructive && !skill.execution.allowedNetworkHosts.includes(target.hostname)) return approval(skillId, 'network-access', `Network access to ${target.hostname} requires your approval and an allowlist entry.`);
        const response = await fetch(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'text/plain, text/markdown, application/json, text/html;q=0.5' } });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) return { ok: false, status: response.status, error: `Network request failed with HTTP ${response.status}.` };
        if (!/^(text\/|application\/(json|xml|javascript))/i.test(contentType)) return { ok: false, error: `Unsupported response content type: ${contentType || 'unknown'}.` };
        const content = truncate(await response.text(), MAX_NETWORK_BYTES);
        return { ok: true, url: target.toString(), contentType, content };
      },
    }),
  };
}
