import { applyThemePreference, normalizeThemePreference } from './theme.js';
import './webawesome.js';
import { initPageTransition, navigateWithTransition } from './page-transition.js';

const formEl = document.getElementById('settingsForm');
const engineEl = document.getElementById('engine');
const themeEl = document.getElementById('theme');
const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const translationApiUrlEl = document.getElementById('translationApiUrl');
const apiSectionEl = document.getElementById('apiSection');
const llmApiUrlEl = document.getElementById('llmApiUrl');
const llmApiKeyEl = document.getElementById('llmApiKey');
const llmModelEl = document.getElementById('llmModel');
const hotkeyEl = document.getElementById('hotkey');
const llmFieldsEl = document.getElementById('llmFields');
const statusEl = document.getElementById('status');
const backBtn = document.getElementById('backBtn');
const saveBtn = document.getElementById('saveBtn');
const launchAtLoginEl = document.getElementById('launchAtLogin');
const launchAtLoginHelpEl = document.getElementById('launchAtLoginHelp');
const repairLaunchAtLoginBtn = document.getElementById('repairLaunchAtLoginBtn');
const moveToApplicationsBtn = document.getElementById('moveToApplicationsBtn');
const STATUS_VARIANTS = {
  error: 'danger',
  success: 'success'
};
const HOTKEY_ERROR_MESSAGES = {
  hotkey_requires_modifier: '请使用组合键（至少包含 Command / Control / Alt / Shift）。',
  hotkey_register_failed: '系统未能注册该快捷键，请更换后重试。',
  invalid_hotkey: '快捷键格式无效。'
};
const SETTINGS_ERROR_MESSAGES = {
  launch_at_login_unsupported: '当前平台不支持开机自启。',
  launch_at_login_unavailable_in_dev: '开发环境下不提供开机自启，请使用打包后的应用。',
  launch_at_login_requires_applications_folder: '请先把应用移到“应用程序”文件夹，然后再开启开机自启。',
  launch_at_login_update_failed: '开机自启更新失败。',
  launch_at_login_repair_failed: '修复开机自启失败。',
  move_to_applications_unsupported: '当前平台不支持移动到“应用程序”文件夹。',
  move_to_applications_unavailable_in_dev: '开发环境下不能移动应用，请使用打包后的应用。',
  move_to_applications_cancelled: '已取消移动到“应用程序”文件夹。',
  move_to_applications_failed: '移动到“应用程序”文件夹失败。'
};
const LAUNCH_AT_LOGIN_HELP_MESSAGES = {
  unsupported: '当前平台暂不支持开机自启。',
  unavailable_in_dev: '开发环境下不建议启用开机自启，打包后的应用中可用。',
  requires_applications_folder: '当前应用不在“应用程序”文件夹中，先移动过去再开启开机自启。',
  'requires-approval': '系统已收到请求，但仍需在系统设置里批准。',
  'not-found': '系统里残留了旧的开机自启记录，修复后就能重新绑定当前应用。'
};
const SPECIAL_ACCELERATOR_KEYS = {
  Tab: 'Tab',
  Enter: 'Enter',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
};
const HOTKEY_CLEAR_KEYS = new Set(['Escape', 'Backspace', 'Delete']);
let hotkeyBinding = false;
let cachedApiUrl = '';
let launchAtLoginState = null;

function getStatusVariant(type) {
  return STATUS_VARIANTS[type] || 'neutral';
}

function setStatus(message, type) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.variant = 'neutral';
    return;
  }

  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.variant = getStatusVariant(type);
}

function isHotkeyError(errorCode) {
  return String(errorCode || '').startsWith('hotkey_') || errorCode === 'invalid_hotkey';
}

function getHotkeyErrorMessage(errorCode) {
  return HOTKEY_ERROR_MESSAGES[errorCode] || errorCode || '未知错误';
}

function getSettingsErrorMessage(errorCode) {
  if (!errorCode) {
    return '保存失败。';
  }
  if (isHotkeyError(errorCode)) {
    return getHotkeyErrorMessage(errorCode);
  }
  return SETTINGS_ERROR_MESSAGES[errorCode] || errorCode;
}

function getLaunchAtLoginHelp(settings) {
  if (!settings?.launchAtLoginAvailable) {
    return LAUNCH_AT_LOGIN_HELP_MESSAGES[settings?.launchAtLoginStatus] || '当前环境无法管理开机自启。';
  }

  return LAUNCH_AT_LOGIN_HELP_MESSAGES[settings.launchAtLoginStatus] || '登录系统后自动启动 OpenTranslate。';
}

