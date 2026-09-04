import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promoteWorkspaceDeliverablesToProject } from '@opcai/agent-core';
import type { EventHub, HubListener } from './hub.js';
import { deleteKey, listJsonIds, readJson, writeJson } from './repo.js';
import type { OrcEvent } from './events.js';
import { RunEngine } from './run-engine.js';
import type { ChatRunContext } from './chat-session.js';
import type { KeyValueStore } from './storage/kv.js';
import { namespaceKey } from './storage/kv.js';
import { withKeyLock } from './lock.js';
import type {
  GrantCapability,
  Project,
  ProjectMessage,
  ProjectRun,
  ProjectTask,
  RunRecord,
} from './types.js';

export const PROJECT_KEY_PREFIX = 'projects:';
export const PROJECT_RUN_KEY_PREFIX = 'project-run:';
const PROJECT_NS = 'projects';
const PROJECT_RUN_NS = 'project-run';

const DEFAULT_TASK_CONCURRENCY = 4;
const TASK_SETTLE_POLL_MS = 200;
const PARKED_POLL_MS = 400;

function runWorkspaceRoot(runId: string) {
  return path.join(
    process.env.OPCAI_WORKSPACES_DIR || path.join(os.homedir(), '.opcai', 'workspaces'),
    runId,
  );
}

export interface ProjectTaskDraft {
  /** Stable client id (optional); preserved so dependsOn references survive. */
  id?: string;
  title: string;
  objective: string;
  employeeId: string;
  skillIds: string[];
  dependsOn?: string[];
}

export interface CreateProjectDraftInput {
  name?: string;
  goal: string;
  mode: 'waterfall' | 'parallel' | 'discussion' | 'dag';
  workspacePath: string;
  coordinator?: { provider: string; model: string };
  tasks: ProjectTaskDraft[];
}

export interface ProjectServiceOptions {
  store: KeyValueStore;
  hub: EventHub<OrcEvent>;
  engine: RunEngine;
  runTimeoutMs?: number;
  /**
   * Optional fallback that resolves a run context for a task when the caller
   * did not supply `runContextByTask`/`defaultContext` (e.g. a remote gateway
   * confirming a project). Return null to leave the task failed with a clear
   * message. Never persists secrets.
   */
  contextResolver?: (task: ProjectTask) => ChatRunContext | null | Promise<ChatRunContext | null>;
}

export interface ConfirmProjectInput {
  /** Per-task resolved run context (required unless `defaultContext` covers it). */
  runContextByTask?: Record<string, ChatRunContext>;
  /** Fallback context for tasks without an explicit entry. */
  defaultContext?: ChatRunContext;
  /** Optional coordinator context; when given the project runs a summary turn. */
  summaryContext?: ChatRunContext;
}

export interface ResolveProjectApprovalInput {
  projectId: string;
  taskId: string;
  approvalId: string;
  allow: boolean;
  scope?: 'session' | 'always';
  /** Context needed to re-run the task attempt after granting. */
  resumeContext?: ChatRunContext;
}

function draftToTask(draft: ProjectTaskDraft): ProjectTask {
  return {
    id: draft.id ?? randomUUID(),
    title: draft.title.trim().slice(0, 120) || '未命名任务',
    objective: draft.objective.trim(),
    employeeId: draft.employeeId,
    skillIds: [...(draft.skillIds ?? [])],
    dependsOn: [...(draft.dependsOn ?? [])],
    permissionTier: 'default',
    status: 'draft',
    attempts: 0,
  };
}

interface MutateResult<R> {
  project: Project;
  result: R;
}

export class ProjectService {
  private readonly store: KeyValueStore;
  private readonly hub: EventHub<OrcEvent>;
  private readonly engine: RunEngine;
  private readonly runTimeoutMs: number;
  private readonly taskAborts = new Map<string, AbortController>();
  private readonly contextResolver?: ProjectServiceOptions['contextResolver'];
  /** Transient (never persisted): summary context keyed by active run id. */
  private readonly summaryContextByRun = new Map<string, ChatRunContext>();

  constructor(options: ProjectServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.engine = options.engine;
    this.runTimeoutMs = options.runTimeoutMs ?? 600_000;
    this.contextResolver = options.contextResolver;
  }

  private projectKey(id: string): string {
    return namespaceKey(PROJECT_NS, id);
  }

