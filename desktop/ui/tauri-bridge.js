(function initSnapTranslate() {
  const tauri = window.__TAURI__;
  if (!tauri?.core || !tauri?.event) {
    return;
  }

  const listeners = {
    'selection-windows': [],
    'overlay-render': [],
    'overlay-controls-render': []
  };
  const latest = {};

  function subscribe(event, handler) {
    listeners[event].push(handler);
    if (Object.prototype.hasOwnProperty.call(latest, event)) {
      handler(latest[event]);
    }
  }

  function publish(event, payload) {
    latest[event] = payload;
    for (const handler of listeners[event]) {
      handler(payload);
    }
  }

  window.snapTranslate = {
    completeSelection(rect) {
      return tauri.core.invoke('selection_complete', { rect });
    },
    cancelSelection() {
      return tauri.core.invoke('selection_cancel');
    },
    getCursorScreenPointSync() {
      return null;
    },
    closeOverlay() {
      return tauri.core.invoke('overlay_close');
    },
    writeClipboardText(text) {
      return tauri.core.invoke('clipboard_write_text', { text });
    },
    setOverlayIgnoreMouseEvents(shouldIgnore = true) {
      return tauri.core.invoke('overlay_set_ignore_mouse', { shouldIgnore: shouldIgnore });
    },
    reportOverlayMetrics(payload) {
      return tauri.core.invoke('overlay_metrics', { payload });
    },
    getSettings() {
      return tauri.core.invoke('settings_get');
    },
    setSettings(settings) {
      return tauri.core.invoke('settings_set', { settings });
    },
    moveToApplicationsFolder() {
      return tauri.core.invoke('move_to_applications');
    },
    repairLaunchAtLogin(openAtLogin = false) {
      return tauri.core.invoke('repair_launch_at_login', { openAtLogin });
    },
    updateHotkey(hotkey) {
      return tauri.core.invoke('hotkey_update', { hotkey });
    },
    translateText(text, options = {}) {
      return tauri.core.invoke('translate_text', {
        text,
        sourceLang: options.sourceLang,
        targetLang: options.targetLang
      });
    },
    testTranslation(config) {
      return tauri.core.invoke('test_translation', { config });
    },
    openSettings(options = {}) {
      return tauri.core.invoke('open_settings', { nav: options.nav || null });
    },
    openTranslate(options = {}) {
      return tauri.core.invoke('open_translate', { nav: options.nav || null });
    },
    onSelectionWindows(handler) {
      subscribe('selection-windows', handler);
    },
    onOverlayRender(handler) {
      subscribe('overlay-render', handler);
    },
    onOverlayControlsRender(handler) {
      subscribe('overlay-controls-render', handler);
    }
  };

  Promise.all([
    tauri.event.listen('selection-windows', (event) => publish('selection-windows', event.payload)),
    tauri.event.listen('overlay-render', (event) => publish('overlay-render', event.payload)),
    tauri.event.listen('overlay-controls-render', (event) => publish('overlay-controls-render', event.payload))
  ])
    .then(() => tauri.core.invoke('ui_listener_ready'))
    .catch((error) => {
      console.error('[opentranslate] bridge listen failed', error);
    });
})();
