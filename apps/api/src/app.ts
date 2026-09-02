import cors from '@fastify/cors';
import Fastify from 'fastify';
import { healthRoutes } from './modules/health/routes.js';
import { chatRoutes } from './modules/chat/routes.js';

export async function createApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: false });
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  return app;
}
