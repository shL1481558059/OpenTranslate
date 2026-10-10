(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.selectionGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CLICK_DISTANCE = 6;

  function isClick(startClient, endClient, threshold) {
    const limit = Number.isFinite(threshold) ? threshold : CLICK_DISTANCE;
    return Math.abs(startClient.x - endClient.x) < limit && Math.abs(startClient.y - endClient.y) < limit;
  }

  function clientToScreen(client, origin) {
    return {
      x: Math.round(origin.x + client.x),
      y: Math.round(origin.y + client.y)
    };
  }

  function dragRect(startClient, endClient, origin) {
    const start = clientToScreen(startClient, origin);
    const end = clientToScreen(endClient, origin);
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(start.x - end.x),
      height: Math.abs(start.y - end.y)
    };
  }

  function clampRect(rect, bounds) {
    if (!bounds) {
      return rect;
    }
    const left = Math.max(bounds.x, rect.x);
    const top = Math.max(bounds.y, rect.y);
    const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
    const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(right - left)),
      height: Math.max(0, Math.round(bottom - top))
    };
  }

  return {
    CLICK_DISTANCE,
    isClick,
    clientToScreen,
    dragRect,
    clampRect
  };
});
