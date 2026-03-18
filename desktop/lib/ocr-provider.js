const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app } = require('electron');

const execFileAsync = promisify(execFile);
const DEBUG_OCR = process.env.SNAP_TRANSLATE_DEBUG_OCR === '1';

function resolveScriptPath() {
  const local = path.join(__dirname, '..', 'scripts', 'vision_ocr.swift');
  if (!app || !app.isPackaged) {
    return local;
  }
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop', 'scripts', 'vision_ocr.swift'),
    path.join(process.resourcesPath, 'desktop', 'scripts', 'vision_ocr.swift'),
    local
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return local;
}

function normalizeVisionBBox(normalizedBBox, width, height) {
  const x = Math.max(0, Math.round(normalizedBBox.x * width));
  const w = Math.max(1, Math.round(normalizedBBox.width * width));

  const top = (1 - normalizedBBox.y - normalizedBBox.height) * height;
  const y = Math.max(0, Math.round(top));
  const h = Math.max(1, Math.round(normalizedBBox.height * height));

  return { x, y, width: w, height: h };
}

async function recognize(imagePath) {
  const scriptPath = resolveScriptPath();
  const { stdout } = await execFileAsync('xcrun', ['swift', scriptPath, imagePath], {
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
