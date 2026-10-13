mod capture;
mod cursor;
mod hotkey;
mod layout;
mod ocr_models;
mod paths;
mod pipeline;
mod secrets;
mod settings;
mod translate;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use arboard::Clipboard;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use capture::{CssRect, Rect};
use settings::Settings;

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub ready: Mutex<HashSet<String>>,
    pub selecting: AtomicBool,
    pub overlay_control: Mutex<Option<CssRect>>,
    pub overlay_close: Mutex<Option<CssRect>>,
    pub overlay_shape: Mutex<Option<(i32, i32, i32, i32)>>,
    pub overlay_visible: AtomicBool,
    /// X11 window ids captured on the GTK thread. Frame queries from the
    /// async pipeline use these instead of tao's scale-multiplied origin.
    pub device_xids: Mutex<HashMap<String, u64>>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let is_escape = shortcut == &Shortcut::new(None, Code::Escape);
                    let app = app.clone();
                    let _ = app.run_on_main_thread({
                        let app = app.clone();
                        move || {
                            if is_escape {
                                dismiss_overlay(&app);
                            } else {
                                open_selection(&app);
                            }
                        }
                    });
                })
                .build(),
        )
        .manage(AppState {
            settings: Mutex::new(Settings::defaults()),
            ready: Mutex::new(HashSet::new()),
            selecting: AtomicBool::new(false),
            overlay_control: Mutex::new(None),
            overlay_close: Mutex::new(None),
            overlay_shape: Mutex::new(None),
            overlay_visible: AtomicBool::new(false),
            device_xids: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            configure_runtime(app.handle());
            let loaded = Settings::load(&settings_path(app.handle()));
            let hotkey = loaded.hotkey.clone();
            if let Ok(mut guard) = app.state::<AppState>().settings.lock() {
                *guard = loaded;
            }
            install_window_icon(app.handle());
            if let Err(error) = install_tray(app.handle()) {
                eprintln!("[tray] {error}");
            }
            if let Err(error) = apply_hotkey(app.handle(), &hotkey) {
                eprintln!("[hotkey] {error}");
            } else if !hotkey.is_empty() {
                eprintln!("[hotkey] ready: {hotkey}");
            }
            let ocr_dir = paths::ocr_dir(app.handle());
            if ocr_models::present(&ocr_dir) {
                std::thread::spawn(|| {
                    if let Err(error) = ocr_engine::preload() {
                        eprintln!("[ocr] preload failed: {error}");
                    }
                });
            }
            if let Ok(spec) = std::env::var("SNAP_TRANSLATE_RUN_RECT") {
                if let Some(rect) = parse_run_rect(&spec) {
                    let app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        pipeline::run(app, rect).await;
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            selection_complete,
            selection_cancel,
            overlay_close,
            overlay_set_hit_rect,
            overlay_set_ignore_mouse,
            overlay_metrics,
            settings_get,
            settings_set,
            move_to_applications,
            repair_launch_at_login,
            open_settings,
            open_translate,
            hotkey_update,
            translate_text,
            test_translation,
            clipboard_write_text,
            ui_listener_ready
        ])
        .run(tauri::generate_context!())
        .expect("OpenTranslate failed to start");
}

fn configure_runtime(app: &AppHandle) {
    std::env::set_var("OPENTRANSLATE_OCR_DIR", paths::ocr_dir(app));
    std::env::set_var("OPENTRANSLATE_VISION_SWIFT", paths::vision_swift(app));
}

fn settings_path_early() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return std::path::PathBuf::from(dir)
            .join("com.opentranslate.desktop")
            .join("settings.json");
    }
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home)
            .join(".config")
            .join("com.opentranslate.desktop")
            .join("settings.json");
    }
    std::env::temp_dir().join("opentranslate-settings.json")
}

fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .unwrap_or_else(|_| settings_path_early())
}

fn tray_icon_bytes() -> &'static [u8] {
    #[cfg(target_os = "macos")]
    {
        include_bytes!("../../assets/tray-template-36.png")
    }
    #[cfg(not(target_os = "macos"))]
    {
        include_bytes!("../icons/128x128.png")
    }
}

fn install_window_icon(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/256x256.png")) {
        let _ = window.set_icon(icon);
    }
    #[cfg(target_os = "linux")]
    set_linux_icon_list(&window);
}

#[cfg(target_os = "linux")]
fn set_linux_icon_list(window: &tauri::WebviewWindow) {
    use gtk::gdk_pixbuf::prelude::PixbufLoaderExt;
    use gtk::prelude::{GtkWindowExt, IconThemeExt};

    let Ok(gtk_window) = window.gtk_window() else {
        eprintln!("[icon] gtk window unavailable");
        return;
    };
    let mut icons = Vec::new();
    for bytes in [
        include_bytes!("../icons/16x16.png").as_slice(),
        include_bytes!("../icons/24x24.png").as_slice(),
        include_bytes!("../icons/32x32.png").as_slice(),
        include_bytes!("../icons/48x48.png").as_slice(),
        include_bytes!("../icons/64x64.png").as_slice(),
        include_bytes!("../icons/96x96.png").as_slice(),
        include_bytes!("../icons/128x128.png").as_slice(),
        include_bytes!("../icons/256x256.png").as_slice(),
    ] {
        let loader = gtk::gdk_pixbuf::PixbufLoader::new();
        if loader.write(bytes).is_err() || loader.close().is_err() {
            continue;
        }
        if let Some(pixbuf) = loader.pixbuf() {
            icons.push(pixbuf);
        }
    }
    if icons.is_empty() {
        return;
    }
    install_user_hicolor_icons();
    if let Some(theme) = gtk::IconTheme::default() {
        theme.rescan_if_needed();
    }
    gtk_window.set_icon(Some(&icons[icons.len() - 1]));
    gtk_window.set_icon_list(&icons);
    // Theme lookup (SVG / @2x) is what docks and status icons scale sharply.
    // A single pixmap is what they upscale into a pixelated OT mark.
    gtk_window.set_icon_name(Some("opentranslate"));
    publish_net_wm_icon(window);
}

