<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../../app/i18n.js';

/**
 * P1「远程办公 / 连接」门户。
 * Telegram 卡片可完整启用与保存；飞书（P2）与远程中继（P3）卡片先展示状态占位。
 * 非敏感元数据 → 域 KV channels.v1；凭证经主进程 safeStorage 加密保存并仅在下发时使用。
 */
const { t } = useI18n();

const tgEnabled = ref(false);
const tgToken = ref('');
const feishuEnabled = ref(false);
const feishuAppId = ref('');
const feishuSecret = ref('');
const relayEnabled = ref(false);
const allowlistText = ref('');
const defaultEmployeeId = ref('general');
const gatewayRunning = ref(false);
const gatewayPid = ref<number | null>(null);
const message = ref('');
const error = ref('');

type ChannelMeta = { enabled?: boolean; appId?: string };
interface ChannelMetaShape {
  defaultEmployeeId?: string;
  allowlist?: string[];
  channels?: { telegram?: ChannelMeta; feishu?: ChannelMeta; relay?: ChannelMeta };
}

let statusTimer: ReturnType<typeof setInterval> | null = null;

function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function refreshStatus() {
  const status = await window.opcaiDesktop?.gatewayStatus?.().catch(() => ({ running: false, pid: null }));
  gatewayRunning.value = Boolean(status?.running);
  gatewayPid.value = status?.pid ?? null;
}

async function load() {
  const settings = await window.opcaiDesktop?.getChannelSettings?.().catch(() => undefined);
  const meta = (settings?.meta ?? {}) as ChannelMetaShape;
  const secrets = settings?.secrets ?? {};
  tgEnabled.value = Boolean(meta.channels?.telegram?.enabled);
  tgToken.value = secrets.telegram?.botToken ?? '';
  feishuEnabled.value = Boolean(meta.channels?.feishu?.enabled);
  feishuAppId.value = meta.channels?.feishu?.appId ?? '';
  feishuSecret.value = secrets.feishu?.appSecret ?? '';
  relayEnabled.value = Boolean(meta.channels?.relay?.enabled);
  allowlistText.value = (Array.isArray(meta.allowlist) ? meta.allowlist : []).join('\n');
  defaultEmployeeId.value = String(meta.defaultEmployeeId || 'general');
  await refreshStatus();
}

async function save() {
  error.value = '';
  message.value = '';
  try {
    const payload = {
      meta: {
        defaultEmployeeId: defaultEmployeeId.value.trim() || 'general',
        allowlist: parseList(allowlistText.value),
        channels: {
          telegram: { enabled: tgEnabled.value },
          feishu: { enabled: feishuEnabled.value, appId: feishuAppId.value.trim() || undefined },
          relay: { enabled: relayEnabled.value },
        },
      },
      secrets: {
        telegram: { botToken: tgToken.value },
        feishu: { appSecret: feishuSecret.value },
        relay: {},
      },
    };
    const result = await window.opcaiDesktop?.saveChannelSettings?.(payload);
    if (!result?.ok) throw new Error('保存失败：主进程未响应。');
    message.value = '已保存。重启网关后生效。';
    await refreshStatus();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function restart() {
  error.value = '';
  message.value = '';
  try {
    const result = await window.opcaiDesktop?.gatewayRestart?.();
    gatewayRunning.value = Boolean(result?.running);
    gatewayPid.value = result?.pid ?? null;
    message.value = gatewayRunning.value ? '网关已重启（运行中）。' : '网关未运行（未启用任何通道或配置为空）。';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

const inputClass = 'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30';
const cardClass = 'rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4';

onMounted(async () => {
  await load();
  statusTimer = setInterval(() => void refreshStatus(), 5000);
});
onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer);
});
</script>

<template>
  <section class="mx-auto flex h-full max-w-4xl flex-col overflow-auto px-6 py-8 sm:px-10">
    <header class="mb-6">
      <p class="text-[11px] font-extrabold uppercase tracking-[.13em] text-[var(--accent)]">OPCAI / REMOTE & CHANNELS</p>
      <h1 class="mt-1 text-3xl font-bold tracking-[-.03em]">{{ t('nav.remote') }}</h1>
      <p class="mt-2 text-sm text-[var(--muted)]">把外部 IM 与远程终端接入本地工作台。凭证仅保存在本机（系统级加密），非敏感配置存于本地域存储。</p>
    </header>

    <div class="mb-4 flex flex-wrap items-center gap-3 text-sm">
      <span class="font-medium">网关状态：</span>
      <span :class="gatewayRunning ? 'text-emerald-600' : 'text-rose-600'">{{ gatewayRunning ? '运行中' : '未运行' }}</span>
      <span v-if="gatewayPid" class="text-xs text-[var(--muted)]">pid {{ gatewayPid }}</span>
      <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-muted)]" type="button" @click="restart">重启网关</button>
    </div>

    <div v-if="error" class="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{{ error }}</div>
    <div v-if="message" class="mb-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">{{ message }}</div>

    <div class="grid gap-4">
      <!-- Telegram -->
      <div :class="cardClass">
        <div class="mb-3 flex items-center justify-between">
          <div>
            <h2 class="font-semibold">Telegram</h2>
            <p class="text-xs text-[var(--muted)]">长轮询入站 + 流式出站；保存后重启网关生效。</p>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="tgEnabled" type="checkbox" class="h-4 w-4 accent-[var(--accent)]" />
            启用
          </label>
        </div>
        <div class="grid gap-3">
          <input v-model="tgToken" :class="inputClass" type="password" placeholder="Bot Token（留空则清除已保存的令牌）" />
        </div>
      </div>

      <!-- Feishu (P2 占位) -->
      <div :class="cardClass">
        <div class="mb-3 flex items-center justify-between">
          <div>
            <h2 class="font-semibold">飞书 Feishu</h2>
            <p class="text-xs text-[var(--muted)]">适配器将在下一迭代启用；此处已支持保存凭证，避免二次录入。</p>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="feishuEnabled" type="checkbox" class="h-4 w-4 accent-[var(--accent)]" />
            启用
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <input v-model="feishuAppId" :class="inputClass" type="text" placeholder="App ID" />
          <input v-model="feishuSecret" :class="inputClass" type="password" placeholder="App Secret（留空则清除）" />
        </div>
      </div>

      <!-- Relay (P3 占位) -->
      <div :class="cardClass">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="font-semibold">远程中继（远程办公）</h2>
            <p class="text-xs text-[var(--muted)]">设备出连中继与外部终端控制台将在 P3 迭代提供。</p>
          </div>
          <span class="text-xs text-[var(--muted)]">计划中</span>
        </div>
      </div>

      <!-- 通用 -->
      <div :class="cardClass">
        <h2 class="mb-3 font-semibold">通用</h2>
        <div class="grid gap-3">
          <label class="grid gap-1 text-sm">
            <span>默认数字员工</span>
            <input v-model="defaultEmployeeId" :class="inputClass" type="text" placeholder="general" />
          </label>
          <label class="grid gap-1 text-sm">
            <span>白名单（每行或逗号分隔；示例：telegram:user:123456 或 telegram:chat:-100xxx）</span>
            <textarea v-model="allowlistText" :class="inputClass" rows="3" />
          </label>
        </div>
      </div>
    </div>

    <div class="mt-6">
      <button class="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90" type="button" @click="save">保存配置</button>
    </div>
  </section>
</template>
