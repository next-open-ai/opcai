export interface HealthStatus { status: 'ok'; service: 'opcai-api'; version: string; }

export async function getHealth(): Promise<HealthStatus> {
  const apiBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:4318' : '';
  const response = await fetch(`${apiBase}/api/health`);
  if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
  return response.json() as Promise<HealthStatus>;
}
