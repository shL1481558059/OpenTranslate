import { applyThemePreference, normalizeThemePreference } from './theme.js';
import { languageOptions } from './languages.mjs';
import { initPageTransition, navigateWithTransition } from './page-transition.js';

const formEl = document.getElementById('settingsForm');
const providerEl = document.getElementById('provider');
const themeEl = document.getElementById('theme');
const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const baseUrlEl = document.getElementById('baseUrl');
const apiKeyEl = document.getElementById('apiKey');
const modelEl = document.getElementById('model');
const promptEl = document.getElementById('prompt');
const openaiFieldsEl = document.getElementById('openaiFields');
const baseUrlHintEl = document.getElementById('baseUrlHint');
const apiKeyHintEl = document.getElementById('apiKeyHint');
const apiKeyToggle = document.getElementById('apiKeyToggle');
const testBtn = document.getElementById('testBtn');
const testStatusEl = document.getElementById('testStatus');
const hotkeyEl = document.getElementById('hotkey');
const statusEl = document.getElementById('status');
const backBtn = document.getElementById('backBtn');
const saveBtn = document.getElementById('saveBtn');
const launchAtLoginEl = document.getElementById('launchAtLogin');
const launchAtLoginHelpEl = document.getElementById('launchAtLoginHelp');
const repairLaunchAtLoginBtn = document.getElementById('repairLaunchAtLoginBtn');
const moveToApplicationsBtn = document.getElementById('moveToApplicationsBtn');
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
const PROVIDER_FIELDS = {
  deepl: {
    placeholder: 'https://api-free.deepl.com',
    hint: '官方地址：免费版 https://api-free.deepl.com，专业版 https://api.deepl.com。',
    key: '必填。请求使用 Authorization: DeepL-Auth-Key。'
  },
  deeplx: {
    placeholder: 'http://localhost:7100/deeplx',
    hint: '填写完整地址，例如本地 LinguaSpark 的 http://localhost:7100/deeplx。',
    key: '可选。填写后请求会带 Authorization: Bearer。'
  },
  openai: {
    placeholder: 'https://api.openai.com',
    hint: 'OpenAI 或兼容服务的根地址。末尾已有 /v1 时不会重复拼接。',
    key: '必填。请求使用 Authorization: Bearer。'
  }
};
let hotkeyBinding = false;
let launchAtLoginState = null;

function setNote(el, message, type) {
  if (!el) {
    return;
  }
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    delete el.dataset.tone;
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.dataset.tone = type || 'neutral';
}

function setStatus(message, type) {
  setNote(statusEl, message, type);
}

function setTestStatus(message, type) {
  setNote(testStatusEl, message, type);
}

function setBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
  if (busy) {
    button.dataset.loading = 'true';
  } else {
    delete button.dataset.loading;
  }
}

function fillLanguageSelect(select, options, selected, fallback) {
  const known = new Set(options.map((item) => item.value));
  const items = known.has(selected) || !selected ? options : [...options, { value: selected, label: selected }];
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  const next = items.some((item) => item.value === selected) ? selected : fallback;
  select.value = next;
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

function currentProvider() {
  return PROVIDER_FIELDS[providerEl.value] ? providerEl.value : 'deepl';
}

function updateProviderFields() {
  const provider = currentProvider();
  const fields = PROVIDER_FIELDS[provider];
  baseUrlEl.placeholder = fields.placeholder;
  if (baseUrlHintEl) {
    baseUrlHintEl.textContent = fields.hint;
  }
  if (apiKeyHintEl) {
    apiKeyHintEl.textContent = fields.key;
  }
  openaiFieldsEl.hidden = provider !== 'openai';
}

function currentPayload() {
  return {
    provider: currentProvider(),
    theme: normalizeThemePreference(themeEl.value),
    sourceLang: normalizeLang(sourceLangEl.value, 'auto'),
    targetLang: normalizeLang(targetLangEl.value, 'zh-CN'),
    baseUrl: baseUrlEl.value.trim(),
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim(),
    prompt: promptEl.value.trim(),
    launchAtLogin: !!launchAtLoginEl.checked
  };
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
    providerEl.value = settings.provider || 'deepl';
    themeEl.value = normalizeThemePreference(settings.theme);
    fillLanguageSelect(sourceLangEl, languageOptions({ includeAuto: true }), settings.sourceLang || 'auto', 'auto');
    fillLanguageSelect(targetLangEl, languageOptions({ includeAuto: false }), settings.targetLang || 'zh-CN', 'zh-CN');
    baseUrlEl.value = settings.baseUrl || '';
    apiKeyEl.value = settings.apiKey || '';
    modelEl.value = settings.model || 'gpt-4o-mini';
    promptEl.value = settings.prompt || '';
    hotkeyEl.value = settings.hotkey || '';
    hotkeyEl.readOnly = true;
    applyLaunchAtLoginState(settings);
    updateProviderFields();
    if (settings.configured === false) {
      setStatus('尚未配置翻译接口。填写类型、Base URL 和 API Key 后可以测试连接。');
    }
  } catch (error) {
    fillLanguageSelect(sourceLangEl, languageOptions({ includeAuto: true }), 'auto', 'auto');
    fillLanguageSelect(targetLangEl, languageOptions({ includeAuto: false }), 'zh-CN', 'zh-CN');
    setStatus('加载设置失败。', 'error');
  }
}

providerEl.addEventListener('change', updateProviderFields);
themeEl.addEventListener('change', () => {
  applyThemePreference(themeEl.value, { persist: false });
});
launchAtLoginEl.addEventListener('change', () => {
  syncLaunchAtLoginActions({
    ...launchAtLoginState,
    launchAtLogin: !!launchAtLoginEl.checked
  });
});

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(saveBtn, true);
  setStatus('保存中…');

  try {
    const result = await window.snapTranslate.setSettings(currentPayload());
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
    setBusy(saveBtn, false);
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

  setBusy(repairLaunchAtLoginBtn, true);
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
    setBusy(repairLaunchAtLoginBtn, false);
  }
});

moveToApplicationsBtn?.addEventListener('click', async () => {
  if (!window.snapTranslate?.moveToApplicationsFolder) {
    setStatus('当前版本不支持移动应用位置。', 'error');
    return;
  }

  setBusy(moveToApplicationsBtn, true);

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
    setBusy(moveToApplicationsBtn, false);
  }
});

if (testBtn) {
  testBtn.type = 'button';
}

testBtn?.addEventListener('click', async () => {
  if (!window.snapTranslate?.testTranslation) {
    setStatus('当前版本不支持测试连接。', 'error');
    return;
  }

  setBusy(testBtn, true);
  setTestStatus('正在测试连接…');

  try {
    const result = await window.snapTranslate.testTranslation(currentPayload());
    if (!result?.ok) {
      setTestStatus(result?.error || '连接失败。', 'error');
      return;
    }
    setTestStatus(result.message || '连接成功。', 'success');
  } catch (error) {
    setTestStatus(`连接失败：${getActionErrorMessage(error)}`, 'error');
  } finally {
    setBusy(testBtn, false);
  }
});

apiKeyToggle?.addEventListener('click', () => {
  const show = apiKeyEl.type === 'password';
  apiKeyEl.type = show ? 'text' : 'password';
  apiKeyToggle.textContent = show ? '隐藏' : '显示';
});

loadSettings();
initPageTransition();
