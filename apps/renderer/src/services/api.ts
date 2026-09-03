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
export interface SearchSource { title: string; url: string; source?: string; }
export type McpConnectionPayload =
  | { id: string; name: string; url: string; transport: 'http' | 'sse'; enabled: boolean; apiKey?: string; description?: string }
  | { id: string; name: string; transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled: boolean; description?: string };

export type KnowledgeBasePayload = {
  id: string;
  name: string;
  provider: 'lancedb' | 'bailian' | 'dify' | 'qdrant' | 'pinecone';
  enabled: boolean;
  description?: string;
  dataDir?: string;
  baseUrl?: string;
  apiKey?: string;
  externalId?: string;
  categoryId?: string;
  workspaceId?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
};

export type StreamChatInput = {
  profile: { id: string; name: string; instructions: string; toolIds: string[] };
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: { provider: string; baseUrl?: string; chatModel: string; imageModel?: string; embeddingModel?: string; apiKey: string; disableThinking?: boolean; enableSearch?: boolean };
  skills?: RuntimeSkill[];
  searchProviders?: Array<{ id: 'bocha' | 'tavily' | 'brave' | 'exa' | 'zhipu' | 'aliyun'; label: string; apiKey: string; baseUrl?: string; enabled: boolean; preferred: boolean }>;
  mcpConnections?: McpConnectionPayload[];
  knowledgeBases?: KnowledgeBasePayload[];
  maxSteps?: number;
  runTimeoutMs?: number;
  mcpToolTimeoutMs?: number;
  signal?: AbortSignal;
};

function isAbortError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name || '') : '';
  return name === 'AbortError';
}

export async function streamChat(
  input: StreamChatInput,
  onDelta: (text: string) => void,
  onToolActivity?: (activity: ToolActivity) => void,
  onApproval?: (approval: ToolApproval) => void,
  onArtifact?: (artifact: GeneratedArtifact) => void | Promise<void>,
  onSearchSources?: (value: { provider: string; sources: SearchSource[] }) => void,
): Promise<void> {
  const { signal, ...body } = input;
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) {
      throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    let message = `Chat request failed: ${response.status}`;
    try {
      const parsed = JSON.parse(detail) as { message?: string; issues?: Array<{ path?: unknown[]; message?: string }> };
      if (parsed.message) message = parsed.message;
      const first = parsed.issues?.[0];
      if (first?.message) message = `${message}: ${first.message}`;
    } catch { /* keep status message */ }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw Object.assign(new Error('已由用户中止当前执行。'), { name: 'AbortError' });
        }
        throw error;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const item of events) {
        if (!item.startsWith('data: ')) continue;
        const event = JSON.parse(item.slice(6)) as {
          type: string;
          text?: string;
          message?: string;
          toolName?: string;
          summary?: string;
          ok?: boolean;
          skillId?: string;
          capability?: ToolApproval['capability'];
          runId?: string;
          path?: string;
          provider?: string;
          sources?: SearchSource[];
          reason?: 'user' | 'timeout';
        };
        if (event.type === 'message.delta' && event.text) onDelta(event.text);
        if (event.type === 'tool.started' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: 'running' });
        if (event.type === 'tool.completed' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: event.ok ? 'completed' : 'failed' });
        if (event.type === 'tool.failed' && event.toolName && event.summary) onToolActivity?.({ toolName: event.toolName, summary: event.summary, status: 'failed' });
        if (event.type === 'tool.approval_required' && event.skillId && event.capability && event.summary) onApproval?.({ skillId: event.skillId, capability: event.capability, summary: event.summary });
        if (event.type === 'artifact.created' && event.runId && event.path) await onArtifact?.({ runId: event.runId, path: event.path });
        if (event.type === 'search.sources' && event.provider && event.sources) onSearchSources?.({ provider: event.provider, sources: event.sources });
        if (event.type === 'run.cancelled') {
          throw Object.assign(new Error(event.message || '已中止当前执行。'), {
            name: 'AbortError',
            reason: event.reason || 'user',
          });
        }
        if (event.type === 'run.failed') throw new Error(event.message || 'Model request failed.');
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
  }
}

