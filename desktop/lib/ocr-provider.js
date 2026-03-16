const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'vision_ocr.swift');
const DEBUG_OCR = process.env.SNAP_TRANSLATE_DEBUG_OCR === '1';

function normalizeVisionBBox(normalizedBBox, width, height) {
  const x = Math.max(0, Math.round(normalizedBBox.x * width));
  const w = Math.max(1, Math.round(normalizedBBox.width * width));

  const top = (1 - normalizedBBox.y - normalizedBBox.height) * height;
  const y = Math.max(0, Math.round(top));
  const h = Math.max(1, Math.round(normalizedBBox.height * height));

  return { x, y, width: w, height: h };
}

async function recognize(imagePath) {
  const { stdout } = await execFileAsync('xcrun', ['swift', SCRIPT_PATH, imagePath], {
    maxBuffer: 1024 * 1024 * 8
  });
  const parsed = JSON.parse(stdout);
  const imageWidth = Number(parsed.imageWidth || 1);
  const imageHeight = Number(parsed.imageHeight || 1);

  const blocks = (parsed.blocks || []).map((block, index) => ({
    id: block.id || `b${index + 1}`,
    text: block.text || '',
    lines: Array.isArray(block.lines) ? block.lines : [],
    bbox: normalizeVisionBBox(block.bbox, imageWidth, imageHeight)
  }));

  if (DEBUG_OCR) {
    console.warn('[ocr] result', {
      imageWidth,
      imageHeight,
      blocks: blocks.length
    });
  }

  return { blocks, imageWidth, imageHeight };
}

module.exports = {
  recognize
};
