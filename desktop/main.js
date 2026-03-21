require('../load-env');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, nativeImage, Menu, Tray, dialog } = require('electron');

const APP_NAME = 'OpenTranslate';
app.setName(APP_NAME);
app.name = APP_NAME;

const { captureRect, captureScreen, cleanupImage } = require('./lib/capture');
const ocrProvider = require('./lib/ocr-provider');
const translationProvider = require('./lib/translation-provider');
const layoutEngine = require('./lib/layout-engine');
const { normalizeRect, rectRelativeToBounds } = require('./lib/geometry');
const { normalizeHotkey, hasModifierHotkey } = require('./lib/hotkey-rules');
const { buildOverlayLayout } = require('./lib/overlay-layout');

const CAPTURE_DELAY_MS = Number(process.env.SNAP_TRANSLATE_CAPTURE_DELAY_MS || 280);
const DEFAULT_API_URL = process.env.TRANSLATION_API_URL || 'http://127.0.0.1:8787/v1/translate';
const LOGIN_ITEM_SUPPORTED_PLATFORMS = new Set(['darwin', 'win32']);
const THEME_PREFERENCES = new Set(['system', 'light', 'dark']);
const execFileAsync = promisify(execFile);
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const UI_DIR = path.join(__dirname, 'ui');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

let selectionWindow = null;
let overlayWindow = null;
let overlayControlsWindow = null;
let lastSelectionDisplayId = null;
let overlayReadyPromise = null;
let overlaySessionHostBounds = null;
let overlaySessionViewportBounds = null;
let translateWindow = null;
let settings = null;
const appIconPath = path.join(__dirname, 'assets', 'app-icon-apple.png');
const trayIconPath = path.join(__dirname, 'assets', 'tray-template-18.png');
const trayIconPath2x = path.join(__dirname, 'assets', 'tray-template-36.png');
let tray = null;
const SELECTION_CANCEL_ACCELERATOR = 'Escape';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getErrorMessage(error) {
  return error?.message || error;
}

function normalizeLang(value, fallback) {
  const trimmed = String(value || '').trim();
  return trimmed || fallback;
}

