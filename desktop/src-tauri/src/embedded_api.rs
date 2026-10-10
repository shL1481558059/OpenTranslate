use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::deepl;

static READY: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct ApiPaths {
    pub api_dir: PathBuf,
    pub work_dir: PathBuf,
    pub config_path: PathBuf,
    pub usage_path: PathBuf,
    pub dotenv_path: PathBuf,
}

impl ApiPaths {
    pub fn development() -> Self {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        Self {
            api_dir: repo.join("api"),
            work_dir: repo.clone(),
            config_path: repo.join("api").join("config.json"),
            usage_path: repo.join("api").join("usage.json"),
            dotenv_path: repo.join(".env"),
        }
    }
}

struct ApiState {
    paths: ApiPaths,
    startup_env: HashMap<String, String>,
    external_admin_token: String,
    config: Mutex<Value>,
    usage: Mutex<u64>,
    argos: Mutex<Option<Worker>>,
    marian: Mutex<Option<Worker>>,
}

struct Worker {
    child: Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

pub fn serve_blocking() -> i32 {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[api] {error}");
            return 1;
        }
    };
    if let Err(error) = runtime.block_on(serve(ApiPaths::development())) {
        eprintln!("[api] {error}");
        return 1;
    }
    0
}

pub fn spawn(paths: ApiPaths) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(paths).await {
            eprintln!("[api] {error}");
        }
    });
}

pub async fn wait_until_ready() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    for _ in 0..40 {
        if READY.load(Ordering::Relaxed) || client.get("http://127.0.0.1:8787/v2/languages").send().await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    eprintln!("[api] timed out waiting for /v2/languages");
}

pub async fn serve(paths: ApiPaths) -> Result<(), String> {
    load_dotenv(&paths.dotenv_path);
    let startup_env = capture_startup_env();
    let external_admin_token = std::env::var("ADMIN_TOKEN").unwrap_or_default().trim().to_string();
    let config = load_config(&paths, &startup_env, &external_admin_token);
    apply_runtime_env(&config);
    let usage = load_usage(&paths.usage_path);
    let host = std::env::var("TRANSLATION_API_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("TRANSLATION_API_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let address = format!("{host}:{port}");
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("[api] port already in use: {address}");
            READY.store(true, Ordering::Relaxed);
            return Ok(());
        }
        Err(error) => return Err(format!("failed to bind {address}: {error}")),
    };
    let bound = listener.local_addr().map_err(|error| error.to_string())?;
    eprintln!("[api] listening on http://{bound}");
    let state = std::sync::Arc::new(ApiState {
        paths,
        startup_env,
        external_admin_token,
        config: Mutex::new(config),
        usage: Mutex::new(usage),
        argos: Mutex::new(None),
        marian: Mutex::new(None),
    });
    let app = Router::new().fallback(any(dispatch)).with_state(state);
    READY.store(true, Ordering::Relaxed);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .map_err(|error| error.to_string())
}

async fn dispatch(
    State(state): State<std::sync::Arc<ApiState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path();
    let query: Query<HashMap<String, String>> = Query::try_from_uri(&uri).unwrap_or_else(|_| Query(HashMap::new()));
    if method == Method::GET && path == "/health" {
        return json_status(200, json!({ "ok": true, "service": "translation-api" }));
    }
    if method == Method::GET && (path == "/admin" || path == "/admin/") {
        if let Some(response) = reject_admin(&headers, &query, &state) {
            return response;
        }
        return send_file(&state.paths.api_dir.join("admin").join("index.html"), "text/html; charset=utf-8");
    }
    if method == Method::GET {
        if let Some(rest) = path.strip_prefix("/admin/assets/") {
            if let Some(response) = reject_admin(&headers, &query, &state) {
                return response;
            }
            let Some(file) = safe_join(&state.paths.api_dir.join("admin").join("assets"), rest) else {
                return json_status(404, json!({ "error_code": "not_found" }));
            };
            return send_file(&file, content_type(&file));
        }
    }
    if path == "/v1/config" {
        if let Some(response) = reject_admin(&headers, &query, &state) {
            return response;
        }
        if method == Method::GET {
            let config = state.config.lock().await.clone();
            return json_status(200, json!({ "ok": true, "config": config }));
        }
        if method == Method::PUT {
            let Ok(patch) = serde_json::from_slice::<Value>(&body) else {
                return json_status(400, json!({ "error_code": "bad_request", "message": "invalid JSON" }));
            };
            let mut config = state.config.lock().await;
            *config = update_config(&state, &*config, &patch);
            apply_runtime_env(&config);
            let _ = state.argos.lock().await.take();
            let _ = state.marian.lock().await.take();
            return json_status(200, json!({ "ok": true, "config": config.clone() }));
        }
    }
    if path.starts_with("/v1/models/") {
        if let Some(response) = reject_admin(&headers, &query, &state) {
            return response;
        }
        return models(&state, method, path, &query, &body).await;
    }
    if path == "/v2/translate" || path == "/v2/usage" || path == "/v2/languages" {
        return v2(&state, method, path, addr, &headers, &query, &body).await;
    }
    if path.starts_with("/v2/") {
        return json_status(404, deepl::error_payload("The requested resource could not be found.", Some("not_found")));
    }
    json_status(404, json!({ "error_code": "not_found" }))
}

