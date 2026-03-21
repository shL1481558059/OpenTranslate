const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExtractedText } = require('../desktop/lib/extraction-text');

test('buildExtractedText orders nearby rows by x before joining text', () => {
  const text = buildExtractedText([
    { text: 'World', bbox: { x: 86, y: 12, width: 60, height: 22 } },
    { text: 'Hello', bbox: { x: 12, y: 10, width: 60, height: 22 } },
    { text: 'Again', bbox: { x: 12, y: 64, width: 60, height: 22 } }
  ]);

  assert.equal(text, 'Hello\nWorld\nAgain');
});

test('buildExtractedText ignores empty blocks and preserves line breaks inside a block', () => {
  const text = buildExtractedText([
    { text: '  ', bbox: { x: 10, y: 10, width: 20, height: 20 } },
    { text: 'Line 1\n Line 2 ', bbox: { x: 30, y: 30, width: 80, height: 30 } }
  ]);

  assert.equal(text, 'Line 1\nLine 2');
});
