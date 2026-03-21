const root = document.getElementById('root');
const mask = document.getElementById('mask');
const snapshotEl = document.getElementById('snapshot');
const controlsEl = document.getElementById('controls');
const extractSourceBtn = document.getElementById('extractSource');
const extractTranslatedBtn = document.getElementById('extractTranslated');
const closeBtn = document.getElementById('close');
const ACTION_BUTTON_WIDTH = 82;
const CONTROL_PADDING = 4;
const CONTROL_GAP = 4;

const DEFAULT_BUTTON_LABELS = {
  source: {
    eyebrow: 'OCR',
    label: '原文',
    title: '复制原文',
    icon: {
      name: 'file',
      variant: 'solid'
    }
  },
  translated: {
    eyebrow: 'TR',
    label: '译文',
    title: '复制译文',
    icon: {
      name: 'copy',
      variant: 'regular'
    }
  }
};

const BUTTON_FEEDBACK_LABELS = {
  success: {
    eyebrow: 'OK',
    label: '已复制',
    icon: {
      name: 'check',
      variant: 'solid'
    },
    state: 'success'
  },
  error: {
    eyebrow: 'ERR',
    label: '复制失败',
    icon: {
      name: 'circle-xmark',
      variant: 'regular'
    },
    state: 'error'
  }
};

let ignoreMouseEvents = true;
let extractionState = {
  sourceText: '',
  translatedText: ''
};

function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeViewportRect(rect) {
  return {
    x: toFiniteNumber(rect?.x),
    y: toFiniteNumber(rect?.y),
    width: Math.max(0, Number(rect?.width) || 0),
    height: Math.max(0, Number(rect?.height) || 0)
  };
}