#[cfg(target_os = "linux")]
fn install_user_hicolor_icons() {
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let base = std::path::PathBuf::from(home)
        .join(".local/share/icons/hicolor");
    let files: &[(&str, &str, &[u8])] = &[
        (
            "scalable/apps",
            "opentranslate.svg",
            include_bytes!("../icons/opentranslate.svg"),
        ),
        (
            "16x16/apps",
            "opentranslate.png",
            include_bytes!("../icons/16x16.png"),
        ),
        (
            "24x24/apps",
            "opentranslate.png",
            include_bytes!("../icons/24x24.png"),
        ),
        (
            "32x32/apps",
            "opentranslate.png",
            include_bytes!("../icons/32x32.png"),
        ),
        (
            "48x48/apps",
            "opentranslate.png",
            include_bytes!("../icons/48x48.png"),
        ),
        (
            "64x64/apps",
            "opentranslate.png",
            include_bytes!("../icons/64x64.png"),
        ),
        (
            "96x96/apps",
            "opentranslate.png",
            include_bytes!("../icons/96x96.png"),
        ),
        (
            "128x128/apps",
            "opentranslate.png",
            include_bytes!("../icons/128x128.png"),
        ),
        (
            "256x256/apps",
            "opentranslate.png",
            include_bytes!("../icons/256x256.png"),
        ),
        (
            "512x512/apps",
            "opentranslate.png",
            include_bytes!("../icons/512x512.png"),
        ),
        (
            "24x24@2/apps",
            "opentranslate.png",
            include_bytes!("../icons/48x48.png"),
        ),
        (
            "48x48@2/apps",
            "opentranslate.png",
            include_bytes!("../icons/96x96.png"),
        ),
        (
            "64x64@2/apps",
            "opentranslate.png",
            include_bytes!("../icons/128x128.png"),
        ),
        (
            "128x128@2/apps",
            "opentranslate.png",
            include_bytes!("../icons/256x256.png"),
        ),
        (
            "256x256@2/apps",
            "opentranslate.png",
            include_bytes!("../icons/512x512.png"),
        ),
    ];
    for (dir, name, bytes) in files {
        let path = base.join(dir).join(name);
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        if std::fs::write(&path, bytes).is_err() {
            eprintln!("[icon] failed to install {}", path.display());
        }
    }
    install_user_desktop_file();
    let status = std::process::Command::new("gtk-update-icon-cache")
        .args(["-f", "-t", &base.to_string_lossy()])
        .status();
    if !matches!(status, Ok(code) if code.success()) {
        eprintln!("[icon] gtk-update-icon-cache skipped");
    }
}

#[cfg(target_os = "linux")]
fn install_user_desktop_file() {
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let path = std::path::PathBuf::from(home)
        .join(".local/share/applications/opentranslate.desktop");
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let body = "\
[Desktop Entry]
Type=Application
Name=OpenTranslate
Comment=Screenshot translation
Exec=opentranslate
Icon=opentranslate
StartupWMClass=Opentranslate
Categories=Utility;
Terminal=false
";
    if std::fs::write(&path, body).is_err() {
        eprintln!("[icon] failed to install {}", path.display());
    }
}

#[cfg(target_os = "linux")]
fn publish_net_wm_icon(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::os::raw::{c_int, c_long, c_uchar, c_ulong, c_void};

    #[link(name = "X11")]
    extern "C" {
        fn XOpenDisplay(name: *const i8) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
        fn XInternAtom(display: *mut c_void, name: *const i8, only_if_exists: c_int) -> c_ulong;
        fn XChangeProperty(
            display: *mut c_void,
            window: c_ulong,
            property: c_ulong,
            type_: c_ulong,
            format: c_int,
            mode: c_int,
            data: *const c_uchar,
            nelements: c_int,
        ) -> c_int;
        fn XFlush(display: *mut c_void) -> c_int;
        fn XSync(display: *mut c_void, discard: c_int) -> c_int;
    }

    let Ok(handle) = window.window_handle() else {
        return;
    };
    let xid = match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => handle.window as c_ulong,
        RawWindowHandle::Xcb(handle) => c_ulong::from(handle.window.get()),
        _ => return,
    };
    let mut data: Vec<c_long> = Vec::new();
    // Largest first. Some docks use the first icon and scale it; a 32px
    // bitmap stretched into a HiDPI dock slot is the pixelated OT mark.
    // 512+256 fit in XExtendedMaxRequestSize (BIG-REQUESTS), not the 64KB default.
    for bytes in [
        include_bytes!("../icons/512x512.png").as_slice(),
        include_bytes!("../icons/256x256.png").as_slice(),
        include_bytes!("../icons/128x128.png").as_slice(),
        include_bytes!("../icons/64x64.png").as_slice(),
        include_bytes!("../icons/48x48.png").as_slice(),
        include_bytes!("../icons/32x32.png").as_slice(),
    ] {
        let Ok(image) = image::load_from_memory(bytes) else {
            continue;
        };
        let image = image.to_rgba8();
        data.push(c_long::from(image.width() as i32));
        data.push(c_long::from(image.height() as i32));
        for pixel in image.pixels() {
            let argb = (u32::from(pixel[3]) << 24)
                | (u32::from(pixel[0]) << 16)
                | (u32::from(pixel[1]) << 8)
                | u32::from(pixel[2]);
            data.push(argb as c_long);
        }
    }
    std::thread::spawn(move || {
        // GTK clears _NET_WM_ICON while mapping. Rewrite after that, then once
        // more in case the toolkit sets a small icon list of its own.
        for delay_ms in [700_u64, 1800] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            unsafe {
                let display = XOpenDisplay(std::ptr::null());
                if display.is_null() {
                    return;
                }
                let property = XInternAtom(display, b"_NET_WM_ICON\0".as_ptr().cast(), 0);
                let kind = XInternAtom(display, b"CARDINAL\0".as_ptr().cast(), 0);
                XChangeProperty(
                    display,
                    xid,
                    property,
                    kind,
                    32,
                    0,
                    data.as_ptr().cast(),
                    data.len() as c_int,
                );
                XSync(display, 0);
                XFlush(display);
                XCloseDisplay(display);
            }
        }
    });
}

