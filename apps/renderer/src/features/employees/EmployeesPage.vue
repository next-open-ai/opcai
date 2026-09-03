<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Employee, EmployeeDraft, EmployeeId } from '../../app/workspace';
import { useI18n } from '../../app/i18n';
import { baselineWorkspaceSkillMeta } from '../../app/baseline-skills';
import { useCapabilities, type PolicyMode } from '../../app/capabilities';
import { chatEndpointLabel, useModelConfig } from '../../app/model-config';
import { searchProviderIds, useSearchConfig } from '../../app/search-config';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_MAX_STEPS,
  MAX_MCP_TOOL_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  MIN_MAX_STEPS,
  MIN_MCP_TOOL_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
  defaultEmployeeRuntimePrefs,
  useEmployeeRuntimePrefs,
  type EmployeeKnowledgeProvider,
  type EmployeeSearchMode,
} from '../../app/employee-prefs';
import { useNotify } from '../../app/notify';
import { mcpSummaryLine, useMcpConfig, isAssociableMcp } from '../../app/mcp-config';
import { knowledgeProviderMeta, useKnowledgeConfig } from '../../app/kb-config';
import {
  EMPLOYEE_COLOR_PRESETS,
  defaultEmployeeDraft,
  draftFromEmployee,
  employeeDisplayDescription,
  employeeDisplayName,
  isEditableEmployee,
  isPresetEmployee,
} from '../../app/employees';

const props = defineProps<{
  employees: Employee[];
  selectedEmployeeId: EmployeeId;
  createEmployee: (draft: EmployeeDraft) => Promise<Employee>;
  updateEmployee: (id: EmployeeId, draft: EmployeeDraft) => Promise<Employee>;
  removeEmployee: (id: EmployeeId) => Promise<void>;
}>();
const emit = defineEmits<{ startChat: [id: EmployeeId] }>();
const { t } = useI18n();
const notify = useNotify();
const selected = ref<EmployeeId | null>(null);
const savingSkillId = ref<string | null>(null);
const savingRuntime = ref(false);
const savingProfile = ref(false);
const formOpen = ref(false);
const editingId = ref<EmployeeId | null>(null);
const draft = ref(defaultEmployeeDraft());
const { skills, load, policyFor, setPolicy } = useCapabilities();
const { availableChatModels, load: loadModels, setEmployeeDefaultModel, settings: modelSettings } = useModelConfig();
const { settings: searchSettings, load: loadSearch } = useSearchConfig();
const { load: loadPrefs, get: getPrefs, set: setPrefs, reset: resetPrefs } = useEmployeeRuntimePrefs();
const { connections: mcpConnections, load: loadMcp } = useMcpConfig();
const { bases: knowledgeBases, load: loadKnowledge, isReady: isKnowledgeReady, isProviderEnabled, enabledProviders } = useKnowledgeConfig();

const draftModelId = ref('');
const draftSearchMode = ref<EmployeeSearchMode>('inherit');
const draftMaxSteps = ref(DEFAULT_MAX_STEPS);
const draftRunTimeoutSec = ref(Math.round(DEFAULT_RUN_TIMEOUT_MS / 1000));
const draftMcpToolTimeoutSec = ref(Math.round(DEFAULT_MCP_TOOL_TIMEOUT_MS / 1000));
const draftMcpIds = ref<string[]>([]);
const draftKnowledgeProvider = ref<EmployeeKnowledgeProvider>('off');
const draftKnowledgeBaseIds = ref<string[]>([]);
const mcpPickerOpen = ref(false);
const mcpPickerDraft = ref<string[]>([]);

const selectedEmployee = computed(() => props.employees.find((employee) => employee.id === selected.value) ?? null);
const availableMcps = computed(() => mcpConnections.value.filter((item) => isAssociableMcp(item)));
const useMcpModal = computed(() => availableMcps.value.length > 5);
const selectedMcpItems = computed(() => availableMcps.value.filter((item) => draftMcpIds.value.includes(item.id)));
const knowledgeProviderOptions = computed(() => [
  { value: 'off' as const, label: t('employee.kbProviderOff') },
  ...enabledProviders.value.map((item) => ({
    value: item.id,
    label: knowledgeProviderMeta[item.id].label,
  })),
]);
const availableKnowledgeBases = computed(() => {
  if (draftKnowledgeProvider.value === 'off') return [];
  return knowledgeBases.value.filter(
    (item) =>
      item.provider === draftKnowledgeProvider.value
      && isProviderEnabled(item.provider)
      && isKnowledgeReady(item),
  );
});
const canEditSelected = computed(() => selectedEmployee.value ? isEditableEmployee(selectedEmployee.value) : false);

