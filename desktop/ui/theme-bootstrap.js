function readStoredThemePreference() {
  try {
    return String(localStorage.getItem('snapTranslate.themePreference') || '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

function resolveThemePreference(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function resolveThemeMode(preference) {
  if (preference === 'dark') {
    return 'dark';
  }
  if (preference === 'light') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeBootstrap() {
  const root = document.documentElement;
  const preference = resolveThemePreference(readStoredThemePreference());
  const mode = resolveThemeMode(preference);
  const isDark = mode === 'dark';

  root.classList.toggle('wa-dark', isDark);
  root.classList.toggle('wa-light', !isDark);
  root.style.colorScheme = mode;
  root.dataset.theme = mode;
  root.dataset.themePreference = preference;
}

applyThemeBootstrap();
