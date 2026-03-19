const test = require('node:test');
const assert = require('node:assert/strict');

const translationProvider = require('../desktop/lib/translation-provider');

test('translation provider should not retry deterministic API errors', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 409,
      json: async () => ({ error_code: 'missing_model' }),
      text: async () => ''
    };
  };

  try {
    await assert.rejects(
      () =>
        translationProvider.translateText('Hello world', 'en', 'zh-CN', {
          engine: 'api',
          translationApiUrl: 'http://127.0.0.1:8787/v1/translate'
        }),
      /missing_model/
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('translation provider should retry transient API failures once', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => ''
      };
    }
    return {
      ok: true,
      json: async () => ({
        items: [{ id: 't1', translated_text: '你好，世界', confidence: 0.98 }]
      })
    };
  };

  try {
    const result = await translationProvider.translateText('Hello world', 'en', 'zh-CN', {
      engine: 'api',
      translationApiUrl: 'http://127.0.0.1:8787/v1/translate'
    });
    assert.equal(result.text, '你好，世界');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('translation provider should not retry deterministic LLM errors', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 400,
      text: async () => 'bad request'
    };
  };

  try {
    await assert.rejects(
      () =>
        translationProvider.translateText('Hello world', 'en', 'zh-CN', {
          engine: 'llm',
          llmApiUrl: 'https://api.example.com/v1',
          llmApiKey: 'test-key',
          llmModel: 'test-model'
        }),
      /llm_api_400/
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
