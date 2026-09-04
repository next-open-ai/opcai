import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatRequest } from '@opcai/contracts';
import type { OrcEvent } from './events.js';
import type { EventHub } from './hub.js';
import { readJson, writeJson } from './repo.js';
import type { AgentRunner } from './runner.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import type { GrantCapability, RunActivity, RunApproval, RunRecord, RunStatus } from './types.js';

export type { OrcEvent };

export interface ExecuteAttemptOptions {
  runId?: string;
  sessionId: string;
  kind: 'chat' | 'project-task';
  taskId?: string;
  turnId?: string;
  attemptNo?: number;
  request: ChatRequest;
  /** Abort this attempt (user cancel / timeout). */
  signal?: AbortSignal;
  /** Extra hub topics to publish structural events onto (e.g. project:<id>). */
  extraTopics?: string[];
}

export const RUN_NS = 'run';

function isDeltaLike(event: AgentEvent): boolean {
  return event.type === 'message.delta';
}

/**
 * Executes one agent attempt and records a durable RunRecord.
 *
 * Resumable-run semantics (M0):
 * - A tool that needs approval yields `tool.approval_required`. The engine
 *   keeps collecting events until the model turn settles, then marks the run
 *   `waiting-approval` instead of `completed`.
 * - The caller resolves approvals and starts a *new attempt* of the same turn
 *   with the granted capabilities merged into the request (see chat-session /
 *   project service). Deltas are streamed live over the hub and only final
 *   state is persisted, so approvals/artifacts/activities survive restarts.
 */
export class RunEngine {
  constructor(
    private readonly store: KeyValueStore,
    private readonly runner: AgentRunner,
    private readonly hub: EventHub<OrcEvent>,
    private readonly runTimeoutMs = 600_000,
  ) {}

  private runKey(runId: string): string {
    return namespaceKey(RUN_NS, runId);
  }

  async load(runId: string): Promise<RunRecord | null> {
    return readJson<RunRecord>(this.store, this.runKey(runId));
  }

  async save(run: RunRecord): Promise<void> {
    await writeJson(this.store, this.runKey(run.id), run);
  }

  /** Record an approval decision on a run (called by chat/project services). */
  async decideApproval(runId: string, approvalId: string, decision: { allow: boolean; scope?: 'session' | 'always' }): Promise<RunRecord | null> {
    const run = await this.load(runId);
    if (!run) return null;
    const approval = run.approvals.find((item) => item.id === approvalId);
    if (!approval || approval.status !== 'pending') return run;
    approval.status = decision.allow ? 'allowed' : 'denied';
    approval.scope = decision.allow ? decision.scope ?? 'session' : undefined;
    approval.resolvedAt = Date.now();
    await this.save(run);
    this.hub.publish(`run:${runId}`, { type: 'run.approval', runId, approval: { ...approval } });
    return run;
  }

  /**
   * Start an attempt and drive it to completion. Resolves once the run
   * settles. Persisted status transitions happen here; message deltas are
   * only streamed.
   */
  async execute(options: ExecuteAttemptOptions): Promise<RunRecord> {
    const runId = options.runId ?? randomUUID();
    const attemptNo = options.attemptNo ?? 1;
    const now = Date.now();
    const run: RunRecord = {
      id: runId,
      sessionId: options.sessionId,
      kind: options.kind,
      taskId: options.taskId,
      turnId: options.turnId,
      attemptNo,
      status: 'running',
      startedAt: now,
      transcript: '',
      activities: [],
      approvals: [],
      artifacts: [],
      sources: [],
      eventLog: [],
    };

    const topic = `run:${runId}`;
    const sessionTopic = `session:${options.sessionId}`;
    const topics = [...new Set([topic, sessionTopic, ...(options.extraTopics ?? [])])];
    const publish = (event: OrcEvent) => {
      for (const item of topics) this.hub.publish(item, event);
    };

    // Persist a 'running' record BEFORE the attempt starts. Consumers
    // (RunEngine.load / runStatusOf / waitRunningSettle / isParked and the
    // renderer's settle waiters) treat a missing run record as "settled", so
    // without this the scheduler would see the run as finished while it is
    // still executing and never advance to the next task.
    await this.save(run);
    publish({ type: 'run.started', runId, sessionId: options.sessionId, kind: options.kind, taskId: options.taskId, attemptNo });

    const emit = (event: AgentEvent) => {
      if (event.type === 'message.delta' && event.text) {
        run.transcript += event.text;
        publish({ type: 'run.delta', runId, sessionId: options.sessionId, text: event.text });
        return;
      }
      run.eventLog.push(event);
      if (run.eventLog.length > 500) run.eventLog.splice(0, run.eventLog.length - 500);
      switch (event.type) {
        case 'tool.started': {
          const activity: RunActivity = { toolName: event.toolName, summary: event.summary, status: 'running', at: Date.now() };
          run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity });
          break;
        }
        case 'tool.completed': {
          const activity: RunActivity = { toolName: event.toolName, summary: event.summary, status: event.ok ? 'completed' : 'failed', at: Date.now() };
          run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity });
          break;
        }
        case 'tool.failed': {
          const activity: RunActivity = { toolName: event.toolName, summary: event.summary, status: 'failed', at: Date.now() };
          run.activities.push(activity);
          publish({ type: 'run.activity', runId, activity });
          break;
        }
        case 'tool.approval_required': {
          const approval: RunApproval = {
            id: randomUUID(),
            skillId: event.skillId,
            capability: event.capability as GrantCapability,
            summary: event.summary,
            status: 'pending',
            at: Date.now(),
          };
          run.approvals.push(approval);
          publish({ type: 'run.approval', runId, approval });
          break;
        }
        case 'artifact.created': {
          const artifact = { path: event.path };
          run.artifacts.push(artifact);
          publish({ type: 'run.artifact', runId, artifact });
          break;
        }
        case 'search.sources': {
          run.sources = event.sources.map((source) => ({ ...source }));
          publish({ type: 'run.sources', runId, sources: run.sources });
          break;
        }
        default:
          break;
      }
    };

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutId = setTimeout(() => abortController.abort(new Error(`Run timed out after ${Math.round(this.runTimeoutMs / 1000)}s`)), this.runTimeoutMs);

    try {
      await this.runner.start(options.request, emit, { abortSignal: abortController.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model request failed.';
      if (!abortController.signal.aborted) {
        run.status = 'failed';
        run.error = message;
      }
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    // Agent-core already emits run.completed / run.failed / run.cancelled as
    // events; map terminal state from the event log when needed.
    const lastTerminal = [...run.eventLog].reverse().find((event) => event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled');
    if (lastTerminal) {
      switch (lastTerminal.type) {
        case 'run.failed':
          run.status = 'failed';
          run.error = lastTerminal.message;
          break;
        case 'run.cancelled':
          run.status = 'cancelled';
          run.error = lastTerminal.message;
          run.cancelReason = lastTerminal.reason;
          break;
        case 'run.completed':
          run.status = 'completed';
          break;
      }
    } else if (run.status === 'running') {
      run.status = abortController.signal.aborted ? 'cancelled' : 'failed';
      if (!run.error) run.error = abortController.signal.aborted ? '已中止当前执行。' : 'Model request failed.';
    }

    const pending = run.approvals.filter((approval) => approval.status === 'pending');
    if (run.status === 'completed' && pending.length > 0) {
      run.status = 'waiting-approval';
    }
    run.finishedAt = Date.now();
    await this.save(run);
    publish({ type: 'run.settled', runId, sessionId: options.sessionId, status: run.status, error: run.error });
    return run;
  }
}

export type { GrantCapability };