async fn v2(
    state: &ApiState,
    method: Method,
    path: &str,
    addr: SocketAddr,
    headers: &HeaderMap,
    query: &Query<HashMap<String, String>>,
    body_bytes: &Bytes,
) -> Response {
    let remote = addr.ip().to_string();
    let authorization = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    if method == Method::POST && path == "/v2/translate" {
        if body_bytes.len() > deepl::MAX_BODY_BYTES {
            return deepl_error(413, "The request size exceeds the limit.");
        }
        let content_type = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("");
        let Ok(body) = deepl::parse_request_body(body_bytes, content_type) else {
            return deepl_error(400, "Bad request. Please check error message and your parameters.");
        };
        if let Err((status, message)) = deepl::authorize(&remote, authorization, query.get("auth_key").map(String::as_str), Some(&body)) {
            return deepl_error(status, &message);
        }
        let normalized = match deepl::normalize_translate_body(&body) {
            Ok(value) => value,
            Err((status, message)) => return deepl_error(status, &message),
        };
        let billed: u64 = normalized.texts.iter().map(|text| deepl::count_characters(text)).sum();
        let limit = character_limit();
        {
            let usage = *state.usage.lock().await;
            if usage.saturating_add(billed) > limit {
                return deepl_error(456, "Quota exceeded. The character limit has been reached.");
            }
        }
        match translate_texts(state, &normalized).await {
            Ok(translations) => {
                add_usage(state, billed).await;
                json_status(200, json!({ "translations": translations }))
            }
            Err(error) => {
                let (status, message, code) = deepl::provider_failure(&error);
                json_status(status, deepl::error_payload(&message, Some(code)))
            }
        }
    } else if method == Method::GET && path == "/v2/usage" {
        if let Err((status, message)) = deepl::authorize(&remote, authorization, query.get("auth_key").map(String::as_str), None) {
            return deepl_error(status, &message);
        }
        let count = *state.usage.lock().await;
        json_status(200, json!({ "character_count": count, "character_limit": character_limit() }))
    } else if method == Method::GET && path == "/v2/languages" {
        if let Err((status, message)) = deepl::authorize(&remote, authorization, query.get("auth_key").map(String::as_str), None) {
            return deepl_error(status, &message);
        }
        let kind = query.get("type").map(String::as_str).unwrap_or("source");
        if kind != "source" && kind != "target" {
            return deepl_error(400, "Value for 'type' not supported.");
        }
        json_status(200, Value::Array(deepl::list_languages(kind)))
    } else {
        deepl_error(405, "Bad request. Please check error message and your parameters.")
    }
}

