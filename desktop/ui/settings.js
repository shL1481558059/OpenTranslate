const formEl = document.getElementById('settingsForm');
const engineEl = document.getElementById('engine');
const translationApiUrlEl = document.getElementById('translationApiUrl');
const llmApiUrlEl = document.getElementById('llmApiUrl');
const llmApiKeyEl = document.getElementById('llmApiKey');
const llmModelEl = document.getElementById('llmModel');
const hotkeyEl = document.getElementById('hotkey');
const llmFieldsEl = document.getElementById('llmFields');
const statusEl = document.getElementById('status');
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
    llmApiUrlEl.value = settings.llmApiUrl || '';
    llmApiKeyEl.value = settings.llmApiKey || '';
    llmModelEl.value = settings.llmModel || '';
    hotkeyEl.value = settings.hotkey || '';
    hotkeyEl.readOnly = true;
    toggleFields();
  } catch (error) {
    setStatus('加载设置失败。', 'error');
  }
}

engineEl.addEventListener('change', toggleFields);

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('保存中…');

  const payload = {
    engine: engineEl.value,
    translationApiUrl: translationApiUrlEl.value.trim(),
    llmApiUrl: llmApiUrlEl.value.trim(),
    llmApiKey: llmApiKeyEl.value.trim(),
    llmModel: llmModelEl.value.trim()
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

loadSettings();
