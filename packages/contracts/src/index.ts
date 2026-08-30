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

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: z.string() }),
  z.object({ type: z.literal('message.delta'), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool.approval_required'), runId: z.string(), toolId: z.string() }),
  z.object({ type: z.literal('run.completed'), runId: z.string() }),
  z.object({ type: z.literal('run.failed'), runId: z.string(), message: z.string() }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
