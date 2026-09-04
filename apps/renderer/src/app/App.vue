<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getHealth } from '../services/api';
import AppSidebar from './AppSidebar.vue';
import ChatWorkspace from '../features/chat/ChatWorkspace.vue';
import EmployeesPage from '../features/employees/EmployeesPage.vue';
import SettingsPage from '../features/settings/SettingsPage.vue';
import CapabilitiesPage from '../features/capabilities/CapabilitiesPage.vue';
import KnowledgePage from '../features/knowledge/KnowledgePage.vue';
import AssetsPage from '../features/assets/AssetsPage.vue';
import AutomationsPage from '../features/automations/AutomationsPage.vue';
import ProjectsPage from '../features/projects/ProjectsPage.vue';
import RemoteOfficePage from '../features/remote/RemoteOfficePage.vue';
import EnvironmentPage from '../features/environment/EnvironmentPage.vue';
import { runEnvironmentCheck } from '../services/environment';
import AppToastHost from '../features/common/AppToastHost.vue';
import EnvironmentCheckDialog from '../features/common/EnvironmentCheckDialog.vue';
import { useI18n } from './i18n';
import { useWorkspace } from './workspace';
import { useModelConfig } from './model-config';
import { useTheme } from './theme';
import { readStored, writeStored } from './storage';
import { useCapabilities } from './capabilities';
import { useAutomations, type Automation } from './automations';
import { useEmployeeRuntimePrefs } from './employee-prefs';
import { useSearchConfig } from './search-config';
import { useNotify } from './notify';

const { t, loadLocale } = useI18n();
const { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, load: loadWorkspace, setView, startChat, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, abortActiveRun, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry, createEmployee, updateEmployee, removeEmployee, resetEmployee, hasEmployeeOverride } = useWorkspace();
const serviceReady = ref(false);
const sidebarCollapsed = ref(false);
const { loadTheme } = useTheme();
const { activeConfig: modelConfig, availableChatModels, configured, load: loadModelConfig, selectChatEndpoint, chatEndpointToken, modelForProvider, modelById } = useModelConfig();
const { load: loadCapabilities } = useCapabilities();
const { load: loadAutomations, startScheduler } = useAutomations();
const { load: loadEmployeePrefs } = useEmployeeRuntimePrefs();
const { load: loadSearchConfig } = useSearchConfig();
const notify = useNotify();
const showEnvCheckDialog = ref(false);
let stopScheduler: (() => void) | undefined;
const runScheduledAutomation = async (automation: Automation) => {
  const model = (automation.modelId ? modelById(automation.modelId) : undefined) ?? modelForProvider(automation.provider);
  if (!model) {
    const message = notify.errorMessage('model missing');
    notify.error(new Error(message));
    throw new Error(message);
  }
  return runAutomation(automation, model);
};
async function openProjectFromAssets(projectId: string) {
  await writeStored('projects.focus-id', projectId);
  setView('projects');
}
onMounted(async () => { await Promise.all([loadModelConfig(), loadWorkspace(), loadTheme(), loadLocale(), loadCapabilities(), loadAutomations(), loadEmployeePrefs(), loadSearchConfig()]); stopScheduler = startScheduler(runScheduledAutomation); sidebarCollapsed.value = (await readStored('ui.sidebar-collapsed')) === 'true'; try { await getHealth(); serviceReady.value = true; } catch { serviceReady.value = false; } void setupEnvironmentCheck(); });
/** 打开带实时进度的环境检查弹窗并执行。keepOpenOnClean=true 时即使全部通过也保留结果。 */
async function runCheckInDialog(keepOpenOnClean: boolean) {
  showEnvCheckDialog.value = true;
  const report = await runEnvironmentCheck();
  if (!keepOpenOnClean && report && report.summary.error === 0 && report.summary.warn === 0) {
    setTimeout(() => { showEnvCheckDialog.value = false; }, 900);
  }
  return report;
}
async function setupEnvironmentCheck() {
  try {
    // 安装后首次启动无论如何都执行一次环境检查；之后遵循“每次启动检查”开关。
    const firstRun = !(await readStored('env.first-run-done'));
    if (firstRun) await writeStored('env.first-run-done', '1');
    // 缺省为“每次启动检查”：从未设置过时显式落为 '1'，不覆盖用户已关闭('0')的选择。
    const stored = await readStored('env.check-on-startup');
    if (stored == null) await writeStored('env.check-on-startup', '1');
    const startupEnabled = stored !== '0';
    if (!firstRun && !startupEnabled) return;
    void runCheckInDialog(false);
  } catch { /* 环境检查失败不应阻塞启动 */ }
}
function openEnvDetails() {
  showEnvCheckDialog.value = false;
  setView('env');
}
onUnmounted(() => stopScheduler?.());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; void writeStored('ui.sidebar-collapsed', String(sidebarCollapsed.value)); }
</script>

