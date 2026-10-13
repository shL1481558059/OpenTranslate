const selectionEl = document.getElementById('selection');
const hintEl = document.getElementById('hint');
const maskSvg = document.getElementById('mask');
const maskShade = document.getElementById('mask-shade');
const maskOutlineGroup = document.getElementById('mask-outline');
const MIN_WINDOW_SIZE = 40;
const CLICK_DISTANCE = 6;
const hoverOutlineRect = createSvgRect(
  { x: 0, y: 0, width: 0, height: 0 },
  {
    fill: 'none',
    stroke: '#171717',
    'stroke-width': '1',
    'stroke-dasharray': '6 4',
    visibility: 'hidden'
  }
);
let startClient = null;
let startScreen = null;
let hoveredWindow = null;
let pendingPointer = null;
let moveFrameId = 0;
let displayBounds = {
  x: window.screenX || 0,
  y: window.screenY || 0,
  width: window.innerWidth || 0,
  height: window.innerHeight || 0
};
let webviewOrigin = {
  x: Number.isFinite(window.screenX) ? window.screenX : 0,
  y: Number.isFinite(window.screenY) ? window.screenY : 0
};
let pageScale = 1;
let deviceSize = { width: 0, height: 0 };
let activePointer = null;
let lastClient = null;
let windowRects = [];
const baseHint = '拖拽框选，单击整窗。按 ESC 取消。';

function toFiniteNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function toWindowRect(win) {
  return {
    id: win?.id,
    x: toFiniteNumber(win?.x),
    y: toFiniteNumber(win?.y),
    width: toFiniteNumber(win?.width),
    height: toFiniteNumber(win?.height)
  };
}

function isPointInsideRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function getClientPoint(pointer) {
  return {
    x: pointer.clientX,
    y: pointer.clientY
  };
}

function resetPointerFrame() {
  if (moveFrameId) {
    window.cancelAnimationFrame(moveFrameId);
    moveFrameId = 0;
  }
  pendingPointer = null;
}

function setHint(extra, isWarning = false) {
  if (!hintEl) return;
  hintEl.textContent = extra ? `${baseHint} ${extra}` : baseHint;
  hintEl.classList.toggle('hint-warning', Boolean(isWarning));
}

