require('../load-env');

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, nativeImage, Menu } = require('electron');

const { captureRect, captureScreen, cleanupImage } = require('./lib/capture');
const ocrProvider = require('./lib/ocr-provider');
const translationProvider = require('./lib/translation-provider');
const layoutEngine = require('./lib/layout-engine');

const CAPTURE_DELAY_MS = Number(process.env.SNAP_TRANSLATE_CAPTURE_DELAY_MS || 280);

let selectionWindow = null;
let overlayWindow = null;
let lastSelectionDisplayId = null;
let overlayReadyPromise = null;
let translateWindow = null;
let settingsWindow = null;
let settings = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDefaultSettings() {
  const envEngine = String(process.env.DESKTOP_TRANSLATION_ENGINE || '').toLowerCase();
  return {
    engine: envEngine === 'llm' ? 'llm' : 'api',
    translationApiUrl: process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8787/v1/translate',
    llmApiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1',
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
    hotkey: process.env.SNAP_TRANSLATE_HOTKEY || 'CommandOrControl+Shift+T'
  };
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
    return { ...defaults, ...sanitizeSettings(parsed) };
  } catch {
    return defaults;
  }
}

function saveSettings(next) {
  settings = { ...settings, ...sanitizeSettings(next) };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function registerHotkey(hotkey) {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hotkey, () => {
    if (selectionWindow) {
      return;
    }
    createSelectionWindow();
  });
  return ok;
}

function updateHotkey(nextHotkey) {
  const trimmed = String(nextHotkey || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'invalid_hotkey' };
  }
  const previous = settings?.hotkey;
  const ok = registerHotkey(trimmed);
  if (!ok) {
    if (previous) {
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
    show: true,
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
    width: 640,
    height: 520,
    show: true,
    resizable: true,
    title: 'Manual Translate',
    frame: true,
    titleBarStyle: 'hiddenInset',
    transparent: true,
    backgroundColor: '#00000000',
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

function ensureSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 560,
    show: true,
    resizable: true,
    title: 'Settings',
    frame: true,
    titleBarStyle: 'hiddenInset',
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  return settingsWindow;
}

function showTranslateWindow() {
  const win = ensureTranslateWindow();
  win.show();
  win.focus();
}

function showSettingsWindow() {
  const win = ensureSettingsWindow();
  win.show();
  win.focus();
}

function setupMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: 'Manual Translate…', click: showTranslateWindow },
        { label: 'Settings…', click: showSettingsWindow },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

    const translatedItems = await translationProvider.translateBlocks(scaledBlocks, 'auto', 'zh-CN', settings);
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
    const friendly = isTimeout ? '翻译超时，请稍后重试。' : `翻译失败，可重试\n${message}`;
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

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const accessory = process.env.SNAP_TRANSLATE_ACCESSORY === '1';
    if (accessory) {
      if (app.dock && app.dock.hide) {
        app.dock.hide();
      }
      if (app.setActivationPolicy) {
        app.setActivationPolicy('accessory');
      }
    } else if (app.setActivationPolicy) {
      app.setActivationPolicy('regular');
    }
  }

  settings = loadSettings();
  setupMenu();

  const ok = registerHotkey(settings.hotkey);
  if (!ok) {
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
    hideSelectionWindowForCapture();
    if (!rect) {
      return;
    }
    let targetRect = rect;
    if (rect.click) {
      const display = screen.getDisplayNearestPoint({ x: rect.x, y: rect.y }) || screen.getPrimaryDisplay();
      targetRect = {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height
      };
    } else if (rect.width < 6 || rect.height < 6) {
      return;
    }
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

  ipcMain.handle('settings:set', async (_, next) => {
    const payload = sanitizeSettings(next);
    let hotkeyError = null;
    if (payload.hotkey && payload.hotkey !== settings.hotkey) {
      const result = updateHotkey(payload.hotkey);
      if (!result.ok) {
        hotkeyError = result.error || 'hotkey_register_failed';
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
      const result = await translationProvider.translateText(text, 'auto', 'zh-CN', settings);
      return { ok: true, text: result.text, confidence: result.confidence };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });

  // window controls are handled by the system title bar

  app.on('activate', () => {
    if (!translateWindow && !settingsWindow) {
      showTranslateWindow();
    } else if (translateWindow) {
      translateWindow.show();
      translateWindow.focus();
    } else if (settingsWindow) {
      settingsWindow.show();
      settingsWindow.focus();
    }
  });
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
