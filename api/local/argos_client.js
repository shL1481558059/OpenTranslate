const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
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
  const modelDir = path.resolve(process.env.LOCAL_TRANSLATE_MODEL_DIR || path.join(process.cwd(), 'models', 'argos'));
  const xdgRoot = path.join(modelDir, '.xdg');
  const xdgData = path.join(xdgRoot, 'data');
  const xdgCache = path.join(xdgRoot, 'cache');
  const xdgConfig = path.join(xdgRoot, 'config');
  const venvDir = path.resolve(process.env.LOCAL_TRANSLATE_VENV || path.join(process.cwd(), '.venv'));
  const pythonPath = path.resolve(process.env.LOCAL_TRANSLATE_PYTHON || path.join(venvDir, 'bin', 'python'));
  const timeoutMs = Number(process.env.LOCAL_TRANSLATE_TIMEOUT_MS || 20000);
  const isPackaged = process.env.SNAP_TRANSLATE_IS_PACKAGED === '1';
  const resourcesPath = process.env.SNAP_TRANSLATE_RESOURCES_PATH || process.resourcesPath || '';
  const workerPath = isPackaged && resourcesPath
    ? path.join(resourcesPath, 'api', 'local', 'argos_worker.py')
    : path.resolve(__dirname, 'argos_worker.py');
  return {
    modelDir,
    xdgRoot,
    xdgData,
    xdgCache,
    xdgConfig,
    venvDir,
    pythonPath,
    timeoutMs,
    workerPath
  };
}

function ensureConfig() {
  const next = getRuntimeConfig();
  const changed =
    !currentConfig ||
    currentConfig.modelDir !== next.modelDir ||
    currentConfig.venvDir !== next.venvDir ||
    currentConfig.pythonPath !== next.pythonPath ||
    currentConfig.workerPath !== next.workerPath;
  if (changed) {
    currentConfig = next;
    initPromise = null;
    resetWorker('config_changed');
  } else {
    currentConfig = next;
  }
  return currentConfig;
}

async function ensureVenv() {
  const config = ensureConfig();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!existsSync(config.modelDir)) {
      mkdirSync(config.modelDir, { recursive: true });
    }
    mkdirSync(config.xdgData, { recursive: true });
    mkdirSync(config.xdgCache, { recursive: true });
    mkdirSync(config.xdgConfig, { recursive: true });
    if (!existsSync(config.pythonPath)) {
      await execFileAsync('python3', ['-m', 'venv', config.venvDir]);
      await execFileAsync(config.pythonPath, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH]);
    }
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
  worker = spawn(config.pythonPath, [config.workerPath], {
    env: {
      ...process.env,
      LOCAL_TRANSLATE_MODEL_DIR: config.modelDir,
      XDG_DATA_HOME: config.xdgData,
      XDG_CACHE_HOME: config.xdgCache,
      XDG_CONFIG_HOME: config.xdgConfig
    },
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
      console.error(`[local-argos] ${message}`);
    }
  });
}

function sendPayload(payload) {
  return new Promise((resolve, reject) => {
    const config = currentConfig || ensureConfig();
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
      resetWorker('timeout');
    }, config.timeoutMs);

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

async function translateItems(items, sourceLang, targetLang) {
  await ensureVenv();
  ensureWorker();

  const run = async () => {
    const response = await sendPayload({
      items,
      source_lang: sourceLang,
      target_lang: targetLang
    });

    if (!response || !Array.isArray(response.items)) {
      throw new Error('invalid_local_response');
    }

    return response.items;
  };

  chain = chain.catch(() => {}).then(run);
  return chain;
}

module.exports = {
  translateItems
};
