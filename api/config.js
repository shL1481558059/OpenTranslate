const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const EXTERNAL_ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

const DEFAULT_MARIAN_MODEL = 'Helsinki-NLP/opus-mt-en-zh';

function normalizeEngine(value, fallback = 'argos') {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'local' || normalized === 'argos') return 'argos';
  if (normalized === 'marian') return 'marian';
  return fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function buildDefaults() {
  return {
    engine: normalizeEngine(process.env.TRANSLATION_ENGINE, 'argos'),
    local: {
      argosModelDir: process.env.LOCAL_TRANSLATE_MODEL_DIR || path.join(process.cwd(), 'models', 'argos'),
      marianModelDir: process.env.LOCAL_MARIAN_MODEL_DIR || path.join(process.cwd(), 'models', 'marian'),
      pythonPath: process.env.LOCAL_TRANSLATE_PYTHON || path.join(process.cwd(), '.venv', 'bin', 'python'),
      venvDir: process.env.LOCAL_TRANSLATE_VENV || path.join(process.cwd(), '.venv'),
      timeoutMs: Number(process.env.LOCAL_TRANSLATE_TIMEOUT_MS || 20000)
    },
    marian: {
      modelId: process.env.MARIAN_MODEL_ID || DEFAULT_MARIAN_MODEL,
      device: process.env.MARIAN_DEVICE || 'cpu',
      dtype: process.env.MARIAN_DTYPE || 'float32',
      maxTokens: Number(process.env.MARIAN_MAX_TOKENS || 512),
      hfEndpoint: process.env.MARIAN_HF_ENDPOINT || process.env.HF_ENDPOINT || '',
      hfDisableSslVerify: parseBoolean(
        process.env.MARIAN_HF_DISABLE_SSL_VERIFY || process.env.HF_HUB_DISABLE_SSL_VERIFICATION,
        false
      )
    },
    admin: {
      token: process.env.ADMIN_TOKEN || ''
    }
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    result[key] = deepMerge(base[key], value);
  }
  return result;
}

function sanitizeConfig(input, fallback) {
  const base = fallback || buildDefaults();
  const next = deepMerge(base, {});
  if (!input || typeof input !== 'object') {
    return next;
  }
  if (input.engine !== undefined) {
    next.engine = normalizeEngine(input.engine, base.engine);
  }
  if (isPlainObject(input.local)) {
    if (typeof input.local.argosModelDir === 'string') {
      next.local.argosModelDir = input.local.argosModelDir.trim() || base.local.argosModelDir;
    }
    if (typeof input.local.marianModelDir === 'string') {
      next.local.marianModelDir = input.local.marianModelDir.trim() || base.local.marianModelDir;
    }
    if (typeof input.local.pythonPath === 'string') {
      next.local.pythonPath = input.local.pythonPath.trim() || base.local.pythonPath;
    }
    if (typeof input.local.venvDir === 'string') {
      next.local.venvDir = input.local.venvDir.trim() || base.local.venvDir;
    }
    if (input.local.timeoutMs !== undefined) {
      const num = Number(input.local.timeoutMs);
      if (Number.isFinite(num) && num > 0) {
        next.local.timeoutMs = Math.floor(num);
      }
    }
  }
  if (isPlainObject(input.marian)) {
    if (typeof input.marian.modelId === 'string') {
      next.marian.modelId = input.marian.modelId.trim() || base.marian.modelId;
    }
    if (typeof input.marian.hfEndpoint === 'string') {
      next.marian.hfEndpoint = input.marian.hfEndpoint.trim();
    }
    if (input.marian.hfDisableSslVerify !== undefined) {
      next.marian.hfDisableSslVerify = parseBoolean(input.marian.hfDisableSslVerify, base.marian.hfDisableSslVerify);
    }
    if (typeof input.marian.device === 'string') {
      next.marian.device = input.marian.device.trim() || base.marian.device;
    }
    if (typeof input.marian.dtype === 'string') {
      next.marian.dtype = input.marian.dtype.trim() || base.marian.dtype;
    }
    if (input.marian.maxTokens !== undefined) {
      const num = Number(input.marian.maxTokens);
      if (Number.isFinite(num) && num > 0) {
        next.marian.maxTokens = Math.floor(num);
      }
    }
  }
  if (isPlainObject(input.admin)) {
    if (typeof input.admin.token === 'string') {
      next.admin.token = input.admin.token.trim();
    }
  }
  return next;
}

function applyEnvOverrides(config) {
  if (!config) return config;
  const next = deepMerge(config, {});
  // Only honor startup-provided ADMIN_TOKEN so runtime updates are not locked by old values.
  if (EXTERNAL_ADMIN_TOKEN) {
    next.admin.token = EXTERNAL_ADMIN_TOKEN;
  }
  return next;
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadConfigFromFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let currentConfig = null;

function loadConfig() {
  const defaults = buildDefaults();
  const stored = loadConfigFromFile() || {};
  const merged = sanitizeConfig(stored, defaults);
  currentConfig = applyEnvOverrides(merged);
  applyRuntimeEnv(currentConfig);
  return currentConfig;
}

function getConfig() {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

function updateConfig(patch) {
  const base = getConfig();
  const next = sanitizeConfig(patch, base);
  currentConfig = applyEnvOverrides(next);
  writeJsonAtomic(CONFIG_PATH, currentConfig);
  applyRuntimeEnv(currentConfig);
  return currentConfig;
}

function applyRuntimeEnv(config) {
  if (!config) return;
  process.env.LOCAL_TRANSLATE_MODEL_DIR = config.local.argosModelDir;
  process.env.LOCAL_MARIAN_MODEL_DIR = config.local.marianModelDir;
  process.env.LOCAL_TRANSLATE_PYTHON = config.local.pythonPath;
  process.env.LOCAL_TRANSLATE_VENV = config.local.venvDir;
  process.env.LOCAL_TRANSLATE_TIMEOUT_MS = String(config.local.timeoutMs);
  process.env.MARIAN_MODEL_ID = config.marian.modelId;
  process.env.MARIAN_DEVICE = config.marian.device;
  process.env.MARIAN_DTYPE = config.marian.dtype;
  process.env.MARIAN_MAX_TOKENS = String(config.marian.maxTokens);
  if (config.marian.hfEndpoint) {
    process.env.HF_ENDPOINT = config.marian.hfEndpoint;
    process.env.MARIAN_HF_ENDPOINT = config.marian.hfEndpoint;
  } else {
    delete process.env.HF_ENDPOINT;
    delete process.env.MARIAN_HF_ENDPOINT;
  }
  if (config.marian.hfDisableSslVerify) {
    process.env.HF_HUB_DISABLE_SSL_VERIFICATION = '1';
    process.env.MARIAN_HF_DISABLE_SSL_VERIFY = '1';
  } else {
    delete process.env.HF_HUB_DISABLE_SSL_VERIFICATION;
    delete process.env.MARIAN_HF_DISABLE_SSL_VERIFY;
  }
  if (config.admin?.token) {
    process.env.ADMIN_TOKEN = config.admin.token;
  } else {
    delete process.env.ADMIN_TOKEN;
  }
}

function getAdminToken() {
  const config = getConfig();
  return EXTERNAL_ADMIN_TOKEN || config?.admin?.token || '';
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_MARIAN_MODEL,
  getConfig,
  updateConfig,
  loadConfig,
  applyRuntimeEnv,
  getAdminToken,
  writeJsonAtomic,
  __private: {
    applyEnvOverrides
  }
};
