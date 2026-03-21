function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hasBlocks(ocrBlocks) {
  return Array.isArray(ocrBlocks) && ocrBlocks.length > 0;
}

function getSelectionMetric(selectionRect, key) {
  return Math.max(1, Number(selectionRect?.[key]) || 0);
}

function getBlockMetric(block, key) {
  return Number(block?.bbox?.[key]) || 0;
}

function getBlockArea(block) {
  const width = Math.max(1, getBlockMetric(block, 'width'));
  const height = Math.max(1, getBlockMetric(block, 'height'));
  return width * height;
}

function isCompactSelection(selectionRect) {
  if (!selectionRect) {
    return false;
  }
  const selectionHeight = getSelectionMetric(selectionRect, 'height');
  const selectionWidth = getSelectionMetric(selectionRect, 'width');
  return selectionHeight <= 180 || selectionWidth <= 220;
}

function isVeryCompactSelection(selectionRect) {
  if (!selectionRect) {
    return false;
  }
  const selectionHeight = getSelectionMetric(selectionRect, 'height');
  const selectionWidth = getSelectionMetric(selectionRect, 'width');
  return selectionHeight <= 140 || selectionWidth <= 160;
}

function getLineCount(block) {
  if (Array.isArray(block.lines) && block.lines.length) {
    return block.lines.length;
  }
  const text = String(block.text || '');
  if (!text) {
    return 1;
  }
  return text.split('\n').length || 1;
}

function getSignificantBlocks(ocrBlocks, selectionRect) {
  if (!hasBlocks(ocrBlocks) || !selectionRect) {
    return [];
  }
  const selectionWidth = getSelectionMetric(selectionRect, 'width');
  const blockAreas = ocrBlocks.map((block) => getBlockArea(block));
  const maxArea = Math.max(...blockAreas, 1);

  return ocrBlocks.filter((block, index) => {
    const width = Math.max(1, getBlockMetric(block, 'width'));
    const area = blockAreas[index];
    return width >= selectionWidth * 0.55 || area >= maxArea * 0.6;
  });
}

function getProbeBlocks(ocrBlocks, selectionRect) {
  const targetBlocks = getSignificantBlocks(ocrBlocks, selectionRect);
  return targetBlocks.length ? targetBlocks : ocrBlocks;
}

function getDominantAnchorY(ocrBlocks, selectionRect) {
  const probeBlocks = getProbeBlocks(ocrBlocks, selectionRect)
    .map((block) => ({
      y: Math.max(0, getBlockMetric(block, 'y')),
      area: getBlockArea(block)
    }))
    .sort((left, right) => left.y - right.y);

  if (!probeBlocks.length) {
    return 0;
  }

  const totalArea = probeBlocks.reduce((sum, block) => sum + block.area, 0);
  const threshold = Math.max(1, totalArea * 0.3);
  let consumedArea = 0;
  for (const block of probeBlocks) {
    consumedArea += block.area;
    if (consumedArea >= threshold) {
      return block.y;
    }
  }
  return probeBlocks[0].y;
}

function shouldUseCompactTopFlow(ocrBlocks, selectionRect) {
  if (!hasBlocks(ocrBlocks) || !selectionRect) {
    return false;
  }
  if (!isVeryCompactSelection(selectionRect)) {
    return false;
  }
  const selectionHeight = getSelectionMetric(selectionRect, 'height');
  const probeBlocks = getProbeBlocks(ocrBlocks, selectionRect);
  const overallMinY = Math.min(...ocrBlocks.map((block) => getBlockMetric(block, 'y')));
  const dominantAnchorY = getDominantAnchorY(ocrBlocks, selectionRect);
  const avgY = probeBlocks.reduce((sum, block) => sum + getBlockMetric(block, 'y'), 0) / probeBlocks.length;
  const dominantLow = dominantAnchorY >= selectionHeight * 0.28 && avgY >= selectionHeight * 0.48;
  const largeTopGap =
    dominantAnchorY >= selectionHeight * 0.24 &&
    dominantAnchorY - overallMinY >= Math.max(14, selectionHeight * 0.16);

  return dominantLow || largeTopGap;
}