function resizeMask() {
  if (!maskSvg || !maskShade) {
    return;
  }
  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  maskSvg.setAttribute('width', `${width}`);
  maskSvg.setAttribute('height', `${height}`);
  maskSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

function currentScale() {
  return window.selectionGeometry.pointerScale(
    deviceSize.width,
    window.innerWidth,
    window.devicePixelRatio,
    pageScale
  );
}

function toClientRect(rect) {
  if (!rect) return null;
  const scale = currentScale();
  return {
    x: (rect.x - webviewOrigin.x) / scale,
    y: (rect.y - webviewOrigin.y) / scale,
    width: rect.width / scale,
    height: rect.height / scale
  };
}

function clearGroup(group) {
  if (!group) return;
  while (group.firstChild) {
    group.removeChild(group.firstChild);
  }
}

function createSvgRect(rect, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  el.setAttribute('x', `${rect.x}`);
  el.setAttribute('y', `${rect.y}`);
  el.setAttribute('width', `${rect.width}`);
  el.setAttribute('height', `${rect.height}`);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}

function updateSvgRect(el, rect) {
  if (!el || !rect) {
    return;
  }
  el.setAttribute('x', `${rect.x}`);
  el.setAttribute('y', `${rect.y}`);
  el.setAttribute('width', `${rect.width}`);
  el.setAttribute('height', `${rect.height}`);
}

function buildShadePath(rect) {
  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  const outerPath = `M0 0H${width}V${height}H0Z`;
  if (!rect) {
    return outerPath;
  }

  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(width, Math.round(rect.x + rect.width));
  const bottom = Math.min(height, Math.round(rect.y + rect.height));
  if (right <= x || bottom <= y) {
    return outerPath;
  }

  return `${outerPath} M${x} ${y}H${right}V${bottom}H${x}Z`;
}

function redrawMask() {
  const rect = hoveredWindow ? toClientRect(hoveredWindow) : null;
  const visible = rect && rect.width > 0 && rect.height > 0;
  const hoverRect = visible ? rect : null;

  if (maskShade) {
    maskShade.setAttribute('d', buildShadePath(hoverRect));
  }

  if (hoverRect) {
    updateSvgRect(hoverOutlineRect, hoverRect);
  }

  hoverOutlineRect.setAttribute('visibility', visible ? 'visible' : 'hidden');
}

function updateHover(screenPoint) {
  const target = hitTestWindow(screenPoint);
  if (target && (!hoveredWindow || hoveredWindow.id !== target.id)) {
    hoveredWindow = target;
    redrawMask();
    return;
  }
  if (!target && hoveredWindow) {
    hoveredWindow = null;
    redrawMask();
  }
}

function rebuildSnapEdges(windows) {
  windowRects = Array.isArray(windows)
    ? windows.map((win) => toWindowRect(win)).filter((win) => win.width >= MIN_WINDOW_SIZE && win.height >= MIN_WINDOW_SIZE)
    : [];
  resizeMask();
  redrawMask();
}

function hitTestWindow(point) {
  if (hoveredWindow && isPointInsideRect(point, hoveredWindow)) {
    return hoveredWindow;
  }

  // xcap lists the front window first. Scanning from the back made the
  // fullscreen desktop win every hit, so a click never landed on the window
  // under the pointer.
  for (let index = 0; index < windowRects.length; index += 1) {
    const win = windowRects[index];
    if (isPointInsideRect(point, win)) {
      return win;
    }
  }
  return null;
}

function toScreenPoint(pointer) {
  if (Number.isFinite(pointer?.clientX) && Number.isFinite(pointer?.clientY)) {
    return window.selectionGeometry.clientToScreen(getClientPoint(pointer), webviewOrigin, currentScale());
  }

  return {
    x: toFiniteNumber(pointer?.screenX),
    y: toFiniteNumber(pointer?.screenY)
  };
}

function renderRect(startPoint, endPoint) {
  const x = Math.min(startPoint.x, endPoint.x);
  const y = Math.min(startPoint.y, endPoint.y);
  const width = Math.abs(startPoint.x - endPoint.x);
  const height = Math.abs(startPoint.y - endPoint.y);

  selectionEl.style.display = 'block';
  selectionEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  selectionEl.style.width = `${width}px`;
  selectionEl.style.height = `${height}px`;
}

function getRenderedSelectionRect() {
  if (!selectionEl) {
    return null;
  }
  const bounds = selectionEl.getBoundingClientRect();
  const width = Math.max(0, Math.round(bounds.width));
  const height = Math.max(0, Math.round(bounds.height));
  if (!width || !height) {
    return null;
  }
  const scale = currentScale();
  return window.selectionGeometry.clampRect(
    {
      x: Math.round(webviewOrigin.x + bounds.left * scale),
      y: Math.round(webviewOrigin.y + bounds.top * scale),
      width: Math.round(width * scale),
      height: Math.round(height * scale)
    },
    displayBounds
  );
}

function processPointerMove(pointer) {
  const screenPoint = toScreenPoint(pointer);
  if (!startClient) {
    updateHover(screenPoint);
    return;
  }
  const endClient = getClientPoint(pointer);
  renderRect(startClient, endClient);
}

function flushPendingPointer() {
  const pointer = pendingPointer;
  pendingPointer = null;
  if (!pointer) {
    return;
  }
  processPointerMove(pointer);
}

function schedulePointerFrame() {
  if (moveFrameId) {
    return;
  }
  moveFrameId = window.requestAnimationFrame(() => {
    moveFrameId = 0;
    flushPendingPointer();
  });
}

function rememberPointer(event) {
  lastClient = getClientPoint(event);
  pendingPointer = {
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY
  };
}

async function finishSelection(endClient) {
  if (!startClient || !endClient) {
    startClient = null;
    startScreen = null;
    activePointer = null;
    return;
  }
  renderRect(startClient, endClient);
  const endScreen = window.selectionGeometry.clientToScreen(endClient, webviewOrigin, currentScale());
  let rect;

  if (window.selectionGeometry.isClick(startClient, endClient, CLICK_DISTANCE)) {
    const target = hitTestWindow(endScreen);
    if (target) {
      rect = {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        click: true,
        snapped: 'window',
        windowId: target.id
      };
    } else {
      rect = {
        x: endScreen.x,
        y: endScreen.y,
        width: 1,
        height: 1,
        click: true
      };
    }
  } else {
    rect = window.selectionGeometry.clampRect(
      window.selectionGeometry.dragRect(startClient, endClient, webviewOrigin, currentScale()),
      displayBounds
    );
  }
  startClient = null;
  startScreen = null;
  activePointer = null;
  lastClient = null;
  await window.snapTranslate.completeSelection(rect);
}

window.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) {
    return;
  }
  resetPointerFrame();
  if (hoveredWindow) {
    hoveredWindow = null;
    redrawMask();
  }
  activePointer = event.pointerId;
  try {
    event.target.setPointerCapture(event.pointerId);
  } catch {
    // capture is a best effort; pointerup on window still completes the drag
  }
  startClient = getClientPoint(event);
  startScreen = window.selectionGeometry.clientToScreen(startClient, webviewOrigin, currentScale());
  lastClient = startClient;
  renderRect(startClient, startClient);
});

