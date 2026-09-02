<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../app/i18n';
import {
  ollamaLibraryCatalog,
  ollamaLocalModelNames,
  providerDefaults,
  providerSuggestedChatModels,
  uniqueModels,
  type ProviderId,
} from '../../app/model-config';

const props = defineProps<{
  provider: ProviderId;
  baseUrl: string;
  chatModel: string;
  chatModels: string[];
}>();

const emit = defineEmits<{
  'update:chatModel': [value: string];
  'update:chatModels': [value: string[]];
  dirty: [];
}>();

const { t } = useI18n();

const pickerOpen = ref(false);
const search = ref('');
const manualId = ref('');
const listError = ref('');
const ollamaLocal = ref<string[]>([]);
const ollamaLoading = ref(false);
const pullingModel = ref('');

const modelRows = computed(() => uniqueModels([...props.chatModels, props.chatModel]));

function emitModels(next: string[], defaultModel?: string) {
  const models = uniqueModels(next);
  emit('update:chatModels', models);
  if (defaultModel !== undefined) emit('update:chatModel', defaultModel);
  emit('dirty');
}

function setDefault(model: string) {
  emit('update:chatModel', model);
  emitModels(uniqueModels([...props.chatModels, model]), model);
}

function removeModel(model: string) {
  const next = modelRows.value.filter((item) => item !== model);
  const fallback = next[0] || providerDefaults[props.provider].chatModel;
  emitModels(next, props.chatModel === model ? fallback : props.chatModel);
}

function renameModel(oldId: string, newId: string) {
  const trimmed = newId.trim();
  if (!trimmed || trimmed === oldId) return;
  if (modelRows.value.includes(trimmed)) return;
  const next = modelRows.value.map((item) => (item === oldId ? trimmed : item));
  const defaultModel = props.chatModel === oldId ? trimmed : props.chatModel;
  emitModels(next, defaultModel);
}

function addModel(id: string, makeDefault = true) {
  const model = id.trim();
  if (!model) return;
  if (modelRows.value.includes(model)) {
    if (makeDefault) setDefault(model);
    return;
  }
  const next = uniqueModels([...modelRows.value, model]);
  emitModels(next, makeDefault ? model : props.chatModel);
}

function ollamaInstalled(name: string) {
  const base = name.split(':')[0].toLowerCase();
  return ollamaLocal.value.some((item) => item === name || item.split(':')[0].toLowerCase() === base);
}

async function refreshOllamaLocal() {
  if (props.provider !== 'ollama') return;
  listError.value = '';
  ollamaLoading.value = true;
  try {
    if (!window.opcaiDesktop?.listOllamaModels) {
      ollamaLocal.value = [];
      return;
    }
    ollamaLocal.value = await window.opcaiDesktop.listOllamaModels(props.baseUrl);
    ollamaLocalModelNames.value = ollamaLocal.value;
  } catch (cause) {
    ollamaLocal.value = [];
    listError.value = cause instanceof Error ? cause.message : t('settings.invalidConfig');
  } finally {
    ollamaLoading.value = false;
  }
}

async function openPicker() {
  pickerOpen.value = true;
  search.value = '';
  manualId.value = '';
  listError.value = '';
  if (props.provider === 'ollama') await refreshOllamaLocal();
}

const pickerCandidates = computed(() => {
  const q = search.value.trim().toLowerCase();
  const selected = new Set(modelRows.value);
  if (props.provider === 'ollama') {
    const local = ollamaLocal.value.filter((item) => !selected.has(item) && (!q || item.toLowerCase().includes(q)));
    const catalog = ollamaLibraryCatalog.filter((item) => {
      if (selected.has(item)) return false;
      if (q && !item.toLowerCase().includes(q)) return false;
      return !ollamaInstalled(item);
    });
    const merged = uniqueModels([...local, ...catalog]);
    return merged.map((name) => ({ name, installed: ollamaInstalled(name) }));
  }
  const suggestions = providerSuggestedChatModels[props.provider] ?? [];
  return uniqueModels(suggestions)
    .filter((item) => !selected.has(item) && (!q || item.toLowerCase().includes(q)))
    .map((name) => ({ name, installed: true as const }));
});

async function pullAndAdd(name: string) {
  if (!window.opcaiDesktop?.pullOllamaModel) {
    listError.value = t('settings.ollamaDesktopOnly');
    return;
  }
  pullingModel.value = name;
  listError.value = '';
  try {
    await window.opcaiDesktop.pullOllamaModel(props.baseUrl, name);
    await refreshOllamaLocal();
    addModel(name, true);
  } catch (cause) {
    listError.value = cause instanceof Error ? cause.message : t('settings.ollamaPullFailed');
  } finally {
    pullingModel.value = '';
  }
}

function pickCandidate(name: string, installed: boolean) {
  if (props.provider === 'ollama' && !installed) {
    void pullAndAdd(name);
    return;
  }
  addModel(name, true);
  pickerOpen.value = false;
}

function confirmManual() {
  const id = manualId.value.trim();
  if (!id) return;
  if (props.provider === 'ollama' && !ollamaInstalled(id)) {
    void pullAndAdd(id).then(() => {
      manualId.value = '';
    });
    return;
  }
  addModel(id, true);
  manualId.value = '';
  if (props.provider !== 'ollama') pickerOpen.value = false;
}

watch(
  () => [props.provider, props.baseUrl] as const,
  () => {
    if (props.provider === 'ollama') void refreshOllamaLocal();
  },
  { immediate: true },
);
</script>

