const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function send(channel, payload) {
  ipcRenderer.send(channel, payload);
}

function sendSync(channel) {
  return ipcRenderer.sendSync(channel);
}

function on(channel, handler) {
  ipcRenderer.on(channel, (_, payload) => handler(payload));
}

const api = {
  completeSelection(rect) {
    return invoke('selection:complete', rect);
  },
  cancelSelection() {
    return invoke('selection:cancel');
  },
  getCursorScreenPointSync() {
    return sendSync('selection:cursor-point-sync');
  },
  closeOverlay() {
    return invoke('overlay:close');
  },
  writeClipboardText(text) {
    return invoke('clipboard:write-text', text);
  },
  setOverlayIgnoreMouseEvents(shouldIgnore = true) {
    return invoke('overlay:set-ignore-mouse-events', shouldIgnore);
  },
  reportOverlayMetrics(payload) {
    send('overlay:metrics', payload);
  },
  getSettings() {
    return invoke('settings:get');
  },
  setSettings(settings) {
    return invoke('settings:set', settings);
  },
  moveToApplicationsFolder() {
    return invoke('app:move-to-applications');
  },
  repairLaunchAtLogin(openAtLogin = false) {
    return invoke('launch-at-login:repair', openAtLogin);
  },
  updateHotkey(hotkey) {
    return invoke('hotkey:update', hotkey);
  },
  translateText(text, options = {}) {
    return invoke('translate:text', { text, ...options });
  },
  openSettings(options = {}) {
    return invoke('settings:open', options);
  },
  openTranslate(options = {}) {
    return invoke('translate:open', options);
  },
  onSelectionWindows(handler) {
    on('selection:windows', handler);
  },
  onOverlayRender(handler) {
    on('overlay:render', handler);
  },
  onOverlayControlsRender(handler) {
    on('overlay-controls:render', handler);
  }
};

contextBridge.exposeInMainWorld('snapTranslate', api);
