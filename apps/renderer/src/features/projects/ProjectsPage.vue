<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
      permissionTier: "read-only" | "default" | "extended" | "full";
      model: ProviderConfig;
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
const tab = ref<"projects" | "runs">("projects");
const selectedId = ref<string | null>(null);
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
  if (!name.value.trim() || !goal.value.trim() || !coordinator.value) {
    error.value = "请填写项目名称、需求并选择协调员模型。";
    return;
  }
  await generateTasks();
  if (!error.value) createStep.value = 2;
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
  const project = await createDraft({
    name: name.value,
    goal: goal.value,
    provider: coordinator.value.provider,
    model: coordinator.value.chatModel,
    mode: mode.value,
    tasks: draftTasks.value,
    workspacePath,
  });
  selectedId.value = project.id;
  detailTaskId.value = project.tasks[0]?.id ?? null;
  closeCreate();
}
async function chooseWorkspaceParent() {
  const selected = await window.opcaiDesktop?.pickProjectDirectory();
  if (selected) workspaceParent.value = selected;
}
function openProject(project: Project) {
  selectedId.value = project.id;
  detailTaskId.value =
    project.tasks.find((task) => task.status === "running")?.id ??
    project.tasks[0]?.id ??
    null;
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
  const focusId = await readStored("projects.focus-id");
  if (focusId && projects.value.some((project) => project.id === focusId)) {
    selectedId.value = focusId;
    await writeStored("projects.focus-id", "");
  }
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      :class="['mx-auto flex h-full min-h-0 w-full flex-col', selected ? 'max-w-none p-0' : 'max-w-7xl px-6 py-9 sm:px-12']"
    >
      <header v-if="!selected" class="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <p
            class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]"
          >
            OPCAI / PROJECT ORCHESTRATION
          </p>
          <h1 class="mt-2 text-4xl font-bold tracking-[-.045em]">项目</h1>
          <p class="mt-3 text-[var(--muted)]">
            把复杂目标交给多个数字员工：先确认编排，再让任务在隔离上下文中可靠运行。
          </p>
        </div>
        <button
          class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white"
          @click="openCreate"
        >
          ＋ 新建项目
        </button>
      </header>
      <div v-if="!selected"
        class="mt-6 inline-flex w-fit rounded-xl bg-[var(--surface-muted)] p-1"
      >
        <button
          :class="[
            'rounded-lg px-4 py-2 text-sm font-semibold',
            tab === 'projects'
              ? 'bg-[var(--surface)] shadow-sm'
              : 'text-[var(--muted)]',
          ]"
          @click="
            tab = 'projects';
            selectedId = null;
          "
        >
          项目</button
        ><button
          :class="[
            'rounded-lg px-4 py-2 text-sm font-semibold',
            tab === 'runs'
              ? 'bg-[var(--surface)] shadow-sm'
              : 'text-[var(--muted)]',
          ]"
          @click="tab = 'runs'"
        >
          运行记录
          <span class="ml-1 rounded bg-[var(--surface)] px-1.5 text-xs">{{
            runs.length
          }}</span>
        </button>
      </div>
      <div :class="[selected ? 'min-h-0 flex-1 overflow-hidden' : 'mt-6 min-h-0 flex-1 overflow-y-auto pr-1']">
        <section
          v-if="creating"
          class="rounded-2xl border border-[var(--accent)]/30 bg-[var(--surface)] shadow-sm"
        >
          <div
            class="flex items-start justify-between border-b border-[var(--border)] px-6 py-5"
          >
            <div>
              <p
                class="text-[10px] font-bold tracking-[.14em] text-[var(--accent)]"
              >
                CREATE · REVIEW · RUN
              </p>
              <h2 class="mt-1 text-xl font-bold">
                {{
                  createStep === 1
                    ? "定义项目"
                    : createStep === 2
                      ? "规划员工与分工"
                      : "确认并创建项目"
                }}
              </h2>
              <p class="mt-1 text-sm text-[var(--muted)]">
                创建只生成草案；确认后才运行任何智能体。
              </p>
            </div>
            <button class="text-sm text-[var(--muted)]" @click="closeCreate">
              关闭
            </button>
          </div>
          <div class="p-6">
            <ol class="mb-7 flex items-center gap-2 text-xs font-semibold">
              <template v-for="step in [1, 2, 3]" :key="step"
                ><span
                  :class="[
                    'grid h-6 w-6 place-items-center rounded-full',
                    createStep >= step
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--surface-muted)] text-[var(--muted)]',
                  ]"
                  >{{ step }}</span
                ><span
                  :class="
                    createStep >= step
                      ? 'text-[var(--text)]'
                      : 'text-[var(--muted)]'
                  "
                  >{{
                    step === 1
                      ? "项目与模板"
                      : step === 2
                        ? "员工与分工"
                        : "确认"
                  }}</span
                ><i v-if="step < 3" class="h-px w-8 bg-[var(--border)]"
              /></template>
            </ol>
            <div v-if="createStep === 1">
              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <button
                  v-for="item in templates"
                  :key="item.id"
                  :class="[
                    'rounded-2xl border p-4 text-left transition',
                    mode === item.id
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                      : 'border-[var(--border)] hover:border-[var(--accent)]/50',
                  ]"
                  @click="chooseTemplate(item.id)"
                >
                  <span
                    class="grid h-9 w-9 place-items-center rounded-xl bg-[var(--surface-muted)] text-lg font-bold"
                    >{{ item.icon }}</span
                  ><strong class="mt-4 block">{{ item.name }}</strong>
                  <p
                    class="mt-1 min-h-10 text-xs leading-relaxed text-[var(--muted)]"
                  >
                    {{ item.description }}
                  </p>
                  <span
                    class="mt-3 inline-block text-[11px] font-semibold text-[var(--accent)]"
                    >{{ item.hint }}</span
                  >
                </button>
              </div>
              <div class="mt-6 grid gap-5 lg:grid-cols-[1fr_250px]">
                <div class="space-y-4">
                  <label class="block text-sm font-semibold"
                    >项目名称（可选）<input
                      v-model="name"
                      class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-normal outline-none focus:border-[var(--accent)]"
                      placeholder="例如：新产品调研与交付" /></label
                  ><label class="block text-sm font-semibold"
                    >项目目标<textarea
                      v-model="goal"
                      class="mt-2 min-h-28 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-normal outline-none focus:border-[var(--accent)]"
                      placeholder="描述最终目标、边界、对象和期望产出…"
                    />
                  </label>
                </div>
                <aside class="rounded-xl bg-[var(--surface-muted)] p-4">
                  <p class="text-sm font-bold">协调员模型</p>
                  <select
                    v-model="coordinatorId"
                    class="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                  >
                    <option disabled value="">选择模型</option>
                    <option
                      v-for="model in models"
                      :key="model.id"
                      :value="model.id"
                    >
                      {{ modelLabel(model) }}
                    </option></select
                  ><button
                    class="mt-4 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    :disabled="planning"
                    @click="continueCreate"
                  >
                    {{ planning ? "正在规划…" : "下一步：规划员工" }}
                  </button>
                  <p class="mt-3 text-xs leading-relaxed text-[var(--muted)]">
                    当前模板：{{
                      template.name
                    }}。也可由协调员依据目标改写任务。
                  </p>
                  <div class="mt-4 border-t border-[var(--border)] pt-4">
                    <p class="text-xs font-bold">项目空间目录</p>
                    <p
                      class="mt-1 break-all text-[11px] leading-4 text-[var(--muted)]"
                    >
                      {{
                        workspaceParent ||
                        "默认：~/.opcai/projects/项目名称-随机标识"
                      }}
                    </p>
                    <button
                      class="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold"
                      type="button"
                      @click="chooseWorkspaceParent"
                    >
                      {{
                        workspaceParent ? "更换父目录" : "选择父目录（可选）"
                      }}
                    </button>
                  </div>
                </aside>
              </div>
            </div>
            <p v-if="error" class="mt-4 text-sm text-rose-600">{{ error }}</p>
            <div
              v-if="createStep === 2"
              class="mt-6 border-t border-[var(--border)] pt-5"
            >
              <div class="mb-3 flex justify-between">
                <h3 class="font-bold">执行草案 · 请确认</h3>
                <button
                  class="text-sm text-[var(--accent)]"
                  @click="
                    draftTasks.push({
                      title: '新任务',
                      objective: '',
                      employeeId: 'general',
                      skillIds: [],
                    })
                  "
                >
                  ＋ 添加任务
                </button>
              </div>
              <article
                v-for="(task, index) in draftTasks"
                :key="index"
                class="mb-2 grid gap-2 rounded-xl border border-[var(--border)] p-3 md:grid-cols-[.9fr_1.7fr_150px_auto]"
              >
                <input
                  v-model="task.title"
                  class="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-2 text-sm"
                /><input
                  v-model="task.objective"
                  class="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-2 text-sm"
                /><select
                  v-model="task.employeeId"
                  class="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-2 text-sm"
                >
                  <option
                    v-for="employee in employees"
                    :key="employee.id"
                    :value="employee.id"
                  >
                    {{ employeeName(employee.id) }}
                  </option></select
                ><button
                  class="text-sm text-rose-600"
                  @click="draftTasks.splice(index, 1)"
                >
                  删除
                </button>
              </article>
              <div class="mt-5 flex justify-end gap-3">
                <button
                  class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
                  @click="createStep = 1"
                >
                  返回上一步</button
                ><button
                  class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
                  @click="createStep = 3"
                >
                  下一步：确认项目
                </button>
              </div>
            </div>
            <div
              v-if="createStep === 3"
              class="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-5"
            >
              <p
                class="text-xs font-bold tracking-[.12em] text-[var(--accent)]"
              >
                FINAL REVIEW
              </p>
              <h3 class="mt-2 text-lg font-bold">{{ name }}</h3>
              <p class="mt-2 text-sm text-[var(--muted)]">{{ goal }}</p>
              <div class="mt-4 space-y-2">
                <div
                  v-for="(task, index) in draftTasks"
                  :key="task.title + index"
                  class="flex items-center justify-between rounded-xl bg-[var(--surface)] px-3 py-2 text-sm"
                >
                  <span
                    ><strong>{{ index + 1 }}. {{ task.title }}</strong
                    ><small class="ml-2 text-[var(--muted)]">{{
                      employeeName(task.employeeId)
                    }}</small></span
                  ><span class="text-xs text-[var(--muted)]">{{
                    task.dependsOn?.length
                      ? `依赖 ${task.dependsOn.map((item) => item + 1).join("、")}`
                      : "可立即执行"
                  }}</span>
                </div>
              </div>
              <p class="mt-4 text-xs text-[var(--muted)]">
                创建后将进入项目对话工作台；只有点击“启动首轮”后才会调用员工。
              </p>
              <div class="mt-5 flex justify-end gap-3">
                <button
                  class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
                  @click="createStep = 2"
                >
                  返回修改</button
                ><button
                  class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white"
                  @click="confirmCreate"
                >
                  确认并进入项目工作台
                </button>
              </div>
            </div>
          </div>
        </section>

        <section
          v-else-if="tab === 'runs'"
          class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
        >
          <div
            v-if="!runs.length"
            class="p-14 text-center text-sm text-[var(--muted)]"
          >
            尚无项目运行记录。
          </div>
          <button
            v-for="item in runs"
            :key="item.id"
            class="flex w-full items-center justify-between border-b border-[var(--border)] px-5 py-4 text-left last:border-0"
          >
            <span
              ><strong>{{
                projects.find((project) => project.id === item.projectId)
                  ?.name ?? "已删除项目"
              }}</strong
              ><span class="ml-3 text-xs text-[var(--muted)]">{{
                date(item.startedAt)
              }}</span></span
            ><span
              :class="[
                'rounded-full px-2 py-1 text-xs font-semibold',
                statusStyle(item.status),
              ]"
              >{{ statusText(item.status) }}</span
            >
          </button>
        </section>

        <section v-else-if="!selected" class="space-y-7">
          <div
            v-if="projects.length"
            class="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          >
            <button
              v-for="project in projects"
              :key="project.id"
              class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:border-[var(--accent)] hover:shadow-md"
              @click="openProject(project)"
            >
              <div class="flex justify-between gap-3">
                <span
                  class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-bold text-[var(--accent)]"
                  >{{
                    templates.find((item) => item.id === project.mode)?.name
                  }}</span
                ><span
                  :class="[
                    'rounded-full px-2 py-1 text-[10px] font-bold',
                    statusStyle(project.status),
                  ]"
                  >{{ statusText(project.status) }}</span
                >
              </div>
              <h2 class="mt-4 text-lg font-bold">{{ project.name }}</h2>
              <p class="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                {{ project.goal }}
              </p>
              <p class="mt-5 text-xs text-[var(--muted)]">
                {{ project.tasks.length }} 个任务 · 更新于
                {{ date(project.updatedAt) }}
              </p>
            </button>
          </div>
          <div
            v-else
            class="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-14 text-center"
          >
            <h2 class="text-xl font-bold">选择一种项目编排方式</h2>
            <p
              class="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[var(--muted)]"
            >
              瀑布、并发、讨论与 DAG
              都从模板开始；在运行前可确认并调整任务草案。
            </p>
            <button
              class="mt-6 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white"
              @click="openCreate"
            >
              创建第一个项目
            </button>
          </div>
          <div>
            <h2 class="text-lg font-bold">项目模板</h2>
            <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <button
                v-for="item in templates"
                :key="item.id"
                class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:border-[var(--accent)]"
                @click="
                  openCreate();
                  chooseTemplate(item.id);
                "
              >
                <span class="text-lg font-bold text-[var(--accent)]">{{
                  item.icon
                }}</span
                ><strong class="mt-3 block">{{ item.name }}</strong>
                <p class="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                  {{ item.description }}
                </p>
              </button>
            </div>
          </div>
        </section>

        <ProjectConversationWorkspace
          v-else-if="selected"
          :project="selected!"
          :employees="employees"
          :template-name="
            templates.find((item) => item.id === selected!.mode)?.name ?? '项目'
          "
          :running="selected!.status === 'running'"
          @back="selectedId = null"
          @start="run(selected!)"
          @cancel="cancel(selected!)"
          @remove="
            remove(selected!.id);
            selectedId = null;
          "
          @dispatch="dispatchProjectInstruction(selected!, $event)"
        />

        <!-- Legacy task-detail view retained temporarily as reference for the project workspace migration.
        <section v-else-if="false" class="min-h-0">
          <button
            class="mb-4 text-sm font-semibold text-[var(--accent)]"
            @click="selectedId = null"
          >
            ← 返回项目列表
          </button>
          <header
            class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6"
          >
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <span
                  class="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-bold text-[var(--accent)]"
                  >{{
                    templates.find((item) => item.id === selected?.mode)?.name
                  }}</span
                >
                <h2 class="mt-3 text-2xl font-bold">{{ selected?.name }}</h2>
                <p
                  class="mt-2 max-w-4xl text-sm leading-relaxed text-[var(--muted)]"
                >
                  {{ selected?.goal }}
                </p>
              </div>
              <div class="flex gap-2">
                <button
                  v-if="selected?.status === 'running'"
                  class="rounded-lg border border-amber-500/40 px-3 py-2 text-sm font-semibold text-amber-700"
                  @click="selected && cancel(selected)"
                >
                  取消待执行任务</button
                ><button
                  v-else
                  class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white"
                  @click="selected && run(selected)"
                >
                  {{
                    selected?.status === "draft" ? "确认并启动" : "再次运行"
                  }}</button
                ><button
                  class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-rose-600"
                  @click="
                    selected && remove(selected.id);
                    selectedId = null;
                  "
                >
                  删除
                </button>
              </div>
            </div>
            <div class="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div
                v-for="state in ['queued', 'running', 'completed', 'failed']"
                :key="state"
                class="rounded-xl bg-[var(--surface-muted)] p-3"
              >
                <p class="text-xs text-[var(--muted)]">
                  {{ statusText(state) }}
                </p>
                <strong class="mt-1 block text-xl">{{
                  selected?.tasks.filter((task) => task.status === state)
                    .length ?? 0
                }}</strong>
              </div>
            </div>
          </header>
          <div
            class="mt-5 grid min-h-[500px] gap-5 xl:grid-cols-[minmax(360px,.8fr)_minmax(0,1.4fr)]"
          >
            <aside
              class="min-h-0 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div class="mb-2 flex items-center justify-between px-2">
                <h3 class="text-sm font-bold">智能体与任务</h3>
                <span class="text-xs text-[var(--muted)]"
                  >{{ selected.tasks.length }} 项</span
                >
              </div>
              <button
                v-for="task in selected.tasks"
                :key="task.id"
                :class="[
                  'mb-2 w-full rounded-xl border p-3 text-left transition',
                  detailTask?.id === task.id
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]/40'
                    : 'border-transparent hover:bg-[var(--surface-muted)]',
                ]"
                @click="detailTaskId = task.id"
              >
                <div class="flex items-center justify-between gap-2">
                  <strong class="truncate text-sm">{{ task.title }}</strong
                  ><span
                    :class="[
                      'rounded-full px-2 py-0.5 text-[10px] font-bold',
                      statusStyle(task.status),
                    ]"
                    >{{ statusText(task.status) }}</span
                  >
                </div>
                <p class="mt-1 text-xs text-[var(--muted)]">
                  {{ employeeName(task.employeeId) }} · {{ task.provider }}
                </p>
                <div
                  class="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]"
                >
                  <div
                    :class="[
                      'h-full rounded-full',
                      task.status === 'completed'
                        ? 'w-full bg-emerald-500'
                        : task.status === 'running'
                          ? 'w-2/3 animate-pulse bg-[var(--accent)]'
                          : task.status === 'failed'
                            ? 'w-full bg-rose-500'
                            : 'w-1/6 bg-slate-400',
                    ]"
                  ></div>
                </div>
              </button>
            </aside>
            <article
              v-if="detailTask"
              class="min-h-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
            >
              <header class="border-b border-[var(--border)] px-5 py-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-xs font-bold text-[var(--accent)]">
                      {{ employeeName(detailTask.employeeId) }} · LIVE TASK RUN
                    </p>
                    <h3 class="mt-1 text-lg font-bold">
                      {{ detailTask.title }}
                    </h3>
                  </div>
                  <span
                    :class="[
                      'rounded-full px-2 py-1 text-xs font-bold',
                      statusStyle(detailTask.status),
                    ]"
                    >{{ statusText(detailTask.status) }}</span
                  >
                </div>
                <p class="mt-2 text-sm text-[var(--muted)]">
                  {{ detailTask.objective }}
                </p>
              </header>
              <div class="grid min-h-[420px] grid-rows-[minmax(0,1fr)_auto]">
                <div class="min-h-0 overflow-y-auto p-5">
                  <div
                    v-if="detailTask.transcript?.assistantContent"
                    class="rounded-xl bg-[var(--surface-muted)] p-4"
                  >
                    <p class="mb-2 text-xs font-bold text-[var(--muted)]">
                      {{ employeeName(detailTask.employeeId) }} 的输出
                    </p>
                    <pre
                      class="whitespace-pre-wrap font-sans text-sm leading-relaxed"
                      >{{ detailTask.transcript.assistantContent }}</pre
                    >
                    <span
                      v-if="detailTask.status === 'running'"
                      class="mt-3 inline-flex items-center gap-2 text-xs text-[var(--accent)]"
                      ><i
                        class="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]"
                      ></i
                      >正在流式生成</span
                    >
                  </div>
                  <p
                    v-else
                    class="py-10 text-center text-sm text-[var(--muted)]"
                  >
                    {{
                      detailTask.status === "queued"
                        ? "正在等待前置任务或可用执行槽位…"
                        : "等待任务启动…"
                    }}
                  </p>
                  <p
                    v-if="detailTask.error"
                    class="mt-4 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700"
                  >
                    {{ detailTask.error }}
                  </p>
                </div>
                <div
                  class="border-t border-[var(--border)] bg-[var(--surface-muted)]/40 p-4"
                >
                  <div class="mb-2 flex items-center justify-between">
                    <p class="text-xs font-bold">执行过程</p>
                    <span class="text-xs text-[var(--muted)]"
                      >{{
                        detailTask.transcript?.activities?.length ?? 0
                      }}
                      步</span
                    >
                  </div>
                  <div class="max-h-36 space-y-1 overflow-y-auto">
                    <div
                      v-for="(activity, index) in detailTask.transcript
                        ?.activities ?? []"
                      :key="`${activity.toolName}-${index}`"
                      class="flex items-center gap-2 rounded-lg bg-[var(--surface)] px-3 py-2 text-xs"
                    >
                      <span
                        :class="[
                          'h-1.5 w-1.5 rounded-full',
                          activity.status === 'completed'
                            ? 'bg-emerald-500'
                            : activity.status === 'failed'
                              ? 'bg-rose-500'
                              : 'animate-pulse bg-blue-500',
                        ]"
                      ></span
                      ><strong class="shrink-0">{{ activity.toolName }}</strong
                      ><span class="truncate text-[var(--muted)]">{{
                        activity.summary
                      }}</span>
                    </div>
                    <p
                      v-if="!detailTask.transcript?.activities?.length"
                      class="text-xs text-[var(--muted)]"
                    >
                      工具、命令和文件过程会实时显示在这里。
                    </p>
                  </div>
                  <div
                    v-if="detailTask.transcript?.assets?.length"
                    class="mt-3 flex flex-wrap gap-2"
                  >
                    <span
                      v-for="asset in detailTask.transcript.assets"
                      :key="asset.id"
                      class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                      >📦 {{ asset.name }}</span
                    >
                  </div>
                </div>
              </div>
            </article>
          </div>
          <article
            v-if="selected.summary"
            class="mt-5 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6"
          >
            <p class="text-xs font-bold text-emerald-700">
              COORDINATOR SUMMARY
            </p>
            <pre
              class="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed"
              >{{ selected.summary }}</pre
            >
          </article>
        </section> -->
      </div>
    </div>
  </section>
</template>