function shouldReanchorBlocksToTop(ocrBlocks, selectionRect) {
  if (!hasBlocks(ocrBlocks) || !selectionRect) {
    return false;
  }
  if (!isCompactSelection(selectionRect) || shouldUseCompactTopFlow(ocrBlocks, selectionRect)) {
    return false;
  }

  const selectionHeight = getSelectionMetric(selectionRect, 'height');
  const probeBlocks = getProbeBlocks(ocrBlocks, selectionRect);
  const yValues = probeBlocks.map((block) => getBlockMetric(block, 'y'));
  const minY = Math.min(...yValues);
  const avgY = yValues.reduce((sum, value) => sum + value, 0) / yValues.length;

  return minY >= selectionHeight * 0.45 && avgY >= selectionHeight * 0.58;
}

function reanchorBlocksToTop(ocrBlocks, selectionRect) {
  if (!hasBlocks(ocrBlocks)) {
    return [];
  }
  const minY = getDominantAnchorY(ocrBlocks, selectionRect);
  return ocrBlocks.map((block) => ({
    ...block,
    bbox: {
      ...block.bbox,
      y: Math.max(0, getBlockMetric(block, 'y') - minY)
    }
  }));
}

function normalizeCompactText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function compareBlocksByPosition(left, right) {
  const yDiff = getBlockMetric(left, 'y') - getBlockMetric(right, 'y');
  if (yDiff !== 0) {
    return yDiff;
  }
  return getBlockMetric(left, 'x') - getBlockMetric(right, 'x');
}

function getTranslatedText(textById, block) {
  return textById.get(block.id) || `${block.text} [翻译失败，可重试]`;
}

function buildCompactMaskReplaceBlock(ocrBlocks, textById, selectionRect) {
  if (!hasBlocks(ocrBlocks) || !selectionRect) {
    return null;
  }
  const selectionWidth = getSelectionMetric(selectionRect, 'width');
  const selectionHeight = getSelectionMetric(selectionRect, 'height');
  const sourceBlocks = getProbeBlocks(ocrBlocks, selectionRect);
  const mergedText = sourceBlocks
    .slice()
    .sort(compareBlocksByPosition)
    .map((block) => normalizeCompactText(getTranslatedText(textById, block)))
    .filter(Boolean)
    .join('\n');

  if (!mergedText) {
    return null;
  }

  const lineCount = Math.max(1, mergedText.split('\n').length);
  const estimatedLineHeight = selectionHeight / Math.max(2.6, lineCount + 0.8);
  const fontSize = clamp(Math.floor(estimatedLineHeight * 0.82), 10, 24);
  const padding = clamp(Math.floor(fontSize * 0.5), 4, 10);

  return {
    id: 'compact-result',
    bbox: {
      x: 0,
      y: 0,
      width: selectionWidth,
      height: selectionHeight
    },
    text: mergedText,
    styleHint: {
      baseFontSize: fontSize,
      minFontSize: 8,
      fontSize,
      lineHeight: 1.22,
      padding,
      verticalOffset: 0,
      background: 'transparent',
      color: '#ffffff',
      textShadow: '0 1px 2px rgba(0,0,0,0.72)',
      layout: 'center',
      layoutMode: 'compact-mask-replace'
    }
  };
}

function mapBlocks(ocrBlocks, translatedItems, options = {}) {
  const items = Array.isArray(translatedItems) ? translatedItems : [];
  const textById = new Map(items.map((item) => [item.id, item.translatedText || item.translated_text || '']));
  if (shouldUseCompactTopFlow(ocrBlocks, options.selectionRect)) {
    const compactBlock = buildCompactMaskReplaceBlock(ocrBlocks, textById, options.selectionRect);
    if (compactBlock) {
      return [compactBlock];
    }
  }

  const normalizedBlocks = shouldReanchorBlocksToTop(ocrBlocks, options.selectionRect)
    ? reanchorBlocksToTop(ocrBlocks, options.selectionRect)
    : ocrBlocks;

  return normalizedBlocks.map((block) => {
    const text = getTranslatedText(textById, block);
    const lineCount = Math.max(1, getLineCount(block));
    const lineHeight = 1.1;
    const baseLineHeight = block.bbox.height / lineCount;
    const minFontSize = 6;
    const fontSize = clamp(Math.floor((baseLineHeight / lineHeight) * 0.92), minFontSize, 36);
    const padding = clamp(Math.floor(fontSize * 0.06), 0, 2);

    return {
      id: block.id,
      bbox: block.bbox,
      text,
      styleHint: {
        baseFontSize: fontSize,
        minFontSize,
        fontSize,
        lineHeight,
        padding,
        verticalOffset: Math.max(1, Math.round(fontSize * 0.12)),
        background: 'transparent',
        color: '#ffffff',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)',
        layoutMode: 'ocr'
      }
    };
  });
}

module.exports = {
  mapBlocks
};