function normalizeThemePreference(value, fallback = 'system') {
  const trimmed = String(value || '').trim().toLowerCase();
  return THEME_PREFERENCES.has(trimmed) ? trimmed : fallback;
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
    theme: normalizeThemePreference(process.env.SNAP_TRANSLATE_THEME || '', 'system'),
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

function getUiPath(fileName) {
  return path.join(UI_DIR, fileName);
}

function getScriptPath(fileName) {
  return path.join(SCRIPTS_DIR, fileName);
}

function buildRendererWebPreferences() {
  return {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false
  };
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
  if (typeof input.theme === 'string') {
    next.theme = normalizeThemePreference(input.theme);
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

function supportsLaunchAtLogin() {
  return LOGIN_ITEM_SUPPORTED_PLATFORMS.has(process.platform);
}

function canManageLaunchAtLogin() {
  return supportsLaunchAtLogin() && app.isPackaged;
}

function requiresApplicationsInstallForLaunchAtLogin() {
  return process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder();
}

function buildLaunchAtLoginState(launchAtLogin, launchAtLoginAvailable, launchAtLoginStatus) {
  return {
    launchAtLogin: Boolean(launchAtLogin),
    launchAtLoginAvailable: Boolean(launchAtLoginAvailable),
    launchAtLoginStatus
  };
}

function getLaunchAtLoginAccessError() {
  if (!supportsLaunchAtLogin()) {
    return 'launch_at_login_unsupported';
  }
  if (!canManageLaunchAtLogin()) {
    return 'launch_at_login_unavailable_in_dev';
  }
  if (requiresApplicationsInstallForLaunchAtLogin()) {
    return 'launch_at_login_requires_applications_folder';
  }
  return null;
}

function getLaunchAtLoginState() {
  const accessError = getLaunchAtLoginAccessError();
  if (accessError) {
    return buildLaunchAtLoginState(false, false, accessError.replace('launch_at_login_', ''));
  }

  try {
    const loginItem = app.getLoginItemSettings();
    return buildLaunchAtLoginState(
      loginItem.openAtLogin,
      true,
      typeof loginItem.status === 'string' ? loginItem.status : 'enabled'
    );
  } catch (error) {
    console.warn('[desktop] failed to read login item settings', getErrorMessage(error));
    return buildLaunchAtLoginState(false, false, 'error');
  }
}

function buildRendererSettings() {
  return {
    ...settings,
    ...getLaunchAtLoginState()
  };
}

function updateLaunchAtLogin(openAtLogin) {
  const accessError = getLaunchAtLoginAccessError();
  if (accessError) {
    return { ok: false, error: accessError };
  }

  try {
    const current = app.getLoginItemSettings();
    if (openAtLogin && current?.status === 'not-found') {
      return repairLaunchAtLogin(true);
    }
    app.setLoginItemSettings({
      openAtLogin: Boolean(openAtLogin)
    });
    return { ok: true, settings: buildRendererSettings() };
  } catch (error) {
    console.error('[desktop] failed to update login item settings', error);
    return { ok: false, error: 'launch_at_login_update_failed' };
  }
}

function repairLaunchAtLogin(openAtLogin = false) {
  const accessError = getLaunchAtLoginAccessError();
  if (accessError) {
    return { ok: false, error: accessError };
  }

  try {
    // Remove any stale registration first so macOS can bind the current bundle path again.
    app.setLoginItemSettings({ openAtLogin: false });

    if (openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true });
    }

    return { ok: true, settings: buildRendererSettings() };
  } catch (error) {
    console.error('[desktop] failed to repair login item settings', error);
    return { ok: false, error: 'launch_at_login_repair_failed' };
  }
}

async function moveToApplicationsFolder() {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'move_to_applications_unsupported' };
  }

  if (!app.isPackaged) {
    return { ok: false, error: 'move_to_applications_unavailable_in_dev' };
  }

  if (app.isInApplicationsFolder()) {
    return { ok: true, alreadyInApplicationsFolder: true, settings: buildRendererSettings() };
  }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['取消', '移动'],
    defaultId: 1,
    cancelId: 0,
    message: '将 OpenTranslate 移动到“应用程序”文件夹？',
    detail: '开机自启依赖应用位于“应用程序”文件夹中。移动成功后，应用会自动退出并重新打开。'
  });

  if (response !== 1) {
    return { ok: false, error: 'move_to_applications_cancelled' };
  }

  try {
    const moved = app.moveToApplicationsFolder();
    if (!moved) {
      return { ok: false, error: 'move_to_applications_cancelled' };
    }
    return { ok: true, moved: true, relaunching: true };
  } catch (error) {
    console.error('[desktop] failed to move app to Applications', error);
    return { ok: false, error: 'move_to_applications_failed' };
  }
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

function registerSelectionCancelShortcut() {
  globalShortcut.unregister(SELECTION_CANCEL_ACCELERATOR);
  return globalShortcut.register(SELECTION_CANCEL_ACCELERATOR, () => {
    if (!selectionWindow) {
      return;
    }
    closeSelectionWindow();
  });
}

