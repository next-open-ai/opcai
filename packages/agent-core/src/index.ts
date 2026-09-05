import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { stepCountIs, streamText } from 'ai';
import type { AgentEvent, AgentProfile, AgentSkillRuntime, ModelConfig, RunModelRef, TokenUsage } from '@opcai/contracts';
import type { OpcaiTool, ToolPolicy } from '@opcai/tools';
import { compactMessagesForStep, summarizePlainTurns } from './context-compaction.js';
import { createSkillExecutionTools, isBusinessDeliverablePath, promoteWorkspaceDeliverablesToProject } from './skill-runtime.js';
import { createWebSearchTools } from './search-runtime.js';
import { createKnowledgeTools } from './knowledge-runtime.js';
import { createExperienceTools, recallExperienceBlock } from './experience/index.js';
import { loadMcpToolset } from './skills.js';
export * from './skills.js';
export * from './skill-runtime.js';
export * from './context-compaction.js';
export * from './search-runtime.js';
export * from './knowledge-runtime.js';
export * from './experience/index.js';

/**
 * The only Vercel AI SDK boundary in OPCAI. Model execution is deliberately
 * deferred until provider configuration and tool approval UI are implemented.
 */
export interface AgentRuntime {
  start(input: { profile: AgentProfile; prompt: string; tools: OpcaiTool[] }): AsyncIterable<AgentEvent>;
  cancel(runId: string): void;
}

export class PolicyEngine implements ToolPolicy {
  requiresApproval(risk: OpcaiTool['risk']): boolean {
    return risk !== 'read';
  }
}

function asNonNegInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** Map AI SDK LanguageModelUsage → contracts TokenUsage. */
export function tokenUsageFromAiSdk(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined };
  outputTokenDetails?: { reasoningTokens?: number | undefined };
}): TokenUsage | null {
  const inputTokens = asNonNegInt(usage.inputTokens);
  const outputTokens = asNonNegInt(usage.outputTokens);
  const cacheReadTokens = asNonNegInt(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens = asNonNegInt(usage.inputTokenDetails?.cacheWriteTokens);
  const reasoningTokens = asNonNegInt(usage.outputTokenDetails?.reasoningTokens);
  const totalTokens = asNonNegInt(usage.totalTokens) || inputTokens + outputTokens;
  if (inputTokens + outputTokens + totalTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens <= 0) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
}

function modelRefFromConfig(model: ModelConfig): RunModelRef {
  return {
    provider: model.provider,
    chatModel: model.chatModel,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}),
  };
}

export const defaultProfile: AgentProfile = {
  id: 'general',
  name: 'General Assistant',
  instructions: 'You are a helpful assistant.',
  toolIds: [],
};

function usesChatCompletionsApi(provider: ModelConfig['provider']) {
  return provider === 'ollama' || provider === 'deepseek' || provider === 'qwen' || provider === 'openai-compatible';
}

function supportsBuiltinEnableSearch(provider: ModelConfig['provider']) {
  return provider === 'qwen' || provider === 'openai-compatible';
}

function looksLikeDeepseek(config: ModelConfig) {
  if (config.provider === 'deepseek') return true;
  if (config.provider !== 'openai-compatible') return false;
  return /deepseek/i.test(config.baseUrl || '') || /deepseek/i.test(config.chatModel || '');
}

/**
 * Mutate chat-completions JSON body for Ollama think-off, Bailian enable_search,
 * and DeepSeek thinking-off (required for reliable multi-step tool / MCP loops).
 *
 * DeepSeek thinking mode demands that every subsequent tool-turn echoes
 * `reasoning_content`. The OpenAI-compatible AI SDK path does not round-trip
 * that field, so the API returns 400 mid-loop and the final answer never lands.
 */
function chatCompletionsBodyFetch(options: {
  disableThinking?: boolean;
  enableSearch?: boolean;
  disableDeepseekThinking?: boolean;
}) {
  const patchOllama = Boolean(options.disableThinking);
  const patchSearch = Boolean(options.enableSearch);
  const patchDeepseekThinking = Boolean(options.disableDeepseekThinking);
  if (!patchOllama && !patchSearch && !patchDeepseekThinking) return undefined;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body || typeof init.body !== 'string') return fetch(input, init);
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (patchOllama) body.think = false;
      if (patchSearch) body.enable_search = true;
      if (patchDeepseekThinking) {
        body.thinking = { type: 'disabled' };
      }
      return fetch(input, { ...init, body: JSON.stringify(body) });
    } catch {
      return fetch(input, init);
    }
  };
}

