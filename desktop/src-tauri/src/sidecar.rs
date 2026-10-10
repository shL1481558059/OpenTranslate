use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::paths;

pub fn ensure_started(app: &AppHandle) {
    if port_open(8787) {
        eprintln!("[api] already listening on 127.0.0.1:8787");
        return;
    }
    let state = app.state::<crate::AppState>();
    if state.api.lock().ok().and_then(|guard| guard.as_ref().map(|child| child.id())).is_some() {
        return;
    }
    match spawn(app) {
        Ok(child) => {
            if let Ok(mut guard) = state.api.lock() {
                *guard = Some(child);
            }
        }
        Err(error) => eprintln!("[api] failed to start: {error}"),
    }
}

pub async fn wait_until_ready() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    for _ in 0..40 {
        if client.get("http://127.0.0.1:8787/v2/languages").send().await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    eprintln!("[api] timed out waiting for /v2/languages");
}

fn spawn(app: &AppHandle) -> Result<Child, String> {
    let server = paths::api_server(app);
    if !server.exists() {
        return Err(format!("missing {}", server.display()));
    }
    let node = paths::node_binary();
    let mut command = Command::new(&node);
    command
        .arg(&server)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("TRANSLATION_API_HOST", "127.0.0.1")
        .env("TRANSLATION_API_PORT", "8787");
    if paths::is_packaged() {
        let resources = paths::resource_root(app);
        let data = paths::data_dir(app);
        std::fs::create_dir_all(&data).ok();
        command
            .current_dir(&data)
            .env("SNAP_TRANSLATE_IS_PACKAGED", "1")
            .env("SNAP_TRANSLATE_RESOURCES_PATH", &resources);
        if std::env::var_os("LOCAL_TRANSLATE_MODEL_DIR").is_none() {
            command.env("LOCAL_TRANSLATE_MODEL_DIR", data.join("models").join("argos"));
        }
        if std::env::var_os("LOCAL_TRANSLATE_VENV").is_none() {
            command.env("LOCAL_TRANSLATE_VENV", data.join(".venv"));
        }
    } else {
        command.current_dir(paths::repo_root());
    }
    command.spawn().map_err(|error| format!("spawn {}: {error}", node.display()))
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}