export async function ingestKnowledgeDocument(input: {
  knowledgeBase: KnowledgeBasePayload;
  title: string;
  content?: string;
  fileBase64?: string;
  fileName?: string;
  source?: string;
  model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
  const response = await fetch(`${apiBase}/api/knowledge/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as {
    message?: string;
    chunks?: number;
    backend?: string;
    documentId?: string;
    jobId?: string;
    status?: string;
  };
  if (!response.ok) throw new Error(body.message || `Knowledge ingest failed: ${response.status}`);
  return body as {
    ok: true;
    chunks: number;
    backend: string;
    dataDir?: string;
    documentId?: string;
    jobId?: string;
    status?: string;
  };
}

function knowledgeApiBase() {
  return window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
}

async function postKnowledge<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${knowledgeApiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error((payload as { message?: string }).message || `Knowledge request failed: ${response.status}`);
  return payload;
}

export type KnowledgeDocumentRow = {
  id: string;
  title: string;
  source?: string;
  chunkCount: number;
  createdAt: number;
  preview: string;
};

export type KnowledgeChunkRow = {
  id: string;
  documentId: string;
  documentTitle: string;
  title: string;
  content: string;
  source?: string;
  createdAt: number;
};

export async function listKnowledgeDocuments(input: {
  knowledgeBase: KnowledgeBasePayload;
}) {
  return postKnowledge<{
    ok: true;
    backend: string;
    dataDir: string;
    documentCount: number;
    chunkCount: number;
    documents: KnowledgeDocumentRow[];
  }>('/api/knowledge/documents', input);
}

export async function listKnowledgeChunks(input: {
  knowledgeBase: KnowledgeBasePayload;
  documentId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}) {
  return postKnowledge<{
    ok: true;
    backend: string;
    total: number;
    offset: number;
    limit: number;
    chunks: KnowledgeChunkRow[];
  }>('/api/knowledge/chunks', input);
}

export async function deleteKnowledgeDocument(input: {
  knowledgeBase: KnowledgeBasePayload;
  documentId: string;
}) {
  return postKnowledge<{ ok: true; removedChunks: number; remainingChunks: number; documentCount: number }>(
    '/api/knowledge/documents/delete',
    input,
  );
}

export async function deleteKnowledgeChunk(input: {
  knowledgeBase: KnowledgeBasePayload;
  chunkId: string;
}) {
  return postKnowledge<{ ok: true; remainingChunks: number; documentCount: number }>(
    '/api/knowledge/chunks/delete',
    input,
  );
}

export async function searchKnowledge(input: {
  knowledgeBase: KnowledgeBasePayload;
  query: string;
  topK?: number;
  model?: { provider: string; baseUrl?: string; chatModel: string; embeddingModel?: string; apiKey: string };
}) {
  return postKnowledge<{
    ok: true;
    results: Array<{ id: string; title: string; content: string; score: number; source?: string; url?: string }>;
  }>('/api/knowledge/search', input);
}

export async function listBailianPipelines(input: {
  apiKey: string;
  baseUrl?: string;
  workspaceId?: string;
}) {
  return postKnowledge<{
    ok: true;
    pipelines: Array<{ id: string; name: string; workspaceId: string; docNum: number }>;
  }>('/api/knowledge/bailian/pipelines', input);
}

export async function createBailianKnowledge(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  name: string;
  description?: string;
  embeddingModelName?: string;
}) {
  return postKnowledge<{
    ok: true;
    indexId: string;
    categoryId: string;
    workspaceId: string;
    name: string;
  }>('/api/knowledge/bailian/create', input);
}

export async function deleteBailianKnowledge(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  indexId: string;
}) {
  return postKnowledge<{ ok: true }>('/api/knowledge/bailian/delete', input);
}

export async function listBailianIndices(input: {
  accessKeyId: string;
  accessKeySecret: string;
  workspaceId: string;
  pageNumber?: number;
  pageSize?: number;
  indexName?: string;
}) {
  return postKnowledge<{
    ok: true;
    indices: Array<{ id: string; name: string; description: string; documentCount: number; categoryId?: string }>;
  }>('/api/knowledge/bailian/list', input);
}

export async function getKnowledgeJobStatus(input: {
  knowledgeBase: KnowledgeBasePayload;
  jobId: string;
}) {
  return postKnowledge<{
    ok: true;
    jobId: string;
    status: string;
    message?: string;
  }>('/api/knowledge/job-status', input);
}

export async function deleteRemoteKnowledgeBase(input: {
  knowledgeBase: KnowledgeBasePayload;
}) {
  return postKnowledge<{ ok: true }>('/api/knowledge/delete-remote', input);
}

export async function testMcpConnection(connection: McpConnectionPayload, timeoutMs = 25_000) {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
  const response = await fetch(`${apiBase}/api/mcp/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection, timeoutMs }),
  });
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    toolCount?: number;
    toolNames?: string[];
    tools?: Array<{ name?: string; description?: string }>;
    durationMs?: number;
    error?: string;
    message?: string;
  };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || body.message || `MCP test failed: ${response.status}`);
  }
  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((item) => {
          const name = String(item?.name || '').trim();
          if (!name) return null;
          const description = item?.description ? String(item.description).slice(0, 400) : undefined;
          return { name, ...(description ? { description } : {}) };
        })
        .filter((item): item is { name: string; description?: string } => Boolean(item))
    : (Array.isArray(body.toolNames) ? body.toolNames.map((name) => ({ name: String(name) })) : []);
  return {
    ok: true as const,
    toolCount: Number(body.toolCount) || tools.length,
    toolNames: tools.map((item) => item.name),
    tools,
    durationMs: Number(body.durationMs) || 0,
  };
}
