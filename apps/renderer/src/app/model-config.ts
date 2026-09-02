import { computed, ref } from 'vue';

export const providerIds = ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'ollama', 'openai-compatible'] as const;
export type ProviderId = (typeof providerIds)[number];

export interface ProviderConfig {
  provider: ProviderId;
  baseUrl: string;
  chatModel: string;
  /** Saved chat model ids for this provider; `chatModel` is the active default. */
  chatModels: string[];
  /** When true, disable model "thinking"/reasoning (Ollama `think: false`, OpenAI-compatible `reasoningEffort: none`). */
  disableThinking: boolean;
  imageModel: string;
  embeddingModel: string;
  asrModel: string;
  ttsModel: string;
  apiKey: string;
}

export interface ModelSettings {
  activeProvider: ProviderId;
  providers: ProviderConfig[];
}

export const providerSuggestedChatModels: Partial<Record<ProviderId, string[]>> = {
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  qwen: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
  ollama: [],
  'openai-compatible': [],
};

/** Common Ollama library model names for picker search (not exhaustive). */
export const ollamaLibraryCatalog = [
  'llama3.2',
  'llama3.1',
  'llama3.2:latest',
  'llama3.1:8b',
  'llama3.1:70b',
  'qwen2.5',
  'qwen2.5:7b',
  'qwen2.5:14b',
  'qwen2.5-coder',
  'deepseek-r1',
  'deepseek-v3',
  'mistral',
  'mixtral',
  'gemma2',
  'phi3',
  'codellama',
  'nomic-embed-text',
];

export const providerDefaults: Record<ProviderId, Omit<ProviderConfig, 'apiKey'>> = {
  openai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4.1-mini', chatModels: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'], disableThinking: false, imageModel: 'gpt-image-1', embeddingModel: 'text-embedding-3-small', asrModel: 'gpt-4o-mini-transcribe', ttsModel: 'gpt-4o-mini-tts' },
  anthropic: { provider: 'anthropic', baseUrl: '', chatModel: 'claude-sonnet-4-5', chatModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'], disableThinking: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  google: { provider: 'google', baseUrl: '', chatModel: 'gemini-2.5-flash', chatModels: ['gemini-2.5-flash', 'gemini-2.5-pro'], disableThinking: false, imageModel: 'gemini-2.5-flash-image', embeddingModel: 'text-embedding-004', asrModel: '', ttsModel: '' },
  deepseek: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat', chatModels: ['deepseek-chat', 'deepseek-reasoner'], disableThinking: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  qwen: { provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModel: 'qwen-plus', chatModels: ['qwen-plus', 'qwen-turbo'], disableThinking: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  ollama: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', chatModel: 'llama3.2', chatModels: [], disableThinking: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
  'openai-compatible': { provider: 'openai-compatible', baseUrl: '', chatModel: '', chatModels: [], disableThinking: false, imageModel: '', embeddingModel: '', asrModel: '', ttsModel: '' },
};

const localKey = 'opcai.model-settings';
const defaultSettings = (): ModelSettings => ({ activeProvider: 'openai', providers: providerIds.map((provider) => ({ ...providerDefaults[provider], apiKey: '' })) });
const settings = ref<ModelSettings>(defaultSettings());
const loaded = ref(false);

/** Latest Ollama /api/tags names; empty until refreshed (chat may show all configured ids). */
export const ollamaLocalModelNames = ref<string[]>([]);

export function ollamaModelIsLocal(name: string) {
  if (!ollamaLocalModelNames.value.length) return true;
  const base = name.split(':')[0].toLowerCase();
  return ollamaLocalModelNames.value.some((item) => item === name || item.split(':')[0].toLowerCase() === base);
}

export function providerNeedsApiKey(provider: ProviderId) {
  return provider !== 'ollama';
}