onMounted(async () => {
  await Promise.all([load(), loadModels(), loadSearch(), loadPrefs(), loadMcp(), loadKnowledge()]);
});

watch(
  selected,
  (id) => {
    if (!id) return;
    const prefs = getPrefs(id);
    const modelFromLegacy = modelSettings.value.employeeDefaultModelIds[id] || '';
    draftModelId.value = prefs.defaultModelId || modelFromLegacy || '';
    draftSearchMode.value = prefs.searchMode;
    draftMaxSteps.value = prefs.maxSteps;
    draftRunTimeoutSec.value = Math.round((prefs.runTimeoutMs || DEFAULT_RUN_TIMEOUT_MS) / 1000);
    draftMcpToolTimeoutSec.value = Math.round((prefs.mcpToolTimeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS) / 1000);
    draftMcpIds.value = [...(prefs.mcpIds || [])].filter((id) =>
      mcpConnections.value.some((item) => item.id === id && isAssociableMcp(item)),
    );
    let provider = prefs.knowledgeProvider || 'off';
    const ids = [...(prefs.knowledgeBaseIds || [])];
    // Migrate legacy prefs that only stored knowledgeBaseIds.
    if (provider === 'off' && ids.length) {
      const first = knowledgeBases.value.find((item) => ids.includes(item.id));
      if (first) provider = first.provider;
    }
    draftKnowledgeProvider.value = provider;
    draftKnowledgeBaseIds.value = provider === 'off'
      ? []
      : ids.filter((id) => knowledgeBases.value.some((item) => item.id === id && item.provider === provider));
  },
);

function displayName(employee: Employee) {
  return employeeDisplayName(employee, t);
}

function displayDescription(employee: Employee) {
  return employeeDisplayDescription(employee, t);
}

function mode(skillId: string): PolicyMode {
  return selected.value ? policyFor(selected.value, skillId)?.mode ?? 'disabled' : 'disabled';
}

async function update(skillId: string, event: Event) {
  if (!selected.value) return;
  savingSkillId.value = skillId;
  try {
    await setPolicy(selected.value, skillId, (event.target as HTMLSelectElement).value as PolicyMode);
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingSkillId.value = null;
  }
}

