import { computed, ref } from 'vue';
import { streamChat, type RuntimeSkill, type ToolActivity, type ToolApproval } from '../services/api.js';
import type { ProviderConfig } from './model-config.js';
import { toModelPayload } from './model-config.js';
import { readStored, writeStored } from './storage.js';
import {
  BASELINE_WORKSPACE_SKILL_ID,
  mergeRuntimeSkills,
} from './baseline-skills.js';
import { useCapabilities, type ExecutionLevel } from './capabilities.js';
import { useAssets, type Asset } from './assets.js';
import type { Automation } from './automations.js';

export type View = 'chat' | 'employees' | 'capabilities' | 'assets' | 'automations' | 'projects' | 'settings';
export type EmployeeId = 'general' | 'research' | 'code' | 'administrator';

export interface Employee { id: EmployeeId; color: string; nameKey: string; descriptionKey: string; initials: string; system?: boolean; }
export type CollaborationDelivery = 'synthesize' | 'direct';
export interface CollaborationRun { employeeId: EmployeeId; task: string; status: 'running' | 'completed' | 'failed'; summary: string; activities: ToolActivity[]; error?: string; }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; activities?: ToolActivity[]; approvals?: ToolApproval[]; assets?: Asset[]; collaborations?: CollaborationRun[]; collaborationDelivery?: CollaborationDelivery; }
export interface Conversation { id: string; title: string; employeeId: EmployeeId; messages: Message[]; updatedAt: number; }
export interface ProjectTaskDraft { title: string; objective: string; employeeId: EmployeeId; skillIds: string[]; }
export interface ProjectTaskTranscript { assistantContent: string; activities: ToolActivity[]; approvals: ToolApproval[]; assets: Array<{ id: string; name: string; sizeBytes: number; runId?: string }>; runId?: string; }

const employees: Employee[] = [
  { id: 'general', color: '#526fe0', initials: 'AI', nameKey: 'employee.general.name', descriptionKey: 'employee.general.description' },
  { id: 'research', color: '#0f9b8e', initials: 'R', nameKey: 'employee.research.name', descriptionKey: 'employee.research.description' },
  { id: 'code', color: '#8b5bd3', initials: '</>', nameKey: 'employee.code.name', descriptionKey: 'employee.code.description' },
  { id: 'administrator', color: '#263449', initials: 'SYS', nameKey: 'employee.administrator.name', descriptionKey: 'employee.administrator.description', system: true },
];

const view = ref<View>('chat');
const currentEmployeeId = ref<EmployeeId>('general');
const conversations = ref<Conversation[]>([]);
const activeConversationId = ref<string | null>(null);
const permissionTierByEmployee = ref<Record<string, ExecutionLevel>>({});
const sessionGrants = new Map<string, Set<ToolApproval['capability']>>();

