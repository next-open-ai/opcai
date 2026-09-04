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
import AppToastHost from '../features/common/AppToastHost.vue';
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
const { employees, view, currentEmployeeId, currentEmployee, conversations, activeConversation, permissionTier, load: loadWorkspace, setView, startChat, selectConversation, selectEmployee, setDefaultEmployee, setPermissionTier, clearConversation, deleteConversation, addMessage, abortActiveRun, runAutomation, runProjectTask, generateProjectDraft, approveAndRetry, createEmployee, updateEmployee, removeEmployee } = useWorkspace();
const serviceReady = ref(false);
const sidebarCollapsed = ref(false);
const { loadTheme } = useTheme();
const { activeConfig: modelConfig, availableChatModels, configured, load: loadModelConfig, selectChatEndpoint, chatEndpointToken, modelForProvider, modelById } = useModelConfig();
const { load: loadCapabilities } = useCapabilities();
const { load: loadAutomations, startScheduler } = useAutomations();
const { load: loadEmployeePrefs } = useEmployeeRuntimePrefs();
const { load: loadSearchConfig } = useSearchConfig();
const notify = useNotify();
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
onMounted(async () => { await Promise.all([loadModelConfig(), loadWorkspace(), loadTheme(), loadLocale(), loadCapabilities(), loadAutomations(), loadEmployeePrefs(), loadSearchConfig()]); stopScheduler = startScheduler(runScheduledAutomation); sidebarCollapsed.value = (await readStored('ui.sidebar-collapsed')) === 'true'; try { await getHealth(); serviceReady.value = true; } catch { serviceReady.value = false; } });
onUnmounted(() => stopScheduler?.());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; void writeStored('ui.sidebar-collapsed', String(sidebarCollapsed.value)); }
</script>

<template>
  <div class="flex h-screen min-h-[600px] overflow-hidden bg-[var(--background)] text-[var(--text)]">
    <AppSidebar :collapsed="sidebarCollapsed" :view="view" :conversations="conversations" :active-conversation-id="activeConversation?.id ?? null" :service-ready="serviceReady" @toggle="toggleSidebar" @navigate="setView" @new-chat="startChat()" @select-conversation="selectConversation" @delete-conversation="deleteConversation" />
    <main :class="['min-w-0 flex-1 bg-[var(--background)]', view === 'chat' || view === 'capabilities' || view === 'knowledge' || view === 'assets' || view === 'automations' || view === 'projects' ? 'overflow-hidden' : 'overflow-auto']">
      <ChatWorkspace v-if="view === 'chat'" :employee="currentEmployee" :selected-employee-id="currentEmployeeId" :employees="employees" :conversation="activeConversation" :model-configured="configured" :model="modelConfig" :available-models="availableChatModels" :chat-endpoint-token="chatEndpointToken" :permission-tier="permissionTier" :send-message="async (content, collaboratorIds, collaborationDelivery, onlineSearch) => { await addMessage(content, modelConfig, { collaboratorIds, collaborationDelivery, onlineSearch }); }" :abort-message="() => { abortActiveRun(); }" :approve="(conversationId, approval, scope) => approveAndRetry(conversationId, approval, scope, modelConfig)" @select-endpoint="selectChatEndpoint" @select-employee="selectEmployee" @set-permission-tier="setPermissionTier" @clear-conversation="clearConversation" @open-assets="setView('assets')" @open-settings="setView('settings')" />
      <EmployeesPage
        v-else-if="view === 'employees'"
        :employees="employees"
        :selected-employee-id="currentEmployeeId"
        :create-employee="createEmployee"
        :update-employee="updateEmployee"
        :remove-employee="removeEmployee"
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
      <SettingsPage v-else :employees="employees" :default-employee-id="currentEmployeeId" @set-default-employee="setDefaultEmployee" />
    </main>
    <AppToastHost />
    <p class="sr-only" role="status">{{ serviceReady ? t('common.statusReady') : t('common.statusOffline') }}</p>
  </div>
</template>
