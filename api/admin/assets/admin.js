const statusEl = document.getElementById('status');
const reloadBtn = document.getElementById('reloadBtn');
const refreshModelsBtn = document.getElementById('refreshModelsBtn');
const saveBtn = document.getElementById('saveBtn');

const engineSelect = document.getElementById('engineSelect');
const argosDir = document.getElementById('argosDir');
const marianDir = document.getElementById('marianDir');
const pythonPath = document.getElementById('pythonPath');
const venvDir = document.getElementById('venvDir');
const timeoutMs = document.getElementById('timeoutMs');

const marianModelId = document.getElementById('marianModelId');
const marianEndpoint = document.getElementById('marianEndpoint');
const marianDisableSsl = document.getElementById('marianDisableSsl');
const marianDevice = document.getElementById('marianDevice');
const marianDtype = document.getElementById('marianDtype');
const marianMaxTokens = document.getElementById('marianMaxTokens');

const argosModelsCard = document.getElementById('argosModelsCard');
const marianModelsCard = document.getElementById('marianModelsCard');
const marianParamsCard = document.getElementById('marianParamsCard');
const marianCustomRow = document.getElementById('marianCustomRow');

const argosInstalledEl = document.getElementById('argosInstalled');
const argosAvailableEl = document.getElementById('argosAvailable');
const marianInstalledEl = document.getElementById('marianInstalled');
const marianAvailableEl = document.getElementById('marianAvailable');
const customMarianId = document.getElementById('customMarianId');
const downloadCustomMarian = document.getElementById('downloadCustomMarian');

const token = new URLSearchParams(window.location.search).get('token') || '';

function setStatus(message, type, progress, details) {
  const classes = ['status'];
  if (type) classes.push(type);
  if (progress) classes.push('has-progress');
  if (progress?.indeterminate) classes.push('is-loading');
  statusEl.className = classes.join(' ');

  statusEl.innerHTML = '';
  const text = document.createElement('div');
  text.className = 'status-text';
  text.textContent = message || '';
  statusEl.appendChild(text);

  if (progress) {
    const bar = document.createElement('div');
    bar.className = 'status-bar';
    const fill = document.createElement('div');
    fill.className = 'status-bar__fill';
    if (!progress.indeterminate) {
      const percent = Math.max(0, Math.min(100, Number(progress.value || 0)));
      fill.style.width = `${percent}%`;
    }
    bar.appendChild(fill);
    statusEl.appendChild(bar);
  }

  if (details) {
    const detailEl = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看详情';
    const pre = document.createElement('pre');
    pre.textContent = details;
    detailEl.appendChild(summary);
    detailEl.appendChild(pre);
    statusEl.appendChild(detailEl);
  }
}

function parseApiError(error) {
  const raw = error?.message ? String(error.message) : String(error || '');
  let summary = raw;
  let details = '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      summary = parsed.message || parsed.error || raw;
      details = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // ignore
  }
  if (summary.length > 160) {
    details = details || summary;
    summary = `${summary.slice(0, 160)}…`;
  }
  return { summary, details };
}

function setErrorStatus(prefix, error) {
  const { summary, details } = parseApiError(error);
  const message = prefix ? `${prefix}${summary ? `：${summary}` : ''}` : summary;
  setStatus(message || '操作失败', 'error', null, details);
}

async function withDownloadProgress(label, button, runner) {
  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
    button.textContent = '下载中…';
  }
  setStatus(`下载中：${label}`, 'loading', { indeterminate: true });
  try {
    await runner();
    setStatus(`下载完成：${label}`, 'success', { value: 100 });
  } catch (error) {
    setErrorStatus('下载失败', error);
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.textContent = originalText;
    }
  }
}

