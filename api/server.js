require('../load-env');

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.TRANSLATION_API_PORT || 8787);
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_API_MODE = (process.env.LLM_API_MODE || 'chat').toLowerCase();
const LLM_RESPONSES_FORMAT = process.env.LLM_RESPONSES_FORMAT === '1';
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 1800);
const MAX_RETRIES = 1;
const TRANSLATION_ENGINE = (process.env.TRANSLATION_ENGINE || 'llm').toLowerCase();
const LOCAL_MODEL_NAME = process.env.LOCAL_TRANSLATE_MODEL_NAME || 'argos-local';

const localArgos = require('./local/argos_client');

const SERVER_ERROR = {
  bad_request: 400,
  auth_required: 401,
  rate_limited: 429,
  provider_down: 503,
  timeout: 504,
  internal_error: 500
};

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
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

function stripCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

function parseModelPayload(content) {
  const normalized = stripCodeFence(content);
  const parsed = JSON.parse(normalized);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('invalid_model_payload');
  }
  return parsed.items.map((item) => ({
    id: String(item.id || ''),
    translated_text: String(item.translated_text || ''),
    confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0.8
  }));
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

function toPrompt(input) {
  return [
    'Translate each input text segment into Simplified Chinese.',
    'Return JSON only in this schema:',
    '{"items":[{"id":"string","translated_text":"string","confidence":0.0}]}',
    'Rules:',
    '- Keep item order and ids unchanged.',
    '- translated_text must be translation only, no notes.',
    '- confidence is 0..1 numeric estimate.',
    '- If source is already Chinese, keep semantic meaning and polish lightly.',
    '',
    `source_lang=${input.source_lang || 'auto'}`,
    `target_lang=${input.target_lang || 'zh-CN'}`,
    `items=${JSON.stringify(input.items)}`
  ].join('\n');
}

function mapProviderErrorStatus(error) {
  const message = String(error.message || '');
  if (message.includes('auth')) return SERVER_ERROR.auth_required;
  if (message.includes('429') || message.includes('rate')) return SERVER_ERROR.rate_limited;
  if (message.includes('timeout')) return SERVER_ERROR.timeout;
  return SERVER_ERROR.provider_down;
}

function containsCjk(text) {
  return /[\u3400-\u9FFF]/.test(text || '');
}

function normalizeArgosLang(lang, fallback) {
  if (!lang || lang === 'auto') {
    return fallback;
  }
  const normalized = String(lang).toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh';
  }
  return normalized.split('-')[0] || fallback;
}

function extractResponseText(payload) {
  if (payload && typeof payload.output_text === 'string') {
    return payload.output_text;
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') {
        return part.text;
      }
    }
  }
  const legacy = payload?.choices?.[0]?.message?.content;
  if (typeof legacy === 'string') {
    return legacy;
  }
  return '';
}

async function callResponsesApi(input, startedAt, signal) {
  const makeBody = (withFormat) =>
    JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      response_format: withFormat ? { type: 'json_object' } : undefined,
      instructions: 'You are a translation engine. Output strict JSON only.',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: toPrompt(input)
            }
          ]
        }
      ]
    });

  let response = await fetch(`${LLM_API_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    signal,
    body: makeBody(LLM_RESPONSES_FORMAT)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`provider_${response.status}: ${text.slice(0, 120)}`);
  }

  const payload = await response.json();
  const content = extractResponseText(payload);
  if (!content) {
    throw new Error('invalid_provider_response');
  }

  const translatedItems = parseModelPayload(content);
  return {
    translatedItems,
    latencyMs: Date.now() - startedAt
  };
}

async function callChatCompletionsApi(input, startedAt, signal) {
  const response = await fetch(`${LLM_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    signal,
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a translation engine. Output strict JSON only.'
        },
        {
          role: 'user',
          content: toPrompt(input)
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`provider_${response.status}: ${text.slice(0, 120)}`);
  }

  const payload = await response.json();
  const content = extractResponseText(payload);
  if (!content) {
    throw new Error('invalid_provider_response');
  }

  const translatedItems = parseModelPayload(content);
  return {
    translatedItems,
    latencyMs: Date.now() - startedAt
  };
}

