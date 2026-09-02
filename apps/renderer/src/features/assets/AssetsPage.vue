<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useAssets, type Asset } from '../../app/assets';
import { useI18n } from '../../app/i18n';
import type { Conversation } from '../../app/workspace';

const props = defineProps<{ conversations: Conversation[] }>();
const emit = defineEmits<{ openConversation: [id: string] }>();

const { t } = useI18n();
const { assets, loading, loadAssets } = useAssets();
const query = ref('');
const type = ref('all');
const selected = ref<Asset | null>(null);
const showTechnical = ref(false);
const copied = ref('');

const filtered = computed(() =>
  assets.value.filter(
    (asset) =>
      (type.value === 'all' || asset.name.toLowerCase().endsWith(`.${type.value}`)) &&
      asset.name.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
const types = computed(
  () => [...new Set(assets.value.map((asset) => asset.name.split('.').pop()?.toLowerCase()).filter(Boolean))] as string[],
);

watch(
  filtered,
  (list) => {
    if (!list.length) {
      selected.value = null;
      return;
    }
    if (!selected.value || !list.some((item) => item.id === selected.value?.id)) selected.value = list[0];
  },
  { immediate: true },
);

type FileKind = 'pdf' | 'image' | 'sheet' | 'doc' | 'code' | 'file';

function fileKind(asset: Asset): FileKind {
  const ext = asset.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return 'pdf';
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return 'image';
  if (/^(xlsx?|csv|tsv)$/.test(ext)) return 'sheet';
  if (/^(docx?|md|txt|rtf)$/.test(ext)) return 'doc';
  if (/^(ts|js|py|json|ya?ml|html|css)$/.test(ext)) return 'code';
  return 'file';
}

function kindStyle(kind: FileKind) {
  const map: Record<FileKind, { gradient: string; badge: string; icon: string }> = {
    pdf: { gradient: 'from-rose-500/20 via-orange-400/10 to-[var(--surface)]', badge: 'bg-rose-500/15 text-rose-700 dark:text-rose-300', icon: '📄' },
    image: { gradient: 'from-violet-500/20 via-fuchsia-400/10 to-[var(--surface)]', badge: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', icon: '🖼' },
    sheet: { gradient: 'from-emerald-500/20 via-teal-400/10 to-[var(--surface)]', badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', icon: '📊' },
    doc: { gradient: 'from-sky-500/20 via-blue-400/10 to-[var(--surface)]', badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', icon: '📝' },
    code: { gradient: 'from-amber-500/20 via-yellow-400/10 to-[var(--surface)]', badge: 'bg-amber-500/15 text-amber-800 dark:text-amber-200', icon: '{ }' },
    file: { gradient: 'from-slate-400/15 to-[var(--surface)]', badge: 'bg-[var(--surface-muted)] text-[var(--muted)]', icon: '📁' },
  };
  return map[kind];
}

function typeLabel(asset: Asset) {
  return asset.name.split('.').pop()?.toUpperCase() || 'FILE';
}

function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function employeeName(id: string | null) {
  if (!id) return t('assets.employeeUnknown');
  const key = `employee.${id}.name`;
  const label = t(key);
  return label === key ? id : label;
}

function conversationTitle(id: string | null) {
  if (!id) return null;
  return props.conversations.find((item) => item.id === id)?.title ?? null;
}

function shortId(value: string) {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

async function copyText(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = label;
    window.setTimeout(() => {
      if (copied.value === label) copied.value = '';
    }, 1600);
  } catch {
    /* clipboard unavailable */
  }
}

async function download(asset: Asset) {
  await window.opcaiDesktop?.saveAsset(asset.id);
}

async function reveal(asset: Asset) {
  await window.opcaiDesktop?.revealAsset(asset.id);
}

onMounted(loadAssets);
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-6 py-10 sm:px-12 sm:py-12">
      <header class="shrink-0">
        <p class="text-[11px] font-extrabold tracking-[.13em] text-[var(--accent)]">OPCAI / ASSETS</p>
        <div class="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 class="text-4xl font-bold tracking-[-.045em]">{{ t('assets.title') }}</h1>
            <p class="mt-3 max-w-2xl text-[var(--muted)]">{{ t('assets.subtitle') }}</p>
          </div>
          <button
            class="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--accent)]"
            type="button"
            @click="loadAssets"
          >
            {{ loading ? t('assets.refreshing') : t('assets.refresh') }}
          </button>
        </div>
      </header>

      <div class="mt-6 flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-5">
        <!-- 列表区：Finder / Mail 式主栏 -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <div class="shrink-0 border-b border-[var(--border)] p-4">
            <input
              v-model="query"
              class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
              :placeholder="t('assets.search')"
            />
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                :class="['rounded-lg px-3 py-1.5 text-xs font-semibold transition', type === 'all' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]']"
                type="button"
                @click="type = 'all'"
              >
                {{ t('assets.filterAll') }} · {{ assets.length }}
              </button>
              <button
                v-for="item in types"
                :key="item"
                :class="['rounded-lg px-3 py-1.5 text-xs font-semibold uppercase transition', type === item ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]']"
                type="button"
                @click="type = item"
              >
                {{ item }}
              </button>
            </div>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div v-if="!filtered.length" class="flex flex-col items-center justify-center px-6 py-16 text-center">
              <span class="grid h-14 w-14 place-items-center rounded-2xl bg-[var(--surface-muted)] text-2xl">📂</span>
              <p class="mt-4 text-sm font-medium">{{ t('assets.emptyTitle') }}</p>
              <p class="mt-1 max-w-xs text-xs leading-relaxed text-[var(--muted)]">{{ t('assets.emptyHint') }}</p>
            </div>
            <ul v-else class="p-2">
              <li v-for="asset in filtered" :key="asset.id">
                <button
                  :class="[
                    'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition',
                    selected?.id === asset.id
                      ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/25'
                      : 'hover:bg-[var(--surface-muted)]',
                  ]"
                  type="button"
                  @click="selected = asset"
                >
                  <span
                    :class="['grid h-11 w-11 shrink-0 place-items-center rounded-xl text-xs font-extrabold', kindStyle(fileKind(asset)).badge]"
                  >
                    {{ typeLabel(asset) }}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-semibold">{{ asset.name }}</span>
                    <span class="mt-0.5 block truncate text-xs text-[var(--muted)]">
                      {{ formatDate(asset.createdAt) }} · {{ formatBytes(asset.sizeBytes) }} · {{ employeeName(asset.employeeId) }}
                    </span>
                  </span>
                  <span
                    :class="['h-2 w-2 shrink-0 rounded-full', selected?.id === asset.id ? 'bg-[var(--accent)]' : 'bg-transparent']"
                    aria-hidden="true"
                  />
                </button>
              </li>
            </ul>
          </div>
        </div>

        <!-- 检查器：预览头 + 元数据 + 底栏操作（类似 macOS Inspector） -->
        <aside
          class="flex w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm lg:w-[340px] xl:w-[380px]"
        >
          <template v-if="selected">
            <div
              :class="['relative shrink-0 bg-gradient-to-br px-6 pb-8 pt-6', kindStyle(fileKind(selected)).gradient]"
            >
              <span
                :class="['inline-flex rounded-lg px-2 py-1 text-[10px] font-bold tracking-wide', kindStyle(fileKind(selected)).badge]"
              >
                {{ typeLabel(selected) }}
              </span>
              <p class="mt-6 text-4xl leading-none" aria-hidden="true">{{ kindStyle(fileKind(selected)).icon }}</p>
              <h2 class="mt-4 break-words text-lg font-bold leading-snug">{{ selected.name }}</h2>
              <p class="mt-2 text-xs text-[var(--muted)]">{{ formatBytes(selected.sizeBytes) }} · {{ selected.mimeType || t('assets.mimeUnknown') }}</p>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
              <p class="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{{ t('assets.sectionInfo') }}</p>
              <dl class="mt-3 divide-y divide-[var(--border)] text-sm">
                <div class="flex items-start justify-between gap-3 py-3">
                  <dt class="text-[var(--muted)]">{{ t('assets.createdAt') }}</dt>
                  <dd class="text-right font-medium">{{ formatDate(selected.createdAt) }}</dd>
                </div>
                <div class="flex items-start justify-between gap-3 py-3">
                  <dt class="text-[var(--muted)]">{{ t('assets.fromEmployee') }}</dt>
                  <dd class="text-right font-medium">{{ employeeName(selected.employeeId) }}</dd>
                </div>
                <div class="py-3">
                  <dt class="text-[var(--muted)]">{{ t('assets.fromConversation') }}</dt>
                  <dd class="mt-2">
                    <template v-if="selected.conversationId">
                      <p class="font-medium">{{ conversationTitle(selected.conversationId) || t('assets.unnamedConversation') }}</p>
                      <button
                        class="mt-2 text-xs font-semibold text-[var(--accent)] hover:underline"
                        type="button"
                        @click="selected.conversationId && emit('openConversation', selected.conversationId)"
                      >
                        {{ t('assets.openConversation') }} →
                      </button>
                    </template>
                    <p v-else class="text-[var(--muted)]">—</p>
                  </dd>
                </div>
              </dl>

              <button
                class="mt-2 flex w-full items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-left text-xs font-semibold text-[var(--muted)] transition hover:bg-[var(--surface-muted)]"
                type="button"
                @click="showTechnical = !showTechnical"
              >
                {{ t('assets.technical') }}
                <span>{{ showTechnical ? '−' : '+' }}</span>
              </button>
              <div v-if="showTechnical" class="mt-2 space-y-3 rounded-xl bg-[var(--surface-muted)] p-3 text-xs">
                <div>
                  <p class="text-[var(--muted)]">{{ t('assets.conversationId') }}</p>
                  <div class="mt-1 flex items-center gap-2">
                    <code class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ selected.conversationId || '—' }}</code>
                    <button
                      v-if="selected.conversationId"
                      class="shrink-0 rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold hover:border-[var(--accent)]"
                      type="button"
                      @click="copyText('conversation', selected.conversationId || '')"
                    >
                      {{ copied === 'conversation' ? t('assets.copied') : t('assets.copy') }}
                    </button>
                  </div>
                </div>
                <div>
                  <p class="text-[var(--muted)]">{{ t('assets.runId') }}</p>
                  <div class="mt-1 flex items-center gap-2">
                    <code class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ selected.runId }}</code>
                    <button
                      class="shrink-0 rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold hover:border-[var(--accent)]"
                      type="button"
                      @click="copyText('run', selected.runId)"
                    >
                      {{ copied === 'run' ? t('assets.copied') : t('assets.copy') }}
                    </button>
                  </div>
                </div>
                <div>
                  <p class="text-[var(--muted)]">SHA-256</p>
                  <div class="mt-1 flex items-center gap-2">
                    <code class="min-w-0 flex-1 truncate font-mono text-[11px]" :title="selected.sha256">{{ shortId(selected.sha256) }}</code>
                    <button
                      class="shrink-0 rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold hover:border-[var(--accent)]"
                      type="button"
                      @click="copyText('sha', selected.sha256)"
                    >
                      {{ copied === 'sha' ? t('assets.copied') : t('assets.copy') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="shrink-0 border-t border-[var(--border)] p-4">
              <button
                class="w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
                type="button"
                @click="download(selected)"
              >
                {{ t('assets.download') }}
              </button>
              <button
                class="mt-2 w-full rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-semibold transition hover:bg-[var(--surface-muted)]"
                type="button"
                @click="reveal(selected)"
              >
                {{ t('assets.reveal') }}
              </button>
            </div>
          </template>

          <div v-else class="grid flex-1 place-items-center p-8 text-center">
            <span class="grid h-16 w-16 place-items-center rounded-2xl bg-[var(--surface-muted)] text-3xl opacity-80">✦</span>
            <p class="mt-4 text-sm font-medium">{{ t('assets.selectTitle') }}</p>
            <p class="mt-1 max-w-[220px] text-xs leading-relaxed text-[var(--muted)]">{{ t('assets.selectHint') }}</p>
          </div>
        </aside>
      </div>
    </div>
  </section>
</template>
