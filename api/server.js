require('../load-env');

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.TRANSLATION_API_PORT || 8787);
const HOST = process.env.TRANSLATION_API_HOST || '127.0.0.1';
const LOCAL_MODEL_NAME = process.env.LOCAL_TRANSLATE_MODEL_NAME || 'argos-local';

const { getConfig, updateConfig, loadConfig, getAdminToken, writeJsonAtomic } = require('./config');
const { normalizeLang, detectLanguageFromItems, extractMarianPair } = require('./lang-utils');
const localArgos = require('./local/argos_client');
const marianClient = require('./local/marian_client');
const argosManager = require('./local/argos_manager');
const marianManager = require('./local/marian_manager');

const ADMIN_UI_DIR = path.resolve(__dirname, 'admin');
const ADMIN_ASSETS_DIR = path.join(ADMIN_UI_DIR, 'assets');
const MODEL_CACHE_PATH = path.resolve(__dirname, 'model-cache.json');

const SERVER_ERROR = {
  bad_request: 400,
  missing_model: 409,
  auth_required: 401,
  rate_limited: 429,
  provider_down: 503,
  timeout: 504,
  internal_error: 500
};

const MARIAN_RECOMMENDED = [
  { model_id: 'Helsinki-NLP/opus-mt-en-zh', from: 'en', to: 'zh' },
  { model_id: 'Helsinki-NLP/opus-mt-zh-en', from: 'zh', to: 'en' },
  { model_id: 'Helsinki-NLP/opus-mt-en-ja', from: 'en', to: 'ja' },
  { model_id: 'Helsinki-NLP/opus-mt-ja-en', from: 'ja', to: 'en' },
  { model_id: 'Helsinki-NLP/opus-mt-en-ko', from: 'en', to: 'ko' },
  { model_id: 'Helsinki-NLP/opus-mt-ko-en', from: 'ko', to: 'en' },
  { model_id: 'Helsinki-NLP/opus-mt-en-fr', from: 'en', to: 'fr' },
  { model_id: 'Helsinki-NLP/opus-mt-fr-en', from: 'fr', to: 'en' }
];

