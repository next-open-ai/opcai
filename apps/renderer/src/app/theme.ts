import { computed, onBeforeUnmount, ref } from 'vue';

export const themeOptions = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof themeOptions)[number];
type ResolvedTheme = Exclude<ThemePreference, 'system'>;

const storageKey = 'opcai.theme-preference';
const preference = ref<ThemePreference>(readPreference());
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function readPreference(): ThemePreference {
  const saved = window.localStorage.getItem(storageKey);
  return themeOptions.includes(saved as ThemePreference) ? (saved as ThemePreference) : 'system';
}

function resolveTheme(value: ThemePreference): ResolvedTheme {
  return value === 'system' ? (mediaQuery.matches ? 'dark' : 'light') : value;
}

function applyTheme(value: ThemePreference) {
  const resolved = resolveTheme(value);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

applyTheme(preference.value);

/** Renderer-only theme state: works in Electron and in a future browser build. */
export function useTheme() {
  const resolvedTheme = computed(() => resolveTheme(preference.value));

  const setTheme = (value: ThemePreference) => {
    preference.value = value;
    window.localStorage.setItem(storageKey, value);
    applyTheme(value);
  };

  const onSystemThemeChange = () => {
    if (preference.value === 'system') applyTheme('system');
  };

  mediaQuery.addEventListener('change', onSystemThemeChange);
  onBeforeUnmount(() => mediaQuery.removeEventListener('change', onSystemThemeChange));

  return { preference, resolvedTheme, setTheme };
}
