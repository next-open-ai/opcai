<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n, localeOptions, type Locale } from '../../app/i18n';
import { themeOptions, type ThemePreference, useTheme } from '../../app/theme';
import { useModelConfig, type ModelSettings } from '../../app/model-config';
import type { Employee, EmployeeId } from '../../app/workspace';
import { employeeDisplayName } from '../../app/employees';
import ProviderInstancesEditor from './ProviderInstancesEditor.vue';
import EnvironmentSettingsCard from './EnvironmentSettingsCard.vue';
import ConfiguredModelsEditor from './ConfiguredModelsEditor.vue';
import UsageStatsPanel from './UsageStatsPanel.vue';
import { searchProviderIds, useSearchConfig, type SearchProviderId } from '../../app/search-config';
import { knowledgeProviderMeta, useKnowledgeConfig } from '../../app/kb-config';
import { useNotify } from '../../app/notify';

const props = defineProps<{ employees: Employee[]; defaultEmployeeId: EmployeeId }>();
const emit = defineEmits<{ setDefaultEmployee: [id: EmployeeId]; openEnvironment: []; openCheck: [] }>();
const { t, locale, setLocale } = useI18n();
const { preference, setTheme } = useTheme();
const { settings, load, save } = useModelConfig();
const { settings: searchSettings, load: loadSearch, save: saveSearch, defaults: searchDefaults } = useSearchConfig();
const {
  providerSettings: knowledgeProviderSettings,
  loadProviders: loadKnowledgeProviders,
  saveProviders: saveKnowledgeProviders,
} = useKnowledgeConfig();
const notify = useNotify();
const dirty = ref(false);
const languageLabel: Record<Locale, string> = { 'zh-CN': '简体中文', 'en-US': 'English' };
type SettingsTab = 'appearance' | 'providers' | 'models' | 'search' | 'knowledge' | 'usage' | 'environment' | 'general';
const tab = ref<SettingsTab>('providers');
const tabs: Array<{ id: SettingsTab; labelKey: string }> = [
  { id: 'appearance', labelKey: 'settings.tabAppearance' },
  { id: 'providers', labelKey: 'settings.tabProviders' },
  { id: 'models', labelKey: 'settings.tabModels' },
  { id: 'search', labelKey: 'settings.tabSearch' },
  { id: 'knowledge', labelKey: 'settings.tabKnowledge' },
  { id: 'usage', labelKey: 'settings.tabUsage' },
  { id: 'environment', labelKey: 'settings.tabEnvironment' },
  { id: 'general', labelKey: 'settings.tabGeneral' },
];

onMounted(() => { void load(); void loadSearch(); void loadKnowledgeProviders(); });

function onDirty() {
  dirty.value = true;
}

