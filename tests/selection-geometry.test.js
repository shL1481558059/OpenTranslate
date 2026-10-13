const test = require('node:test');
const assert = require('node:assert/strict');

const { isClick, dragRect, clampRect, pointerScale } = require('../desktop/ui/selection-geometry');

test('a four-line drag keeps its height when the webview sits below the monitor', () => {
  const start = { x: 80, y: 140 };
  const end = { x: 720, y: 236 };
  const rect = dragRect(start, end, { x: 0, y: 29 });
  assert.equal(rect.x, 80);
  assert.equal(rect.y, 169);
  assert.equal(rect.width, 640);
  assert.equal(rect.height, 96);
  assert.equal(isClick(start, end), false);
});

test('drag size follows the pointer, not a mix of monitor and webview origins', () => {
  const start = { x: 40, y: 100 };
  const end = { x: 40, y: 220 };
  const rect = dragRect(start, end, { x: 0, y: 29 });
  assert.equal(rect.height, 120);
  assert.ok(rect.height >= 6);
});

test('hidpi drag maps css pixels through the webview scale', () => {
  const start = { x: 100, y: 105.5 };
  const end = { x: 450, y: 335.5 };
  const rect = dragRect(start, end, { x: 0, y: 29 }, 2);
  assert.equal(rect.x, 200);
  assert.equal(rect.y, 240);
  assert.equal(rect.width, 700);
  assert.equal(rect.height, 460);
});

test('movement under six pixels is a click and six pixels is a drag', () => {
  assert.equal(isClick({ x: 10, y: 10 }, { x: 15, y: 14 }), true);
  assert.equal(isClick({ x: 10, y: 10 }, { x: 16, y: 10 }), false);
});

test('the window pixel ratio wins when devicePixelRatio disagrees', () => {
  assert.equal(pointerScale(1920, 1920, 2, 1), 1);
  assert.equal(pointerScale(1920, 960, 2, 1), 2);
  assert.ok(Math.abs(pointerScale(1920, 1293, 1, 1) - 1920 / 1293) < 1e-9);
  assert.equal(pointerScale(0, 960, 2, 1), 2);
  const scale = pointerScale(1920, 1920, 2, 1);
  const rect = dragRect({ x: 40, y: 108 }, { x: 1245, y: 155 }, { x: 0, y: 0 }, scale);
  assert.deepEqual(rect, { x: 40, y: 108, width: 1205, height: 47 });
});

test('clamp keeps a drag inside the monitor without collapsing a normal box', () => {
  const rect = clampRect(
    { x: -10, y: 20, width: 100, height: 80 },
    { x: 0, y: 0, width: 1920, height: 1200 }
  );
  assert.deepEqual(rect, { x: 0, y: 20, width: 90, height: 80 });
});
