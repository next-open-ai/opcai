import path from 'node:path';
import os from 'node:os';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { JsonFileStore, Orchestrator, createScriptedRunner, type AgentRunner, type OrcEvent } from '@opcai/orchestrator';
import type { ChatRunContext, ConfirmProjectInput, CreateProjectDraftInput, ProjectTask, ResolveProjectApprovalInput } from '@opcai/orchestrator';
import { resolveTaskContext } from './context-assembler.js';

/**
 * Orchestration module (M0): hosts the headless orchestrator inside the API
 * process. Both the Vue renderer and future channel/relay gateways consume
 * these endpoints; the orchestrator owns the durable domain state machines
 * (chat sessions, resumable runs, project scheduling).
 *
 * Domain persistence is a single-writer JSON document under the data dir
 * (`OPCAI_DATA_DIR`, defaults to `~/.opcai`). Secrets never reach this store.
 */

let instance: Orchestrator | null = null;

function dataDir(): string {
  return process.env.OPCAI_DATA_DIR || path.join(os.homedir(), '.opcai');
}

/**
 * Headless smoke mode: `OPCAI_ORCH_RUNNER=memory-echo|memory-approval` swaps
 * the real agent-core runner for a deterministic scripted one so end-to-end
 * HTTP acceptance tests need no model credentials or network. The production
 * default keeps agent-core as the only model boundary.
 */
function scriptedRunner(): AgentRunner | null {
  const mode = process.env.OPCAI_ORCH_RUNNER;
  if (mode === 'memory-echo' || mode === 'memory-approval') {
    return createScriptedRunner(mode === 'memory-approval');
  }
  return null;
}

export function getOrchestrator(): Orchestrator {
  if (!instance) {
    const runner = scriptedRunner();
    const store = new JsonFileStore(path.join(dataDir(), 'domain.json'));
    const contextResolver = async (task: ProjectTask): Promise<ChatRunContext | null> => {
      // Remote confirm without client context → assemble from domain KV + keyring.
      try {
        return await resolveTaskContext(store, task);
      } catch {
        return null;
      }
    };
    const chatContextResolver = async (employeeId: string): Promise<ChatRunContext | null> => {
      // Desktop/remote chat without client context → assemble for the employee
      // with all their authorized skills and the default permission tier.
      try {
        const task = {
          id: 'chat',
          title: 'chat',
          objective: '',
          employeeId,
          skillIds: [] as string[],
          permissionTier: 'default' as const,
        } as ProjectTask;
        return await resolveTaskContext(store, task);
      } catch {
        return null;
      }
    };
    instance = new Orchestrator({
      store,
      ...(runner ? { runner } : {}),
      contextResolver,
      chatContextResolver,
    });
    // Fire-and-forget: settle runs left `running` by a previous process exit.
    void instance.recoverOnBoot().catch((error) => {
      console.error('[orch] recoverOnBoot failed', error);
    });
  }
  return instance;
}

