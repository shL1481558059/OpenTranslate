const formEl = document.getElementById('settingsForm');
const engineEl = document.getElementById('engine');
const translationApiUrlEl = document.getElementById('translationApiUrl');
const apiExposeLanEl = document.getElementById('apiExposeLan');
const apiPortEl = document.getElementById('apiPort');
const llmApiUrlEl = document.getElementById('llmApiUrl');
const llmApiKeyEl = document.getElementById('llmApiKey');
const llmModelEl = document.getElementById('llmModel');
const hotkeyEl = document.getElementById('hotkey');
const llmFieldsEl = document.getElementById('llmFields');
const statusEl = document.getElementById('status');
const backBtn = document.getElementById('backBtn');
let hotkeyBinding = false;

function setStatus(message, type) {
  statusEl.textContent = message || '';
  statusEl.className = `status${type ? ` ${type}` : ''}`;
}

function toggleFields() {
  if (engineEl.value === 'llm') {
    llmFieldsEl.style.display = 'grid';
  } else {
    llmFieldsEl.style.display = 'none';
  }
}

function normalizePort(value) {
  const num = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(num) || num < 1 || num > 65535) {
    return null;
  }
  return num;
}

function syncTranslationApiUrl() {
  if (!apiPortEl || !translationApiUrlEl) return;
  const port = normalizePort(apiPortEl.value) || 8787;
  translationApiUrlEl.value = `http://127.0.0.1:${port}/v1/translate`;
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
    return baseKey;
  }
  return `${parts.join('+')}+${baseKey}`;
}

async function loadSettings() {
  try {
    const settings = await window.snapTranslate.getSettings();
    engineEl.value = settings.engine || 'api';
    translationApiUrlEl.value = settings.translationApiUrl || '';
    translationApiUrlEl.readOnly = true;
    llmApiUrlEl.value = settings.llmApiUrl || '';
    llmApiKeyEl.value = settings.llmApiKey || '';
    llmModelEl.value = settings.llmModel || '';
    hotkeyEl.value = settings.hotkey || '';
    apiExposeLanEl.checked = settings.apiExposeLan !== false;
    apiPortEl.value = settings.apiPort || 8787;
    hotkeyEl.readOnly = true;
    syncTranslationApiUrl();
    toggleFields();
  } catch (error) {
    setStatus('加载设置失败。', 'error');
  }
}

engineEl.addEventListener('change', toggleFields);
apiPortEl?.addEventListener('input', syncTranslationApiUrl);

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('保存中…');

  const payload = {
    engine: engineEl.value,
    translationApiUrl: translationApiUrlEl.value.trim(),
    llmApiUrl: llmApiUrlEl.value.trim(),
    llmApiKey: llmApiKeyEl.value.trim(),
    llmModel: llmModelEl.value.trim(),
    apiExposeLan: apiExposeLanEl.checked,
    apiPort: normalizePort(apiPortEl.value) || 8787
  };

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

  if (event.key === 'Escape') {
    hotkeyEl.value = '';
    setStatus('已清空快捷键。', '');
    return;
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    hotkeyEl.value = '';
    setStatus('已清空快捷键。', '');
    return;
  }

  const accelerator = buildAccelerator(event);
  if (!accelerator) {
    setStatus('不支持该按键，请按组合键。', 'error');
    return;
  }

  hotkeyEl.value = accelerator;
  hotkeyBinding = true;
  const result = await window.snapTranslate.updateHotkey(accelerator);
  hotkeyBinding = false;
  if (!result.ok) {
    setStatus(`快捷键更新失败：${result.error || '未知错误'}`, 'error');
    return;
  }
  setStatus(`快捷键已更新为 ${accelerator}`, 'success');
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
