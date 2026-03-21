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

test('mapBlocks should reanchor compact low-confidence layouts to the top', () => {
  const ocrBlocks = [
    { id: 'b1', text: 'Hello', bbox: { x: 0, y: 92, width: 140, height: 24 } },
    { id: 'b2', text: 'World', bbox: { x: 10, y: 120, width: 140, height: 22 } }
  ];
  const mapped = mapBlocks(
    ocrBlocks,
    [
      { id: 'b1', translatedText: '你好' },
      { id: 'b2', translatedText: '世界' }
    ],
    { selectionRect: { x: 0, y: 0, width: 210, height: 170 } }
  );

  assert.equal(mapped[0].bbox.y, 0);
  assert.equal(mapped[1].bbox.y, 28);
});

test('mapBlocks should replace very compact noisy layouts with one full-mask result block', () => {
  const ocrBlocks = [
    { id: 'b1', text: '.', bbox: { x: 4, y: 19, width: 14, height: 10 } },
    { id: 'b2', text: 'Hello', bbox: { x: 0, y: 70, width: 80, height: 20 } },
    { id: 'b3', text: 'World', bbox: { x: 10, y: 93, width: 82, height: 18 } }
  ];

  const mapped = mapBlocks(
    ocrBlocks,
    [
      { id: 'b1', translatedText: '。' },
      { id: 'b2', translatedText: '你好' },
      { id: 'b3', translatedText: '世界' }
    ],
    { selectionRect: { x: 0, y: 0, width: 103, height: 115 } }
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 'compact-result');
  assert.equal(mapped[0].bbox.x, 0);
  assert.equal(mapped[0].bbox.y, 0);
  assert.equal(mapped[0].bbox.width, 103);
  assert.equal(mapped[0].bbox.height, 115);
  assert.equal(mapped[0].text, '你好\n世界');
  assert.equal(mapped[0].styleHint.layout, 'center');
  assert.equal(mapped[0].styleHint.layoutMode, 'compact-mask-replace');
});

test('mapBlocks should preserve accurate compact layouts near the top edge', () => {
  const ocrBlocks = [
    { id: 'b1', text: 'Hello', bbox: { x: 0, y: 8, width: 120, height: 18 } },
    { id: 'b2', text: 'World', bbox: { x: 0, y: 34, width: 120, height: 18 } }
  ];

  const mapped = mapBlocks(
    ocrBlocks,
    [
      { id: 'b1', translatedText: '你好' },
      { id: 'b2', translatedText: '世界' }
    ],
    { selectionRect: { x: 0, y: 0, width: 140, height: 90 } }
  );

  assert.equal(mapped[0].bbox.x, 0);
  assert.equal(mapped[1].bbox.x, 0);
  assert.equal(mapped[0].bbox.y, 8);
  assert.equal(mapped[1].bbox.y, 34);
  assert.equal(mapped[0].styleHint.layoutMode, 'ocr');
  assert.equal(mapped[1].styleHint.layoutMode, 'ocr');
});