function applyViewportRect(el, rect) {
  if (!el) {
    return;
  }

  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

function resolveBaseFontSize(el, hint) {
  if (Number.isFinite(hint.baseFontSize)) {
    return hint.baseFontSize;
  }
  if (Number.isFinite(hint.fontSize)) {
    return hint.fontSize;
  }
  return parseFloat(getComputedStyle(el).fontSize) || 14;
}

function applyTextBlockStyle(el, hint, textOnly) {
  el.style.fontSize = `${hint.fontSize || 14}px`;
  el.style.lineHeight = String(hint.lineHeight || 1.35);
  el.style.padding = `${Number.isFinite(hint.padding) ? hint.padding : 0}px`;
  el.style.background = textOnly && !hint.background ? 'transparent' : hint.background || 'rgba(255,255,255,0.88)';
  el.style.overflow = 'hidden';
  el.style.color = hint.color || '#ffffff';
  el.style.display = 'flex';
  el.style.alignItems = 'flex-start';
  el.style.justifyContent = 'flex-start';
  el.style.textAlign = 'left';

  if (textOnly) {
    el.style.border = 'none';
    el.style.backdropFilter = 'none';
  }

  if (hint.textShadow) {
    el.style.textShadow = hint.textShadow;
  }

  if (hint.layout === 'center') {
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.textAlign = 'center';
    el.style.transform = 'none';
    return;
  }

  const offset = Number.isFinite(hint.verticalOffset) ? hint.verticalOffset : 1;
  el.style.transform = `translateY(-${offset}px)`;
}

function getOverlayMode(payload) {
  if (payload?.blocks?.length !== 1) {
    return 'result';
  }

  const blockId = payload.blocks[0]?.id;
  if (blockId === 'status') {
    return 'status';
  }
  if (blockId === 'error') {
    return 'error';
  }
  return 'result';
}

function isPointInsideBounds(pointX, pointY, bounds) {
  return pointX >= bounds.left && pointX <= bounds.right && pointY >= bounds.top && pointY <= bounds.bottom;
}

async function syncIgnoreMouseEvents(next) {
  if (ignoreMouseEvents === next) {
    return;
  }
  ignoreMouseEvents = next;
  try {
    await window.snapTranslate.setOverlayIgnoreMouseEvents(next);
  } catch {
    // ignore
  }
}

function applySelectionViewport(payload) {
  const rect = normalizeViewportRect(payload?.selectionRect || payload?.rect);
  applyViewportRect(mask, rect);
  applyViewportRect(snapshotEl, rect);
  applyViewportRect(root, rect);
}

function resetActionButton(button, kind) {
  if (!button) {
    return;
  }
  clearTimeout(button._feedbackTimer);
  applyActionButtonCopy(button, DEFAULT_BUTTON_LABELS[kind], 'idle');
}

function applyActionButtonCopy(button, content, state) {
  if (!button || !content) {
    return;
  }

  const eyebrowEl = button.querySelector('[data-role="eyebrow"]');
  const labelEl = button.querySelector('[data-role="label"]');
  const iconEl = button.querySelector('wa-icon');

  if (eyebrowEl) {
    eyebrowEl.textContent = content.eyebrow;
  }

  if (labelEl) {
    labelEl.textContent = content.label;
  }

  if (iconEl && content.icon) {
    iconEl.setAttribute('name', content.icon.name);
    iconEl.setAttribute('variant', content.icon.variant || 'solid');
    iconEl.setAttribute('library', content.icon.library || 'system');
  }

  if (content.title) {
    button.title = content.title;
    button.setAttribute('aria-label', content.title);
  }

  button.dataset.state = state;
}

function setActionButtonVisible(button, kind, visible) {
  if (!button) {
    return;
  }
  button.hidden = !visible;
  button.disabled = !visible;
  if (visible) {
    resetActionButton(button, kind);
  }
}

function applyExtractionState(payload) {
  extractionState = {
    sourceText: String(payload?.extraction?.sourceText || ''),
    translatedText: String(payload?.extraction?.translatedText || '')
  };

  setActionButtonVisible(extractSourceBtn, 'source', Boolean(extractionState.sourceText));
  setActionButtonVisible(extractTranslatedBtn, 'translated', Boolean(extractionState.translatedText));
}

function getVisibleControlButtons() {
  return [extractSourceBtn, extractTranslatedBtn, closeBtn].filter((button) => button && !button.hidden);
}

function getControlButtonWidth(button) {
  if (!button) {
    return 0;
  }

  // Keep the first-paint toolbar size stable before styles/fonts fully settle.
  const measuredWidth = Math.ceil(button.getBoundingClientRect().width || button.offsetWidth || 0);
  const fallbackWidth = ACTION_BUTTON_WIDTH;
  return Math.max(measuredWidth, fallbackWidth);
}

function measureControlsWidth() {
  if (!controlsEl) {
    return 0;
  }

  const styles = getComputedStyle(controlsEl);
  const gap = parseFloat(styles.gap || styles.columnGap || '0') || CONTROL_GAP;
  const paddingLeft = parseFloat(styles.paddingLeft || '0') || CONTROL_PADDING;
  const paddingRight = parseFloat(styles.paddingRight || '0') || CONTROL_PADDING;
  const buttons = getVisibleControlButtons();
  const buttonWidth = buttons.reduce((sum, button) => sum + getControlButtonWidth(button), 0);

  return Math.ceil(paddingLeft + paddingRight + buttonWidth + gap * Math.max(0, buttons.length - 1));
}

function applyControlViewport(payload) {
  if (!controlsEl) {
    return;
  }

  const rect = payload?.controlRect;
  if (!rect) {
    controlsEl.style.display = 'none';
    return;
  }

  const controlRect = normalizeViewportRect(rect);
  controlsEl.style.display = 'flex';
  controlsEl.style.height = `${controlRect.height}px`;

  const width = measureControlsWidth();
  controlsEl.style.width = `${width}px`;
  controlsEl.style.left = `${controlRect.x + controlRect.width - width}px`;
  controlsEl.style.top = `${controlRect.y}px`;
}

function applySnapshot(payload) {
  if (!snapshotEl) {
    return;
  }
  if (!payload?.snapshotDataUrl) {
    snapshotEl.style.display = 'none';
    snapshotEl.removeAttribute('src');
    return;
  }
  snapshotEl.style.display = 'block';
  if (snapshotEl.getAttribute('src') !== payload.snapshotDataUrl) {
    snapshotEl.setAttribute('src', payload.snapshotDataUrl);
  }
}

function fitTextToBox(el, bbox, hint) {
  if (!el || !bbox) {
    return;
  }
  const targetWidth = Math.max(0, Number(bbox.width) || 0);
  const targetHeight = Math.max(0, Number(bbox.height) || 0);
  if (!targetWidth || !targetHeight) {
    return;
  }

  const baseFontSize = resolveBaseFontSize(el, hint);
  const minFontSize = Number.isFinite(hint.minFontSize) ? hint.minFontSize : 6;
  const basePadding = Number.isFinite(hint.padding) ? hint.padding : 0;
  const baseLineHeight = Number.isFinite(hint.lineHeight) ? hint.lineHeight : 1.35;

  const applySize = (size) => {
    const ratio = baseFontSize ? size / baseFontSize : 1;
    const padding = Math.max(0, Math.round(basePadding * ratio));
    const lineHeight = Math.max(1, baseLineHeight * Math.max(ratio, 0.92));
    el.style.fontSize = `${size}px`;
    el.style.padding = `${padding}px`;
    el.style.lineHeight = String(lineHeight);
  };

  const fits = () => el.scrollWidth <= el.clientWidth + 0.5 && el.scrollHeight <= el.clientHeight + 0.5;

  applySize(baseFontSize);
  if (fits()) {
    return;
  }

  let low = minFontSize;
  let high = Math.max(minFontSize, Math.floor(baseFontSize));
  let best = minFontSize;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    applySize(mid);
    if (fits()) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  applySize(best);
  if (!fits()) {
    el.style.overflow = 'hidden';
  }
}

function renderBlocks(payload) {
  root.innerHTML = '';
  applySelectionViewport(payload);
  applySnapshot(payload);
  applyExtractionState(payload);
  applyControlViewport(payload);
  void syncIgnoreMouseEvents(true);

  if (mask) {
    mask.style.display = payload && payload.mask === false ? 'none' : 'block';
    if (payload?.maskColor) {
      mask.style.background = payload.maskColor;
    } else {
      mask.style.background = `rgba(0, 0, 0, ${getMaskOpacity(payload)})`;
    }
  }
  const textOnly = payload && payload.textOnly === true;
  for (const block of payload.blocks) {
    const el = document.createElement('div');
    el.className = 'block';
    el.textContent = block.text;

    el.style.left = `${block.bbox.x}px`;
    el.style.top = `${block.bbox.y}px`;
    el.style.width = `${block.bbox.width}px`;
    el.style.height = `${block.bbox.height}px`;

    const hint = block.styleHint || {};
    applyTextBlockStyle(el, hint, textOnly);

    root.appendChild(el);
    fitTextToBox(el, block.bbox, hint);
  }

  window.requestAnimationFrame(() => {
    reportOverlayMetrics(payload);
  });
}

function getMaskOpacity(payload) {
  return typeof payload?.maskOpacity === 'number' ? payload.maskOpacity : 0.35;
}

function reportOverlayMetrics(payload) {
  if (!window.snapTranslate?.reportOverlayMetrics || !root) {
    return;
  }
  const rootRect = root.getBoundingClientRect();
  const maskRect = mask?.getBoundingClientRect?.() || null;
  const blocks = Array.from(root.querySelectorAll('.block')).slice(0, 3).map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      text: (el.textContent || '').slice(0, 40),
      declaredTop: parseFloat(el.style.top || '0') || 0,
      declaredLeft: parseFloat(el.style.left || '0') || 0,
      actualTop: Math.round(rect.top - rootRect.top),
      actualLeft: Math.round(rect.left - rootRect.left),
      actualWidth: Math.round(rect.width),
      actualHeight: Math.round(rect.height),
      fontSize: parseFloat(el.style.fontSize || '0') || 0,
      lineHeight: parseFloat(el.style.lineHeight || '0') || 0,
      paddingTop: parseFloat(getComputedStyle(el).paddingTop || '0') || 0
    };
  });

  window.snapTranslate.reportOverlayMetrics({
    mode: getOverlayMode(payload),
    selectionRect: payload?.selectionRect || null,
    overlayBounds: payload?.overlayBounds || null,
    rootRect: {
      top: Math.round(rootRect.top),
      left: Math.round(rootRect.left),
      width: Math.round(rootRect.width),
      height: Math.round(rootRect.height)
    },
    maskRect: maskRect
      ? {
          top: Math.round(maskRect.top),
          left: Math.round(maskRect.left),
          width: Math.round(maskRect.width),
          height: Math.round(maskRect.height)
        }
      : null,
    blocks
  });
}