function languageModel(config: ModelConfig) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })(config.chatModel);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) })(config.chatModel);
    case 'openai':
    case 'deepseek':
    case 'qwen':
    case 'ollama':
    case 'openai-compatible': {
      const customFetch = chatCompletionsBodyFetch({
        disableThinking: config.provider === 'ollama' && Boolean(config.disableThinking),
        enableSearch: supportsBuiltinEnableSearch(config.provider) && Boolean(config.enableSearch),
        // Agent runs always carry tools; disable DeepSeek thinking to avoid mid-loop 400s.
        disableDeepseekThinking: looksLikeDeepseek(config),
      });
      const openai = createOpenAI({
        apiKey: config.apiKey || 'ollama',
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        ...(customFetch ? { fetch: customFetch } : {}),
      });
      return usesChatCompletionsApi(config.provider) ? openai.chat(config.chatModel) : openai(config.chatModel);
    }
    default: {
      const unsupported: never = config.provider;
      throw new Error(`Unsupported model provider: ${unsupported}`);
    }
  }
}

function streamProviderOptions(config: ModelConfig) {
  if (!config.disableThinking && !looksLikeDeepseek(config)) return undefined;
  if (config.provider === 'ollama') return undefined;
  return {
    openai: {
      reasoningEffort: 'none' as const,
      forceReasoning: false,
    },
  };
}

