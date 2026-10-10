const crypto = require('node:crypto');

const MAX_BODY_BYTES = 128 * 1024;

const SOURCE_LANGUAGES = [
  ['AR', 'Arabic'],
  ['BG', 'Bulgarian'],
  ['CS', 'Czech'],
  ['DA', 'Danish'],
  ['DE', 'German'],
  ['EL', 'Greek'],
  ['EN', 'English'],
  ['ES', 'Spanish'],
  ['ET', 'Estonian'],
  ['FI', 'Finnish'],
  ['FR', 'French'],
  ['HE', 'Hebrew'],
  ['HU', 'Hungarian'],
  ['ID', 'Indonesian'],
  ['IT', 'Italian'],
  ['JA', 'Japanese'],
  ['KO', 'Korean'],
  ['LT', 'Lithuanian'],
  ['LV', 'Latvian'],
  ['NB', 'Norwegian (Bokmål)'],
  ['NL', 'Dutch'],
  ['PL', 'Polish'],
  ['PT', 'Portuguese'],
  ['RO', 'Romanian'],
  ['RU', 'Russian'],
  ['SK', 'Slovak'],
  ['SL', 'Slovenian'],
  ['SV', 'Swedish'],
  ['TH', 'Thai'],
  ['TR', 'Turkish'],
  ['UK', 'Ukrainian'],
  ['VI', 'Vietnamese'],
  ['ZH', 'Chinese']
];

const TARGET_EXTRAS = [
  ['DE-DE', 'German (Germany)', true],
  ['DE-CH', 'German (Switzerland)', true],
  ['EN-GB', 'English (British)', false],
  ['EN-US', 'English (American)', false],
  ['ES-419', 'Spanish (Latin American)', true],
  ['ES-ES', 'Spanish (Spain)', true],
  ['FR-CA', 'French (Canada)', true],
  ['FR-FR', 'French (France)', true],
  ['PT-BR', 'Portuguese (Brazilian)', true],
  ['PT-PT', 'Portuguese (European)', true],
  ['ZH-HANS', 'Chinese (simplified)', false],
  ['ZH-HANT', 'Chinese (traditional)', false]
];

const FORMALITY_TARGETS = new Set([
  'DE',
  'DE-DE',
  'DE-CH',
  'ES',
  'ES-419',
  'ES-ES',
  'FR',
  'FR-CA',
  'FR-FR',
  'IT',
  'JA',
  'NL',
  'PL',
  'PT-BR',
  'PT-PT',
  'RU'
]);

const SOURCE_SET = new Set(SOURCE_LANGUAGES.map(([code]) => code));
const TARGET_SET = new Set([
  ...SOURCE_LANGUAGES.map(([code]) => code).filter((code) => code !== 'EN'),
  'ZH',
  ...TARGET_EXTRAS.map(([code]) => code)
]);

const SOURCE_ALIASES = {
  'ZH-CN': 'ZH',
  'ZH-SG': 'ZH',
  'ZH-HANS': 'ZH',
  'ZH-TW': 'ZH',
  'ZH-HK': 'ZH',
  'ZH-MO': 'ZH',
  'ZH-HANT': 'ZH',
  'EN-US': 'EN',
  'EN-GB': 'EN',
  'PT-BR': 'PT',
  'PT-PT': 'PT',
  'DE-DE': 'DE',
  'DE-CH': 'DE',
  'ES-419': 'ES',
  'ES-ES': 'ES',
  'FR-CA': 'FR',
  'FR-FR': 'FR',
  NO: 'NB',
  'NB-NO': 'NB'
};

const TARGET_ALIASES = {
  EN: 'EN-US',
  'ZH-CN': 'ZH',
  'ZH-SG': 'ZH',
  'ZH-TW': 'ZH-HANT',
  'ZH-HK': 'ZH-HANT',
  'ZH-MO': 'ZH-HANT',
  'EN-UK': 'EN-GB',
  NO: 'NB',
  'NB-NO': 'NB'
};

const ENGINE_LANG = {
  AR: 'ar',
  BG: 'bg',
  CS: 'cs',
  DA: 'da',
  DE: 'de',
  EL: 'el',
  EN: 'en',
  ES: 'es',
  ET: 'et',
  FI: 'fi',
  FR: 'fr',
  HE: 'he',
  HU: 'hu',
  ID: 'id',
  IT: 'it',
  JA: 'ja',
  KO: 'ko',
  LT: 'lt',
  LV: 'lv',
  NB: 'nb',
  NL: 'nl',
  PL: 'pl',
  PT: 'pt',
  RO: 'ro',
  RU: 'ru',
  SK: 'sk',
  SL: 'sl',
  SV: 'sv',
  TH: 'th',
  TR: 'tr',
  UK: 'uk',
  VI: 'vi',
  ZH: 'zh'
};