async fn models(state: &ApiState, method: Method, path: &str, query: &Query<HashMap<String, String>>, body: &Bytes) -> Response {
    let config = state.config.lock().await.clone();
    if method == Method::GET && path == "/v1/models/installed" {
        let engine = normalize_engine(query.get("engine").map(String::as_str));
        let installed = if engine == "marian" { list_marian(&state.paths, &config) } else { list_argos(&state.paths, &config) };
        return json_status(200, json!({ "ok": true, "engine": engine, "installed": installed }));
    }
    if method == Method::GET && path == "/v1/models/available" {
        let engine = normalize_engine(query.get("engine").map(String::as_str));
        if engine == "marian" {
            return json_status(200, json!({ "ok": true, "engine": engine, "available": marian_recommended(), "cached": false }));
        }
        let refresh = query.get("refresh").map(|value| matches!(value.as_str(), "1" | "true" | "yes")).unwrap_or(false);
        if !refresh {
            return json_status(200, json!({ "ok": true, "engine": engine, "available": [], "cached": false, "cache_miss": true }));
        }
        match python_json(&state.paths, &config, &["list", &model_dir(&state.paths, &config).to_string_lossy()]).await {
            Ok(available) => json_status(200, json!({ "ok": true, "engine": engine, "available": available, "cached": false })),
            Err(error) => json_status(500, json!({ "ok": false, "error_code": "model_list_failed", "message": error, "engine": engine, "available": [] })),
        }
    } else if method == Method::POST && path == "/v1/models/download" {
        let Ok(payload) = serde_json::from_slice::<Value>(body) else {
            return json_status(400, json!({ "error_code": "bad_request", "message": "invalid JSON" }));
        };
        let engine = normalize_engine(payload.get("engine").and_then(|value| value.as_str()));
        if engine == "marian" {
            let model_id = payload.get("modelId").or_else(|| payload.get("model_id")).and_then(|value| value.as_str()).unwrap_or("").trim();
            if model_id.is_empty() {
                return json_status(400, json!({ "error_code": "bad_request", "message": "modelId is required" }));
            }
            let local_dir = marian_root(&state.paths, &config).join(encode_model_id(model_id));
            let request = json!({
                "action": "download",
                "model_id": model_id,
                "local_dir": local_dir,
                "device": config.pointer("/marian/device").and_then(|value| value.as_str()).unwrap_or("cpu"),
                "dtype": config.pointer("/marian/dtype").and_then(|value| value.as_str()).unwrap_or("float32")
            });
            return match marian_request(state, &config, request).await {
                Ok(_) => {
                    let _ = std::fs::create_dir_all(&local_dir);
                    let _ = std::fs::write(local_dir.join("model.json"), serde_json::to_vec_pretty(&json!({ "model_id": model_id })).unwrap_or_default());
                    json_status(200, json!({ "ok": true, "engine": engine, "result": { "ok": true, "model_id": model_id, "local_dir": local_dir } }))
                }
                Err(error) => json_status(500, json!({ "ok": false, "error_code": "model_download_failed", "message": error, "engine": engine })),
            };
        }
        let from = payload.get("from").and_then(|value| value.as_str()).unwrap_or("").trim();
        let to = payload.get("to").and_then(|value| value.as_str()).unwrap_or("").trim();
        if from.is_empty() || to.is_empty() {
            return json_status(400, json!({ "error_code": "bad_request", "message": "from/to required" }));
        }
        let dir = model_dir(&state.paths, &config);
        match python_status(&state.paths, &config, &["download", &dir.to_string_lossy(), from, to]).await {
            Ok(()) => {
                *state.argos.lock().await = None;
                json_status(200, json!({ "ok": true, "engine": engine, "result": { "ok": true } }))
            }
            Err(error) => json_status(500, json!({ "ok": false, "error_code": "model_download_failed", "message": error, "engine": engine })),
        }
    } else if method == Method::POST && path == "/v1/models/remove" {
        let Ok(payload) = serde_json::from_slice::<Value>(body) else {
            return json_status(400, json!({ "error_code": "bad_request", "message": "invalid JSON" }));
        };
        let engine = normalize_engine(payload.get("engine").and_then(|value| value.as_str()));
        if engine == "marian" {
            let model_id = payload.get("modelId").or_else(|| payload.get("model_id")).and_then(|value| value.as_str()).unwrap_or("").trim();
            if model_id.is_empty() {
                return json_status(400, json!({ "error_code": "bad_request", "message": "modelId is required" }));
            }
            let dir = marian_root(&state.paths, &config).join(encode_model_id(model_id));
            let _ = std::fs::remove_dir_all(&dir);
            *state.marian.lock().await = None;
            return json_status(200, json!({ "ok": true, "engine": engine, "result": { "ok": true } }));
        }
        let filename = payload.get("filename").and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
        let from = payload.get("from").and_then(|value| value.as_str()).unwrap_or("").trim();
        let to = payload.get("to").and_then(|value| value.as_str()).unwrap_or("").trim();
        let resolved = if !filename.is_empty() { filename } else if !from.is_empty() && !to.is_empty() { format!("{from}-{to}.argosmodel") } else { String::new() };
        if resolved.is_empty() {
            return json_status(400, json!({ "error_code": "bad_request", "message": "filename or from/to required" }));
        }
        let dir = model_dir(&state.paths, &config);
        let path = dir.join(&resolved);
        if !path.starts_with(&dir) {
            return json_status(400, json!({ "error_code": "invalid_model_path", "message": "invalid_model_path" }));
        }
        let _ = std::fs::remove_file(&path);
        *state.argos.lock().await = None;
        json_status(200, json!({ "ok": true, "engine": engine, "result": { "ok": true } }))
    } else {
        json_status(404, json!({ "error_code": "not_found" }))
    }
}

