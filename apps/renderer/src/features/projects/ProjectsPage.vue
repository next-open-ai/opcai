<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  Employee,
  EmployeeId,
  ProjectTaskDraft,
} from "../../app/workspace.js";
import { employeeDisplayName } from "../../app/employees.js";
import type { ProviderConfig, ProviderId } from "../../app/model-config.js";
import { useModelConfig } from "../../app/model-config.js";
import type { ToolActivity, ToolApproval } from "../../services/api.js";
import { useCapabilities } from "../../app/capabilities.js";
import { readStored, writeStored } from "../../app/storage.js";
import {
  useProjects,
  type Project,
  type ProjectMessage,
  type ProjectMode,
  type ProjectTask,
  type ProjectTaskInput,
} from "../../app/projects.js";
import ProjectConversationWorkspace from "./ProjectConversationWorkspace.vue";
import * as orch from "../../services/orchestration.js";

type Transcript = {
  assistantContent: string;
  activities: ToolActivity[];
  approvals: ToolApproval[];
  assets: Array<{ id: string; name: string; sizeBytes: number; runId?: string }>;
  runId?: string;
};
const props = defineProps<{
  employees: Employee[];
  models: ProviderConfig[];
  generateDraft: (
    goal: string,
    model: ProviderConfig,
  ) => Promise<ProjectTaskDraft[]>;
  runTask: (
    input: {
      projectId: string;
      taskId: string;
      prompt: string;
      employeeId: EmployeeId;
      skillIds: string[];
      permissionTier: "read-only" | "default" | "full";
      model: ProviderConfig;
      workspacePath?: string;
    },
    onActivity?: (activity: ToolActivity) => void,
    onDelta?: (delta: string) => void,
  ) => Promise<Transcript>;
}>();
const { load: loadSkills, allowedSkillsFor } = useCapabilities();
const {
  projects,
  runs,
  load,
  createDraft,
  update,
  remove,
  createRun,
  finishRun,
} = useProjects();

/* ------------------------------------------------------------------ *
 * M0 managed (server-orchestrated) projects.
 *
 * New projects created from this page live on the orchestration server
 * (`/api/orch/projects`); the server owns scheduling, approvals and durable
 * state — the page only mirrors it (poll + on-demand transcript hydration).
 * Legacy local projects keep the original scheduler below.
 * ------------------------------------------------------------------ */
const managedPollers = new Map<string, ReturnType<typeof setInterval>>();
const managedPollCounts = new Map<string, number>();
function stopManagedPoll(projectId: string) {
  const timer = managedPollers.get(projectId);
  if (timer) clearInterval(timer);
  managedPollers.delete(projectId);
  managedPollCounts.delete(projectId);
}
const hydratedKeys = new Set<string>();

function managedProvider(): ProviderId {
  return props.models[0]?.provider ?? "openai";
}
function managedModel(): string {
  return props.models[0]?.chatModel ?? "";
}

function serverToTranscript(run: orch.ServerRunRecord): Transcript {
  return {
    assistantContent: run.transcript,
    activities: run.activities.map((activity) => ({
      toolName: activity.toolName,
      summary: activity.summary,
      status:
        activity.status === "completed" || activity.status === "failed"
          ? activity.status
          : ("running" as const),
    })),
    approvals: run.approvals.map((approval) => ({
      skillId: approval.skillId,
      capability: approval.capability,
      summary: approval.summary,
    })),
    assets: run.artifacts
      .filter((artifact) => artifact.assetId)
      .map((artifact) => ({
        id: artifact.assetId!,
        name: artifact.assetName || artifact.path,
        sizeBytes: artifact.assetSizeBytes ?? 0,
        runId: run.id,
      })),
    runId: run.id,
  };
}

/** Server project → local Project mirror (keeps previously hydrated data). */
function adoptServerProject(sp: orch.ServerProject, previous?: Project): Project {
  const provider: ProviderId = (sp.coordinator?.provider ?? managedProvider()) as ProviderId;
  const model = sp.coordinator?.model ?? managedModel();
  const previousTasks = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const previousMessages = previous?.messages ?? [];
  const project: Project = {
    id: sp.id,
    name: sp.name,
    goal: sp.goal,
    status: sp.status,
    coordinatorProvider: provider,
    coordinatorModel: model,
    mode: sp.mode,
    workspacePath: sp.workspacePath,
    tasks: sp.tasks.map((task) => {
      const old = previousTasks.get(task.id);
      const transcript = old?.transcript ? old.transcript : undefined;
      return {
        id: task.id,
        title: task.title,
        objective: task.objective,
        employeeId: task.employeeId,
        provider,
        model,
        skillIds: task.skillIds ?? [],
        dependsOn: task.dependsOn ?? [],
        permissionTier: task.permissionTier ?? "default",
        status: task.status,
        attempts: task.attempts ?? 0,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        transcript,
        runId: task.runId,
        error: task.error,
      };
    }),
    messages: [...previousMessages],
    createdAt: sp.createdAt,
    updatedAt: sp.updatedAt,
    activeRunId: sp.activeRunId,
    summary: sp.summary ?? previous?.summary,
    managedServer: true,
  };
  // Append any server-side messages we have not mirrored yet.
  const known = new Set(project.messages.map((message) => message.id));
  for (const message of sp.messages) {
    if (!known.has(message.id)) {
      project.messages.push({
        id: message.id,
        role: message.role,
        content: message.content,
        employeeId: message.employeeId,
        taskId: message.taskId,
        createdAt: message.createdAt,
        assets: [],
        activities: [],
      });
    }
  }
  return project;
}

