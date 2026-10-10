use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

pub fn resource_root(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("api").join("server.js").exists() {
            return dir;
        }
    }
    repo_root()
}

pub fn layout_script(app: &AppHandle) -> PathBuf {
    let packaged = resource_root(app).join("desktop").join("lib").join("render-layout.js");
    if packaged.exists() {
        packaged
    } else {
        repo_root().join("desktop").join("lib").join("render-layout.js")
    }
}

pub fn ocr_dir(app: &AppHandle) -> PathBuf {
    if is_packaged() {
        return data_dir(app).join("models").join("ocr");
    }
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models").join("ocr");
    if bundled.join("det.onnx").exists() {
        bundled
    } else {
        data_dir(app).join("models").join("ocr")
    }
}

pub fn vision_swift(app: &AppHandle) -> PathBuf {
    let packaged = resource_root(app).join("swift").join("vision_ocr.swift");
    if packaged.exists() {
        packaged
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("swift").join("vision_ocr.swift")
    }
}

pub fn node_binary() -> PathBuf {
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

pub fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| repo_root().join(".opentranslate-data"))
}
