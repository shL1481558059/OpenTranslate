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
    // Keep the overlay hidden until the pixels are captured. Showing "翻译中…"
    // first paints that status into the screenshot, so the first line is covered
    // and the status itself comes back as an extra block.
    crate::place_window(&app, "overlay", host);
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }
    crate::set_overlay_visible(&app, false);
    tokio::time::sleep(CAPTURE_DELAY).await;

    let captured = match capture::capture_rect(rect) {
        Ok(image) => image.0,
        Err(error) => {
            reveal_overlay(&app, host);
            emit_status(
                &app,
                rect,
                host,
                &format!("截图失败：{error}"),
                0.88,
                "#ffe3e3",
            );
            return;
        }
    };
    let image = captured;
    reveal_overlay(&app, host);
    wait_ready(&app, "overlay").await;
    emit_status(&app, rect, host, "翻译中…", 0.35, "#ffffff");
    #[cfg(target_os = "linux")]
    {
        let dir = paths::ocr_dir(&app);
        if !crate::ocr_models::present(&dir) {
            emit_status(&app, rect, host, "正在下载 OCR 模型…", 0.35, "#ffffff");
        }
        if let Err(error) = crate::ocr_models::ensure(&dir).await {
            emit_status(
                &app,
                rect,
                host,
                &format!("识别失败：{error}"),
                0.88,
                "#ffe3e3",
            );
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
            emit_status(
                &app,
                rect,
                host,
                &format!("识别失败：{error}"),
                0.88,
                "#ffe3e3",
            );
            return;
        }
        Err(error) => {
            emit_status(
                &app,
                rect,
                host,
                &format!("识别失败：{error}"),
                0.88,
                "#ffe3e3",
            );
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
    for block in &recognized.blocks {
        eprintln!("[ocr] {}", block.text.replace('\n', " / "));
    }
    let kept = recognized
        .blocks
        .iter()
        .filter(|block| meaningful_ocr(&block.text))
        .cloned()
        .collect::<Vec<_>>();
    if kept.is_empty() {
        emit_status(&app, rect, host, "未识别到文字", 0.88, "#ffffff");
        return;
    }

    let scale_x = recognized.image_width as f64 / rect.width.max(1) as f64;
    let scale_y = recognized.image_height as f64 / rect.height.max(1) as f64;
    let scaled = kept
        .iter()
        .map(|block| scale_block(block, scale_x, scale_y))
        .collect::<Vec<_>>();
    let settings = current_settings(&app);
    let texts = scaled
        .iter()
        .map(|block| {
            block
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect::<Vec<_>>();
    let translated = translate::translate(
        &settings.translation(),
        &texts,
        &settings.source_lang,
        &settings.target_lang,
    )
    .await;
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
            let outcome = translated.get(index);
            let failed = outcome.is_some_and(|item| item.error.is_some());
            let text = outcome
                .map(|item| item.error.clone().unwrap_or_else(|| item.text.clone()))
                .unwrap_or_default();
            json!({
                "id": block.get("id").and_then(|value| value.as_str()).unwrap_or(""),
                "translatedText": text,
                "failed": failed
            })
        })
        .collect::<Vec<_>>();
    let mut laid_out = crate::layout::render(&scaled, &items, json!(rect), json!(host));
    let compact = laid_out
        .get("blocks")
        .and_then(|value| value.as_array())
        .map(|blocks| {
            blocks.iter().any(|block| {
                block
                    .pointer("/styleHint/layoutMode")
                    .and_then(|value| value.as_str())
                    == Some("compact-mask-replace")
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
    mark_failed_blocks(&mut laid_out, &items);
    emit_overlay(&app, laid_out);
}

fn reveal_overlay(app: &AppHandle, _host: Rect) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.show();
        let _ = window.set_ignore_cursor_events(true);
    }
    crate::set_overlay_visible(app, true);
    crate::ensure_overlay_pointer(app);
}

fn meaningful_ocr(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.chars().any(|ch| ch.is_alphanumeric()) {
        return false;
    }
    let compact: String = trimmed
        .chars()
        .filter(|ch| !ch.is_whitespace() && !matches!(ch, '.' | '。' | '…' | '!' | '！'))
        .collect();
    !matches!(compact.as_str(), "翻译中" | "正在下载OCR模型")
}

fn mark_failed_blocks(payload: &mut Value, items: &[Value]) {
    let failed = items
        .iter()
        .filter(|item| item.get("failed").and_then(|value| value.as_bool()) == Some(true))
        .map(|item| {
            item.get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect::<Vec<_>>();
    let Some(blocks) = payload
        .get_mut("blocks")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for block in blocks {
        let id = block
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if failed.iter().any(|item| item == id) {
            if let Some(hint) = block
                .get_mut("styleHint")
                .and_then(|value| value.as_object_mut())
            {
                hint.insert("color".into(), json!("#ffe3e3"));
                hint.insert("background".into(), json!("rgba(80, 16, 16, 0.82)"));
            }
        }
    }
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

fn apply_sampled_colors(
    payload: &mut Value,
    image: &RgbaImage,
    blocks: &[Value],
    scale_x: f64,
    scale_y: f64,
) {
    let Some(rendered) = payload
        .get_mut("blocks")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for block in rendered {
        let id = block
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let Some(source) = blocks
            .iter()
            .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(id))
        else {
            continue;
        };
        let Some(bbox) = source.get("bbox") else {
            continue;
        };
        let rect = Rect {
            x: (bbox
                .get("x")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0)
                * scale_x)
                .round() as i32,
            y: (bbox
                .get("y")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0)
                * scale_y)
                .round() as i32,
            width: (bbox
                .get("width")
                .and_then(|value| value.as_f64())
                .unwrap_or(1.0)
                * scale_x)
                .round()
                .max(1.0) as i32,
            height: (bbox
                .get("height")
                .and_then(|value| value.as_f64())
                .unwrap_or(1.0)
                * scale_y)
                .round()
                .max(1.0) as i32,
        };
        if let Some(color) = capture::average_color(image, rect) {
            let hint = block
                .as_object_mut()
                .and_then(|object| object.get_mut("styleHint"));
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
    let luminance =
        (0.2126 * color[0] as f64 + 0.7152 * color[1] as f64 + 0.0722 * color[2] as f64) / 255.0;
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
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
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

fn emit_overlay(app: &AppHandle, mut payload: Value) {
    compensate_frame(app, &mut payload);
    remember_controls(app, &payload);
    if let Some(window) = app.get_webview_window("overlay") {
        if let Err(error) = window.emit("overlay-render", payload) {
            eprintln!("[overlay] emit failed: {error}");
        }
    }
}

fn compensate_frame(app: &AppHandle, payload: &mut Value) {
    let Some(window) = app.get_webview_window("overlay") else {
        return;
    };
    let Ok(inner) = window.inner_position() else {
        return;
    };
    let origin_x = payload
        .get("overlayBounds")
        .and_then(|value| value.get("x"))
        .and_then(|value| value.as_i64())
        .unwrap_or(0) as i32;
    let origin_y = payload
        .get("overlayBounds")
        .and_then(|value| value.get("y"))
        .and_then(|value| value.as_i64())
        .unwrap_or(0) as i32;
    let dx = origin_x - inner.x;
    let dy = origin_y - inner.y;
    if dx == 0 && dy == 0 {
        return;
    }
    for key in ["selectionRect", "controlRect"] {
        let Some(rect) = payload.get_mut(key).and_then(|value| value.as_object_mut()) else {
            continue;
        };
        if let Some(x) = rect.get("x").and_then(|value| value.as_f64()) {
            rect.insert("x".into(), json!(x + dx as f64));
        }
        if let Some(y) = rect.get("y").and_then(|value| value.as_f64()) {
            rect.insert("y".into(), json!(y + dy as f64));
        }
    }
}

fn remember_controls(app: &AppHandle, payload: &Value) {
    let Some(control) = payload.get("controlRect") else {
        return;
    };
    let width = control
        .get("width")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let height = control
        .get("height")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    if width < 1.0 || height < 1.0 {
        crate::set_overlay_control(app, None);
        return;
    }
    crate::set_overlay_control(
        app,
        Some(crate::capture::CssRect {
            x: control.get("x").and_then(|value| value.as_f64()).unwrap_or(0.0),
            y: control.get("y").and_then(|value| value.as_f64()).unwrap_or(0.0),
            width,
            height,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::meaningful_ocr;

    #[test]
    fn blank_and_status_chrome_are_not_text() {
        assert!(!meaningful_ocr(""));
        assert!(!meaningful_ocr("..."));
        assert!(!meaningful_ocr("翻译中…"));
        assert!(!meaningful_ocr("翻译中."));
        assert!(!meaningful_ocr("正在下载 OCR 模型…"));
        assert!(meaningful_ocr(
            "Hello world, this is a screenshot translation tool."
        ));
        assert!(meaningful_ocr("今天天气很好"));
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
