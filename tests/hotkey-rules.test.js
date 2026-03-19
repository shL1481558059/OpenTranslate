const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeHotkey, hasModifierHotkey } = require('../desktop/lib/hotkey-rules');

test('normalizeHotkey should trim input and handle empty values', () => {
  assert.equal(normalizeHotkey('  Command+K  '), 'Command+K');
  assert.equal(normalizeHotkey(''), '');
  assert.equal(normalizeHotkey(null), '');
});

test('hasModifierHotkey should reject single key accelerators', () => {
  assert.equal(hasModifierHotkey('A'), false);
  assert.equal(hasModifierHotkey('F5'), false);
  assert.equal(hasModifierHotkey('Tab'), false);
});

test('hasModifierHotkey should accept valid modifier combos', () => {
  assert.equal(hasModifierHotkey('Command+Shift+T'), true);
  assert.equal(hasModifierHotkey('Control+Enter'), true);
  assert.equal(hasModifierHotkey('CommandOrControl+K'), true);
});
