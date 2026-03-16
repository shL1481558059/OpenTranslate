const test = require('node:test');
const assert = require('node:assert/strict');

const payload = {
  request_id: 'r1',
  source_lang: 'auto',
  target_lang: 'zh-CN',
  items: [
    { id: 'b1', text: 'Hello world' },
    { id: 'b2', text: 'How are you?' }
  ]
};

test('translate payload should match required contract shape', () => {
  assert.equal(typeof payload.request_id, 'string');
  assert.equal(Array.isArray(payload.items), true);
  assert.equal(typeof payload.items[0].id, 'string');
  assert.equal(typeof payload.items[0].text, 'string');
  assert.equal(payload.target_lang, 'zh-CN');
});
