use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::Engine;
use image::{ExtendedColorType, ImageEncoder, Rgba, RgbaImage};
use ocr_engine::OcrBlock;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::{self, Rect};
use crate::paths;
use crate::settings::Settings;
use crate::translate;

const CAPTURE_DELAY: Duration = Duration::from_millis(280);

pub async fn run(app: AppHandle, rect: Rect) {
    let host = capture::monitor_at(rect.x, rect.y).unwrap_or(rect);
    crate::place_window(&app, "overlay", host);
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.show();
        let _ = window.set_ignore_cursor_events(true);
    }
    wait_ready(&app, "overlay").await;
    emit_status(&app, rect, host, "翻译中…", 0.35, "#ffffff");
    tokio::time::sleep(CAPTURE_DELAY).await;

    let captured = match capture::capture_rect(rect) {
        Ok(image) => image.0,
        Err(error) => {
            emit_status(&app, rect, host, &format!("截图失败：{error}"), 0.88, "#ffe3e3");
            return;
        }
    };
    let image = captured;
    #[cfg(target_os = "linux")]
    {
        let dir = paths::ocr_dir(&app);
        if !crate::ocr_models::present(&dir) {
            emit_status(&app, rect, host, "正在下载 OCR 模型…", 0.35, "#ffffff");
        }
        if let Err(error) = crate::ocr_models::ensure(&dir).await {
            emit_status(&app, rect, host, &format!("识别失败：{error}"), 0.88, "#ffe3e3");
            return;
        }
        std::env::set_var("OPENTRANSLATE_OCR_DIR", &dir);
    }
    let recognized = match tauri::async_runtime::spawn_blocking({
        let image = image.clone();
        move || ocr_engine::recognize_image(&image)
    })
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            emit_status(&app, rect, host, &format!("识别失败：{error}"), 0.88, "#ffe3e3");
            return;
        }
        Err(error) => {
            emit_status(&app, rect, host, &format!("识别失败：{error}"), 0.88, "#ffe3e3");
            return;
        }
    };
    eprintln!(
        "[ocr] {} blocks in {}ms ({}x{})",
        recognized.blocks.len(),
        recognized.elapsed_ms,
        recognized.image_width,
        recognized.image_height
    );
    if recognized.blocks.is_empty() {
        emit_status(&app, rect, host, "未识别到文本，请重新框选或换个区域试试。", 0.88, "#ffffff");
        return;
    }

    let scale_x = recognized.image_width as f64 / rect.width.max(1) as f64;
    let scale_y = recognized.image_height as f64 / rect.height.max(1) as f64;
    let scaled = recognized
        .blocks
        .iter()
        .map(|block| scale_block(block, scale_x, scale_y))
        .collect::<Vec<_>>();
    let settings = current_settings(&app);
    let texts = scaled
        .iter()
        .map(|block| block.get("text").and_then(|value| value.as_str()).unwrap_or("").to_string())
        .collect::<Vec<_>>();
    let translated = if settings.engine == "llm" {
        translate::translate_with_llm(
            &settings.llm_api_url,
            &settings.llm_api_key,
            &settings.llm_model,
            &texts,
            &settings.source_lang,
            &settings.target_lang,
        )
        .await
    } else {
        crate::embedded_api::wait_until_ready().await;
        translate::translate_texts(
            &settings.translation_api_url,
            &texts,
            &settings.source_lang,
            &settings.target_lang,
        )
        .await
    };
    let translated = match translated {
        Ok(items) => items,
        Err(error) => {
            let friendly = if error == "timeout" || error.to_ascii_lowercase().contains("timeout") {
                "翻译超时，请稍后重试。".to_string()
            } else {
                error
            };
            emit_status(&app, rect, host, &friendly, 0.88, "#ffe3e3");
            return;
        }
    };
    let items = scaled
        .iter()
        .enumerate()
        .map(|(index, block)| {
            json!({
                "id": block.get("id").and_then(|value| value.as_str()).unwrap_or(""),
                "translatedText": translated.get(index).cloned().unwrap_or_default()
            })
        })
        .collect::<Vec<_>>();
    let mut laid_out = match layout_with_node(&app, &scaled, &items, rect, host) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[layout] {error}");
            fallback_layout(&scaled, &items, rect, host)
        }
    };
    let compact = laid_out
        .get("blocks")
        .and_then(|value| value.as_array())
        .map(|blocks| {
            blocks.iter().any(|block| {
                block.pointer("/styleHint/layoutMode").and_then(|value| value.as_str()) == Some("compact-mask-replace")
            })
        })
        .unwrap_or(false);
    if compact {
        laid_out["mask"] = json!(true);
        laid_out["textOnly"] = json!(true);
        laid_out["maskOpacity"] = json!(0.35);
        laid_out["hasText"] = json!(true);
    } else {
        apply_sampled_colors(&mut laid_out, &image, &scaled, scale_x, scale_y);
        laid_out["snapshotDataUrl"] = json!(png_data_url(&image));
        laid_out["mask"] = json!(true);
        laid_out["textOnly"] = json!(true);
        laid_out["maskOpacity"] = json!(0.18);
        laid_out["hasText"] = json!(true);
    }
    laid_out["rect"] = json!(rect);
    emit_overlay(&app, laid_out);
}