function getActionErrorMessage(error) {
  return error?.message || error;
}

function applyReturnedSettings(result) {
  if (result?.settings) {
    applyLaunchAtLoginState(result.settings);
  }
}

function syncLaunchAtLoginActions(settings) {
  const status = settings?.launchAtLoginStatus || '';

  if (repairLaunchAtLoginBtn) {
    repairLaunchAtLoginBtn.hidden = status !== 'not-found';
    repairLaunchAtLoginBtn.textContent = launchAtLoginEl.checked ? '修复并启用自启' : '修复自启项';
  }

  if (moveToApplicationsBtn) {
    moveToApplicationsBtn.hidden = status !== 'requires_applications_folder';
  }
}

function applyLaunchAtLoginState(settings) {
  launchAtLoginState = settings || null;
  launchAtLoginEl.checked = !!settings?.launchAtLogin;
  launchAtLoginEl.disabled = !settings?.launchAtLoginAvailable;
  launchAtLoginHelpEl.textContent = getLaunchAtLoginHelp(settings);
  syncLaunchAtLoginActions(settings);
}

async function clearHotkeyInput() {
  if (!window.snapTranslate?.updateHotkey) {
    setStatus('无法清空快捷键。', 'error');
    return;
  }

  const previous = hotkeyEl.value;
  hotkeyBinding = true;

  try {
    const result = await window.snapTranslate.updateHotkey('');
    if (!result?.ok) {
      hotkeyEl.value = previous;
      setStatus(`快捷键清空失败：${getHotkeyErrorMessage(result?.error)}`, 'error');
      return;
    }

    hotkeyEl.value = '';
    setStatus('快捷键已清空。', 'success');
  } finally {
    hotkeyBinding = false;
  }
}

function updateModeFields() {
  const engine = engineEl.value;
  llmFieldsEl.hidden = engine !== 'llm';
  apiSectionEl.hidden = engine !== 'api';

  if (engine === 'api') {
    translationApiUrlEl.readOnly = false;
    translationApiUrlEl.value = cachedApiUrl || '';
  } else {
    translationApiUrlEl.readOnly = true;
  }
}

function normalizeLang(value, fallback) {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

function getAcceleratorBaseKey(code, key) {
  if (code.startsWith('Key')) {
    return code.slice(3);
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  if (/^F\d{1,2}$/.test(code)) {
    return code;
  }
  if (code.startsWith('Arrow')) {
    return code.replace('Arrow', '');
  }
  return SPECIAL_ACCELERATOR_KEYS[key] || '';
}

function buildAccelerator(event) {
  const code = event.code || '';
  const key = event.key || '';

  if (key === 'Escape') {
    return 'Escape';
  }

  const baseKey = getAcceleratorBaseKey(code, key);
  if (!baseKey) {
    return null;
  }

  const parts = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  if (!parts.length) {
    return null;
  }

  return `${parts.join('+')}+${baseKey}`;
}

async function loadSettings() {
  try {
    const settings = await window.snapTranslate.getSettings();
    engineEl.value = settings.engine || 'api';
    themeEl.value = normalizeThemePreference(settings.theme);
    sourceLangEl.value = settings.sourceLang || 'auto';
    targetLangEl.value = settings.targetLang || 'zh-CN';
    cachedApiUrl = settings.translationApiUrl || '';
    translationApiUrlEl.value = cachedApiUrl;
    llmApiUrlEl.value = settings.llmApiUrl || '';
    llmApiKeyEl.value = settings.llmApiKey || '';
    llmModelEl.value = settings.llmModel || '';
    hotkeyEl.value = settings.hotkey || '';
    hotkeyEl.readOnly = true;
    applyLaunchAtLoginState(settings);
    updateModeFields();
  } catch (error) {
    setStatus('加载设置失败。', 'error');
  }
}

engineEl.addEventListener('change', updateModeFields);
themeEl.addEventListener('change', () => {
  applyThemePreference(themeEl.value, { persist: false });
});
translationApiUrlEl.addEventListener('input', () => {
  if (engineEl.value === 'api') {
    cachedApiUrl = translationApiUrlEl.value.trim();
  }
});
launchAtLoginEl.addEventListener('change', () => {
  syncLaunchAtLoginActions({
    ...launchAtLoginState,
    launchAtLogin: !!launchAtLoginEl.checked
  });
});

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveBtn.loading = true;
  setStatus('保存中…');

  try {
    const payload = {
      engine: engineEl.value,
      theme: normalizeThemePreference(themeEl.value),
      sourceLang: normalizeLang(sourceLangEl.value, 'auto'),
      targetLang: normalizeLang(targetLangEl.value, 'zh-CN'),
      llmApiUrl: llmApiUrlEl.value.trim(),
      llmApiKey: llmApiKeyEl.value.trim(),
      llmModel: llmModelEl.value.trim(),
      launchAtLogin: !!launchAtLoginEl.checked
    };

    if (engineEl.value === 'api') {
      payload.translationApiUrl = translationApiUrlEl.value.trim();
    }

    const result = await window.snapTranslate.setSettings(payload);
    applyReturnedSettings(result);
    if (!result.ok) {
      setStatus(getSettingsErrorMessage(result.error), 'error');
      return;
    }

    applyThemePreference(result?.settings?.theme || themeEl.value);
    setStatus('设置已保存。', 'success');
  } catch (error) {
    setStatus(`保存失败：${getActionErrorMessage(error)}`, 'error');
  } finally {
    saveBtn.loading = false;
  }
});

