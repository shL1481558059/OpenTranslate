const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, handler) => {
  ipcRenderer.on(channel, (_, payload) => handler(payload));
};

contextBridge.exposeInMainWorld('snapTranslate', {
  completeSelection: (rect) => invoke('selection:complete', rect),
  cancelSelection: () => invoke('selection:cancel'),
  closeOverlay: () => invoke('overlay:close'),
  getSettings: () => invoke('settings:get'),
  setSettings: (settings) => invoke('settings:set', settings),
  updateHotkey: (hotkey) => invoke('hotkey:update', hotkey),
  translateText: (text, options = {}) => invoke('translate:text', { text, ...options }),
  openSettings: (options = {}) => invoke('settings:open', options),
  openTranslate: (options = {}) => invoke('translate:open', options),
  onSelectionWindows: (handler) => on('selection:windows', handler),
  onOverlayRender: (handler) => on('overlay:render', handler)
});
