import type { FastifyPluginAsync } from 'fastify';
import { ChatRequestSchema } from '@opcai/contracts';
import { streamAgentReply } from '@opcai/agent-core';

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat', async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid chat request.', issues: parsed.error.issues });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    for await (const event of streamAgentReply(parsed.data)) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    reply.raw.end();
  });
};