function updateEngineVisibility() {
  const engine = engineSelect.value || 'argos';
  const showArgos = engine === 'argos';
  const showMarian = engine === 'marian';
  if (argosModelsCard) {
    argosModelsCard.classList.toggle('is-hidden', !showArgos);
  }
  if (marianModelsCard) {
    marianModelsCard.classList.toggle('is-hidden', !showMarian);
  }
  if (marianParamsCard) {
    marianParamsCard.classList.toggle('is-hidden', !showMarian);
  }
  if (marianCustomRow) {
    marianCustomRow.classList.toggle('is-hidden', !showMarian);
  }
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request_failed:${response.status}`);
  }
  return response.json();
}

function clearList(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderEmpty(container, text) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = text;
  container.appendChild(empty);
}

function renderRow(container, title, meta, actions = []) {
  const row = document.createElement('div');
  row.className = 'row';
  const left = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.className = 'row-title';
  titleEl.textContent = title || '';
  const metaEl = document.createElement('div');
  metaEl.className = 'meta';
  metaEl.textContent = meta || '';
  left.appendChild(titleEl);
  left.appendChild(metaEl);
  const right = document.createElement('div');
  right.className = 'actions';
  actions.forEach((btn) => right.appendChild(btn));
  row.appendChild(left);
  row.appendChild(right);
  container.appendChild(row);
}

async function loadConfig() {
  const data = await apiFetch('/v1/config');
  const config = data.config || {};
  engineSelect.value = config.engine || 'argos';
  if (argosDir) argosDir.value = config.local?.argosModelDir || '';
  if (marianDir) marianDir.value = config.local?.marianModelDir || '';
  if (pythonPath) pythonPath.value = config.local?.pythonPath || '';
  if (venvDir) venvDir.value = config.local?.venvDir || '';
  if (timeoutMs) timeoutMs.value = config.local?.timeoutMs || 20000;
  if (marianModelId) marianModelId.value = config.marian?.modelId || '';
  if (marianEndpoint) marianEndpoint.value = config.marian?.hfEndpoint || '';
  if (marianDisableSsl) marianDisableSsl.checked = !!config.marian?.hfDisableSslVerify;
  if (marianDevice) marianDevice.value = config.marian?.device || 'cpu';
  if (marianDtype) marianDtype.value = config.marian?.dtype || 'float32';
  if (marianMaxTokens) marianMaxTokens.value = config.marian?.maxTokens || 512;
  updateEngineVisibility();
}

async function saveConfig() {
  const payload = {
    engine: engineSelect.value,
    marian: {
      modelId: marianModelId ? marianModelId.value.trim() : '',
      hfEndpoint: marianEndpoint ? marianEndpoint.value.trim() : '',
      hfDisableSslVerify: marianDisableSsl ? !!marianDisableSsl.checked : false,
      device: marianDevice ? marianDevice.value.trim() : '',
      dtype: marianDtype ? marianDtype.value.trim() : '',
      maxTokens: marianMaxTokens ? Number(marianMaxTokens.value || 512) : 512
    }
  };
  const local = {};
  let hasLocal = false;
  if (argosDir) {
    local.argosModelDir = argosDir.value.trim();
    hasLocal = true;
  }
  if (marianDir) {
    local.marianModelDir = marianDir.value.trim();
    hasLocal = true;
  }
  if (pythonPath) {
    local.pythonPath = pythonPath.value.trim();
    hasLocal = true;
  }
  if (venvDir) {
    local.venvDir = venvDir.value.trim();
    hasLocal = true;
  }
  if (timeoutMs) {
    local.timeoutMs = Number(timeoutMs.value || 20000);
    hasLocal = true;
  }
  if (hasLocal) {
    payload.local = local;
  }
  await apiFetch('/v1/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function loadModels(options = {}) {
  const refreshRemote = !!options.refreshRemote;
  clearList(argosInstalledEl);
  clearList(argosAvailableEl);
  clearList(marianInstalledEl);
  clearList(marianAvailableEl);

  const [argosInstalled, argosAvailable, marianInstalled, marianAvailable] = await Promise.all([
    apiFetch('/v1/models/installed?engine=argos'),
    apiFetch(`/v1/models/available?engine=argos${refreshRemote ? '&refresh=1' : ''}`),
    apiFetch('/v1/models/installed?engine=marian'),
    apiFetch(`/v1/models/available?engine=marian${refreshRemote ? '&refresh=1' : ''}`)
  ]);

  const argosInstalledList = argosInstalled.installed || [];
  if (!argosInstalledList.length) {
    renderEmpty(argosInstalledEl, '暂无已安装 Argos 模型。');
  }
  argosInstalledList.forEach((item) => {
    const title = item.from && item.to ? `${item.from} → ${item.to}` : item.filename || '未知模型';
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = '移除';
    btn.addEventListener('click', async () => {
      await apiFetch('/v1/models/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'argos', filename: item.filename })
      });
      await loadModels();
    });
    renderRow(argosInstalledEl, title, item.filename || '', [btn]);
  });

  const argosAvailableList = argosAvailable.available || [];
  if (!argosAvailableList.length) {
    const message = argosAvailable.cache_miss
      ? '暂无缓存，请点击“刷新模型列表”获取。'
      : '暂无可下载 Argos 模型。';
    renderEmpty(argosAvailableEl, message);
  }
  argosAvailableList.forEach((item) => {
    const title = `${item.from_code} → ${item.to_code}`;
    const meta = [item.package_name, item.package_version].filter(Boolean).join(' · ');
    const btn = document.createElement('button');
    btn.textContent = '下载';
    btn.addEventListener('click', async () => {
      try {
        await withDownloadProgress(`${item.from_code} → ${item.to_code}`, btn, async () => {
          await apiFetch('/v1/models/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: 'argos', from: item.from_code, to: item.to_code })
          });
        });
        await loadModels();
      } catch (error) {
        setErrorStatus('下载失败', error);
      }
    });
    renderRow(argosAvailableEl, title, meta, [btn]);
  });

  const marianInstalledList = marianInstalled.installed || [];
  if (!marianInstalledList.length) {
    renderEmpty(marianInstalledEl, '暂无已安装 Marian 模型。');
  }
  marianInstalledList.forEach((item) => {
    const title = item.model_id || '未知模型';
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = '移除';
    btn.addEventListener('click', async () => {
      await apiFetch('/v1/models/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'marian', modelId: item.model_id })
      });
      await loadModels();
    });
    renderRow(marianInstalledEl, title, item.local_dir || '', [btn]);
  });

  const marianAvailableList = marianAvailable.available || [];
  if (!marianAvailableList.length) {
    const message = marianAvailable.cache_miss
      ? '暂无缓存，请点击“刷新模型列表”获取。'
      : '暂无可下载 Marian 模型。';
    renderEmpty(marianAvailableEl, message);
  }
  marianAvailableList.forEach((item) => {
    const title = item.model_id;
    const meta = item.from && item.to ? `${item.from} → ${item.to}` : '';
    const btn = document.createElement('button');
    btn.textContent = '下载';
    btn.addEventListener('click', async () => {
      try {
        await withDownloadProgress(item.model_id, btn, async () => {
          await apiFetch('/v1/models/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: 'marian', modelId: item.model_id })
          });
        });
        await loadModels();
      } catch (error) {
        setErrorStatus('下载失败', error);
      }
    });
    renderRow(marianAvailableEl, title, meta, [btn]);
  });
}

engineSelect.addEventListener('change', () => {
  updateEngineVisibility();
});

reloadBtn.addEventListener('click', async () => {
  setStatus('刷新配置中…');
  try {
    await loadConfig();
    await loadModels();
    setStatus('配置已刷新', 'success');
  } catch (error) {
    setErrorStatus('刷新失败', error);
  }
});

refreshModelsBtn.addEventListener('click', async () => {
  setStatus('刷新模型列表中…', 'loading', { indeterminate: true });
  try {
    await loadModels({ refreshRemote: true });
    setStatus('模型列表已刷新', 'success', { value: 100 });
  } catch (error) {
    setErrorStatus('刷新失败', error);
  }
});

saveBtn.addEventListener('click', async () => {
  setStatus('保存中…');
  try {
    await saveConfig();
    setStatus('配置已保存', 'success');
  } catch (error) {
    setErrorStatus('保存失败', error);
  }
});

downloadCustomMarian.addEventListener('click', async () => {
  const modelId = customMarianId.value.trim();
  if (!modelId) {
    setStatus('请输入模型 ID', 'error');
    return;
  }
  try {
    await withDownloadProgress(modelId, downloadCustomMarian, async () => {
      await apiFetch('/v1/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'marian', modelId })
      });
    });
    await loadModels();
  } catch (error) {
    setErrorStatus('下载失败', error);
  }
});

(async () => {
  try {
    await loadConfig();
    await loadModels();
  } catch (error) {
    setErrorStatus('初始化失败', error);
  }
})();
