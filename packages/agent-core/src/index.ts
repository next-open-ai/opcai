import type { AgentEvent, AgentProfile } from '@opcai/contracts';
import type { OpcaiTool, ToolPolicy } from '@opcai/tools';

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