function unregisterSelectionCancelShortcut() {
  globalShortcut.unregister(SELECTION_CANCEL_ACCELERATOR);
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

function imagePathToDataUrl(imagePath) {
  if (!imagePath) {
    return null;
  }
  try {
    const buffer = fs.readFileSync(imagePath);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

function getImageScale(imageSize, targetSize, fallback = 1) {
  if (imageSize > 0) {
    return imageSize / Math.max(targetSize, 1);
  }
  return fallback;
}

function createImageRectMapper(scaleX, scaleY) {
  return function mapRectToImage(bbox) {
    return {
      x: Math.round(bbox.x * scaleX),
      y: Math.round(bbox.y * scaleY),
      width: Math.round(bbox.width * scaleX),
      height: Math.round(bbox.height * scaleY)
    };
  };
}

function scaleOcrBlocks(blocks, scaleX, scaleY) {
  return blocks.map((block) => ({
    ...block,
    bbox: {
      x: Math.round(block.bbox.x / scaleX),
      y: Math.round(block.bbox.y / scaleY),
      width: Math.round(block.bbox.width / scaleX),
      height: Math.round(block.bbox.height / scaleY)
    }
  }));
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

function hideOverlayWindows() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  if (overlayControlsWindow && !overlayControlsWindow.isDestroyed()) {
    overlayControlsWindow.hide();
  }
  overlaySessionHostBounds = null;
  overlaySessionViewportBounds = null;
}

function configureSelectionWindow(win) {
  configureOverlayWindow(win);
  win.setFullScreenable(true);
  win.setSimpleFullScreen(true);
}

function getWindowViewportBounds(win) {
  if (!win || win.isDestroyed()) {
    return null;
  }
  if (typeof win.getContentBounds === 'function') {
    return normalizeRect(win.getContentBounds());
  }
  return normalizeRect(win.getBounds());
}

function getWindowHostBounds(win) {
  if (!win || win.isDestroyed()) {
    return null;
  }
  return normalizeRect(win.getBounds());
}

function rectsEqual(left, right) {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.width === right?.width &&
    left?.height === right?.height
  );
}

async function settleWindowViewportBounds(win, attempts = 4, intervalMs = 24) {
  let previous = null;
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = getWindowViewportBounds(win);
    if (current && previous && rectsEqual(current, previous)) {
      return current;
    }
    previous = current;
  }
  return previous || getWindowViewportBounds(win);
}

function resolveSelectionWindowBounds(display) {
  if (
    selectionWindow &&
    !selectionWindow.isDestroyed() &&
    display &&
    lastSelectionDisplayId === display.id
  ) {
    return getWindowHostBounds(selectionWindow);
  }
  return normalizeRect(display?.bounds || screen.getPrimaryDisplay().bounds);
}

function resolveDesktopScriptPath(fileName) {
  const local = getScriptPath(fileName);
  if (!app || !app.isPackaged) {
    return local;
  }

  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop', 'scripts', fileName);
  if (fs.existsSync(unpacked)) {
    return unpacked;
  }

  const resources = path.join(process.resourcesPath, 'desktop', 'scripts', fileName);
  if (fs.existsSync(resources)) {
    return resources;
  }

  return local;
}

function resolveWindowListScriptPath() {
  return resolveDesktopScriptPath('window_list.swift');
}

function resolveVisionRectsScriptPath() {
  return resolveDesktopScriptPath('vision_rects.swift');
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
    console.warn('[desktop] window list unavailable', getErrorMessage(error));
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
    console.warn('[desktop] vision window detect failed', getErrorMessage(error));
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
  const baseSize = Math.max(12, Math.min(28, Math.floor(Math.min(rect.width, rect.height) * 0.06)));
  const block = buildOverlayRectBlock('status', rect, message, {
    fontSize: baseSize,
    lineHeight: 1.3,
    padding: Math.max(8, Math.floor(baseSize * 0.6)),
    background: 'transparent',
    color: '#ffffff',
    textShadow: '0 1px 2px rgba(0,0,0,0.6)',
    layout: 'center',
    ...styleHint
  });
  await renderOverlayPayload(rect, {
    rect,
    blocks: [block],
    ...buildTextOnlyOverlayOptions({ maskOpacity: options.maskOpacity }, false)
  });
}

function buildOverlayRectBlock(id, rect, text, styleHint) {
  return {
    id,
    bbox: { x: 0, y: 0, width: rect.width, height: rect.height },
    text,
    styleHint
  };
}

function buildTextOnlyOverlayOptions(options = {}, hasText = false) {
  return {
    hasText,
    mask: true,
    textOnly: true,
    maskOpacity: typeof options.maskOpacity === 'number' ? options.maskOpacity : 0.35
  };
}

function buildResultOverlayOptions(snapshotDataUrl, sampledMaskColor, usesCompactMaskReplace, hasText) {
  return {
    hasText,
    snapshotDataUrl,
    mask: true,
    textOnly: true,
    maskOpacity: snapshotDataUrl ? (usesCompactMaskReplace ? 0.35 : 0.18) : 1,
    maskColor: snapshotDataUrl ? undefined : sampledMaskColor ? colorToCss(sampledMaskColor) : undefined
  };
}

function cleanupCapturedImages(paths, keepLast) {
  if (keepLast) {
    return Promise.resolve();
  }

  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  return Promise.all(uniquePaths.map((imagePath) => cleanupImage(imagePath)));
}

async function renderOverlayPayload(rect, payload) {
  const display = screen.getDisplayNearestPoint({ x: rect.x, y: rect.y }) || screen.getPrimaryDisplay();
  const win = await ensureOverlayWindowReady();
  if (!overlaySessionHostBounds) {
    overlaySessionHostBounds = resolveSelectionWindowBounds(display);
  }
  if (!overlaySessionViewportBounds) {
    win.setBounds(overlaySessionHostBounds);
    win.showInactive();
    overlaySessionViewportBounds = await settleWindowViewportBounds(win);
  } else if (!win.isVisible()) {
    win.showInactive();
  }
  const overlayBounds = overlaySessionViewportBounds;
  const layout = buildOverlayLayout(rect, overlayBounds);

  win.webContents.send('overlay:render', {
    ...payload,
    rect,
    overlayBounds,
    selectionRect: rectRelativeToBounds(rect, overlayBounds),
    controlRect: rectRelativeToBounds(layout.controlBounds, overlayBounds),
    controlSide: layout.controlSide
  });
  if (overlayControlsWindow && !overlayControlsWindow.isDestroyed()) {
    overlayControlsWindow.hide();
  }
}

function hideSelectionWindowForCapture() {
  if (!selectionWindow || selectionWindow.isDestroyed()) {
    return;
  }
  selectionWindow.setIgnoreMouseEvents(true);
  selectionWindow.setOpacity(0);
  selectionWindow.hide();
}

function shouldKeepSelectionWindowForOverlay() {
  return Boolean(selectionWindow && !selectionWindow.isDestroyed());
}

function loadWindowFile(win, fileName, options) {
  return win.loadFile(getUiPath(fileName), options);
}

function showLoadedWindow(win) {
  win.show();
  win.focus();
}

function buildOverlayBrowserWindowOptions(overrides = {}) {
  return {
    show: false,
    frame: false,
    hasShadow: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    fullscreenable: false,
    webPreferences: buildRendererWebPreferences(),
    ...overrides
  };
}

function buildSelectionWindowOptions(display) {
  return buildOverlayBrowserWindowOptions({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    movable: false
  });
}

function buildTranslateWindowEffects() {
  if (process.platform !== 'darwin') {
    return {};
  }
  return {
    vibrancy: 'under-window',
    visualEffectState: 'active'
  };
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  overlayWindow = new BrowserWindow(buildOverlayBrowserWindowOptions());

  configureOverlayWindow(overlayWindow);
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayReadyPromise = null;
    overlaySessionHostBounds = null;
    overlaySessionViewportBounds = null;
    if (overlayControlsWindow && !overlayControlsWindow.isDestroyed()) {
      overlayControlsWindow.close();
    }
  });
  loadWindowFile(overlayWindow, 'overlay.html');
  return overlayWindow;
}