window.addEventListener('pointermove', (event) => {
  if (activePointer !== null && event.pointerId !== activePointer) {
    return;
  }
  rememberPointer(event);
  schedulePointerFrame();
});

window.addEventListener('pointerup', async (event) => {
  if (activePointer !== null && event.pointerId !== activePointer) {
    return;
  }
  resetPointerFrame();
  await finishSelection(getClientPoint(event));
});

window.addEventListener('pointercancel', async (event) => {
  if (activePointer !== null && event.pointerId !== activePointer) {
    return;
  }
  resetPointerFrame();
  await finishSelection(lastClient);
});

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    await window.snapTranslate.cancelSelection();
  }
});

function getSelectionHint(payload) {
  if (payload?.requiresScreenRecording) {
    return {
      message: '需在系统设置 > 隐私与安全 > 屏幕录制中启用 OpenTranslate 才能识别窗口。',
      isWarning: true
    };
  }
  if (payload?.requiresAccessibility) {
    return {
      message: '需在系统设置 > 隐私与安全 > 辅助功能中启用 OpenTranslate 才能吸附窗口。',
      isWarning: true
    };
  }
  if (!payload?.windows || payload.windows.length === 0) {
    return {
      message: '未检测到可吸附窗口，已临时关闭吸附。',
      isWarning: true
    };
  }

  const count = Array.isArray(payload.windows) ? payload.windows.length : 0;
  if (count > 0) {
    return {
      message: `已检测到 ${count} 个窗口。`,
      isWarning: false
    };
  }

  return null;
}

if (window.snapTranslate?.onSelectionWindows) {
  window.snapTranslate.onSelectionWindows((payload) => {
    if (payload?.displayBounds) {
      displayBounds = payload.displayBounds;
    }
    if (Number.isFinite(payload?.scale) && payload.scale > 0) {
      pageScale = payload.scale;
    }
    if (Number.isFinite(payload?.webviewOrigin?.x) && Number.isFinite(payload?.webviewOrigin?.y)) {
      webviewOrigin = {
        x: payload.webviewOrigin.x,
        y: payload.webviewOrigin.y
      };
    }
    if (Number.isFinite(payload?.deviceWidth) && payload.deviceWidth > 1) {
      deviceSize = {
        width: payload.deviceWidth,
        height: Number.isFinite(payload?.deviceHeight) ? payload.deviceHeight : 0
      };
    }
    rebuildSnapEdges(payload?.windows || []);
    const nextHint = getSelectionHint(payload);
    if (nextHint) {
      setHint(nextHint.message, nextHint.isWarning);
    } else {
      setHint();
    }
  });
}

if (maskOutlineGroup && hoverOutlineRect.parentNode !== maskOutlineGroup) {
  clearGroup(maskOutlineGroup);
  maskOutlineGroup.appendChild(hoverOutlineRect);
}

resizeMask();
redrawMask();
rebuildSnapEdges([]);
window.addEventListener('resize', () => {
  const scale = currentScale();
  const width = Math.round((window.innerWidth || 0) * scale);
  const height = Math.round((window.innerHeight || 0) * scale);
  if (width > 0 && height > 0) {
    displayBounds = {
      ...displayBounds,
      width,
      height
    };
  }
  resizeMask();
  redrawMask();
});

setHint();
