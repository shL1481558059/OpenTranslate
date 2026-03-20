require('../load-env');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, nativeImage, Menu, Tray } = require('electron');

const APP_NAME = 'OpenTranslate';
app.setName(APP_NAME);
app.name = APP_NAME;

const { captureRect, captureScreen, cleanupImage } = require('./lib/capture');
const ocrProvider = require('./lib/ocr-provider');
const translationProvider = require('./lib/translation-provider');
const layoutEngine = require('./lib/layout-engine');
const { normalizeHotkey, hasModifierHotkey } = require('./lib/hotkey-rules');

const CAPTURE_DELAY_MS = Number(process.env.SNAP_TRANSLATE_CAPTURE_DELAY_MS || 280);
const DEFAULT_API_URL = process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8787/v1/translate';
const execFileAsync = promisify(execFile);

let selectionWindow = null;
let overlayWindow = null;
let lastSelectionDisplayId = null;
let overlayReadyPromise = null;
let translateWindow = null;
let settings = null;
const appIconPath = path.join(__dirname, 'assets', 'app-icon-apple.png');
const trayIconPath = path.join(__dirname, 'assets', 'tray-template-18.png');
const trayIconPath2x = path.join(__dirname, 'assets', 'tray-template-36.png');
let tray = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLang(value, fallback) {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

function applyApiDefaults(next) {
  const translationApiUrl =
    typeof next.translationApiUrl === 'string' && next.translationApiUrl.trim()
      ? next.translationApiUrl.trim()
      : DEFAULT_API_URL;
  return {
    ...next,
    translationApiUrl
  };
}

function getDefaultSettings() {
  const envEngine = String(process.env.DESKTOP_TRANSLATION_ENGINE || '').toLowerCase();
  const normalizedEngine = envEngine === 'llm' ? 'llm' : 'api';
  return applyApiDefaults({
    engine: normalizedEngine,
    sourceLang: normalizeLang(process.env.SOURCE_LANG || '', 'auto'),
    targetLang: normalizeLang(process.env.TARGET_LANG || '', 'zh-CN'),
    llmApiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1',
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
    hotkey: process.env.SNAP_TRANSLATE_HOTKEY || 'CommandOrControl+Shift+T'
  });
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function sanitizeSettings(input) {
  const next = {};
  if (!input || typeof input !== 'object') {
    return next;
  }
  if (typeof input.engine === 'string') {
    const engine = input.engine.toLowerCase();
    if (engine === 'llm' || engine === 'api') {
      next.engine = engine;
    }
  }
  if (typeof input.translationApiUrl === 'string') {
    next.translationApiUrl = input.translationApiUrl;
  }
  if (typeof input.llmApiUrl === 'string') {
    next.llmApiUrl = input.llmApiUrl;
  }
  if (typeof input.llmApiKey === 'string') {
    next.llmApiKey = input.llmApiKey;
  }
  if (typeof input.llmModel === 'string') {
    next.llmModel = input.llmModel;
  }
  if (typeof input.sourceLang === 'string') {
    next.sourceLang = normalizeLang(input.sourceLang, 'auto');
  }
  if (typeof input.targetLang === 'string') {
    next.targetLang = normalizeLang(input.targetLang, 'zh-CN');
  }
  if (typeof input.hotkey === 'string') {
    next.hotkey = input.hotkey;
  }
  return next;
}

function loadSettings() {
  const defaults = getDefaultSettings();
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return applyApiDefaults({ ...defaults, ...sanitizeSettings(parsed) });
  } catch {
    return defaults;
  }
}

function saveSettings(next) {
  settings = applyApiDefaults({ ...settings, ...sanitizeSettings(next) });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function registerHotkey(hotkey) {
  globalShortcut.unregisterAll();
  const normalized = normalizeHotkey(hotkey);
  if (!normalized) {
    return true;
  }
  if (!hasModifierHotkey(normalized)) {
    return false;
  }
  const ok = globalShortcut.register(normalized, () => {
    if (selectionWindow) {
      return;
    }
    createSelectionWindow();
  });
  return ok;
}

function updateHotkey(nextHotkey) {
  const trimmed = normalizeHotkey(nextHotkey);
  if (!trimmed) {
    const ok = registerHotkey('');
    if (!ok) {
      return { ok: false, error: 'hotkey_register_failed' };
    }
    saveSettings({ hotkey: '' });
    return { ok: true, cleared: true };
  }
  if (!hasModifierHotkey(trimmed)) {
    return { ok: false, error: 'hotkey_requires_modifier' };
  }
  const previous = settings?.hotkey;
  const ok = registerHotkey(trimmed);
  if (!ok) {
    if (previous !== undefined) {
      registerHotkey(previous);
    }
    return { ok: false, error: 'hotkey_register_failed' };
  }
  saveSettings({ hotkey: trimmed });
  return { ok: true };
}

function averageColorFromBitmap(bitmap, imageWidth, imageHeight, rect, grid = 8) {
  if (!bitmap || !imageWidth || !imageHeight || !rect) {
    return null;
  }
  const x = clamp(Math.floor(rect.x), 0, imageWidth - 1);
  const y = clamp(Math.floor(rect.y), 0, imageHeight - 1);
  const width = clamp(Math.floor(rect.width), 1, imageWidth - x);
  const height = clamp(Math.floor(rect.height), 1, imageHeight - y);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const stepsX = clamp(grid, 2, 12);
  const stepsY = clamp(grid, 2, 12);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let iy = 0; iy < stepsY; iy += 1) {
    const py = y + Math.floor(((iy + 0.5) / stepsY) * height);
    for (let ix = 0; ix < stepsX; ix += 1) {
      const px = x + Math.floor(((ix + 0.5) / stepsX) * width);
      const idx = (py * imageWidth + px) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const alpha = bitmap[idx + 3];
      if (alpha === 0) {
        continue;
      }
      r += red;
      g += green;
      b += blue;
      count += 1;
    }
  }

  if (!count) {
    return null;
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count)
  };
}