async function refreshManaged(projectId: string): Promise<boolean> {
  const count = (managedPollCounts.get(projectId) ?? 0) + 1;
  managedPollCounts.set(projectId, count);
  // 防失控：超过约 15 分钟仍未结束则停轮询，避免无限刷请求。
  if (count > 1200) { stopManagedPoll(projectId); return false; }
  const sp = await orch.getProject(projectId);
  const index = projects.value.findIndex((item) => item.id === projectId);
  if (!sp || index < 0) { stopManagedPoll(projectId); return false; }

  // Always adopt server truth first. Previously we returned early when
  // `activeRunId` was cleared at finish — local UI stayed stuck on「执行中」.
  const next = adoptServerProject(sp, projects.value[index]);
  projects.value = [...projects.value.slice(0, index), next, ...projects.value.slice(index + 1)];

  for (const task of next.tasks) {
    if (task.status === "completed" && !task.transcript) {
      void hydrateManagedTask(next, task.id);
    } else if (task.status === "failed" && !task.transcript && task.runId) {
      void hydrateManagedTask(next, task.id);
    } else if (task.status === "running" && task.runId) {
      void hydrateManagedTask(next, task.id, { allowRefresh: true });
    } else if (task.status === "running" && /等待审批|approval/i.test(task.error ?? "")) {
      void hydratePendingApprovals(next, task);
    }
  }

  const settled =
    !sp.activeRunId ||
    sp.status === "completed" ||
    sp.status === "failed" ||
    sp.status === "cancelled";
  if (settled) {
    await finishManagedRun(next);
    stopManagedPoll(projectId);
    return false;
  }
  return sp.status === "running";
}

async function hydrateManagedTask(
  project: Project,
  taskId: string,
  options: { allowRefresh?: boolean } = {},
): Promise<void> {
  const key = `${project.id}:${taskId}`;
  if (hydratedKeys.has(key) && !options.allowRefresh) return;
  if (!options.allowRefresh) hydratedKeys.add(key);
  const task = project.tasks.find((item) => item.id === taskId);
  const run = task ? await orch.projectTranscript(project.id, taskId) : null;
  if (!task || !run) {
    if (!options.allowRefresh) hydratedKeys.delete(key);
    return;
  }
  // Running tasks with empty checkpoints stay quiet until progress lands.
  if (run.status === "running" && !run.transcript && !(run.activities?.length) && !(run.artifacts?.length)) {
    return;
  }
  if (!options.allowRefresh) hydratedKeys.add(key);
  else if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    hydratedKeys.add(key);
  }
  task.transcript = serverToTranscript(run);
  task.runId = run.id;
  const existingMsg = project.messages.find(
    (message) => message.taskId === taskId && message.role === "assistant",
  );
  if (existingMsg) {
    // Finalize the live-streamed message with the authoritative transcript.
    existingMsg.content = run.transcript || existingMsg.content;
    existingMsg.activities = task.transcript.activities;
    existingMsg.assets = task.transcript.assets;
  } else {
    project.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      employeeId: task.employeeId,
      taskId,
      content: run.transcript || "(无文本输出)",
      assets: task.transcript.assets,
      activities: task.transcript.activities,
      createdAt: Date.now(),
    });
  }
  if (project.workspacePath && run.id) {
    try {
      await window.opcaiDesktop?.syncProjectWorkspace(project.workspacePath, run.id);
    } catch {
      /* keep going even if folder sync fails */
    }
  }
  projects.value = [...projects.value];
}

async function finishManagedRun(project: Project): Promise<void> {
  const index = projects.value.findIndex((item) => item.id === project.id);
  if (index < 0) return;
  const current = projects.value[index];
  const stop = managedPollers.get(project.id);
  if (stop) {
    clearInterval(stop);
    managedPollers.delete(project.id);
  }
  stopManagedStream(project.id);
  if (!current.summary && (current.status === "completed" || current.status === "failed")) {
    const completed = current.tasks.filter((task) => task.status === "completed").length;
    const failed = current.tasks.filter((task) => task.status === "failed").length;
    current.summary = failed
      ? `项目已结束：${completed} 项任务完成，${failed} 项失败。${current.tasks.find((task) => task.error)?.error ?? ""}`
      : `项目已完成：${completed} 项任务成功。`;
    if (!current.messages.some((message) => message.role === "system" && message.content.startsWith("本轮调度已结束"))) {
      current.messages.push({
        id: crypto.randomUUID(),
        role: "system",
        content: "本轮调度已结束，服务端已完成任务编排。",
        createdAt: Date.now(),
      });
    }
    projects.value = [...projects.value];
  }
}

/* ------------------------------------------------------------------ *
 * Live streaming per-task process info (managed projects).
 *
 * The server publishes run deltas/activities/artifacts on the project topic
 * (`GET /events?project=`). We subscribe while the project is running and
 * mirror them into the local tasks + conversation messages so the member's
 * thinking/activity shows live instead of only after the task settles.
 * The 800ms poll remains the source of truth for task status; this live pass
 * is purely additive (delta text + activity/approval/asset progress).
 * ------------------------------------------------------------------ */
const managedStreams = new Map<string, () => void>();

function stopManagedStream(projectId: string): void {
  const stop = managedStreams.get(projectId);
  if (stop) {
    stop();
    managedStreams.delete(projectId);
  }
}

function startManagedStream(projectId: string): void {
  if (managedStreams.has(projectId)) return;
  const stop = orch.subscribeProjectEvents(projectId, (event) => {
    applyManagedEvent(projectId, event);
  });
  managedStreams.set(projectId, stop);
}

function taskForEvent(project: Project, event: orch.OrcEvent): ProjectTask | undefined {
  return project.tasks.find(
    (task) =>
      (event.taskId && task.id === event.taskId) ||
      (event.runId && task.runId === event.runId),
  );
}

function ensureTaskTranscript(task: ProjectTask): NonNullable<ProjectTask["transcript"]> {
  if (!task.transcript) {
    task.transcript = {
      assistantContent: "",
      activities: [],
      approvals: [],
      assets: [],
      runId: task.runId,
    };
  }
  return task.transcript;
}

function ensureTaskMessage(project: Project, task: ProjectTask): ProjectMessage {
  const existing = project.messages.find(
    (message) => message.taskId === task.id && message.role === "assistant",
  );
  if (existing) return existing;
  const message: ProjectMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    employeeId: task.employeeId,
    taskId: task.id,
    content: "",
    activities: [],
    assets: [],
    createdAt: Date.now(),
  };
  project.messages.push(message);
  return message;
}

function bumpProject(): void {
  projects.value = [...projects.value];
}