async function saveRuntime() {
  if (!selected.value) return;
  savingRuntime.value = true;
  try {
    const modelId = draftModelId.value || null;
    await setPrefs(selected.value, {
      defaultModelId: modelId,
      searchMode: draftSearchMode.value,
      maxSteps: draftMaxSteps.value,
      runTimeoutMs: Math.round(draftRunTimeoutSec.value * 1000),
      mcpToolTimeoutMs: Math.round(draftMcpToolTimeoutSec.value * 1000),
      mcpIds: [...draftMcpIds.value],
      knowledgeProvider: draftKnowledgeProvider.value,
      knowledgeBaseIds: draftKnowledgeProvider.value === 'off' ? [] : [...draftKnowledgeBaseIds.value],
    });
    await setEmployeeDefaultModel(selected.value, modelId);
    notify.success('notify.employeeRuntimeSaved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingRuntime.value = false;
  }
}

async function resetRuntime() {
  if (!selected.value) return;
  const defaults = defaultEmployeeRuntimePrefs();
  draftModelId.value = '';
  draftSearchMode.value = defaults.searchMode;
  draftMaxSteps.value = defaults.maxSteps;
  draftRunTimeoutSec.value = Math.round(defaults.runTimeoutMs / 1000);
  draftMcpToolTimeoutSec.value = Math.round(defaults.mcpToolTimeoutMs / 1000);
  draftMcpIds.value = [];
  draftKnowledgeProvider.value = defaults.knowledgeProvider;
  draftKnowledgeBaseIds.value = [];
  await resetPrefs(selected.value);
  await setEmployeeDefaultModel(selected.value, null);
  notify.success('notify.employeeRuntimeReset');
}

function toggleMcp(id: string) {
  draftMcpIds.value = draftMcpIds.value.includes(id)
    ? draftMcpIds.value.filter((item) => item !== id)
    : [...draftMcpIds.value, id];
}

function openMcpPicker() {
  mcpPickerDraft.value = [...draftMcpIds.value].filter((id) => availableMcps.value.some((item) => item.id === id));
  mcpPickerOpen.value = true;
}

function toggleMcpPickerDraft(id: string) {
  mcpPickerDraft.value = mcpPickerDraft.value.includes(id)
    ? mcpPickerDraft.value.filter((item) => item !== id)
    : [...mcpPickerDraft.value, id];
}

function confirmMcpPicker() {
  draftMcpIds.value = [...mcpPickerDraft.value];
  mcpPickerOpen.value = false;
}

function removeSelectedMcp(id: string) {
  draftMcpIds.value = draftMcpIds.value.filter((item) => item !== id);
}

function toggleKnowledgeBase(id: string) {
  draftKnowledgeBaseIds.value = draftKnowledgeBaseIds.value.includes(id)
    ? draftKnowledgeBaseIds.value.filter((item) => item !== id)
    : [...draftKnowledgeBaseIds.value, id];
}

function onKnowledgeProviderChange() {
  if (draftKnowledgeProvider.value === 'off') {
    draftKnowledgeBaseIds.value = [];
    return;
  }
  draftKnowledgeBaseIds.value = draftKnowledgeBaseIds.value.filter((id) =>
    availableKnowledgeBases.value.some((item) => item.id === id),
  );
}

function openCreate() {
  editingId.value = null;
  draft.value = defaultEmployeeDraft();
  formOpen.value = true;
}

function openEdit(employee: Employee) {
  if (!isEditableEmployee(employee)) return;
  editingId.value = employee.id;
  draft.value = draftFromEmployee(employee, t);
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
  draft.value = defaultEmployeeDraft();
}

async function saveProfile() {
  savingProfile.value = true;
  try {
    if (editingId.value) {
      const saved = await props.updateEmployee(editingId.value, draft.value);
      selected.value = saved.id;
      notify.success('notify.employeeUpdated');
    } else {
      const saved = await props.createEmployee(draft.value);
      selected.value = saved.id;
      notify.success('notify.employeeCreated');
    }
    closeForm();
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  } finally {
    savingProfile.value = false;
  }
}

async function onDelete(employee: Employee) {
  if (!isEditableEmployee(employee)) return;
  if (!window.confirm(t('employee.deleteConfirm', { name: displayName(employee) }))) return;
  try {
    await props.removeEmployee(employee.id);
    if (selected.value === employee.id) selected.value = null;
    notify.success('notify.employeeDeleted');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

const employeeModelSupportsBuiltinSearch = computed(() => {
  const preferredId = draftModelId.value || modelSettings.value.employeeDefaultModelIds[selected.value || ''] || modelSettings.value.activeChatModelId;
  const match = preferredId
    ? availableChatModels.value.find((item) => item.id === preferredId)
    : availableChatModels.value[0];
  return Boolean(match?.supportsBuiltinWebSearch);
});

const searchModeOptions = computed(() => {
  const base: Array<{ value: EmployeeSearchMode; label: string }> = [
    { value: 'inherit', label: t('employee.searchInherit') },
    { value: 'auto', label: t('employee.searchAuto') },
    { value: 'off', label: t('employee.searchOff') },
  ];
  if (employeeModelSupportsBuiltinSearch.value) {
    base.push({ value: 'llm-builtin', label: t('employee.searchBuiltin') });
  }
  for (const id of searchProviderIds) {
    const label = searchSettings.value.providers.find((item) => item.id === id)?.label ?? id;
    base.push({ value: id, label: `${t('employee.searchForce')} · ${label}` });
  }
  return base;
});

watch(employeeModelSupportsBuiltinSearch, (ok) => {
  if (!ok && draftSearchMode.value === 'llm-builtin') draftSearchMode.value = 'inherit';
});
</script>

<template>
  <section class="mx-auto w-full max-w-6xl px-6 py-14 sm:px-12">
    <header class="mb-9">
      <p class="mb-2 text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OPCAI / TEAM</p>
      <h1 class="text-4xl font-bold tracking-[-.045em]">{{ t('employee.title') }}</h1>
      <p class="mt-3 max-w-2xl leading-relaxed text-[var(--muted)]">{{ selectedEmployee ? t('employee.detailSubtitle') : t('employee.subtitle') }}</p>
    </header>

    <template v-if="!selectedEmployee">
      <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold">{{ t('employee.directory') }}</p>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ t('employee.directoryHelp') }}</p>
        </div>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white" type="button" @click="openCreate">
          {{ t('employee.create') }}
        </button>
      </div>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <button
          v-for="employee in employees"
          :key="employee.id"
          class="group relative min-h-[190px] rounded-[18px] border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-sm"
          type="button"
          @click="selected = employee.id"
        >
          <span class="grid h-12 w-12 place-items-center rounded-2xl text-[11px] font-extrabold text-white" :style="{ background: employee.color }">{{ employee.initials }}</span>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <h2 class="text-[16px] font-bold">{{ displayName(employee) }}</h2>
            <span v-if="employee.system" class="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">{{ t('employee.system') }}</span>
            <span v-else-if="isPresetEmployee(employee)" class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--muted)]">{{ t('employee.preset') }}</span>
            <span v-else class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">{{ t('employee.custom') }}</span>
          </div>
          <p class="mt-2 line-clamp-3 text-[13px] leading-relaxed text-[var(--muted)]">{{ displayDescription(employee) }}</p>
          <span class="mt-5 inline-block text-sm font-semibold text-[var(--accent)]">{{ t('employee.viewDetails') }} →</span>
        </button>

        <button
          class="flex min-h-[190px] flex-col items-center justify-center rounded-[18px] border border-dashed border-[var(--border)] bg-[var(--surface)]/60 p-5 text-center transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]/30"
          type="button"
          @click="openCreate"
        >
          <span class="grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-[var(--border)] text-xl text-[var(--muted)]">+</span>
          <strong class="mt-4 text-sm">{{ t('employee.create') }}</strong>
          <p class="mt-2 max-w-[14rem] text-xs leading-relaxed text-[var(--muted)]">{{ t('employee.createHint') }}</p>
        </button>
      </div>
    </template>

    <template v-else>
      <button class="mb-5 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" @click="selected = null">← {{ t('employee.backToDirectory') }}</button>

      <section class="rounded-[20px] border border-[var(--border)] bg-[var(--surface)] p-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex gap-4">
            <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xs font-extrabold text-white" :style="{ background: selectedEmployee.color }">{{ selectedEmployee.initials }}</span>
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-2xl font-bold">{{ displayName(selectedEmployee) }}</h2>
                <span v-if="selectedEmployee.system" class="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">{{ t('employee.system') }}</span>
                <span v-else-if="isPresetEmployee(selectedEmployee)" class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--muted)]">{{ t('employee.preset') }}</span>
                <span v-else class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">{{ t('employee.custom') }}</span>
              </div>
              <p class="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{{ displayDescription(selectedEmployee) }}</p>
              <p v-if="selectedEmployee.instructions" class="mt-2 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">
                <span class="font-semibold text-[var(--foreground)]">{{ t('employee.instructions') }}：</span>{{ selectedEmployee.instructions }}
              </p>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <button v-if="canEditSelected" class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold hover:border-[var(--accent)]" type="button" @click="openEdit(selectedEmployee)">
              {{ t('employee.edit') }}
            </button>
            <button v-if="canEditSelected" class="rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-500/10" type="button" @click="onDelete(selectedEmployee)">
              {{ t('employee.delete') }}
            </button>
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white" type="button" @click="emit('startChat', selectedEmployee.id)">{{ t('employee.start') }}</button>
          </div>
        </div>

        <p v-if="isPresetEmployee(selectedEmployee)" class="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--muted)]">
          {{ t('employee.presetLockedHelp') }}
        </p>

        <div class="mt-8 border-t border-[var(--border)] pt-6">
          <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">{{ t('employee.runtimeSection') }}</p>
          <h3 class="mt-1 text-lg font-bold">{{ t('employee.runtimeTitle') }}</h3>
          <p class="mt-1 text-sm text-[var(--muted)]">{{ t('employee.runtimeHelp') }}</p>

          <div class="mt-5 grid gap-4 sm:grid-cols-2">
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.defaultModel') }}</span>
              <select v-model="draftModelId" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                <option value="">{{ t('employee.modelInherit') }}</option>
                <option v-for="model in availableChatModels" :key="model.id" :value="model.id">{{ chatEndpointLabel(model) }}</option>
              </select>
              <span class="font-normal text-[11px]">{{ t('employee.modelInheritHelp') }}</span>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.searchMode') }}</span>
              <select v-model="draftSearchMode" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal">
                <option v-for="option in searchModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <span class="font-normal text-[11px]">{{ t('employee.searchModeHelp') }}</span>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)] sm:col-span-2">
              <span>{{ t('employee.maxSteps') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <input
                  v-model.number="draftMaxSteps"
                  class="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  type="number"
                  :min="MIN_MAX_STEPS"
                  :max="MAX_MAX_STEPS"
                />
                <span class="font-normal text-[11px]">{{ t('employee.maxStepsHelp', { def: DEFAULT_MAX_STEPS, min: MIN_MAX_STEPS, max: MAX_MAX_STEPS }) }}</span>
              </div>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.runTimeout') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <input
                  v-model.number="draftRunTimeoutSec"
                  class="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  type="number"
                  :min="Math.round(MIN_RUN_TIMEOUT_MS / 1000)"
                  :max="Math.round(MAX_RUN_TIMEOUT_MS / 1000)"
                  step="30"
                />
                <span class="font-normal text-[11px]">{{ t('employee.runTimeoutHelp', { def: Math.round(DEFAULT_RUN_TIMEOUT_MS / 1000), min: Math.round(MIN_RUN_TIMEOUT_MS / 1000), max: Math.round(MAX_RUN_TIMEOUT_MS / 1000) }) }}</span>
              </div>
            </label>

            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.mcpToolTimeout') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <input
                  v-model.number="draftMcpToolTimeoutSec"
                  class="w-28 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  type="number"
                  :min="Math.round(MIN_MCP_TOOL_TIMEOUT_MS / 1000)"
                  :max="Math.round(MAX_MCP_TOOL_TIMEOUT_MS / 1000)"
                  step="5"
                />
                <span class="font-normal text-[11px]">{{ t('employee.mcpToolTimeoutHelp', { def: Math.round(DEFAULT_MCP_TOOL_TIMEOUT_MS / 1000), min: Math.round(MIN_MCP_TOOL_TIMEOUT_MS / 1000), max: Math.round(MAX_MCP_TOOL_TIMEOUT_MS / 1000) }) }}</span>
              </div>
            </label>

            <div class="grid gap-1.5 text-xs font-semibold text-[var(--muted)] sm:col-span-2">
              <span>{{ t('employee.mcpTitle') }}</span>
              <p class="font-normal text-[11px]">{{ t('employee.mcpHelp') }}</p>
              <p v-if="!availableMcps.length" class="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 font-normal text-[var(--muted)]">
                {{ t('employee.mcpEmpty') }}
              </p>
              <template v-else-if="!useMcpModal">
                <div class="grid gap-2 sm:grid-cols-2">
                  <button
                    v-for="item in availableMcps"
                    :key="item.id"
                    type="button"
                    :class="[
                      'rounded-xl border px-3 py-3 text-left text-xs font-semibold transition',
                      draftMcpIds.includes(item.id)
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:border-[var(--accent)]/40',
                    ]"
                    @click="toggleMcp(item.id)"
                  >
                    <span class="block">{{ item.name }}</span>
                    <span class="mt-0.5 block truncate font-mono text-[10px] opacity-70">{{ mcpSummaryLine(item) }}</span>
                  </button>
                </div>
              </template>
              <template v-else>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
                    type="button"
                    @click="openMcpPicker"
                  >
                    {{ t('employee.mcpPick') }}
                  </button>
                  <span class="font-normal text-[11px] text-[var(--muted)]">
                    {{ t('employee.mcpSelectedCount', { n: selectedMcpItems.length }) }}
                  </span>
                </div>
                <div v-if="selectedMcpItems.length" class="mt-2 flex flex-wrap gap-2">
                  <span
                    v-for="item in selectedMcpItems"
                    :key="item.id"
                    class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--accent)]"
                  >
                    {{ item.name }}
                    <button class="text-sm leading-none opacity-70 hover:opacity-100" type="button" @click="removeSelectedMcp(item.id)">×</button>
                  </span>
                </div>
              </template>
            </div>

            <div class="grid gap-1.5 text-xs font-semibold text-[var(--muted)] sm:col-span-2">
              <span>{{ t('employee.kbTitle') }}</span>
              <p class="font-normal text-[11px]">{{ t('employee.kbHelp') }}</p>
              <label class="mt-1 grid gap-1.5 font-semibold">
                <span>{{ t('employee.kbProvider') }}</span>
                <select
                  v-model="draftKnowledgeProvider"
                  class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal"
                  @change="onKnowledgeProviderChange"
                >
                  <option v-for="option in knowledgeProviderOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <span class="font-normal text-[11px]">{{ t('employee.kbProviderHelp') }}</span>
              </label>
              <template v-if="draftKnowledgeProvider !== 'off'">
                <p class="mt-2 font-semibold">{{ t('employee.kbPick') }}</p>
                <p v-if="!availableKnowledgeBases.length" class="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 font-normal text-[var(--muted)]">
                  {{ t('employee.kbEmptyForProvider', { provider: knowledgeProviderMeta[draftKnowledgeProvider].label }) }}
                </p>
                <div v-else class="flex flex-wrap gap-2">
                  <button
                    v-for="item in availableKnowledgeBases"
                    :key="item.id"
                    type="button"
                    :class="[
                      'rounded-lg border px-3 py-2 text-left text-xs font-semibold transition',
                      draftKnowledgeBaseIds.includes(item.id)
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--muted)] hover:border-[var(--accent)]/40',
                    ]"
                    @click="toggleKnowledgeBase(item.id)"
                  >
                    <span class="block">{{ item.name }}</span>
                    <span class="mt-0.5 block truncate text-[10px] opacity-70">{{ item.description || item.id }}</span>
                  </button>
                </div>
              </template>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="button" :disabled="savingRuntime" @click="saveRuntime">
              {{ savingRuntime ? t('employee.saving') : t('employee.saveRuntime') }}
            </button>
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" type="button" :disabled="savingRuntime" @click="resetRuntime">
              {{ t('employee.resetRuntime') }}
            </button>
          </div>
        </div>

        <div class="mt-8 border-t border-[var(--border)] pt-6">
          <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">{{ t('employee.skillPolicy') }}</p>
          <h3 class="mt-1 text-lg font-bold">{{ t('employee.capabilityTitle') }}</h3>
          <p class="mt-1 text-sm text-[var(--muted)]">{{ t('employee.skillPolicyHelp') }}</p>
          <div class="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 px-4 py-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong class="text-sm">{{ t('employee.baselineSkill') }}</strong>
                <span class="ml-2 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--accent)]">{{ t('employee.system') }}</span>
                <p class="mt-1 text-xs text-[var(--muted)]">{{ baselineWorkspaceSkillMeta.description }}</p>
                <p class="mt-1 text-[11px] text-[var(--muted)]">{{ t('employee.baselineSkillTier') }}</p>
              </div>
              <span class="text-xs font-semibold text-emerald-600">{{ t('employee.baselineSkillAlways') }}</span>
            </div>
          </div>
          <div class="mt-3 divide-y divide-[var(--border)]">
            <div v-for="skill in skills" :key="skill.id" class="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <strong class="text-sm">{{ skill.name }}</strong>
                <p class="mt-1 text-xs text-[var(--muted)]">{{ skill.description }}</p>
              </div>
              <select
                class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2 text-xs"
                :value="mode(skill.id)"
                :disabled="savingSkillId === skill.id || Boolean(skill.systemOnly && selectedEmployee.id !== 'administrator')"
                @change="update(skill.id, $event)"
              >
                <option value="disabled">{{ t('employee.skillDisabled') }}</option>
                <option value="available">{{ t('employee.skillAvailable') }}</option>
                <option value="default">{{ t('employee.skillDefault') }}</option>
              </select>
            </div>
          </div>
        </div>
      </section>
    </template>

    <div v-if="formOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-5" @click.self="closeForm">
      <article class="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-[11px] font-extrabold tracking-[.12em] text-[var(--accent)]">EMPLOYEE · PROFILE</p>
            <h2 class="mt-1 text-xl font-bold">{{ editingId ? t('employee.edit') : t('employee.create') }}</h2>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('employee.formHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="closeForm">×</button>
        </div>

        <form class="mt-5 space-y-3" @submit.prevent="saveProfile">
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('employee.formName') }}</span>
            <input v-model.trim="draft.name" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required maxlength="48" />
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('employee.formDescription') }}</span>
            <textarea v-model.trim="draft.description" rows="3" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" required maxlength="240" />
          </label>
          <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            <span>{{ t('employee.formInstructions') }}</span>
            <textarea v-model.trim="draft.instructions" rows="3" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal" :placeholder="t('employee.formInstructionsHint')" maxlength="1200" />
          </label>
          <div class="grid gap-3 sm:grid-cols-[120px_1fr]">
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formInitials') }}</span>
              <input v-model.trim="draft.initials" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal uppercase" maxlength="4" />
            </label>
            <div class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('employee.formColor') }}</span>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="color in EMPLOYEE_COLOR_PRESETS"
                  :key="color"
                  type="button"
                  :class="['h-8 w-8 rounded-full border-2 transition', draft.color === color ? 'border-[var(--foreground)] scale-110' : 'border-transparent']"
                  :style="{ background: color }"
                  @click="draft.color = color"
                />
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-3">
            <span class="grid h-11 w-11 place-items-center rounded-xl text-[11px] font-extrabold text-white" :style="{ background: draft.color }">{{ (draft.initials || draft.name || 'AI').slice(0, 4) }}</span>
            <div class="min-w-0">
              <strong class="block truncate text-sm">{{ draft.name || t('employee.formName') }}</strong>
              <p class="truncate text-xs text-[var(--muted)]">{{ draft.description || t('employee.formDescription') }}</p>
            </div>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" type="button" @click="closeForm">{{ t('common.cancel') }}</button>
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" :disabled="savingProfile">
              {{ savingProfile ? t('employee.saving') : t('employee.saveProfile') }}
            </button>
          </div>
        </form>
      </article>
    </div>

    <div v-if="mcpPickerOpen" class="fixed inset-0 z-40 grid place-items-center bg-slate-950/40 p-5" @click.self="mcpPickerOpen = false">
      <article class="flex max-h-[min(85vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 class="text-lg font-bold">{{ t('employee.mcpPickTitle') }}</h2>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ t('employee.mcpPickHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="mcpPickerOpen = false">×</button>
        </header>
        <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          <button
            v-for="item in availableMcps"
            :key="item.id"
            type="button"
            :class="[
              'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
              mcpPickerDraft.includes(item.id)
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border)] hover:border-[var(--accent)]/40',
            ]"
            @click="toggleMcpPickerDraft(item.id)"
          >
            <span
              class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border text-[11px] font-bold"
              :class="mcpPickerDraft.includes(item.id) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)] text-transparent'"
            >✓</span>
            <span class="min-w-0 flex-1">
              <strong class="block text-sm">{{ item.name }}</strong>
              <span class="mt-0.5 block truncate font-mono text-[11px] text-[var(--muted)]">{{ mcpSummaryLine(item) }}</span>
            </span>
          </button>
        </div>
        <footer class="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--surface-muted)]/50 px-5 py-3">
          <span class="text-[11px] text-[var(--muted)]">{{ t('employee.mcpSelectedCount', { n: mcpPickerDraft.length }) }}</span>
          <div class="flex gap-2">
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-semibold" type="button" @click="mcpPickerOpen = false">{{ t('common.cancel') }}</button>
            <button class="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white" type="button" @click="confirmMcpPicker">{{ t('employee.mcpPickConfirm') }}</button>
          </div>
        </footer>
      </article>
    </div>
  </section>
</template>
