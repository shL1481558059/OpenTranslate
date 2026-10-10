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
      status: 400,
      json: async () => ({ message: "Value for 'target_lang' not supported.", code: 'bad_request' }),
      text: async () => ''
    };
  };

  try {
    await assert.rejects(
      () =>
        translationProvider.translateText('Hello world', 'en', 'zh-CN', {
          engine: 'api',
          translationApiUrl: 'http://127.0.0.1:8787/v2/translate'
        }),
      /target_lang/
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
        status: 504,
        json: async () => ({ message: 'Resource currently unavailable. Try again later.' }),
        text: async () => ''
      };
    }
    return {
      ok: true,
      json: async () => ({
        translations: [{ detected_source_language: 'EN', text: '你好，世界' }]
      })
    };
  };

  try {
    const result = await translationProvider.translateText('Hello world', 'en', 'zh-CN', {
      engine: 'api',
      translationApiUrl: 'http://127.0.0.1:8787/v2/translate'
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
