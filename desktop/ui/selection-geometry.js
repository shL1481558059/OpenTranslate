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

  function scaleOf(scale) {
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  // CSS pixels become screen pixels by the window's real size, not by
  // devicePixelRatio. Fractional DPI, GDK_SCALE and a browser zoom can make
  // those two numbers disagree; the one that matches X11 is device/css.
  function pointerScale(deviceWidth, cssWidth, devicePixelRatio, pageScale) {
    const device = Number(deviceWidth);
    const css = Number(cssWidth);
    if (device > 1 && css > 1) {
      const ratio = device / css;
      if (ratio > 0.2 && ratio < 8) {
        return ratio;
      }
    }
    const dpr = Number(devicePixelRatio);
    if (Number.isFinite(dpr) && dpr > 1) {
      return dpr;
    }
    const page = Number(pageScale);
    if (Number.isFinite(page) && page > 0) {
      return page;
    }
    return 1;
  }

  function clientToScreen(client, origin, scale) {
    const factor = scaleOf(scale);
    return {
      x: Math.round(origin.x + client.x * factor),
      y: Math.round(origin.y + client.y * factor)
    };
  }

  function dragRect(startClient, endClient, origin, scale) {
    const start = clientToScreen(startClient, origin, scale);
    const end = clientToScreen(endClient, origin, scale);
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
    clampRect,
    scaleOf,
    pointerScale
  };
});
