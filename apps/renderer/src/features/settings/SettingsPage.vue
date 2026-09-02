<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n, localeOptions, type Locale } from '../../app/i18n';
import { themeOptions, type ThemePreference, useTheme } from '../../app/theme';
import {
  providerDefaults,
  providerIds,
  providerNeedsApiKey,
  uniqueModels,
  useModelConfig,
  type ProviderId,
} from '../../app/model-config';
import type { Employee, EmployeeId } from '../../app/workspace';
import ChatModelsEditor from './ChatModelsEditor.vue';

const props = defineProps<{ employees: Employee[]; defaultEmployeeId: EmployeeId }>();
const emit = defineEmits<{ setDefaultEmployee: [id: EmployeeId] }>();
const { t, locale, setLocale } = useI18n();
const { preference, setTheme } = useTheme();
const { settings, load, save } = useModelConfig();
const saved = ref(false);
const error = ref('');
const languageLabel: Record<Locale, string> = { 'zh-CN': '简体中文', 'en-US': 'English' };

const active = computed(() => settings.value.providers.find((item) => item.provider === settings.value.activeProvider)!);
const optionalFields = [
  ['imageModel', 'settings.imageModel'],
  ['embeddingModel', 'settings.embeddingModel'],
  ['asrModel', 'settings.asrModel'],
  ['ttsModel', 'settings.ttsModel'],
] as const;

onMounted(load);

function selectProvider(id: ProviderId) {
  settings.value.activeProvider = id;
  saved.value = false;
}

function onModelsDirty() {
  saved.value = false;
}

async function saveConfig() {
  saved.value = false;
  error.value = '';
  try {
    if (!active.value.chatModel.trim()) throw new Error(t('settings.modelRequired'));
    if (providerNeedsApiKey(active.value.provider) && !active.value.apiKey.trim()) throw new Error(t('settings.modelRequired'));
    if (active.value.baseUrl) new URL(active.value.baseUrl);
    active.value.chatModels = uniqueModels([...active.value.chatModels, active.value.chatModel]);
    await save(settings.value);
    saved.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('settings.invalidConfig');
  }
}
</script>

<template>
  <section class="mx-auto w-full max-w-3xl px-6 py-16 sm:px-12">
    <header class="mb-10">
      <p class="mb-2 text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OPCAI / PREFERENCES</p>
      <h1 class="text-4xl font-bold tracking-[-.045em]">{{ t('settings.title') }}</h1>
      <p class="mt-3 max-w-xl leading-relaxed text-[var(--muted)]">{{ t('settings.subtitle') }}</p>
    </header>

    <section class="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-3 text-[17px] font-bold">{{ t('settings.appearance') }}</h2>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm"><strong>{{ t('settings.theme') }}</strong><select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="preference" @change="setTheme(($event.target as HTMLSelectElement).value as ThemePreference)"><option v-for="option in themeOptions" :key="option" :value="option">{{ t(`theme.${option}`) }}</option></select></label>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm"><strong>{{ t('settings.language') }}</strong><select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value as Locale)"><option v-for="option in localeOptions" :key="option" :value="option">{{ languageLabel[option] }}</option></select></label>
    </section>

    <section class="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="text-[17px] font-bold">{{ t('settings.modelTitle') }}</h2>
      <p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.modelHelp') }}</p>

      <div class="mt-5 flex flex-wrap gap-2">
        <button v-for="id in providerIds" :key="id" :class="['rounded-lg border px-2.5 py-2 text-xs transition', settings.activeProvider === id ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-bold text-[var(--accent)]' : 'border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/40']" type="button" @click="selectProvider(id)">{{ t(`provider.${id}`) }}</button>
      </div>

      <form class="mt-6 space-y-6" @submit.prevent="saveConfig">
        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/30 p-4">
          <p class="text-xs font-bold uppercase tracking-[.08em] text-[var(--muted)]">{{ t('settings.connectionSection') }}</p>
          <div class="mt-3 grid gap-3.5">
            <label class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.baseUrl') }}</span>
              <input v-model.trim="active.baseUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]" type="text" :placeholder="providerDefaults[active.provider].baseUrl || t('settings.baseUrlHint')" />
            </label>
            <label v-if="providerNeedsApiKey(active.provider)" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t('settings.apiKey') }}</span>
              <input v-model="active.apiKey" class="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]" type="password" autocomplete="off" placeholder="sk-…" />
            </label>
            <p v-else class="text-xs leading-relaxed text-[var(--muted)]">{{ t('settings.ollamaKeyHint') }}</p>
            <label class="flex cursor-pointer items-start gap-3 border-t border-[var(--border)] pt-3 text-xs">
              <input v-model="active.disableThinking" class="mt-0.5" type="checkbox" @change="onModelsDirty" />
              <span>
                <strong class="font-semibold text-[var(--text)]">{{ t('settings.disableThinking') }}</strong>
                <span class="mt-1 block leading-relaxed text-[var(--muted)]">{{ t('settings.disableThinkingHelp') }}</span>
              </span>
            </label>
          </div>
        </div>

        <ChatModelsEditor
          :provider="active.provider"
          :base-url="active.baseUrl"
          v-model:chat-model="active.chatModel"
          v-model:chat-models="active.chatModels"
          @dirty="onModelsDirty"
        />

        <details class="rounded-xl border border-[var(--border)] p-4">
          <summary class="cursor-pointer text-sm font-semibold">{{ t('settings.advancedModels') }}</summary>
          <div class="mt-4 grid gap-3.5">
            <label v-for="field in optionalFields" :key="field[0]" class="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
              <span>{{ t(field[1]) }}</span>
              <input v-model.trim="active[field[0]]" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm font-normal outline-none focus:border-[var(--accent)]" type="text" :placeholder="t('settings.optional')" />
            </label>
          </div>
        </details>

        <p class="text-xs leading-relaxed text-[var(--muted)]">{{ t('settings.capabilityNote') }}</p>
        <div class="flex items-center justify-between gap-3">
          <span v-if="saved" class="text-[13px] text-emerald-600">{{ t('settings.saved') }}</span>
          <span v-else-if="error" class="text-[13px] text-rose-600">{{ error }}</span>
          <span v-else></span>
          <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="submit">{{ t('settings.save') }}</button>
        </div>
      </form>
    </section>

    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-3 text-[17px] font-bold">{{ t('settings.defaultEmployee') }}</h2>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('common.chooseEmployee') }}</strong>
        <select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="props.defaultEmployeeId" @change="emit('setDefaultEmployee', ($event.target as HTMLSelectElement).value as EmployeeId)">
          <option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ t(employee.nameKey) }}</option>
        </select>
      </label>
    </section>
  </section>
</template>