async fn translate_texts(state: &ApiState, body: &deepl::TranslateBody) -> Result<Vec<Value>, String> {
    let config = state.config.lock().await.clone();
    let mut groups: Vec<(String, String, Vec<(usize, String)>)> = Vec::new();
    for (index, text) in body.texts.iter().enumerate() {
        let detected = body
            .source_lang
            .clone()
            .unwrap_or_else(|| deepl::to_detected_source_language(deepl::detect_language(text).unwrap_or("en")));
        let engine_source = deepl::to_engine_lang(&detected);
        if let Some(group) = groups.iter_mut().find(|item| item.0 == detected && item.1 == engine_source) {
            group.2.push((index, text.clone()));
        } else {
            groups.push((detected, engine_source, vec![(index, text.clone())]));
        }
    }
    let target_engine = deepl::to_engine_lang(&body.target_lang);
    let mut outputs = vec![Value::Null; body.texts.len()];
    for (detected, engine_source, entries) in groups {
        let items: Vec<Value> = entries.iter().map(|(index, text)| json!({ "id": index.to_string(), "text": text })).collect();
        let translated = translate_engine(state, &config, &items, &engine_source, &target_engine).await?;
        for (index, text) in entries {
            let value = translated.get(&index.to_string()).cloned().unwrap_or_default();
            let mut row = json!({
                "detected_source_language": body.source_lang.clone().unwrap_or(detected.clone()),
                "text": value
            });
            if body.show_billed_characters {
                row["billed_characters"] = json!(deepl::count_characters(&text));
            }
            if let Some(model) = &body.model_type_used {
                row["model_type_used"] = json!(model);
            }
            if let Some(version) = &body.tag_handling_version {
                row["tag_handling_version"] = json!(version);
            }
            outputs[index] = row;
        }
    }
    Ok(outputs)
}

async fn translate_engine(state: &ApiState, config: &Value, items: &[Value], source: &str, target: &str) -> Result<HashMap<String, String>, String> {
    let engine = config.get("engine").and_then(|value| value.as_str()).unwrap_or("argos");
    if engine == "marian" {
        return translate_marian(state, config, items, source, target).await;
    }
    let mut direct = HashMap::new();
    let mut pending = Vec::new();
    for item in items {
        let id = item.get("id").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let text = item.get("text").and_then(|value| value.as_str()).unwrap_or("").to_string();
        if source == target || text.is_empty() {
            direct.insert(id, text);
        } else {
            pending.push(json!({ "id": id, "text": text }));
        }
    }
    if pending.is_empty() {
        return Ok(direct);
    }
    let response = argos_request(state, config, json!({ "items": pending, "source_lang": source, "target_lang": target })).await?;
    let rows = response.get("items").and_then(|value| value.as_array()).ok_or_else(|| "invalid_local_response".to_string())?;
    for row in rows {
        let id = row.get("id").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let text = row.get("translated_text").and_then(|value| value.as_str()).unwrap_or("").to_string();
        direct.insert(id, text);
    }
    Ok(direct)
}

async fn argos_request(state: &ApiState, config: &Value, payload: Value) -> Result<Value, String> {
    let timeout = Duration::from_millis(config_u64(config, &["local", "timeoutMs"], 20000));
    let mut guard = state.argos.lock().await;
    if guard.is_none() {
        *guard = Some(spawn_argos(&state.paths, config).await?);
    }
    let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let worker = guard.as_mut().ok_or_else(|| "worker missing".to_string())?;
    worker.stdin.write_all(line.as_bytes()).await.map_err(|error| error.to_string())?;
    worker.stdin.write_all(b"\n").await.map_err(|error| error.to_string())?;
    worker.stdin.flush().await.map_err(|error| error.to_string())?;
    let read = tokio::time::timeout(timeout, worker.lines.next_line()).await;
    let line = match read {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) => {
            *guard = None;
            return Err("worker closed".into());
        }
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => {
            *guard = None;
            return Err("timeout".into());
        }
    };
    let value: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
        return Err(error.to_string());
    }
    Ok(value)
}

async fn translate_marian(state: &ApiState, config: &Value, items: &[Value], source: &str, target: &str) -> Result<HashMap<String, String>, String> {
    let mut direct = HashMap::new();
    let mut pending = Vec::new();
    for item in items {
        let id = item.get("id").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let text = item.get("text").and_then(|value| value.as_str()).unwrap_or("").to_string();
        if source == target || text.is_empty() {
            direct.insert(id, text);
        } else {
            pending.push(json!({ "id": id, "text": text }));
        }
    }
    if pending.is_empty() {
        return Ok(direct);
    }
    let (model_id, local_dir) = select_marian(state, config, source, target)?;
    let response = marian_request(state, config, json!({
        "action": "translate",
        "items": pending,
        "model_id": model_id,
        "local_dir": local_dir,
        "device": config.pointer("/marian/device").and_then(|value| value.as_str()).unwrap_or("cpu"),
        "dtype": config.pointer("/marian/dtype").and_then(|value| value.as_str()).unwrap_or("float32"),
        "max_tokens": config.pointer("/marian/maxTokens").and_then(|value| value.as_u64()).unwrap_or(512),
        "source_lang": source,
        "target_lang": target
    })).await?;
    let rows = response.get("items").and_then(|value| value.as_array()).ok_or_else(|| "invalid_local_response".to_string())?;
    for row in rows {
        let id = row.get("id").and_then(|value| value.as_str()).unwrap_or("").to_string();
        let text = row.get("translated_text").and_then(|value| value.as_str()).unwrap_or("").to_string();
        direct.insert(id, text);
    }
    Ok(direct)
}

