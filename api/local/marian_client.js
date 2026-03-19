const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { promisify } = require('node:util');
const readline = require('node:readline');

const execFileAsync = promisify(execFile);

const REQUIREMENTS_PATH = path.resolve(__dirname, 'requirements.txt');
let currentConfig = null;

let initPromise = null;
let worker = null;
let rl = null;
let pending = [];
let chain = Promise.resolve();

function getRuntimeConfig() {
  const modelDir = path.resolve(process.env.LOCAL_MARIAN_MODEL_DIR || path.join(process.cwd(), 'models', 'marian'));
  const venvDir = path.resolve(process.env.LOCAL_TRANSLATE_VENV || path.join(process.cwd(), '.venv'));
  const pythonPath = path.resolve(process.env.LOCAL_TRANSLATE_PYTHON || path.join(venvDir, 'bin', 'python'));
  const timeoutMs = Number(process.env.LOCAL_TRANSLATE_TIMEOUT_MS || 20000);
  const hfEndpoint = process.env.MARIAN_HF_ENDPOINT || process.env.HF_ENDPOINT || '';
  const hfDisableSslVerify = Boolean(
    process.env.MARIAN_HF_DISABLE_SSL_VERIFY || process.env.HF_HUB_DISABLE_SSL_VERIFICATION
  );
  const isPackaged = process.env.SNAP_TRANSLATE_IS_PACKAGED === '1';
  const resourcesPath = process.env.SNAP_TRANSLATE_RESOURCES_PATH || process.resourcesPath || '';
  const workerPath = isPackaged && resourcesPath
    ? path.join(resourcesPath, 'api', 'local', 'marian_worker.py')
    : path.resolve(__dirname, 'marian_worker.py');
  return {
    modelDir,
    venvDir,
    pythonPath,
    timeoutMs,
    workerPath,
    hfEndpoint,
    hfDisableSslVerify
  };
}

function ensureConfig() {
  const next = getRuntimeConfig();
  const changed =
    !currentConfig ||
    currentConfig.modelDir !== next.modelDir ||
    currentConfig.venvDir !== next.venvDir ||
    currentConfig.pythonPath !== next.pythonPath ||
    currentConfig.workerPath !== next.workerPath ||
    currentConfig.hfEndpoint !== next.hfEndpoint ||
    currentConfig.hfDisableSslVerify !== next.hfDisableSslVerify;
  currentConfig = next;
  if (changed) {
    initPromise = null;
    resetWorker('config_changed');
  }
  return currentConfig;
}

async function ensureMarianDeps(config) {
  const depsStamp = path.join(config.venvDir, '.marian_deps_installed');
  const checkArgs = [
    '-c',
    [
      'import transformers, sentencepiece, torch, huggingface_hub, urllib3',
      'v = urllib3.__version__.split(".")',
      'major = int(v[0]) if v and v[0].isdigit() else 0',
      'raise SystemExit(0 if major < 2 else 1)'
    ].join('; ')
  ];
  if (existsSync(depsStamp)) {
    try {
      await execFileAsync(config.pythonPath, checkArgs);
      return;
    } catch {
      // fall through to reinstall
    }
  }
  await execFileAsync(config.pythonPath, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH]);
  try {
    writeFileSync(depsStamp, new Date().toISOString(), 'utf8');
  } catch {
    // ignore stamp failure
  }
}

async function ensureVenv() {
  const config = ensureConfig();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!existsSync(config.modelDir)) {
      mkdirSync(config.modelDir, { recursive: true });
    }
    if (!existsSync(config.pythonPath)) {
      await execFileAsync('python3', ['-m', 'venv', config.venvDir]);
    }
    await ensureMarianDeps(config);
  })();
  return initPromise;
}

function resetWorker(reason) {
  if (worker) {
    try {
      worker.kill();
    } catch {
      // ignore
    }
  }
  worker = null;
  if (rl) {
    rl.removeAllListeners();
    rl.close();
    rl = null;
  }
  while (pending.length) {
    const { reject } = pending.shift();
    reject(new Error(reason || 'worker_reset'));
  }
}

