import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('opcai-api'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string(),
  toolIds: z.array(z.string()),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * A capability package made available to one agent run. Content is kept out
 * of the model prompt until the agent explicitly loads the skill (except for
 * deliberately configured default skills).
 */
export const AgentSkillResourceSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(48_000),
});
export const SkillExecutionPolicySchema = z.object({
  /** A per-run workspace can be written only after this capability is granted. */
  allowWorkspaceWrite: z.boolean().default(false),
  /** Only executable files under this Skill's scripts/ directory may run. */
  allowScriptExecution: z.boolean().default(false),
  /** Exact HTTPS host names permitted for this Skill. Empty means no egress. */
  allowedNetworkHosts: z.array(z.string().min(1).max(253)).max(32).default([]),
  allowAllNonDestructive: z.boolean().default(false),
});
export type SkillExecutionPolicy = z.infer<typeof SkillExecutionPolicySchema>;
export const AgentSkillRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).max(2_000),
  mode: z.enum(['available', 'default']),
  /** Private runtime location; it is never included in model-visible tool output. */
  rootPath: z.string().min(1).optional(),
  instructions: z.string().max(24_000).optional(),
  resources: z.array(AgentSkillResourceSchema).max(40).default([]),
  execution: SkillExecutionPolicySchema.default({}),
});
export type AgentSkillRuntime = z.infer<typeof AgentSkillRuntimeSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: z.string() }),
  z.object({ type: z.literal('message.delta'), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool.started'), runId: z.string(), toolName: z.string(), summary: z.string() }),
  z.object({ type: z.literal('tool.completed'), runId: z.string(), toolName: z.string(), summary: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('tool.failed'), runId: z.string(), toolName: z.string(), summary: z.string() }),
  z.object({ type: z.literal('artifact.created'), runId: z.string(), path: z.string().min(1).max(240) }),
  z.object({ type: z.literal('tool.approval_required'), runId: z.string(), skillId: z.string(), capability: z.enum(['workspace-write', 'script-execution', 'network-access']), summary: z.string() }),
  z.object({ type: z.literal('run.completed'), runId: z.string() }),
  z.object({ type: z.literal('run.failed'), runId: z.string(), message: z.string() }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'ollama', 'openai-compatible']);
export const ModelConfigSchema = z.object({
  provider: ProviderIdSchema,
  baseUrl: z.string().url().optional(),
  chatModel: z.string().min(1),
  disableThinking: z.boolean().optional(),
  imageModel: z.string().optional(),
  embeddingModel: z.string().optional(),
  asrModel: z.string().optional(),
  ttsModel: z.string().optional(),
  apiKey: z.string(),
}).refine((value) => value.provider === 'ollama' || value.apiKey.trim().length > 0, { message: 'API key is required for this provider.' });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ChatRequestSchema = z.object({
  profile: AgentProfileSchema,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) })).min(1),
  model: ModelConfigSchema,
  skills: z.array(AgentSkillRuntimeSchema).max(24).default([]),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