fn select_marian(state: &ApiState, config: &Value, source: &str, target: &str) -> Result<(String, PathBuf), String> {
    let configured = config.pointer("/marian/modelId").and_then(|value| value.as_str()).unwrap_or("").to_string();
    if let Some((from, to)) = extract_pair(&configured) {
        if from == source && to == target {
            return Ok((configured.clone(), marian_root(&state.paths, config).join(encode_model_id(&configured))));
        }
    }
    for entry in list_marian(&state.paths, config) {
        let model_id = entry.get("model_id").and_then(|value| value.as_str()).unwrap_or("");
        if let Some((from, to)) = extract_pair(model_id) {
            if from == source && to == target {
                let dir = entry.get("local_dir").and_then(|value| value.as_str()).map(PathBuf::from).unwrap_or_else(|| marian_root(&state.paths, config).join(encode_model_id(model_id)));
                return Ok((model_id.to_string(), dir));
            }
        }
    }
    Err(format!("no_translation_pair:{source}->{target}"))
}

fn extract_pair(model_id: &str) -> Option<(String, String)> {
    let lower = model_id.to_lowercase();
    let rest = lower.split("opus-mt-").nth(1)?;
    let mut parts = rest.split(|ch: char| !ch.is_ascii_alphabetic());
    let from = parts.next()?.to_string();
    let to = parts.next()?.to_string();
    if from.len() < 2 || to.len() < 2 { None } else { Some((from, to)) }
}

fn encode_model_id(model_id: &str) -> String {
    model_id.chars().map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '_' }).collect()
}

fn marian_root(paths: &ApiPaths, config: &Value) -> PathBuf {
    resolve_under(&paths.work_dir, config.pointer("/local/marianModelDir").and_then(|value| value.as_str()).unwrap_or("./models/marian"))
}

async fn marian_request(state: &ApiState, config: &Value, payload: Value) -> Result<Value, String> {
    let timeout = Duration::from_millis(config_u64(config, &["local", "timeoutMs"], 20000).saturating_mul(if payload.get("action").and_then(|value| value.as_str()) == Some("download") { 30 } else { 1 }));
    let mut guard = state.marian.lock().await;
    if guard.is_none() {
        *guard = Some(spawn_marian(&state.paths, config).await?);
    }
    let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let worker = guard.as_mut().ok_or_else(|| "worker missing".to_string())?;
    worker.stdin.write_all(line.as_bytes()).await.map_err(|error| error.to_string())?;
    worker.stdin.write_all(b"\n").await.map_err(|error| error.to_string())?;
    worker.stdin.flush().await.map_err(|error| error.to_string())?;
    let read = tokio::time::timeout(timeout, worker.lines.next_line()).await;
    match read {
        Ok(Ok(Some(line))) => {
            let value: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
            if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
                *guard = None;
                return Err(error.to_string());
            }
            Ok(value)
        }
        Ok(Ok(None)) => {
            *guard = None;
            Err("worker closed".into())
        }
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => {
            *guard = None;
            Err("timeout".into())
        }
    }
}

