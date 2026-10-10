import './theme.js';
import { languageOptions, shouldRetranslate } from './languages.mjs';
import { initPageTransition, navigateWithTransition } from './page-transition.js';

const inputEl = document.getElementById('input');
const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');
const translateBtn = document.getElementById('translateBtn');
const copyBtn = document.getElementById('copyBtn');
const settingsBtn = document.getElementById('settingsBtn');
const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
let appliedTarget = 'zh-CN';
let translateSeq = 0;

function getErrorMessage(error) {
  return error?.message || error;
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

function setStatus(message, type) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    delete statusEl.dataset.tone;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.dataset.tone = type || 'neutral';
}

function normalizeLang(value, fallback) {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
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
  select.value = known.has(selected) || items.some((item) => item.value === selected) ? selected : fallback;
}

function getSelectedLanguages() {
  return {
    sourceLang: normalizeLang(sourceLangEl.value, 'auto'),
    targetLang: normalizeLang(targetLangEl.value, 'zh-CN')
  };
}

async function loadSettings() {
  try {
    const settings = await window.snapTranslate.getSettings();
    fillLanguageSelect(sourceLangEl, languageOptions({ includeAuto: true }), settings.sourceLang || 'auto', 'auto');
    fillLanguageSelect(targetLangEl, languageOptions({ includeAuto: false }), settings.targetLang || 'zh-CN', 'zh-CN');
    appliedTarget = targetLangEl.value;
    if (settings.configured === false) {
      setStatus('尚未配置翻译接口，请打开设置填写接口类型和地址。', 'error');
    }
  } catch (error) {
    fillLanguageSelect(sourceLangEl, languageOptions({ includeAuto: true }), 'auto', 'auto');
    fillLanguageSelect(targetLangEl, languageOptions({ includeAuto: false }), 'zh-CN', 'zh-CN');
    setStatus('加载设置失败。', 'error');
  }
}

async function saveLangSettings() {
  if (!window.snapTranslate?.setSettings) {
    return;
  }
  try {
    await window.snapTranslate.setSettings(getSelectedLanguages());
  } catch (error) {
    setStatus(`保存语言设置失败：${getErrorMessage(error)}`, 'error');
  }
}

async function doTranslate() {
  const seq = ++translateSeq;
  const text = inputEl.value.trim();
  if (!text) {
    setStatus('请输入要翻译的文本。', 'error');
    outputEl.value = '';
    copyBtn.disabled = true;
    return;
  }

  setBusy(translateBtn, true);
  copyBtn.disabled = true;
  setStatus('翻译中…');

  try {
    const result = await window.snapTranslate.translateText(text, getSelectedLanguages());
    if (seq !== translateSeq) {
      return;
    }
    if (!result.ok) {
      setStatus(`翻译失败：${result.error || '未知错误'}`, 'error');
      outputEl.value = '';
      return;
    }
    outputEl.value = result.text || '';
    copyBtn.disabled = !result.text;
    setStatus('翻译完成。', 'success');
  } catch (error) {
    if (seq !== translateSeq) {
      return;
    }
    setStatus(`翻译失败：${getErrorMessage(error)}`, 'error');
    outputEl.value = '';
  } finally {
    if (seq === translateSeq) {
      setBusy(translateBtn, false);
    }
  }
}

async function copyResult() {
  if (!outputEl.value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(outputEl.value);
    setStatus('已复制到剪贴板。', 'success');
  } catch (error) {
    setStatus('复制失败。', 'error');
  }
}

translateBtn.addEventListener('click', doTranslate);
copyBtn.addEventListener('click', copyResult);
settingsBtn.addEventListener('click', async () => {
  if (!window.snapTranslate?.openSettings) {
    setStatus('无法打开设置。', 'error');
    return;
  }
  try {
    await navigateWithTransition((options) => window.snapTranslate.openSettings(options), 'forward');
  } catch (error) {
    setStatus(`打开设置失败：${getErrorMessage(error)}`, 'error');
  }
});

sourceLangEl.addEventListener('change', saveLangSettings);
targetLangEl.addEventListener('change', async () => {
  const previous = appliedTarget;
  const next = targetLangEl.value;
  await saveLangSettings();
  appliedTarget = targetLangEl.value;
  if (shouldRetranslate(inputEl.value, previous, next)) {
    await doTranslate();
  }
});

inputEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    doTranslate();
  }
});

loadSettings();
initPageTransition();
