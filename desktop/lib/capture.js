const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const KEEP_LAST = process.env.SNAP_TRANSLATE_KEEP_LAST === '1';
const DEBUG_IMAGE_PATH = process.env.SNAP_TRANSLATE_DEBUG_IMAGE_PATH;

async function captureRect(rect, scaleFactor = 1) {
  const imagePath = KEEP_LAST
    ? (DEBUG_IMAGE_PATH || path.join(os.tmpdir(), 'snap-translate-last.png'))
    : path.join(os.tmpdir(), `snap-translate-${Date.now()}.png`);
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
  const imagePath = KEEP_LAST
    ? (DEBUG_IMAGE_PATH || path.join(os.tmpdir(), 'snap-translate-last.png'))
    : path.join(os.tmpdir(), `snap-translate-full-${Date.now()}.png`);
  await execFileAsync('screencapture', ['-x', imagePath]);
  return imagePath;
}

module.exports = {
  captureRect,
  captureScreen,
  cleanupImage
};
