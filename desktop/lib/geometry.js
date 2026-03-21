function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function toRectSource(rect) {
  return rect && typeof rect === 'object' ? rect : {};
}

function roundCoordinate(value) {
  return Math.round(toNumber(value));
}

function normalizeSize(value) {
  return Math.max(0, Math.round(toNumber(value)));
}

function normalizeRect(rect) {
  const source = toRectSource(rect);
  return {
    x: roundCoordinate(source.x),
    y: roundCoordinate(source.y),
    width: normalizeSize(source.width),
    height: normalizeSize(source.height)
  };
}

function rectRelativeToBounds(rect, bounds) {
  const nextRect = normalizeRect(rect);
  const nextBounds = normalizeRect(bounds);
  return {
    x: nextRect.x - nextBounds.x,
    y: nextRect.y - nextBounds.y,
    width: nextRect.width,
    height: nextRect.height
  };
}

module.exports = {
  normalizeRect,
  rectRelativeToBounds
};
