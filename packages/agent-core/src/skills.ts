import { createMCPClient } from '@ai-sdk/mcp';

export interface AgentSkill { id: string; name: string; description: string; source: 'builtin' | 'local'; path?: string; enabled: boolean; }
export interface McpConnection { id: string; name: string; transport: 'http' | 'sse' | 'stdio'; url?: string; command?: string; enabled: boolean; }

/** Parses the portable SKILL.md frontmatter used by Agent Skills. */
export function parseSkillManifest(content: string, path?: string): AgentSkill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = Object.fromEntries(match[1].split(/\r?\n/).map((line) => line.split(/:\s*/, 2)).filter(([key, value]) => key && value));
  if (!fields.name || !fields.description) return null;
  return { id: String(fields.name), name: String(fields.name), description: String(fields.description), source: 'local', path, enabled: true };
}

/** Creates an AI SDK V7 MCP client for remote HTTP/SSE connections. */
export async function connectMcp(connection: McpConnection) {
  if (!connection.url || connection.transport === 'stdio') throw new Error('This connection requires a local Stdio transport adapter.');
  return createMCPClient({ transport: { type: connection.transport, url: connection.url } });
}