export async function closeOrchestrator(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

function fail(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(400).send({ message });
}

function topicFilter(query: Record<string, unknown>): string[] {
  const topics: string[] = [];
  const push = (key: string) => {
    const value = query[key];
    if (typeof value === 'string' && value.trim()) topics.push(`${key}:${value.trim()}`);
  };
  push('session');
  push('project');
  push('run');
  return topics;
}

function sseHeaders(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

export const orchestrationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onClose', async () => {
    await closeOrchestrator();
  });
  const orch = getOrchestrator();

  /* ------------------------------------------------------------------ *
   * Legacy KV proxy — the Electron main process will re-point its
   * `storageGet/storageSet` IPC handlers here so the renderer's existing
   * stores and the orchestrator share one durable domain store.
   * ------------------------------------------------------------------ */

  app.get('/kv', async (request, reply) => {
    const key = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).key ?? '') : '';
    const prefix = request.query && typeof request.query === 'object' ? String((request.query as Record<string, unknown>).prefix ?? '') : '';
    if (key) return { key, value: await orch.store.get(key) };
    const keys = await orch.store.keys(prefix);
    return { keys, prefix };
  });

  app.put('/kv', async (request, reply) => {
    const body = (request.body ?? {}) as { key?: unknown; value?: unknown };
    const key = String(body.key ?? '');
    if (!key) return fail(reply, new Error('key is required.'));
    const value = body.value == null ? '' : String(body.value);
    await orch.store.set(key, value);
    return { ok: true, key };
  });

  app.delete('/kv', async (request, reply) => {
    const body = (request.body ?? {}) as { key?: unknown };
    const key = String(body.key ?? '');
    if (!key) return fail(reply, new Error('key is required.'));
    await orch.store.delete(key);
    return { ok: true, key };
  });

  /* ------------------------------------------------------------------ *
   * Chat sessions
   * ------------------------------------------------------------------ */

  app.post('/sessions', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; employeeId?: string; channelBinding?: { channelId: string; threadId: string } | null };
    const session = await orch.chat.createChatSession({
      title: body.title,
      employeeId: body.employeeId,
      channelBinding: body.channelBinding,
    });
    return { session };
  });

  app.get('/sessions', async () => {
    return { sessions: await orch.chat.listChatSessions() };
  });

  app.get('/sessions/:sessionId', async (request, reply) => {
    const session = await orch.chat.getChatSession(String((request.params as Record<string, string>).sessionId));
    if (!session) return fail(reply, new Error('Chat session not found.'));
    return { session };
  });

  app.delete('/sessions/:sessionId', async (request, reply) => {
    await orch.chat.deleteChatSession(String((request.params as Record<string, string>).sessionId));
    return { ok: true };
  });

  app.post('/sessions/:sessionId/messages', async (request, reply) => {
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const body = (request.body ?? {}) as { content?: string; employeeId?: string; context?: ChatRunContext };
    if (!body.content) return fail(reply, new Error('content is required.'));
    const result = await orch.chat.sendUserMessage(sessionId, {
      content: body.content,
      employeeId: body.employeeId,
      context: body.context,
    });
    return result;
  });

  app.post('/sessions/:sessionId/cancel', async (request, reply) => {
    const aborted = await orch.chat.abortActiveRun(String((request.params as Record<string, string>).sessionId));
    return { aborted };
  });

  /** Flush session rolling memory (switch/idle/close). */
  app.post('/sessions/:sessionId/memory/flush', async (request, reply) => {
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const session = await orch.chat.flushSessionMemory(sessionId);
    if (!session) return fail(reply, new Error('Chat session not found.'));
    return { session };
  });

  app.get('/sessions/:sessionId/runs', async (request, reply) => {
    const session = await orch.chat.getChatSession(String((request.params as Record<string, string>).sessionId));
    if (!session) return fail(reply, new Error('Chat session not found.'));
    const runs = [];
    for (const message of session.messages) {
      if (!message.runId) continue;
      const run = await orch.chat.getRun(message.runId);
      if (run) runs.push(run);
    }
    return { runs };
  });

  app.get('/sessions/:sessionId/approvals', async (request, reply) => {
    const pending = await orch.chat.pendingApprovals(String((request.params as Record<string, string>).sessionId));
    return { pending };
  });

  app.post('/sessions/:sessionId/approvals/:approvalId/resolve', async (request, reply) => {
    const sessionId = String((request.params as Record<string, string>).sessionId);
    const approvalId = String((request.params as Record<string, string>).approvalId);
    const body = (request.body ?? {}) as { allow?: boolean; scope?: 'session' | 'always'; resumeContext?: ChatRunContext };
    const result = await orch.chat.resolveApproval({
      sessionId,
      approvalId,
      allow: Boolean(body.allow),
      scope: body.scope,
      resumeContext: body.resumeContext,
    });
    return result;
  });

  app.get('/runs/:runId', async (request, reply) => {
    const run = await orch.chat.getRun(String((request.params as Record<string, string>).runId));
    if (!run) return fail(reply, new Error('Run not found.'));
    return { run };
  });

  /* ------------------------------------------------------------------ *
   * Projects
   * ------------------------------------------------------------------ */

  app.post('/projects', async (request, reply) => {
    const input = (request.body ?? {}) as CreateProjectDraftInput;
    if (!input.goal || !Array.isArray(input.tasks)) return fail(reply, new Error('goal and tasks are required.'));
    const project = await orch.projects.createDraft(input);
    return { project };
  });

  app.get('/projects', async () => {
    return { projects: await orch.projects.listProjects() };
  });

  app.get('/projects/:projectId', async (request, reply) => {
    const project = await orch.projects.getProject(String((request.params as Record<string, string>).projectId));
    if (!project) return fail(reply, new Error('Project not found.'));
    return { project };
  });

  app.patch('/projects/:projectId', async (request, reply) => {
    const projectId = String((request.params as Record<string, string>).projectId);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const project = await orch.projects.updateDraft(projectId, {
      name: body.name as string | undefined,
      goal: body.goal as string | undefined,
      mode: body.mode as CreateProjectDraftInput['mode'] | undefined,
      workspacePath: body.workspacePath as string | undefined,
      tasks: body.tasks as CreateProjectDraftInput['tasks'] | undefined,
    });
    if (!project) return fail(reply, new Error('Project not found.'));
    return { project };
  });

  app.delete('/projects/:projectId', async (request, reply) => {
    await orch.projects.removeProject(String((request.params as Record<string, string>).projectId));
    return { ok: true };
  });

  app.post('/projects/:projectId/confirm', async (request, reply) => {
    const projectId = String((request.params as Record<string, string>).projectId);
    const body = (request.body ?? {}) as ConfirmProjectInput;
    const result = await orch.projects.confirmProject(projectId, {
      runContextByTask: body.runContextByTask,
      defaultContext: body.defaultContext,
      summaryContext: body.summaryContext,
    });
    if (!result) return fail(reply, new Error('Project not found.'));
    return result;
  });

  app.post('/projects/:projectId/cancel', async (request, reply) => {
    const cancelled = await orch.projects.cancelActiveRun(String((request.params as Record<string, string>).projectId));
    return { cancelled };
  });

  app.post('/projects/:projectId/tasks/:taskId/retry', async (request, reply) => {
    const projectId = String((request.params as Record<string, string>).projectId);
    const taskId = String((request.params as Record<string, string>).taskId);
    const body = (request.body ?? {}) as { context?: ChatRunContext };
    if (!body.context) return fail(reply, new Error('context is required.'));
    const started = await orch.projects.retryTask(projectId, taskId, body.context);
    return { started };
  });

  app.get('/projects/:projectId/tasks/:taskId/transcript', async (request, reply) => {
    const project = await orch.projects.getProject(String((request.params as Record<string, string>).projectId));
    const task = project?.tasks.find((item) => item.id === String((request.params as Record<string, string>).taskId));
    if (!task) return fail(reply, new Error('Task not found.'));
    const transcript = await orch.projects.taskTranscript(task);
    return { transcript };
  });

  app.post('/projects/:projectId/tasks/:taskId/approvals/:approvalId/resolve', async (request, reply) => {
    const projectId = String((request.params as Record<string, string>).projectId);
    const taskId = String((request.params as Record<string, string>).taskId);
    const approvalId = String((request.params as Record<string, string>).approvalId);
    const body = (request.body ?? {}) as Pick<ResolveProjectApprovalInput, 'allow' | 'scope' | 'resumeContext'>;
    const result = await orch.projects.resolveProjectApproval({
      projectId,
      taskId,
      approvalId,
      allow: Boolean(body.allow),
      scope: body.scope,
      resumeContext: body.resumeContext,
    });
    return result;
  });

  app.get('/projects/:projectId/runs', async (request, reply) => {
    const runs = await orch.projects.listProjectRuns(String((request.params as Record<string, string>).projectId));
    return { runs };
  });

  /* ------------------------------------------------------------------ *
   * Event stream (SSE) — subscribe by ?session=&project=&run=
   * ------------------------------------------------------------------ */

  app.get('/events', async (request, reply) => {
    const topics = topicFilter(request.query as Record<string, unknown>);
    if (topics.length === 0) {
      return fail(reply, new Error('Provide at least one of ?session=, ?project= or ?run=.'));
    }
    reply.hijack();
    sseHeaders(reply);
    const unsubscribers: Array<() => void> = [];
    const send = (event: OrcEvent) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`);
    };
    for (const topic of topics) {
      unsubscribers.push(orch.subscribe(topic, send));
    }
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.on('close', cleanup);
  });
};
