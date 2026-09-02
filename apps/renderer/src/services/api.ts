export interface HealthStatus { status: 'ok'; service: 'opcai-api'; version: string; }

export async function getHealth(): Promise<HealthStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
  const response = await fetch(`${apiBase}/api/health`);
  if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
  return response.json() as Promise<HealthStatus>;
}

export interface RuntimeSkill {
  id: string; name: string; description: string; mode: 'available' | 'default'; rootPath?: string; instructions?: string;
  resources: Array<{ path: string; content: string }>;
  execution: { allowWorkspaceWrite: boolean; allowScriptExecution: boolean; allowedNetworkHosts: string[]; allowAllNonDestructive: boolean };
}

export interface ToolActivity { toolName: string; summary: string; status: 'running' | 'completed' | 'failed'; }
export interface ToolApproval { skillId: string; capability: 'workspace-write' | 'script-execution' | 'network-access'; summary: string; }
export interface GeneratedArtifact { runId: string; path: string; }
export async function streamChat(input: { profile: { id: string; name: string; instructions: string; toolIds: string[] }; messages: Array<{ role: 'user' | 'assistant'; content: string }>; model: { provider: string; baseUrl?: string; chatModel: string; imageModel?: string; embeddingModel?: string; apiKey: string }; skills?: RuntimeSkill[] }, onDelta: (text: string) => void, onToolActivity?: (activity: ToolActivity) => void, onApproval?: (approval: ToolApproval) => void, onArtifact?: (artifact: GeneratedArtifact) => void | Promise<void>): Promise<void> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
  const response = await fetch(`${apiBase}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok || !response.body) throw new Error(`Chat request failed: ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n'); buffer = events.pop() ?? '';
    for (const item of events) {
      if (!item.startsWith('data: ')) continue;
      const event = JSON.parse(item.slice(6)) as { type: string; text?: string; message?: string; toolName?: string; summary?: string; ok?: boolean; skillId?: string; capability?: ToolApproval['capability']; runId?: string; path?: string };
      if (event.type === 'message.delta' && event.text) onDelta(event.text);
      if (event.type === 'tool.started' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: 'running' });
      if (event.type === 'tool.completed' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: event.ok ? 'completed' : 'failed' });
      if (event.type === 'tool.failed' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: 'failed' });
      if (event.type === 'tool.approval_required' && event.skillId && event.capability && event.summary) onApproval?.({ skillId: event.skillId, capability: event.capability, summary: event.summary });
      if (event.type === 'artifact.created' && event.runId && event.path) await onArtifact?.({ runId: event.runId, path: event.path });
      if (event.type === 'run.failed') throw new Error(event.message || 'Model request failed.');
    }
  }
}
