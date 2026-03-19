const MODIFIER_KEYS = new Set([
  'Command',
  'Cmd',
  'CommandOrControl',
  'Control',
  'Ctrl',
  'Alt',
  'Option',
  'Shift',
  'Super',
  'Meta'
]);

function normalizeHotkey(value) {
  return String(value || '').trim();
}

function hasModifierHotkey(hotkey) {
  const normalized = normalizeHotkey(hotkey);
  if (!normalized) {
    return false;
  }
  const parts = normalized
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  return parts.some((part) => MODIFIER_KEYS.has(part));
}

module.exports = {
  normalizeHotkey,
  hasModifierHotkey
};
