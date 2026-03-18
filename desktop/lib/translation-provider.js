const crypto = require('node:crypto');

const REQUEST_TIMEOUT_MS = Number(process.env.CLIENT_TRANSLATION_TIMEOUT_MS || 20000);
const MAX_RETRIES = 1;

const DEFAULTS = {
  engine: (process.env.DESKTOP_TRANSLATION_ENGINE || 'api').toLowerCase(),
  translationApiUrl: process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8787/v1/translate',
  llmApiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini'
};

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
        if (errorPayload?.error_code) {
          const err = new Error(String(errorPayload.error_code));
          err.code = errorPayload.error_code;
          err.meta = errorPayload.missing_model || null;
          throw err;
        }
        throw new Error(`translation_api_${response.status}`);
      }

      const payloadJson = await response.json();
      if (payloadJson?.error_code) {
        const err = new Error(String(payloadJson.error_code));
        err.code = payloadJson.error_code;
        err.meta = payloadJson.missing_model || null;
        throw err;
      }
      return payloadJson;
    } catch (error) {
      clearTimeout(timeout);
      if (error && error.name === 'AbortError') {
        lastError = new Error('timeout');
      } else {
        lastError = error;
      }
      if (attempt === MAX_RETRIES) {
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
        lastError = new Error('timeout');
      } else {
        lastError = error;
      }
      if (attempt === MAX_RETRIES) {
        throw lastError;
      }
    }
  }

  throw lastError;
}

async function translateItems(items, sourceLang, targetLang, config) {
  const normalized = normalizeConfig(config);
  const payload = {
    request_id: crypto.randomUUID(),
    source_lang: sourceLang,
    target_lang: targetLang,
    items
  };

  if (normalized.engine === 'llm') {
    const result = await callLlmTranslate(payload, normalized);
    return result.items || [];
  }

  const result = await callTranslateApi(payload, normalized);
  return result.items || [];
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
  translateText
};