function ensureOverlayControlsWindow() {
  if (overlayControlsWindow && !overlayControlsWindow.isDestroyed()) {
    return overlayControlsWindow;
  }

  overlayControlsWindow = new BrowserWindow(buildOverlayBrowserWindowOptions());

  configureOverlayWindow(overlayControlsWindow);
  overlayControlsWindow.on('closed', () => {
    overlayControlsWindow = null;
  });
  loadWindowFile(overlayControlsWindow, 'overlay-controls.html');
  return overlayControlsWindow;
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

function isValidSelectionSize(rect) {
  return rect.width > 6 && rect.height > 6;
}

function resolvePipelineTargetRect(rect) {
  if (!rect) {
    return null;
  }
  if (rect.click) {
    if (rect.snapped !== 'window' || !isValidSelectionSize(rect)) {
      return null;
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    };
  }
  return isValidSelectionSize(rect) ? rect : null;
}

function createSelectionWindow() {
  overlaySessionHostBounds = null;
  overlaySessionViewportBounds = null;
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  lastSelectionDisplayId = display.id;
  let selectionContext = {
    windows: [],
    requiresAccessibility: false,
    requiresScreenRecording: false
  };
  let didFinishLoad = false;

  const sendSelectionContext = () => {
    if (
      !didFinishLoad ||
      !selectionWindow ||
      selectionWindow.isDestroyed() ||
      selectionWindow.webContents.isDestroyed()
    ) {
      return;
    }
    selectionWindow.webContents.send('selection:windows', {
      ...selectionContext,
      displayBounds: getWindowViewportBounds(selectionWindow)
    });
  };

  selectionWindow = new BrowserWindow(buildSelectionWindowOptions(display));

  configureSelectionWindow(selectionWindow);
  registerSelectionCancelShortcut();
  loadWindowFile(selectionWindow, 'selection.html');
  selectionWindow.webContents.once('did-finish-load', async () => {
    didFinishLoad = true;
    try {
      selectionContext = await getSnapWindows(display);
    } catch {
      // ignore
    }
    sendSelectionContext();
  });
  selectionWindow.once('ready-to-show', () => {
    if (!selectionWindow || selectionWindow.isDestroyed()) {
      return;
    }
    selectionWindow.showInactive();
    setTimeout(sendSelectionContext, 0);
  });
  selectionWindow.on('move', sendSelectionContext);
  selectionWindow.on('resize', sendSelectionContext);
  selectionWindow.on('closed', () => {
    unregisterSelectionCancelShortcut();
    selectionWindow = null;
  });
}

function closeSelectionWindow() {
  unregisterSelectionCancelShortcut();
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
    ...buildTranslateWindowEffects(),
    icon: appIconPath,
    webPreferences: buildRendererWebPreferences()
  });
  translateWindow.on('closed', () => {
    translateWindow = null;
  });
  loadWindowFile(translateWindow, 'translate.html');
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
  loadWindowFile(win, 'translate.html', buildPageLoadOptions(options));
  showLoadedWindow(win);
}

