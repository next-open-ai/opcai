/**
 * Typed client for the server-side orchestration API (`/api/orch/**`).
 *
 * The Vue renderer and future channel/relay gateways call the SAME endpoints;
 * the orchestrator process owns the durable state machines (chat sessions,
 * resumable runs, project scheduling). Development uses the Vite `/api` proxy;
 * packaged desktop loads from `file:` and calls `http://127.0.0.1:4318` — same
 * convention as services/api.ts.
 */

const apiBase = () =>
  window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';

/* ------------------------------------------------------------------ *
 * Server shapes (mirror of packages/orchestrator/src/types.ts)
 * ------------------------------------------------------------------ */

export type ServerProjectStatus = 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ServerTaskStatus = 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ServerProjectMode = 'waterfall' | 'parallel' | 'discussion' | 'dag';
export type GrantCapability = 'workspace-write' | 'script-execution' | 'network-access';

export interface ServerRunApproval {
  id: string;
  skillId: string;
  capability: GrantCapability;
  summary: string;
  status: 'pending' | 'allowed' | 'denied';
  at: number;
  scope?: 'session' | 'always';
  resolvedAt?: number;
}

export interface ServerRunActivity {
  toolName: string;
  summary: string;
  status: 'running' | 'completed' | 'failed';
  at: number;
}

export interface ServerRunArtifact {
  path: string;
  assetId?: string;
  assetName?: string;
  assetSizeBytes?: number;
  createdAt?: number;
}

export interface ServerRunRecord {
  id: string;
  sessionId: string;
  kind: 'chat' | 'project-task';
  taskId?: string;
  attemptNo: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting-approval';
  error?: string;
  startedAt: number;
  finishedAt?: number;
  transcript: string;
  activities: ServerRunActivity[];
  approvals: ServerRunApproval[];
  artifacts: ServerRunArtifact[];
  sources: Array<{ title: string; url: string; source?: string }>;
  cancelReason?: 'user' | 'timeout';
}

export interface ServerTask {
  id: string;
  title: string;
  objective: string;
  employeeId: string;
  skillIds: string[];
  dependsOn: string[];
  permissionTier: 'read-only' | 'default' | 'extended' | 'full';
  status: ServerTaskStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  runId?: string;
  error?: string;
}

export interface ServerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  employeeId?: string;
  taskId?: string;
  createdAt: number;
}

export interface ServerProject {
  id: string;
  name: string;
  goal: string;
  status: ServerProjectStatus;
  mode: ServerProjectMode;
  workspacePath: string;
  tasks: ServerTask[];
  messages: ServerMessage[];
  createdAt: number;
  updatedAt: number;
  activeRunId?: string;
  summary?: string;
  coordinator?: { provider: string; model: string };
}