fn install_tray(app: &AppHandle) -> Result<(), String> {
    let icon = tauri::image::Image::from_bytes(tray_icon_bytes())
        .map_err(|error| error.to_string())?;
    let translate = MenuItem::with_id(app, "translate", "打开翻译", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&translate, &settings, &quit])
        .map_err(|error| error.to_string())?;
    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("OpenTranslate")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "translate" => show_page(app, "translate.html", None),
            "settings" => show_page(app, "settings.html", None),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_page(tray.app_handle(), "translate.html", None);
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let parsed = hotkey::parse_shortcut(hotkey)?;
    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister_all()
        .map_err(|error| error.to_string())?;
    if let Some(shortcut) = parsed {
        if let Err(error) = shortcuts.register(shortcut) {
            if let Some(previous) = app
                .state::<AppState>()
                .settings
                .lock()
                .ok()
                .and_then(|guard| hotkey::parse_shortcut(&guard.hotkey).ok().flatten())
            {
                let _ = shortcuts.register(previous);
            }
            return Err(error.to_string());
        }
    }
    if app.state::<AppState>().selecting.load(Ordering::SeqCst) {
        let _ = shortcuts.register(Shortcut::new(None, Code::Escape));
    }
    Ok(())
}

fn open_selection(app: &AppHandle) {
    if app
        .state::<AppState>()
        .selecting
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let (x, y) = cursor::cursor_position().unwrap_or((0, 0));
    let host = capture::monitor_at(x, y).unwrap_or(Rect {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
    });
    place_window(app, "selection", host);
    let _ = app
        .global_shortcut()
        .register(Shortcut::new(None, Code::Escape));
    if let Some(window) = app.get_webview_window("selection") {
        let _ = window.show();
        pin_capture_window(&window, host);
        let _ = window.set_focus();
    }
    let windows = capture::list_windows(host);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        wait_for_label(&app, "selection").await;
        emit_selection_windows(&app, host, &windows);
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        if app.state::<AppState>().selecting.load(Ordering::SeqCst) {
            emit_selection_windows(&app, host, &windows);
        }
    });
}

fn emit_selection_windows(app: &AppHandle, host: Rect, windows: &[capture::SnapWindow]) {
    let Some(window) = app.get_webview_window("selection") else {
        return;
    };
    let tao = window
        .inner_position()
        .unwrap_or(PhysicalPosition::new(host.x, host.y));
    let frame = device_frame(app, &window).unwrap_or(Rect {
        x: tao.x,
        y: tao.y,
        width: host.width,
        height: host.height,
    });
    let scale = window.scale_factor().unwrap_or(1.0);
    eprintln!(
        "[selection] webview origin {},{} tao {},{} device {}x{} host {},{} {}x{} scale {}",
        frame.x,
        frame.y,
        tao.x,
        tao.y,
        frame.width,
        frame.height,
        host.x,
        host.y,
        host.width,
        host.height,
        scale
    );
    let _ = window.emit(
        "selection-windows",
        json!({
            "windows": windows,
            "displayBounds": host,
            "webviewOrigin": { "x": frame.x, "y": frame.y },
            "deviceWidth": frame.width,
            "deviceHeight": frame.height,
            "scale": scale,
            "requiresAccessibility": false,
            "requiresScreenRecording": false
        }),
    );
}

/// X11 frame when we have learned the window id, otherwise tao's physical
/// position. tao multiplies GTK configure coordinates by `scale_factor`. On a
/// GTK that already reports device pixels that doubles a non-zero origin, and
/// the overlay then draws away from the selection. At 0,0 the mistake is hidden.
pub(crate) fn device_frame(app: &AppHandle, window: &WebviewWindow) -> Option<Rect> {
    #[cfg(target_os = "linux")]
    {
        if gtk_context_owner() {
            remember_device_xid(app, window);
        }
        if let Some(frame) = cached_x11_frame(app, window.label()) {
            return Some(frame);
        }
        if !gtk_context_owner() {
            if let Some(frame) = device_frame_on_main(app, window.label()) {
                return Some(frame);
            }
        }
    }
    tao_device_frame(window)
}

fn tao_device_frame(window: &WebviewWindow) -> Option<Rect> {
    let pos = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Rect {
        x: pos.x,
        y: pos.y,
        width: size.width.max(1) as i32,
        height: size.height.max(1) as i32,
    })
}

/// A real X11 origin wins over tao. `None` means the frame was not measured
/// yet, so the caller keeps tao's value.
pub(crate) fn prefer_frame_origin(x11: Option<i32>, tao: i32) -> i32 {
    x11.unwrap_or(tao)
}

#[cfg(target_os = "linux")]
fn gtk_context_owner() -> bool {
    gtk::glib::MainContext::default().is_owner()
}

#[cfg(target_os = "linux")]
fn cached_x11_frame(app: &AppHandle, label: &str) -> Option<Rect> {
    let xid = app
        .state::<AppState>()
        .device_xids
        .lock()
        .ok()
        .and_then(|guard| guard.get(label).copied())?;
    capture::x11_frame_of(xid)
}

#[cfg(target_os = "linux")]
fn device_frame_on_main(app: &AppHandle, label: &str) -> Option<Rect> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let app_main = app.clone();
    let label_main = label.to_string();
    let posted = app.run_on_main_thread(move || {
        if let Some(window) = app_main.get_webview_window(&label_main) {
            remember_device_xid(&app_main, &window);
        }
        let _ = tx.send(cached_x11_frame(&app_main, &label_main));
    });
    if posted.is_err() {
        return None;
    }
    rx.recv_timeout(std::time::Duration::from_millis(300))
        .ok()
        .flatten()
}

#[cfg(target_os = "linux")]
fn remember_device_xid(app: &AppHandle, window: &WebviewWindow) {
    use gtk::prelude::WidgetExt;

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let Some(gdk_window) = gtk_window.window() else {
        return;
    };
    cache_device_xid(app, window.label(), &gdk_window);
}

