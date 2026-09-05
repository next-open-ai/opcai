import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { healthRoutes } from './modules/health/routes.js';
import { chatRoutes } from './modules/chat/routes.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { assetRoutes } from './modules/assets/routes.js';
import { mcpRoutes } from './modules/mcp/routes.js';
import { providerRoutes } from './modules/providers/routes.js';
import { remoteRoutes } from './modules/remote/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { skillRoutes } from './modules/skills/routes.js';
import { orchestrationRoutes } from './modules/orchestration/routes.js';
import { workspaceRoutes } from './modules/workspace/routes.js';

export async function createApp() {
  const app = Fastify({ logger: true });
  const staticRoot = process.env.OPCAI_WEB_STATIC_DIR?.trim();
  await app.register(cors, { origin: false });
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(assetRoutes, { prefix: '/api' });
  await app.register(mcpRoutes, { prefix: '/api' });
  await app.register(providerRoutes, { prefix: '/api' });
  await app.register(remoteRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(skillRoutes, { prefix: '/api' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  await app.register(orchestrationRoutes, { prefix: '/api/orch' });
  if (staticRoot) {
    const indexFile = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(indexFile)) {
      throw new Error(`OPCAI_WEB_STATIC_DIR is missing index.html: ${indexFile}`);
    }
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
      prefix: '/',
      index: false,
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler(async (request, reply) => {
      const target = request.raw.url || '/';
      if (request.method === 'GET' && !target.startsWith('/api')) {
        return reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexFile, 'utf8'));
      }
      return reply.code(404).send({ message: 'Not Found' });
    });
  }
  return app;
}
