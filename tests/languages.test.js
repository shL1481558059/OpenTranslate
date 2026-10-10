const test = require('node:test');
const assert = require('node:assert/strict');

test('language lists keep auto on the source side only', async () => {
  const { languageOptions } = await import('../desktop/ui/languages.mjs');
  const source = languageOptions({ includeAuto: true }).map((item) => item.value);
  const target = languageOptions({ includeAuto: false }).map((item) => item.value);
  assert.equal(source[0], 'auto');
  assert.ok(source.includes('zh-CN'));
  assert.ok(source.includes('en'));
  assert.ok(source.includes('ja'));
  assert.equal(target.includes('auto'), false);
  assert.equal(target[0], 'zh-CN');
});

test('changing the target language retriggers only when there is text', async () => {
  const { shouldRetranslate } = await import('../desktop/ui/languages.mjs');
  assert.equal(shouldRetranslate('Hello', 'zh-CN', 'en'), true);
  assert.equal(shouldRetranslate('   ', 'zh-CN', 'en'), false);
  assert.equal(shouldRetranslate('Hello', 'en', 'en'), false);
});