  private projectRunKey(id: string): string {
    return namespaceKey(PROJECT_RUN_NS, id);
  }

  /**
   * After an API/desktop process restart, in-flight `execute()` calls are gone
   * but RunRecords may still say `running`. Settle those orphans, promote any
   * leftover workspace deliverables, and close project runs that can finish.
   */
  async recoverOrphanedExecution(): Promise<{ projects: number; tasks: number }> {
    const ids = await listJsonIds(this.store, PROJECT_KEY_PREFIX);
    let projectsTouched = 0;
    let tasksTouched = 0;
    for (const id of ids) {
      const project = await this.getProject(id);
      if (!project || project.status !== 'running') continue;
      let changed = false;
      for (const task of project.tasks) {
        if (task.status !== 'running' || !task.runId) continue;
        // Live attempts register an AbortController; absence means orphaned.
        if (this.taskAborts.has(task.id)) continue;
        const run = await this.engine.load(task.runId);
        if (run && run.status !== 'running') {
          task.status = run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed';
          task.finishedAt = run.finishedAt ?? Date.now();
          task.error = run.error;
          changed = true;
          tasksTouched += 1;
          continue;
        }
        const settled = await this.settleOrphanedTask(project, task, run);
        if (settled) {
          changed = true;
          tasksTouched += 1;
        }
      }
      if (!changed) continue;
      projectsTouched += 1;
      await this.saveProject(project);
      this.hub.publish(`project:${project.id}`, { type: 'project.updated', projectId: project.id });
      await this.maybeFinish(project.id, project.activeRunId);
    }
    return { projects: projectsTouched, tasks: tasksTouched };
  }

