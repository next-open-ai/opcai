import cors from '@fastify/cors';
import Fastify from 'fastify';
import { healthRoutes } from './modules/health/routes.js';
import { chatRoutes } from './modules/chat/routes.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { mcpRoutes } from './modules/mcp/routes.js';

export async function createApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: false });
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(mcpRoutes, { prefix: '/api' });
  return app;
}