fn current_settings(app: &AppHandle) -> Settings {
    app.state::<crate::AppState>()
        .settings
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|error| error.into_inner().clone())
}

fn scale_block(block: &OcrBlock, scale_x: f64, scale_y: f64) -> Value {
    json!({
        "id": block.id,
        "text": block.text,
        "lines": block.lines,
        "bbox": {
            "x": (block.bbox.x as f64 / scale_x).round() as i32,
            "y": (block.bbox.y as f64 / scale_y).round() as i32,
            "width": (block.bbox.width as f64 / scale_x).round().max(1.0) as i32,
            "height": (block.bbox.height as f64 / scale_y).round().max(1.0) as i32
        }
    })
}

fn layout_with_node(app: &AppHandle, blocks: &[Value], items: &[Value], rect: Rect, host: Rect) -> Result<Value, String> {
    let script = paths::layout_script(app);
    let node = paths::node_binary();
    let mut child = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("layout node: {error}"))?;
    let body = json!({
        "blocks": blocks,
        "items": items,
        "selectionRect": rect,
        "displayBounds": host
    });
    {
        let stdin = child.stdin.as_mut().ok_or_else(|| "layout stdin missing".to_string())?;
        stdin
            .write_all(serde_json::to_string(&body).unwrap_or_else(|_| "{}".into()).as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "layout exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("layout json: {error}"))
}

fn fallback_layout(blocks: &[Value], items: &[Value], rect: Rect, host: Rect) -> Value {
    let rendered = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let mut next = block.clone();
            let text = items
                .get(index)
                .and_then(|item| item.get("translatedText"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            next["text"] = json!(text);
            next["styleHint"] = json!({
                "fontSize": 16,
                "lineHeight": 1.2,
                "padding": 2,
                "background": "transparent",
                "color": "#ffffff",
                "textShadow": "0 1px 2px rgba(0,0,0,0.6)"
            });
            next
        })
        .collect::<Vec<_>>();
    json!({
        "blocks": rendered,
        "extraction": {
            "sourceText": blocks.iter().filter_map(|block| block.get("text").and_then(|value| value.as_str())).collect::<Vec<_>>().join("\n"),
            "translatedText": items.iter().filter_map(|item| item.get("translatedText").and_then(|value| value.as_str())).collect::<Vec<_>>().join("\n")
        },
        "overlayBounds": host,
        "selectionRect": relative(rect, host),
        "controlRect": relative(Rect { x: rect.x + rect.width - 260, y: rect.y - 36, width: 260, height: 36 }, host),
        "controlSide": "top"
    })
}

fn apply_sampled_colors(payload: &mut Value, image: &RgbaImage, blocks: &[Value], scale_x: f64, scale_y: f64) {
    let Some(rendered) = payload.get_mut("blocks").and_then(|value| value.as_array_mut()) else {
        return;
    };
    for block in rendered {
        let id = block.get("id").and_then(|value| value.as_str()).unwrap_or("");
        let Some(source) = blocks.iter().find(|item| item.get("id").and_then(|value| value.as_str()) == Some(id)) else {
            continue;
        };
        let Some(bbox) = source.get("bbox") else { continue };
        let rect = Rect {
            x: (bbox.get("x").and_then(|value| value.as_f64()).unwrap_or(0.0) * scale_x).round() as i32,
            y: (bbox.get("y").and_then(|value| value.as_f64()).unwrap_or(0.0) * scale_y).round() as i32,
            width: (bbox.get("width").and_then(|value| value.as_f64()).unwrap_or(1.0) * scale_x).round().max(1.0) as i32,
            height: (bbox.get("height").and_then(|value| value.as_f64()).unwrap_or(1.0) * scale_y).round().max(1.0) as i32,
        };
        if let Some(color) = capture::average_color(image, rect) {
            let hint = block.as_object_mut().and_then(|object| object.get_mut("styleHint"));
            if let Some(Value::Object(hint)) = hint {
                hint.insert("background".into(), json!(css_color(color)));
                hint.insert("color".into(), json!(text_color(color)));
                hint.insert("textShadow".into(), json!("none"));
            }
        }
    }
}

fn css_color(color: Rgba<u8>) -> String {
    format!("rgb({}, {}, {})", color[0], color[1], color[2])
}

fn text_color(color: Rgba<u8>) -> &'static str {
    let luminance = (0.2126 * color[0] as f64 + 0.7152 * color[1] as f64 + 0.0722 * color[2] as f64) / 255.0;
    if luminance > 0.6 {
        "#111111"
    } else {
        "#ffffff"
    }
}

