const inputEl = document.getElementById('input');
const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');
const translateBtn = document.getElementById('translateBtn');
const copyBtn = document.getElementById('copyBtn');
const settingsBtn = document.getElementById('settingsBtn');

function setStatus(message, type) {
  statusEl.textContent = message || '';
  statusEl.className = `status${type ? ` ${type}` : ''}`;
}

async function doTranslate() {
  const text = inputEl.value.trim();
  if (!text) {
    setStatus('请输入要翻译的文本。', 'error');
    outputEl.textContent = '';
    copyBtn.disabled = true;
    return;
  }

  translateBtn.disabled = true;
  copyBtn.disabled = true;
  setStatus('翻译中…', '');

  try {
    const result = await window.snapTranslate.translateText(text);
    if (!result.ok) {
      setStatus(`翻译失败：${result.error || '未知错误'}`, 'error');
      outputEl.textContent = '';
      return;
    }
    outputEl.textContent = result.text || '';
    copyBtn.disabled = !result.text;
    setStatus('翻译完成。', 'success');
  } catch (error) {
    setStatus(`翻译失败：${error.message || error}`, 'error');
    outputEl.textContent = '';
  } finally {
    translateBtn.disabled = false;
  }
}

async function copyResult() {
  if (!outputEl.textContent) {
    return;
  }
  try {
    await navigator.clipboard.writeText(outputEl.textContent);
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
    await window.snapTranslate.openSettings();
  } catch (error) {
    setStatus(`打开设置失败：${error.message || error}`, 'error');
  }
});

inputEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    doTranslate();
  }
});