function ensureWorker() {
  const config = ensureConfig();
  if (worker) return;
  const env = { ...process.env, LOCAL_MARIAN_MODEL_DIR: config.modelDir };
  if (config.hfEndpoint) {
    env.HF_ENDPOINT = config.hfEndpoint;
  } else {
    delete env.HF_ENDPOINT;
  }
  if (config.hfDisableSslVerify) {
    env.HF_HUB_DISABLE_SSL_VERIFICATION = '1';
  } else {
    delete env.HF_HUB_DISABLE_SSL_VERIFICATION;
  }
  worker = spawn(config.pythonPath, [config.workerPath], {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  rl = readline.createInterface({ input: worker.stdout });
  rl.on('line', (line) => {
    const pendingItem = pending.shift();
    if (!pendingItem) {
      return;
    }
    try {
      const payload = JSON.parse(line);
      if (payload && payload.error) {
        pendingItem.reject(new Error(String(payload.error)));
        return;
      }
      pendingItem.resolve(payload);
    } catch (error) {
      pendingItem.reject(error);
    }
  });

  worker.on('exit', () => {
    resetWorker('worker_exit');
  });

  worker.stderr.on('data', (chunk) => {
    const message = chunk.toString('utf8').trim();
    if (message) {
      console.error(`[local-marian] ${message}`);
    }
  });
}

function sendPayload(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const config = currentConfig || ensureConfig();
    const timeoutMs = Number(options.timeoutMs || config.timeoutMs || 20000);
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
      resetWorker('timeout');
    }, timeoutMs);

    pending.push({
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });

    try {
      worker.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      pending.pop();
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function downloadModel({ modelId, localDir, device, dtype }) {
  await ensureVenv();
  ensureWorker();

  const config = currentConfig || ensureConfig();
  const envTimeout = Number(process.env.MARIAN_DOWNLOAD_TIMEOUT_MS || '');
  const downloadTimeoutMs =
    Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : Math.max(config.timeoutMs * 30, 5 * 60 * 1000);

  const run = async () => {
    const response = await sendPayload({
      action: 'download',
      model_id: modelId,
      local_dir: localDir,
      device,
      dtype
    }, { timeoutMs: downloadTimeoutMs });

    if (!response || !response.ok) {
      throw new Error('download_failed');
    }
    return response;
  };

  chain = chain.catch(() => {}).then(run);
  return chain;
}

async function translateItems(items, options = {}) {
  await ensureVenv();
  ensureWorker();

  const config = currentConfig || ensureConfig();
  const envTranslate = Number(process.env.MARIAN_TRANSLATE_TIMEOUT_MS || '');
  let translateTimeoutMs =
    Number.isFinite(envTranslate) && envTranslate > 0
      ? envTranslate
      : Number(options.timeoutMs || config.timeoutMs || 20000);
  if (!Number.isFinite(translateTimeoutMs) || translateTimeoutMs <= 0) {
    translateTimeoutMs = 20000;
  }
  if (!(Number.isFinite(envTranslate) && envTranslate > 0)) {
    const totalChars = Array.isArray(items)
      ? items.reduce((sum, item) => sum + String(item?.text || '').length, 0)
      : 0;
    const itemCount = Array.isArray(items) ? items.length : 0;
    const charFactor = Math.ceil(Math.max(totalChars, 1) / 600);
    const itemFactor = Math.ceil(Math.max(itemCount, 1) / 20);
    const factor = Math.min(8, Math.max(1, charFactor, itemFactor));
    translateTimeoutMs = Math.max(translateTimeoutMs, translateTimeoutMs * factor);
  }
  translateTimeoutMs = Math.min(translateTimeoutMs, 5 * 60 * 1000);

  const run = async () => {
    const response = await sendPayload({
      action: 'translate',
      items,
      model_id: options.modelId,
      local_dir: options.localDir,
      device: options.device,
      dtype: options.dtype,
      max_tokens: options.maxTokens,
      source_lang: options.sourceLang,
      target_lang: options.targetLang
    }, { timeoutMs: translateTimeoutMs });

    if (!response || !Array.isArray(response.items)) {
      throw new Error('invalid_local_response');
    }

    return response.items;
  };

  chain = chain.catch(() => {}).then(run);
  return chain;
}

function resetRuntime(reason = 'manual_reset') {
  resetWorker(reason);
}

module.exports = {
  downloadModel,
  translateItems,
  resetRuntime
};