hotkeyEl.addEventListener('keydown', async (event) => {
  if (hotkeyBinding) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (HOTKEY_CLEAR_KEYS.has(event.key)) {
    await clearHotkeyInput();
    return;
  }

  const accelerator = buildAccelerator(event);
  if (!accelerator) {
    setStatus('不支持该按键，请按组合键。', 'error');
    return;
  }

  hotkeyEl.value = accelerator;
  hotkeyBinding = true;

  try {
    const result = await window.snapTranslate.updateHotkey(accelerator);
    if (!result.ok) {
      setStatus(`快捷键更新失败：${getHotkeyErrorMessage(result.error)}`, 'error');
      return;
    }

    setStatus(`快捷键已更新为 ${accelerator}`, 'success');
  } catch (error) {
    setStatus(`快捷键更新失败：${getActionErrorMessage(error)}`, 'error');
  } finally {
    hotkeyBinding = false;
  }
});

backBtn.addEventListener('click', async () => {
  if (!window.snapTranslate?.openTranslate) {
    setStatus('无法返回翻译页。', 'error');
    return;
  }

  try {
    await navigateWithTransition((options) => window.snapTranslate.openTranslate(options), 'back');
  } catch (error) {
    setStatus(`返回失败：${getActionErrorMessage(error)}`, 'error');
  }
});

repairLaunchAtLoginBtn?.addEventListener('click', async () => {
  if (!window.snapTranslate?.repairLaunchAtLogin) {
    setStatus('当前版本不支持修复开机自启。', 'error');
    return;
  }

  repairLaunchAtLoginBtn.loading = true;
  setStatus('正在修复开机自启…');

  try {
    const result = await window.snapTranslate.repairLaunchAtLogin(!!launchAtLoginEl.checked);
    applyReturnedSettings(result);
    if (!result?.ok) {
      setStatus(getSettingsErrorMessage(result?.error), 'error');
      return;
    }

    setStatus(launchAtLoginEl.checked ? '开机自启已修复并启用。' : '开机自启记录已修复。', 'success');
  } catch (error) {
    setStatus(`修复失败：${getActionErrorMessage(error)}`, 'error');
  } finally {
    repairLaunchAtLoginBtn.loading = false;
  }
});

moveToApplicationsBtn?.addEventListener('click', async () => {
  if (!window.snapTranslate?.moveToApplicationsFolder) {
    setStatus('当前版本不支持移动应用位置。', 'error');
    return;
  }

  moveToApplicationsBtn.loading = true;

  try {
    const result = await window.snapTranslate.moveToApplicationsFolder();
    applyReturnedSettings(result);
    if (!result?.ok) {
      if (result?.error !== 'move_to_applications_cancelled') {
        setStatus(getSettingsErrorMessage(result?.error), 'error');
      } else {
        setStatus(getSettingsErrorMessage(result?.error));
      }
      return;
    }

    if (result?.relaunching) {
      setStatus('正在移动到“应用程序”文件夹，并重新打开应用…', 'success');
      return;
    }

    setStatus('应用已经在“应用程序”文件夹中。', 'success');
  } catch (error) {
    setStatus(`移动失败：${getActionErrorMessage(error)}`, 'error');
  } finally {
    moveToApplicationsBtn.loading = false;
  }
});

loadSettings();
initPageTransition();
