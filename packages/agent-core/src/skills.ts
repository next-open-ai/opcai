import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { McpConnectionRuntime } from '@opcai/contracts';

export interface AgentSkill { id: string; name: string; description: string; source: 'builtin' | 'local'; path?: string; enabled: boolean; }
export interface McpConnection { id: string; name: string; transport: 'http' | 'sse' | 'stdio'; url?: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled: boolean; apiKey?: string; }

/** Parses the portable SKILL.md frontmatter used by Agent Skills. */
export function parseSkillManifest(content: string, path?: string): AgentSkill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = Object.fromEntries(match[1].split(/\r?\n/).map((line) => line.split(/:\s*/, 2)).filter(([key, value]) => key && value));
  if (!fields.name || !fields.description) return null;
  return { id: String(fields.name), name: String(fields.name), description: String(fields.description), source: 'local', path, enabled: true };
}

function sanitizeToolPrefix(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'mcp';
}

export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wraps an MCP tool execute so a single hanging call cannot stall the whole run forever. */
function wrapMcpTool(tool: unknown, toolName: string, timeoutMs: number) {
  if (!tool || typeof tool !== 'object') return tool;
  const record = tool as Record<string, unknown>;
  if (typeof record.execute !== 'function') return tool;
  const execute = record.execute as (input: unknown, options?: unknown) => unknown;
  return {
    ...record,
    execute: async (input: unknown, options?: unknown) => {
      try {
        return await withTimeout(Promise.resolve(execute(input, options)), timeoutMs, toolName);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function isStdio(connection: McpConnection | McpConnectionRuntime): connection is Extract<McpConnectionRuntime, { transport: 'stdio' }> | (McpConnection & { transport: 'stdio' }) {
  return connection.transport === 'stdio' || Boolean((connection as McpConnection).command && !(connection as McpConnection).url);
}

/** Creates an AI SDK MCP client for remote HTTP/SSE or local stdio (npx/uvx) connections. */
export async function connectMcp(connection: McpConnection | McpConnectionRuntime) {
  /**
   * Newer Python MCP servers (2026-07-28) lock the stdio session to the modern
   * era after the client's first framed request. `@ai-sdk/mcp` defaults to
   * probing `server/discover` first, then falls back to legacy `initialize` on
   * the *same* connection — which those servers reject. Disable discovery so
   * the first request is `initialize` and the server stays on the legacy era.
   */
  const clientOptions = { protocolVersionDiscovery: false as const };

  if (isStdio(connection) || connection.transport === 'stdio') {
    const command = 'command' in connection ? String(connection.command || '').trim() : '';
    if (!command) throw new Error('Local MCP requires a command (npx / uvx / custom).');
    const args = 'args' in connection && Array.isArray(connection.args) ? connection.args.map(String) : [];
    const env = 'env' in connection && connection.env && typeof connection.env === 'object' ? connection.env : undefined;
    const cwd = 'cwd' in connection && connection.cwd ? String(connection.cwd) : undefined;
    return createMCPClient({
      ...clientOptions,
      transport: new Experimental_StdioMCPTransport({
        command,
        args,
        ...(env ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
        ...(cwd ? { cwd } : {}),
        stderr: 'pipe',
      }),
    });
  }

  if (!connection.url) {
    throw new Error('This connection requires an HTTP or SSE URL.');
  }
  const transportType = connection.transport === 'sse' ? 'sse' : 'http';
  const headers: Record<string, string> = {};
  if (connection.apiKey?.trim()) headers.Authorization = `Bearer ${connection.apiKey.trim()}`;
  return createMCPClient({
    ...clientOptions,
    transport: {
      type: transportType,
      url: connection.url,
      ...(Object.keys(headers).length ? { headers } : {}),
    },
  });
}

/**
 * Connects employee-associated MCP servers and converts their tools for streamText.
 * Call `close()` in a finally block so transports are released after the run.
 */
export async function loadMcpToolset(
  connections: McpConnectionRuntime[] | undefined,
  options?: { toolTimeoutMs?: number },
) {
  const toolTimeoutMs = Math.min(
    300_000,
    Math.max(3_000, Math.round(Number(options?.toolTimeoutMs) || DEFAULT_MCP_TOOL_TIMEOUT_MS)),
  );
  const clients: MCPClient[] = [];
  const tools: Record<string, unknown> = {};
  const labels: string[] = [];
  for (const connection of connections ?? []) {
    if (!connection?.enabled) continue;
    const ready =
      connection.transport === 'stdio'
        ? Boolean(connection.command?.trim())
        : Boolean(connection.url);
    if (!ready) continue;
    try {
      const client = await connectMcp(connection);
      clients.push(client);
      const mcpTools = await client.tools();
      const prefix = sanitizeToolPrefix(connection.name || connection.id);
      for (const [name, tool] of Object.entries(mcpTools || {})) {
        const key = `mcp_${prefix}_${name}`.slice(0, 64);
        tools[key] = wrapMcpTool(tool, key, toolTimeoutMs);
      }
      labels.push(connection.name);
    } catch {
      // Skip unreachable connectors; the agent can still run with remaining tools.
    }
  }
  const instructions = clients
    .map((client, index) => {
      const label = labels[index] || `MCP ${index + 1}`;
      const text = client.instructions?.trim();
      return text ? `MCP 「${label}」使用说明：\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return {
    tools: tools as Record<string, any>,
    instructions,
    labels,
    async close() {
      await Promise.all(clients.map(async (client) => {
        try { await client.close(); } catch { /* ignore */ }
      }));
    },
  };
}

export type McpProbeTool = {
  name: string;
  description?: string;
};

export type McpProbeResult = {
  ok: boolean;
  toolCount: number;
  toolNames: string[];
  tools: McpProbeTool[];
  durationMs: number;
  error?: string;
};

/** One-shot connectivity check: connect → list tools → close. */
export async function probeMcpConnection(
  connection: McpConnection | McpConnectionRuntime,
  options?: { timeoutMs?: number },
): Promise<McpProbeResult> {
  const timeoutMs = Math.min(60_000, Math.max(3_000, options?.timeoutMs ?? 25_000));
  const started = Date.now();
  let client: MCPClient | undefined;
  try {
    const work = (async () => {
      client = await connectMcp(connection);
      const mcpTools = await client.tools();
      const entries = Object.entries(mcpTools || {}).slice(0, 80);
      return entries.map(([name, tool]) => {
        const description =
          tool && typeof tool === 'object' && 'description' in tool && typeof (tool as { description?: unknown }).description === 'string'
            ? String((tool as { description: string }).description).slice(0, 400)
            : undefined;
        return { name, ...(description ? { description } : {}) };
      });
    })();
    const tools = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`MCP probe timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
    return {
      ok: true,
      toolCount: tools.length,
      toolNames: tools.map((item) => item.name),
      tools,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      toolCount: 0,
      toolNames: [],
      tools: [],
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'MCP probe failed.',
    };
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
