import { employeeDisplayName } from '../../app/employees';
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import type { Employee, EmployeeId } from "../../app/workspace.js";
import {
  deliverableEntries,
  type ProjectFileEntry,
} from "../../app/project-files.js";
import type { Project } from "../../app/projects.js";

const props = defineProps<{
  project: Project;
  employees: Employee[];
  templateName: string;
  running: boolean;
}>();
const emit = defineEmits<{
  back: [];
  start: [];
  cancel: [];
  remove: [];
  dispatch: [input: { employeeId: EmployeeId; content: string }];
}>();

const draft = ref("");
const pickerOpen = ref(false);
const selectedEmployeeId = ref<EmployeeId | null>(null);
const detailEmployeeId = ref<EmployeeId | null>(null);
const membersDockOpen = ref(false);
const sending = ref(false);
const refreshing = ref(false);
const filesError = ref("");
type FileEntry = ProjectFileEntry;
const files = ref<FileEntry[]>([]);
const selectedFile = ref('');
const fileContent = ref('');
const editorHost = ref<HTMLElement>();
const collapsedDirectories = ref(new Set<string>());
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const members = computed(() => {
  const ids = [...new Set(props.project.tasks.map((task) => task.employeeId))];
  return ids
    .map((id) => props.employees.find((employee) => employee.id === id))
    .filter(Boolean) as Employee[];
});
const selectedEmployee = computed(
  () =>
    members.value.find(
      (employee) => employee.id === selectedEmployeeId.value,
    ) ?? null,
);
const detailEmployee = computed(
  () =>
    members.value.find((employee) => employee.id === detailEmployeeId.value) ??
    null,
);
const detailTasks = computed(() =>
  props.project.tasks
    .filter((task) => task.employeeId === detailEmployeeId.value)
    .sort(
      (a, b) =>
        (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0),
    ),
);
const statusFor = (employeeId: EmployeeId) => {
  const tasks = props.project.tasks.filter(
    (task) => task.employeeId === employeeId,
  );
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.length && tasks.every((task) => task.status === "completed"))
    return "completed";
  return "queued";
};
const statusText = (status: string) =>
  ({
    queued: "等待调度",
    running: "执行中",
    completed: "已完成",
    failed: "需要处理",
    cancelled: "已取消",
  })[status] ?? status;
const statusClass = (status: string) =>
  ({
    queued: "bg-slate-500/10 text-slate-600",
    running: "bg-blue-500/10 text-blue-600",
    completed: "bg-emerald-500/10 text-emerald-600",
    failed: "bg-rose-500/10 text-rose-600",
    cancelled: "bg-amber-500/10 text-amber-700",
  })[status] ?? "bg-slate-500/10 text-slate-600";
const statusDotClass = (status: string) =>
  ({
    queued: "bg-slate-400",
    running: "animate-pulse bg-blue-500 ring-4 ring-blue-500/20",
    completed: "bg-emerald-500",
    failed: "bg-rose-500 ring-4 ring-rose-500/15",
    cancelled: "bg-amber-500",
  })[status] ?? "bg-slate-400";
const employeeName = (id?: EmployeeId) => {
  const employee = props.employees.find((item) => item.id === id);
  return employeeDisplayName(employee, (key) => ({
    'employee.general.name': '通用助理',
    'employee.research.name': '研究助理',
    'employee.code.name': '编程助理',
    'employee.administrator.name': '系统管理员',
  } as Record<string, string>)[key] || key) || id || '';
};
const date = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
const totalAssets = computed(() =>
  props.project.messages.flatMap((message) => message.assets ?? []),
);
const TREE_WIDTH_KEY = "opcai.project.tree-width";
const TREE_COLLAPSED_KEY = "opcai.project.tree-collapsed";
const treeWidth = ref(Number(localStorage.getItem(TREE_WIDTH_KEY)) || 260);
const treeCollapsed = ref(localStorage.getItem(TREE_COLLAPSED_KEY) === "1");
const resizingTree = ref(false);
const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 560;
const COLLAPSED_TREE_WIDTH = 44;