<template>
  <div class="rounded-xl border border-[var(--border)] p-4">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p class="text-xs font-bold uppercase tracking-[.08em] text-[var(--muted)]">{{ t('settings.chatModelsSection') }}</p>
        <p class="mt-1 text-xs text-[var(--muted)]">{{ t('settings.chatModelsHelp') }}</p>
      </div>
      <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--accent)]" type="button" @click="openPicker">{{ t('settings.chatModelPick') }}</button>
    </div>

    <div v-if="modelRows.length" class="mt-4 overflow-hidden rounded-lg border border-[var(--border)]">
      <div class="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)]/50 px-3 py-2 text-[10px] font-bold uppercase tracking-[.06em] text-[var(--muted)] sm:grid-cols-[1fr_auto_auto_auto]">
        <span>{{ t('settings.chatModelIdColumn') }}</span>
        <span v-if="provider === 'ollama'" class="hidden sm:block">{{ t('settings.chatModelStatusColumn') }}</span>
        <span>{{ t('settings.chatModelDefaultColumn') }}</span>
        <span></span>
      </div>
      <div
        v-for="model in modelRows"
        :key="model"
        class="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-t border-[var(--border)] px-3 py-2 first:border-t-0 sm:grid-cols-[1fr_auto_auto_auto]"
      >
        <input
          :value="model"
          class="min-w-0 rounded-md border border-transparent bg-transparent px-1 py-1 text-sm font-medium outline-none focus:border-[var(--accent)] focus:bg-[var(--surface-muted)]"
          type="text"
          @change="renameModel(model, ($event.target as HTMLInputElement).value)"
        />
        <span v-if="provider === 'ollama'" class="hidden text-[11px] sm:block">
          <span v-if="ollamaLoading" class="text-[var(--muted)]">…</span>
          <span v-else-if="ollamaInstalled(model)" class="text-emerald-600">{{ t('settings.ollamaInstalled') }}</span>
          <button
            v-else
            class="text-[var(--accent)] underline-offset-2 hover:underline"
            type="button"
            :disabled="pullingModel === model"
            @click="pullAndAdd(model)"
          >
            {{ pullingModel === model ? t('settings.ollamaPulling') : t('settings.ollamaPull') }}
          </button>
        </span>
        <label class="flex cursor-pointer items-center gap-1.5 text-xs">
          <input :checked="chatModel === model" name="default-chat-model" type="radio" @change="setDefault(model)" />
          <span class="text-[var(--muted)]">{{ t('settings.activeModel') }}</span>
        </label>
        <button class="rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-rose-600" type="button" :title="t('settings.chatModelRemove')" @click="removeModel(model)">×</button>
      </div>
    </div>
    <p v-else class="mt-4 text-xs text-[var(--muted)]">{{ t('settings.chatModelsEmpty') }}</p>

    <p v-if="provider === 'ollama' && listError && !pickerOpen" class="mt-2 text-xs text-rose-600">{{ listError }}</p>

    <div v-if="pickerOpen" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" @click.self="pickerOpen = false">
      <article class="flex max-h-[min(85vh,640px)] w-full max-w-lg flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h3 class="text-lg font-bold">{{ t('settings.chatModelPickerTitle') }}</h3>
            <p class="mt-1 text-xs text-[var(--muted)]">{{ provider === 'ollama' ? t('settings.chatModelPickerOllamaHelp') : t('settings.chatModelPickerHelp') }}</p>
          </div>
          <button class="text-xl text-[var(--muted)]" type="button" @click="pickerOpen = false">×</button>
        </header>

        <div class="space-y-3 border-b border-[var(--border)] px-5 py-4">
          <input
            v-model="search"
            class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            type="search"
            :placeholder="provider === 'ollama' ? t('settings.chatModelSearchOllama') : t('settings.chatModelSearch')"
            @keydown.enter.prevent
          />
          <button
            v-if="provider === 'ollama'"
            class="text-xs font-semibold text-[var(--accent)]"
            type="button"
            :disabled="ollamaLoading"
            @click="refreshOllamaLocal"
          >
            {{ ollamaLoading ? t('settings.ollamaLoading') : t('settings.ollamaRefreshLocal') }}
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <p v-if="listError" class="mb-2 text-xs text-rose-600">{{ listError }}</p>
          <ul v-if="pickerCandidates.length" class="space-y-1">
            <li v-for="item in pickerCandidates" :key="item.name">
              <button
                class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--surface-muted)]"
                type="button"
                :disabled="pullingModel === item.name"
                @click="pickCandidate(item.name, item.installed)"
              >
                <span class="truncate font-medium">{{ item.name }}</span>
                <span v-if="provider === 'ollama'" class="shrink-0 text-[11px]">
                  <span v-if="item.installed" class="text-emerald-600">{{ t('settings.ollamaInstalled') }}</span>
                  <span v-else class="text-[var(--accent)]">{{ pullingModel === item.name ? t('settings.ollamaPulling') : t('settings.ollamaPullAdd') }}</span>
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="py-6 text-center text-xs text-[var(--muted)]">{{ t('settings.chatModelSearchEmpty') }}</p>
        </div>

        <footer class="border-t border-[var(--border)] px-5 py-4">
          <p class="mb-2 text-xs font-semibold text-[var(--muted)]">{{ t('settings.chatModelManual') }}</p>
          <div class="flex gap-2">
            <input
              v-model="manualId"
              class="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              type="text"
              :placeholder="t('settings.chatModelCustomPlaceholder')"
              @keydown.enter.prevent="confirmManual"
            />
            <button class="shrink-0 rounded-lg bg-[var(--text)] px-3 py-2 text-xs font-semibold text-[var(--surface)]" type="button" @click="confirmManual">{{ t('settings.chatModelAdd') }}</button>
          </div>
        </footer>
      </article>
    </div>
  </div>
</template>