function canonicalToken(value) {
  return String(value || '')
    .trim()
    .replace(/_/g, '-')
    .toUpperCase();
}

function normalizeSourceLang(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, code: null };
  }
  const token = canonicalToken(value);
  const code = SOURCE_ALIASES[token] || token;
  if (!SOURCE_SET.has(code)) {
    return { ok: false, message: "Value for 'source_lang' not supported." };
  }
  return { ok: true, code };
}

function normalizeTargetLang(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: false, message: "Missing or empty 'target_lang' parameter." };
  }
  const token = canonicalToken(value);
  const code = TARGET_ALIASES[token] || token;
  if (!TARGET_SET.has(code)) {
    return { ok: false, message: "Value for 'target_lang' not supported." };
  }
  return { ok: true, code };
}

function toEngineLang(code) {
  const token = canonicalToken(code);
  const source = SOURCE_ALIASES[token] || (token.startsWith('ZH') ? 'ZH' : token.split('-')[0]);
  return ENGINE_LANG[source] || ENGINE_LANG[token] || source.toLowerCase();
}

function toDetectedSourceLanguage(engineOrCode) {
  const token = canonicalToken(engineOrCode);
  if (SOURCE_SET.has(token)) {
    return token;
  }
  if (SOURCE_ALIASES[token]) {
    return SOURCE_ALIASES[token];
  }
  const lower = String(engineOrCode || '').trim().toLowerCase();
  if (lower.startsWith('zh')) return 'ZH';
  if (lower.startsWith('en')) return 'EN';
  if (lower.startsWith('pt')) return 'PT';
  if (lower === 'nb' || lower === 'no') return 'NB';
  const upper = token.split('-')[0];
  return SOURCE_SET.has(upper) ? upper : 'EN';
}

function countCharacters(text) {
  return Array.from(String(text || '')).length;
}

function isTruthyFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return [String(value)];
}

function parseMultipart(raw, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) {
    throw new Error('invalid_multipart');
  }
  const boundary = match[1] || match[2];
  const text = raw.toString('utf8');
  const parts = text.split(`--${boundary}`);
  const fields = {};
  const push = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const current = fields[key];
      fields[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      fields[key] = value;
    }
  };
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n') continue;
    const separated = part.split('\r\n\r\n');
    if (separated.length < 2) continue;
    const headers = separated.shift();
    let body = separated.join('\r\n\r\n');
    body = body.replace(/\r\n$/, '').replace(/--$/, '');
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    if (!nameMatch) continue;
    push(nameMatch[1], body);
  }
  return fields;
}

function formToBody(params) {
  const body = {};
  const text = [];
  for (const [key, value] of params.entries()) {
    if (key === 'text') {
      text.push(value);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const current = body[key];
      body[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      body[key] = value;
    }
  }
  body.text = text;
  return body;
}

function parseRequestBody(raw, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const text = raw.toString('utf8');
  if (!text.trim()) {
    return {};
  }
  if (type === 'application/json' || (!type && text.trim().startsWith('{'))) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid_json');
    }
    return parsed;
  }
  if (type === 'multipart/form-data') {
    return parseMultipart(raw, contentType);
  }
  return formToBody(new URLSearchParams(text));
}

function normalizeTranslateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, message: 'Bad request. Please check error message and your parameters.' };
  }
  const texts = asStringList(body.text);
  if (!texts.length) {
    return { ok: false, status: 400, message: "Missing or empty 'text' parameter." };
  }
  const source = normalizeSourceLang(body.source_lang);
  if (!source.ok) {
    return { ok: false, status: 400, message: source.message };
  }
  const target = normalizeTargetLang(body.target_lang);
  if (!target.ok) {
    return { ok: false, status: 400, message: target.message };
  }
  const modelType = body.model_type === undefined || body.model_type === null || body.model_type === ''
    ? null
    : String(body.model_type);
  let modelTypeUsed = null;
  if (modelType) {
    if (modelType === 'quality_optimized' || modelType === 'prefer_quality_optimized') {
      modelTypeUsed = 'quality_optimized';
    } else if (modelType === 'latency_optimized') {
      modelTypeUsed = 'latency_optimized';
    } else {
      modelTypeUsed = 'latency_optimized';
    }
  }
  const tagHandling = body.tag_handling ? String(body.tag_handling).toLowerCase() : '';
  const tagHandlingVersion = tagHandling === 'xml' || tagHandling === 'html'
    ? (String(body.tag_handling_version || 'v2').toLowerCase() === 'v1' ? 'v1' : 'v2')
    : null;
  return {
    ok: true,
    texts,
    sourceLang: source.code,
    targetLang: target.code,
    showBilledCharacters: isTruthyFlag(body.show_billed_characters),
    modelTypeUsed,
    tagHandlingVersion
  };
}

