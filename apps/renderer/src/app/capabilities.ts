import { ref } from 'vue';
import { readStored, writeStored } from './storage.js';

export type SkillSource = 'builtin' | 'local' | 'registry';
export type SkillStatus = 'ready' | 'draft' | 'disabled';
export type PolicyMode = 'disabled' | 'available' | 'default';
export type ExecutionLevel = 'read-only' | 'default' | 'extended' | 'full';
export const defaultSkillExecution = (level: ExecutionLevel = 'default') => ({ allowWorkspaceWrite: level !== 'read-only', allowScriptExecution: level !== 'read-only', allowedNetworkHosts: [] as string[], allowAllNonDestructive: level === 'full' });

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  status: SkillStatus;
  risk: 'low' | 'medium' | 'high';
  path?: string;
  tags: string[];
  systemOnly?: boolean;
  execution: { allowWorkspaceWrite: boolean; allowScriptExecution: boolean; allowedNetworkHosts: string[]; allowAllNonDestructive: boolean };
}

export interface EmployeeSkillPolicy {
  employeeId: string;
  skillId: string;
  mode: PolicyMode;
  priority: number;
  approvalRequired: boolean;
}

const skillKey = 'capabilities.skills.v2';
const policyKey = 'capabilities.employee-policies';
const seededKey = 'capabilities.seeded.v1';

export const builtinSkills: SkillRecord[] = [
  { id: 'skill-discovery', name: 'Skill Discovery', description: 'Search the open skill ecosystem and review a package before installation.', source: 'builtin', status: 'ready', risk: 'medium', tags: ['registry', 'web'], systemOnly: true, execution: defaultSkillExecution() },
  { id: 'skill-authoring', name: 'Skill Authoring', description: 'Create and validate portable SKILL.md packages with progressive disclosure.', source: 'builtin', status: 'ready', risk: 'low', tags: ['developer', 'local'], systemOnly: true, execution: defaultSkillExecution() },
  { id: 'mcp-governance', name: 'MCP Governance', description: 'Review MCP connections, tool scopes, and approval boundaries before activation.', source: 'builtin', status: 'ready', risk: 'high', tags: ['mcp', 'security'], systemOnly: true, execution: defaultSkillExecution() },
  { id: 'document-workbench', name: 'Document Workbench', description: 'Structure, summarize, and improve documents without external side effects.', source: 'builtin', status: 'ready', risk: 'low', tags: ['writing', 'office'], execution: defaultSkillExecution() },
];

const skills = ref<SkillRecord[]>([]);
const policies = ref<EmployeeSkillPolicy[]>([]);

function parse<T>(raw: string | null, fallback: T): T { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } }
function canonicalName(value: string) { return value.trim().replace(/^['"]|['"]$/g, '').toLowerCase(); }

export function useCapabilities() {
  const load = async () => {
    const seeded = await readStored(seededKey);
    const restored = parse(await readStored(skillKey), seeded ? [] : builtinSkills);
    const unique = new Map<string, SkillRecord>();
    for (const skill of restored) {
      const normalized = { ...skill, name: skill.name.replace(/^['"]|['"]$/g, ''), execution: skill.execution?.allowAllNonDestructive !== undefined ? skill.execution : defaultSkillExecution() };
      const key = normalized.source === 'builtin' ? normalized.id : canonicalName(normalized.name);
      const current = unique.get(key);
      if (!current || (current.source === 'registry' && normalized.path)) unique.set(key, normalized);
    }
    skills.value = [...unique.values()];
    if (skills.value.length !== restored.length) await writeStored(skillKey, JSON.stringify(skills.value));
    policies.value = parse(await readStored(policyKey), []);
    if (!seeded) {
      policies.value = [
        ...builtinSkills.filter((skill) => skill.systemOnly).map((skill) => ({ employeeId: 'administrator', skillId: skill.id, mode: 'default' as PolicyMode, priority: 100, approvalRequired: true })),
        { employeeId: 'general', skillId: 'document-workbench', mode: 'available', priority: 50, approvalRequired: false },
      ];
      await writeStored(skillKey, JSON.stringify(skills.value));
      await writeStored(policyKey, JSON.stringify(policies.value));
      await writeStored(seededKey, 'true');
    }
  };
  const saveSkills = async () => writeStored(skillKey, JSON.stringify(skills.value));
  const setExecutionPolicy = async (skillId: string, execution: SkillRecord['execution']) => {
    const skill = skills.value.find((item) => item.id === skillId);
    if (!skill) return;
    skill.execution = {
      allowWorkspaceWrite: Boolean(execution.allowWorkspaceWrite),
      allowScriptExecution: Boolean(execution.allowScriptExecution),
      allowedNetworkHosts: [...new Set(execution.allowedNetworkHosts.map((host) => host.trim().toLowerCase()).filter((host) => /^[a-z0-9.-]+$/i.test(host)))].slice(0, 32),
      allowAllNonDestructive: Boolean(execution.allowAllNonDestructive),
    };
    await saveSkills();
  };
  const removeSkill = async (id: string) => {
    skills.value = skills.value.filter((skill) => skill.id !== id);
    policies.value = policies.value.filter((policy) => policy.skillId !== id);
    await Promise.all([saveSkills(), savePolicies()]);
  };
  const savePolicies = async () => writeStored(policyKey, JSON.stringify(policies.value));
  const policyFor = (employeeId: string, skillId: string) => policies.value.find((item) => item.employeeId === employeeId && item.skillId === skillId);
  const setPolicy = async (employeeId: string, skillId: string, mode: PolicyMode) => {
    const found = policyFor(employeeId, skillId);
    if (found) found.mode = mode;
    else policies.value.push({ employeeId, skillId, mode, priority: 50, approvalRequired: mode !== 'disabled' });
    await savePolicies();
  };
  const allowedSkillsFor = (employeeId: string) => skills.value.filter((skill) => policyFor(employeeId, skill.id)?.mode !== 'disabled' && policyFor(employeeId, skill.id));
  return { skills, policies, load, saveSkills, removeSkill, setExecutionPolicy, policyFor, setPolicy, allowedSkillsFor };
}
