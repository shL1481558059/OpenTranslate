const formEl = document.getElementById('settingsForm');
const engineEl = document.getElementById('engine');
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
let hotkeyBinding = false;
let cachedApiUrl = '';

function setStatus(message, type) {
  statusEl.textContent = message || '';
  statusEl.className = `status${type ? ` ${type}` : ''}`;
}

function getHotkeyErrorMessage(errorCode) {
  if (errorCode === 'hotkey_requires_modifier') {
    return '请使用组合键（至少包含 Command / Control / Alt / Shift）。';
  }
  if (errorCode === 'hotkey_register_failed') {
    return '系统未能注册该快捷键，请更换后重试。';
  }
  if (errorCode === 'invalid_hotkey') {
    return '快捷键格式无效。';
  }
  return errorCode || '未知错误';
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
  llmFieldsEl.style.display = engine === 'llm' ? 'grid' : 'none';
  apiSectionEl.style.display = engine === 'api' ? 'grid' : 'none';

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

function buildAccelerator(event) {
  const code = event.code || '';
  const key = event.key || '';

  if (key === 'Escape') {
    return 'Escape';
  }

  let baseKey = '';
  if (code.startsWith('Key')) {
    baseKey = code.slice(3);
  } else if (code.startsWith('Digit')) {
    baseKey = code.slice(5);
  } else if (/^F\\d{1,2}$/.test(code)) {
    baseKey = code;
  } else if (code.startsWith('Arrow')) {
    baseKey = code.replace('Arrow', '');
  } else {
    const mapped = {
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
    baseKey = mapped[key] || '';
  }

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
    sourceLangEl.value = settings.sourceLang || 'auto';
    targetLangEl.value = settings.targetLang || 'zh-CN';
    cachedApiUrl = settings.translationApiUrl || '';
    translationApiUrlEl.value = cachedApiUrl;
    llmApiUrlEl.value = settings.llmApiUrl || '';
    llmApiKeyEl.value = settings.llmApiKey || '';
    llmModelEl.value = settings.llmModel || '';
    hotkeyEl.value = settings.hotkey || '';
    hotkeyEl.readOnly = true;
    updateModeFields();
  } catch (error) {
    setStatus('加载设置失败。', 'error');
  }
}

engineEl.addEventListener('change', updateModeFields);
translationApiUrlEl?.addEventListener('input', () => {
  if (engineEl.value === 'api') {
    cachedApiUrl = translationApiUrlEl.value.trim();
  }
});

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('保存中…');

  const payload = {
    engine: engineEl.value,
    sourceLang: normalizeLang(sourceLangEl.value, 'auto'),
    targetLang: normalizeLang(targetLangEl.value, 'zh-CN'),
    llmApiUrl: llmApiUrlEl.value.trim(),
    llmApiKey: llmApiKeyEl.value.trim(),
    llmModel: llmModelEl.value.trim()
  };
  if (engineEl.value === 'api') {
    payload.translationApiUrl = translationApiUrlEl.value.trim();
  }

  const result = await window.snapTranslate.setSettings(payload);
  if (!result.ok) {
    setStatus(result.error || '保存失败。', 'error');
    return;
  }

  setStatus('设置已保存。', 'success');
});

hotkeyEl.addEventListener('keydown', async (event) => {
  if (hotkeyBinding) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') {
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
    setStatus(`快捷键更新失败：${error.message || error}`, 'error');
  } finally {
    hotkeyBinding = false;
  }
});

backBtn?.addEventListener('click', async () => {
  if (!window.snapTranslate?.openTranslate) {
    setStatus('无法返回翻译页。', 'error');
    return;
  }
  try {
    await window.snapTranslate.openTranslate();
  } catch (error) {
    setStatus(`返回失败：${error.message || error}`, 'error');
  }
});

loadSettings();
