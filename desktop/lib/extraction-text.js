function getBlockMetric(block, key) {
  return Number(block?.bbox?.[key]) || 0;
}

function isSameRow(left, right) {
  const leftHeight = Math.max(1, getBlockMetric(left, 'height'));
  const rightHeight = Math.max(1, getBlockMetric(right, 'height'));
  const rowThreshold = Math.max(12, Math.min(leftHeight, rightHeight) * 0.45);
  return Math.abs(getBlockMetric(left, 'y') - getBlockMetric(right, 'y')) <= rowThreshold;
}

function compareBlocksByPosition(left, right) {
  if (isSameRow(left, right)) {
    const xDiff = getBlockMetric(left, 'x') - getBlockMetric(right, 'x');
    if (xDiff !== 0) {
      return xDiff;
    }
  }

  const yDiff = getBlockMetric(left, 'y') - getBlockMetric(right, 'y');
  if (yDiff !== 0) {
    return yDiff;
  }

  return getBlockMetric(left, 'x') - getBlockMetric(right, 'x');
}

function normalizeBlockText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildExtractedText(blocks, resolveText = (block) => block.text) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return '';
  }

  return blocks
    .slice()
    .sort(compareBlocksByPosition)
    .map((block) => normalizeBlockText(resolveText(block)))
    .filter(Boolean)
    .join('\n')
    .trim();
}

module.exports = {
  buildExtractedText,
  compareBlocksByPosition
};
