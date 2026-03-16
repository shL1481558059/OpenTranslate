function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function mapBlocks(ocrBlocks, translatedItems) {
  const textById = new Map(translatedItems.map((item) => [item.id, item.translatedText || item.translated_text || '']));

  return ocrBlocks.map((block) => {
    const text = textById.get(block.id) || `${block.text} [翻译失败，可重试]`;
    const lineCount = Math.max(1, getLineCount(block));
    const lineHeight = 1.25;
    const baseLineHeight = block.bbox.height / lineCount;
    const minFontSize = 6;
    const fontSize = clamp(Math.floor((baseLineHeight / lineHeight) * 0.95), minFontSize, 36);
    const padding = clamp(Math.floor(fontSize * 0.15), 2, 8);

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
        background: 'transparent',
        color: '#ffffff',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)'
      }
    };
  });
}

module.exports = {
  mapBlocks
};
