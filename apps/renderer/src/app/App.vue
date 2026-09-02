<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getHealth } from '../services/api';
import AppSidebar from './AppSidebar.vue';
import ChatWorkspace from '../features/chat/ChatWorkspace.vue';
import EmployeesPage from '../features/employees/EmployeesPage.vue';
import SettingsPage from '../features/settings/SettingsPage.vue';
import CapabilitiesPage from '../features/capabilities/CapabilitiesPage.vue';
import AssetsPage from '../features/assets/AssetsPage.vue';
import AutomationsPage from '../features/automations/AutomationsPage.vue';
import ProjectsPage from '../features/projects/ProjectsPage.vue';
import { useI18n } from './i18n';
import { useWorkspace } from './workspace';
import { useModelConfig } from './model-config';
import { useTheme } from './theme';
import { readStored, writeStored } from './storage';
import { useCapabilities } from './capabilities';
import { useAutomations, type Automation } from './automations';

const { t, loadLocale } = useI18n();
const { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, load: loadWorkspace, setView, startChat, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry } = useWorkspace();
const serviceReady = ref(false);
const sidebarCollapsed = ref(false);
const { loadTheme } = useTheme();
const { activeConfig: modelConfig, availableChatModels, configured, load: loadModelConfig, selectChatEndpoint, chatEndpointToken, modelForProvider } = useModelConfig();
const { load: loadCapabilities } = useCapabilities();
const { load: loadAutomations, startScheduler } = useAutomations();
let stopScheduler: (() => void) | undefined;
const runScheduledAutomation = async (automation: Automation) => {
  const model = modelForProvider(automation.provider);
  if (!model) throw new Error('所选自动化模型尚未配置或 API Key 不可用。');
  return runAutomation(automation, model);
};
onMounted(async () => { await Promise.all([loadModelConfig(), loadWorkspace(), loadTheme(), loadLocale(), loadCapabilities(), loadAutomations()]); stopScheduler = startScheduler(runScheduledAutomation); sidebarCollapsed.value = (await readStored('ui.sidebar-collapsed')) === 'true'; try { await getHealth(); serviceReady.value = true; } catch { serviceReady.value = false; } });
onUnmounted(() => stopScheduler?.());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; void writeStored('ui.sidebar-collapsed', String(sidebarCollapsed.value)); }
</script>

<template>
  <div class="flex h-screen min-h-[600px] overflow-hidden bg-[var(--background)] text-[var(--text)]">
    <AppSidebar :collapsed="sidebarCollapsed" :view="view" :conversations="conversations" :active-conversation-id="activeConversation?.id ?? null" :service-ready="serviceReady" @toggle="toggleSidebar" @navigate="setView" @new-chat="startChat()" @select-conversation="selectConversation" @delete-conversation="deleteConversation" />
    <main :class="['min-w-0 flex-1 bg-[var(--background)]', view === 'chat' || view === 'capabilities' || view === 'assets' || view === 'automations' || view === 'projects' ? 'overflow-hidden' : 'overflow-auto']">
      <ChatWorkspace v-if="view === 'chat'" :employee="currentEmployee" :selected-employee-id="currentEmployeeId" :employees="employees" :conversation="activeConversation" :model-configured="configured" :model="modelConfig" :available-models="availableChatModels" :chat-endpoint-token="chatEndpointToken" :permission-tier="permissionTier" :send-message="async (content, collaboratorIds, collaborationDelivery) => { await addMessage(content, modelConfig, { collaboratorIds, collaborationDelivery }); }" :approve="(conversationId, approval, scope) => approveAndRetry(conversationId, approval, scope, modelConfig)" @select-endpoint="selectChatEndpoint" @select-employee="selectEmployee" @set-permission-tier="setPermissionTier" @clear-conversation="clearConversation" @open-assets="setView('assets')" @open-settings="setView('settings')" />
      <EmployeesPage v-else-if="view === 'employees'" :employees="employees" :selected-employee-id="currentEmployeeId" @start-chat="startChat" />
      <CapabilitiesPage v-else-if="view === 'capabilities'" />
      <AssetsPage v-else-if="view === 'assets'" :conversations="conversations" @open-conversation="(id) => { selectConversation(id); setView('chat'); }" />
      <AutomationsPage
        v-else-if="view === 'automations'"
        :employees="employees"
        :models="availableChatModels"
        :conversations="conversations"
        :run-automation="runScheduledAutomation"
        :open-conversation="(id) => { selectConversation(id); setView('chat'); }"
      />
      <ProjectsPage v-else-if="view === 'projects'" :employees="employees" :models="availableChatModels" :generate-draft="generateProjectDraft" :run-task="runProjectTask" />
      <SettingsPage v-else :employees="employees" :default-employee-id="currentEmployeeId" @set-default-employee="setDefaultEmployee" />
    </main>
    <p class="sr-only" role="status">{{ serviceReady ? t('common.statusReady') : t('common.statusOffline') }}</p>
  </div>
</template>
