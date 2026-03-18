const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapTranslate', {
  completeSelection: (rect) => ipcRenderer.invoke('selection:complete', rect),
  cancelSelection: () => ipcRenderer.invoke('selection:cancel'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  updateHotkey: (hotkey) => ipcRenderer.invoke('hotkey:update', hotkey),
  translateText: (text, options = {}) => ipcRenderer.invoke('translate:text', { text, ...options }),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  openTranslate: () => ipcRenderer.invoke('translate:open'),
  onSelectionWindows: (handler) => {
    ipcRenderer.on('selection:windows', (_, payload) => handler(payload));
  },
  onOverlayRender: (handler) => {
    ipcRenderer.on('overlay:render', (_, payload) => handler(payload));
  }
});