#[cfg(target_os = "linux")]
fn cache_device_xid(app: &AppHandle, label: &str, gdk_window: &gtk::gdk::Window) {
    let xid = gdk_x11_xid(gdk_window);
    if xid == 0 {
        return;
    }
    if let Ok(mut guard) = app.state::<AppState>().device_xids.lock() {
        guard.insert(label.to_string(), xid);
    }
}

#[cfg(target_os = "linux")]
fn gdk_x11_xid(window: &gtk::gdk::Window) -> u64 {
    use gtk::glib::ObjectType;

    #[link(name = "gdk-3")]
    unsafe extern "C" {
        fn gdk_x11_window_get_xid(window: *mut std::ffi::c_void) -> u64;
    }
    unsafe { gdk_x11_window_get_xid(window.as_ptr().cast()) }
}

#[cfg(target_os = "linux")]
fn x11_width_of(window: &gtk::gdk::Window) -> Option<f64> {
    let frame = capture::x11_frame_of(gdk_x11_xid(window))?;
    (frame.width > 1).then_some(f64::from(frame.width))
}

fn dismiss_overlay(app: &AppHandle) {
    set_overlay_visible(app, false);
    set_overlay_control(app, None);
    set_overlay_close(app, None);
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
        apply_overlay_input_shape(&window, None, None, 0.0);
    }
    close_selection(app);
}

pub(crate) fn set_overlay_visible(app: &AppHandle, visible: bool) {
    app.state::<AppState>()
        .overlay_visible
        .store(visible, Ordering::SeqCst);
}

pub(crate) fn set_overlay_control(app: &AppHandle, rect: Option<CssRect>) {
    if let Ok(mut guard) = app.state::<AppState>().overlay_control.lock() {
        *guard = rect;
    }
}

pub(crate) fn pass_through_overlay(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("overlay") {
            apply_overlay_input_shape(&window, None, None, 0.0);
        }
    });
}

fn apply_overlay_input_shape(
    window: &WebviewWindow,
    css: Option<CssRect>,
    close: Option<CssRect>,
    css_viewport_width: f64,
) {
    #[cfg(target_os = "linux")]
    {
        use cairo::{RectangleInt, Region};
        use gtk::prelude::{Cast, WidgetExt};

        let Ok(gtk_window) = window.gtk_window() else {
            return;
        };
        let Some(gdk_window) = gtk_window.window() else {
            return;
        };
        wire_overlay_clicks(gtk_window.upcast_ref(), &window.app_handle());
        cache_device_xid(&window.app_handle(), window.label(), &gdk_window);
        // GDK's logical width and the X11 width diverge under GDK_SCALE.
        // Some builds treat the input shape as logical pixels, others as
        // device pixels. Cover the visible 关闭 in both when they disagree.
        // At scale 1 the two rectangles are the same.
        let logical_width = f64::from(gdk_window.width().max(1));
        let css_width = if css_viewport_width.is_finite() && css_viewport_width > 1.0 {
            css_viewport_width
        } else {
            logical_width
        };
        let to_logical = logical_width / css_width;
        let to_device = x11_width_of(&gdk_window).unwrap_or(logical_width) / css_width;
        let logical_close = close.map(|rect| scale_css_rect(rect, to_logical));
        set_overlay_close(&window.app_handle(), logical_close);
        let region = match css {
            Some(rect) => {
                // Result mode adds 原文|译文 to the left of 关闭. Grow the hit
                // region to that full toolbar on the first report so a later
                // layout pass does not reshape under the pointer — GTK drops
                // the click that lands in the same moment as an input-shape change.
                let rects = overlay_input_rects(rect, to_logical, to_device);
                let next = shape_bounds(&rects).unwrap_or((0, 0, 1, 1));
                if overlay_shape_covers(&window.app_handle(), next) {
                    return;
                }
                set_overlay_shape(&window.app_handle(), Some(next));
                eprintln!(
                    "[overlay] input shape {} from css {:.1},{:.1} {:.1}x{:.1} logical x{to_logical:.3} device x{to_device:.3}",
                    rects
                        .iter()
                        .map(|item| format!("{},{} {}x{}", item.0, item.1, item.2, item.3))
                        .collect::<Vec<_>>()
                        .join(" + "),
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height
                );
                let cairo_rects: Vec<RectangleInt> = rects
                    .iter()
                    .copied()
                    .map(|(x, y, width, height)| RectangleInt::new(x, y, width, height))
                    .collect();
                Region::create_rectangles(&cairo_rects)
            }
            None => {
                set_overlay_shape(&window.app_handle(), None);
                Region::create_rectangle(&RectangleInt::new(0, 0, 1, 1))
            }
        };
        // WebKit's child window does not inherit a toplevel input shape, so
        // the right side of 关闭 can sit outside the region that receives the
        // first button press. Paint the same region on every child.
        paint_input_shape(&gdk_window, &region, 0, 0);
        paint_widget_input_shape(gtk_window.upcast_ref(), &region, 0, 0);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, css, close, css_viewport_width);
    }
}

/// Result mode is 原文|译文|关闭. The status bar is only 关闭, pinned to the
/// same right edge. Reserve the wider toolbar up front so the input shape
/// already contains 关闭 when the two extra buttons appear.
fn scale_css_rect(rect: CssRect, scale: f64) -> CssRect {
    CssRect {
        x: rect.x * scale,
        y: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
    }
}

fn scaled_shape(rect: CssRect, scale: f64, pad: f64) -> (i32, i32, i32, i32) {
    let x = ((rect.x - pad) * scale).floor() as i32;
    let y = ((rect.y - pad) * scale).floor() as i32;
    let width = ((rect.width + pad * 2.0) * scale).ceil().max(1.0) as i32;
    let height = ((rect.height + pad * 2.0) * scale).ceil().max(1.0) as i32;
    (x, y, width, height)
}