async function saveModelConfig() {
  try {
    const next: ModelSettings = JSON.parse(JSON.stringify(settings.value));
    const instanceIds = new Set(next.providerInstances.map((item) => item.id));
    next.models = next.models.filter((item) => instanceIds.has(item.providerInstanceId) && item.modelId.trim());
    if (next.activeChatModelId && !next.models.some((item) => item.id === next.activeChatModelId && item.capability === 'chat')) {
      next.activeChatModelId = next.models.find((item) => item.capability === 'chat')?.id ?? null;
    }
    for (const [employeeId, modelId] of Object.entries(next.employeeDefaultModelIds)) {
      if (!next.models.some((item) => item.id === modelId && item.capability === 'chat')) delete next.employeeDefaultModelIds[employeeId];
    }
    await save(next);
    dirty.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function saveSearchConfig() {
  try {
    await saveSearch();
    dirty.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

async function saveKnowledgeProviderConfig() {
  try {
    await saveKnowledgeProviders();
    dirty.value = false;
    notify.success('notify.saved');
  } catch (cause) {
    notify.error(cause, 'notify.saveFailed');
  }
}

function resetSearchEndpoint(id: SearchProviderId) {
  const item = searchSettings.value.providers.find((provider) => provider.id === id);
  if (item) item.baseUrl = searchDefaults[id].baseUrl;
  onDirty();
}
</script>

<template>
  <section class="mx-auto w-full max-w-3xl px-6 py-16 sm:px-12">
    <header class="mb-8">
      <p class="mb-2 text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OPCAI / PREFERENCES</p>
      <h1 class="text-4xl font-bold tracking-[-.045em]">{{ t('settings.title') }}</h1>
      <p class="mt-3 max-w-xl leading-relaxed text-[var(--muted)]">{{ t('settings.subtitleTabs') }}</p>
    </header>

    <nav class="mb-5 flex flex-wrap gap-2 border-b border-[var(--border)] pb-3">
      <button
        v-for="item in tabs"
        :key="item.id"
        :class="[
          'rounded-lg px-3 py-2 text-xs font-semibold transition',
          tab === item.id ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]',
        ]"
        type="button"
        @click="tab = item.id"
      >
        {{ t(item.labelKey) }}
      </button>
    </nav>

    <section v-if="tab === 'appearance'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-3 text-[17px] font-bold">{{ t('settings.appearance') }}</h2>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('settings.theme') }}</strong>
        <select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="preference" @change="setTheme(($event.target as HTMLSelectElement).value as ThemePreference)">
          <option v-for="option in themeOptions" :key="option" :value="option">{{ t(`theme.${option}`) }}</option>
        </select>
      </label>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('settings.language') }}</strong>
        <select class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2" :value="locale" @change="setLocale(($event.target as HTMLSelectElement).value as Locale)">
          <option v-for="option in localeOptions" :key="option" :value="option">{{ languageLabel[option] }}</option>
        </select>
      </label>
    </section>

    <section v-else-if="tab === 'providers'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="text-[17px] font-bold">{{ t('settings.tabProviders') }}</h2>
      <p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.providersHelp') }}</p>
      <div class="mt-6">
        <ProviderInstancesEditor
          :instances="settings.providerInstances"
          @update:instances="settings.providerInstances = $event"
          @dirty="onDirty"
        />
      </div>
      <div class="mt-6 flex items-center justify-between gap-3">
        <span class="text-[13px] text-[var(--muted)]">{{ dirty ? t('settings.saveHint') : t('settings.tabProvidersHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveModelConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <section v-else-if="tab === 'models'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="text-[17px] font-bold">{{ t('settings.tabModels') }}</h2>
      <p class="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.configuredModelsHelp') }}</p>
      <div class="mt-6">
        <ConfiguredModelsEditor
          :instances="settings.providerInstances"
          :models="settings.models"
          :active-chat-model-id="settings.activeChatModelId"
          @update:models="settings.models = $event"
          @update:active-chat-model-id="settings.activeChatModelId = $event"
          @dirty="onDirty"
        />
      </div>
      <div class="mt-6 flex items-center justify-between gap-3">
        <span class="text-[13px] text-[var(--muted)]">{{ dirty ? t('settings.saveHint') : t('settings.tabModelsHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveModelConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <section v-else-if="tab === 'search'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-[17px] font-bold">{{ t('settings.tabSearch') }}</h2>
          <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.searchHelp') }}</p>
        </div>
        <select v-model="searchSettings.defaultProvider" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" @change="onDirty">
          <option value="auto">{{ t('settings.searchAuto') }}</option>
          <option v-for="id in searchProviderIds" :key="id" :value="id">{{ searchSettings.providers.find((item) => item.id === id)?.label }}</option>
        </select>
      </div>
      <div class="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <article v-for="provider in searchSettings.providers" :key="provider.id" class="py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="flex items-center gap-2 text-sm font-bold"><input v-model="provider.enabled" type="checkbox" @change="onDirty" />{{ provider.label }}</label>
            <span class="text-xs text-[var(--muted)]">{{ provider.id === 'aliyun' ? t('settings.searchAliyunHint') : t('settings.searchEndpointHint') }}</span>
          </div>
          <div class="mt-3 grid gap-2 sm:grid-cols-[1fr_1.25fr_auto]">
            <input v-model="provider.apiKey" type="password" autocomplete="off" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" :placeholder="t('settings.apiKey')" @input="onDirty" />
            <input v-model="provider.baseUrl" class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm" placeholder="Endpoint" @input="onDirty" />
            <button class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold" type="button" @click="resetSearchEndpoint(provider.id)">{{ t('settings.searchReset') }}</button>
          </div>
        </article>
      </div>
      <div class="mt-5 flex items-center justify-between gap-3">
        <span class="text-xs text-[var(--muted)]">{{ t('settings.searchSaveHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveSearchConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <section v-else-if="tab === 'knowledge'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <div>
        <h2 class="text-[17px] font-bold">{{ t('settings.tabKnowledge') }}</h2>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.knowledgeHelp') }}</p>
      </div>
      <div class="mt-5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
        <article v-for="provider in knowledgeProviderSettings.providers" :key="provider.id" class="py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="flex items-center gap-2 text-sm font-bold">
              <input
                v-model="provider.enabled"
                type="checkbox"
                :disabled="provider.id === 'lancedb'"
                @change="onDirty"
              />
              {{ knowledgeProviderMeta[provider.id].label }}
            </label>
            <span class="text-xs text-[var(--muted)]">
              {{ provider.id === 'lancedb' ? t('settings.knowledgeLocalHint') : t('settings.knowledgeCloudHint') }}
            </span>
          </div>
          <div v-if="provider.id !== 'lancedb'" class="mt-3 grid gap-2 sm:grid-cols-2">
            <input
              v-model="provider.defaultApiKey"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="provider.id === 'bailian' ? t('settings.knowledgeBailianApiKey') : t('settings.knowledgeDefaultApiKey')"
              @input="onDirty"
            />
            <input
              v-model="provider.defaultBaseUrl"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="t('settings.knowledgeDefaultBaseUrl')"
              @input="onDirty"
            />
          </div>
          <div v-if="provider.id === 'bailian'" class="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              v-model="provider.defaultWorkspaceId"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm sm:col-span-2"
              :placeholder="t('settings.knowledgeBailianWorkspace')"
              @input="onDirty"
            />
            <input
              v-model="provider.defaultAccessKeyId"
              autocomplete="off"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="t('settings.knowledgeBailianAccessKeyId')"
              @input="onDirty"
            />
            <input
              v-model="provider.defaultAccessKeySecret"
              type="password"
              autocomplete="off"
              class="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm"
              :placeholder="t('settings.knowledgeBailianAccessKeySecret')"
              @input="onDirty"
            />
            <p class="sm:col-span-2 text-[11px] leading-relaxed text-[var(--muted)]">{{ t('settings.knowledgeBailianSharedHint') }}</p>
          </div>
        </article>
      </div>
      <div class="mt-5 flex items-center justify-between gap-3">
        <span class="text-xs text-[var(--muted)]">{{ t('settings.knowledgeSaveHint') }}</span>
        <button class="rounded-lg bg-[var(--accent)] px-3 py-2.5 text-[13px] font-semibold text-white" type="button" @click="saveKnowledgeProviderConfig">{{ t('settings.save') }}</button>
      </div>
    </section>

    <section v-else-if="tab === 'environment'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-4 text-[17px] font-bold">{{ t('settings.tabEnvironment') }}</h2>
      <EnvironmentSettingsCard @open-environment="emit('openEnvironment')" @open-check="emit('openCheck')" />
    </section>

    <section v-else-if="tab === 'usage'" class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <UsageStatsPanel />
    </section>

    <section v-else class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
      <h2 class="mb-1 text-[17px] font-bold">{{ t('settings.defaultEmployee') }}</h2>
      <p class="mb-3 text-[13px] leading-relaxed text-[var(--muted)]">{{ t('settings.employeeRuntimeMoved') }}</p>
      <label class="flex items-center justify-between gap-6 border-t border-[var(--border)] py-4 text-sm">
        <strong>{{ t('common.chooseEmployee') }}</strong>
        <select
          class="min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-2"
          :value="props.defaultEmployeeId"
          @change="emit('setDefaultEmployee', ($event.target as HTMLSelectElement).value as EmployeeId)"
        >
          <option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employeeDisplayName(employee, t) }}</option>
        </select>
      </label>
    </section>
  </section>
</template>