export interface ServerProjectRun {
  id: string;
  projectId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  taskIds: string[];
  summary?: string;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * OrcEvent (mirror of packages/orchestrator/src/events.ts)
 * ------------------------------------------------------------------ */

export interface OrcEvent {
  type: string;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  status?: string;
  text?: string;
  provider?: string;
  attemptNo?: number;
  activity?: ServerRunActivity;
  approval?: ServerRunApproval;
  artifact?: { path: string };
  sources?: ServerRunRecord['sources'];
  message?: ServerMessage;
  error?: string;
  ts?: number;
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}/api/orch${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) {
    throw new Error(body?.message || `Orchestration request failed: ${response.status}`);
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export async function createProject(input: {
  name?: string;
  goal: string;
  mode: ServerProjectMode;
  workspacePath: string;
  coordinator?: { provider: string; model: string };
  tasks: Array<{ id?: string; title: string; objective: string; employeeId: string; skillIds: string[]; dependsOn?: string[] }>;
}): Promise<ServerProject> {
  const result = await request<{ project: ServerProject }>('/projects', { method: 'POST', body: JSON.stringify(input) });
  return result.project;
}

export async function listProjects(): Promise<ServerProject[]> {
  const result = await request<{ projects: ServerProject[] }>('/projects');
  return result.projects;
}

export async function getProject(id: string): Promise<ServerProject | null> {
  try {
    const result = await request<{ project: ServerProject }>(`/projects/${encodeURIComponent(id)}`);
    return result.project;
  } catch {
    return null;
  }
}

export async function deleteProject(id: string): Promise<void> {
  await request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Start the server scheduler (contexts are assembled server-side). */
export async function confirmProject(id: string): Promise<{ project: ServerProject; run: ServerProjectRun }> {
  const result = await request<{ project: ServerProject; run: ServerProjectRun }>(
    `/projects/${encodeURIComponent(id)}/confirm`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return result;
}

export async function cancelProject(id: string): Promise<boolean> {
  const result = await request<{ cancelled: boolean }>(`/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
  return result.cancelled;
}

export async function retryTask(projectId: string, taskId: string): Promise<boolean> {
  const result = await request<{ started: boolean }>(
    `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/retry`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return result.started;
}

export async function projectTranscript(projectId: string, taskId: string): Promise<ServerRunRecord | null> {
  const result = await request<{ transcript: ServerRunRecord | null }>(
    `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/transcript`,
  );
  return result.transcript;
}

export async function projectRuns(projectId: string): Promise<ServerProjectRun[]> {
  const result = await request<{ runs: ServerProjectRun[] }>(`/projects/${encodeURIComponent(projectId)}/runs`);
  return result.runs;
}

export async function resolveTaskApproval(input: {
  projectId: string;
  taskId: string;
  approvalId: string;
  allow: boolean;
  scope?: 'session' | 'always';
}): Promise<{ resumed?: boolean }> {
  return request(
    `/projects/${encodeURIComponent(input.projectId)}/tasks/${encodeURIComponent(input.taskId)}/approvals/${encodeURIComponent(input.approvalId)}/resolve`,
    { method: 'POST', body: JSON.stringify({ allow: input.allow, scope: input.scope }) },
  );
}

/* ------------------------------------------------------------------ *
 * Chat sessions (普通对话)
 * ------------------------------------------------------------------ */

export interface ServerChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  turnId?: string;
  runId?: string;
  superseded?: boolean;
}

export interface ServerChatSession {
  id: string;
  kind: 'chat';
  title: string;
  employeeId: string;
  modelLabel?: string;
  messages: ServerChatMessage[];
  channelBinding?: { channelId: string; threadId: string } | null;
  grantsSession: Record<string, GrantCapability[]>;
  grantsAlways: Record<string, GrantCapability[]>;
  createdAt: number;
  updatedAt: number;
}

export async function createChatSession(input: { title?: string; employeeId?: string }): Promise<ServerChatSession> {
  const result = await request<{ session: ServerChatSession }>('/sessions', { method: 'POST', body: JSON.stringify(input) });
  return result.session;
}

export async function listChatSessions(): Promise<ServerChatSession[]> {
  const result = await request<{ sessions: ServerChatSession[] }>('/sessions');
  return result.sessions;
}

export async function getChatSession(id: string): Promise<ServerChatSession | null> {
  try {
    const result = await request<{ session: ServerChatSession }>(`/sessions/${encodeURIComponent(id)}`);
    return result.session;
  } catch {
    return null;
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  await request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Send a chat message. `context` is optional: the server assembles the run
 * context for the session's employee (domain KV + keyring) when omitted.
 */
export async function sendChatMessage(id: string, input: { content: string; employeeId?: string }): Promise<{ runId: string; turnId: string; attemptNo: number }> {
  return request(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) });
}

export async function cancelChatRun(id: string): Promise<boolean> {
  const result = await request<{ aborted: boolean }>(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
  return result.aborted;
}

export async function chatPendingApprovals(id: string): Promise<ServerRunRecord[]> {
  const result = await request<{ pending: ServerRunRecord[] }>(`/sessions/${encodeURIComponent(id)}/approvals`);
  return result.pending;
}

/** Runs reachable from a session's messages (for waiting/status checks). */
export async function sessionRuns(id: string): Promise<ServerRunRecord[]> {
  const result = await request<{ runs: ServerRunRecord[] }>(`/sessions/${encodeURIComponent(id)}/runs`);
  return result.runs;
}

export async function resolveChatApproval(
  id: string,
  approvalId: string,
  input: { allow: boolean; scope?: 'session' | 'always' },
): Promise<{ resumedRunId?: string; turnId?: string }> {
  return request(`/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Subscribe to a session's orchestration events (run deltas/activities/...). */
export function subscribeSessionEvents(
  sessionId: string,
  onEvent: (event: OrcEvent) => void,
  options: { signal?: AbortSignal } = {},
): () => void {
  return subscribeEvents('session', sessionId, onEvent, options);
}

/* ------------------------------------------------------------------ *
 * Generic event stream (fetch-based SSE — EventSource is CORS-blocked from file:)
 * ------------------------------------------------------------------ */

function subscribeEvents(
  topic: 'session' | 'project',
  id: string,
  onEvent: (event: OrcEvent) => void,
  options: { signal?: AbortSignal },
): () => void {
  let cancelled = false;
  const controller = new AbortController();
  const abortFromOutside = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromOutside, { once: true });

  void (async () => {
    try {
      const response = await fetch(`${apiBase()}/api/orch/events?${topic}=${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          if (!chunk.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(chunk.slice(6)) as OrcEvent;
            onEvent(event);
          } catch {
            /* skip malformed/heartbeat */
          }
        }
      }
    } catch {
      /* stream closed */
    } finally {
      cancelled = true;
      options.signal?.removeEventListener('abort', abortFromOutside);
    }
  })();

  return () => {
    if (!cancelled) controller.abort();
  };
}

export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: OrcEvent) => void,
  options: { signal?: AbortSignal } = {},
): () => void {
  return subscribeEvents('project', projectId, onEvent, options);
}