fn union_shape(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> (i32, i32, i32, i32) {
    let left = a.0.min(b.0);
    let top = a.1.min(b.1);
    let right = (a.0 + a.2).max(b.0 + b.2);
    let bottom = (a.1 + a.3).max(b.1 + b.3);
    (left, top, (right - left).max(1), (bottom - top).max(1))
}

/// Toolbar rectangle in the spaces GTK might use for an input shape.
/// Logical is `gdk_width / css`. Device is `x11_width / css`. When those
/// match, one rectangle is enough and the hit target does not grow a ghost.
pub(crate) fn overlay_input_rects(
    rect: CssRect,
    logical_scale: f64,
    device_scale: f64,
) -> Vec<(i32, i32, i32, i32)> {
    const PAD: f64 = 16.0;
    let target = toolbar_hit_target(rect);
    let logical = scaled_shape(target, logical_scale, PAD);
    if !device_scale.is_finite()
        || device_scale <= 0.0
        || (device_scale - logical_scale).abs() < 0.02
    {
        return vec![logical];
    }
    let device = scaled_shape(target, device_scale, PAD);
    if device == logical {
        vec![logical]
    } else {
        vec![logical, device]
    }
}

pub(crate) fn shape_bounds(rects: &[(i32, i32, i32, i32)]) -> Option<(i32, i32, i32, i32)> {
    let mut iter = rects.iter().copied();
    let first = iter.next()?;
    Some(iter.fold(first, union_shape))
}

/// `event.position()` is relative to the GDK window that received it. That
/// window is often a WebKit child, so add its origin minus the toplevel
/// origin. Both origins are GDK coordinates; `event.root()` is not, and on
/// some builds it is device pixels while the close rectangle is logical.
pub(crate) fn toplevel_point(
    local_x: f64,
    local_y: f64,
    win_x: i32,
    win_y: i32,
    top_x: i32,
    top_y: i32,
) -> (f64, f64) {
    (
        local_x + f64::from(win_x) - f64::from(top_x),
        local_y + f64::from(win_y) - f64::from(top_y),
    )
}

pub(crate) fn close_contains(x: f64, y: f64, rect: CssRect) -> bool {
    const PAD: f64 = 12.0;
    rect.width >= 1.0
        && rect.height >= 1.0
        && x >= rect.x - PAD
        && y >= rect.y - PAD
        && x < rect.x + rect.width + PAD
        && y < rect.y + rect.height + PAD
}

fn toolbar_hit_target(rect: CssRect) -> CssRect {
    const MIN_WIDTH: f64 = 248.0;
    const MIN_HEIGHT: f64 = 46.0;
    let width = rect.width.max(MIN_WIDTH);
    let height = rect.height.max(MIN_HEIGHT);
    CssRect {
        x: rect.x + rect.width - width,
        y: rect.y + rect.height - height,
        width,
        height,
    }
}

fn shape_already_covers(previous: (i32, i32, i32, i32), next: (i32, i32, i32, i32)) -> bool {
    let (px, py, pw, ph) = previous;
    let (nx, ny, nw, nh) = next;
    let covers = nx >= px - 1
        && ny >= py - 1
        && nx + nw <= px + pw + 1
        && ny + nh <= py + ph + 1;
    let not_much_larger = pw <= nw + 80 && ph <= nh + 48;
    covers && not_much_larger
}

fn overlay_shape_covers(app: &AppHandle, next: (i32, i32, i32, i32)) -> bool {
    app.state::<AppState>()
        .overlay_shape
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .is_some_and(|previous| shape_already_covers(previous, next))
}

fn set_overlay_shape(app: &AppHandle, shape: Option<(i32, i32, i32, i32)>) {
    if let Ok(mut guard) = app.state::<AppState>().overlay_shape.lock() {
        *guard = shape;
    }
}

#[cfg(target_os = "linux")]
fn paint_input_shape(window: &gtk::gdk::Window, region: &cairo::Region, dx: i32, dy: i32) {
    window.input_shape_combine_region(region, -dx, -dy);
    for child in window.children() {
        let (x, y) = child.position();
        paint_input_shape(&child, region, dx + x, dy + y);
    }
}

#[cfg(target_os = "linux")]
fn paint_widget_input_shape(widget: &gtk::Widget, region: &cairo::Region, dx: i32, dy: i32) {
    use gtk::prelude::{Cast, ContainerExt, WidgetExt};

    let shifted = region.copy();
    shifted.translate(-dx, -dy);
    widget.input_shape_combine_region(Some(&shifted));
    if let Some(container) = widget.downcast_ref::<gtk::Container>() {
        for child in container.children() {
            let alloc = child.allocation();
            paint_widget_input_shape(&child, region, dx + alloc.x(), dy + alloc.y());
        }
    }
}

#[cfg(target_os = "linux")]
fn wire_overlay_clicks(widget: &gtk::Widget, app: &AppHandle) {
    use gtk::glib::object::ObjectExt;
    use gtk::prelude::{Cast, ContainerExt, WidgetExt, WidgetExtManual};

    const KEY: &str = "ot-overlay-wired";
    let already = unsafe { widget.data::<bool>(KEY).is_some() };
    if !already {
        unsafe { widget.set_data(KEY, true) };
        // A focus-on-click window spends the first press moving focus and
        // never delivers it to the button. The toolbar can take the press.
        widget.set_focus_on_click(false);
        widget.add_events(
            gtk::gdk::EventMask::BUTTON_PRESS_MASK | gtk::gdk::EventMask::BUTTON_RELEASE_MASK,
        );
        let pressed = app.clone();
        widget.connect_button_press_event(move |_widget, event| {
            if event.button() != 1 || !close_button_pressed(&pressed, event) {
                return gtk::glib::Propagation::Proceed;
            }
            dismiss_overlay(&pressed);
            gtk::glib::Propagation::Stop
        });
        let released = app.clone();
        widget.connect_button_release_event(move |_widget, event| {
            if event.button() != 1 || !close_button_pressed(&released, event) {
                return gtk::glib::Propagation::Proceed;
            }
            dismiss_overlay(&released);
            gtk::glib::Propagation::Stop
        });
    }
    if let Some(container) = widget.downcast_ref::<gtk::Container>() {
        for child in container.children() {
            wire_overlay_clicks(&child, app);
        }
    }
}

#[cfg(target_os = "linux")]
fn close_button_pressed(app: &AppHandle, event: &gtk::gdk::EventButton) -> bool {
    let Some(rect) = app
        .state::<AppState>()
        .overlay_close
        .lock()
        .ok()
        .and_then(|guard| *guard)
    else {
        return false;
    };
    if rect.width < 1.0 || rect.height < 1.0 {
        return false;
    }
    let Some(gdk_window) = event.window() else {
        return false;
    };
    let top = gdk_window.toplevel();
    let (_status, top_x, top_y) = top.origin();
    let (_status, win_x, win_y) = gdk_window.origin();
    let (local_x, local_y) = event.position();
    let (x, y) = toplevel_point(local_x, local_y, win_x, win_y, top_x, top_y);
    close_contains(x, y, rect)
}

fn set_overlay_close(app: &AppHandle, rect: Option<CssRect>) {
    if let Ok(mut guard) = app.state::<AppState>().overlay_close.lock() {
        *guard = rect;
    }
}

fn close_selection(app: &AppHandle) {
    app.state::<AppState>()
        .selecting
        .store(false, Ordering::SeqCst);
    let _ = app
        .global_shortcut()
        .unregister(Shortcut::new(None, Code::Escape));
    if let Some(window) = app.get_webview_window("selection") {
        let _ = window.hide();
    }
}

pub fn place_window(app: &AppHandle, label: &str, rect: Rect) {
    if app.get_webview_window(label).is_none() {
        let url = if label == "selection" {
            "selection.html"
        } else {
            "overlay.html"
        };
        let title = if label == "selection" {
            "Selection"
        } else {
            "Overlay"
        };
        let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title(title)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .focused(label == "selection")
            .shadow(false)
            .build();
        if let Some(window) = app.get_webview_window(label) {
            prepare_capture_window(&window);
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        pin_capture_window(&window, rect);
        let _ = window.set_always_on_top(true);
    }
}

pub(crate) fn pin_capture_window(window: &WebviewWindow, rect: Rect) {
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)));
    let _ = window.set_size(Size::Physical(PhysicalSize::new(
        rect.width.max(1) as u32,
        rect.height.max(1) as u32,
    )));
}