function showSettingsWindow(options = {}) {
  const win = ensureTranslateWindow();
  loadWindowFile(win, 'settings.html', buildPageLoadOptions(options));
  showLoadedWindow(win);
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
  let sourceImagePath = null;
  let snapshotDataUrl = null;
  const keepLast = process.env.SNAP_TRANSLATE_KEEP_LAST === '1';
  const allowFullCaptureFallback = process.env.SNAP_TRANSLATE_ALLOW_FULL_CAPTURE_FALLBACK === '1';
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
    const tryPreciseCapture = async () => {
      const attempts = buildCaptureAttempts(absoluteRect, display);
      for (const attempt of attempts) {
        let matchedAttempt = false;
        try {
          imagePath = await captureRect(attempt.rect, attempt.scaleFactor);
          await showProgress();
          const ocrResult = await ocrProvider.recognize(imagePath);
          const blocks = ocrResult.blocks || [];
          imageWidth = Number(ocrResult.imageWidth || 1);
          imageHeight = Number(ocrResult.imageHeight || 1);
          const fallbackScale = display.scaleFactor || 1;
          const scaleX = getImageScale(imageWidth, attempt.rect.width, fallbackScale);
          const scaleY = getImageScale(imageHeight, attempt.rect.height, fallbackScale);
          scaledBlocks = scaleOcrBlocks(blocks, scaleX, scaleY);
          if (scaledBlocks.length) {
            matchedAttempt = true;
            console.warn('[capture] matched', attempt.name, {
              rect: attempt.rect,
              scaleFactor: attempt.scaleFactor,
              imageWidth,
              imageHeight
            });
            mapRectToImage = createImageRectMapper(scaleX, scaleY);
            return true;
          }
        } catch (error) {
          console.warn('[capture] attempt failed', attempt.name, {
            rect: attempt.rect,
            scaleFactor: attempt.scaleFactor,
            error: String(getErrorMessage(error))
          });
        } finally {
          if (imagePath && !keepLast && !matchedAttempt) {
            await cleanupImage(imagePath);
          }
          if (!matchedAttempt && !keepLast) {
            imagePath = null;
          }
        }
      }
      return false;
    };

    const tryFullScreenCapture = async () => {
      sourceImagePath = await captureScreen();
      await showProgress();
      const fullImage = nativeImage.createFromPath(sourceImagePath);
      if (fullImage.isEmpty()) {
        throw new Error('full_capture_empty');
      }
      const fullSize = fullImage.getSize();
      const fullImageWidth = Number(fullSize.width || 1);
      const fullImageHeight = Number(fullSize.height || 1);
      const virtualBounds = getVirtualBounds();
      const fallbackScale = display.scaleFactor || 1;
      const fullScaleX = getImageScale(fullImageWidth, virtualBounds.width, fallbackScale);
      const fullScaleY = getImageScale(fullImageHeight, virtualBounds.height, fallbackScale);
      const cropX = Math.round((absoluteRect.x - virtualBounds.x) * fullScaleX);
      const cropY = Math.round((absoluteRect.y - virtualBounds.y) * fullScaleY);
      const cropW = Math.max(1, Math.round(absoluteRect.width * fullScaleX));
      const cropH = Math.max(1, Math.round(absoluteRect.height * fullScaleY));
      const clampedCropX = clamp(cropX, 0, Math.max(0, fullImageWidth - 1));
      const clampedCropY = clamp(cropY, 0, Math.max(0, fullImageHeight - 1));
      const clampedCropW = clamp(cropW, 1, Math.max(1, fullImageWidth - clampedCropX));
      const clampedCropH = clamp(cropH, 1, Math.max(1, fullImageHeight - clampedCropY));
      const croppedImage = fullImage.crop({
        x: clampedCropX,
        y: clampedCropY,
        width: clampedCropW,
        height: clampedCropH
      });
      const debugImagePath = process.env.SNAP_TRANSLATE_DEBUG_IMAGE_PATH;
      const cropImagePath = keepLast
        ? debugImagePath
          ? path.join(
              path.dirname(debugImagePath),
              `${path.basename(debugImagePath, path.extname(debugImagePath) || '.png')}-crop${path.extname(debugImagePath) || '.png'}`
            )
          : path.join(os.tmpdir(), 'snap-translate-last-crop.png')
        : path.join(os.tmpdir(), `snap-translate-crop-${Date.now()}.png`);
      fs.writeFileSync(cropImagePath, croppedImage.toPNG());
      imagePath = cropImagePath;

      const ocrResult = await ocrProvider.recognize(imagePath);
      const blocks = ocrResult.blocks || [];
      imageWidth = Number(ocrResult.imageWidth || croppedImage.getSize().width || 1);
      imageHeight = Number(ocrResult.imageHeight || croppedImage.getSize().height || 1);
      const scaleX = getImageScale(imageWidth, absoluteRect.width, fullScaleX);
      const scaleY = getImageScale(imageHeight, absoluteRect.height, fullScaleY);
      mapRectToImage = createImageRectMapper(scaleX, scaleY);
      scaledBlocks = scaleOcrBlocks(blocks, scaleX, scaleY);

      console.warn('[capture] full-crop', {
        fullImageWidth,
        fullImageHeight,
        imageWidth,
        imageHeight,
        virtualBounds,
        displayBounds,
        fullScaleX,
        fullScaleY,
        cropX,
        cropY,
        cropW,
        cropH,
        clampedCropX,
        clampedCropY,
        clampedCropW,
        clampedCropH,
        blocks: scaledBlocks.length
      });
      return scaledBlocks.length > 0;
    };

    const matchedPreciseCapture = await tryPreciseCapture();
    if (!matchedPreciseCapture && allowFullCaptureFallback) {
      console.warn('[capture] precise capture missed, falling back to full-screen crop');
      await tryFullScreenCapture();
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
    const renderBlocks = layoutEngine.mapBlocks(scaledBlocks, translatedItems, {
      selectionRect: absoluteRect
    });
    const usesCompactMaskReplace = renderBlocks.some(
      (block) => block.styleHint?.layoutMode === 'compact-mask-replace'
    );
    snapshotDataUrl = usesCompactMaskReplace ? null : imagePathToDataUrl(imagePath);
    const sampled = usesCompactMaskReplace
      ? null
      : sampleOverlayColors(imagePath, mapRectToImage, absoluteRect, scaledBlocks);
    if (sampled && !usesCompactMaskReplace) {
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

    await renderOverlayPayload(absoluteRect, {
      rect: absoluteRect,
      blocks: renderBlocks,
      ...(usesCompactMaskReplace
        ? buildTextOnlyOverlayOptions({ maskOpacity: 0.35 }, scaledBlocks.length > 0)
        : buildResultOverlayOptions(
            snapshotDataUrl,
            sampled?.maskColor,
            false,
            scaledBlocks.length > 0
          ))
    });
  } catch (error) {
    const message = String(getErrorMessage(error));
    const isTimeout = message === 'timeout' || /aborted|timeout/i.test(message);
    const friendly = isTimeout
      ? '翻译超时，请稍后重试。'
      : `翻译失败，可重试\n${message}`;
    snapshotDataUrl = snapshotDataUrl || imagePathToDataUrl(imagePath);
    const errorBlock = buildOverlayRectBlock('error', absoluteRect, friendly, {
      fontSize: 18,
      lineHeight: 1.28,
      padding: 8,
      background: 'transparent',
      color: '#ffe3e3',
      textShadow: '0 2px 8px rgba(60, 0, 0, 0.85)'
    });
    await renderOverlayPayload(absoluteRect, {
      rect: absoluteRect,
      blocks: [errorBlock],
      snapshotDataUrl,
      ...buildTextOnlyOverlayOptions({ maskOpacity: snapshotDataUrl ? 0.28 : 0.88 }, false)
    });
  } finally {
    await cleanupCapturedImages([imagePath, sourceImagePath], keepLast);
  }
}

function configureMacAppAppearance() {
  if (process.platform !== 'darwin') {
    return;
  }

  const accessory = process.env.SNAP_TRANSLATE_ACCESSORY === '1';
  if (accessory) {
    if (app.dock?.hide) {
      app.dock.hide();
    }
    if (app.setActivationPolicy) {
      app.setActivationPolicy('accessory');
    }
  } else {
    if (app.setActivationPolicy) {
      app.setActivationPolicy('regular');
    }
    if (app.dock?.show) {
      app.dock.show();
    }
  }

  if (app.dock?.setIcon) {
    app.dock.setIcon(appIconPath);
  }
}

function logHotkeyStatus(ok) {
  if (!settings.hotkey) {
    console.log('[desktop] hotkey disabled');
    return;
  }
  if (!ok) {
    console.error(`[desktop] failed to register hotkey: ${settings.hotkey}`);
    return;
  }
  console.log(`[desktop] hotkey ready: ${settings.hotkey}`);
}

async function handleSelectionComplete(_, rect) {
  const targetRect = resolvePipelineTargetRect(rect);
  if (!targetRect) {
    closeSelectionWindow();
    return;
  }
  hideSelectionWindowForCapture();
  try {
    await runPipeline(targetRect);
  } finally {
    if (!shouldKeepSelectionWindowForOverlay()) {
      closeSelectionWindow();
    }
  }
}

function handleOverlayIgnoreMouseEvents(_, shouldIgnore = true) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }
  if (shouldIgnore) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    return true;
  }
  overlayWindow.setIgnoreMouseEvents(false);
  return true;
}

