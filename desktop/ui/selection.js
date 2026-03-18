const selectionEl = document.getElementById('selection');
const hintEl = document.getElementById('hint');
const maskSvg = document.getElementById('mask');
const maskDef = document.getElementById('mask-holes');
const maskBase = document.getElementById('mask-base');
const maskRect = document.getElementById('mask-rect');
const maskHolesGroup = document.getElementById('mask-holes-group');
const maskOutlineGroup = document.getElementById('mask-outline');
const SNAP_THRESHOLD = 12;
let startClient = null;
let startScreen = null;
let lastScreen = null;
let hoveredWindow = null;
let displayBounds = {
  x: window.screenX || 0,
  y: window.screenY || 0,
  width: window.innerWidth || 0,
  height: window.innerHeight || 0
};
let snapEdgesX = [];
let snapEdgesY = [];
let windowRects = [];
const baseHint = '拖拽框选，单击整窗。按 ESC 取消。';

function setHint(extra, isWarning = false) {
  if (!hintEl) return;
  hintEl.textContent = extra ? `${baseHint} ${extra}` : baseHint;
  hintEl.classList.toggle('hint-warning', Boolean(isWarning));
}

function resizeMask() {
  if (!maskSvg || !maskBase || !maskRect || !maskDef) {
    return;
  }
  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  maskSvg.setAttribute('width', `${width}`);
  maskSvg.setAttribute('height', `${height}`);
  maskSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  maskDef.setAttribute('width', `${width}`);
  maskDef.setAttribute('height', `${height}`);
  maskBase.setAttribute('width', `${width}`);
  maskBase.setAttribute('height', `${height}`);
  maskRect.setAttribute('width', `${width}`);
  maskRect.setAttribute('height', `${height}`);
}