async fn spawn_marian(paths: &ApiPaths, config: &Value) -> Result<Worker, String> {
    let python = resolve_python(paths, config).await?;
    let worker_path = paths.api_dir.join("local").join("marian_worker.py");
    let model_dir = marian_root(paths, config);
    std::fs::create_dir_all(&model_dir).ok();
    let mut command = Command::new(&python);
    command
        .arg(&worker_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("LOCAL_MARIAN_MODEL_DIR", &model_dir)
        .env("MARIAN_MODEL_ID", config.pointer("/marian/modelId").and_then(|value| value.as_str()).unwrap_or(""))
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| format!("failed to start Marian worker: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "marian stdin missing".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "marian stdout missing".to_string())?;
    Ok(Worker { child, stdin, lines: BufReader::new(stdout).lines() })
}

async fn spawn_argos(paths: &ApiPaths, config: &Value) -> Result<Worker, String> {
    let python = resolve_python(paths, config).await?;
    let worker_path = paths.api_dir.join("local").join("argos_worker.py");
    let model_dir = model_dir(paths, config);
    std::fs::create_dir_all(&model_dir).ok();
    let xdg = model_dir.join(".xdg");
    let mut command = Command::new(&python);
    command
        .arg(&worker_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("LOCAL_TRANSLATE_MODEL_DIR", &model_dir)
        .env("XDG_DATA_HOME", xdg.join("data"))
        .env("XDG_CACHE_HOME", xdg.join("cache"))
        .env("XDG_CONFIG_HOME", xdg.join("config"))
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| format!("failed to start Argos worker: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "argos stdin missing".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "argos stdout missing".to_string())?;
    Ok(Worker { child, stdin, lines: BufReader::new(stdout).lines() })
}

async fn resolve_python(paths: &ApiPaths, config: &Value) -> Result<PathBuf, String> {
    let configured = config
        .pointer("/local/pythonPath")
        .and_then(|value| value.as_str())
        .unwrap_or("./.venv/bin/python");
    let path = resolve_under(&paths.work_dir, configured);
    if path.exists() {
        return Ok(path);
    }
    let venv = resolve_under(
        &paths.work_dir,
        config.pointer("/local/venvDir").and_then(|value| value.as_str()).unwrap_or("./.venv"),
    );
    let launcher = if cfg!(windows) { "python" } else { "python3" };
    let created = Command::new(launcher)
        .arg("-m")
        .arg("venv")
        .arg(&venv)
        .status()
        .await
        .map_err(|error| format!("无法创建 Python 虚拟环境：{error}"))?;
    if !created.success() {
        return Err("无法创建 Python 虚拟环境。请先安装 python3。".into());
    }
    let requirements = paths.api_dir.join("local").join("requirements.txt");
    let installed = Command::new(&path)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("-r")
        .arg(&requirements)
        .status()
        .await
        .map_err(|error| format!("安装翻译依赖失败：{error}"))?;
    if !installed.success() || !path.exists() {
        return Err(format!("安装翻译依赖失败。请检查 {} 和网络连接。", requirements.display()));
    }
    Ok(path)
}

async fn python_json(paths: &ApiPaths, config: &Value, args: &[&str]) -> Result<Value, String> {
    let python = resolve_python(paths, config).await?;
    let script = paths.api_dir.join("local").join("download_model.py");
    let output = Command::new(python)
        .arg(script)
        .args(args)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

async fn python_status(paths: &ApiPaths, config: &Value, args: &[&str]) -> Result<(), String> {
    let python = resolve_python(paths, config).await?;
    let script = paths.api_dir.join("local").join("download_model.py");
    let output = Command::new(python)
        .arg(script)
        .args(args)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn list_argos(paths: &ApiPaths, config: &Value) -> Vec<Value> {
    let dir = model_dir(paths, config);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".argosmodel") {
                return None;
            }
            let stem = name.trim_end_matches(".argosmodel");
            let (from, to) = stem.split_once('-').map(|(left, right)| (left, right)).unwrap_or(("", ""));
            Some(json!({ "from": from, "to": to, "filename": name }))
        })
        .collect()
}

fn list_marian(paths: &ApiPaths, config: &Value) -> Vec<Value> {
    let root = resolve_under(&paths.work_dir, config.pointer("/local/marianModelDir").and_then(|value| value.as_str()).unwrap_or("./models/marian"));
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let meta = entry.path().join("model.json");
            let raw = std::fs::read_to_string(meta).ok()?;
            let parsed: Value = serde_json::from_str(&raw).ok()?;
            let model_id = parsed.get("model_id")?.as_str()?.to_string();
            Some(json!({
                "model_id": model_id,
                "local_dir": entry.path(),
                "added_at": Value::Null,
                "from": Value::Null,
                "to": Value::Null
            }))
        })
        .collect()
}

fn marian_recommended() -> Value {
    json!([
        { "model_id": "Helsinki-NLP/opus-mt-en-zh", "from": "en", "to": "zh" },
        { "model_id": "Helsinki-NLP/opus-mt-zh-en", "from": "zh", "to": "en" }
    ])
}

fn model_dir(paths: &ApiPaths, config: &Value) -> PathBuf {
    resolve_under(
        &paths.work_dir,
        config.pointer("/local/argosModelDir").and_then(|value| value.as_str()).unwrap_or("./models/argos"),
    )
}

fn resolve_under(base: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() { path } else { base.join(path) }
}

fn normalize_engine(value: Option<&str>) -> String {
    match value.unwrap_or("").to_lowercase().as_str() {
        "marian" => "marian".into(),
        _ => "argos".into(),
    }
}

fn character_limit() -> u64 {
    let raw = std::env::var("DEEPL_CHARACTER_LIMIT").unwrap_or_default();
    if raw.trim().is_empty() {
        return 1_000_000_000_000;
    }
    raw.trim().parse::<u64>().unwrap_or(1_000_000_000_000)
}

async fn add_usage(state: &ApiState, count: u64) {
    if count == 0 {
        return;
    }
    let mut usage = state.usage.lock().await;
    *usage = usage.saturating_add(count);
    let payload = json!({ "character_count": *usage, "character_limit": character_limit() });
    let _ = std::fs::write(&state.paths.usage_path, serde_json::to_vec_pretty(&payload).unwrap_or_default());
}

fn load_usage(path: &Path) -> u64 {
    let Ok(raw) = std::fs::read_to_string(path) else { return 0 };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("character_count").and_then(|item| item.as_u64()))
        .unwrap_or(0)
}

