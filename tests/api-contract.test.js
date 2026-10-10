const test = require('node:test');
const assert = require('node:assert/strict');

const { toDeepLPayload, toDeepLTarget, toDeepLSource } = require('../desktop/lib/translation-provider');

test('desktop translate payload should follow DeepL v2', () => {
  const payload = toDeepLPayload(
    [
      { id: 'b1', text: 'Hello world' },
      { id: 'b2', text: 'How are you?' }
    ],
    'auto',
    'zh-CN'
  );
  assert.deepEqual(payload.text, ['Hello world', 'How are you?']);
  assert.equal(payload.target_lang, 'ZH');
  assert.equal(payload.source_lang, undefined);
  assert.equal(toDeepLTarget('en-us'), 'EN-US');
  assert.equal(toDeepLTarget('EN-gb'), 'EN-GB');
  assert.equal(toDeepLTarget('zh-Hant'), 'ZH-HANT');
  assert.equal(toDeepLSource('en-US'), 'EN');
  assert.equal(toDeepLSource('auto'), null);
});