/** Durable session-memory summarizer (ModelConfig → plain turns). */
export async function summarizeSessionMemory(input: {
  model: ModelConfig;
  previousSummary?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<string | null> {
  const providerOptions = streamProviderOptions(input.model);
  return summarizePlainTurns({
    previousSummary: input.previousSummary,
    turns: input.turns,
    model: languageModel(input.model),
    providerOptions: providerOptions as Record<string, unknown> | undefined,
  });
}

function friendlyModelError(raw: string) {
  if (/reasoning_content/i.test(raw)) {
    return 'DeepSeek 思考模式在工具多轮调用中要求回传 reasoning_content，当前链路已自动关闭 thinking。请重试本轮以生成最终结论。';
  }
  return raw;
}

function skillCatalog(skills: AgentSkillRuntime[]) {
  if (!skills.length) return 'No Skill packages are authorized for this run.';
  return skills.map((skill) => `- ${skill.id} (${skill.mode}): ${skill.description}`).join('\n');
}

/** Authoritative wall-clock for this run — models otherwise invent dates from training cutoffs. */
function runtimeClockContext(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const local = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return [
    'Runtime clock (local machine time for this run; reference only — not a certified time source):',
    `- Local: ${local} (${timeZone})`,
    `- Calendar date (YYYY-MM-DD): ${ymd}`,
    `- UTC ISO: ${now.toISOString()}`,
    'Treat this as the host\'s current wall clock only. Prefer it over training-cutoff guesses for 今天/昨日/本周/最新交易日 and similar relative dates.',
    'For market data tools, set end dates from this calendar date (or the latest session on/before it); never invent a past year from memory. If a data source disagrees about the latest trading day, state that discrepancy.',
  ].join('\n');
}

function defaultSkillInstructions(skills: AgentSkillRuntime[]) {
  return skills
    .filter((skill) => skill.mode === 'default' && skill.instructions)
    .map((skill) => `<skill id="${skill.id}">\n${skill.instructions}\n</skill>`)
    .join('\n\n');
}

function toolInputSummary(toolName: string, input: unknown) {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (toolName === 'load_skill') return `正在加载 Skill：${String(value.skillId || '')}`;
  if (toolName === 'read_skill_file') return `正在读取 Skill 文件：${String(value.path || '')}`;
  if (toolName === 'read_workspace_file') return `正在读取运行工作区文件：${String(value.path || '')}`;
  if (toolName === 'write_workspace_file') {
    const mode = value.mode === 'append' ? '追加' : '写入';
    return `正在${mode}运行工作区文件：${String(value.path || '')}`;
  }
  if (toolName === 'publish_to_project') {
    const dest = value.destPath ? ` → ${String(value.destPath)}` : '';
    return `正在发布到项目空间：${String(value.path || '')}${dest}`;
  }
  if (toolName === 'register_deliverable') return `正在登记业务交付物：${String(value.path || '')}`;
  if (toolName === 'run_skill_script') return `正在执行脚本：${String(value.path || '')}`;
  if (toolName === 'run_workspace_script') return `正在执行生成脚本：${String(value.path || '')}`;
  if (toolName === 'fetch_skill_url') return `正在访问网络资源：${String(value.url || '')}`;
  if (toolName === 'web_search') return `正在联网搜索：${String(value.query || '')}`;
  if (toolName === 'kb_search') return `正在检索知识库：${String(value.query || '')}`;
  if (toolName === 'save_experience') return `正在保存智能体经验：${String(value.title || '')}`;
  if (toolName === 'load_experience') return `正在加载智能体经验：${String(value.query || '')}`;
  return `正在调用工具：${toolName}`;
}

function toolResultSummary(toolName: string, output: unknown) {
  const value = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const failText = () => String(value.message || value.error || `${toolName} 未完成。`);
  if (toolName === 'web_search' && value.ok === false) {
    return `联网搜索未完成：${String(value.provider || '')} · ${String(value.durationMs ?? 0)}ms · ${String(value.error || value.message || '请求失败')}`;
  }
  if (toolName === 'save_experience') {
    return value.ok === false
      ? `经验保存失败：${failText()}`
      : `经验已保存${value.merged ? '（已合并近似条目）' : ''}：${String(value.title || value.id || '')}`;
  }
  if (toolName === 'load_experience') {
    if (value.ok === false) return `经验加载失败：${failText()}`;
    const count = Number(value.count) || 0;
    return count > 0 ? `已加载 ${count} 条高置信经验。` : '未命中高置信经验（已忽略）。';
  }
  if (value.ok === false) return failText();
  if (toolName === 'run_skill_script') return `脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  if (toolName === 'run_workspace_script') {
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts.filter((item): item is string => typeof item === 'string') : [];
    return artifacts.length ? `生成脚本执行完成：${artifacts.join('、')}` : `生成脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  }
  if (toolName === 'write_workspace_file') {
    const mode = value.mode === 'append' ? '已追加' : '已写入';
    return `${mode} ${String(value.path || '运行工作区文件')}${typeof value.totalBytes === 'number' ? `（共 ${value.totalBytes} 字节）` : '。'}`;
  }
  if (toolName === 'publish_to_project') {
    return `已发布到项目空间：${String(value.projectPath || value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'register_deliverable') {
    return `已登记业务交付物：${String(value.path || '')}${typeof value.bytes === 'number' ? `（${value.bytes} 字节）` : ''}`;
  }
  if (toolName === 'fetch_skill_url') return `已获取网络资源（${String(value.contentType || 'text')}）。`;
  if (toolName === 'web_search') {
    const count = Array.isArray(value.results) ? value.results.length : 0;
    const fallback = value.fallbackFrom ? `，已从 ${String(value.fallbackFrom)} 自动降级` : '';
    return `联网搜索完成：${String(value.provider || '')}${fallback}，${count} 条结果，${String(value.durationMs ?? 0)}ms，估算 ${String(value.estimatedCredits ?? 0)} credit。`;
  }
  if (toolName === 'load_skill') return `Skill 已加载：${String((value.skill as Record<string, unknown> | undefined)?.name || '')}`;
  if (toolName === 'read_skill_file') return `已读取 Skill 文件：${String(value.path || '')}`;
  if (toolName === 'read_workspace_file') return `已读取运行工作区文件：${String(value.path || '')}`;
  return '工具调用完成。';
}

function isSoftFailTool(toolName: string) {
  return toolName === 'save_experience' || toolName === 'load_experience';
}

export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

function isAbortLike(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  if (name === 'AbortError') return true;
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
  return /abort|cancel|中止|超时/i.test(message);
}

/**
 * Builds the progressive-disclosure boundary for Agent Skills. Models first
 * see only a catalog, may load an authorized SKILL.md, then may read one of
 * the resources advertised by that loaded package. No filesystem path or
 * arbitrary file access is exposed to the model.
 */
export async function* streamAgentReply(input: {
  profile: AgentProfile;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: ModelConfig;
  skills?: AgentSkillRuntime[];
  searchProviders?: import('@opcai/contracts').SearchProviderRuntime[];
  mcpConnections?: import('@opcai/contracts').McpConnectionRuntime[];
  knowledgeBases?: import('@opcai/contracts').KnowledgeBaseRuntime[];
  runId?: string;
  projectWorkspacePath?: string;
  maxSteps?: number;
  runTimeoutMs?: number;
  mcpToolTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const runId = input.runId?.trim() || crypto.randomUUID();
  const projectRoot = input.projectWorkspacePath?.trim() || '';
  yield { type: 'run.started', runId };
  const mcp = await loadMcpToolset(input.mcpConnections, { toolTimeoutMs: input.mcpToolTimeoutMs });
  const knowledgeTools = createKnowledgeTools({ knowledgeBases: input.knowledgeBases, model: input.model });
  const experienceTools = createExperienceTools({ agentId: input.profile.id, model: input.model });
  const runTimeoutMs = Math.min(1_800_000, Math.max(15_000, Math.round(Number(input.runTimeoutMs) || DEFAULT_RUN_TIMEOUT_MS)));
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Run timed out after ${Math.round(runTimeoutMs / 1000)}s`)), runTimeoutMs);
  const abortSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  try {
    if (abortSignal.aborted) {
      const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
      yield {
        type: 'run.cancelled',
        runId,
        reason: timedOut ? 'timeout' : 'user',
        message: timedOut ? `执行超时（${Math.round(runTimeoutMs / 1000)}s），已自动中止。` : '已由用户中止当前执行。',
      };
      return;
    }
    const skills = input.skills ?? [];
    const defaults = defaultSkillInstructions(skills);
    const kbLabels = (input.knowledgeBases ?? []).filter((item) => item.enabled).map((item) => item.name);
    const searchTools = createWebSearchTools(input.searchProviders ?? []);
    const builtinSearchOn = Boolean(input.model.enableSearch) && supportsBuiltinEnableSearch(input.model.provider);
    const lastUserText = [...input.messages].reverse().find((item) => item.role === 'user')?.content || '';
    let experienceBlock = '';
    if (lastUserText.trim().length >= 4 && Object.keys(experienceTools).length) {
      try {
        experienceBlock = await recallExperienceBlock({
          agentId: input.profile.id,
          query: lastUserText.slice(0, 500),
          model: input.model,
        });
      } catch {
        experienceBlock = '';
      }
    }
    const runtimeInstructions = [
      input.profile.instructions,
      runtimeClockContext(),
      'Authorized Agent Skills (metadata only unless loaded):\n' + skillCatalog(skills),
      defaults ? `Default Skill instructions (already loaded; follow only when relevant):\n${defaults}` : '',
      mcp.labels.length
        ? `Authorized MCP connectors for this run: ${mcp.labels.join(', ')}.`
        : '',
      mcp.instructions || '',
      kbLabels.length ? `Authorized knowledge bases for this run: ${kbLabels.join(', ')}. Use kb_search for internal/private knowledge before guessing.` : '',
      builtinSearchOn
        ? 'Built-in model web search is enabled for this run (provider enable_search). Prefer it for public realtime facts; do not invent sources. Use kb_search for private corpora.'
        : '',
      experienceBlock || '',
      Object.keys(experienceTools).length
        ? 'Agent experience memory is available for this employee only. After a meaningful multi-step success (or a hard-won pitfall), call save_experience with a short structured card (situation/action/pitfall/whenNot). Use load_experience when pivoting to a task that may match prior work. Low-similarity loads return empty—do not invent memories.'
        : '',
      projectRoot
        ? 'This run is bound to a shared project workspace. Keep generators under the run workspace (prefer scripts/). Put finished business products under output/ (or write_workspace_file with deliverable=true / register_deliverable). Prefer publish_to_project for each finished output/ file so it appears in the project tree mid-run; end-of-run auto-promotes remaining output/ files.'
        : '',
      'Use load_skill only for a relevant authorized Skill. The platform harness `opcai-workspace` is pre-authorized for this run: use skillId `opcai-workspace` for write_workspace_file, run_workspace_script, register_deliverable, install_python_dependency, and publish_to_project (when a project workspace is bound) when the run permission tier allows. Skill files are read-only. Process files (generators, caches) stay outside output/ and are never archived. Finished business deliverables MUST be under output/ — write there directly, pass deliverable=true, or call register_deliverable (this allows final .py/.js products without mistaking them for tooling). Scripts should write finals to output/<name>; the platform also stages accidental root documents (pdf/html/…) into output/ after script runs. Default work permission allows workspace writes, script execution, and isolated Python dependency installation. Host-level network for skills is capability-gated. Never claim an operation ran unless its tool returned a successful result. After load_skill, only read or execute paths explicitly returned in its files list. For artifact requests (PDFs, reports, code packages, data files), do not stop at a plan: produce the file under output/. When writing websites or large codebases: (1) keep each write_workspace_file body under ~8KB, (2) split CSS/JS/HTML or use mode "append" / chunks, (3) ship critical pages under output/ before polish, (4) on JSON/parse write failures retry with a much smaller chunk, (5) if a project is bound, publish_to_project each output/ asset (auto-promote also runs at the end). If a Skill needs a generator but has none, write a minimal script outside output/ (e.g. scripts/generate.py) and run it with run_workspace_script; use install_python_dependency when needed. Use reasonable defaults for non-critical details. If a required permission, script, dependency, or output path is unavailable, state the exact blocker and the one next user action.',
    ].filter(Boolean).join('\n\n');
    const model = languageModel(input.model);
    const providerOptions = streamProviderOptions(input.model);
    const maxSteps = Math.min(64, Math.max(4, Math.round(Number(input.maxSteps) || 28)));
    const result = streamText({
      model,
      system: runtimeInstructions,
      messages: input.messages,
      tools: {
        ...createSkillExecutionTools({ skills, runId, projectRoot: projectRoot || undefined }),
        ...searchTools,
        ...knowledgeTools,
        ...experienceTools,
        ...mcp.tools,
      },
      stopWhen: stepCountIs(maxSteps),
      providerOptions,
      abortSignal,
      prepareStep: async ({ messages, model: stepModel }) => {
        const compacted = await compactMessagesForStep({
          messages,
          model: stepModel,
          providerOptions: providerOptions as Record<string, unknown> | undefined,
        });
        if (!compacted.didPrune && !compacted.didSummarize) return undefined;
        return { messages: compacted.messages };
      },
    });
    let emittedText = false;
    let lastToolSucceeded: boolean | undefined;
    let usageSteps = 0;
    const modelRef = modelRefFromConfig(input.model);
    const emittedArtifactPaths = new Set<string>();
    const pushDeliverable = function* (rawPath: string): Generator<AgentEvent> {
      const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!isBusinessDeliverablePath(normalized) || emittedArtifactPaths.has(normalized)) return;
      emittedArtifactPaths.add(normalized);
      yield { type: 'artifact.created', runId, path: normalized };
    };
    for await (const part of result.fullStream) {
      if (abortSignal.aborted) break;
      if (part.type === 'text-delta') { emittedText = true; yield { type: 'message.delta', runId, text: part.text }; }
      else if (part.type === 'tool-call') yield { type: 'tool.started', runId, toolName: part.toolName, summary: toolInputSummary(part.toolName, part.input) };
      else if (part.type === 'tool-result') {
        const output = part.output;
        const approvalRequest = output && typeof output === 'object' ? (output as Record<string, unknown>).approval : undefined;
        if (approvalRequest && typeof approvalRequest === 'object') {
          const approval = approvalRequest as Record<string, unknown>;
          const capability = approval.capability;
          if (typeof approval.skillId === 'string' && (capability === 'workspace-write' || capability === 'script-execution' || capability === 'network-access')) {
            yield { type: 'tool.approval_required', runId, skillId: approval.skillId, capability, summary: toolResultSummary(part.toolName, output) };
          }
        }
        const logicalOk = !(output && typeof output === 'object' && (output as Record<string, unknown>).ok === false);
        const ok = logicalOk || isSoftFailTool(part.toolName);
        lastToolSucceeded = logicalOk;
        yield { type: 'tool.completed', runId, toolName: part.toolName, summary: toolResultSummary(part.toolName, output), ok };
        if (logicalOk && (part.toolName === 'run_workspace_script' || part.toolName === 'run_skill_script') && output && typeof output === 'object') {
          const artifacts = (output as Record<string, unknown>).artifacts;
          if (Array.isArray(artifacts)) for (const artifact of artifacts) if (typeof artifact === 'string') yield* pushDeliverable(artifact);
        }
        if (logicalOk && (part.toolName === 'write_workspace_file' || part.toolName === 'register_deliverable') && output && typeof output === 'object') {
          const value = output as Record<string, unknown>;
          if (value.deliverable === true && typeof value.path === 'string') yield* pushDeliverable(value.path);
        }
        if (logicalOk && part.toolName === 'publish_to_project' && output && typeof output === 'object') {
          const value = output as Record<string, unknown>;
          if (typeof value.path === 'string' && typeof value.projectPath === 'string') {
            yield { type: 'project.file.published', runId, path: value.path, projectPath: value.projectPath };
            yield* pushDeliverable(value.path);
          }
        }
        if (logicalOk && part.toolName === 'web_search' && output && typeof output === 'object') {
          const value = output as Record<string, unknown>; const sources = Array.isArray(value.sources) ? value.sources.filter((item): item is { title: string; url: string; source?: string } => Boolean(item && typeof item === 'object' && typeof (item as any).title === 'string' && typeof (item as any).url === 'string')).slice(0, 10) : [];
          if (sources.length) yield { type: 'search.sources', runId, provider: String(value.provider || ''), sources };
        }
      } else if (part.type === 'tool-error') {
        lastToolSucceeded = false;
        const raw = part.error instanceof Error ? part.error.message : String(part.error);
        const hint = /JSON|parse|Invalid input|Unterminated string/i.test(raw)
          ? ' 写入内容过大或转义失败：请改用更小的 content，或分多次 mode=append / chunks 写入。'
          : '';
        yield { type: 'tool.failed', runId, toolName: part.toolName, summary: `${raw}${hint}` };
      } else if (part.type === 'finish-step') {
        const mapped = tokenUsageFromAiSdk(part.usage);
        if (mapped) {
          yield { type: 'run.usage', runId, usage: mapped, model: modelRef, stepIndex: usageSteps };
          usageSteps += 1;
        }
      } else if (part.type === 'finish') {
        if (usageSteps === 0) {
          const mapped = tokenUsageFromAiSdk(part.totalUsage);
          if (mapped) {
            yield { type: 'run.usage', runId, usage: mapped, model: modelRef, stepIndex: 0 };
            usageSteps += 1;
          }
        }
      } else if (part.type === 'error') {
        const raw = part.error instanceof Error ? part.error.message : String(part.error);
        yield { type: 'run.failed', runId, message: friendlyModelError(raw) };
        return;
      }
    }
    if (usageSteps === 0 && !abortSignal.aborted) {
      try {
        const mapped = tokenUsageFromAiSdk(await result.totalUsage);
        if (mapped) {
          yield { type: 'run.usage', runId, usage: mapped, model: modelRef, stepIndex: 0 };
          usageSteps += 1;
        }
      } catch {
        /* providers may omit usage */
      }
    }
    if (abortSignal.aborted) {
      const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
      yield {
        type: 'run.cancelled',
        runId,
        reason: timedOut ? 'timeout' : 'user',
        message: timedOut ? `执行超时（${Math.round(runTimeoutMs / 1000)}s），已自动中止。` : '已由用户中止当前执行。',
      };
      return;
    }
    if (!emittedText && lastToolSucceeded !== undefined) yield { type: 'message.delta', runId, text: lastToolSucceeded ? '工具调用已完成。请查看上方执行记录和运行工作区产物。' : '工具未能完成请求；请查看上方执行记录中的权限或输入原因。' };
    // Auto-promote deliverables under output/ so the project file tree is filled even when the
    // model never called publish_to_project (or only published a subset).
    if (projectRoot) {
      const workspaceRoot = path.join(
        process.env.OPCAI_WORKSPACES_DIR || path.join(process.cwd(), '.opcai-workspaces'),
        runId,
      );
      const published = await promoteWorkspaceDeliverablesToProject(workspaceRoot, projectRoot);
      for (const item of published) {
        yield { type: 'project.file.published', runId, path: item.path, projectPath: item.projectPath };
        yield* pushDeliverable(item.path);
      }
    }
    yield { type: 'run.completed', runId };
  } catch (error) {
    if (isAbortLike(error, abortSignal)) {
      const timedOut = timeoutController.signal.aborted && !input.abortSignal?.aborted;
      yield {
        type: 'run.cancelled',
        runId,
        reason: timedOut ? 'timeout' : 'user',
        message: timedOut ? `执行超时（${Math.round(runTimeoutMs / 1000)}s），已自动中止。` : '已由用户中止当前执行。',
      };
    } else {
      const raw = error instanceof Error ? error.message : 'Model request failed.';
      yield { type: 'run.failed', runId, message: friendlyModelError(raw) };
    }
  } finally {
    clearTimeout(timeoutId);
    await mcp.close();
  }
}
