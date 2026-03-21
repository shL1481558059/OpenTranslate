const THEME_STORAGE_KEY = 'snapTranslate.themePreference';
const VALID_THEME_PREFERENCES = new Set(['system', 'light', 'dark']);
const root = document.documentElement;
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
let currentPreference = readStoredThemePreference();

export function normalizeThemePreference(value, fallback = 'system') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_THEME_PREFERENCES.has(normalized) ? normalized : fallback;
}

function readStoredThemePreference() {
  return normalizeThemePreference(withLocalStorage(() => localStorage.getItem(THEME_STORAGE_KEY)));
}

function withLocalStorage(action) {
  try {
    return action();
  } catch {
    return null;
  }
}

function persistThemePreference(preference) {
  withLocalStorage(() => {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  });
}

function setThemeRootState(mode, preference) {
  const isDark = mode === 'dark';
  root.classList.toggle('wa-dark', isDark);
  root.classList.toggle('wa-light', !isDark);
  root.style.colorScheme = mode;
  root.dataset.theme = mode;
  root.dataset.themePreference = preference;
}

function isExplicitThemeMode(preference) {
  return preference === 'dark' || preference === 'light';
}

function resolveThemeMode(preference) {
  if (isExplicitThemeMode(preference)) {
    return preference;
  }
  return darkModeQuery.matches ? 'dark' : 'light';
}

export function applyThemePreference(preference, options = {}) {
  const normalized = normalizeThemePreference(preference);
  const mode = resolveThemeMode(normalized);
  currentPreference = normalized;
  setThemeRootState(mode, normalized);

  if (options.persist !== false) {
    persistThemePreference(normalized);
  }

  return { mode, preference: normalized };
}

function handleSystemThemeChange() {
  if (currentPreference !== 'system') {
    return;
  }
  applyThemePreference('system', { persist: false });
}

function syncThemePreferenceFromSettings() {
  if (!window.snapTranslate?.getSettings) {
    return;
  }

  window.snapTranslate
    .getSettings()
    .then((settings) => {
      const preference = normalizeThemePreference(settings?.theme, '');
      if (!preference) {
        return;
      }
      applyThemePreference(preference);
    })
    .catch(() => {
      // ignore theme sync failures
    });
}

applyThemePreference(currentPreference, { persist: false });

if (typeof darkModeQuery.addEventListener === 'function') {
  darkModeQuery.addEventListener('change', handleSystemThemeChange);
} else if (typeof darkModeQuery.addListener === 'function') {
  darkModeQuery.addListener(handleSystemThemeChange);
}

syncThemePreferenceFromSettings();
