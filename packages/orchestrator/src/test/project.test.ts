import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, Orchestrator, type Project } from '../index.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

async function createDraft(orch: Orchestrator, goal: string, mode: Project['mode'], tasks: Array<{ title: string; objective: string; dependsOn?: string[] }>) {
  const project = await orch.projects.createDraft({
    goal,
    mode,
    workspacePath: '/tmp/opcai-workspace',
    coordinator: { provider: 'ollama', model: 'fake-model' },
    tasks: tasks.map((task) => ({ ...task, employeeId: 'general', skillIds: [] })),
  });
  return project;
}

test('parallel project: all tasks run and the project completes', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '产出一份分析报告', 'parallel', [
      { title: '调研', objective: '调研行业现状' },
      { title: '写作', objective: '撰写报告正文' },
      { title: '质检', objective: '检查报告质量' },
    ]);
    await orch.projects.confirmProject(project.id, {
      defaultContext: runContext(),
    });

    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    assert.ok(done?.tasks.every((task) => task.runId));
    assert.equal(fake.calls.length, 3);

    // Task transcripts are durable and carry the assistant output.
    for (const task of done?.tasks ?? []) {
      const transcript = await orch.projects.taskTranscript(task);
      assert.ok(transcript?.transcript.includes('echo#1') || transcript?.transcript.includes('echo#2') || transcript?.transcript.includes('echo#3'));
    }
    const runs = await orch.projects.listProjectRuns(project.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
  } finally {
    await orch.close();
  }
});

test('dag respects dependsOn ordering regardless of declaration order', async () => {
  const fake = new FakeRunner({ texts: (request) => request.messages.at(-1)?.content ?? '' });
  // Two clients share one physical store (like desktop UI + a gateway).
  const store = new MemoryStore();
  const first = new Orchestrator({ store, runner: fake });
  const second = new Orchestrator({ store, runner: fake });
  try {
    const project = await first.projects.createDraft({
      goal: '先建地基再盖楼',
      mode: 'dag',
      workspacePath: '/tmp/opcai-workspace',
      coordinator: { provider: 'ollama', model: 'fake-model' },
      tasks: [
        { id: 'b', title: '后置', objective: 'B-盖楼', employeeId: 'general', skillIds: [], dependsOn: ['a'] },
        { id: 'a', title: '前置', objective: 'A-打地基', employeeId: 'general', skillIds: [] },
      ],
    });

    // The gateway client confirms a draft the desktop client created.
    await second.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await second.projects.getProject(project.id))?.status === 'completed');

    const done = await second.projects.getProject(project.id);
    assert.deepEqual(
      done?.tasks.map((task) => task.status),
      ['completed', 'completed'],
    );
    const order = fake.calls.map((call) => call.messages.at(-1)?.content ?? '');
    assert.deepEqual(order, ['A-打地基', 'B-盖楼']);
  } finally {
    await first.close();
    await second.close();
  }
});

test('waterfall runs strictly one task after another', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '顺序执行', 'waterfall', [
      { title: '一', objective: '第一步' },
      { title: '二', objective: '第二步' },
      { title: '三', objective: '第三步' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    const order = fake.calls.map((call) => call.messages.at(-1)?.content ?? '');
    assert.deepEqual(order, ['第一步', '第二步', '第三步']);
  } finally {
    await orch.close();
  }
});

test('task approval parks the task and resume finishes the project', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 'document-workbench', capability: 'workspace-write', summary: '需要写入工作区' }],
  });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '需要审批的项目', 'waterfall', [
      { title: '任务A', objective: '写入文件' },
      { title: '任务B', objective: '校验结果' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });

    // Task A parks waiting approval; scheduler must not mark the project done.
    await waitFor(async () => {
      const current = await orch.projects.getProject(project.id);
      return Boolean(current && current.status === 'running' && current.tasks[0].status === 'running');
    });
    const waiting = await orch.projects.getProject(project.id);
    const taskA = waiting?.tasks[0];
    assert.ok(taskA?.runId);
    const parked = await orch.projects.taskTranscript(taskA);
    assert.equal(parked?.status, 'waiting-approval');

    // Meanwhile task B may already be queued but not running (waterfall).
    await orch.projects.resolveProjectApproval({
      projectId: project.id,
      taskId: taskA!.id,
      approvalId: parked!.approvals[0].id,
      allow: true,
      scope: 'session',
      resumeContext: runContext(),
    });

    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    assert.equal(fake.calls.length, 3); // A (approval), A retry, B
  } finally {
    await orch.close();
  }
});

test('server-side context resolver runs tasks when confirm carries no context', async () => {
  const fake = new FakeRunner({ texts: (request) => `resolved:${request.messages.at(-1)?.content ?? ''}` });
  const orch = new Orchestrator({
    store: new MemoryStore(),
    runner: fake,
    contextResolver: async () => runContext(),
  });
  try {
    const project = await createDraft(orch, '无上下文项目', 'parallel', [
      { title: '任务1', objective: '第一步' },
      { title: '任务2', objective: '第二步' },
    ]);
    // Remote gateway confirms WITHOUT any runContextByTask/defaultContext —
    // the orchestrator's fallback resolver supplies each task's context.
    await orch.projects.confirmProject(project.id, {});
    await waitFor(async () => (await orch.projects.getProject(project.id))?.status === 'completed');
    const done = await orch.projects.getProject(project.id);
    assert.ok(done?.tasks.every((task) => task.status === 'completed'));
    const contents = fake.calls.map((call) => call.messages.at(-1)?.content ?? '');
    assert.deepEqual(contents, ['第一步', '第二步']);
  } finally {
    await orch.close();
  }
});

test('cancel aborts queued work and finishes as cancelled', async () => {
  const fake = new FakeRunner({ texts: () => 'slow', delayMs: 300 });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const project = await createDraft(orch, '取消测试', 'parallel', [
      { title: '任务1', objective: '长任务一' },
      { title: '任务2', objective: '长任务二' },
    ]);
    await orch.projects.confirmProject(project.id, { defaultContext: runContext() });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await orch.projects.cancelActiveRun(project.id);
    await waitFor(async () => {
      const current = await orch.projects.getProject(project.id);
      return Boolean(current && current.status === 'cancelled' && current.tasks.every((task) => task.status === 'cancelled' || task.status === 'failed'));
    }, 8_000);
    const done = await orch.projects.getProject(project.id);
    assert.equal(done?.status, 'cancelled');
  } finally {
    await orch.close();
  }
});