export function uniqueModels(values: string[]) {
  const seen = new Set<string>();
  return values.map((item) => item.trim()).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

export function chatModelList(config: ProviderConfig) {
  return uniqueModels([...(config.chatModels ?? []), config.chatModel]);
}

export function providerConfigured(config: ProviderConfig) {
  if (!config.chatModel.trim()) return false;
  if (!providerNeedsApiKey(config.provider)) return true;
  return Boolean(config.apiKey.trim());
}

function mergeProvider(provider: ProviderId, stored?: Partial<ProviderConfig>): ProviderConfig {
  const base = { ...providerDefaults[provider], apiKey: '', ...(stored ?? {}), provider };
  const chatModels = uniqueModels([...(stored?.chatModels ?? base.chatModels ?? []), stored?.chatModel ?? base.chatModel]);
  const chatModel = stored?.chatModel?.trim() || chatModels[0] || base.chatModel;
  return { ...base, chatModels, chatModel, disableThinking: stored?.disableThinking ?? base.disableThinking ?? false };
}

function normalize(value: unknown): ModelSettings {
  const legacy = value as { baseUrl?: string; model?: string; apiKey?: string; providers?: ProviderConfig[]; activeProvider?: ProviderId };
  if (Array.isArray(legacy?.providers)) {
    return {
      activeProvider: providerIds.includes(legacy.activeProvider as ProviderId) ? legacy.activeProvider as ProviderId : 'openai',
      providers: providerIds.map((provider) => mergeProvider(provider, legacy.providers?.find((item) => item.provider === provider))),
    };
  }
  const next = defaultSettings();
  if (legacy?.apiKey || legacy?.model) next.providers[0] = mergeProvider('openai', { ...next.providers[0], baseUrl: legacy.baseUrl || next.providers[0].baseUrl, chatModel: legacy.model || next.providers[0].chatModel, apiKey: legacy.apiKey || '' });
  return next;
}

async function load() {
  if (loaded.value) return;
  const stored = window.opcaiDesktop ? await window.opcaiDesktop.getModelConfig() : JSON.parse(localStorage.getItem(localKey) || '{}');
  settings.value = normalize(stored);
  loaded.value = true;
  const ollama = settings.value.providers.find((item) => item.provider === 'ollama');
  if (ollama && window.opcaiDesktop?.listOllamaModels) {
    try {
      ollamaLocalModelNames.value = await window.opcaiDesktop.listOllamaModels(ollama.baseUrl);
    } catch {
      ollamaLocalModelNames.value = [];
    }
  }
}

export function apiKeyForRequest(config: ProviderConfig) {
  if (config.provider === 'ollama') return config.apiKey.trim() || 'ollama';
  return config.apiKey;
}

export function toModelPayload(config: ProviderConfig) {
  return { ...config, baseUrl: config.baseUrl || undefined, apiKey: apiKeyForRequest(config) };
}

export function useModelConfig() {
  const activeConfig = computed(() => settings.value.providers.find((item) => item.provider === settings.value.activeProvider) ?? settings.value.providers[0]);
  const availableChatModels = computed(() =>
    settings.value.providers.flatMap((item) => {
      if (!providerConfigured(item)) return [];
      return chatModelList(item)
        .filter((chatModel) => item.provider !== 'ollama' || ollamaModelIsLocal(chatModel))
        .map((chatModel) => ({ ...item, chatModel }));
    }),
  );
  const configured = computed(() => providerConfigured(activeConfig.value));

  const save = async (value: ModelSettings) => {
    const plainSettings = JSON.parse(JSON.stringify(normalize(value))) as ModelSettings;
    settings.value = plainSettings;
    if (window.opcaiDesktop) await window.opcaiDesktop.saveModelConfig(plainSettings);
    else localStorage.setItem(localKey, JSON.stringify(plainSettings));
  };

  const setActiveProvider = async (provider: ProviderId) => {
    settings.value.activeProvider = provider;
    await save(settings.value);
  };

  const setActiveChatModel = async (provider: ProviderId, chatModel: string) => {
    const item = settings.value.providers.find((entry) => entry.provider === provider);
    if (!item) return;
    item.chatModel = chatModel;
    item.chatModels = uniqueModels([...item.chatModels, chatModel]);
    settings.value.activeProvider = provider;
    await save(settings.value);
  };

  const selectChatEndpoint = async (token: string) => {
    const [provider, chatModel] = token.split('::') as [ProviderId, string];
    if (!providerIds.includes(provider) || !chatModel) return;
    await setActiveChatModel(provider, chatModel);
  };

  const chatEndpointToken = computed(() => `${activeConfig.value.provider}::${activeConfig.value.chatModel}`);

  const modelForProvider = (provider: ProviderId) => {
    const item = settings.value.providers.find((entry) => entry.provider === provider);
    if (!item || !providerConfigured(item)) return undefined;
    const chatModel = item.chatModel.trim() || chatModelList(item)[0] || '';
    if (!chatModel) return undefined;
    return { ...item, chatModel };
  };

  return { settings, activeConfig, availableChatModels, configured, load, save, setActiveProvider, setActiveChatModel, selectChatEndpoint, chatEndpointToken, providerConfigured, chatModelList, modelForProvider };
}