fn load_config(paths: &ApiPaths, startup_env: &HashMap<String, String>, admin_token: &str) -> Value {
    let stored = std::fs::read_to_string(&paths.config_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));
    let mut config = defaults(startup_env);
    merge(&mut config, &stored);
    apply_startup_env(&mut config, startup_env, admin_token);
    config
}

fn update_config(state: &ApiState, current: &Value, patch: &Value) -> Value {
    let mut next = current.clone();
    merge(&mut next, patch);
    apply_startup_env(&mut next, &state.startup_env, &state.external_admin_token);
    if let Some(parent) = state.paths.config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&state.paths.config_path, serde_json::to_vec_pretty(&next).unwrap_or_default());
    next
}

fn defaults(env: &HashMap<String, String>) -> Value {
    json!({
        "engine": normalize_engine(env.get("TRANSLATION_ENGINE").map(String::as_str)),
        "local": {
            "argosModelDir": env.get("LOCAL_TRANSLATE_MODEL_DIR").cloned().unwrap_or_else(|| "./models/argos".into()),
            "marianModelDir": env.get("LOCAL_MARIAN_MODEL_DIR").cloned().unwrap_or_else(|| "./models/marian".into()),
            "pythonPath": env.get("LOCAL_TRANSLATE_PYTHON").cloned().unwrap_or_else(|| "./.venv/bin/python".into()),
            "venvDir": env.get("LOCAL_TRANSLATE_VENV").cloned().unwrap_or_else(|| "./.venv".into()),
            "timeoutMs": env.get("LOCAL_TRANSLATE_TIMEOUT_MS").and_then(|value| value.parse::<u64>().ok()).unwrap_or(20000)
        },
        "marian": {
            "modelId": env.get("MARIAN_MODEL_ID").cloned().unwrap_or_else(|| "Helsinki-NLP/opus-mt-en-zh".into()),
            "device": env.get("MARIAN_DEVICE").cloned().unwrap_or_else(|| "cpu".into()),
            "dtype": env.get("MARIAN_DTYPE").cloned().unwrap_or_else(|| "float32".into()),
            "maxTokens": env.get("MARIAN_MAX_TOKENS").and_then(|value| value.parse::<u64>().ok()).unwrap_or(512),
            "hfEndpoint": env.get("MARIAN_HF_ENDPOINT").or_else(|| env.get("HF_ENDPOINT")).cloned().unwrap_or_default(),
            "hfDisableSslVerify": false
        },
        "admin": { "token": env.get("ADMIN_TOKEN").cloned().unwrap_or_default() }
    })
}

fn apply_startup_env(config: &mut Value, env: &HashMap<String, String>, admin_token: &str) {
    if !admin_token.is_empty() {
        config["admin"]["token"] = json!(admin_token);
    }
    if let Some(engine) = env.get("TRANSLATION_ENGINE") {
        config["engine"] = json!(normalize_engine(Some(engine)));
    }
    assign_string(config, &["local", "argosModelDir"], env.get("LOCAL_TRANSLATE_MODEL_DIR"));
    assign_string(config, &["local", "marianModelDir"], env.get("LOCAL_MARIAN_MODEL_DIR"));
    assign_string(config, &["local", "pythonPath"], env.get("LOCAL_TRANSLATE_PYTHON"));
    assign_string(config, &["local", "venvDir"], env.get("LOCAL_TRANSLATE_VENV"));
    if let Some(value) = env.get("LOCAL_TRANSLATE_TIMEOUT_MS").and_then(|item| item.parse::<u64>().ok()) {
        config["local"]["timeoutMs"] = json!(value);
    }
    assign_string(config, &["marian", "modelId"], env.get("MARIAN_MODEL_ID"));
    assign_string(config, &["marian", "device"], env.get("MARIAN_DEVICE"));
    assign_string(config, &["marian", "dtype"], env.get("MARIAN_DTYPE"));
    if let Some(value) = env.get("MARIAN_MAX_TOKENS").and_then(|item| item.parse::<u64>().ok()) {
        config["marian"]["maxTokens"] = json!(value);
    }
}

fn assign_string(config: &mut Value, path: &[&str], value: Option<&String>) {
    let Some(value) = value else { return };
    let mut cursor = config;
    for (index, key) in path.iter().enumerate() {
        if index + 1 == path.len() {
            cursor[*key] = json!(value);
            return;
        }
        if !cursor[*key].is_object() {
            cursor[*key] = json!({});
        }
        cursor = &mut cursor[*key];
    }
}

