const test = require('node:test');
const assert = require('node:assert/strict');

const { mapBlocks } = require('../desktop/lib/layout-engine');

test('mapBlocks should preserve block ids and use translated text', () => {
  const ocrBlocks = [
    { id: 'b1', text: 'Hello', bbox: { x: 10, y: 10, width: 100, height: 30 } },
    { id: 'b2', text: 'World', bbox: { x: 10, y: 50, width: 100, height: 30 } }
  ];

  const translated = [
    { id: 'b1', translatedText: '你好' },
    { id: 'b2', translatedText: '世界' }
  ];

  const mapped = mapBlocks(ocrBlocks, translated);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].id, 'b1');
  assert.equal(mapped[0].text, '你好');
  assert.equal(mapped[1].text, '世界');
});

test('mapBlocks should fallback when translation missing', () => {
  const ocrBlocks = [{ id: 'b1', text: 'Hello', bbox: { x: 0, y: 0, width: 60, height: 20 } }];
  const mapped = mapBlocks(ocrBlocks, []);
  assert.equal(mapped[0].text.includes('翻译失败'), true);
});