function traceId() {
  return crypto.randomBytes(16).toString('hex');
}

function errorPayload(message, code) {
  const payload = { message };
  if (code) payload.code = code;
  return payload;
}

function statusCodeFor(status) {
  if (status === 400) return 'bad_request';
  if (status === 403) return 'authorization_failed';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 429 || status === 529) return 'too_many_requests';
  if (status === 456) return 'quota_exceeded';
  if (status === 504) return 'service_unavailable';
  return 'internal_error';
}

function configuredAuthKey() {
  return String(process.env.DEEPL_AUTH_KEY || process.env.TRANSLATION_API_KEY || '').trim();
}

function isLoopbackAddress(address) {
  const raw = String(address || '');
  const ip = raw.replace(/^::ffff:/i, '');
  return ip === '127.0.0.1' || ip === '::1' || raw === '::1';
}

function extractAuthKey(req, url, body) {
  const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  const deepl = header.match(/^DeepL-Auth-Key\s+(.+)$/i);
  if (deepl) return deepl[1].trim();
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  if (body && typeof body.auth_key === 'string' && body.auth_key.trim()) {
    return body.auth_key.trim();
  }
  const queryKey = url?.searchParams?.get('auth_key');
  if (queryKey && queryKey.trim()) return queryKey.trim();
  return '';
}

function keysMatch(provided, expected) {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function authorize(req, url, body) {
  const expected = configuredAuthKey();
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  if (!expected) {
    if (isLoopbackAddress(remote)) {
      return { ok: true };
    }
    return {
      ok: false,
      status: 403,
      message: 'Authorization failed. Please supply a valid DeepL-Auth-Key via the Authorization header.'
    };
  }
  const provided = extractAuthKey(req, url, body);
  if (provided && keysMatch(provided, expected)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    message: 'Authorization failed. Please supply a valid DeepL-Auth-Key via the Authorization header.'
  };
}

function listLanguages(type) {
  const kind = String(type || 'source').toLowerCase();
  if (kind === 'target') {
    const base = SOURCE_LANGUAGES
      .filter(([code]) => code !== 'EN')
      .map(([language, name]) => ({
        language,
        name,
        supports_formality: FORMALITY_TARGETS.has(language)
      }));
    const extras = TARGET_EXTRAS.map(([language, name, supports]) => ({
      language,
      name,
      supports_formality: supports
    }));
    const chinese = {
      language: 'ZH',
      name: 'Chinese (simplified)',
      supports_formality: false
    };
    return [...base.filter((item) => item.language !== 'ZH'), chinese, ...extras];
  }
  return SOURCE_LANGUAGES.map(([language, name]) => ({ language, name }));
}

function providerFailure(error) {
  const message = String(error?.message || error || '');
  if (message.includes('missing_model:') || message.includes('no_translation_pair:')) {
    return {
      status: 504,
      message: 'Resource currently unavailable. Try again later.',
      code: 'service_unavailable'
    };
  }
  if (message.includes('timeout')) {
    return {
      status: 504,
      message: 'Resource currently unavailable. Try again later.',
      code: 'service_unavailable'
    };
  }
  if (message.includes('429') || message.includes('rate')) {
    return {
      status: 429,
      message: 'Too many requests. Please wait and resend your request.',
      code: 'too_many_requests'
    };
  }
  return {
    status: 500,
    message: 'Internal error.',
    code: 'internal_error'
  };
}

module.exports = {
  MAX_BODY_BYTES,
  SOURCE_LANGUAGES,
  normalizeSourceLang,
  normalizeTargetLang,
  toEngineLang,
  toDetectedSourceLanguage,
  countCharacters,
  parseRequestBody,
  normalizeTranslateBody,
  traceId,
  errorPayload,
  statusCodeFor,
  authorize,
  isLoopbackAddress,
  extractAuthKey,
  configuredAuthKey,
  listLanguages,
  providerFailure
};