async function callSmallLlmTranslate(input) {
  if (!LLM_API_KEY) {
    throw new Error('auth_required: missing LLM_API_KEY');
  }

  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let result;
      if (LLM_API_MODE === 'responses') {
        result = await callResponsesApi(input, startedAt, controller.signal);
      } else if (LLM_API_MODE === 'chat') {
        result = await callChatCompletionsApi(input, startedAt, controller.signal);
      } else {
        result = await callChatCompletionsApi(input, startedAt, controller.signal);
      }
      clearTimeout(timeout);
      return result;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      const isAbort = error && error.name === 'AbortError';
      const message = String(error.message || '');
      if (LLM_API_MODE !== 'responses' && message.includes('Unsupported legacy protocol')) {
        try {
          const result = await callResponsesApi(input, startedAt, controller.signal);
          return result;
        } catch (innerError) {
          lastError = innerError;
        }
      }
      if (attempt === MAX_RETRIES) {
        throw new Error(isAbort ? 'timeout' : String(error.message || 'provider_down'));
      }
    }
  }

  throw lastError || new Error('provider_down');
}

function mergeById(items, translatedItems) {
  const byId = new Map(translatedItems.map((item) => [item.id, item]));
  return items.map((item) => {
    const translated = byId.get(item.id);
    if (!translated || !translated.translated_text) {
      return {
        id: item.id,
        translated_text: `${item.text} [翻译失败，可重试]`,
        confidence: 0
      };
    }
    return translated;
  });
}

async function callLocalTranslate(input) {
  const startedAt = Date.now();
  const items = Array.isArray(input.items) ? input.items : [];
  const directItems = [];
  const toTranslate = [];

  for (const item of items) {
    const text = String(item.text || '');
    if (containsCjk(text)) {
      directItems.push({
        id: item.id,
        translated_text: text,
        confidence: 0.99
      });
    } else {
      toTranslate.push({ id: item.id, text });
    }
  }

  const sourceLang = normalizeArgosLang(input.source_lang, 'en');
  const targetLang = normalizeArgosLang(input.target_lang, 'zh');
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { ok: true, service: 'translation-api' });
  }

  if (req.method === 'POST' && req.url === '/v1/translate') {
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
    const sourceLang = body.source_lang || 'auto';
    const targetLang = body.target_lang || 'zh-CN';

    try {
      const engineInput = {
        source_lang: sourceLang,
        target_lang: targetLang,
        items: body.items
      };

      const result =
        TRANSLATION_ENGINE === 'local' ? await callLocalTranslate(engineInput) : await callSmallLlmTranslate(engineInput);

      return jsonResponse(res, 200, {
        request_id: requestId,
        detected_source_lang: sourceLang,
        items: mergeById(body.items, result.translatedItems),
        model: TRANSLATION_ENGINE === 'local' ? result.model : LLM_MODEL,
        latency_ms: result.latencyMs,
        error_code: null
      });
    } catch (error) {
      const status = mapProviderErrorStatus(error);
      return jsonResponse(res, status, {
        request_id: requestId,
        detected_source_lang: sourceLang,
        items: body.items.map((item) => ({
          id: item.id,
          translated_text: `${item.text} [翻译失败，可重试]`,
          confidence: 0
        })),
        model: TRANSLATION_ENGINE === 'local' ? LOCAL_MODEL_NAME : LLM_MODEL,
        latency_ms: null,
        error_code:
          status === SERVER_ERROR.timeout
            ? 'timeout'
            : status === SERVER_ERROR.auth_required
              ? 'auth_required'
              : status === SERVER_ERROR.rate_limited
                ? 'rate_limited'
                : 'provider_down'
      });
    }
  }

  return jsonResponse(res, 404, { error_code: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[translation-api] listening on http://127.0.0.1:${PORT}`);
});