function handleOverlayMetrics(_, payload) {
  try {
    console.warn('[overlay:metrics]', JSON.stringify(payload));
  } catch (error) {
    console.warn('[overlay:metrics] failed to serialize', getErrorMessage(error));
  }
}

function handleTranslateOpen(_, options = {}) {
  showTranslateWindow(options);
  return true;
}

function handleSettingsOpen(_, options = {}) {
  showSettingsWindow(options);
  return true;
}

async function handleSettingsSet(_, next) {
  const payload = sanitizeSettings(next);
  let hotkeyError = null;
  let launchAtLoginError = null;
  if (Object.hasOwn(payload, 'hotkey') && payload.hotkey !== settings.hotkey) {
    const result = updateHotkey(payload.hotkey);
    if (!result.ok) {
      hotkeyError = result.error || 'hotkey_update_failed';
      delete payload.hotkey;
    }
  }
  if (typeof next?.launchAtLogin === 'boolean') {
    const currentLaunchAtLogin = getLaunchAtLoginState().launchAtLogin;
    if (next.launchAtLogin !== currentLaunchAtLogin) {
      const result = updateLaunchAtLogin(next.launchAtLogin);
      if (!result.ok) {
        launchAtLoginError = result.error || 'launch_at_login_update_failed';
      }
    }
  }
  saveSettings(payload);
  return {
    ok: !hotkeyError && !launchAtLoginError,
    error: hotkeyError || launchAtLoginError,
    settings: buildRendererSettings()
  };
}