function applyManagedEvent(projectId: string, event: orch.OrcEvent): void {
  const project = projects.value.find((item) => item.id === projectId);
  if (!project || project.status !== "running") return;
  const task = taskForEvent(project, event);
  if (!task) return;

  if (event.type === "run.started") {
    // A new attempt is beginning: reset the previous attempt's streamed state so
    // an approval-resumed (or retried) run does not append onto stale content.
    if (task.transcript && (task.transcript.assistantContent || task.transcript.activities.length)) {
      task.transcript.assistantContent = "";
      task.transcript.activities = [];
      task.transcript.approvals = [];
      task.transcript.assets = [];
    }
    const message = project.messages.find((m) => m.taskId === task.id && m.role === "assistant");
    if (message) {
      message.content = "";
      message.activities = [];
      message.approvals = [];
      message.assets = [];
    }
    bumpProject();
  } else if (event.type === "run.delta" && event.text) {
    const transcript = ensureTaskTranscript(task);
    transcript.assistantContent += event.text;
    const message = ensureTaskMessage(project, task);
    message.content += event.text;
    bumpProject();
  } else if (event.type === "run.activity" && event.activity) {
    const transcript = ensureTaskTranscript(task);
    const activity = event.activity;
    const existing = transcript.activities.find(
      (item) => item.toolName === activity.toolName && item.status === "running",
    );
    if (existing && activity.status !== "running") Object.assign(existing, activity);
    else transcript.activities.push({ toolName: activity.toolName, summary: activity.summary, status: activity.status });
    const message = ensureTaskMessage(project, task);
    message.activities = [...transcript.activities];
    bumpProject();
  } else if (event.type === "run.approval" && event.approval) {
    const transcript = ensureTaskTranscript(task);
    const approval = event.approval;
    if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
      transcript.approvals.push({ id: approval.id, skillId: approval.skillId, capability: approval.capability, summary: approval.summary });
    }
    const message = ensureTaskMessage(project, task);
    message.approvals = [...transcript.approvals];
    bumpProject();
  } else if (event.type === "run.artifact" && event.artifact && event.runId) {
    bumpProject();
  } else if (event.type === "project.file.published") {
    fileTreeEpoch.value += 1;
    bumpProject();
  } else if (event.type === "project.task" && event.taskId && event.status) {
    const target = project.tasks.find((task) => task.id === event.taskId);
    if (target && target.status !== event.status) target.status = event.status as ProjectTask["status"];
    bumpProject();
  }
}

const pendingApprovalFetched = new Set<string>();

/** Surface pending approvals for an already-parked task (e.g. after reload). */
async function hydratePendingApprovals(project: Project, task: ProjectTask): Promise<void> {
  if (!task.runId || pendingApprovalFetched.has(task.runId)) return;
  pendingApprovalFetched.add(task.runId);
  const run = await orch.projectTranscript(project.id, task.id).catch(() => null);
  if (!run) return;
  const pending = run.approvals.filter((approval) => approval.status === "pending");
  if (!pending.length) return;
  const transcript = ensureTaskTranscript(task);
  for (const approval of pending) {
    if (!transcript.approvals.some((item) => item.skillId === approval.skillId && item.capability === approval.capability)) {
      transcript.approvals.push({ id: approval.id, skillId: approval.skillId, capability: approval.capability, summary: approval.summary });
    }
  }
  const message = ensureTaskMessage(project, task);
  message.approvals = [...transcript.approvals];
  bumpProject();
}

async function loadManagedProjects(): Promise<void> {
  const server = await orch.listProjects().catch(() => [] as orch.ServerProject[]);
  if (!server.length) return;
  const byId = new Map(projects.value.map((project) => [project.id, project]));
  const next = [...projects.value];
  const seen = new Set<string>();
  for (const sp of server) {
    seen.add(sp.id);
    const existingIndex = next.findIndex((item) => item.id === sp.id);
    const adopted = adoptServerProject(sp, existingIndex >= 0 ? next[existingIndex] : undefined);
    if (existingIndex >= 0) next[existingIndex] = adopted;
    else next.unshift(adopted);
    if (sp.status === "running") {
      managedPollers.set(
        sp.id,
        setInterval(() => void refreshManaged(sp.id), 800),
      );
      startManagedStream(sp.id);
    }
  }
  projects.value = next.filter((project) => !project.managedServer || seen.has(project.id));
}