fn prepare_capture_window(window: &WebviewWindow) {
    // A normal window is shoved below the top panel (about 29px here) while
    // keeping the full monitor height, so the shade starts in the wrong place
    // and the bottom hangs off the screen. An override-redirect splash covers
    // the monitor from its real origin, including the panel.
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::{Cast, GtkWindowExt, WidgetExt};
        let Ok(gtk_window) = window.gtk_window() else {
            return;
        };
        gtk_window.set_decorated(false);
        gtk_window.set_type_hint(gtk::gdk::WindowTypeHint::Splashscreen);
        if window.label() == "overlay" {
            // Keep keyboard focus available for Escape, but do not spend the
            // first mouse press on focusing the override-redirect window.
            gtk_window.set_focus_on_click(false);
        }
        if let Some(gdk_window) = gtk_window.window() {
            gdk_window.set_override_redirect(true);
        }
        let overlay_app = window.label() == "overlay";
        let label = window.label().to_string();
        let app = window.app_handle().clone();
        if let Some(gdk_window) = gtk_window.window() {
            cache_device_xid(&app, &label, &gdk_window);
        }
        gtk_window.connect_realize(move |widget| {
            if let Some(gdk_window) = widget.window() {
                gdk_window.set_override_redirect(true);
                cache_device_xid(&app, &label, &gdk_window);
            }
            if overlay_app {
                wire_overlay_clicks(widget.upcast_ref(), &app);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
    }
}

fn show_page(app: &AppHandle, file: &str, nav: Option<String>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let target = match nav.as_deref() {
        Some(nav @ ("forward" | "back")) => format!("{file}?nav={nav}"),
        _ => file.to_string(),
    };
    let script = format!(
        "window.location.assign({})",
        serde_json::to_string(&target).unwrap_or_else(|_| "\"translate.html\"".into())
    );
    let _ = window.eval(&script);
    let _ = window.show();
    let _ = window.set_focus();
}

fn launch_state(app: &AppHandle) -> Value {
    if cfg!(debug_assertions) {
        return json!({
            "launchAtLogin": false,
            "launchAtLoginAvailable": false,
            "launchAtLoginStatus": "unavailable_in_dev"
        });
    }
    match app.autolaunch().is_enabled() {
        Ok(enabled) => json!({
            "launchAtLogin": enabled,
            "launchAtLoginAvailable": true,
            "launchAtLoginStatus": if enabled { "enabled" } else { "disabled" }
        }),
        Err(_) => json!({
            "launchAtLogin": false,
            "launchAtLoginAvailable": false,
            "launchAtLoginStatus": "unsupported"
        }),
    }
}

fn update_launch(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("launch_at_login_unavailable_in_dev".into());
    }
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

async fn wait_for_label(app: &AppHandle, label: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let ready = app
            .state::<AppState>()
            .ready
            .lock()
            .map(|guard| guard.contains(label))
            .unwrap_or(false);
        if ready || tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
}

fn parse_run_rect(spec: &str) -> Option<Rect> {
    let parts: Vec<i32> = spec
        .split(',')
        .filter_map(|part| part.trim().parse().ok())
        .collect();
    if parts.len() != 4 {
        return None;
    }
    Some(Rect {
        x: parts[0],
        y: parts[1],
        width: parts[2],
        height: parts[3],
    })
}

#[derive(Deserialize)]
struct SelectionInput {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    click: bool,
    snapped: Option<String>,
}

fn resolve_selection(input: &SelectionInput) -> Option<Rect> {
    let rect = Rect {
        x: input.x.round() as i32,
        y: input.y.round() as i32,
        width: input.width.round() as i32,
        height: input.height.round() as i32,
    };
    if input.click {
        if input.snapped.as_deref() == Some("window") && rect.width > 6 && rect.height > 6 {
            Some(rect)
        } else {
            None
        }
    } else if rect.width >= 6 && rect.height >= 6 {
        Some(rect)
    } else {
        None
    }
}

#[tauri::command]
async fn selection_complete(app: AppHandle, rect: SelectionInput) {
    let Some(target) = resolve_selection(&rect) else {
        eprintln!(
            "[selection] ignored {:.1}x{:.1} click={}",
            rect.width, rect.height, rect.click
        );
        close_selection(&app);
        return;
    };
    eprintln!(
        "[selection] use {}x{} @ {},{}",
        target.width, target.height, target.x, target.y
    );
    if let Some(window) = app.get_webview_window("selection") {
        let _ = window.hide();
    }
    pipeline::run(app, target).await;
}

#[tauri::command]
fn selection_cancel(app: AppHandle) {
    close_selection(&app);
}

#[tauri::command]
fn overlay_close(app: AppHandle) {
    dismiss_overlay(&app);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HitRectInput {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    inner_width: f64,
    #[serde(default)]
    inner_height: f64,
    #[serde(default)]
    dpr: f64,
    #[serde(default)]
    close_x: f64,
    #[serde(default)]
    close_y: f64,
    #[serde(default)]
    close_width: f64,
    #[serde(default)]
    close_height: f64,
}

#[tauri::command]
fn overlay_set_hit_rect(app: AppHandle, rect: Option<HitRectInput>) {
    let Some(rect) = rect else {
        set_overlay_control(&app, None);
        return;
    };
    if !rect.width.is_finite() || !rect.height.is_finite() || rect.width < 1.0 || rect.height < 1.0
    {
        set_overlay_control(&app, None);
        return;
    }
    let css = CssRect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    };
    set_overlay_control(&app, Some(css));
    let close = if rect.close_width >= 1.0 && rect.close_height >= 1.0 {
        CssRect {
            x: rect.close_x,
            y: rect.close_y,
            width: rect.close_width,
            height: rect.close_height,
        }
    } else {
        CssRect {
            x: css.x + (css.width - 72.0).max(0.0),
            y: css.y,
            width: 72.0_f64.min(css.width),
            height: css.height,
        }
    };
    let viewport = rect.inner_width;
    let _ = rect.inner_height;
    let _ = rect.dpr;
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("overlay") {
            apply_overlay_input_shape(&window, Some(css), Some(close), viewport);
        }
    });
}