fn apply_runtime_env(config: &Value) {
    if let Some(value) = config.pointer("/local/argosModelDir").and_then(|item| item.as_str()) {
        std::env::set_var("LOCAL_TRANSLATE_MODEL_DIR", value);
    }
    if let Some(value) = config.pointer("/local/marianModelDir").and_then(|item| item.as_str()) {
        std::env::set_var("LOCAL_MARIAN_MODEL_DIR", value);
    }
    if let Some(value) = config.pointer("/local/pythonPath").and_then(|item| item.as_str()) {
        std::env::set_var("LOCAL_TRANSLATE_PYTHON", value);
    }
    if let Some(value) = config.pointer("/local/venvDir").and_then(|item| item.as_str()) {
        std::env::set_var("LOCAL_TRANSLATE_VENV", value);
    }
}

fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(left), Value::Object(right)) => {
            for (key, value) in right {
                if value.is_null() {
                    continue;
                }
                if let Some(slot) = left.get_mut(key) {
                    merge(slot, value);
                } else {
                    left.insert(key.clone(), value.clone());
                }
            }
        }
        (left, right) => *left = right.clone(),
    }
}

fn config_u64(config: &Value, path: &[&str], fallback: u64) -> u64 {
    let mut cursor = config;
    for key in path {
        cursor = match cursor.get(*key) {
            Some(value) => value,
            None => return fallback,
        };
    }
    cursor.as_u64().unwrap_or(fallback)
}

fn capture_startup_env() -> HashMap<String, String> {
    [
        "TRANSLATION_ENGINE",
        "LOCAL_TRANSLATE_MODEL_DIR",
        "LOCAL_MARIAN_MODEL_DIR",
        "LOCAL_TRANSLATE_PYTHON",
        "LOCAL_TRANSLATE_VENV",
        "LOCAL_TRANSLATE_TIMEOUT_MS",
        "MARIAN_MODEL_ID",
        "MARIAN_DEVICE",
        "MARIAN_DTYPE",
        "MARIAN_MAX_TOKENS",
        "MARIAN_HF_ENDPOINT",
        "HF_ENDPOINT",
        "ADMIN_TOKEN",
    ]
    .into_iter()
    .filter_map(|key| {
        let value = std::env::var(key).ok()?;
        if value.trim().is_empty() { None } else { Some((key.to_string(), value)) }
    })
    .collect()
}

fn load_dotenv(path: &Path) {
    let Ok(raw) = std::fs::read_to_string(path) else { return };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let normalized = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((key, value)) = normalized.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || std::env::var(key).is_ok() {
            continue;
        }
        let mut value = value.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')) {
            value = value[1..value.len() - 1].to_string();
        }
        std::env::set_var(key, value);
    }
}

fn reject_admin(headers: &HeaderMap, query: &Query<HashMap<String, String>>, state: &ApiState) -> Option<Response> {
    let token = state.external_admin_token.clone();
    let expected = if !token.is_empty() {
        token
    } else {
        state.config.try_lock().ok().and_then(|config| config.pointer("/admin/token").and_then(|value| value.as_str()).map(|value| value.to_string())).unwrap_or_default()
    };
    if expected.is_empty() {
        return None;
    }
    let header = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    let provided = header.strip_prefix("Bearer ").unwrap_or("").trim();
    let provided = if provided.is_empty() {
        headers.get("x-admin-token").and_then(|value| value.to_str().ok()).unwrap_or("").trim()
    } else {
        provided
    };
    let provided = if provided.is_empty() { query.get("token").map(String::as_str).unwrap_or("") } else { provided };
    if provided == expected {
        None
    } else {
        Some(json_status(401, json!({ "error_code": "auth_required", "message": "ADMIN_TOKEN required" })))
    }
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.contains("..") || rel.contains('\\') {
        return None;
    }
    let path = root.join(rel);
    path.starts_with(root).then_some(path)
}

fn send_file(path: &Path, content_type: &str) -> Response {
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            *response.status_mut() = StatusCode::OK;
            if let Ok(value) = HeaderValue::from_str(content_type) {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response
        }
        Err(_) => json_status(404, json!({ "error_code": "not_found" })),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn json_status(status: u16, payload: Value) -> Response {
    let mut response = Response::new(Body::from(serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec())));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    if let Ok(value) = HeaderValue::from_str(&deepl::trace_id()) {
        response.headers_mut().insert(header::HeaderName::from_static("x-trace-id"), value);
    }
    response
}

fn deepl_error(status: u16, message: &str) -> Response {
    json_status(status, deepl::error_payload(message, Some(deepl::status_code_for(status))))
}

#[allow(dead_code)]
fn _keep_child(worker: &Worker) -> Option<u32> {
    worker.child.id()
}
