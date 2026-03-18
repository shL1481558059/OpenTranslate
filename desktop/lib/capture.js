const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const KEEP_LAST = process.env.SNAP_TRANSLATE_KEEP_LAST === '1';
const DEBUG_IMAGE_PATH = process.env.SNAP_TRANSLATE_DEBUG_IMAGE_PATH;

function resolveImagePath(prefix) {
  if (KEEP_LAST) {
    return DEBUG_IMAGE_PATH || path.join(os.tmpdir(), 'snap-translate-last.png');
  }
  const stamp = Date.now();
  const filename = prefix
    ? `snap-translate-${prefix}-${stamp}.png`
    : `snap-translate-${stamp}.png`;
  return path.join(os.tmpdir(), filename);
}

async function captureRect(rect, scaleFactor = 1) {
  const imagePath = resolveImagePath();
  const x = Math.round(rect.x * scaleFactor);
  const y = Math.round(rect.y * scaleFactor);
  const width = Math.round(rect.width * scaleFactor);
  const height = Math.round(rect.height * scaleFactor);

  await execFileAsync('screencapture', ['-x', '-R', `${x},${y},${width},${height}`, imagePath]);
  return imagePath;
}

async function cleanupImage(imagePath) {
  try {
    await fs.unlink(imagePath);
  } catch {
    // ignore temp cleanup errors
  }
}

async function captureScreen() {
  const imagePath = resolveImagePath('full');
  await execFileAsync('screencapture', ['-x', imagePath]);
  return imagePath;
}

module.exports = {
  captureRect,
  captureScreen,
  cleanupImage
};