function toClientRect(rect) {
  if (!rect) return null;
  return {
    x: rect.x - displayBounds.x,
    y: rect.y - displayBounds.y,
    width: rect.width,
    height: rect.height
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

function drawHoles() {
  if (!maskHolesGroup) {
    return;
  }
  clearGroup(maskHolesGroup);
  if (!hoveredWindow) {
    return;
  }
  const rect = toClientRect(hoveredWindow);
  if (!rect) {
    return;
  }
  maskHolesGroup.appendChild(
    createSvgRect(rect, { fill: 'black' })
  );
}

function drawOutline() {
  if (!maskOutlineGroup) {
    return;
  }
  clearGroup(maskOutlineGroup);
  if (!hoveredWindow) {
    return;
  }
  const rect = toClientRect(hoveredWindow);
  if (!rect) {
    return;
  }
  maskOutlineGroup.appendChild(
    createSvgRect(rect, {
      fill: 'none',
      stroke: 'rgba(0, 208, 132, 0.7)',
      'stroke-width': '1',
      'stroke-dasharray': '6 4'
    })
  );
}

function updateHover(screenPoint) {
  const target = hitTestWindow(screenPoint);
  if (target && (!hoveredWindow || hoveredWindow.id !== target.id)) {
    hoveredWindow = target;
    drawHoles();
    drawOutline();
    return;
  }
  if (!target && hoveredWindow) {
    hoveredWindow = null;
    drawHoles();
    drawOutline();
  }
}

function rebuildSnapEdges(windows) {
  const edgesX = [displayBounds.x, displayBounds.x + displayBounds.width];
  const edgesY = [displayBounds.y, displayBounds.y + displayBounds.height];
  windowRects = Array.isArray(windows) ? windows : [];
  for (const win of windowRects) {
    const x = Number(win.x || 0);
    const y = Number(win.y || 0);
    const width = Number(win.width || 0);
    const height = Number(win.height || 0);
    if (width < 40 || height < 40) {
      continue;
    }
    edgesX.push(x, x + width);
    edgesY.push(y, y + height);
  }
  snapEdgesX = edgesX;
  snapEdgesY = edgesY;
  resizeMask();
  drawHoles();
  drawOutline();
}

function nearestEdge(value, edges) {
  let best = value;
  let bestDist = SNAP_THRESHOLD + 1;
  for (const edge of edges) {
    const dist = Math.abs(edge - value);
    if (dist <= SNAP_THRESHOLD && dist < bestDist) {
      bestDist = dist;
      best = edge;
    }
  }
  return best;
}

function applySnap(point) {
  if (!snapEdgesX.length && !snapEdgesY.length) {
    return point;
  }
  return {
    x: nearestEdge(point.x, snapEdgesX),
    y: nearestEdge(point.y, snapEdgesY)
  };
}

function hitTestWindow(point) {
  for (const win of windowRects) {
    const x = Number(win.x || 0);
    const y = Number(win.y || 0);
    const width = Number(win.width || 0);
    const height = Number(win.height || 0);
    if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) {
      return { x, y, width, height, id: win.id };
    }
  }
  return null;
}

function toClient(point, fallback) {
  if (!displayBounds || !Number.isFinite(displayBounds.x)) {
    return fallback || point;
  }
  return {
    x: point.x - displayBounds.x,
    y: point.y - displayBounds.y
  };
}

function renderRect(startPoint, endPoint) {
  const x = Math.min(startPoint.x, endPoint.x);
  const y = Math.min(startPoint.y, endPoint.y);
  const width = Math.abs(startPoint.x - endPoint.x);
  const height = Math.abs(startPoint.y - endPoint.y);

  selectionEl.style.display = 'block';
  selectionEl.style.left = `${x}px`;
  selectionEl.style.top = `${y}px`;
  selectionEl.style.width = `${width}px`;
  selectionEl.style.height = `${height}px`;
}

window.addEventListener('mousedown', (event) => {
  const screenPoint = applySnap({ x: event.screenX, y: event.screenY });
  if (hoveredWindow) {
    hoveredWindow = null;
    drawHoles();
    drawOutline();
  }
  startScreen = screenPoint;
  startClient = toClient(screenPoint, { x: event.clientX, y: event.clientY });
  lastScreen = { ...startScreen };
  renderRect(startClient, startClient);
});

window.addEventListener('mousemove', (event) => {
  const snapped = applySnap({ x: event.screenX, y: event.screenY });
  if (!startClient) {
    updateHover(snapped);
    return;
  }
  lastScreen = snapped;
  const endClient = toClient(snapped, { x: event.clientX, y: event.clientY });
  renderRect(startClient, endClient);
});

window.addEventListener('mouseup', async (event) => {
  if (!startClient || !startScreen) {
    return;
  }
  const endScreen = lastScreen || applySnap({ x: event.screenX, y: event.screenY });
  const width = Math.abs(startScreen.x - endScreen.x);
  const height = Math.abs(startScreen.y - endScreen.y);
  let rect;

  if (width < 6 && height < 6) {
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
        x: startScreen.x,
        y: startScreen.y,
        width: 1,
        height: 1,
        click: true
      };
    }
  } else {
    rect = {
      x: Math.min(startScreen.x, endScreen.x),
      y: Math.min(startScreen.y, endScreen.y),
      width,
      height
    };
  }
  startClient = null;
  startScreen = null;
  lastScreen = null;
  await window.snapTranslate.completeSelection(rect);
});

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    await window.snapTranslate.cancelSelection();
  }
});

if (window.snapTranslate?.onSelectionWindows) {
  window.snapTranslate.onSelectionWindows((payload) => {
    if (payload?.displayBounds) {
      displayBounds = payload.displayBounds;
    }
    rebuildSnapEdges(payload?.windows || []);
    if (payload?.requiresScreenRecording) {
      setHint('需在系统设置 > 隐私与安全 > 屏幕录制中启用 OpenTranslate 才能识别窗口。', true);
    } else if (payload?.requiresAccessibility) {
      setHint('需在系统设置 > 隐私与安全 > 辅助功能中启用 OpenTranslate 才能吸附窗口。', true);
    } else if (!payload?.windows || payload.windows.length === 0) {
      setHint('未检测到可吸附窗口，已临时关闭吸附。', true);
    } else {
      const count = Array.isArray(payload?.windows) ? payload.windows.length : 0;
      if (count > 0) {
        setHint(`已检测到 ${count} 个窗口。`);
      } else {
        setHint();
      }
    }
  });
}

resizeMask();
drawHoles();
drawOutline();
rebuildSnapEdges([]);
window.addEventListener('resize', () => {
  resizeMask();
  drawHoles();
  drawOutline();
});

setHint();