function parseBoolean(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function loadModelCache() {
  try {
    const raw = fs.readFileSync(MODEL_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function updateModelCache(cache, engine, available) {
  const next = { ...(cache || {}) };
  next[engine] = {
    available: Array.isArray(available) ? available : [],
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(MODEL_CACHE_PATH, next);
  return next[engine];
}

function getCachedAvailable(cache, engine) {
  const entry = cache?.[engine];
  if (!entry || !Array.isArray(entry.available)) return null;
  return entry;
}

function normalizeEngine(engine, fallback = 'argos') {
  const normalized = String(engine || '').toLowerCase();
  if (normalized === 'local' || normalized === 'argos') return 'argos';
  if (normalized === 'marian') return 'marian';
  return fallback;
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length
    });
    res.end(data);
  } catch {
    jsonResponse(res, 404, { error_code: 'not_found' });
  }
}

function extractAdminToken(req, url) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  if (req.headers['x-admin-token']) {
    return String(req.headers['x-admin-token']).trim();
  }
  if (url?.searchParams?.get('token')) {
    return url.searchParams.get('token').trim();
  }
  return '';
}

function ensureAdmin(req, res, url) {
  const token = getAdminToken();
  if (!token) {
    return true;
  }
  const provided = extractAdminToken(req, url);
  if (provided && provided === token) {
    return true;
  }
  jsonResponse(res, SERVER_ERROR.auth_required, { error_code: 'auth_required', message: 'ADMIN_TOKEN required' });
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function validateTranslateRequest(body) {
  if (!body || typeof body !== 'object') {
    return 'invalid body';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'items must be a non-empty array';
  }
  for (const item of body.items) {
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') {
      return 'each item must include string id and text';
    }
  }
  return null;
}

function extractMissingModel(error) {
  const message = String(error?.message || error || '');
  const marianMarker = 'missing_model:';
  const marianIdx = message.indexOf(marianMarker);
  if (marianIdx >= 0) {
    const modelId = message.slice(marianIdx + marianMarker.length).trim();
    return modelId ? { model_id: modelId } : { model_id: null };
  }
  const marker = 'no_translation_pair:';
  const idx = message.indexOf(marker);
  if (idx < 0) {
    return null;
  }
  const pair = message.slice(idx + marker.length).trim();
  const [from, to] = pair.split('->').map((item) => item.trim());
  if (!from || !to) {
    return null;
  }
  return { from, to };
}

function mapProviderErrorStatus(error) {
  const message = String(error.message || '');
  if (message.includes('missing_model:')) return SERVER_ERROR.missing_model;
  if (message.includes('no_translation_pair:')) return SERVER_ERROR.missing_model;
  if (message.includes('auth')) return SERVER_ERROR.auth_required;
  if (message.includes('429') || message.includes('rate')) return SERVER_ERROR.rate_limited;
  if (message.includes('timeout')) return SERVER_ERROR.timeout;
  return SERVER_ERROR.provider_down;
}

function normalizeRequestedSourceLang(value) {
  return normalizeLang(value, 'auto', { allowAuto: true });
}

function normalizeTargetLang(value, fallback = 'zh') {
  return normalizeLang(value, fallback);
}

function resolveSourceLang(items, requestedSourceLang) {
  const sourceLang = normalizeRequestedSourceLang(requestedSourceLang);
  if (sourceLang !== 'auto') {
    return {
      sourceLang,
      detectedSourceLang: sourceLang
    };
  }

  const detected = detectLanguageFromItems(items) || 'en';
  return {
    sourceLang: detected,
    detectedSourceLang: detected
  };
}

function shouldPassthroughText(text, sourceLang, targetLang) {
  if (!text) {
    return true;
  }
  const normalizedSource = normalizeLang(sourceLang, '');
  const normalizedTarget = normalizeLang(targetLang, '');
  return Boolean(normalizedSource && normalizedTarget && normalizedSource === normalizedTarget);
}

function encodeMarianModelId(modelId) {
  return String(modelId || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function resolveMarianModelDir(config, modelId) {
  const root = config?.local?.marianModelDir || path.join(process.cwd(), 'models', 'marian');
  return path.resolve(root, encodeMarianModelId(modelId));
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function mergeById(items, translatedItems) {
  const byId = new Map(translatedItems.map((item) => [item.id, item]));
  return items.map((item) => {
    const translated = byId.get(item.id);
    if (!translated || typeof translated.translated_text !== 'string') {
      return {
        id: item.id,
        translated_text: `${item.text} [翻译失败，可重试]`,
        confidence: 0
      };
    }
    return translated;
  });
}

function buildMarianCandidates(config) {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = ({ modelId, from, to, installed = false, localDir = null, priority = 10 }) => {
    if (!modelId || !from || !to) {
      return;
    }
    const key = `${modelId}:${from}:${to}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({
      modelId,
      from,
      to,
      installed,
      localDir,
      priority
    });
  };

  const configuredModelId = config?.marian?.modelId || process.env.MARIAN_MODEL_ID || '';
  const configuredPair = extractMarianPair(configuredModelId);
  const configuredLocalDir = configuredModelId ? resolveMarianModelDir(config, configuredModelId) : null;
  pushCandidate({
    modelId: configuredModelId,
    from: configuredPair?.from,
    to: configuredPair?.to,
    installed: Boolean(configuredLocalDir && fs.existsSync(configuredLocalDir)),
    localDir: configuredLocalDir,
    priority: 2
  });

  for (const entry of marianManager.listInstalled(config)) {
    const pair = entry?.from && entry?.to ? { from: entry.from, to: entry.to } : extractMarianPair(entry?.model_id);
    pushCandidate({
      modelId: entry?.model_id,
      from: pair?.from,
      to: pair?.to,
      installed: true,
      localDir: entry?.local_dir || resolveMarianModelDir(config, entry?.model_id),
      priority: 0
    });
  }

  for (const entry of MARIAN_RECOMMENDED) {
    pushCandidate({
      modelId: entry.model_id,
      from: entry.from,
      to: entry.to,
      installed: false,
      localDir: resolveMarianModelDir(config, entry.model_id),
      priority: 5
    });
  }

  return candidates.sort((left, right) => left.priority - right.priority);
}

function resolveMarianModelSelection(config, sourceLang, targetLang) {
  const normalizedSource = normalizeLang(sourceLang, '');
  const normalizedTarget = normalizeLang(targetLang, '');
  if (!normalizedSource || !normalizedTarget) {
    throw new Error(`no_translation_pair:${normalizedSource || 'unknown'}->${normalizedTarget || 'unknown'}`);
  }

  const candidates = buildMarianCandidates(config).filter(
    (candidate) => candidate.from === normalizedSource && candidate.to === normalizedTarget
  );
  if (!candidates.length) {
    throw new Error(`no_translation_pair:${normalizedSource}->${normalizedTarget}`);
  }

  const selected = candidates.find((candidate) => candidate.installed) || candidates[0];
  return {
    modelId: selected.modelId,
    localDir: selected.localDir || resolveMarianModelDir(config, selected.modelId)
  };
}

async function callLocalTranslate(input) {
  const startedAt = Date.now();
  const items = Array.isArray(input.items) ? input.items : [];
  const sourceLang = normalizeLang(input.source_lang, 'en');
  const targetLang = normalizeTargetLang(input.target_lang, 'zh');
  const directItems = [];
  const toTranslate = [];

  for (const item of items) {
    const text = String(item.text || '');
    if (shouldPassthroughText(text, sourceLang, targetLang)) {
      directItems.push({
        id: item.id,
        translated_text: text,
        confidence: text ? 0.99 : 1
      });
    } else {
      toTranslate.push({ id: item.id, text });
    }
  }

  let translatedItems = [];

  if (toTranslate.length > 0) {
    const results = await localArgos.translateItems(toTranslate, sourceLang, targetLang);
    translatedItems = results.map((item) => ({
      id: String(item.id || ''),
      translated_text: String(item.translated_text || ''),
      confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0.8
    }));
  }

  return {
    translatedItems: [...translatedItems, ...directItems],
    latencyMs: Date.now() - startedAt,
    model: LOCAL_MODEL_NAME
  };
}

async function callMarianTranslate(input, config) {
  const startedAt = Date.now();
  const items = Array.isArray(input.items) ? input.items : [];
  const sourceLang = normalizeLang(input.source_lang, '');
  const targetLang = normalizeTargetLang(input.target_lang, 'zh');
  if (items.length === 0) {
    return { translatedItems: [], latencyMs: Date.now() - startedAt, model: 'marian' };
  }

  const directItems = [];
  const toTranslate = [];
  for (const item of items) {
    const text = String(item.text || '');
    if (shouldPassthroughText(text, sourceLang, targetLang)) {
      directItems.push({ id: item.id, translated_text: text, confidence: text ? 0.99 : 1 });
      continue;
    }
    toTranslate.push({ id: item.id, text });
  }

  if (toTranslate.length === 0) {
    return {
      translatedItems: directItems,
      latencyMs: Date.now() - startedAt,
      model: 'marian'
    };
  }

  const selection = resolveMarianModelSelection(config, sourceLang, targetLang);
  const modelId = selection.modelId;
  const localDir = selection.localDir;
  const translatedItems = await marianClient.translateItems(toTranslate, {
    modelId,
    localDir,
    device: config?.marian?.device,
    dtype: config?.marian?.dtype,
    maxTokens: config?.marian?.maxTokens,
    sourceLang: input.source_lang,
    targetLang: input.target_lang
  });
  const normalized = translatedItems.map((item) => ({
    id: String(item.id || ''),
    translated_text: String(item.translated_text || ''),
    confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0.8
  }));
  return {
    translatedItems: [...normalized, ...directItems],
    latencyMs: Date.now() - startedAt,
    model: `marian:${modelId}`
  };
}

function createServer() {
  loadConfig();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return jsonResponse(res, 200, { ok: true, service: 'translation-api' });
    }

    if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
      if (!ensureAdmin(req, res, url)) return;
      const filePath = path.join(ADMIN_UI_DIR, 'index.html');
      return sendFile(res, filePath, 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && pathname.startsWith('/admin/assets/')) {
      const rel = pathname.replace('/admin/assets/', '');
      const filePath = path.resolve(ADMIN_ASSETS_DIR, rel);
      if (!(filePath === ADMIN_ASSETS_DIR || filePath.startsWith(`${ADMIN_ASSETS_DIR}${path.sep}`))) {
        return jsonResponse(res, 404, { error_code: 'not_found' });
      }
      return sendFile(res, filePath, contentTypeForPath(filePath));
    }

    if (req.method === 'GET' && pathname === '/v1/config') {
      if (!ensureAdmin(req, res, url)) return;
      return jsonResponse(res, 200, { ok: true, config: getConfig() });
    }

    if (req.method === 'PUT' && pathname === '/v1/config') {
      if (!ensureAdmin(req, res, url)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, SERVER_ERROR.bad_request, { error_code: 'bad_request', message: 'invalid JSON' });
      }
      try {
        const updated = updateConfig(body || {});
        return jsonResponse(res, 200, { ok: true, config: updated });
      } catch (error) {
        return jsonResponse(res, SERVER_ERROR.internal_error, {
          error_code: 'config_update_failed',
          message: String(error?.message || error)
        });
      }
    }

    if (req.method === 'GET' && pathname === '/v1/models/installed') {
      if (!ensureAdmin(req, res, url)) return;
      const engine = normalizeEngine(url.searchParams.get('engine'), 'argos');
      const config = getConfig();
      try {
        const installed =
          engine === 'marian' ? marianManager.listInstalled(config) : argosManager.listInstalled(config);
        return jsonResponse(res, 200, { ok: true, engine, installed });
      } catch (error) {
        return jsonResponse(res, SERVER_ERROR.internal_error, {
          ok: false,
          error_code: error?.code || 'model_list_failed',
          message: String(error?.message || error),
          engine,
          installed: []
        });
      }
    }

    if (req.method === 'GET' && pathname === '/v1/models/available') {
      if (!ensureAdmin(req, res, url)) return;
      const engine = normalizeEngine(url.searchParams.get('engine'), 'argos');
      const config = getConfig();
      const refresh = parseBoolean(url.searchParams.get('refresh'));
      const cache = loadModelCache();
      const cached = getCachedAvailable(cache, engine);
      if (!refresh && cached) {
        return jsonResponse(res, 200, {
          ok: true,
          engine,
          available: cached.available || [],
          cached: true,
          updatedAt: cached.updatedAt || null
        });
      }
      if (engine === 'marian') {
        const updated = updateModelCache(cache, engine, MARIAN_RECOMMENDED);
        return jsonResponse(res, 200, {
          ok: true,
          engine,
          available: MARIAN_RECOMMENDED,
          cached: false,
          updatedAt: updated.updatedAt || null
        });
      }
      if (!refresh && !cached) {
        return jsonResponse(res, 200, {
          ok: true,
          engine,
          available: [],
          cached: false,
          cache_miss: true,
          updatedAt: null
        });
      }
      try {
        const available = await argosManager.listAvailable(config);
        const updated = updateModelCache(cache, engine, available);
        return jsonResponse(res, 200, {
          ok: true,
          engine,
          available,
          cached: false,
          updatedAt: updated.updatedAt || null
        });
      } catch (error) {
        return jsonResponse(res, SERVER_ERROR.internal_error, {
          ok: false,
          error_code: error?.code || 'model_list_failed',
          message: String(error?.message || error),
          engine,
          available: []
        });
      }
    }

    if (req.method === 'POST' && pathname === '/v1/models/download') {
      if (!ensureAdmin(req, res, url)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, SERVER_ERROR.bad_request, { error_code: 'bad_request', message: 'invalid JSON' });
      }
      const engine = normalizeEngine(body?.engine, 'argos');
      const config = getConfig();
      try {
        if (engine === 'marian') {
          const modelId = String(body?.modelId || body?.model_id || '').trim();
          if (!modelId) {
            return jsonResponse(res, SERVER_ERROR.bad_request, {
              error_code: 'bad_request',
              message: 'modelId is required'
            });
          }
          const result = await marianManager.downloadModel(config, modelId);
          marianClient.resetRuntime('model_downloaded');
          return jsonResponse(res, 200, { ok: true, engine, result });
        }
        const from = String(body?.from || '').trim();
        const to = String(body?.to || '').trim();
        if (!from || !to) {
          return jsonResponse(res, SERVER_ERROR.bad_request, { error_code: 'bad_request', message: 'from/to required' });
        }
        const result = await argosManager.downloadModel(config, from, to);
        localArgos.resetRuntime('model_downloaded');
        return jsonResponse(res, 200, { ok: true, engine, result });
      } catch (error) {
        return jsonResponse(res, SERVER_ERROR.internal_error, {
          ok: false,
          error_code: error?.code || 'model_download_failed',
          message: String(error?.message || error),
          engine
        });
      }
    }

    if (req.method === 'POST' && pathname === '/v1/models/remove') {
      if (!ensureAdmin(req, res, url)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, SERVER_ERROR.bad_request, { error_code: 'bad_request', message: 'invalid JSON' });
      }
      const engine = normalizeEngine(body?.engine, 'argos');
      const config = getConfig();
      try {
        if (engine === 'marian') {
          const modelId = String(body?.modelId || body?.model_id || '').trim();
          if (!modelId) {
            return jsonResponse(res, SERVER_ERROR.bad_request, {
              error_code: 'bad_request',
              message: 'modelId is required'
            });
          }
          const result = marianManager.removeModel(config, modelId);
          marianClient.resetRuntime('model_removed');
          return jsonResponse(res, 200, { ok: true, engine, result });
        }
        const filename = String(body?.filename || '').trim();
        const from = String(body?.from || '').trim();
        const to = String(body?.to || '').trim();
        const resolved = filename || (from && to ? `${from}-${to}.argosmodel` : '');
        if (!resolved) {
          return jsonResponse(res, SERVER_ERROR.bad_request, {
            error_code: 'bad_request',
            message: 'filename or from/to required'
          });
        }
        const result = argosManager.removeModel(config, resolved);
        localArgos.resetRuntime('model_removed');
        return jsonResponse(res, 200, { ok: true, engine, result });
      } catch (error) {
        return jsonResponse(res, SERVER_ERROR.internal_error, {
          ok: false,
          error_code: error?.code || 'model_remove_failed',
          message: String(error?.message || error),
          engine
        });
      }
    }

    if (req.method === 'POST' && pathname === '/v1/translate') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, SERVER_ERROR.bad_request, { error_code: 'bad_request', message: 'invalid JSON' });
      }

      const validation = validateTranslateRequest(body);
      if (validation) {
        return jsonResponse(res, SERVER_ERROR.bad_request, { error_code: 'bad_request', message: validation });
      }

      const requestId = body.request_id || crypto.randomUUID();
      const requestedSourceLang = body.source_lang || 'auto';
      const targetLang = normalizeTargetLang(body.target_lang, 'zh');
      const sourceResolution = resolveSourceLang(body.items, requestedSourceLang);
      const config = getConfig();
      const engine = normalizeEngine(config.engine, 'argos');

      try {
        const engineInput = {
          source_lang: sourceResolution.sourceLang,
          target_lang: targetLang,
          items: body.items
        };

        let result;
        if (engine === 'marian') {
          result = await callMarianTranslate(engineInput, config);
        } else {
          result = await callLocalTranslate(engineInput);
        }

        return jsonResponse(res, 200, {
          request_id: requestId,
          detected_source_lang: sourceResolution.detectedSourceLang,
          items: mergeById(body.items, result.translatedItems),
          model: result.model,
          latency_ms: result.latencyMs,
          error_code: null
        });
      } catch (error) {
        const missingModel = extractMissingModel(error);
        const status = missingModel ? SERVER_ERROR.missing_model : mapProviderErrorStatus(error);
        const errorModel =
          engine === 'marian'
            ? `marian:${missingModel?.model_id || config?.marian?.modelId || 'unknown'}`
            : LOCAL_MODEL_NAME;
        return jsonResponse(res, status, {
          request_id: requestId,
          detected_source_lang: sourceResolution.detectedSourceLang,
          items: body.items.map((item) => ({
            id: item.id,
            translated_text: `${item.text} [翻译失败，可重试]`,
            confidence: 0
          })),
          model: errorModel,
          latency_ms: null,
          error_code:
            status === SERVER_ERROR.missing_model
              ? 'missing_model'
              : status === SERVER_ERROR.timeout
                ? 'timeout'
                : status === SERVER_ERROR.auth_required
                  ? 'auth_required'
                  : status === SERVER_ERROR.rate_limited
                    ? 'rate_limited'
                    : 'provider_down',
          missing_model: missingModel
        });
      }
    }

    return jsonResponse(res, 404, { error_code: 'not_found' });
  });
}

function startTranslationApi(options = {}) {
  const port = Number(options.port || PORT);
  const host = options.host || HOST;
  const server = createServer();
  return new Promise((resolve) => {
    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        console.warn(`[translation-api] port already in use: ${host}:${port}`);
        resolve({ ok: false, alreadyRunning: true, error });
        return;
      }
      console.error('[translation-api] failed to start', error);
      resolve({ ok: false, error });
    });
    server.listen(port, host, () => {
      console.log(`[translation-api] listening on http://${host}:${port}`);
      resolve({ ok: true, server, host, port });
    });
  });
}

module.exports = {
  startTranslationApi,
  __internal: {
    resolveSourceLang,
    shouldPassthroughText,
    resolveMarianModelSelection,
    buildMarianCandidates,
    mergeById
  }
};

if (require.main === module) {
  startTranslationApi().then((result) => {
    if (!result?.ok && !result?.alreadyRunning) {
      process.exitCode = 1;
    }
  });
}
