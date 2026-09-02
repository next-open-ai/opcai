import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { stepCountIs, streamText } from 'ai';
import type { AgentEvent, AgentProfile, AgentSkillRuntime, ModelConfig } from '@opcai/contracts';
import type { OpcaiTool, ToolPolicy } from '@opcai/tools';
import { compactMessagesForStep } from './context-compaction.js';
import { createSkillExecutionTools } from './skill-runtime.js';
export * from './skills.js';
export * from './skill-runtime.js';
export * from './context-compaction.js';

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

export const defaultProfile: AgentProfile = {
  id: 'general',
  name: 'General Assistant',
  instructions: 'You are a helpful assistant.',
  toolIds: [],
};

function usesChatCompletionsApi(provider: ModelConfig['provider']) {
  return provider === 'ollama' || provider === 'deepseek' || provider === 'qwen' || provider === 'openai-compatible';
}

function ollamaThinkFetch(disableThinking: boolean) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!disableThinking || !init?.body || typeof init.body !== 'string') {
      return fetch(input, init);
    }
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      body.think = false;
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
      const openai = createOpenAI({
        apiKey: config.apiKey || 'ollama',
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        ...(config.provider === 'ollama' ? { fetch: ollamaThinkFetch(Boolean(config.disableThinking)) } : {}),
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
  if (!config.disableThinking) return undefined;
  if (config.provider === 'ollama') return undefined;
  return {
    openai: {
      reasoningEffort: 'none' as const,
      forceReasoning: false,
    },
  };
}

function skillCatalog(skills: AgentSkillRuntime[]) {
  if (!skills.length) return 'No Skill packages are authorized for this run.';
  return skills.map((skill) => `- ${skill.id} (${skill.mode}): ${skill.description}`).join('\n');
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
  if (toolName === 'run_skill_script') return `正在执行脚本：${String(value.path || '')}`;
  if (toolName === 'run_workspace_script') return `正在执行生成脚本：${String(value.path || '')}`;
  if (toolName === 'fetch_skill_url') return `正在访问网络资源：${String(value.url || '')}`;
  return `正在调用工具：${toolName}`;
}

function toolResultSummary(toolName: string, output: unknown) {
  const value = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  if (value.ok === false) return String(value.error || `${toolName} 未完成。`);
  if (toolName === 'run_skill_script') return `脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  if (toolName === 'run_workspace_script') {
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts.filter((item): item is string => typeof item === 'string') : [];
    return artifacts.length ? `生成脚本执行完成：${artifacts.join('、')}` : `生成脚本执行完成（退出码 ${String(value.exitCode ?? 0)}）。`;
  }
  if (toolName === 'write_workspace_file') {
    const mode = value.mode === 'append' ? '已追加' : '已写入';
    return `${mode} ${String(value.path || '运行工作区文件')}${typeof value.totalBytes === 'number' ? `（共 ${value.totalBytes} 字节）` : '。'}`;
  }
  if (toolName === 'fetch_skill_url') return `已获取网络资源（${String(value.contentType || 'text')}）。`;
  if (toolName === 'load_skill') return `Skill 已加载：${String((value.skill as Record<string, unknown> | undefined)?.name || '')}`;
  if (toolName === 'read_skill_file') return `已读取 Skill 文件：${String(value.path || '')}`;
  if (toolName === 'read_workspace_file') return `已读取运行工作区文件：${String(value.path || '')}`;
  return '工具调用完成。';
}

/**
 * Builds the progressive-disclosure boundary for Agent Skills. Models first
 * see only a catalog, may load an authorized SKILL.md, then may read one of
 * the resources advertised by that loaded package. No filesystem path or
 * arbitrary file access is exposed to the model.
 */
export async function* streamAgentReply(input: { profile: AgentProfile; messages: Array<{ role: 'user' | 'assistant'; content: string }>; model: ModelConfig; skills?: AgentSkillRuntime[] }): AsyncGenerator<AgentEvent> {
  const runId = crypto.randomUUID();
  yield { type: 'run.started', runId };
  try {
    const skills = input.skills ?? [];
    const defaults = defaultSkillInstructions(skills);
    const runtimeInstructions = [
      input.profile.instructions,
      'Authorized Agent Skills (metadata only unless loaded):\n' + skillCatalog(skills),
      defaults ? `Default Skill instructions (already loaded; follow only when relevant):\n${defaults}` : '',
      'Use load_skill only for a relevant authorized Skill. The platform harness `opcai-workspace` is pre-authorized for this run: use skillId `opcai-workspace` for write_workspace_file, run_workspace_script, and install_python_dependency when the run permission tier allows. Skill files are read-only. Generated files belong in the isolated run workspace. Default work permission allows workspace writes, script execution, and isolated Python dependency installation through that harness. Direct network access is capability-gated; never claim an operation ran unless its tool returned a successful result. After load_skill, only read or execute paths explicitly returned in its files list; never guess a filename from an instruction example. For artifact requests (for example PDFs, reports, code, or data files), do not stop at a plan or ask avoidable follow-up questions. When writing websites or large codebases: (1) keep each write_workspace_file body under ~8KB, (2) split CSS/JS/HTML into multiple files or use mode "append" / chunks, (3) ship the critical HTML pages before polish, (4) if a write fails with JSON/parse/input errors, immediately retry with a much smaller chunk—never paste the same huge payload again. If the Skill documents a creation workflow but has no generator script, write a minimal generator script to the run workspace and invoke run_workspace_script with skillId `opcai-workspace`. If a Python dependency such as reportlab is required, use install_python_dependency before executing. Use reasonable defaults for non-critical details. If a required permission, script, dependency, or output path is unavailable, state the exact blocker and the one next user action in the final answer.',
    ].filter(Boolean).join('\n\n');
    const model = languageModel(input.model);
    const providerOptions = streamProviderOptions(input.model);
    const result = streamText({
      model,
      system: runtimeInstructions,
      messages: input.messages,
      tools: createSkillExecutionTools({ skills, runId }),
      stopWhen: stepCountIs(28),
      providerOptions,
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
    for await (const part of result.fullStream) {
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
        const ok = !(output && typeof output === 'object' && (output as Record<string, unknown>).ok === false);
        lastToolSucceeded = ok;
        yield { type: 'tool.completed', runId, toolName: part.toolName, summary: toolResultSummary(part.toolName, output), ok };
        if (ok && (part.toolName === 'run_workspace_script' || part.toolName === 'run_skill_script') && output && typeof output === 'object') {
          const artifacts = (output as Record<string, unknown>).artifacts;
          if (Array.isArray(artifacts)) for (const artifact of artifacts) if (typeof artifact === 'string') yield { type: 'artifact.created', runId, path: artifact };
        }
        if (ok && part.toolName === 'write_workspace_file' && output && typeof output === 'object') {
          const artifact = (output as Record<string, unknown>).path;
          if (typeof artifact === 'string' && !/\.(sh|js|mjs|cjs|py)$/i.test(artifact)) yield { type: 'artifact.created', runId, path: artifact };
        }
      } else if (part.type === 'tool-error') {
        lastToolSucceeded = false;
        const raw = part.error instanceof Error ? part.error.message : String(part.error);
        const hint = /JSON|parse|Invalid input|Unterminated string/i.test(raw)
          ? ' 写入内容过大或转义失败：请改用更小的 content，或分多次 mode=append / chunks 写入。'
          : '';
        yield { type: 'tool.failed', runId, toolName: part.toolName, summary: `${raw}${hint}` };
      }
    }
    if (!emittedText && lastToolSucceeded !== undefined) yield { type: 'message.delta', runId, text: lastToolSucceeded ? '工具调用已完成。请查看上方执行记录和运行工作区产物。' : '工具未能完成请求；请查看上方执行记录中的权限或输入原因。' };
    yield { type: 'run.completed', runId };
  } catch (error) {
    yield { type: 'run.failed', runId, message: error instanceof Error ? error.message : 'Model request failed.' };
  }
}