<template>
  <div class="flex h-screen min-h-[600px] overflow-hidden bg-[var(--background)] text-[var(--text)]">
    <AppSidebar :collapsed="sidebarCollapsed" :view="view" :conversations="conversations" :active-conversation-id="activeConversation?.id ?? null" :service-ready="serviceReady" @toggle="toggleSidebar" @navigate="setView" @new-chat="startChat()" @select-conversation="selectConversation" @delete-conversation="deleteConversation" />
    <main :class="['relative min-w-0 flex-1 bg-[var(--background)]', view === 'chat' || view === 'capabilities' || view === 'knowledge' || view === 'assets' || view === 'automations' || view === 'projects' ? 'overflow-hidden' : 'overflow-auto']">
      <ChatWorkspace v-if="view === 'chat'" :employee="currentEmployee" :selected-employee-id="currentEmployeeId" :employees="employees" :conversation="activeConversation" :model-configured="configured" :model="modelConfig" :available-models="availableChatModels" :chat-endpoint-token="chatEndpointToken" :permission-tier="permissionTier" :send-message="async (content, collaboratorIds, collaborationDelivery, onlineSearch) => { await addMessage(content, modelConfig, { collaboratorIds, collaborationDelivery, onlineSearch }); }" :abort-message="() => { abortActiveRun(); }" :approve="(conversationId, approval, scope) => approveAndRetry(conversationId, approval, scope, modelConfig)" @select-endpoint="selectChatEndpoint" @select-employee="selectEmployee" @set-permission-tier="setPermissionTier" @clear-conversation="clearConversation" @open-assets="setView('assets')" @open-settings="setView('settings')" />
      <EmployeesPage
        v-else-if="view === 'employees'"
        :employees="employees"
        :selected-employee-id="currentEmployeeId"
        :create-employee="createEmployee"
        :update-employee="updateEmployee"
        :remove-employee="removeEmployee"
        :reset-employee="resetEmployee"
        :has-employee-override="hasEmployeeOverride"
        @start-chat="startChat"
      />
      <CapabilitiesPage v-else-if="view === 'capabilities'" @open-knowledge="setView('knowledge')" />
      <KnowledgePage v-else-if="view === 'knowledge'" @open-settings="setView('settings')" />
      <AssetsPage v-else-if="view === 'assets'" :conversations="conversations" @open-conversation="(id) => { selectConversation(id); setView('chat'); }" @open-project="openProjectFromAssets" />
      <AutomationsPage
        v-else-if="view === 'automations'"
        :employees="employees"
        :models="availableChatModels"
        :conversations="conversations"
        :run-automation="runScheduledAutomation"
        :open-conversation="(id) => { selectConversation(id); setView('chat'); }"
      />
      <ProjectsPage v-else-if="view === 'projects'" :employees="employees" :models="availableChatModels" :generate-draft="generateProjectDraft" :run-task="runProjectTask" />
      <RemoteOfficePage v-else-if="view === 'remote'" />
      <EnvironmentPage v-else-if="view === 'env'" />
      <SettingsPage v-else :employees="employees" :default-employee-id="currentEmployeeId" @set-default-employee="setDefaultEmployee" @open-environment="setView('env')" @open-check="runCheckInDialog(true)" />
    </main>
    <AppToastHost />
    <EnvironmentCheckDialog v-if="showEnvCheckDialog" @close="showEnvCheckDialog = false" @go="openEnvDetails" />
    <p class="sr-only" role="status">{{ serviceReady ? t('common.statusReady') : t('common.statusOffline') }}</p>
  </div>
</template>
