const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { promisify } = require('node:util');
const readline = require('node:readline');

const execFileAsync = promisify(execFile);

const MODEL_DIR = path.resolve(process.env.LOCAL_TRANSLATE_MODEL_DIR || path.join(process.cwd(), 'models', 'argos'));
const VENV_DIR = path.resolve(process.env.LOCAL_TRANSLATE_VENV || path.join(process.cwd(), '.venv'));
const PYTHON_PATH = path.resolve(process.env.LOCAL_TRANSLATE_PYTHON || path.join(VENV_DIR, 'bin', 'python'));
const TIMEOUT_MS = Number(process.env.LOCAL_TRANSLATE_TIMEOUT_MS || 20000);
const REQUIREMENTS_PATH = path.resolve(__dirname, 'requirements.txt');
const IS_PACKAGED = process.env.SNAP_TRANSLATE_IS_PACKAGED === '1';
const RESOURCES_PATH = process.env.SNAP_TRANSLATE_RESOURCES_PATH || process.resourcesPath || '';
const WORKER_PATH = IS_PACKAGED && RESOURCES_PATH
  ? path.join(RESOURCES_PATH, 'api', 'local', 'argos_worker.py')
  : path.resolve(__dirname, 'argos_worker.py');

let initPromise = null;
let worker = null;
let rl = null;
let pending = [];
let chain = Promise.resolve();

async function ensureVenv() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!existsSync(MODEL_DIR)) {
      mkdirSync(MODEL_DIR, { recursive: true });
    }
    if (!existsSync(PYTHON_PATH)) {
      await execFileAsync('python3', ['-m', 'venv', VENV_DIR]);
      await execFileAsync(PYTHON_PATH, ['-m', 'pip', 'install', '-r', REQUIREMENTS_PATH]);
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
  if (worker) return;
  worker = spawn(PYTHON_PATH, [WORKER_PATH], {
    env: { ...process.env, LOCAL_TRANSLATE_MODEL_DIR: MODEL_DIR },
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
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
      resetWorker('timeout');
    }, TIMEOUT_MS);

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