async function handleTranslateText(_, payload) {
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
    return { ok: false, error: String(getErrorMessage(error)) };
  }
}

function registerIpcHandlers() {
  ipcMain.handle('selection:cancel', closeSelectionWindow);
  ipcMain.on('selection:cursor-point-sync', (event) => {
    event.returnValue = screen.getCursorScreenPoint();
  });
  ipcMain.handle('selection:complete', handleSelectionComplete);
  ipcMain.handle('overlay:close', () => {
    hideOverlayWindows();
    closeSelectionWindow();
  });
  ipcMain.handle('overlay:set-ignore-mouse-events', handleOverlayIgnoreMouseEvents);
  ipcMain.on('overlay:metrics', handleOverlayMetrics);
  ipcMain.handle('settings:get', buildRendererSettings);
  ipcMain.handle('app:move-to-applications', moveToApplicationsFolder);
  ipcMain.handle('launch-at-login:repair', async (_, openAtLogin = false) =>
    repairLaunchAtLogin(Boolean(openAtLogin))
  );
  ipcMain.handle('settings:open', handleSettingsOpen);
  ipcMain.handle('translate:open', handleTranslateOpen);
  ipcMain.handle('settings:set', handleSettingsSet);
  ipcMain.handle('hotkey:update', async (_, hotkey) => updateHotkey(hotkey));
  ipcMain.handle('translate:text', handleTranslateText);
}

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  app.name = APP_NAME;
  configureMacAppAppearance();

  settings = loadSettings();
  setupMenu();
  ensureTray();

  const ok = registerHotkey(settings.hotkey);
  logHotkeyStatus(ok);

  // Show a window on launch so the app isn't "invisible" to users.
  showTranslateWindow();
  registerIpcHandlers();

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
