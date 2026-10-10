const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const deepl = require('../api/deepl');
const localArgos = require('../api/local/argos_client');
const { startTranslationApi } = require('../api/server');

function request(baseUrl, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  const url = new URL(path, baseUrl);
  const payload = body == null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload
            ? { 'Content-Length': payload.length }
            : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const started = await startTranslationApi({ host: '127.0.0.1', port: 0 });
  assert.equal(started.ok, true);
  const baseUrl = `http://127.0.0.1:${started.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

test('deepl language codes are case-insensitive and map regional variants', () => {
  assert.deepEqual(deepl.normalizeTargetLang('zh-hans'), { ok: true, code: 'ZH-HANS' });
  assert.deepEqual(deepl.normalizeTargetLang('ZH-hant'), { ok: true, code: 'ZH-HANT' });
  assert.deepEqual(deepl.normalizeTargetLang('en-us'), { ok: true, code: 'EN-US' });
  assert.deepEqual(deepl.normalizeTargetLang('en-gb'), { ok: true, code: 'EN-GB' });
  assert.deepEqual(deepl.normalizeTargetLang('zh-CN'), { ok: true, code: 'ZH' });
  assert.deepEqual(deepl.normalizeTargetLang('en'), { ok: true, code: 'EN-US' });
  assert.equal(deepl.normalizeTargetLang('').ok, false);
  assert.equal(deepl.normalizeTargetLang('xx').ok, false);
  assert.deepEqual(deepl.normalizeSourceLang('En-Gb'), { ok: true, code: 'EN' });
  assert.deepEqual(deepl.normalizeSourceLang(''), { ok: true, code: null });
  assert.equal(deepl.toEngineLang('ZH-HANT'), 'zh');
  assert.equal(deepl.toEngineLang('EN-US'), 'en');
  assert.equal(deepl.toDetectedSourceLanguage('zh'), 'ZH');
});

test('deepl auth allows loopback without a key and rejects remote clients', () => {
  const previous = process.env.DEEPL_AUTH_KEY;
  delete process.env.DEEPL_AUTH_KEY;
  delete process.env.TRANSLATION_API_KEY;
  try {
    assert.equal(
      deepl.authorize({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, new URL('http://127.0.0.1/v2/translate'), {})
        .ok,
      true
    );
    const remote = deepl.authorize(
      { socket: { remoteAddress: '10.1.2.3' }, headers: {} },
      new URL('http://10.1.2.3/v2/translate'),
      {}
    );
    assert.equal(remote.ok, false);
    assert.equal(remote.status, 403);
  } finally {
    if (previous === undefined) delete process.env.DEEPL_AUTH_KEY;
    else process.env.DEEPL_AUTH_KEY = previous;
  }
});

test('deepl auth accepts DeepL-Auth-Key, Bearer, and auth_key', () => {
  const previous = process.env.DEEPL_AUTH_KEY;
  process.env.DEEPL_AUTH_KEY = 'secret-key';
  try {
    const url = new URL('http://127.0.0.1/v2/translate');
    assert.equal(
      deepl.authorize(
        { socket: { remoteAddress: '10.0.0.8' }, headers: { authorization: 'DeepL-Auth-Key secret-key' } },
        url,
        {}
      ).ok,
      true
    );
    assert.equal(
      deepl.authorize(
        { socket: { remoteAddress: '10.0.0.8' }, headers: { authorization: 'Bearer secret-key' } },
        url,
        {}
      ).ok,
      true
    );
    assert.equal(
      deepl.authorize({ socket: { remoteAddress: '10.0.0.8' }, headers: {} }, url, { auth_key: 'secret-key' }).ok,
      true
    );
    assert.equal(
      deepl.authorize(
        { socket: { remoteAddress: '10.0.0.8' }, headers: { authorization: 'DeepL-Auth-Key wrong' } },
        url,
        {}
      ).status,
      403
    );
  } finally {
    if (previous === undefined) delete process.env.DEEPL_AUTH_KEY;
    else process.env.DEEPL_AUTH_KEY = previous;
  }
});

test('POST /v2/translate accepts JSON and form, optional source_lang, and extra DeepL fields', async () => {
  const original = localArgos.translateItems;
  localArgos.translateItems = async (items) =>
    items.map((item) => ({
      id: item.id,
      translated_text: item.text === 'Hello' ? '你好' : `译:${item.text}`,
      confidence: 0.91
    }));
  const previousKey = process.env.DEEPL_AUTH_KEY;
  delete process.env.DEEPL_AUTH_KEY;
  try {
    await withServer(async (baseUrl) => {
      const json = await request(baseUrl, {
        method: 'POST',
        path: '/v2/translate',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ['Hello', 'World'],
          target_lang: 'zh-hans',
          context: 'greeting',
          formality: 'prefer_more',
          glossary_id: 'ignored',
          split_sentences: '1',
          preserve_formatting: true,
          show_billed_characters: true,
          model_type: 'latency_optimized',
          tag_handling: 'html'
        })
      });
      assert.equal(json.status, 200);
      assert.equal(json.json.translations.length, 2);
      assert.equal(json.json.translations[0].detected_source_language, 'EN');
      assert.equal(json.json.translations[0].text, '你好');
      assert.equal(json.json.translations[1].text, '译:World');
      assert.equal(typeof json.json.translations[0].billed_characters, 'number');
      assert.equal(json.json.translations[0].model_type_used, 'latency_optimized');
      assert.equal(json.json.translations[0].tag_handling_version, 'v2');
      assert.equal(json.raw.includes('翻译失败'), false);
      assert.ok(json.headers['x-trace-id']);

      const form = await request(baseUrl, {
        method: 'POST',
        path: '/v2/translate',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'text=Hello&text=World&target_lang=EN-US&source_lang=zh'
      });
      assert.equal(form.status, 200);
      assert.equal(form.json.translations[0].detected_source_language, 'ZH');
      assert.equal(form.json.translations.length, 2);

      const missing = await request(baseUrl, {
        method: 'POST',
        path: '/v2/translate',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ['Hello'] })
      });
      assert.equal(missing.status, 400);
      assert.match(missing.json.message, /target_lang/);
      assert.equal(missing.raw.includes('翻译失败'), false);

      const languages = await request(baseUrl, { path: '/v2/languages?type=target' });
      assert.equal(languages.status, 200);
      assert.ok(languages.json.some((item) => item.language === 'ZH-HANT'));
      assert.ok(languages.json.some((item) => item.language === 'EN-GB'));

      const usage = await request(baseUrl, { path: '/v2/usage' });
      assert.equal(usage.status, 200);
      assert.equal(typeof usage.json.character_count, 'number');
      assert.equal(typeof usage.json.character_limit, 'number');

      const removed = await request(baseUrl, {
        method: 'POST',
        path: '/v1/translate',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 'b1', text: 'Hello' }], target_lang: 'zh' })
      });
      assert.equal(removed.status, 404);
    });
  } finally {
    localArgos.translateItems = original;
    if (previousKey === undefined) delete process.env.DEEPL_AUTH_KEY;
    else process.env.DEEPL_AUTH_KEY = previousKey;
  }
});

test('POST /v2/translate returns DeepL auth and quota errors', async () => {
  const previousKey = process.env.DEEPL_AUTH_KEY;
  const previousLimit = process.env.DEEPL_CHARACTER_LIMIT;
  process.env.DEEPL_AUTH_KEY = 'desktop-key';
  process.env.DEEPL_CHARACTER_LIMIT = '0';
  const { __internal } = require('../api/server');
  __internal.resetUsage(0);
  try {
    await withServer(async (baseUrl) => {
      const denied = await request(baseUrl, {
        method: 'POST',
        path: '/v2/translate',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ['Hello'], target_lang: 'ZH' })
      });
      assert.equal(denied.status, 403);
      assert.match(denied.json.message, /Authorization failed/);

      const tooBig = await request(baseUrl, {
        method: 'POST',
        path: '/v2/translate?auth_key=desktop-key',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'DeepL-Auth-Key desktop-key'
        },
        body: JSON.stringify({ text: ['Hello world'], target_lang: 'DE' })
      });
      assert.equal(tooBig.status, 456);
      assert.match(tooBig.json.message, /Quota exceeded/);
    });
  } finally {
    if (previousKey === undefined) delete process.env.DEEPL_AUTH_KEY;
    else process.env.DEEPL_AUTH_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.DEEPL_CHARACTER_LIMIT;
    else process.env.DEEPL_CHARACTER_LIMIT = previousLimit;
  }
});