async function persist() { await writeStored('workspace.conversations', JSON.stringify(conversations.value)); }
async function load() {
  try { conversations.value = JSON.parse((await readStored('workspace.conversations')) ?? '[]') as Conversation[]; } catch { conversations.value = []; }
  const employee = await readStored('workspace.default-employee');
  if (employees.some((item) => item.id === employee)) currentEmployeeId.value = employee as EmployeeId;
  activeConversationId.value = conversations.value[0]?.id ?? null;
  permissionTierByEmployee.value = parsePermissionTiers(await readStored('workspace.permission-tiers'));
}
function parsePermissionTiers(value: string | null): Record<string, ExecutionLevel> { try { const parsed = JSON.parse(value || '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(parsed).filter(([, tier]) => tier === 'read-only' || tier === 'default' || tier === 'extended' || tier === 'full')) as Record<string, ExecutionLevel>; } catch { return {}; } }

export function useWorkspace() {
  const { allowedSkillsFor, policyFor, skills, setExecutionPolicy } = useCapabilities();
  const { archiveArtifact } = useAssets();
  const permissionTier = computed<ExecutionLevel>(() => permissionTierByEmployee.value[currentEmployeeId.value] ?? 'default');
  const skillRuntimeFor = async (employeeId: EmployeeId, onlySkillIds?: string[], tierOverride?: ExecutionLevel): Promise<RuntimeSkill[]> => {
    const tier = tierOverride ?? permissionTierByEmployee.value[employeeId] ?? 'default';
    const authorized = allowedSkillsFor(employeeId).filter((skill) => skill.id !== BASELINE_WORKSPACE_SKILL_ID && (!onlySkillIds?.length || onlySkillIds.includes(skill.id))).sort((left, right) => (policyFor(employeeId, right.id)?.mode === 'default' ? 1 : 0) - (policyFor(employeeId, left.id)?.mode === 'default' ? 1 : 0));
    const userSkills = await Promise.all(authorized.map(async (skill) => {
      const mode = policyFor(employeeId, skill.id)?.mode === 'default' ? 'default' as const : 'available' as const;
      let instructions: string | undefined;
      let resources: RuntimeSkill['resources'] = [];
      if (skill.path) {
        try {
          instructions = (await window.opcaiDesktop?.readSkillDraft(skill.path))?.content.slice(0, 24_000);
          const files = await window.opcaiDesktop?.listSkillFiles(skill.path) ?? [];
          const readable = files.filter((file) => file.type === 'file' && file.relative !== 'SKILL.md' && /\.(md|txt|json|ya?ml)$/i.test(file.relative)).slice(0, 20);
          resources = (await Promise.all(readable.map(async (file) => {
            try { const result = await window.opcaiDesktop?.readSkillFile(file.path); return result ? { path: file.relative, content: result.content.slice(0, 48_000) } : null; } catch { return null; }
          }))).filter((item): item is { path: string; content: string } => item !== null);
        } catch { /* Metadata-only Skills remain safely usable in the catalog. */ }
      }
      const rootPath = skill.path?.replace(/[\\/][^\\/]+$/, '');
      return {
        id: skill.id, name: skill.name, description: skill.description, mode, ...(rootPath ? { rootPath } : {}), ...(instructions ? { instructions } : {}), resources,
        // Persisted per-Skill permissions are deny-by-default and are enforced
        // again by Agent Core; they are not model-controlled.
        execution: {
          ...skill.execution,
          allowWorkspaceWrite: tier !== 'read-only' && (skill.execution.allowWorkspaceWrite || sessionGrants.get(skill.id)?.has('workspace-write') === true),
          allowScriptExecution: tier !== 'read-only' && (skill.execution.allowScriptExecution || sessionGrants.get(skill.id)?.has('script-execution') === true),
          allowAllNonDestructive: tier === 'full',
        },
      };
    }));
    return mergeRuntimeSkills(tier, userSkills).map((skill) => ({
      ...skill,
      execution: {
        ...skill.execution,
        allowWorkspaceWrite: skill.execution.allowWorkspaceWrite || sessionGrants.get(skill.id)?.has('workspace-write') === true,
        allowScriptExecution: skill.execution.allowScriptExecution || sessionGrants.get(skill.id)?.has('script-execution') === true,
      },
    }));
  };
  const activeConversation = computed(() => conversations.value.find((item) => item.id === activeConversationId.value) ?? null);
  const currentEmployee = computed(() => employees.find((item) => item.id === currentEmployeeId.value) ?? employees[0]);
  const setView = (value: View) => { view.value = value; };
  const startChat = (employeeId: EmployeeId = currentEmployeeId.value) => {
    currentEmployeeId.value = employeeId;
    activeConversationId.value = null;
    view.value = 'chat';
  };
  const selectConversation = (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    if (!conversation) return;
    activeConversationId.value = id;
    currentEmployeeId.value = conversation.employeeId;
    view.value = 'chat';
  };
  const clearConversation = async (id: string) => {
    const conversation = conversations.value.find((item) => item.id === id);
    if (!conversation) return;
    conversation.messages = [];
    conversation.updatedAt = Date.now();
    conversations.value = [...conversations.value];
    await persist();
  };
  const deleteConversation = async (id: string) => {
    const index = conversations.value.findIndex((item) => item.id === id);
    if (index < 0) return;
    conversations.value = conversations.value.filter((item) => item.id !== id);
    if (activeConversationId.value === id) activeConversationId.value = conversations.value[0]?.id ?? null;
    await persist();
  };
  const selectEmployee = (id: EmployeeId) => { currentEmployeeId.value = id; };
  const setDefaultEmployee = (id: EmployeeId) => { currentEmployeeId.value = id; void writeStored('workspace.default-employee', id); };
  const setPermissionTier = (tier: ExecutionLevel) => { permissionTierByEmployee.value = { ...permissionTierByEmployee.value, [currentEmployeeId.value]: tier }; void writeStored('workspace.permission-tiers', JSON.stringify(permissionTierByEmployee.value)); };
  const addMessage = async (content: string, model: ProviderConfig, options: { employeeId?: EmployeeId; skillIds?: string[]; collaboratorIds?: EmployeeId[]; collaborationDelivery?: CollaborationDelivery; newConversation?: boolean } = {}) => {
    const text = content.trim(); if (!text) return undefined;
    if (options.employeeId) currentEmployeeId.value = options.employeeId;
    if (options.newConversation) activeConversationId.value = null;
    let conversation = activeConversation.value;
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), title: text.slice(0, 28), employeeId: currentEmployeeId.value, messages: [], updatedAt: Date.now() };
      conversations.value.unshift(conversation); activeConversationId.value = conversation.id;
    }
    conversation.messages.push({ id: crypto.randomUUID(), role: 'user', content: text });
    const userMessage = conversation.messages[conversation.messages.length - 1];
    conversation.updatedAt = Date.now();
    conversations.value = [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt);
    void persist();
    const employee = currentEmployee.value;
    const skills = await skillRuntimeFor(employee.id, options.skillIds);
    const assistantMessage: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', activities: [], approvals: [], assets: [], collaborations: [] };
    conversation.messages.push(assistantMessage);
    try {
      const collaboratorIds = [...new Set(options.collaboratorIds ?? [])].filter((id) => id !== employee.id).slice(0, 3);
      // A single selected specialist can own the answer directly. With multiple
      // reports, the primary employee must reconcile scope and possible conflicts.
      assistantMessage.collaborationDelivery = collaboratorIds.length === 1
        ? (options.collaborationDelivery ?? 'direct')
        : 'synthesize';
      if (collaboratorIds.length) {
        const collaboratorTask = (id: EmployeeId) => ({
          research: '聚焦事实、证据、资料线索与不确定性；给出可核查的研究简报。',
          code: '聚焦技术可行性、实现路径、工程风险与验证建议；给出技术简报。',
          general: '聚焦用户目标、执行方案、交付结构与表达方式；给出行动简报。',
          administrator: '聚焦权限、安全、运行边界和治理风险；给出审查简报。',
        }[id]);
        assistantMessage.collaborations = collaboratorIds.map((employeeId) => ({ employeeId, task: collaboratorTask(employeeId), status: 'running', summary: '', activities: [] }));
        conversations.value = [...conversations.value];
        await Promise.all(collaboratorIds.map(async (collaboratorId) => {
          const collaborator = employees.find((item) => item.id === collaboratorId);
          const run = assistantMessage.collaborations?.find((item) => item.employeeId === collaboratorId);
          if (!collaborator || !run) return;
          try {
            const collaboratorSkills = await skillRuntimeFor(collaborator.id, undefined, 'read-only');
            await streamChat({
              profile: { id: collaborator.id, name: collaborator.id, toolIds: collaboratorSkills.map((skill) => skill.id), instructions: `You are OPCAI's ${collaborator.id} digital employee acting as a consultation collaborator. Your assigned focus is: ${run.task} Analyze only the assigned user request. Do not delegate, do not write files, do not execute scripts, and return a concise evidence-based brief in the user's language for the primary employee.` },
              messages: [{ role: 'user', content: `用户请求：${text}\n\n你的分工：${run.task}` }], model: toModelPayload(model), skills: collaboratorSkills,
            }, (delta) => { run.summary += delta; conversations.value = [...conversations.value]; }, (activity) => {
              const existing = run.activities.find((item) => item.toolName === activity.toolName && item.status === 'running');
              if (existing && activity.status !== 'running') Object.assign(existing, activity); else run.activities.push(activity);
              conversations.value = [...conversations.value];
            });
            run.status = 'completed';
          } catch (cause) { run.status = 'failed'; run.error = cause instanceof Error ? cause.message : '协作者未能完成任务。'; }
          conversations.value = [...conversations.value];
        }));
      }
      const collaborationBrief = (assistantMessage.collaborations ?? []).filter((item) => item.status === 'completed' && item.summary.trim()).map((item) => `### ${item.employeeId} 协作者报告\n${item.summary}`).join('\n\n');
      if (collaboratorIds.length === 1 && assistantMessage.collaborationDelivery === 'direct' && collaborationBrief) {
        assistantMessage.content = assistantMessage.collaborations?.[0]?.summary ?? '';
        conversations.value = [...conversations.value];
        void persist();
        return {
          conversationId: conversation.id,
          transcript: { prompt: userMessage.content, conversationId: conversation.id, assistantContent: assistantMessage.content, activities: [], approvals: [], assets: [] },
        };
      }
      await streamChat({
        profile: { id: employee.id, name: employee.id, toolIds: skills.map((skill) => skill.id), instructions: `You are OPCAI's ${employee.id} digital employee. Be helpful, accurate, and concise. Reply in the user's language. ${collaborationBrief ? 'This turn includes reports from explicitly selected collaborators. Synthesize their useful findings, resolve conflicts, and do not claim they completed actions you cannot verify.' : ''}` },
        messages: conversation.messages.filter((message) => message.id !== assistantMessage.id).map(({ role, content }) => ({ role, content: role === 'user' && content === text && collaborationBrief ? `${content}\n\n协作者报告（仅作参考）：\n${collaborationBrief}` : content })),
        model: toModelPayload(model),
        skills,
      }, (delta: string) => { assistantMessage.content += delta; conversations.value = [...conversations.value]; }, (activity) => {
        const existing = assistantMessage.activities?.find((item) => item.toolName === activity.toolName && item.status === 'running');
        if (existing && activity.status !== 'running') Object.assign(existing, activity);
        else assistantMessage.activities?.push(activity);
        conversations.value = [...conversations.value];
      }, (approval) => { if (!assistantMessage.approvals?.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) assistantMessage.approvals?.push(approval); conversations.value = [...conversations.value]; }, async (artifact) => {
        try {
          const asset = await archiveArtifact({ runId: artifact.runId, relativePath: artifact.path, conversationId: conversation.id, employeeId: employee.id });
          if (!assistantMessage.assets?.some((item) => item.id === asset.id)) assistantMessage.assets?.push(asset);
          conversations.value = [...conversations.value];
        } catch (error) {
          assistantMessage.activities?.push({ toolName: 'archive_asset', status: 'failed', summary: error instanceof Error ? error.message : '资产归档失败。' });
          conversations.value = [...conversations.value];
        }
      });
      void persist();
      return {
        conversationId: conversation.id,
        transcript: {
          prompt: userMessage.content,
          conversationId: conversation.id,
          assistantContent: assistantMessage.content,
          activities: [...(assistantMessage.activities ?? [])],
          approvals: [...(assistantMessage.approvals ?? [])],
          assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        },
      };
    } catch (error) {
      assistantMessage.content = error instanceof Error ? `⚠ ${error.message}` : '⚠ Model request failed.';
      void persist();
      return {
        conversationId: conversation.id,
        transcript: {
          prompt: userMessage.content,
          conversationId: conversation.id,
          assistantContent: assistantMessage.content,
          activities: [...(assistantMessage.activities ?? [])],
          approvals: [...(assistantMessage.approvals ?? [])],
          assets: (assistantMessage.assets ?? []).map((asset) => ({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes })),
        },
      };
    }
  };
  const runAutomation = async (automation: Automation, model: ProviderConfig) => {
    const previousConversation = activeConversationId.value; const previousEmployee = currentEmployeeId.value;
    try {
      const result = await addMessage(automation.prompt, model, { employeeId: automation.employeeId, skillIds: automation.skillIds, newConversation: true });
      return result?.transcript;
    } finally { activeConversationId.value = previousConversation; currentEmployeeId.value = previousEmployee; }
  };
  /**
   * Runs a project task without selecting or mutating the user's active chat.
   * This is the concurrency boundary used by the project orchestrator.
   */
  const runProjectTask = async (input: { projectId: string; taskId: string; prompt: string; employeeId: EmployeeId; skillIds: string[]; permissionTier?: ExecutionLevel; model: ProviderConfig }, onActivity?: (activity: ToolActivity) => void, onDelta?: (delta: string) => void): Promise<ProjectTaskTranscript> => {
    const employee = employees.find((item) => item.id === input.employeeId) ?? employees[0];
    const skills = await skillRuntimeFor(employee.id, input.skillIds, input.permissionTier);
    const transcript: ProjectTaskTranscript = { assistantContent: '', activities: [], approvals: [], assets: [] };
    await streamChat({
      profile: { id: employee.id, name: employee.id, toolIds: skills.map((skill) => skill.id), instructions: `You are OPCAI's ${employee.id} digital employee working on one assigned project task. Complete only this task, report concrete findings and deliverables in the user's language. Do not delegate further.` },
      messages: [{ role: 'user', content: input.prompt }], model: toModelPayload(input.model), skills,
    }, (delta) => { transcript.assistantContent += delta; onDelta?.(delta); }, (activity) => {
      const existing = transcript.activities.find((item) => item.toolName === activity.toolName && item.status === 'running');
      if (existing && activity.status !== 'running') Object.assign(existing, activity); else transcript.activities.push(activity);
      onActivity?.(activity);
    }, (approval) => { if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) transcript.approvals.push(approval); }, async (artifact) => {
      transcript.runId = artifact.runId;
      const asset = await archiveArtifact({ runId: artifact.runId, relativePath: artifact.path, employeeId: employee.id });
      if (!transcript.assets.some((item) => item.id === asset.id)) transcript.assets.push({ id: asset.id, name: asset.name, sizeBytes: asset.sizeBytes, runId: asset.runId });
    });
    return transcript;
  };
  const generateProjectDraft = async (goal: string, model: ProviderConfig): Promise<ProjectTaskDraft[]> => {
    let output = '';
    const instruction = `You are OPCAI's project coordinator. Decompose the goal below into 2-5 independent, parallelizable tasks. Return ONLY a JSON array. Each item must be {"title": string, "objective": string, "employeeId": "general"|"research"|"code"|"administrator", "skillIds": string[]}. Do not create dependent tasks. Goal: ${goal}`;
    await streamChat({ profile: { id: 'project-coordinator', name: 'Project coordinator', instructions: 'Create a concise execution draft. Output valid JSON only.', toolIds: [] }, messages: [{ role: 'user', content: instruction }], model: toModelPayload(model), skills: [] }, (delta) => { output += delta; });
    try {
      const json = output.match(/\[[\s\S]*\]/)?.[0] ?? output;
      const parsed = JSON.parse(json) as Array<Partial<ProjectTaskDraft>>;
      const allowed = new Set<EmployeeId>(employees.map((item) => item.id));
      const cleaned = parsed.slice(0, 5).map((item, index) => ({ title: String(item.title || `任务 ${index + 1}`).slice(0, 80), objective: String(item.objective || goal).slice(0, 2000), employeeId: allowed.has(item.employeeId as EmployeeId) ? item.employeeId as EmployeeId : 'general', skillIds: Array.isArray(item.skillIds) ? item.skillIds.filter((id): id is string => typeof id === 'string').slice(0, 12) : [] }));
      if (cleaned.length) return cleaned;
    } catch { /* A conservative local draft remains preferable to blocking the user. */ }
    return [
      { title: '任务分析', objective: `分析目标、范围、关键约束与验收标准：${goal}`, employeeId: 'research', skillIds: [] },
      { title: '方案与产出', objective: `围绕目标提出可执行方案，并生成所需产出：${goal}`, employeeId: 'general', skillIds: [] },
      { title: '质量检查', objective: `检查方案的完整性、风险和可执行性，并给出改进建议：${goal}`, employeeId: 'code', skillIds: [] },
    ];
  };
  const approveAndRetry = async (conversationId: string, approval: ToolApproval, scope: 'session' | 'always', model: ProviderConfig) => {
    if (scope === 'session') { const grants = sessionGrants.get(approval.skillId) ?? new Set<ToolApproval['capability']>(); grants.add(approval.capability); sessionGrants.set(approval.skillId, grants); }
    else {
      const skill = skills.value.find((item) => item.id === approval.skillId);
      if (skill) await setExecutionPolicy(skill.id, { ...skill.execution, allowWorkspaceWrite: approval.capability === 'workspace-write' ? true : skill.execution.allowWorkspaceWrite, allowScriptExecution: approval.capability === 'script-execution' ? true : skill.execution.allowScriptExecution });
    }
    const conversation = conversations.value.find((item) => item.id === conversationId);
    const lastUser = [...(conversation?.messages ?? [])].reverse().find((message) => message.role === 'user');
    if (lastUser) { activeConversationId.value = conversationId; await addMessage(lastUser.content, model); }
  };
  return { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, load, setView, startChat, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry };
}
