use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

pub fn target_triple() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        _ => "unknown",
    }
}

pub fn resource_root(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("api").join("server.js").exists() {
            return dir;
        }
    }
    repo_root()
}

pub fn api_server(app: &AppHandle) -> PathBuf {
    let packaged = resource_root(app).join("api").join("server.js");
    if packaged.exists() {
        packaged
    } else {
        repo_root().join("api").join("server.js")
    }
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
    let packaged = resource_root(app).join("models").join("ocr");
    if packaged.join("det.onnx").exists() {
        packaged
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models").join("ocr")
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
    if !is_packaged() {
        return PathBuf::from("node");
    }
    let file_name = if cfg!(windows) {
        format!("opentranslate-node-{}.exe", target_triple())
    } else {
        format!("opentranslate-node-{}", target_triple())
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let renamed = dir.join(if cfg!(windows) {
                "opentranslate-node.exe"
            } else {
                "opentranslate-node"
            });
            if renamed.exists() {
                return renamed;
            }
            let candidate = dir.join(&file_name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("node")
}

pub fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| repo_root().join(".opentranslate-data"))
}