async function runManagedProject(project: Project): Promise<void> {
  error.value = "";
  try {
    await orch.confirmProject(project.id);
    await refreshManaged(project.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "服务端编排启动失败。";
    // 启动失败仍为草稿：允许下次进入对话时再次自动尝试。
    autoStartedDrafts.delete(project.id);
    return;
  }
  const existing = managedPollers.get(project.id);
  if (existing) clearInterval(existing);
  managedPollers.set(
    project.id,
    setInterval(() => void refreshManaged(project.id), 3000),
  );
  startManagedStream(project.id);
}

async function cancelManagedProject(project: Project): Promise<void> {
  try {
    await orch.cancelProject(project.id);
  } catch {
    /* the poll will reflect server truth */
  }
  await refreshManaged(project.id);
}

async function resolveManagedApproval(input: { taskId: string; approvalId: string; allow: boolean; scope: "session" | "always" }): Promise<void> {
  const project = selected.value;
  if (!project || !project.managedServer) return;
  try {
    await orch.resolveTaskApproval({
      projectId: project.id,
      taskId: input.taskId,
      approvalId: input.approvalId,
      allow: input.allow,
      scope: input.scope,
    });
  } catch {
    /* surface via refresh below */
  }
  // Drop the resolved approval from the local mirror so the card disappears.
  const task = project.tasks.find((item) => item.id === input.taskId);
  if (task?.transcript) task.transcript.approvals = task.transcript.approvals.filter((item) => item.id !== input.approvalId);
  const message = project.messages.find((m) => m.taskId === input.taskId);
  if (message?.approvals) message.approvals = message.approvals.filter((item) => item.id !== input.approvalId);
  projects.value = [...projects.value];
  await refreshManaged(project.id);
}

async function deleteProject(project: Project | null): Promise<void> {
  if (!project) return;
  if (project.managedServer) {
    const stop = managedPollers.get(project.id);
    if (stop) {
      clearInterval(stop);
      managedPollers.delete(project.id);
    }
    stopManagedStream(project.id);
    await orch.deleteProject(project.id).catch(() => undefined);
  }
  await remove(project.id);
}

const tab = ref<"projects" | "runs">("projects");
const selectedId = ref<string | null>(null);
/** Bumped when agents publish files into the shared project workspace. */
const fileTreeEpoch = ref(0);
const creating = ref(false);
const createStep = ref<1 | 2 | 3>(1);
const planning = ref(false);
const error = ref("");
const name = ref("");
const goal = ref("");
const mode = ref<ProjectMode>("parallel");
const coordinatorId = ref<string>(props.models[0]?.id ?? "");
const coordinator = computed(
  () => props.models.find((item) => item.id === coordinatorId.value) ?? props.models[0] ?? null,
);
const workspaceParent = ref("");
const draftTasks = ref<ProjectTaskInput[]>([]);
const detailTaskId = ref<string | null>(null);
const cancelling = new Set<string>();
const selected = computed(
  () => projects.value.find((item) => item.id === selectedId.value) ?? null,
);
const detailTask = computed(
  () =>
    selected.value?.tasks.find((task) => task.id === detailTaskId.value) ??
    selected.value?.tasks.find((task) => task.status === "running") ??
    selected.value?.tasks[0] ??
    null,
);
const templates: Array<{
  id: ProjectMode;
  icon: string;
  name: string;
  description: string;
  hint: string;
  tasks: ProjectTaskInput[];
}> = [
  {
    id: "waterfall",
    icon: "→",
    name: "瀑布项目",
    description: "按明确先后顺序交接，适合调研、方案、交付的线性流程。",
    hint: "研究 → 方案 → 验证",
    tasks: [
      {
        title: "需求与资料研究",
        objective: "梳理目标、约束、关键事实与验收标准。",
        employeeId: "research",
        skillIds: [],
      },
      {
        title: "制定解决方案",
        objective: "基于研究结论形成可执行的方案与交付物。",
        employeeId: "general",
        skillIds: [],
        dependsOn: [0],
      },
      {
        title: "质量验证",
        objective: "检查方案完整性、风险与交付质量。",
        employeeId: "code",
        skillIds: [],
        dependsOn: [1],
      },
    ],
  },
  {
    id: "parallel",
    icon: "⇄",
    name: "并发项目",
    description: "多个相互独立的子任务同时运行，最后由协调员汇总。",
    hint: "多员工并发 → 汇总",
    tasks: [
      {
        title: "信息与事实分析",
        objective: "独立分析目标中的信息、约束和机会。",
        employeeId: "research",
        skillIds: [],
      },
      {
        title: "方案设计",
        objective: "独立提出可执行方案和交付建议。",
        employeeId: "general",
        skillIds: [],
      },
      {
        title: "技术与风险审查",
        objective: "独立评估技术可行性、风险和验证方式。",
        employeeId: "code",
        skillIds: [],
      },
    ],
  },
  {
    id: "discussion",
    icon: "◎",
    name: "讨论项目",
    description: "不同员工先提出视角，再由主持员工整合观点并达成结论。",
    hint: "多视角 → 主持整合",
    tasks: [
      {
        title: "研究视角",
        objective: "从事实、用户需求和证据角度提出观点与建议。",
        employeeId: "research",
        skillIds: [],
      },
      {
        title: "实施视角",
        objective: "从执行、成本和可行性角度提出观点与建议。",
        employeeId: "code",
        skillIds: [],
      },
      {
        title: "主持人整合",
        objective: "比较各方观点，明确共识、分歧、决策及后续行动。",
        employeeId: "administrator",
        skillIds: [],
        dependsOn: [0, 1],
      },
    ],
  },
  {
    id: "dag",
    icon: "◇",
    name: "DAG 项目",
    description: "有向无环图：每个任务只在其前置结果准备好后运行。",
    hint: "并发分支 → 汇合 → 审核",
    tasks: [
      {
        title: "业务调研",
        objective: "收集业务需求、事实和成功指标。",
        employeeId: "research",
        skillIds: [],
      },
      {
        title: "技术探索",
        objective: "评估技术路径、工具和实现风险。",
        employeeId: "code",
        skillIds: [],
      },
      {
        title: "整合方案",
        objective: "基于前两项结果制定统一实施方案。",
        employeeId: "general",
        skillIds: [],
        dependsOn: [0, 1],
      },
      {
        title: "最终评审",
        objective: "审核完整方案、风险和交付质量。",
        employeeId: "administrator",
        skillIds: [],
        dependsOn: [2],
      },
    ],
  },
];
const template = computed(
  () => templates.find((item) => item.id === mode.value) ?? templates[1],
);
const { modelForEmployee } = useModelConfig();
const modelLabel = (model: ProviderConfig) =>
  `${model.providerLabel || model.provider} · ${model.chatModel}`;
function employeeName(id: EmployeeId) {
  const employee = props.employees.find((item) => item.id === id);
  return employeeDisplayName(employee, (key) => ({
    'employee.general.name': '通用助理',
    'employee.research.name': '研究助理',
    'employee.code.name': '编程助理',
    'employee.administrator.name': '系统管理员',
  } as Record<string, string>)[key] || key) || id;
}
function modelFor(task: ProjectTask) {
  const byTask =
    props.models.find(
      (item) =>
        item.provider === task.provider && item.chatModel === task.model,
    ) ??
    props.models.find((item) => item.provider === task.provider) ??
    null;
  return modelForEmployee(task.employeeId, byTask) ?? byTask ?? props.models[0] ?? null;
}
function statusStyle(status: string) {
  return (
    (
      {
        draft: "bg-slate-500/10 text-slate-600",
        queued: "bg-slate-500/10 text-slate-600",
        running: "bg-blue-500/10 text-blue-600",
        completed: "bg-emerald-500/10 text-emerald-600",
        failed: "bg-rose-500/10 text-rose-600",
        cancelled: "bg-amber-500/10 text-amber-700",
      } as Record<string, string>
    )[status] ?? "bg-slate-500/10"
  );
}
function statusText(status: string) {
  return (
    (
      {
        draft: "待确认",
        queued: "等待",
        running: "执行中",
        completed: "完成",
        failed: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] ?? status
  );
}
function date(value?: number) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value)
    : "—";
}
function chooseTemplate(next: ProjectMode) {
  mode.value = next;
  draftTasks.value = templateTasks(next);
}
function templateTasks(next = mode.value) {
  return (templates.find((item) => item.id === next) ?? templates[1]).tasks.map(
    (task) => ({
      ...task,
      skillIds: [...task.skillIds],
      dependsOn: task.dependsOn ? [...task.dependsOn] : [],
    }),
  );
}
function openCreate() {
  creating.value = true;
  createStep.value = 1;
  error.value = "";
  name.value = "";
  goal.value = "";
  mode.value = "parallel";
  draftTasks.value = templateTasks();
  coordinatorId.value = props.models[0]?.id ?? "";
  workspaceParent.value = "";
}
function closeCreate() {
  creating.value = false;
  createStep.value = 1;
  error.value = "";
}
async function continueCreate() {
  // 名称可选；描述与协调员模型必填。规划成功进入「确认运行」步骤。
  if (!goal.value.trim() || !coordinator.value) {
    error.value = "请填写项目描述并选择协调员模型。";
    return;
  }
  if (planning.value) return;
  await generateTasks();
  if (!error.value && draftTasks.value.length) createStep.value = 3;
}
function addProjectMessage(project: Project, message: ProjectMessage) {
  project.messages.push(message);
  void update(project);
}
async function generateTasks() {
  if (!goal.value.trim() || !coordinator.value) {
    error.value = "请先填写目标并选择协调员模型。";
    return;
  }
  planning.value = true;
  error.value = "";
  try {
    const generated = await props.generateDraft(goal.value, coordinator.value);
    draftTasks.value = generated.map((task, index) => ({
      ...task,
      dependsOn:
        template.value.tasks[index]?.dependsOn ??
        (mode.value === "waterfall" && index ? [index - 1] : []),
    }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "生成任务草案失败。";
  } finally {
    planning.value = false;
  }
}
async function confirmCreate() {
  if (
    !coordinator.value ||
    !goal.value.trim() ||
    !draftTasks.value.length ||
    draftTasks.value.some(
      (task) => !task.title.trim() || !task.objective.trim(),
    )
  ) {
    error.value = "请完善项目目标和所有任务。";
    return;
  }
  const workspacePath = await window.opcaiDesktop?.createProjectWorkspace({
    name: name.value,
    parentDirectory: workspaceParent.value || undefined,
  });
  if (!workspacePath) {
    error.value = "无法创建项目空间目录。";
    return;
  }
  // M0: new projects are created on the orchestration server; the page
  // mirrors server state (scheduling/persistence live server-side).
  const serverProject = await orch.createProject({
    name: name.value,
    goal: goal.value,
    mode: mode.value,
    workspacePath,
    coordinator: {
      provider: coordinator.value.provider,
      model: coordinator.value.chatModel,
    },
    tasks: draftTasks.value.map((task) => ({
      title: task.title,
      objective: task.objective,
      employeeId: task.employeeId,
      skillIds: task.skillIds ?? [],
    })),
  });
  const adopted = adoptServerProject(serverProject);
  projects.value = [adopted, ...projects.value];
  selectedId.value = adopted.id;
  detailTaskId.value = adopted.tasks[0]?.id ?? null;
  closeCreate();
  autoStartIfDraft(adopted);
}
async function chooseWorkspaceParent() {
  const selected = await window.opcaiDesktop?.pickProjectDirectory();
  if (selected) workspaceParent.value = selected;
}
const autoStartedDrafts = new Set<string>();
/** 进入项目对话即自动启动（仅草稿项目触发一次；状态离开 draft 后允许再次进入时重试）。 */
function autoStartIfDraft(project: Project | null | undefined) {
  if (!project || project.status !== "draft") return;
  if (autoStartedDrafts.has(project.id)) return;
  autoStartedDrafts.add(project.id);
  void run(project);
}

function openProject(project: Project) {
  selectedId.value = project.id;
  detailTaskId.value =
    project.tasks.find((task) => task.status === "running")?.id ??
    project.tasks[0]?.id ??
    null;
  autoStartIfDraft(project);
  // Re-sync managed projects so a finished server status is not stuck as「执行中」.
  if (project.managedServer) void refreshManaged(project.id);
}
function updateTask(task: ProjectTask, patch: Partial<ProjectTask>) {
  Object.assign(task, patch);
  if (selected.value) void update(selected.value);
}
function toggleSkill(task: ProjectTask, id: string) {
  updateTask(task, {
    skillIds: task.skillIds.includes(id)
      ? task.skillIds.filter((item) => item !== id)
      : [...task.skillIds, id],
  });
}
function isCancelled(project: Project) {
  return cancelling.has(project.id);
}
function cancel(project: Project) {
  if (project.managedServer) {
    void cancelManagedProject(project);
    return;
  }
  cancelling.add(project.id);
  project.tasks
    .filter((task) => task.status === "queued")
    .forEach((task) => {
      task.status = "cancelled";
    });
  void update(project);
}
function dependencyContext(project: Project, task: ProjectTask) {
  const parents = project.tasks.filter((item) =>
    task.dependsOn.includes(item.id),
  );
  if (!parents.length) return "";
  return `\n\n前置任务结果（请以此为依据继续，不重复无关工作）：\n${parents.map((item) => `### ${item.title}\n${item.transcript?.assistantContent ?? "无可用结果"}`).join("\n\n")}`;
}
async function executeTask(project: Project, task: ProjectTask) {
  const model = modelFor(task);
  if (!model) {
    updateTask(task, {
      status: "failed",
      error: "该任务选择的模型未配置。",
      finishedAt: Date.now(),
    });
    return;
  }
  updateTask(task, {
    status: "running",
    startedAt: Date.now(),
    attempts: task.attempts + 1,
    error: undefined,
    transcript: {
      assistantContent: "",
      activities: [],
      approvals: [],
      assets: [],
    },
  });
  const message: ProjectMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    employeeId: task.employeeId,
    taskId: task.id,
    content: "",
    activities: [],
    assets: [],
    createdAt: Date.now(),
  };
  project.messages.push(message);
  void update(project);
  detailTaskId.value ??= task.id;
  try {
    const transcript = await props.runTask(
      {
        projectId: project.id,
        taskId: task.id,
        prompt: `项目模式：${template.value.name}\n项目目标：${project.goal}\n\n当前任务：${task.objective}${dependencyContext(project, task)}\n\n请给出结构化结果：结论、关键依据、交付物/资产、风险与下一步。`,
        employeeId: task.employeeId,
        skillIds: task.skillIds,
        permissionTier: task.permissionTier,
        model,
        workspacePath: project.workspacePath,
      },
      (activity) => {
        const current = task.transcript!;
        const existing = current.activities.find(
          (item) =>
            item.toolName === activity.toolName && item.status === "running",
        );
        if (existing && activity.status !== "running")
          Object.assign(existing, activity);
        else current.activities.push(activity);
        message.activities = current.activities;
        void update(project);
      },
      (delta) => {
        task.transcript!.assistantContent += delta;
        message.content += delta;
        void update(project);
      },
    );
    updateTask(task, {
      status: "completed",
      transcript,
      finishedAt: Date.now(),
    });
    if (project.workspacePath) {
      const runIds = [...new Set([transcript.runId, ...transcript.assets.map((asset) => asset.runId)].filter((id): id is string => Boolean(id)))];
      for (const runId of runIds) await window.opcaiDesktop?.syncProjectWorkspace(project.workspacePath, runId);
      if (!runIds.length && transcript.assets.length) {
        await window.opcaiDesktop?.materializeProjectAssets?.(project.workspacePath, transcript.assets.map((asset) => asset.id));
      }
    }
    message.content = transcript.assistantContent;
    message.activities = transcript.activities;
    message.assets = transcript.assets;
    void update(project);
  } catch (cause) {
    updateTask(task, {
      status: "failed",
      error: cause instanceof Error ? cause.message : "任务执行失败",
      finishedAt: Date.now(),
    });
    message.content ||= `任务未完成：${task.error ?? "执行发生异常。"}`;
    void update(project);
  }
}
async function run(project: Project) {
  if (project.managedServer) {
    await runManagedProject(project);
    return;
  }
  if (project.status === "running") return;
  error.value = "";
  const record = await createRun(project);
  try {
    while (!isCancelled(project)) {
      const pending = project.tasks.filter(
        (task) =>
          task.status === "queued" ||
          task.status === "draft" ||
          task.status === "failed",
      );
      if (!pending.length) break;
      const ready = pending.filter((task) =>
        task.dependsOn.every(
          (id) =>
            project.tasks.find((item) => item.id === id)?.status ===
            "completed",
        ),
      );
      const blocked = pending.filter((task) =>
        task.dependsOn.some((id) =>
          ["failed", "cancelled"].includes(
            project.tasks.find((item) => item.id === id)?.status ?? "failed",
          ),
        ),
      );
      blocked.forEach((task) =>
        updateTask(task, {
          status: "cancelled",
          error: "前置任务未成功完成。",
        }),
      );
      if (!ready.length) {
        if (!blocked.length)
          pending.forEach((task) =>
            updateTask(task, {
              status: "failed",
              error: "任务依赖存在循环或无效引用。",
            }),
          );
        continue;
      }
      await Promise.all(ready.map((task) => executeTask(project, task)));
    }
    if (isCancelled(project)) {
      cancelling.delete(project.id);
      await finishRun(project, record, "cancelled");
      return;
    }
    const done = project.tasks.filter((task) => task.status === "completed");
    const aggregator =
      coordinator.value ?? modelFor(done[0] ?? project.tasks[0]);
    if (!aggregator) throw new Error("没有可用协调员模型。");
    const evidence = done
      .map(
        (task) =>
          `### ${task.title}（${employeeName(task.employeeId)}）\n${task.transcript?.assistantContent ?? ""}`,
      )
      .join("\n\n");
    const synthesis = await props.runTask({
      projectId: project.id,
      taskId: `summary-${record.id}`,
      prompt: `你是项目协调员。仅依据以下子任务结果，输出项目完成情况、合并结论、资产清单、遗留风险与下一步。不要虚构信息。\n\n项目目标：${project.goal}\n\n${evidence}`,
      employeeId: "administrator",
      skillIds: [],
      permissionTier: "read-only",
      model: aggregator,
      workspacePath: project.workspacePath,
    });
    project.summary = synthesis.assistantContent;
    addProjectMessage(project, {
      id: crypto.randomUUID(),
      role: "system",
      content: "本轮调度已结束，协调员已生成项目汇总。",
      createdAt: Date.now(),
      assets: synthesis.assets,
    });
    await finishRun(
      project,
      record,
      project.tasks.some((task) => task.status === "failed")
        ? "failed"
        : "completed",
      synthesis.assistantContent,
    );
  } catch (cause) {
    await finishRun(
      project,
      record,
      "failed",
      undefined,
      cause instanceof Error ? cause.message : "项目运行失败",
    );
  }
}
function downstreamTasks(project: Project, taskId: string) {
  const affected = new Set<string>();
  const visit = (parentId: string) =>
    project.tasks
      .filter((task) => task.dependsOn.includes(parentId))
      .forEach((task) => {
        if (affected.has(task.id)) return;
        affected.add(task.id);
        visit(task.id);
      });
  visit(taskId);
  return project.tasks.filter((task) => affected.has(task.id));
}
async function dispatchProjectInstruction(
  project: Project,
  input: { employeeId: EmployeeId; content: string },
) {
  if (project.status === "running") return;
  if (project.managedServer) {
    error.value = "服务端托管的项目暂不支持对话式追加指令；请使用任务重试或新建项目。";
    return;
  }
  addProjectMessage(project, {
    id: crypto.randomUUID(),
    role: "user",
    content: `@${employeeName(input.employeeId)} ${input.content}`,
    employeeId: input.employeeId,
    createdAt: Date.now(),
  });
  const target =
    [...project.tasks]
      .reverse()
      .find((task) => task.employeeId === input.employeeId) ??
    project.tasks.find((task) => task.employeeId === input.employeeId);
  if (!target) return;
  target.objective = `${target.objective}\n\n本轮项目指令：${input.content}`;
  target.status = "draft";
  target.error = undefined;
  target.transcript = undefined;
  const downstream = downstreamTasks(project, target.id);
  downstream.forEach((task) => {
    task.status = "draft";
    task.error = undefined;
    task.transcript = undefined;
  });
  addProjectMessage(project, {
    id: crypto.randomUUID(),
    role: "system",
    content: downstream.length
      ? `调度器已将指令交给${employeeName(input.employeeId)}，并标记 ${downstream.length} 个下游任务将在前置结果更新后跟进。`
      : `调度器已将指令交给${employeeName(input.employeeId)}；该任务没有下游依赖。`,
    createdAt: Date.now(),
  });
  await update(project);
  await run(project);
}
onMounted(async () => {
  await Promise.all([load(), loadSkills()]);
  await loadManagedProjects();
  const focusId = await readStored("projects.focus-id");
  if (focusId && projects.value.some((project) => project.id === focusId)) {
    selectedId.value = focusId;
    await writeStored("projects.focus-id", "");
    autoStartIfDraft(projects.value.find((project) => project.id === focusId));
  }
});

onBeforeUnmount(() => {
  for (const id of [...managedStreams.keys()]) stopManagedStream(id);
  for (const timer of managedPollers.values()) clearInterval(timer);
  managedPollers.clear();
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      :class="['mx-auto flex h-full min-h-0 w-full flex-col', selected ? 'max-w-none p-0' : 'max-w-7xl px-6 py-9 sm:px-12']"
    >
      <header v-if="!selected" class="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OPCAI / PROJECT ORCHESTRATION</p>
          <h1 class="mt-2 text-4xl font-bold tracking-[-.045em]">项目</h1>
          <p class="mt-3 text-[var(--muted)]">把复杂目标交给多个数字员工：先确认编排，再让任务在隔离上下文中可靠运行。</p>
        </div>
        <button class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" @click="openCreate">＋ 新建项目</button>
      </header>

      <div v-if="!selected" class="mt-6 inline-flex w-fit rounded-xl bg-[var(--surface-muted)] p-1">
        <button :class="['rounded-lg px-4 py-2 text-sm font-semibold', tab === 'projects' ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)]']" @click="tab = 'projects'; selectedId = null;">项目</button>
        <button :class="['rounded-lg px-4 py-2 text-sm font-semibold', tab === 'runs' ? 'bg-[var(--surface)] shadow-sm' : 'text-[var(--muted)]']" @click="tab = 'runs'">运行记录 <span class="ml-1 rounded bg-[var(--surface)] px-1.5 text-xs">{{ runs.length }}</span></button>
      </div>

      <div :class="[selected ? 'min-h-0 flex-1 overflow-hidden flex flex-col' : 'mt-6 min-h-0 flex-1 overflow-y-auto pr-1']">
        <!-- 新建项目向导：①选模板 → ②信息与规划 → ③确认运行 -->
        <section v-if="creating" class="rounded-2xl border border-[var(--accent)]/30 bg-[var(--surface)] shadow-sm">
          <div class="flex items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5">
            <div class="min-w-0">
              <p class="text-[10px] font-bold tracking-[0.14em] text-[var(--accent)]">CREATE · PLAN · RUN</p>
              <h2 class="mt-1 text-xl font-bold tracking-tight">
                {{ createStep === 1 ? '选择项目类型' : createStep === 2 ? '填写信息并规划' : '确认执行方案' }}
              </h2>
              <p class="mt-1 text-sm text-[var(--muted)]">
                {{ createStep === 1 ? '先选协作模式，再填写目标与协调员模型。' : createStep === 2 ? '描述目标后，用协调员模型生成可编辑任务草案。' : '核对任务分工，确认后进入项目对话工作台由服务端调度。' }}
              </p>
            </div>
            <button class="shrink-0 rounded-lg px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]" type="button" @click="closeCreate">关闭</button>
          </div>
          <div class="p-6">
            <ol class="mb-7 flex items-center gap-2 text-xs font-semibold">
              <template v-for="step in [1, 2, 3]" :key="step">
                <span :class="['grid h-6 w-6 place-items-center rounded-full', createStep >= step ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)]']">{{ step }}</span>
                <span :class="createStep >= step ? 'text-[var(--text)]' : 'text-[var(--muted)]'">{{ step === 1 ? '选模板' : step === 2 ? '信息与规划' : '确认方案' }}</span>
                <i v-if="step < 3" class="h-px w-8 bg-[var(--border)]" />
              </template>
            </ol>

            <!-- ① 模板 -->
            <div v-if="createStep === 1">
              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <button
                  v-for="item in templates"
                  :key="item.id"
                  :class="['rounded-2xl border p-4 text-left transition', mode === item.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm' : 'border-[var(--border)] hover:border-[var(--accent)]/50']"
                  @click="chooseTemplate(item.id)"
                >
                  <span class="grid h-9 w-9 place-items-center rounded-xl bg-[var(--surface-muted)] text-lg font-bold">{{ item.icon }}</span>
                  <strong class="mt-4 block">{{ item.name }}</strong>
                  <p class="mt-1 min-h-10 text-xs leading-relaxed text-[var(--muted)]">{{ item.description }}</p>
                  <span class="mt-3 inline-block text-[11px] font-semibold text-[var(--accent)]">{{ item.hint }}</span>
                </button>
              </div>
              <p class="mt-4 text-xs text-[var(--muted)]">选择项目类型模板后，下一步填写项目名称 / 描述、工作目录，并生成执行草案。</p>
              <div class="mt-6 flex items-center justify-between">
                <button class="text-sm text-[var(--muted)]" @click="closeCreate">取消</button>
                <button class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white" @click="createStep = 2">下一步：项目信息</button>
              </div>
            </div>

            <p v-if="error" class="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ error }}</p>

            <!-- ② 信息与规划：名称 → 描述 → 目录 → 底部操作 -->
            <div v-if="createStep === 2" class="space-y-5">
              <label class="block text-sm font-semibold">
                项目名称
                <span class="ml-1 font-normal text-[var(--muted)]">（可选）</span>
                <input
                  v-model="name"
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-normal outline-none transition focus:border-[var(--accent)]"
                  placeholder="例如：计生用品官方网站"
                />
              </label>

              <label class="block text-sm font-semibold">
                项目描述
                <textarea
                  v-model="goal"
                  class="mt-2 min-h-36 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-normal outline-none transition focus:border-[var(--accent)]"
                  placeholder="描述最终目标、边界、对象和期望产出。协调员会据此生成可编辑的任务草案…"
                />
              </label>

              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 px-3.5 py-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-[11px] font-bold tracking-wide text-[var(--muted)]">项目空间</p>
                    <p class="mt-1 break-all text-xs leading-5 text-[var(--text)]">
                      {{ workspaceParent || '默认保存到 ~/.opcai/projects/项目名称-随机标识' }}
                    </p>
                  </div>
                  <button
                    class="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--accent)]/50"
                    type="button"
                    @click="chooseWorkspaceParent"
                  >
                    {{ workspaceParent ? '更换' : '选择目录' }}
                  </button>
                </div>
                <p class="mt-2 text-[11px] text-[var(--muted)]">当前模板：{{ template.name }} · 交付物将写入该目录</p>
              </div>

              <div class="flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-end sm:justify-between">
                <button
                  class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--text)]"
                  type="button"
                  @click="createStep = 1"
                >
                  ← 返回上一步
                </button>

                <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end sm:gap-2.5">
                  <label class="block w-full sm:w-[min(100%,300px)]">
                    <span class="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">
                      协调员模型
                    </span>
                    <select
                      v-model="coordinatorId"
                      class="h-11 w-full truncate rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:border-[var(--accent)]"
                      :disabled="!models.length || planning"
                    >
                      <option v-if="!models.length" disabled value="">请先在设置中配置模型</option>
                      <option v-for="model in models" :key="model.id" :value="model.id">
                        {{ modelLabel(model) }}
                      </option>
                    </select>
                  </label>
                  <button
                    class="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--accent)] px-6 text-sm font-semibold tracking-wide text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                    type="button"
                    :disabled="planning || !coordinator || !goal.trim()"
                    @click="continueCreate"
                  >
                    <span v-if="planning" class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
                    {{ planning ? '正在规划…' : '进行规划' }}
                  </button>
                </div>
              </div>
            </div>

            <!-- ③ 确认运行（可编辑） -->
            <div v-if="createStep === 3" class="space-y-5">
              <div class="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 class="font-bold">执行方案</h3>
                  <p class="mt-1 text-xs text-[var(--muted)]">可编辑标题、目标与负责员工；确认后进入项目对话工作台。</p>
                </div>
                <button
                  class="rounded-lg border border-dashed border-[var(--accent)]/50 px-3 py-1.5 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  type="button"
                  @click="draftTasks.push({ title: '新任务', objective: '', employeeId: 'general', skillIds: [] })"
                >
                  ＋ 添加任务
                </button>
              </div>

              <div class="space-y-2">
                <article
                  v-for="(task, index) in draftTasks"
                  :key="index"
                  class="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)]/40 p-3 md:grid-cols-[.9fr_1.7fr_150px_auto]"
                >
                  <input v-model="task.title" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="任务标题" />
                  <input v-model="task.objective" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]" placeholder="任务目标" />
                  <select v-model="task.employeeId" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm outline-none focus:border-[var(--accent)]">
                    <option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employeeName(employee.id) }}</option>
                  </select>
                  <button class="rounded-lg px-2 py-2 text-sm text-rose-600 hover:bg-rose-50" type="button" @click="draftTasks.splice(index, 1)">删除</button>
                </article>
              </div>

              <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-4 text-sm">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <p><strong>项目：</strong>{{ name || '（未命名）' }}</p>
                  <p class="text-xs text-[var(--muted)]">{{ draftTasks.length }} 项任务</p>
                  <p v-if="coordinator" class="text-xs text-[var(--muted)]">
                    协调员 · {{ modelLabel(coordinator) }}
                  </p>
                </div>
                <p class="mt-2 text-[var(--muted)]">{{ goal }}</p>
              </div>

              <div class="flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)]" type="button" @click="createStep = 2">
                  ← 返回修改描述
                </button>
                <button
                  class="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-45"
                  type="button"
                  :disabled="!draftTasks.length"
                  @click="confirmCreate"
                >
                  确认并进入对话工作台
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 项目列表（未选择时） -->
        <section v-else-if="tab === 'projects' && !selected" class="grid gap-5">
          <template v-if="projects.length">
            <div class="grid gap-4 md:grid-cols-2">
              <button
                v-for="project in projects"
                :key="project.id"
                class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left hover:border-[var(--accent)]/60"
                @click="openProject(project)"
              >
                <div class="flex justify-between gap-3">
                  <span class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-bold text-[var(--accent)]">{{ templates.find((item) => item.id === project.mode)?.name }}</span>
                  <span :class="['rounded-full px-2 py-1 text-[10px] font-bold', statusStyle(project.status)]">{{ statusText(project.status) }}</span>
                </div>
                <h2 class="mt-4 text-lg font-bold">{{ project.name }}</h2>
                <p class="mt-2 line-clamp-2 text-sm text-[var(--muted)]">{{ project.goal }}</p>
                <p class="mt-5 text-xs text-[var(--muted)]">{{ project.tasks.length }} 个任务 · 更新于 {{ date(project.updatedAt) }}</p>
              </button>
            </div>
          </template>
          <div v-else class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-14 text-center">
            <h2 class="text-xl font-bold">选择一种项目编排方式</h2>
            <p class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[var(--muted)]">瀑布、并发、讨论与 DAG 都从模板开始；在运行前可确认并调整任务草案。</p>
            <button class="mt-6 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white" @click="openCreate">创建第一个项目</button>
          </div>
          <div>
            <h2 class="text-lg font-bold">项目模板</h2>
            <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <button v-for="item in templates" :key="item.id" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:border-[var(--accent)]" @click="openCreate(); chooseTemplate(item.id)">
                <span class="text-lg font-bold text-[var(--accent)]">{{ item.icon }}</span>
                <strong class="mt-3 block">{{ item.name }}</strong>
                <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">{{ item.description }}</p>
                <span class="mt-3 inline-block text-[11px] font-semibold text-[var(--accent)]">{{ item.hint }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 项目对话工作台（已选择） -->
        <section v-else-if="tab === 'projects' && selected" class="min-h-0 flex-1 flex flex-col">
          <ProjectConversationWorkspace
            :project="selected!"
            :employees="employees"
            :template-name="templates.find((item) => item.id === selected?.mode)?.name ?? '项目'"
            :running="selected?.status === 'running'"
            :file-tree-epoch="fileTreeEpoch"
            @back="selectedId = null"
            @start="run(selected!)"
            @cancel="cancel(selected!)"
            @remove="deleteProject(selected!); selectedId = null;"
            @dispatch="dispatchProjectInstruction(selected!, $event)"
          />
        </section>

        <!-- 运行记录 -->
        <section v-else-if="tab === 'runs'" class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div v-if="!runs.length" class="p-14 text-center text-sm text-[var(--muted)]">尚无项目运行记录。</div>
          <button v-for="item in runs" :key="item.id" class="flex w-full items-center justify-between border-b border-[var(--border)] px-5 py-4 text-left last:border-0">
            <span>
              <strong>{{ projects.find((project) => project.id === item.projectId)?.name ?? '已删除项目' }}</strong>
              <span class="ml-3 text-xs text-[var(--muted)]">{{ statusText(item.status) }}</span>
              <span class="ml-3 text-xs text-[var(--muted)]">{{ item.taskIds.length }} 项任务</span>
            </span>
            <span class="text-xs text-[var(--muted)]">{{ date(item.finishedAt ?? item.startedAt) }}</span>
          </button>
        </section>
      </div>
    </div>
  </section>
</template>