function flashActionFeedback(button, kind, status) {
  if (!button) {
    return;
  }
  clearTimeout(button._feedbackTimer);
  applyActionButtonCopy(button, BUTTON_FEEDBACK_LABELS[status], BUTTON_FEEDBACK_LABELS[status].state);
  button._feedbackTimer = window.setTimeout(() => {
    if (!button.hidden) {
      resetActionButton(button, kind);
    }
  }, 1200);
}

async function copyExtractionText(kind) {
  const text = kind === 'source' ? extractionState.sourceText : extractionState.translatedText;
  const button = kind === 'source' ? extractSourceBtn : extractTranslatedBtn;

  if (!text || !button || !window.snapTranslate?.writeClipboardText) {
    return;
  }

  try {
    const copied = await window.snapTranslate.writeClipboardText(text);
    flashActionFeedback(button, kind, copied ? 'success' : 'error');
  } catch {
    flashActionFeedback(button, kind, 'error');
  }
}

window.snapTranslate.onOverlayRender((payload) => {
  renderBlocks(payload);
});

closeBtn.addEventListener('click', async () => {
  await window.snapTranslate.closeOverlay();
});

extractSourceBtn.addEventListener('click', async () => {
  await copyExtractionText('source');
});

extractTranslatedBtn.addEventListener('click', async () => {
  await copyExtractionText('translated');
});

window.addEventListener('mousemove', (event) => {
  if (!controlsEl || controlsEl.style.display === 'none') {
    void syncIgnoreMouseEvents(true);
    return;
  }
  const bounds = controlsEl.getBoundingClientRect();
  const hovering = isPointInsideBounds(event.clientX, event.clientY, bounds);
  void syncIgnoreMouseEvents(!hovering);
});

window.addEventListener('mouseleave', () => {
  void syncIgnoreMouseEvents(true);
});

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    await window.snapTranslate.closeOverlay();
  }
});