const deliverableFiles = computed(() => deliverableEntries(files.value));
const fileCount = computed(() => deliverableFiles.value.filter((entry) => entry.type === "file").length);
const visibleFiles = computed(() =>
  deliverableFiles.value.filter((entry) =>
    entry.relative
      .split("/")
      .slice(0, -1)
      .every((_, index, parts) => !collapsedDirectories.value.has(parts.slice(0, index + 1).join("/"))),
  ),
);
const editing = computed(() => Boolean(selectedFile.value));
const effectiveTreeWidth = computed(() => (treeCollapsed.value ? COLLAPSED_TREE_WIDTH : treeWidth.value));

function setTreeCollapsed(value: boolean) {
  treeCollapsed.value = value;
  localStorage.setItem(TREE_COLLAPSED_KEY, value ? "1" : "0");
}

function startTreeResize(event: PointerEvent) {
  if (treeCollapsed.value) return;
  event.preventDefault();
  resizingTree.value = true;
  const originX = event.clientX;
  const originWidth = treeWidth.value;
  const onMove = (moveEvent: PointerEvent) => {
    treeWidth.value = Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, originWidth + (moveEvent.clientX - originX)));
  };
  const onUp = () => {
    resizingTree.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth.value));
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function language(file: string) { if (/\.json$/i.test(file)) return 'json'; if (/\.(ts|tsx|js|jsx)$/i.test(file)) return 'typescript'; if (/\.py$/i.test(file)) return 'python'; if (/\.css$/i.test(file)) return 'css'; if (/\.html$/i.test(file)) return 'html'; if (/\.(ya?ml)$/i.test(file)) return 'yaml'; return 'markdown'; }
function fileDepth(entry: FileEntry) { return Math.max(0, entry.relative.split('/').length - 1); }
function fileName(entry: FileEntry) { return entry.relative.split('/').pop() ?? entry.relative; }
function toggleDirectory(entry: FileEntry) { const next = new Set(collapsedDirectories.value); if (next.has(entry.relative)) next.delete(entry.relative); else next.add(entry.relative); collapsedDirectories.value = next; }

async function recoverProjectFiles() {
  if (!props.project.workspacePath || !window.opcaiDesktop) return;
  const assetIds = [...new Set(totalAssets.value.map((asset) => asset.id))];
  const runIds = new Set<string>();
  for (const asset of totalAssets.value) {
    if ('runId' in asset && typeof (asset as { runId?: string }).runId === 'string') {
      runIds.add((asset as { runId: string }).runId);
    }
  }
  try {
    const catalog = await window.opcaiDesktop.listAssets();
    for (const asset of catalog) {
      if (assetIds.includes(asset.id) && asset.runId) runIds.add(asset.runId);
    }
  } catch { /* Desktop catalog is best-effort during recovery. */ }
  for (const runId of runIds) {
    try { await window.opcaiDesktop.syncProjectWorkspace(props.project.workspacePath, runId); } catch { /* Continue other run workspaces. */ }
  }
  if (assetIds.length) {
    try { await window.opcaiDesktop.materializeProjectAssets(props.project.workspacePath, assetIds); } catch { /* Keep listing whatever already synced. */ }
  }
}

async function loadFiles(options: { recover?: boolean } = {}) {
  filesError.value = '';
  if (!props.project.workspacePath) {
    files.value = [];
    filesError.value = '旧项目尚未配置项目空间。';
    return;
  }
  if (!window.opcaiDesktop) {
    files.value = [];
    filesError.value = '项目文件树仅在桌面应用中可用。';
    return;
  }
  refreshing.value = true;
  try {
    files.value = await window.opcaiDesktop.listProjectFiles(props.project.workspacePath);
    const needsRecover = options.recover !== false && !files.value.some((entry) => entry.type === 'file') && totalAssets.value.length > 0;
    if (needsRecover) {
      await recoverProjectFiles();
      files.value = await window.opcaiDesktop.listProjectFiles(props.project.workspacePath);
    }
  } catch (error) {
    filesError.value = error instanceof Error ? error.message : '无法读取项目空间。';
  } finally {
    refreshing.value = false;
  }
}

