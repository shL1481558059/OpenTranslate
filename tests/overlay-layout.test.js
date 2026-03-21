const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOverlayLayout } = require('../desktop/lib/overlay-layout');

test('buildOverlayLayout prefers top-right gutter when there is space', () => {
  const layout = buildOverlayLayout(
    { x: 100, y: 100, width: 120, height: 60 },
    { x: 0, y: 0, width: 1440, height: 900 }
  );

  assert.equal(layout.controlSide, 'top');
  assert.deepEqual(layout.overlayBounds, { x: 100, y: 100, width: 120, height: 60 });
  assert.deepEqual(layout.controlBounds, { x: 0, y: 64, width: 262, height: 36 });
});

test('buildOverlayLayout moves the control bar below the region near top-right edges', () => {
  const layout = buildOverlayLayout(
    { x: 1360, y: 4, width: 70, height: 40 },
    { x: 0, y: 0, width: 1440, height: 900 }
  );

  assert.equal(layout.controlSide, 'bottom');
  assert.deepEqual(layout.overlayBounds, { x: 1360, y: 4, width: 70, height: 40 });
  assert.deepEqual(layout.controlBounds, { x: 1168, y: 44, width: 262, height: 36 });
});