  private async settleOrphanedTask(project: Project, task: ProjectTask, run: RunRecord | null): Promise<boolean> {
    if (!task.runId) return false;
    const workspaceRoot = runWorkspaceRoot(task.runId);
    let published = 0;
    if (project.workspacePath) {
      try {
        published = (await promoteWorkspaceDeliverablesToProject(workspaceRoot, project.workspacePath)).length;
      } catch {
        published = 0;
      }
    }
    const hasProgress =
      Boolean(run?.transcript?.trim()) ||
      (run?.activities?.length ?? 0) > 0 ||
      (run?.artifacts?.length ?? 0) > 0 ||
      published > 0;
    const now = Date.now();
    const message = hasProgress
      ? `执行进程已中断；已根据运行工作区回收 ${published || run?.artifacts?.length || 0} 个交付物。`
      : '执行进程已中断，任务未正常结束。可重试该任务。';

    if (run && run.status === 'running') {
      run.status = hasProgress ? 'completed' : 'failed';
      run.error = hasProgress ? undefined : message;
      run.finishedAt = now;
      if (hasProgress && !run.transcript.trim()) {
        run.transcript = `（任务产出已写入工作区；${message}）`;
      } else if (!hasProgress && !run.transcript.trim()) {
        run.transcript = message;
      }
      await this.engine.save(run);
      const settled = {
        type: 'run.settled' as const,
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        error: run.error,
      };
      this.hub.publish(`run:${run.id}`, settled);
      this.hub.publish(`project:${project.id}`, settled);
    }

    task.status = hasProgress ? 'completed' : 'failed';
    task.finishedAt = now;
    task.error = hasProgress ? undefined : message;
    this.hub.publish(`project:${project.id}`, {
      type: 'project.task',
      projectId: project.id,
      taskId: task.id,
      status: task.status,
      runId: task.runId,
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Project CRUD (draft state)
   * ------------------------------------------------------------------ */

  async createDraft(input: CreateProjectDraftInput): Promise<Project> {
    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      name: (input.name ?? '').trim() || input.goal.trim().slice(0, 32),
      goal: input.goal.trim(),
      status: 'draft',
      mode: input.mode,
      workspacePath: input.workspacePath,
      coordinator: input.coordinator,
      grantsSession: {},
      grantsAlways: {},
      tasks: input.tasks.map(draftToTask),
      messages: [
        {
          id: randomUUID(),
          role: 'system',
          content: '项目已创建。确认启动后，调度器会按模板编排首轮任务。',
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveProject(project);
    return project;
  }

  /** Replace tasks on a draft project (before any run exists). */
  async updateDraft(id: string, patch: { name?: string; goal?: string; mode?: Project['mode']; workspacePath?: string; tasks?: ProjectTaskDraft[] }): Promise<Project | null> {
    const out = await this.mutateProject(id, (project) => {
      if (project.status !== 'draft') throw new Error('Only draft projects can be edited.');
      if (patch.name !== undefined) project.name = patch.name.trim().slice(0, 80) || project.name;
      if (patch.goal !== undefined) project.goal = patch.goal.trim();
      if (patch.mode !== undefined) project.mode = patch.mode;
      if (patch.workspacePath !== undefined) project.workspacePath = patch.workspacePath;
      if (patch.tasks) {
        const byId = new Map(project.tasks.map((task) => [task.id, task]));
        project.tasks = patch.tasks.map((draft) => {
          const task = draftToTask(draft);
          const existing = draft.id ? byId.get(draft.id) : undefined;
          if (existing) task.id = existing.id;
          return task;
        });
      }
    });
    return out?.project ?? null;
  }

  async getProject(id: string): Promise<Project | null> {
    return readJson<Project>(this.store, this.projectKey(id));
  }

  async listProjects(): Promise<Project[]> {
    const ids = await listJsonIds(this.store, PROJECT_KEY_PREFIX);
    const projects: Project[] = [];
    for (const id of ids) {
      const project = await this.getProject(id);
      if (project) projects.push(project);
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async removeProject(id: string): Promise<void> {
    const project = await this.getProject(id);
    if (!project) return;
    await this.cancelActiveRun(id, 'deleted');
    await deleteKey(this.store, this.projectKey(id));
    const runs = await this.listProjectRuns(id);
    for (const run of runs) await deleteKey(this.store, this.projectRunKey(run.id));
  }

  async listProjectRuns(projectId: string): Promise<ProjectRun[]> {
    const keys = await this.store.keys(PROJECT_RUN_KEY_PREFIX);
    const runs: ProjectRun[] = [];
    for (const key of keys) {
      const run = await readJson<ProjectRun>(this.store, key);
      if (run && run.projectId === projectId) runs.push(run);
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Latest settled run record for a task (transcript/activities/approvals). */
  async taskTranscript(task: ProjectTask): Promise<RunRecord | null> {
    if (!task.runId) return null;
    return this.engine.load(task.runId);
  }

  /* ------------------------------------------------------------------ *
   * Execution
   * ------------------------------------------------------------------ */

  async confirmProject(id: string, input: ConfirmProjectInput = {}): Promise<{ project: Project; run: ProjectRun } | null> {
    const out = await this.mutateProject(id, async (project) => {
      if (project.status === 'running') throw new Error('Project is already running.');
      if (project.status === 'draft' && project.tasks.length === 0) throw new Error('Project has no tasks to run.');
      const now = Date.now();
      const projectRun: ProjectRun = {
        id: randomUUID(),
        projectId: project.id,
        startedAt: now,
        status: 'running',
        taskIds: project.tasks.map((task) => task.id),
      };
      project.activeRunId = projectRun.id;
      project.status = 'running';
      project.summary = undefined;
      for (const task of project.tasks) {
        // Completed tasks are kept; everything else (draft/failed/cancelled)
        // is re-queued so a re-schedule ("再次调度") can recover a project that
        // was cancelled or stalled.
        if (task.status === 'completed') continue;
        task.status = 'queued';
        task.error = undefined;
        task.attempts = 0;
        task.runId = undefined;
      }
      await writeJson(this.store, this.projectRunKey(projectRun.id), projectRun);
      return { projectRun };
    });
    if (!out) return null;
    if (input.summaryContext) this.summaryContextByRun.set(out.result.projectRun.id, input.summaryContext);

    void this.runScheduler(id, out.result.projectRun.id, input).catch(async (error) => {
      await this.finishProjectRun(id, out!.result.projectRun.id, 'failed', undefined, error instanceof Error ? error.message : '项目调度失败。');
    });
    return { project: out.project, run: out.result.projectRun };
  }

  async cancelActiveRun(projectId: string, reason = 'user'): Promise<boolean> {
    const out = await this.mutateProject(projectId, async (project) => {
      if (!project.activeRunId) return { cancelled: false };
      const activeRunId = project.activeRunId;
      for (const task of project.tasks) {
        if (task.status === 'running') {
          const abort = this.taskAborts.get(task.id);
          if (abort && !abort.signal.aborted) abort.abort();
        } else if (task.status === 'queued') {
          task.status = 'cancelled';
        }
      }
      project.activeRunId = undefined;
      project.status = 'cancelled';
      project.summary = undefined;
      const run = await readJson<ProjectRun>(this.store, this.projectRunKey(activeRunId));
      if (run) {
        run.status = 'cancelled';
        run.finishedAt = Date.now();
        run.error = '已由用户取消。';
        await writeJson(this.store, this.projectRunKey(run.id), run);
      }
      return { cancelled: true };
    });
    void reason;
    return out?.result.cancelled ?? false;
  }

  /** Re-run one failed/cancelled task (does not restart the whole project). */
  async retryTask(projectId: string, taskId: string, context?: ChatRunContext): Promise<boolean> {
    const project = await this.getProject(projectId);
    const task = project?.tasks.find((item) => item.id === taskId);
    if (!project || !task) throw new Error('Task not found.');
    if (project.status === 'draft') throw new Error('Project has not started yet.');
    if (task.status === 'running') throw new Error('Task is already running.');

    const runContext = context ?? ((await this.contextResolver?.(task)) ?? undefined);
    if (!runContext) throw new Error('No run context available; configure a model first.');
    const started = await this.startTask(projectId, task, runContext);
    if (started) await this.maybeFinish(projectId);
    return started;
  }

  /** Decide a task's pending approval; when allowed re-runs that task. */
  async resolveProjectApproval(input: ResolveProjectApprovalInput): Promise<{ resumed?: boolean }> {
    const project = await this.getProject(input.projectId);
    const task = project?.tasks.find((item) => item.id === input.taskId);
    if (!project || !task || !task.runId) throw new Error('Task run not found.');
    const run = await this.engine.load(task.runId);
    const approval = run?.approvals.find((item) => item.id === input.approvalId);
    if (!run || !approval || approval.status !== 'pending') throw new Error('Approval is not pending.');

    await this.engine.decideApproval(run.id, input.approvalId, { allow: input.allow, scope: input.scope });

    if (!input.allow) {
      // Deny: settle every remaining pending approval on this run, flip the run
      // to cancelled, and mark the parked task cancelled so the scheduler can
      // continue to the next task instead of waiting forever.
      for (const item of run.approvals) {
        if (item.status === 'pending') {
          item.status = 'denied';
          item.resolvedAt = Date.now();
        }
      }
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      run.error = '工具授权被拒绝，任务已跳过。';
      await this.engine.save(run);
      await this.mutateProject(input.projectId, (current) => {
        const target = current.tasks.find((item) => item.id === task.id);
        if (target && target.status === 'running') {
          target.status = 'cancelled';
          target.finishedAt = Date.now();
          target.error = '工具授权被拒绝，任务已跳过。';
        }
      });
      this.hub.publish(`project:${input.projectId}`, { type: 'project.task', projectId: input.projectId, taskId: task.id, status: 'cancelled', runId: run.id });
      return { resumed: false };
    }

    await this.mutateProject(input.projectId, (current) => {
      if (approval) this.applyGrant(current, approval.skillId, approval.capability, input.scope ?? 'session');
    });

    // Allow: resume the same task as a new attempt. When the client sent no
    // context, assemble it server-side; also carry the granted network host into
    // the resumed context so the same tool call does not immediately re-park.
    let resumeContext = input.resumeContext ?? ((await this.contextResolver?.(task)) ?? undefined);
    if (!resumeContext) return { resumed: false };
    if (approval?.capability === 'network-access') this.grantNetworkHostToContext(resumeContext, approval.summary);
    const resumed = await this.startTask(input.projectId, task, resumeContext);
    return { resumed };
  }

  /** Add the host named in a network-access approval to every skill's allowed hosts. */
  private grantNetworkHostToContext(context: ChatRunContext, summary: string): void {
    const match = /([a-z0-9.-]+\.[a-z]{2,})/i.exec(summary ?? '');
    if (!match) return;
    const host = match[1].toLowerCase();
    for (const skill of context.skills ?? []) {
      const execution = (skill as { execution?: { allowedNetworkHosts?: string[] } }).execution;
      if (execution && !(execution.allowedNetworkHosts ?? []).includes(host)) {
        execution.allowedNetworkHosts = [...(execution.allowedNetworkHosts ?? []), host];
      }
    }
  }

  private applyGrant(project: Project, skillId: string, capability: GrantCapability, scope: 'session' | 'always') {
    const target = scope === 'always' ? project.grantsAlways! : project.grantsSession!;
    const list = target[skillId] ?? [];
    if (!list.includes(capability)) list.push(capability);
    target[skillId] = list;
  }

  /* ------------------------------------------------------------------ *
   * Scheduler internals
   * ------------------------------------------------------------------ */

  private async runScheduler(projectId: string, projectRunId: string, input: ConfirmProjectInput): Promise<void> {
    await this.drain(projectId, projectRunId, input);
    await this.maybeFinish(projectId, projectRunId);
  }

  private async isAlive(projectId: string, projectRunId: string): Promise<boolean> {
    const project = await this.getProject(projectId);
    return Boolean(project && project.activeRunId === projectRunId && project.status === 'running');
  }

  private async runStatusOf(task: ProjectTask): Promise<RunRecord['status'] | undefined> {
    if (!task.runId) return undefined;
    const run = await this.engine.load(task.runId);
    return run?.status;
  }

  private async isParked(task: ProjectTask): Promise<boolean> {
    if (task.status !== 'running') return false;
    return (await this.runStatusOf(task)) === 'waiting-approval';
  }

  private async drain(projectId: string, projectRunId: string, input: ConfirmProjectInput): Promise<void> {
    for (;;) {
      const project = await this.getProject(projectId);
      if (!project || !(await this.isAlive(projectId, projectRunId))) return;
      const mode = project.mode;
      const limit = mode === 'parallel' || mode === 'dag' ? DEFAULT_TASK_CONCURRENCY : 1;

      const parked = new Map<string, ProjectTask>();
      const running: ProjectTask[] = [];
      const queued: ProjectTask[] = [];
      for (const task of project.tasks) {
        if (task.status === 'running' && (await this.isParked(task))) parked.set(task.id, task);
        else if (task.status === 'running') running.push(task);
        else if (task.status === 'queued') queued.push(task);
      }

      const ready: ProjectTask[] = [];
      if (mode === 'waterfall' || mode === 'discussion') {
        for (const task of project.tasks) {
          if (task.status === 'completed' || task.status === 'cancelled') continue;
          if (task.status === 'failed') {
            await this.mutateProject(projectId, (fresh) => {
              for (const later of fresh.tasks) {
                if (later.status === 'queued') {
                  later.status = 'failed';
                  later.error = '前置任务失败，无法继续。';
                }
              }
            });
            return;
          }
          if (parked.has(task.id) || task.status === 'running') break;
          if (task.status === 'queued') {
            ready.push(task);
            break;
          }
        }
      } else {
        for (const task of queued) {
          const depsOk = (task.dependsOn ?? []).every((depId) => {
            const dep = project.tasks.find((item) => item.id === depId);
            if (!dep) return true;
            return dep.status === 'completed' || dep.status === 'cancelled';
          });
          if (depsOk) {
            ready.push(task);
            if (running.length + ready.length >= limit) break;
          }
        }
      }

      if (ready.length > 0) {
        await Promise.allSettled(
          ready.map(async (task) => {
            let runContext = input.runContextByTask?.[task.id] ?? input.defaultContext;
            if (!runContext && this.contextResolver) {
              try {
                runContext = (await this.contextResolver(task)) ?? undefined;
              } catch {
                runContext = undefined;
              }
            }
            if (!runContext) {
              await this.mutateProject(projectId, (fresh) => {
                const target = fresh.tasks.find((item) => item.id === task.id);
                if (target) {
                  target.status = 'failed';
                  target.error = '缺少该任务的运行上下文（模型/Skill 配置）。请先在桌面端配置模型或指定默认上下文。';
                }
              });
              return;
            }
            await this.startTask(projectId, task, runContext);
          }),
        );
        continue;
      }

      if (running.length > 0) {
        await this.waitRunningSettle(projectId, projectRunId, running);
        continue;
      }

      if (parked.size > 0) {
        await this.waitForApprovalResolution(projectId, projectRunId);
        continue;
      }

      if (queued.length > 0) {
        await this.mutateProject(projectId, (fresh) => {
          for (const task of fresh.tasks) {
            if (task.status === 'queued') {
              task.status = 'failed';
              task.error = '存在循环依赖，无法继续。';
            }
          }
        });
      }
      return;
    }
  }

  private async waitRunningSettle(projectId: string, projectRunId: string, running: ProjectTask[]) {
    const deadline = Date.now() + this.runTimeoutMs + 60_000;
    while (Date.now() < deadline && (await this.isAlive(projectId, projectRunId))) {
      let settled = 0;
      for (const task of running) {
        const status = await this.runStatusOf(task);
        if (!status || status !== 'running') settled += 1;
      }
      if (settled === running.length) return;
      await new Promise((resolve) => setTimeout(resolve, TASK_SETTLE_POLL_MS));
    }
  }

  private async waitForApprovalResolution(projectId: string, projectRunId: string) {
    const deadline = Date.now() + this.runTimeoutMs + 300_000;
    while (Date.now() < deadline && (await this.isAlive(projectId, projectRunId))) {
      const project = await this.getProject(projectId);
      if (!project) return;
      let parked = false;
      for (const task of project.tasks) {
        if (task.status === 'running' && (await this.isParked(task))) {
          parked = true;
          break;
        }
      }
      if (!parked) return;
      await new Promise((resolve) => setTimeout(resolve, PARKED_POLL_MS));
    }
  }

  /** Called after every task settles. Closes the project run when done. */
  private async maybeFinish(projectId: string, onlyRunId?: string): Promise<void> {
    const out = await this.mutateProject(projectId, async (project) => {
      if (!project.activeRunId) return { summaryContext: undefined, needsSummary: false };
      if (onlyRunId && project.activeRunId !== onlyRunId) return { summaryContext: undefined, needsSummary: false };

      const parkedIds = new Set<string>();
      for (const task of project.tasks) {
        if (await this.isParked(task)) parkedIds.add(task.id);
      }
      const busy = project.tasks.some(
        (task) => task.status === 'queued' || (task.status === 'running' && !parkedIds.has(task.id)),
      );
      if (busy || parkedIds.size > 0) return { summaryContext: undefined, needsSummary: false };

      const activeRunId = project.activeRunId;
      const summaryContext = this.summaryContextByRun.get(activeRunId);
      const hasFailures = project.tasks.some((task) => task.status === 'failed');
      const allDone = project.tasks.every((task) => task.status === 'completed' || task.status === 'cancelled');

      const status: ProjectRun['status'] = hasFailures ? 'failed' : allDone ? 'completed' : 'cancelled';
      const run = await readJson<ProjectRun>(this.store, this.projectRunKey(activeRunId));
      if (run) {
        run.status = status;
        run.finishedAt = Date.now();
        run.summary = project.summary;
        run.error = hasFailures ? '存在失败任务。' : undefined;
        await writeJson(this.store, this.projectRunKey(run.id), run);
      }
      project.activeRunId = undefined;
      project.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
      this.summaryContextByRun.delete(activeRunId);
      return { summaryContext, needsSummary: Boolean(summaryContext && allDone && !hasFailures) };
    });
    if (out?.result.needsSummary && out.result.summaryContext) {
      await this.runSummaryAfterFinish(projectId, out.result.summaryContext);
    }
  }

  /** Execute one task attempt. Returns false when the run is no longer valid. */
  private async startTask(projectId: string, task: ProjectTask, context: ChatRunContext): Promise<boolean> {
    const runId = randomUUID();
    const abortHolder: { controller?: AbortController } = {};
    const out = await this.mutateProject(projectId, (project) => {
      if (project.status !== 'running' || !project.activeRunId) return { started: false };
      const current = project.tasks.find((item) => item.id === task.id);
      if (!current || current.status === 'cancelled') return { started: false };
      abortHolder.controller = new AbortController();
      this.taskAborts.set(task.id, abortHolder.controller);
      current.status = 'running';
      current.attempts += 1;
      current.startedAt = Date.now();
      current.error = undefined;
      current.runId = runId;
      return { started: true };
    });
    if (!out?.result.started) return false;
    const signal = abortHolder.controller?.signal ?? new AbortController().signal;

    const currentTask = (await this.getProject(projectId))?.tasks.find((item) => item.id === task.id);
    const project = await this.getProject(projectId);
    const request = {
      ...context,
      runId,
      ...(project?.workspacePath ? { projectWorkspacePath: project.workspacePath } : {}),
      messages: [{ role: 'user' as const, content: (currentTask ?? task).objective }],
    };
    let run: RunRecord;
    try {
      run = await this.engine.execute({
        runId,
        sessionId: projectId,
        kind: 'project-task',
        taskId: task.id,
        attemptNo: (currentTask ?? task).attempts,
        request,
        signal,
        extraTopics: [`project:${projectId}`],
      });
    } finally {
      this.taskAborts.delete(task.id);
    }

    await this.mutateProject(projectId, (latest) => {
      const target = latest.tasks.find((item) => item.id === task.id);
      if (!target || target.runId !== run.id) return;
      if (latest.status !== 'running' && latest.status !== 'cancelled') return;
      target.finishedAt = Date.now();
      target.error = run.error;
      if (run.status === 'completed') target.status = 'completed';
      else if (run.status === 'cancelled') target.status = 'cancelled';
      else if (run.status === 'waiting-approval') {
        target.status = 'running';
        target.error = '任务等待审批后继续。';
      } else target.status = 'failed';
      this.hub.publish(`project:${latest.id}`, { type: 'project.task', projectId: latest.id, taskId: task.id, status: target.status, runId: run.id });
    });
    return true;
  }

  /** Runs the coordinator summary after the project run finished. */
  private async runSummaryAfterFinish(projectId: string, context: ChatRunContext): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) return;
    const parts: string[] = [];
    for (const task of project.tasks) {
      if (task.status !== 'completed') continue;
      const transcript = await this.taskTranscript(task);
      const text = transcript?.transcript.trim();
      parts.push(`### ${task.title}\n${text || '(无文本输出)'}`);
    }
    const messageId = randomUUID();
    await this.mutateProject(projectId, (fresh) => {
      fresh.messages.push({ id: messageId, role: 'assistant', content: '', createdAt: Date.now(), taskId: 'summary' });
    });
    const request = {
      ...context,
      messages: [
        {
          role: 'user' as const,
          content: `项目目标：${project.goal}\n\n已完成子任务结果（仅作参考）：\n${parts.join('\n\n')}\n\n请汇总最终交付。不要虚构失败任务的信息。`,
        },
      ],
    };
    const run = await this.engine.execute({
      runId: randomUUID(),
      sessionId: projectId,
      kind: 'project-task',
      taskId: 'summary',
      attemptNo: 1,
      request,
      extraTopics: [`project:${projectId}`],
    });
    await this.mutateProject(projectId, (fresh) => {
      const target = fresh.messages.find((item) => item.id === messageId);
      if (target) target.content = run.transcript.trim() || '(汇总未返回文本。)';
      fresh.summary = run.transcript.trim() || fresh.summary;
    });
  }

  private async finishProjectRun(projectId: string, projectRunId: string, status: ProjectRun['status'], summary?: string, error?: string) {
    await this.mutateProject(projectId, async (project) => {
      if (!project.activeRunId || project.activeRunId !== projectRunId) return;
      const run = await readJson<ProjectRun>(this.store, this.projectRunKey(projectRunId));
      if (run) {
        run.status = status;
        run.finishedAt = Date.now();
        run.summary = summary ?? project.summary;
        run.error = error;
        await writeJson(this.store, this.projectRunKey(run.id), run);
      }
      project.activeRunId = undefined;
      project.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
      project.summary = summary ?? project.summary;
    });
  }

  /** Serialized read-modify-write of one project document. */
  private async mutateProject<R>(id: string, fn: (project: Project) => Promise<R> | R): Promise<MutateResult<R> | null> {
    return withKeyLock(`project-doc:${id}`, async () => {
      const project = await readJson<Project>(this.store, this.projectKey(id));
      if (!project) return null;
      const result = await fn(project);
      project.updatedAt = Date.now();
      await writeJson(this.store, this.projectKey(id), project);
      this.hub.publish(`project:${id}`, { type: 'project.updated', projectId: id });
      return { project, result };
    });
  }

  private async saveProject(project: Project): Promise<void> {
    project.updatedAt = Date.now();
    await writeJson(this.store, this.projectKey(project.id), project);
    this.hub.publish(`project:${project.id}`, { type: 'project.updated', projectId: project.id });
  }

  /** Watch every orchestration event published on a project's topic. */
  subscribe(projectId: string, listener: HubListener<OrcEvent>): () => void {
    return this.hub.subscribe(`project:${projectId}`, listener);
  }
}
