mod capture;
mod cursor;
mod deepl;
mod embedded_api;
mod hotkey;
mod ocr_models;
mod paths;
mod pipeline;
mod settings;
mod translate;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use arboard::Clipboard;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use capture::Rect;
use settings::Settings;

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub ready: Mutex<HashSet<String>>,
    pub selecting: AtomicBool,
}

pub fn serve_api_blocking() -> i32 {
    embedded_api::serve_blocking()
}

pub fn run() {
    let settings = Settings::load(&settings_path_early());
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
            settings: Mutex::new(settings),
            ready: Mutex::new(HashSet::new()),
            selecting: AtomicBool::new(false),
        })
        .setup(|app| {
            configure_runtime(app.handle());
            if let Err(error) = install_tray(app.handle()) {
                eprintln!("[tray] {error}");
            }
            let hotkey = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|guard| guard.hotkey.clone())
                .unwrap_or_default();
            if let Err(error) = apply_hotkey(app.handle(), &hotkey) {
                eprintln!("[hotkey] {error}");
            } else if !hotkey.is_empty() {
                eprintln!("[hotkey] ready: {hotkey}");
            }
            embedded_api::spawn(api_paths(app.handle()));
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
            clipboard_write_text,
            ui_listener_ready
        ])
        .run(tauri::generate_context!())
        .expect("OpenTranslate failed to start");
}

fn api_paths(app: &AppHandle) -> embedded_api::ApiPaths {
    let resources = paths::resource_root(app);
    let data = paths::data_dir(app);
    let packaged = paths::is_packaged();
    let api_dir = {
        let bundled = resources.join("api");
        if bundled.join("local").join("argos_worker.py").exists() { bundled } else { paths::repo_root().join("api") }
    };
    let work_dir = if packaged { data.clone() } else { paths::repo_root() };
    let config_path = if packaged {
        let stored = data.join("config.json");
        if !stored.exists() {
            let _ = std::fs::create_dir_all(&data);
            let seed = api_dir.join("config.json");
            if seed.exists() {
                let _ = std::fs::copy(&seed, &stored);
            }
        }
        stored
    } else {
        api_dir.join("config.json")
    };
    embedded_api::ApiPaths {
        usage_path: if packaged { data.join("usage.json") } else { api_dir.join("usage.json") },
        dotenv_path: if packaged { data.join(".env") } else { paths::repo_root().join(".env") },
        api_dir,
        work_dir,
        config_path,
    }
}

fn configure_runtime(app: &AppHandle) {
    std::env::set_var("OPENTRANSLATE_OCR_DIR", paths::ocr_dir(app));
    std::env::set_var("OPENTRANSLATE_VISION_SWIFT", paths::vision_swift(app));
}

fn settings_path_early() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return std::path::PathBuf::from(dir).join("com.opentranslate.desktop").join("settings.json");
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

fn install_tray(app: &AppHandle) -> Result<(), String> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../assets/tray-template-18.png"))
        .map_err(|error| error.to_string())?;
    let translate = MenuItem::with_id(app, "translate", "手动翻译", true, None::<&str>).map_err(|error| error.to_string())?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>).map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&translate, &settings, &quit]).map_err(|error| error.to_string())?;
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
    shortcuts.unregister_all().map_err(|error| error.to_string())?;
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
    if app.state::<AppState>().selecting.swap(true, Ordering::SeqCst) {
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
    let _ = app.global_shortcut().register(Shortcut::new(None, Code::Escape));
    if let Some(window) = app.get_webview_window("selection") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let windows = capture::list_windows(host);
    let payload = json!({
        "windows": windows,
        "displayBounds": host,
        "requiresAccessibility": false,
        "requiresScreenRecording": false
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        wait_for_label(&app, "selection").await;
        if let Some(window) = app.get_webview_window("selection") {
            let _ = window.emit("selection-windows", payload);
        }
    });
}

fn dismiss_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }
    close_selection(app);
}

fn close_selection(app: &AppHandle) {
    app.state::<AppState>().selecting.store(false, Ordering::SeqCst);
    let _ = app.global_shortcut().unregister(Shortcut::new(None, Code::Escape));
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
        let title = if label == "selection" { "Selection" } else { "Overlay" };
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
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)));
        let _ = window.set_size(Size::Physical(PhysicalSize::new(
            rect.width.max(1) as u32,
            rect.height.max(1) as u32,
        )));
        let _ = window.set_always_on_top(true);
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
    let script = format!("window.location.assign({})", serde_json::to_string(&target).unwrap_or_else(|_| "\"translate.html\"".into()));
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
    let parts: Vec<i32> = spec.split(',').filter_map(|part| part.trim().parse().ok()).collect();
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
    } else if rect.width > 6 && rect.height > 6 {
        Some(rect)
    } else {
        None
    }
}

#[tauri::command]
async fn selection_complete(app: AppHandle, rect: SelectionInput) {
    let Some(target) = resolve_selection(&rect) else {
        close_selection(&app);
        return;
    };
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

#[tauri::command(rename_all = "camelCase")]
fn overlay_set_ignore_mouse(app: AppHandle, should_ignore: Option<bool>) -> bool {
    let Some(window) = app.get_webview_window("overlay") else {
        return false;
    };
    window.set_ignore_cursor_events(should_ignore.unwrap_or(true)).is_ok()
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
    let _ = next.save(&settings_path(&app));
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
    let Some(bundle) = exe.parent().and_then(|path| path.parent()).and_then(|path| path.parent()) else {
        return json!({ "ok": false, "error": "move_to_applications_failed" });
    };
    if bundle.starts_with("/Applications") {
        return json!({ "ok": true, "alreadyInApplicationsFolder": true });
    }
    let destination = std::path::Path::new("/Applications").join(bundle.file_name().unwrap_or_default());
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
async fn translate_text(app: AppHandle, text: String, source_lang: Option<String>, target_lang: Option<String>) -> Value {
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
    let source = source_lang.unwrap_or(settings.source_lang);
    let target = target_lang.unwrap_or(settings.target_lang);
    let result = if settings.engine == "llm" {
        translate::translate_with_llm(&settings.llm_api_url, &settings.llm_api_key, &settings.llm_model, &[text], &source, &target).await
    } else {
        embedded_api::wait_until_ready().await;
        translate::translate_texts(&settings.translation_api_url, &[text], &source, &target).await
    };
    match result {
        Ok(items) => json!({ "ok": true, "text": items.first().cloned().unwrap_or_default(), "confidence": 1 }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn clipboard_write_text(text: String) -> bool {
    let value = text.trim();
    if value.is_empty() {
        return false;
    }
    Clipboard::new().and_then(|mut clipboard| clipboard.set_text(value.to_string())).is_ok()
}

#[tauri::command]
fn ui_listener_ready(window: WebviewWindow, state: tauri::State<'_, AppState>) {
    if let Ok(mut ready) = state.ready.lock() {
        ready.insert(window.label().to_string());
    }
}