function colorToCss(color) {
  if (!color) return null;
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function textColorForBackground(color) {
  if (!color) return '#ffffff';
  const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  return luminance > 0.6 ? '#111111' : '#ffffff';
}

function sampleOverlayColors(imagePath, mapRectToImage, selectionRect, blocks) {
  if (!imagePath || !mapRectToImage) {
    return null;
  }
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) {
    return null;
  }
  const size = image.getSize();
  const imageWidth = size.width;
  const imageHeight = size.height;
  if (!imageWidth || !imageHeight) {
    return null;
  }
  const bitmap = image.toBitmap();

  const maskRect = mapRectToImage(selectionRect);
  const maskColor = averageColorFromBitmap(bitmap, imageWidth, imageHeight, maskRect, 8);

  const blockColors = new Map();
  for (const block of blocks || []) {
    const rect = mapRectToImage(block.bbox);
    const color = averageColorFromBitmap(bitmap, imageWidth, imageHeight, rect, 6);
    if (color) {
      blockColors.set(block.id, color);
    }
  }

  return { maskColor, blockColors };
}

function buildCaptureAttempts(rect, display) {
  const bounds = display.bounds;
  const relY = rect.y - bounds.y;
  const flippedY = bounds.y + bounds.height - relY - rect.height;
  const base = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
  const flipped = { ...base, y: flippedY };
  const scale = display.scaleFactor || 1;

  return [
    { name: 'points', rect: base, scaleFactor: 1 },
    { name: 'points_flipy', rect: flipped, scaleFactor: 1 },
    { name: 'scale', rect: base, scaleFactor: scale },
    { name: 'scale_flipy', rect: flipped, scaleFactor: scale }
  ];
}

function getVirtualBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return screen.getPrimaryDisplay().bounds;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function configureOverlayWindow(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function configureSelectionWindow(win) {
  configureOverlayWindow(win);
  win.setFullScreenable(true);
  win.setSimpleFullScreen(true);
}

function resolveWindowListScriptPath() {
  const local = path.join(__dirname, 'scripts', 'window_list.swift');
  if (!app || !app.isPackaged) {
    return local;
  }
  const unpacked = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'desktop',
    'scripts',
    'window_list.swift'
  );
  if (fs.existsSync(unpacked)) {
    return unpacked;
  }
  const resources = path.join(process.resourcesPath, 'desktop', 'scripts', 'window_list.swift');
  if (fs.existsSync(resources)) {
    return resources;
  }
  return local;
}

function resolveVisionRectsScriptPath() {
  const local = path.join(__dirname, 'scripts', 'vision_rects.swift');
  if (!app || !app.isPackaged) {
    return local;
  }
  const unpacked = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'desktop',
    'scripts',
    'vision_rects.swift'
  );
  if (fs.existsSync(unpacked)) {
    return unpacked;
  }
  const resources = path.join(process.resourcesPath, 'desktop', 'scripts', 'vision_rects.swift');
  if (fs.existsSync(resources)) {
    return resources;
  }
  return local;
}

function rectIntersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

async function listWindowBounds(display) {
  const scriptPath = resolveWindowListScriptPath();
  try {
    const { stdout } = await execFileAsync('xcrun', ['swift', scriptPath], {
      maxBuffer: 1024 * 1024 * 4
    });
    const parsed = JSON.parse(stdout);
    let windows = Array.isArray(parsed?.windows) ? parsed.windows : [];
    const requiresAccessibility = !!parsed?.requires_accessibility;
    const requiresScreenRecording = !!parsed?.requires_screen_recording;
    if (display?.bounds) {
      const bounds = display.bounds;
      windows = windows.filter((item) =>
        rectIntersects(
          {
            x: Number(item.x || 0),
            y: Number(item.y || 0),
            width: Number(item.width || 0),
            height: Number(item.height || 0)
          },
          bounds
        )
      );
    }
    return { windows, requiresAccessibility, requiresScreenRecording };
  } catch (error) {
    console.warn('[desktop] window list unavailable', error?.message || error);
    return { windows: [], requiresAccessibility: false, requiresScreenRecording: false };
  }
}

