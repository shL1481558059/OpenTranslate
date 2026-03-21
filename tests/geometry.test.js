const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRect, rectRelativeToBounds } = require('../desktop/lib/geometry');

test('normalizeRect rounds coordinates and clamps negative sizes', () => {
  assert.deepEqual(normalizeRect({ x: 10.4, y: 20.6, width: -12, height: 35.2 }), {
    x: 10,
    y: 21,
    width: 0,
    height: 35
  });
});

test('rectRelativeToBounds reanchors a selection inside the actual overlay window bounds', () => {
  assert.deepEqual(
    rectRelativeToBounds(
      { x: 112, y: 180, width: 220, height: 96 },
      { x: 64, y: 0, width: 1440, height: 900 }
    ),
    { x: 48, y: 180, width: 220, height: 96 }
  );
});
