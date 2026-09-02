import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
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

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value;
}

function safeRelative(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Path must be a safe relative path.');
  return normalized;
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

async function listWorkspaceArtifacts(root: string, folder = root, depth = 0, entries: string[] = []): Promise<string[]> {
  if (depth > 5 || entries.length >= 40) return entries;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) await listWorkspaceArtifacts(root, target, depth + 1, entries);
    } else if (entry.isFile()) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      // Generator sources are execution plumbing, not user-facing outputs.
      if (!/\.(sh|js|mjs|cjs|py)$/i.test(relative)) entries.push(relative);
    }
    if (entries.length >= 40) break;
  }
  return entries;
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
 */
export function createSkillExecutionTools(input: { skills: AgentSkillRuntime[]; runId: string }): Record<string, Tool<any, any, any>> {
  const packages = new Map(input.skills.map((skill) => [skill.id, skill]));
  const workspaceRoot = path.join(process.env.OPCAI_WORKSPACES_DIR || path.join(process.cwd(), '.opcai-workspaces'), input.runId);
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
    const result = await runProcess(command, [script, ...args], workspaceRoot, { env: { ...process.env, PYTHONPATH: dependencyRoot } });
    const artifacts = await listWorkspaceArtifacts(workspaceRoot).catch(() => []);
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
        } catch (error) {
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
      description: 'Write a text artifact to this run\'s isolated workspace. Keep each call small: prefer content ≤8KB, or pass chunks (≤4KB each). For larger HTML/CSS/JS, call again with mode "append". Never put an entire multi-page site into one call.',
      inputSchema: z.object({
        skillId: z.string().min(1),
        path: z.string().min(1).max(240),
        content: z.string().max(MAX_WRITE_CONTENT).optional(),
        chunks: z.array(z.string().max(MAX_WRITE_CHUNK)).max(MAX_WRITE_CHUNKS).optional(),
        mode: z.enum(['replace', 'append']).default('replace'),
      }).superRefine((value, ctx) => {
        const hasContent = typeof value.content === 'string' && value.content.length > 0;
        const hasChunks = Array.isArray(value.chunks) && value.chunks.length > 0;
        if (!hasContent && !hasChunks) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide content or chunks.' });
      }),
      execute: async ({ skillId, path: relative, content, chunks, mode }) => {
        ensureLoaded(skillId);
        const skill = getSkill(skillId);
        if (!skill.execution.allowWorkspaceWrite) return approval(skillId, 'workspace-write', 'Writing an artifact to this run workspace requires your approval.');
        if (!textFilePattern.test(relative)) return { ok: false, error: 'Only approved text formats can be written.' };
        const body = typeof content === 'string' && content.length ? content : (chunks ?? []).join('');
        if (!body) return { ok: false, error: 'Write body is empty. Pass content or chunks.' };
        if (Buffer.byteLength(body) > MAX_FILE_BYTES) return { ok: false, error: `Single write exceeds ${MAX_FILE_BYTES} bytes. Split with mode "append".` };
        const file = await workspacePath(relative);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        if (mode === 'append') await writeFile(file, body, { encoding: 'utf8', flag: 'a', mode: 0o600 });
        else await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
        const size = (await stat(file)).size;
        return { ok: true, path: safeRelative(relative), bytes: Buffer.byteLength(body), totalBytes: size, mode };
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
        } catch (_) { return { ok: false, error: `Script is unavailable: ${normalized}. Use only a script listed by load_skill.` }; }
        await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
        const extension = path.extname(script).toLowerCase();
        const command = extension === '.py' ? 'python3' : extension === '.sh' ? 'bash' : process.execPath;
        const result = await runProcess(command, [script, ...args], workspaceRoot);
        return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      },
    }),
    run_workspace_script: tool({
      description: 'Run a script previously written to this isolated run workspace. Use this only to create an artifact when the loaded Skill permits both workspace writes and script execution. No shell expressions are accepted.',
      inputSchema: z.object({ skillId: z.string().min(1), path: z.string().min(1).max(240), args: z.array(z.string().max(500)).max(16).default([]) }),
      execute: async ({ skillId, path: relative, args }) => runWorkspaceScript(skillId, relative, args),
    }),
    install_python_dependency: tool({
      description: 'Install a Python package needed by a loaded Skill into this run workspace only. This is allowed by default work permission; it never modifies system Python.',
      inputSchema: z.object({ skillId: z.string().min(1), package: z.string().min(1).max(120) }),
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
