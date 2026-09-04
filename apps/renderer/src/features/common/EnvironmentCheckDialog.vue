<script setup lang="ts">
import { computed } from 'vue';
import { environmentState, type EnvProgressRow } from '../../services/environment.js';

/**
 * 环境检查弹窗：实时展示逐项进度（主进程逐项推送），完成后给出汇总；
 * 有问题的项直接附上分平台解决方案。
 */
const emit = defineEmits<{ close: []; go: [] }>();

const rows = computed(() => environmentState.progressRows.value as EnvProgressRow[]);
const report = computed(() => environmentState.report.value);
const errorMessage = computed(() => environmentState.errorMessage.value);
const checking = computed(() => environmentState.runStatus.value === 'checking' || (report.value === null && rows.value.some((row) => row.state === 'checking')));
const problems = computed(() => (report.value?.checks ?? []).filter((check) => check.status !== 'ok'));
const allOk = computed(() => Boolean(report.value && report.value.summary.error === 0 && report.value.summary.warn === 0));

const stateBadge: Record<string, { text: string; cls: string; dot: string }> = {
  ok: { text: '正常', cls: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' },
  warn: { text: '建议处理', cls: 'bg-amber-500/10 text-amber-600', dot: 'bg-amber-500' },
  error: { text: '需要处理', cls: 'bg-rose-500/10 text-rose-600', dot: 'bg-rose-500' },
};

function lineParts(help: string): string[] {
  return help.split('\n').filter((line) => line.trim());
}
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
    <div class="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl">
      <header class="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent)]/15 text-xl">🛠</span>
        <div class="min-w-0 flex-1">
          <h2 class="text-lg font-bold leading-tight">运行环境检查</h2>
          <p v-if="checking" class="mt-0.5 text-sm text-[var(--muted)]">正在逐项检测本机环境…</p>
          <p v-else-if="allOk" class="mt-0.5 text-sm text-emerald-600">环境已就绪（{{ report?.summary.ok }}/{{ report?.summary.total }}）🎉</p>
          <p v-else class="mt-0.5 text-sm text-[var(--muted)]">
            检测到 {{ report?.summary.error ?? 0 }} 项不满足、{{ report?.summary.warn ?? 0 }} 项建议；每项下方均有安装指引。
          </p>
        </div>
        <button class="ml-auto grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" aria-label="关闭" :disabled="checking" @click="emit('close')">×</button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-4">
        <!-- 逐项进度 / 结果 -->
        <ul class="grid gap-2">
          <li v-for="row in rows" :key="row.id" class="flex items-start gap-3 rounded-xl border border-[var(--border)] p-3">
            <template v-if="row.state === 'checking'">
              <span class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              <div class="min-w-0 text-sm">
                <p class="font-semibold">{{ row.name }}</p>
                <p class="mt-0.5 text-xs text-[var(--muted)]">要求：{{ row.required }} · 检测中…</p>
              </div>
            </template>
            <template v-else>
              <span :class="['mt-1 h-2.5 w-2.5 shrink-0 rounded-full', stateBadge[row.status ?? 'ok'].dot]" />
              <div class="min-w-0 flex-1 text-sm">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <p class="font-semibold">{{ row.name }}</p>
                  <span :class="['rounded-full px-2 py-0.5 text-[11px] font-semibold', stateBadge[row.status ?? 'ok'].cls]">
                    {{ stateBadge[row.status ?? 'ok'].text }}
                  </span>
                  <span class="text-xs text-[var(--muted)]">当前：{{ row.found || '—' }}</span>
                </div>
              </div>
            </template>
          </li>
        </ul>
        <p v-if="errorMessage" class="mt-3 text-sm text-rose-600">检查失败：{{ errorMessage }}</p>

        <!-- 完成后的解决方案 -->
        <div v-if="!checking && problems.length" class="mt-4 grid gap-3">
          <p class="text-sm font-semibold text-rose-600">需要处理的项目与解决方案</p>
          <details v-for="check in problems" :key="check.id" class="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 px-4 py-3">
            <summary class="cursor-pointer text-sm font-semibold">
              {{ check.name }}
              <span class="ml-2 text-xs font-normal text-[var(--muted)]">要求 {{ check.required }}，当前 {{ check.found }}</span>
            </summary>
            <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
              <li v-for="(line, index) in lineParts(check.help)" :key="index">
                <code v-if="/^(brew |winget |sudo |xcode-select |python |chmod |dnf |apt)/.test(line.trim())" class="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-xs">{{ line.trim() }}</code>
                <template v-else>{{ line.trim() }}</template>
              </li>
            </ul>
          </details>
        </div>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
        <button class="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--muted)] hover:bg-[var(--surface-muted)]" type="button" :disabled="checking" @click="emit('close')">
          {{ allOk ? '完成' : '关闭' }}
        </button>
        <button v-if="!allOk && !checking" class="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90" type="button" @click="emit('go')">
          查看完整详情与修复 →
        </button>
      </footer>
    </div>
  </div>
</template>