#[tauri::command(rename_all = "camelCase")]
fn overlay_set_ignore_mouse(app: AppHandle, should_ignore: Option<bool>) -> bool {
    let Some(window) = app.get_webview_window("overlay") else {
        return false;
    };
    if should_ignore.unwrap_or(true) {
        apply_overlay_input_shape(&window, None, None, 0.0);
    }
    true
}

#[tauri::command]
fn overlay_metrics(payload: Value) {
    eprintln!("[overlay:metrics] {payload}");
}

#[tauri::command]
fn settings_get(app: AppHandle) -> Value {
    let settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|error| error.into_inner().clone());
    settings.to_public(launch_state(&app))
}

#[tauri::command]
fn settings_set(app: AppHandle, settings: Value) -> Value {
    let state = app.state::<AppState>();
    let current = state
        .settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|error| error.into_inner().clone());
    let mut hotkey_error = None;
    let mut patch = settings.clone();
    if let Some(hotkey) = settings.get("hotkey").and_then(|value| value.as_str()) {
        if hotkey != current.hotkey {
            if let Err(error) = apply_hotkey(&app, hotkey) {
                hotkey_error = Some(error);
                if let Some(object) = patch.as_object_mut() {
                    object.remove("hotkey");
                }
            }
        }
    }
    let launch_error = settings
        .get("launchAtLogin")
        .and_then(|value| value.as_bool())
        .and_then(|enabled| update_launch(&app, enabled).err());
    let next = current.merged(&patch);
    let settings_file = settings_path(&app);
    if patch.get("apiKey").is_some() {
        if let Err(error) = secrets::store(&settings_file, &next.api_key) {
            return json!({
                "ok": false,
                "error": error,
                "settings": current.to_public(launch_state(&app))
            });
        }
    }
    let _ = next.save(&settings_file);
    if let Ok(mut guard) = state.settings.lock() {
        *guard = next.clone();
    }
    json!({
        "ok": hotkey_error.is_none() && launch_error.is_none(),
        "error": hotkey_error.or(launch_error),
        "settings": next.to_public(launch_state(&app))
    })
}

#[tauri::command]
fn move_to_applications() -> Value {
    #[cfg(not(target_os = "macos"))]
    {
        json!({ "ok": false, "error": "move_to_applications_unsupported" })
    }
    #[cfg(target_os = "macos")]
    {
        move_mac_bundle()
    }
}

