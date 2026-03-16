const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapTranslate', {
  completeSelection: (rect) => ipcRenderer.invoke('selection:complete', rect),
  cancelSelection: () => ipcRenderer.invoke('selection:cancel'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  updateHotkey: (hotkey) => ipcRenderer.invoke('hotkey:update', hotkey),
  translateText: (text) => ipcRenderer.invoke('translate:text', { text }),
  onOverlayRender: (handler) => {
    ipcRenderer.on('overlay:render', (_, payload) => handler(payload));
  }
});
