<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from '../../app/i18n.js';
import { environmentState, runEnvironmentCheck } from '../../services/environment.js';

/**
 * 「环境检查」页面：启动时体检结果的可视化（Python/工具链/数据目录），
 * 缺项给出可执行的修复指引。
 */
const { t } = useI18n();

const report = computed(() => environmentState.report.value);
const runStatus = computed(() => environmentState.runStatus.value);
const errorMessage = computed(() => environmentState.errorMessage.value);

const stateMeta: Record<'ok' | 'warn' | 'error', { label: string; badge: string; dot: string }> = {
  ok: { label: '正常', badge: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' },
  warn: { label: '建议处理', badge: 'bg-amber-500/10 text-amber-600', dot: 'bg-amber-500' },
  error: { label: '需要处理', badge: 'bg-rose-500/10 text-rose-600', dot: 'bg-rose-500' },
};

const statusText = {
  idle: '尚未检查',
  checking: '检查中…',
  ready: '已检查',
};

async function rerun() {
  await runEnvironmentCheck();
}

onMounted(() => {
  void runEnvironmentCheck();
});
</script>

<template>
  <section class="mx-auto flex h-full max-w-4xl flex-col overflow-auto px-6 py-8 sm:px-10">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="text-[11px] font-extrabold uppercase tracking-[.13em] text-[var(--accent)]">OPCAI / ENVIRONMENT</p>
        <h1 class="mt-1 text-3xl font-bold tracking-[-.03em]">环境检查</h1>
        <p class="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          启动环境体检：Python 3 与版本、pip、Git、npx、本地数据目录。缺项会给出对应平台的修复指引；多数问题在安装对应工具并重启应用后即可解决。
        </p>
      </div>
      <button
        class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        type="button"
        :disabled="runStatus === 'checking'"
        @click="rerun"
      >
        重新检查
      </button>
    </header>

    <div v-if="runStatus === 'checking'" class="mb-4 text-sm text-[var(--muted)]">正在检查本地环境…</div>

    <!-- 汇总条 -->
    <div v-if="report" class="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
      <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-center">
        <p class="text-2xl font-bold">{{ report.summary.total }}</p>
        <p class="text-xs text-[var(--muted)]">检查项</p>
      </div>
      <div class="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-center">
        <p class="text-2xl font-bold text-emerald-600">{{ report.summary.ok }}</p>
        <p class="text-xs text-[var(--muted)]">正常</p>
      </div>
      <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-center">
        <p class="text-2xl font-bold text-amber-600">{{ report.summary.warn }}</p>
        <p class="text-xs text-[var(--muted)]">建议</p>
      </div>
      <div class="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-center">
        <p class="text-2xl font-bold text-rose-600">{{ report.summary.error }}</p>
        <p class="text-xs text-[var(--muted)]">需处理</p>
      </div>
      <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-center">
        <p class="text-sm font-semibold">{{ report.platform }}</p>
        <p class="text-xs text-[var(--muted)]">{{ statusText[runStatus] }}</p>
      </div>
    </div>

    <div v-if="errorMessage" class="mb-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600">
      检查失败：{{ errorMessage }}
    </div>

    <div class="grid gap-3">
      <div
        v-for="check in report?.checks ?? []"
        :key="check.id"
        class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span :class="['h-2.5 w-2.5 shrink-0 rounded-full', stateMeta[check.status].dot]" />
              <h2 class="truncate font-semibold">{{ check.name }}</h2>
              <span :class="['shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', stateMeta[check.status].badge]">
                {{ stateMeta[check.status].label }}
              </span>
            </div>
            <p class="mt-1 text-sm text-[var(--muted)]">要求：{{ check.required }}</p>
            <p class="mt-0.5 text-sm">
              <template v-if="check.command">检测命令：<code class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs">{{ check.command }}</code> · </template>
              当前：<span class="font-medium">{{ check.found }}</span>
            </p>
          </div>
        </div>
        <details v-if="check.status !== 'ok'" class="mt-3 rounded-lg bg-[var(--surface-muted)]/60 px-3 py-2 text-sm">
          <summary class="cursor-pointer font-medium text-[var(--accent)]">如何修复（点击展开）</summary>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-[var(--muted)]">
            <li v-for="(line, index) in check.help.split('\n').filter((item) => item.trim())" :key="index">
              <code v-if="line.trim().startsWith('brew ') || line.trim().startsWith('winget ') || line.trim().startsWith('sudo ') || line.trim().startsWith('xcode-select ') || line.trim().startsWith('python ') || line.trim().startsWith('chmod ') || line.trim().startsWith('dnf ') || line.trim().startsWith('apt')" class="rounded bg-[var(--surface-muted)] px-1 py-0.5 text-xs">{{ line.trim() }}</code>
              <template v-else>{{ line.trim() }}</template>
            </li>
          </ul>
        </details>
        <p v-else class="mt-2 text-sm text-[var(--muted)]">{{ check.help }}</p>
      </div>
    </div>

    <p v-if="report?.checks.length === 0" class="py-6 text-center text-sm text-[var(--muted)]">暂无检查结果。</p>
  </section>
</template>