#[cfg(target_os = "macos")]
fn move_mac_bundle() -> Value {
    if cfg!(debug_assertions) {
        return json!({ "ok": false, "error": "move_to_applications_unavailable_in_dev" });
    }
    let Ok(exe) = std::env::current_exe() else {
        return json!({ "ok": false, "error": "move_to_applications_failed" });
    };
    let Some(bundle) = exe
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
    else {
        return json!({ "ok": false, "error": "move_to_applications_failed" });
    };
    if bundle.starts_with("/Applications") {
        return json!({ "ok": true, "alreadyInApplicationsFolder": true });
    }
    let destination =
        std::path::Path::new("/Applications").join(bundle.file_name().unwrap_or_default());
    let status = std::process::Command::new("cp")
        .arg("-R")
        .arg(bundle)
        .arg(&destination)
        .status();
    match status {
        Ok(status) if status.success() => {
            let _ = std::process::Command::new("open").arg(&destination).spawn();
            json!({ "ok": true, "moved": true, "relaunching": true })
        }
        _ => json!({ "ok": false, "error": "move_to_applications_failed" }),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn repair_launch_at_login(app: AppHandle, open_at_login: Option<bool>) -> Value {
    if cfg!(debug_assertions) {
        return json!({ "ok": false, "error": "launch_at_login_unavailable_in_dev" });
    }
    let manager = app.autolaunch();
    if manager.disable().is_err() {
        return json!({ "ok": false, "error": "launch_at_login_repair_failed" });
    }
    if open_at_login.unwrap_or(false) && manager.enable().is_err() {
        return json!({ "ok": false, "error": "launch_at_login_repair_failed" });
    }
    json!({ "ok": true, "settings": settings_get(app) })
}

#[tauri::command]
fn open_settings(app: AppHandle, nav: Option<String>) -> bool {
    show_page(&app, "settings.html", nav);
    true
}

#[tauri::command]
fn open_translate(app: AppHandle, nav: Option<String>) -> bool {
    show_page(&app, "translate.html", nav);
    true
}

#[tauri::command]
fn hotkey_update(app: AppHandle, hotkey: String) -> Value {
    match apply_hotkey(&app, &hotkey) {
        Ok(()) => {
            let state = app.state::<AppState>();
            let mut settings = state
                .settings
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or_else(|error| error.into_inner().clone());
            settings.hotkey = hotkey.trim().to_string();
            let _ = settings.save(&settings_path(&app));
            if let Ok(mut guard) = state.settings.lock() {
                *guard = settings;
            }
            json!({ "ok": true, "cleared": hotkey.trim().is_empty() })
        }
        Err(error) => {
            let code = if error == "hotkey_requires_modifier" || error == "invalid_hotkey" {
                error
            } else {
                "hotkey_register_failed".into()
            };
            json!({ "ok": false, "error": code })
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn translate_text(
    app: AppHandle,
    text: String,
    source_lang: Option<String>,
    target_lang: Option<String>,
) -> Value {
    let text = text.trim().to_string();
    if text.is_empty() {
        return json!({ "ok": false, "error": "empty_text" });
    }
    let settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|error| error.into_inner().clone());
    let source = source_lang.unwrap_or(settings.source_lang.clone());
    let target = target_lang.unwrap_or(settings.target_lang.clone());
    let result = translate::translate(&settings.translation(), &[text], &source, &target).await;
    match result {
        Ok(items) => match items.into_iter().next() {
            Some(block) => match block.error {
                Some(error) => json!({ "ok": false, "error": error }),
                None => json!({ "ok": true, "text": block.text, "confidence": 1 }),
            },
            None => json!({ "ok": false, "error": "empty_text" }),
        },
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
async fn test_translation(app: AppHandle, config: Option<Value>) -> Value {
    let current = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|error| error.into_inner().clone());
    let next = match config {
        Some(config) => current.merged(&config),
        None => current,
    };
    match translate::test_connection(&next.translation()).await {
        Ok(message) => json!({ "ok": true, "message": message }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn clipboard_write_text(text: String) -> bool {
    let value = text.trim();
    if value.is_empty() {
        return false;
    }
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(value.to_string()))
        .is_ok()
}

#[tauri::command]
fn ui_listener_ready(window: WebviewWindow, state: tauri::State<'_, AppState>) {
    if let Ok(mut ready) = state.ready.lock() {
        ready.insert(window.label().to_string());
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    fn input(width: f64, height: f64, click: bool) -> SelectionInput {
        SelectionInput {
            x: 10.0,
            y: 20.0,
            width,
            height,
            click,
            snapped: None,
        }
    }

    #[test]
    fn drag_of_exactly_six_pixels_is_kept() {
        let rect = resolve_selection(&input(6.0, 48.0, false));
        assert_eq!(
            rect,
            Some(Rect {
                x: 10,
                y: 20,
                width: 6,
                height: 48
            })
        );
    }

    #[test]
    fn toolbar_hit_grows_left_to_cover_result_buttons() {
        let status = CssRect {
            x: 1000.0,
            y: 40.0,
            width: 72.0,
            height: 38.0,
        };
        let hit = toolbar_hit_target(status);
        assert!(hit.width >= 248.0);
        assert!((hit.x + hit.width - (status.x + status.width)).abs() < 0.1);
        assert!(hit.x < status.x);
        let result = CssRect {
            x: hit.x + 10.0,
            y: hit.y,
            width: hit.width - 20.0,
            height: hit.height,
        };
        let previous = (hit.x as i32, hit.y as i32, hit.width as i32, hit.height as i32);
        let next = (
            result.x as i32,
            result.y as i32,
            result.width as i32,
            result.height as i32,
        );
        assert!(shape_already_covers(previous, next));
        let moved = (next.0 + 400, next.1, next.2, next.3);
        assert!(!shape_already_covers(previous, moved));
    }

    #[test]
    fn close_hit_uses_the_child_window_offset() {
        let (x, y) = toplevel_point(10.0, 8.0, 400, 0, 0, 0);
        assert_eq!((x, y), (410.0, 8.0));
        let rect = CssRect {
            x: 400.0,
            y: 0.0,
            width: 80.0,
            height: 40.0,
        };
        assert!(close_contains(x, y, rect));
        // The child-local point is the 原文 side, not 关闭.
        assert!(!close_contains(10.0, 8.0, rect));
    }

    #[test]
    fn input_shape_covers_logical_and_device_when_scales_differ() {
        let css = CssRect {
            x: 800.0,
            y: 200.0,
            width: 192.0,
            height: 38.0,
        };
        let same = overlay_input_rects(css, 1.0, 1.0);
        assert_eq!(same.len(), 1);
        let fractional = overlay_input_rects(css, 1.5, 1.5);
        assert_eq!(fractional.len(), 1);
        let split = overlay_input_rects(css, 1.5, 3.0);
        assert_eq!(split.len(), 2);
        let bounds = shape_bounds(&split).expect("bounds");
        assert!(bounds.2 > fractional[0].2);
        assert!(bounds.3 > fractional[0].3);
        assert_eq!(prefer_frame_origin(Some(1920), 3840), 1920);
        assert_eq!(prefer_frame_origin(None, 3840), 3840);
    }

    #[test]
    fn smaller_drag_is_dropped() {
        assert!(resolve_selection(&input(5.0, 80.0, false)).is_none());
    }
}