fn png_data_url(image: &RgbaImage) -> String {
    let mut bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    if encoder
        .write_image(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgba8)
        .is_err()
    {
        return String::new();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn relative(rect: Rect, host: Rect) -> Rect {
    Rect {
        x: rect.x - host.x,
        y: rect.y - host.y,
        width: rect.width,
        height: rect.height,
    }
}

fn emit_status(app: &AppHandle, rect: Rect, host: Rect, message: &str, opacity: f64, color: &str) {
    let font = (rect.width.min(rect.height) as f64 * 0.06).clamp(12.0, 28.0) as i32;
    emit_overlay(
        app,
        json!({
            "rect": rect,
            "overlayBounds": host,
            "selectionRect": relative(rect, host),
            "controlRect": relative(Rect { x: rect.x + rect.width - 260, y: (rect.y - 36).max(host.y), width: 260, height: 36 }, host),
            "controlSide": "top",
            "hasText": false,
            "mask": true,
            "textOnly": true,
            "maskOpacity": opacity,
            "blocks": [{
                "id": if color == "#ffe3e3" { "error" } else { "status" },
                "bbox": { "x": 0, "y": 0, "width": rect.width, "height": rect.height },
                "text": message,
                "styleHint": {
                    "fontSize": font,
                    "lineHeight": 1.3,
                    "padding": (font as f64 * 0.6).max(8.0) as i32,
                    "background": "transparent",
                    "color": color,
                    "textShadow": "0 1px 2px rgba(0,0,0,0.6)",
                    "layout": "center"
                }
            }]
        }),
    );
}

fn emit_overlay(app: &AppHandle, payload: Value) {
    if let Some(window) = app.get_webview_window("overlay") {
        if let Err(error) = window.emit("overlay-render", payload) {
            eprintln!("[overlay] emit failed: {error}");
        }
    }
}

async fn wait_ready(app: &AppHandle, label: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let ready = app
            .state::<crate::AppState>()
            .ready
            .lock()
            .map(|guard| guard.iter().any(|item| item == label))
            .unwrap_or(false);
        if ready || tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}