async function selectFile(entry: FileEntry) {
  if (entry.type === 'directory') { toggleDirectory(entry); return; }
  if (!props.project.workspacePath) return;
  const file = await window.opcaiDesktop?.readProjectFile(props.project.workspacePath, entry.relative);
  if (!file) return;
  selectedFile.value = entry.relative; fileContent.value = file.content;
  membersDockOpen.value = false;
  await nextTick();
  if (!editorHost.value) return;
  if (!editor) editor = monaco.editor.create(editorHost.value, { value: file.content, language: language(entry.relative), theme: 'vs', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', scrollBeyondLastLine: false, padding: { top: 16 } });
  else { monaco.editor.setModelLanguage(editor.getModel()!, language(entry.relative)); editor.setValue(file.content); }
}
function closeEditor() {
  selectedFile.value = '';
  editor?.dispose();
  editor = undefined;
  membersDockOpen.value = false;
}
async function saveFile() { if (!props.project.workspacePath || !selectedFile.value || !editor) return; const result = await window.opcaiDesktop?.writeProjectFile(props.project.workspacePath, selectedFile.value, editor.getValue()); if (result) fileContent.value = result.content; }

async function dispatch() {
  if (
    !draft.value.trim() ||
    !selectedEmployeeId.value ||
    sending.value ||
    props.running
  )
    return;
  sending.value = true;
  try {
    emit("dispatch", {
      employeeId: selectedEmployeeId.value,
      content: draft.value.trim(),
    });
    draft.value = "";
    selectedEmployeeId.value = null;
    pickerOpen.value = false;
  } finally {
    sending.value = false;
  }
}
async function download(assetId: string) {
  await window.opcaiDesktop?.saveAsset(assetId);
}
function openMember(employeeId: EmployeeId) {
  detailEmployeeId.value = employeeId;
  membersDockOpen.value = false;
}

onMounted(() => { void loadFiles({ recover: true }); });
watch(
  () => [props.project.status, props.project.messages.length, totalAssets.value.length, props.project.workspacePath] as const,
  () => { void loadFiles({ recover: true }); },
);
onBeforeUnmount(() => editor?.dispose());
</script>

<template>
  <section class="flex h-full min-h-0 flex-col">
    <header
      class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-6 py-4"
    >
      <div class="flex min-w-0 items-center gap-3">
        <button
          class="rounded-lg px-2 py-1 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
          @click="emit('back')"
        >
          ← 项目列表
        </button>
        <span class="hidden h-5 w-px bg-[var(--border)] sm:block" />
        <div class="min-w-0">
          <p class="text-[10px] font-bold tracking-[.14em] text-[var(--accent)]">
            PROJECT WORKSPACE · {{ templateName }}
          </p>
          <h1 class="truncate text-lg font-bold">{{ project.name }}</h1>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span :class="['rounded-full px-2.5 py-1 text-xs font-bold', statusClass(project.status)]">{{ statusText(project.status) }}</span>
        <button
          v-if="project.status === 'running'"
          class="rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-700"
          @click="emit('cancel')"
        >取消</button>
        <button
          v-else
          class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
          @click="emit('start')"
        >{{ project.status === "draft" ? "启动首轮" : "再次调度" }}</button>
        <button
          class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-rose-600"
          @click="emit('remove')"
        >删除</button>
      </div>
    </header>

    <div
      class="grid min-h-0 flex-1 grid-cols-1"
      :class="[
        resizingTree ? 'select-none' : '',
        editing
          ? 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1.2fr)_minmax(340px,0.9fr)]'
          : 'xl:[grid-template-columns:var(--tree-width)_minmax(0,1fr)_300px]',
      ]"
      :style="{ '--tree-width': `${effectiveTreeWidth}px` }"
    >
      <!-- 项目文件：默认展开；可向左收起，拖右边线调宽 -->
      <aside
        :class="[
          'relative min-h-0 border-r border-[var(--border)] bg-[var(--surface)]',
          treeCollapsed ? 'overflow-hidden' : 'overflow-y-auto p-3',
        ]"
      >
        <template v-if="treeCollapsed">
          <div class="flex h-full flex-col items-center gap-3 py-3">
            <button
              class="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border)] text-sm font-bold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              type="button"
              title="展开项目文件"
              @click="setTreeCollapsed(false)"
            >›</button>
            <span
              class="mt-2 text-[10px] font-bold tracking-[.18em] text-[var(--muted)]"
              style="writing-mode: vertical-rl"
            >项目文件</span>
            <span v-if="fileCount" class="text-[10px] text-[var(--muted)]">{{ fileCount }}</span>
          </div>
        </template>
        <template v-else>
          <div class="mb-3 flex items-center justify-between gap-2 px-2">
            <strong class="text-xs">项目文件</strong>
            <div class="flex items-center gap-1">
              <button
                class="rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-wait disabled:opacity-50"
                type="button"
                :disabled="refreshing || !project.workspacePath"
                @click="loadFiles({ recover: true })"
              >{{ refreshing ? '同步中…' : '刷新' }}</button>
              <button
                class="rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--accent)]"
                type="button"
                title="向左收起，扩大右侧空间"
                @click="setTreeCollapsed(true)"
              >‹</button>
            </div>
          </div>
          <p class="mb-1 px-2 text-[11px] leading-4 text-[var(--muted)] break-all">{{ project.workspacePath || '旧项目尚未配置项目空间。' }}</p>
          <p v-if="fileCount" class="mb-3 px-2 text-[10px] text-[var(--muted)]">{{ fileCount }} 个交付文件</p>
          <button
            v-for="entry in visibleFiles"
            :key="entry.relative"
            type="button"
            :style="{ paddingLeft: `${8 + fileDepth(entry) * 14}px` }"
            :class="[
              'flex w-full items-center gap-2 rounded-lg py-2 text-left text-sm',
              entry.type === 'directory'
                ? 'text-[var(--muted)] hover:bg-[var(--surface-muted)]'
                : selectedFile === entry.relative
                  ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                  : 'hover:bg-[var(--surface-muted)]',
            ]"
            @click="selectFile(entry)"
          >
            <span>{{ entry.type === 'directory' ? (collapsedDirectories.has(entry.relative) ? '›' : '⌄') : '▧' }}</span>
            <span class="truncate">{{ fileName(entry) }}</span>
          </button>
          <p v-if="filesError" class="mt-4 px-2 text-xs leading-5 text-rose-600">{{ filesError }}</p>
          <p v-else-if="!deliverableFiles.length" class="mt-6 px-2 text-xs leading-5 text-[var(--muted)]">
            仅展示交付资产（页面、样式、文案等）。智能体过程脚本（如 .py / .sh）不会出现在此树中。
          </p>
          <div
            class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-[var(--accent)]/25 active:bg-[var(--accent)]/40"
            title="拖动调整目录树宽度"
            @pointerdown="startTreeResize"
          />
        </template>
      </aside>

      <!-- 未选文件：对话居中；选中文件：编辑器居中 -->
      <main v-if="editing" class="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <header class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div class="min-w-0">
            <p class="text-[10px] font-bold tracking-[.12em] text-[var(--accent)]">PROJECT FILE EDITOR</p>
            <strong class="block truncate text-sm">{{ selectedFile }}</strong>
          </div>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs" type="button" @click="closeEditor">关闭编辑器</button>
            <button class="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-white" type="button" @click="saveFile">保存</button>
          </div>
        </header>
        <div ref="editorHost" class="min-h-0 flex-1" />
      </main>

      <div
        :class="[
          'relative flex min-h-0 flex-col bg-[var(--background)]',
          editing ? 'border-l border-[var(--border)]' : '',
        ]"
      >
        <div class="border-b border-[var(--border)] px-6 py-4">
          <div class="mx-auto flex max-w-3xl items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-semibold">{{ project.goal }}</p>
              <p class="mt-1 text-xs text-[var(--muted)]">
                {{ editing ? '正在编辑项目文件；对话移至右侧，成员可从右下角小窗展开。' : '项目对话居中；成员与资产在右侧。点击左侧文件可打开编辑器。' }}
              </p>
            </div>
            <button
              v-if="editing"
              class="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left shadow-sm hover:border-[var(--accent)]"
              type="button"
              @click="membersDockOpen = !membersDockOpen"
            >
              <span class="block text-[10px] font-bold tracking-wide text-[var(--muted)]">成员</span>
              <span class="mt-1 flex items-center gap-1">
                <i
                  v-for="employee in members.slice(0, 4)"
                  :key="employee.id"
                  class="relative grid h-6 w-6 place-items-center rounded-md text-[9px] font-bold text-white"
                  :style="{ background: employee.color }"
                  :title="`${employeeName(employee.id)} · ${statusText(statusFor(employee.id))}`"
                >
                  {{ employee.initials }}
                  <span :class="['absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-white', statusDotClass(statusFor(employee.id))]" />
                </i>
              </span>
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div :class="['mx-auto flex flex-col gap-5', editing ? 'max-w-none' : 'max-w-3xl']">
            <article
              v-for="message in project.messages"
              :key="message.id"
              :class="['flex gap-2.5', message.role === 'user' ? 'self-end' : '']"
            >
              <span
                v-if="message.role === 'assistant'"
                class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--accent)] text-[10px] font-bold text-white"
              >{{ props.employees.find((item) => item.id === message.employeeId)?.initials ?? "AI" }}</span>
              <div :class="message.role === 'user' ? 'max-w-[88%]' : 'min-w-0 max-w-[94%] flex-1'">
                <div class="mb-1 flex gap-2 text-[11px] text-[var(--muted)]">
                  <span>{{ message.role === "user" ? "你" : message.role === "system" ? "调度器" : employeeName(message.employeeId) }}</span>
                  <span>{{ date(message.createdAt) }}</span>
                </div>
                <p
                  :class="[
                    'whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6',
                    message.role === 'user'
                      ? 'rounded-tr-md bg-[var(--accent-soft)]'
                      : message.role === 'system'
                        ? 'border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)]'
                        : 'rounded-tl-md bg-[var(--surface)] shadow-sm',
                  ]"
                >{{ message.content || "正在生成项目任务结果…" }}</p>
                <details
                  v-if="message.activities?.length"
                  class="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <summary class="cursor-pointer px-3 py-2 text-[var(--muted)]">执行过程 · {{ message.activities.length }} 步</summary>
                  <div class="space-y-1 border-t border-[var(--border)] p-2">
                    <p
                      v-for="(activity, index) in message.activities"
                      :key="`${activity.toolName}-${index}`"
                      class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5"
                    ><strong>{{ activity.toolName }}</strong> · {{ activity.summary }}</p>
                  </div>
                </details>
                <div v-if="message.assets?.length" class="mt-2 flex flex-wrap gap-2">
                  <button
                    v-for="asset in message.assets"
                    :key="asset.id"
                    class="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-left text-xs"
                    type="button"
                    @click="download(asset.id)"
                  >📦 <strong>{{ asset.name }}</strong><span class="ml-2 text-[var(--muted)]">下载</span></button>
                </div>
              </div>
            </article>
            <article v-if="project.summary" class="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <p class="text-xs font-bold text-emerald-700">协调员汇总</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{{ project.summary }}</p>
            </article>
          </div>
        </div>

        <div class="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-4">
          <div :class="['mx-auto rounded-2xl border border-[var(--border)] bg-[var(--background)] p-3 shadow-sm', editing ? 'max-w-none' : 'max-w-3xl']">
            <textarea
              v-model="draft"
              rows="3"
              class="w-full resize-none bg-transparent px-1 text-sm outline-none"
              :disabled="running"
              placeholder="向项目成员下达补充指令；调度器会判断是否需要触发下游任务…"
              @keydown.enter.exact.prevent="dispatch"
            />
            <div class="mt-2 flex items-center gap-2">
              <div class="relative">
                <button
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold"
                  type="button"
                  :disabled="running"
                  @click="pickerOpen = !pickerOpen"
                >@ {{ selectedEmployee ? employeeName(selectedEmployee.id) : "选择项目员工" }}</button>
                <div
                  v-if="pickerOpen"
                  class="absolute bottom-10 left-0 z-20 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
                >
                  <p class="border-b border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">仅显示本项目已分配的员工</p>
                  <button
                    v-for="employee in members"
                    :key="employee.id"
                    class="flex w-full items-center gap-2 p-3 text-left text-sm hover:bg-[var(--surface-muted)]"
                    type="button"
                    @click="selectedEmployeeId = employee.id; pickerOpen = false"
                  >
                    <span class="relative grid h-7 w-7 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">
                      {{ employee.initials }}
                      <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
                    </span>
                    <span>
                      <strong class="block">{{ employeeName(employee.id) }}</strong>
                      <small :class="['text-[11px] font-semibold', statusClass(statusFor(employee.id)), 'rounded px-1 py-0.5']">{{ statusText(statusFor(employee.id)) }}</small>
                    </span>
                  </button>
                </div>
              </div>
              <span v-if="selectedEmployee" class="text-xs text-[var(--muted)]">将由调度器评估 {{ employeeName(selectedEmployee.id) }} 的后续依赖。</span>
              <button
                class="ml-auto rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                type="button"
                :disabled="!draft.trim() || !selectedEmployee || running"
                @click="dispatch"
              >发送指令</button>
            </div>
          </div>
        </div>

        <!-- 编辑模式下的成员小窗 -->
        <div
          v-if="editing && membersDockOpen"
          class="absolute bottom-28 right-6 z-30 w-72 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        >
          <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <strong class="text-xs">项目成员 · {{ members.length }}</strong>
            <button class="text-xs text-[var(--muted)]" type="button" @click="membersDockOpen = false">收起</button>
          </div>
          <div class="max-h-72 overflow-y-auto p-2">
            <button
              v-for="employee in members"
              :key="employee.id"
              class="mb-1.5 flex w-full items-center gap-2 rounded-xl border border-[var(--border)] p-2.5 text-left hover:border-[var(--accent)]"
              type="button"
              @click="openMember(employee.id)"
            >
              <span class="relative grid h-8 w-8 place-items-center rounded-lg text-[10px] font-bold text-white" :style="{ background: employee.color }">
                {{ employee.initials }}
                <span :class="['absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
              </span>
              <span class="min-w-0 flex-1">
                <strong class="block text-xs">{{ employeeName(employee.id) }}</strong>
                <span :class="['mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold', statusClass(statusFor(employee.id))]">{{ statusText(statusFor(employee.id)) }}</span>
              </span>
            </button>
            <div v-if="totalAssets.length" class="mt-2 border-t border-[var(--border)] pt-2">
              <p class="px-1 text-[10px] font-bold text-[var(--muted)]">资产 · {{ totalAssets.length }}</p>
              <button
                v-for="asset in totalAssets.slice(0, 5)"
                :key="asset.id"
                class="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-[var(--surface-muted)]"
                type="button"
                @click="download(asset.id)"
              >📦 <span class="truncate">{{ asset.name }}</span></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 未选文件：成员与资产固定最右侧 -->
      <aside
        v-if="!editing"
        class="min-h-0 border-l border-[var(--border)] bg-[var(--surface)]"
      >
        <div class="border-b border-[var(--border)] px-4 py-4">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-bold">项目成员</h2>
            <span class="text-xs text-[var(--muted)]">{{ members.length }} 人</span>
          </div>
          <p class="mt-1 text-xs text-[var(--muted)]">点击成员查看任务记录与执行细节。</p>
        </div>
        <div class="min-h-0 overflow-y-auto p-3">
          <button
            v-for="employee in members"
            :key="employee.id"
            class="mb-2 flex w-full items-center gap-3 rounded-xl border border-[var(--border)] p-3 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/30"
            type="button"
            @click="openMember(employee.id)"
          >
            <span class="relative grid h-10 w-10 place-items-center rounded-xl text-[10px] font-bold text-white" :style="{ background: employee.color }">
              {{ employee.initials }}
              <span :class="['absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white', statusDotClass(statusFor(employee.id))]" />
            </span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm">{{ employeeName(employee.id) }}</strong>
              <small class="mt-1 block text-[11px] text-[var(--muted)]">
                {{ project.tasks.filter((task) => task.employeeId === employee.id).length }} 个任务
              </small>
              <span :class="['mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold', statusClass(statusFor(employee.id))]">
                <i :class="['h-1.5 w-1.5 rounded-full', statusDotClass(statusFor(employee.id))]" />
                {{ statusText(statusFor(employee.id)) }}
              </span>
            </span>
          </button>
          <div v-if="totalAssets.length" class="mt-5 border-t border-[var(--border)] pt-4">
            <p class="text-xs font-bold">项目资产 · {{ totalAssets.length }}</p>
            <button
              v-for="asset in totalAssets.slice(0, 8)"
              :key="asset.id"
              class="mt-2 flex w-full items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-left text-xs"
              type="button"
              @click="download(asset.id)"
            >📦 <span class="truncate">{{ asset.name }}</span></button>
          </div>
        </div>
      </aside>
    </div>

    <div
      v-if="detailEmployee"
      class="fixed inset-0 z-40 flex justify-end bg-slate-950/25"
      @click.self="detailEmployeeId = null"
    >
      <aside class="h-full w-full max-w-xl overflow-y-auto border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="sticky top-0 flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          <div>
            <p class="text-xs font-bold text-[var(--accent)]">MEMBER EXECUTION DETAIL</p>
            <h2 class="mt-1 text-lg font-bold">{{ employeeName(detailEmployee.id) }}</h2>
            <span :class="['mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold', statusClass(statusFor(detailEmployee.id))]">
              <i :class="['h-2 w-2 rounded-full', statusDotClass(statusFor(detailEmployee.id))]" />
              {{ statusText(statusFor(detailEmployee.id)) }}
            </span>
          </div>
          <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm" type="button" @click="detailEmployeeId = null">关闭</button>
        </header>
        <div class="space-y-4 p-5">
          <article v-for="task in detailTasks" :key="task.id" class="rounded-2xl border border-[var(--border)] p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="font-bold">{{ task.title }}</h3>
                <p class="mt-1 text-sm text-[var(--muted)]">{{ task.objective }}</p>
              </div>
              <span :class="['shrink-0 rounded-full px-2 py-1 text-xs font-bold', statusClass(task.status)]">{{ statusText(task.status) }}</span>
            </div>
            <pre
              v-if="task.transcript?.assistantContent"
              class="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[var(--surface-muted)] p-3 font-sans text-xs leading-5"
            >{{ task.transcript.assistantContent }}</pre>
            <div v-if="task.transcript?.activities?.length" class="mt-3 space-y-1">
              <p
                v-for="(activity, index) in task.transcript.activities"
                :key="`${activity.toolName}-${index}`"
                class="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5 text-xs"
              ><strong>{{ activity.toolName }}</strong> · {{ activity.summary }}</p>
            </div>
          </article>
          <p v-if="!detailTasks.length" class="text-sm text-[var(--muted)]">该成员尚无任务记录。</p>
        </div>
      </aside>
    </div>
  </section>
</template>
