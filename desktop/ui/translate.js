import './theme.js';
import './webawesome.js';
import { initPageTransition, navigateWithTransition } from './page-transition.js';

const inputEl = document.getElementById('input');
const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');
const translateBtn = document.getElementById('translateBtn');
const copyBtn = document.getElementById('copyBtn');
const settingsBtn = document.getElementById('settingsBtn');
const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const STATUS_VARIANTS = {
  error: 'danger',
  success: 'success'
};

function getStatusVariant(type) {
  return STATUS_VARIANTS[type] || 'neutral';
}

function getErrorMessage(error) {
  return error?.message || error;
}

function getSelectedLanguages() {
  return {
    sourceLang: normalizeLang(sourceLangEl.value, 'auto'),
    targetLang: normalizeLang(targetLangEl.value, 'zh-CN')
  };
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

function normalizeLang(value, fallback) {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

async function loadSettings() {
  try {
    const settings = await window.snapTranslate.getSettings();
    sourceLangEl.value = settings.sourceLang || 'auto';
    targetLangEl.value = settings.targetLang || 'zh-CN';
  } catch (error) {
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
  const text = inputEl.value.trim();
  if (!text) {
    setStatus('请输入要翻译的文本。', 'error');
    outputEl.value = '';
    copyBtn.disabled = true;
    return;
  }

  translateBtn.loading = true;
  translateBtn.disabled = true;
  copyBtn.disabled = true;
  setStatus('翻译中…');

  try {
    const result = await window.snapTranslate.translateText(text, getSelectedLanguages());

    if (!result.ok) {
      setStatus(`翻译失败：${result.error || '未知错误'}`, 'error');
      outputEl.value = '';
      return;
    }

    outputEl.value = result.text || '';
    copyBtn.disabled = !result.text;
    setStatus('翻译完成。', 'success');
  } catch (error) {
    setStatus(`翻译失败：${getErrorMessage(error)}`, 'error');
    outputEl.value = '';
  } finally {
    translateBtn.loading = false;
    translateBtn.disabled = false;
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
targetLangEl.addEventListener('change', saveLangSettings);

inputEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    doTranslate();
  }
});

loadSettings();
initPageTransition();
