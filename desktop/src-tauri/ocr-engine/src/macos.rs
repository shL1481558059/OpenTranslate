use super::{BBox, OcrBlock, OcrOutput};
use image::RgbaImage;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Deserialize)]
struct VisionFile {
    #[serde(rename = "imageWidth")]
    image_width: u32,
    #[serde(rename = "imageHeight")]
    image_height: u32,
    blocks: Vec<VisionBlock>,
}

#[derive(Deserialize)]
struct VisionBlock {
    text: String,
    lines: Option<Vec<String>>,
    bbox: VisionBox,
}

#[derive(Deserialize)]
struct VisionBox {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

pub fn recognize(image: &RgbaImage) -> Result<OcrOutput, String> {
    let path = std::env::temp_dir().join(format!("opentranslate-ocr-{}.png", std::process::id()));
    image.save(&path).map_err(|error| error.to_string())?;
    let binary = ensure_helper()?;
    let output = Command::new(&binary)
        .arg(&path)
        .output()
        .map_err(|error| format!("Apple Vision helper failed: {error}"))?;
    let _ = std::fs::remove_file(&path);
    if !output.status.success() {
        return Err(format!(
            "Apple Vision helper exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let parsed: VisionFile = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Apple Vision JSON: {error}"))?;
    let width = parsed.image_width.max(1) as f32;
    let height = parsed.image_height.max(1) as f32;
    let blocks = parsed
        .blocks
        .into_iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let text = block.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let x = (block.bbox.x * width).round().max(0.0) as i32;
            let pixel_height = (block.bbox.height * height).round().max(1.0);
            let y = ((1.0 - block.bbox.y - block.bbox.height) * height)
                .round()
                .max(0.0) as i32;
            let w = (block.bbox.width * width).round().max(1.0) as i32;
            Some(OcrBlock {
                id: format!("b{}", index + 1),
                lines: block
                    .lines
                    .unwrap_or_else(|| text.split('\n').map(|line| line.to_string()).collect()),
                text,
                bbox: BBox {
                    x,
                    y,
                    width: w,
                    height: pixel_height as i32,
                },
            })
        })
        .collect();
    Ok(OcrOutput {
        blocks,
        image_width: parsed.image_width,
        image_height: parsed.image_height,
        elapsed_ms: 0,
    })
}

fn ensure_helper() -> Result<PathBuf, String> {
    let cache = dirs_cache().join("vision_ocr");
    if cache.exists() {
        return Ok(cache);
    }
    let source = vision_source();
    if !source.exists() {
        return Err(format!("missing Vision helper source {}", source.display()));
    }
    std::fs::create_dir_all(cache.parent().unwrap()).map_err(|error| error.to_string())?;
    let status = Command::new("swiftc")
        .args(["-O", "-o"])
        .arg(&cache)
        .arg(&source)
        .status()
        .map_err(|error| format!("swiftc is required for Apple Vision OCR: {error}"))?;
    if !status.success() {
        return Err("failed to compile the Apple Vision OCR helper".into());
    }
    Ok(cache)
}

fn vision_source() -> PathBuf {
    if let Ok(path) = std::env::var("OPENTRANSLATE_VISION_SWIFT") {
        let path = PathBuf::from(path);
        if path.exists() {
            return path;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../swift/vision_ocr.swift")
}

fn dirs_cache() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Library/Caches/OpenTranslate");
    }
    std::env::temp_dir().join("opentranslate-cache")
}
