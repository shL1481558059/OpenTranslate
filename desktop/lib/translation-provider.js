const crypto = require('node:crypto');

const REQUEST_TIMEOUT_MS = Number(process.env.CLIENT_TRANSLATION_TIMEOUT_MS || 20000);
const MAX_RETRIES = 1;

const DEFAULTS = {
  engine: (process.env.DESKTOP_TRANSLATION_ENGINE || 'api').toLowerCase(),
  translationApiUrl: process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8787/v2/translate',
  llmApiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini'
};

const TARGET_ALIASES = {
  EN: 'EN-US',
  'ZH-CN': 'ZH',
  'ZH-SG': 'ZH',
  'ZH-TW': 'ZH-HANT',
  'ZH-HK': 'ZH-HANT',
  'ZH-MO': 'ZH-HANT',
  'EN-UK': 'EN-GB',
  NO: 'NB'
};

const SOURCE_ALIASES = {
  'ZH-CN': 'ZH',
  'ZH-SG': 'ZH',
  'ZH-HANS': 'ZH',
  'ZH-TW': 'ZH',
  'ZH-HK': 'ZH',
  'ZH-HANT': 'ZH',
  'EN-US': 'EN',
  'EN-GB': 'EN',
  'PT-BR': 'PT',
  'PT-PT': 'PT',
  NO: 'NB'
};

function canonicalLang(value) {
  return String(value || '')
    .trim()
    .replace(/_/g, '-')
    .toUpperCase();
}

function toDeepLTarget(value) {
  const token = canonicalLang(value || 'ZH');
  return TARGET_ALIASES[token] || token || 'ZH';
}

function toDeepLSource(value) {
  const token = canonicalLang(value);
  if (!token || token === 'AUTO') return null;
  return SOURCE_ALIASES[token] || token;
}

function normalizeConfig(config) {
  let engine = (config?.engine || DEFAULTS.engine || 'api').toLowerCase();
  if (engine !== 'llm' && engine !== 'api') {
    engine = 'api';
  }
  return {
    engine,
    translationApiUrl: config?.translationApiUrl || DEFAULTS.translationApiUrl,
    llmApiUrl: config?.llmApiUrl || DEFAULTS.llmApiUrl,
    llmApiKey: config?.llmApiKey || DEFAULTS.llmApiKey,
    llmModel: config?.llmModel || DEFAULTS.llmModel
  };
}

function isRetryableError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (code === 'timeout' || message === 'timeout') {
    return true;
  }
  if (code === 'rate_limited') {
    return true;
  }
  if (code === 'translation_api_429' || code === 'translation_api_500' || code === 'translation_api_504' || code === 'translation_api_529') {
    return true;
  }
  if (error?.status === 429 || error?.status === 500 || error?.status === 504 || error?.status === 529) {
    return true;
  }
  if (/translation_api_(429|500|504|529)/.test(message) || /llm_api_(429|5\d{2})/.test(message)) {
    return true;
  }
  if (/fetch failed|network|socket|econn|eai_again|timed out|timeout/i.test(message)) {
    return true;
  }
  return false;
}

function toTimeoutError() {
  const error = new Error('timeout');
  error.code = 'timeout';
  return error;
}

async function callTranslateApi(payload, config) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(config.translationApiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      clearTimeout(timeout);

      if (!response.ok) {
        let errorPayload = null;
        try {
          errorPayload = await response.json();
        } catch {
          errorPayload = null;
        }
        const message = errorPayload?.message || errorPayload?.error?.message || `translation_api_${response.status}`;
        const err = new Error(String(message));
        err.status = response.status;
        err.code = errorPayload?.code || `translation_api_${response.status}`;
        throw err;
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeout);
      if (error && error.name === 'AbortError') {
        lastError = toTimeoutError();
      } else {
        lastError = error;
      }
      if (attempt === MAX_RETRIES || !isRetryableError(lastError)) {
        throw lastError;
      }
    }
  }

  throw lastError;
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
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

