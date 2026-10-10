const test = require('node:test');
const assert = require('node:assert/strict');

test('translate errors keep a single failure prefix', async () => {
  const { presentTranslateError } = await import('../desktop/ui/status-text.mjs');
  assert.equal(
    presentTranslateError('翻译失败（400）：Translation from \'en\' to \'ja\' is not supported'),
    '翻译失败（400）：Translation from \'en\' to \'ja\' is not supported'
  );
  assert.equal(
    presentTranslateError('当前翻译服务不支持 英文→日文，请换目标语言或更换接口'),
    '当前翻译服务不支持 英文→日文，请换目标语言或更换接口'
  );
  assert.equal(presentTranslateError('认证失败，请检查 API Key。'), '翻译失败：认证失败，请检查 API Key。');
  assert.equal(presentTranslateError(''), '翻译失败：未知错误');
});
