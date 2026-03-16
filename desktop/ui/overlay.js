const root = document.getElementById('root');
const mask = document.getElementById('mask');
const closeBtn = document.getElementById('close');

function fitTextToBox(el, bbox, hint) {
  if (!el || !bbox) {
    return;
  }
  const targetWidth = Math.max(0, Number(bbox.width) || 0);
  const targetHeight = Math.max(0, Number(bbox.height) || 0);
  if (!targetWidth || !targetHeight) {
    return;
  }

  const baseFontSize = Number.isFinite(hint.baseFontSize)
    ? hint.baseFontSize
    : Number.isFinite(hint.fontSize)
      ? hint.fontSize
      : parseFloat(getComputedStyle(el).fontSize) || 14;
  const minFontSize = Number.isFinite(hint.minFontSize) ? hint.minFontSize : 6;
  const basePadding = Number.isFinite(hint.padding) ? hint.padding : 4;
  const baseLineHeight = Number.isFinite(hint.lineHeight) ? hint.lineHeight : 1.35;

  const applySize = (size) => {
    const ratio = baseFontSize ? size / baseFontSize : 1;
    const padding = Math.max(1, Math.round(basePadding * ratio));
    const lineHeight = Math.max(1.1, baseLineHeight * ratio);
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
    el.style.overflow = 'visible';
    el.style.height = 'auto';
  }
}

function renderBlocks(payload) {
  root.innerHTML = '';
  if (mask) {
    mask.style.display = payload && payload.mask === false ? 'none' : 'block';
    if (payload?.maskColor) {
      mask.style.background = payload.maskColor;
    } else {
      const opacity = typeof payload?.maskOpacity === 'number' ? payload.maskOpacity : 0.35;
      mask.style.background = `rgba(0, 0, 0, ${opacity})`;
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
    el.style.fontSize = `${hint.fontSize || 14}px`;
    el.style.lineHeight = String(hint.lineHeight || 1.35);
    el.style.padding = `${hint.padding || 4}px`;
    const background = hint.background || 'rgba(255,255,255,0.88)';
    if (textOnly && !hint.background) {
      el.style.background = 'transparent';
    } else {
      el.style.background = background;
    }
    if (textOnly) {
      el.style.border = 'none';
      el.style.backdropFilter = 'none';
    }
    el.style.color = hint.color || '#ffffff';
    if (hint.textShadow) {
      el.style.textShadow = hint.textShadow;
    }
    if (hint.layout === 'center') {
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.textAlign = 'center';
    }

    root.appendChild(el);
    fitTextToBox(el, block.bbox, hint);
  }
}

window.snapTranslate.onOverlayRender((payload) => {
  renderBlocks(payload);
});

closeBtn.addEventListener('click', async () => {
  await window.snapTranslate.closeOverlay();
});

window.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    await window.snapTranslate.closeOverlay();
  }
});