function toPrompt(input) {
  return [
    'Translate each input text segment into the target language.',
    'Return JSON only in this schema:',
    '{"items":[{"id":"string","translated_text":"string","confidence":0.0}]}',
    'Rules:',
    '- Keep item order and ids unchanged.',
    '- translated_text must be translation only, no notes.',
    '- confidence is 0..1 numeric estimate.',
    '- If source is already in the target language, keep semantic meaning and polish lightly.',
    '',
    `source_lang=${input.source_lang || 'auto'}`,
    `target_lang=${input.target_lang || 'zh-CN'}`,
    `items=${JSON.stringify(input.items)}`
  ].join('\n');
}

function extractResponseText(payload) {
  const legacy = payload?.choices?.[0]?.message?.content;
  if (typeof legacy === 'string') {
    return legacy;
  }
  return '';
}

async function callLlmTranslate(input, config) {
  if (!config.llmApiKey) {
    throw new Error('auth_required');
  }

  let lastError;
  const apiUrl = config.llmApiUrl.replace(/\/$/, '');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.llmApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.llmModel,
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
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`llm_api_${response.status}: ${text.slice(0, 120)}`);
      }

      const payload = await response.json();
      const content = extractResponseText(payload);
      if (!content) {
        throw new Error('invalid_provider_response');
      }

      const translatedItems = parseModelPayload(content);
      return { items: translatedItems };
    } catch (error) {
      clearTimeout(timeout);
      if (error && error.name === 'AbortError') {
        lastError = toTimeoutError();
      } else {
        lastError = error;
      }
      if (attempt === MAX_RETRIES || !isRetryableError(lastError)) {
        throw lastError;
      }
    }
  }

  throw lastError;
}

function toDeepLPayload(items, sourceLang, targetLang) {
  const payload = {
    text: items.map((item) => String(item.text || '')),
    target_lang: toDeepLTarget(targetLang)
  };
  const source = toDeepLSource(sourceLang);
  if (source) {
    payload.source_lang = source;
  }
  return payload;
}

function fromDeepLResponse(items, payload) {
  const translations = Array.isArray(payload?.translations) ? payload.translations : [];
  return items.map((item, index) => ({
    id: item.id,
    translated_text: String(translations[index]?.text || ''),
    confidence: translations[index]?.text ? 0.9 : 0
  }));
}

async function translateItems(items, sourceLang, targetLang, config) {
  const normalized = normalizeConfig(config);
  const legacyPayload = {
    request_id: crypto.randomUUID(),
    source_lang: sourceLang,
    target_lang: targetLang,
    items
  };

  if (normalized.engine === 'llm') {
    const result = await callLlmTranslate(legacyPayload, normalized);
    return result.items || [];
  }

  const result = await callTranslateApi(toDeepLPayload(items, sourceLang, targetLang), normalized);
  return fromDeepLResponse(items, result);
}

async function translateBlocks(ocrBlocks, sourceLang = 'auto', targetLang = 'zh-CN', config = {}) {
  if (!ocrBlocks.length) {
    return [];
  }

  const textMap = new Map();
  const uniqueItems = [];

  for (const block of ocrBlocks) {
    const text = String(block.text || '');
    if (!textMap.has(text)) {
      const id = `t${uniqueItems.length + 1}`;
      textMap.set(text, { id, originalIds: [block.id] });
      uniqueItems.push({ id, text });
    } else {
      textMap.get(text).originalIds.push(block.id);
    }
  }

  const translatedItems = await translateItems(uniqueItems, sourceLang, targetLang, config);
  const translatedById = new Map(translatedItems.map((item) => [item.id, item]));
  const expanded = [];

  for (const entry of textMap.values()) {
    const translated = translatedById.get(entry.id);
    for (const originalId of entry.originalIds) {
      expanded.push({
        id: originalId,
        translatedText: translated?.translated_text,
        confidence: translated?.confidence
      });
    }
  }

  return expanded;
}

async function translateText(text, sourceLang = 'auto', targetLang = 'zh-CN', config = {}) {
  const items = [{ id: 't1', text: String(text || '') }];
  const translatedItems = await translateItems(items, sourceLang, targetLang, config);
  const first = translatedItems[0];
  return {
    text: first?.translated_text || '',
    confidence: first?.confidence
  };
}

module.exports = {
  translateBlocks,
  translateText,
  toDeepLTarget,
  toDeepLSource,
  toDeepLPayload,
  fromDeepLResponse
};