async function captureDisplayImage(display) {
  const scaleFactor = display?.scaleFactor || 1;
  const bounds = display?.bounds || { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.round(bounds.x * scaleFactor);
  const y = Math.round(bounds.y * scaleFactor);
  const width = Math.round(bounds.width * scaleFactor);
  const height = Math.round(bounds.height * scaleFactor);
  const imagePath = path.join(os.tmpdir(), `snap-translate-window-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  await execFileAsync('screencapture', ['-x', '-R', `${x},${y},${width},${height}`, imagePath]);
  return { imagePath, scaleFactor, bounds };
}

async function detectWindowRects(display) {
  const scriptPath = resolveVisionRectsScriptPath();
  let capture = null;
  try {
    capture = await captureDisplayImage(display);
    const { stdout } = await execFileAsync('xcrun', ['swift', scriptPath, capture.imagePath], {
      maxBuffer: 1024 * 1024 * 4
    });
    const parsed = JSON.parse(stdout);
    const rects = Array.isArray(parsed?.rects) ? parsed.rects : [];
    return rects
      .map((rect, index) => {
        const width = Number(rect.width || 0) / capture.scaleFactor;
        const height = Number(rect.height || 0) / capture.scaleFactor;
        return {
          id: rect.id || `vision-${index + 1}`,
          x: capture.bounds.x + Number(rect.x || 0) / capture.scaleFactor,
          y: capture.bounds.y + Number(rect.y || 0) / capture.scaleFactor,
          width,
          height
        };
      })
      .filter((rect) => rect.width > 120 && rect.height > 80);
  } catch (error) {
    console.warn('[desktop] vision window detect failed', error?.message || error);
    return [];
  } finally {
    if (capture?.imagePath) {
      await cleanupImage(capture.imagePath);
    }
  }
}

async function getSnapWindows(display) {
  const result = await listWindowBounds(display);
  if (result.windows.length) {
    return result;
  }
  const vision = await detectWindowRects(display);
  return {
    windows: vision,
    requiresAccessibility: result.requiresAccessibility,
    requiresScreenRecording: result.requiresScreenRecording
  };
}

async function renderOverlayMessage(rect, message, styleHint = {}, options = {}) {
  const win = await ensureOverlayWindowReady();
  win.setBounds({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  });
  win.showInactive();
  const baseSize = Math.max(12, Math.min(28, Math.floor(Math.min(rect.width, rect.height) * 0.06)));
  win.webContents.send('overlay:render', {
    rect,
    blocks: [
      {
        id: 'status',
        bbox: { x: 0, y: 0, width: rect.width, height: rect.height },
        text: message,
        styleHint: {
          fontSize: baseSize,
          lineHeight: 1.3,
          padding: Math.max(8, Math.floor(baseSize * 0.6)),
          background: 'transparent',
          color: '#ffffff',
          textShadow: '0 1px 2px rgba(0,0,0,0.6)',
          layout: 'center',
          ...styleHint
        }
      }
    ],
    hasText: false,
    mask: true,
    textOnly: true,
    maskOpacity: typeof options.maskOpacity === 'number' ? options.maskOpacity : 0.35
  });
}

function hideSelectionWindowForCapture() {
  if (!selectionWindow || selectionWindow.isDestroyed()) {
    return;
  }
  selectionWindow.setIgnoreMouseEvents(true);
  selectionWindow.setOpacity(0);
  selectionWindow.hide();
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  overlayWindow = new BrowserWindow({
    show: false,
    frame: false,
    hasShadow: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  configureOverlayWindow(overlayWindow);
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayReadyPromise = null;
  });
  overlayWindow.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
  return overlayWindow;
}

async function ensureOverlayWindowReady() {
  const win = ensureOverlayWindow();
  if (!overlayReadyPromise) {
    overlayReadyPromise = new Promise((resolve) => {
      if (win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', resolve);
      } else {
        resolve();
      }
    });
  }
  await overlayReadyPromise;
  return win;
}

function createSelectionWindow() {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  lastSelectionDisplayId = display.id;

  selectionWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: false,
    resizable: false,
    focusable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  configureSelectionWindow(selectionWindow);
  selectionWindow.loadFile(path.join(__dirname, 'ui', 'selection.html'));
  selectionWindow.webContents.once('did-finish-load', async () => {
    try {
      const { windows, requiresAccessibility, requiresScreenRecording } = await getSnapWindows(display);
      selectionWindow.webContents.send('selection:windows', {
        windows,
        displayBounds: display.bounds,
        requiresAccessibility,
        requiresScreenRecording
      });
    } catch {
      // ignore
    }
  });
  selectionWindow.once('ready-to-show', () => {
    if (!selectionWindow || selectionWindow.isDestroyed()) {
      return;
    }
    selectionWindow.show();
    selectionWindow.focus();
  });
  selectionWindow.on('closed', () => {
    selectionWindow = null;
  });
}

function closeSelectionWindow() {
  if (selectionWindow && !selectionWindow.isDestroyed()) {
    selectionWindow.close();
  }
  selectionWindow = null;
}

function ensureTranslateWindow() {
  if (translateWindow && !translateWindow.isDestroyed()) {
    return translateWindow;
  }
  translateWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    show: true,
    resizable: true,
    title: 'Manual Translate',
    frame: true,
    titleBarStyle: 'hidden',
    transparent: true,
    backgroundColor: '#00000000',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  translateWindow.on('closed', () => {
    translateWindow = null;
  });
  translateWindow.loadFile(path.join(__dirname, 'ui', 'translate.html'));
  return translateWindow;
}

function buildPageLoadOptions(options = {}) {
  if (!options || !options.nav) {
    return undefined;
  }
  return {
    query: {
      nav: String(options.nav)
    }
  };
}

function showTranslateWindow(options = {}) {
  const win = ensureTranslateWindow();
  win.loadFile(path.join(__dirname, 'ui', 'translate.html'), buildPageLoadOptions(options));
  win.show();
  win.focus();
}

function showSettingsWindow(options = {}) {
  const win = ensureTranslateWindow();
  win.loadFile(path.join(__dirname, 'ui', 'settings.html'), buildPageLoadOptions(options));
  win.show();
  win.focus();
}

function setupMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: 'Manual Translate…', click: showTranslateWindow },
        { label: 'Settings…', click: showSettingsWindow },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function ensureTray() {
  if (process.platform !== 'darwin') {
    return null;
  }
  if (tray) {
    return tray;
  }
  let icon = nativeImage.createFromPath(trayIconPath);
  const icon2x = nativeImage.createFromPath(trayIconPath2x);
  if (!icon.isEmpty() && !icon2x.isEmpty()) {
    icon.addRepresentation({
      scaleFactor: 2,
      width: icon2x.getSize().width,
      height: icon2x.getSize().height,
      buffer: icon2x.toPNG()
    });
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  const menu = Menu.buildFromTemplate([
    { label: 'Manual Translate…', click: showTranslateWindow },
    { label: 'Settings…', click: showSettingsWindow },
    { type: 'separator' },
    { role: 'quit' }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (translateWindow && translateWindow.isVisible()) {
      translateWindow.hide();
      return;
    }
    showTranslateWindow();
  });
  return tray;
}

async function runPipeline(rect) {
  const display = screen.getDisplayNearestPoint({ x: rect.x, y: rect.y }) || screen.getPrimaryDisplay();
  const displayBounds = display.bounds;
  const absoluteRect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };

  let imagePath;
  const keepLast = process.env.SNAP_TRANSLATE_KEEP_LAST === '1';
  const useFullCapture = process.env.SNAP_TRANSLATE_FULL_CAPTURE === '1';
  let overlayShown = false;
  let mapRectToImage = null;
  const showProgress = async () => {
    if (overlayShown) {
      return;
    }
    overlayShown = true;
    await renderOverlayMessage(absoluteRect, '翻译中…', {}, { maskOpacity: 0.35 });
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_DELAY_MS));
    let scaledBlocks = [];
    let imageWidth = 0;
    let imageHeight = 0;

    if (useFullCapture) {
      imagePath = await captureScreen();
      await showProgress();
      const ocrResult = await ocrProvider.recognize(imagePath);
      const blocks = ocrResult.blocks || [];
      imageWidth = Number(ocrResult.imageWidth || 1);
      imageHeight = Number(ocrResult.imageHeight || 1);
      const virtualBounds = getVirtualBounds();
      const scaleX = imageWidth > 0 ? imageWidth / Math.max(virtualBounds.width, 1) : display.scaleFactor || 1;
      const scaleY = imageHeight > 0 ? imageHeight / Math.max(virtualBounds.height, 1) : display.scaleFactor || 1;
      const cropX = Math.round((absoluteRect.x - virtualBounds.x) * scaleX);
      const cropY = Math.round((absoluteRect.y - virtualBounds.y) * scaleY);
      const cropW = Math.round(absoluteRect.width * scaleX);
      const cropH = Math.round(absoluteRect.height * scaleY);
      const cropRight = cropX + cropW;
      const cropBottom = cropY + cropH;
      mapRectToImage = (bbox) => ({
        x: Math.round(bbox.x * scaleX + cropX),
        y: Math.round(bbox.y * scaleY + cropY),
        width: Math.round(bbox.width * scaleX),
        height: Math.round(bbox.height * scaleY)
      });

      scaledBlocks = blocks
        .filter((block) => {
          const bx = block.bbox.x;
          const by = block.bbox.y;
          const bw = block.bbox.width;
          const bh = block.bbox.height;
          return bx + bw > cropX && by + bh > cropY && bx < cropRight && by < cropBottom;
        })
        .map((block) => ({
          ...block,
          bbox: {
            x: Math.max(0, Math.round((block.bbox.x - cropX) / scaleX)),
            y: Math.max(0, Math.round((block.bbox.y - cropY) / scaleY)),
            width: Math.round(block.bbox.width / scaleX),
            height: Math.round(block.bbox.height / scaleY)
          }
        }));

      console.warn('[capture] full', {
        imageWidth,
        imageHeight,
        virtualBounds,
        displayBounds,
        scaleX,
        scaleY,
        cropX,
        cropY,
        cropW,
        cropH,
        blocks: scaledBlocks.length
      });
    } else {
      const attempts = buildCaptureAttempts(absoluteRect, display);
      for (const attempt of attempts) {
        imagePath = await captureRect(attempt.rect, attempt.scaleFactor);
        await showProgress();
        const ocrResult = await ocrProvider.recognize(imagePath);
        const blocks = ocrResult.blocks || [];
        imageWidth = Number(ocrResult.imageWidth || 1);
        imageHeight = Number(ocrResult.imageHeight || 1);
        const scaleX = imageWidth > 0 ? imageWidth / Math.max(attempt.rect.width, 1) : display.scaleFactor || 1;
        const scaleY = imageHeight > 0 ? imageHeight / Math.max(attempt.rect.height, 1) : display.scaleFactor || 1;
        scaledBlocks = blocks.map((block) => ({
          ...block,
          bbox: {
            x: Math.round(block.bbox.x / scaleX),
            y: Math.round(block.bbox.y / scaleY),
            width: Math.round(block.bbox.width / scaleX),
            height: Math.round(block.bbox.height / scaleY)
          }
        }));
        if (scaledBlocks.length) {
          console.warn('[capture] matched', attempt.name, {
            rect: attempt.rect,
            scaleFactor: attempt.scaleFactor,
            imageWidth,
            imageHeight
          });
          mapRectToImage = (bbox) => ({
            x: Math.round(bbox.x * scaleX),
            y: Math.round(bbox.y * scaleY),
            width: Math.round(bbox.width * scaleX),
            height: Math.round(bbox.height * scaleY)
          });
          break;
        }
        if (imagePath && !keepLast) {
          await cleanupImage(imagePath);
        }
      }
    }

    if (!scaledBlocks.length) {
      console.warn('[ocr] no text detected', {
        imagePath,
        rect,
        imageWidth,
        imageHeight,
        displayBounds: display.bounds,
        displayScale: display.scaleFactor
      });
      await renderOverlayMessage(
        absoluteRect,
        '未识别到文本，请重新框选或换个区域试试。',
        { color: '#ffffff' },
        { maskOpacity: 0.88 }
      );
      return;
    }

    const sourceLang = settings?.sourceLang || 'auto';
    const targetLang = settings?.targetLang || 'zh-CN';
    const translatedItems = await translationProvider.translateBlocks(scaledBlocks, sourceLang, targetLang, settings);
    const renderBlocks = layoutEngine.mapBlocks(scaledBlocks, translatedItems);
    const sampled = sampleOverlayColors(imagePath, mapRectToImage, absoluteRect, scaledBlocks);
    if (sampled) {
      for (const block of renderBlocks) {
        const color = sampled.blockColors.get(block.id);
        if (!color) {
          continue;
        }
        block.styleHint.background = colorToCss(color);
        block.styleHint.color = textColorForBackground(color);
        block.styleHint.textShadow = 'none';
      }
    }

    const win = await ensureOverlayWindowReady();
    win.setBounds({
      x: absoluteRect.x,
      y: absoluteRect.y,
      width: absoluteRect.width,
      height: absoluteRect.height
    });
    win.showInactive();
    win.webContents.send('overlay:render', {
      rect: absoluteRect,
      blocks: renderBlocks,
      hasText: scaledBlocks.length > 0,
      mask: true,
      textOnly: true,
      maskOpacity: 1,
      maskColor: sampled?.maskColor ? colorToCss(sampled.maskColor) : undefined
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const isTimeout = message === 'timeout' || /aborted|timeout/i.test(message);
    const friendly = isTimeout
      ? '翻译超时，请稍后重试。'
      : `翻译失败，可重试\n${message}`;
    const win = await ensureOverlayWindowReady();
    win.setBounds({
      x: absoluteRect.x,
      y: absoluteRect.y,
      width: absoluteRect.width,
      height: absoluteRect.height
    });
    win.showInactive();
    win.webContents.send('overlay:render', {
      rect: absoluteRect,
      blocks: [
        {
          id: 'error',
          bbox: { x: 0, y: 0, width: absoluteRect.width, height: absoluteRect.height },
          text: friendly,
          styleHint: {
            fontSize: 18,
            lineHeight: 1.4,
            padding: 10,
            background: 'rgba(255,245,245,0.95)',
            color: '#8b0000'
          }
        }
      ],
      hasText: false
    });
  } finally {
    if (imagePath && !keepLast) {
      await cleanupImage(imagePath);
    }
  }
}

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  app.name = APP_NAME;
  if (process.platform === 'darwin') {
    const accessory = process.env.SNAP_TRANSLATE_ACCESSORY === '1';
    if (accessory) {
      if (app.dock && app.dock.hide) {
        app.dock.hide();
      }
      if (app.setActivationPolicy) {
        app.setActivationPolicy('accessory');
      }
    } else {
      if (app.setActivationPolicy) {
        app.setActivationPolicy('regular');
      }
      if (app.dock && app.dock.show) {
        app.dock.show();
      }
    }
    if (app.dock && app.dock.setIcon) {
      app.dock.setIcon(appIconPath);
    }
  }

  settings = loadSettings();
  setupMenu();
  ensureTray();

  const ok = registerHotkey(settings.hotkey);
  if (!settings.hotkey) {
    console.log('[desktop] hotkey disabled');
  } else if (!ok) {
    console.error(`[desktop] failed to register hotkey: ${settings.hotkey}`);
  } else {
    console.log(`[desktop] hotkey ready: ${settings.hotkey}`);
  }

  // Show a window on launch so the app isn't "invisible" to users.
  showTranslateWindow();

  ipcMain.handle('selection:cancel', () => {
    closeSelectionWindow();
  });

  ipcMain.handle('selection:complete', async (_, rect) => {
    if (!rect) {
      closeSelectionWindow();
      return;
    }
    let targetRect = rect;
    if (rect.click) {
      if (rect.snapped === 'window' && rect.width > 6 && rect.height > 6) {
        targetRect = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      } else {
        closeSelectionWindow();
        return;
      }
    } else if (rect.width < 6 || rect.height < 6) {
      closeSelectionWindow();
      return;
    }
    hideSelectionWindowForCapture();
    try {
      await runPipeline(targetRect);
    } finally {
      closeSelectionWindow();
    }
  });

  ipcMain.handle('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  });

  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:open', (_, options = {}) => {
    showSettingsWindow(options);
    return true;
  });

  ipcMain.handle('translate:open', (_, options = {}) => {
    showTranslateWindow(options);
    return true;
  });

  ipcMain.handle('settings:set', async (_, next) => {
    const payload = sanitizeSettings(next);
    let hotkeyError = null;
    if (Object.hasOwn(payload, 'hotkey') && payload.hotkey !== settings.hotkey) {
      const result = updateHotkey(payload.hotkey);
      if (!result.ok) {
        hotkeyError = result.error || 'hotkey_update_failed';
        delete payload.hotkey;
      }
    }
    saveSettings(payload);
    return { ok: !hotkeyError, error: hotkeyError, settings };
  });

  ipcMain.handle('hotkey:update', async (_, hotkey) => updateHotkey(hotkey));

  ipcMain.handle('translate:text', async (_, payload) => {
    const text = String(payload?.text || '').trim();
    if (!text) {
      return { ok: false, error: 'empty_text' };
    }
    try {
      const sourceLang = normalizeLang(payload?.sourceLang, settings?.sourceLang || 'auto');
      const targetLang = normalizeLang(payload?.targetLang, settings?.targetLang || 'zh-CN');
      const result = await translationProvider.translateText(text, sourceLang, targetLang, settings);
      return { ok: true, text: result.text, confidence: result.confidence };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });

  // window controls are handled by the system title bar

  app.on('activate', () => {
    if (!translateWindow) {
      showTranslateWindow();
      return;
    }
    translateWindow.show();
    translateWindow.focus();
  });
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
