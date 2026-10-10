use super::{BBox, OcrBlock, OcrOutput};
use image::{imageops::FilterType, RgbaImage};
use ndarray::Array4;
use ort::session::Session;
use ort::value::TensorRef;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

const DET_LIMIT: u32 = 960;
const DET_THRESH: f32 = 0.3;
const BOX_THRESH: f32 = 0.45;
const REC_HEIGHT: u32 = 48;
// Real lines on the desktop samples sit around 0.95. Weak CTC peaks are how a
// blank crop turns into a dictionary word, so drop anything below this.
const REC_MIN_CONFIDENCE: f32 = 0.55;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

struct Engine {
    det: Session,
    rec: Session,
    keys: Vec<String>,
}

fn model_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OPENTRANSLATE_OCR_DIR") {
        let path = PathBuf::from(dir);
        if path.join("det.onnx").exists() {
            return path;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models/ocr")
}

fn load_engine() -> Result<Engine, String> {
    let dir = model_dir();
    let det_path = dir.join("det.onnx");
    let rec_path = dir.join("rec.onnx");
    let keys_path = dir.join("keys.txt");
    if !det_path.exists() || !rec_path.exists() || !keys_path.exists() {
        return Err(format!(
            "OCR models missing in {} (expected det.onnx, rec.onnx, keys.txt)",
            dir.display()
        ));
    }
    let det = Session::builder()
        .map_err(|error| error.to_string())?
        .with_intra_threads(4)
        .map_err(|error| error.to_string())?
        .commit_from_file(&det_path)
        .map_err(|error| format!("det model: {error}"))?;
    let rec = Session::builder()
        .map_err(|error| error.to_string())?
        .with_intra_threads(4)
        .map_err(|error| error.to_string())?
        .commit_from_file(&rec_path)
        .map_err(|error| format!("rec model: {error}"))?;
    let keys = std::fs::read_to_string(&keys_path)
        .map_err(|error| error.to_string())?
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let _ = (det_path, rec_path, keys_path);
    Ok(Engine { det, rec, keys })
}

fn engine() -> Result<MutexGuard<'static, Engine>, String> {
    static ENGINE: OnceLock<Mutex<Engine>> = OnceLock::new();
    if ENGINE.get().is_none() {
        let loaded = load_engine()?;
        let _ = ENGINE.set(Mutex::new(loaded));
    }
    ENGINE
        .get()
        .ok_or_else(|| "OCR engine failed to initialize".to_string())?
        .lock()
        .map_err(|error| error.to_string())
}

pub fn preload() -> Result<(), String> {
    engine().map(|_| ())
}

pub fn recognize(image: &RgbaImage) -> Result<OcrOutput, String> {
    let mut engine = engine()?;
    let boxes = detect(&mut engine, image)?;
    let mut blocks = Vec::new();
    for (index, bbox) in boxes.into_iter().enumerate() {
        let (text, confidence) = recognize_box(&mut engine, image, bbox)?;
        let text = text.trim().to_string();
        if text.is_empty() || confidence < REC_MIN_CONFIDENCE || !looks_like_text(&text) {
            continue;
        }
        let lines = text
            .split('\n')
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        blocks.push(OcrBlock {
            id: format!("b{}", index + 1),
            text,
            lines,
            bbox,
        });
    }
    Ok(OcrOutput {
        blocks,
        image_width: image.width(),
        image_height: image.height(),
        elapsed_ms: 0,
    })
}

fn detect(engine: &mut Engine, image: &RgbaImage) -> Result<Vec<BBox>, String> {
    let (input, scale_x, scale_y, width, height) = det_input(image);
    let outputs = engine
        .det
        .run(ort::inputs![input])
        .map_err(|error| format!("det run: {error}"))?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("det output: {error}"))?;
    let shape = shape.to_vec();
    if shape.len() < 2 {
        return Err(format!("unexpected det shape {shape:?}"));
    }
    let map_h = shape[shape.len() - 2] as usize;
    let map_w = shape[shape.len() - 1] as usize;
    if data.len() < map_h * map_w {
        return Err("det output is smaller than its shape".into());
    }
    let offset = data.len() - map_h * map_w;
    let map = &data[offset..];
    let mut boxes = boxes_from_map(map, map_w, map_h);
    for bbox in &mut boxes {
        let x = (bbox.x as f32 / scale_x).round() as i32;
        let y = (bbox.y as f32 / scale_y).round() as i32;
        let right = ((bbox.x + bbox.width) as f32 / scale_x).round() as i32;
        let bottom = ((bbox.y + bbox.height) as f32 / scale_y).round() as i32;
        bbox.x = x.clamp(0, image.width() as i32 - 1);
        bbox.y = y.clamp(0, image.height() as i32 - 1);
        bbox.width = (right - bbox.x).clamp(1, image.width() as i32 - bbox.x);
        bbox.height = (bottom - bbox.y).clamp(1, image.height() as i32 - bbox.y);
    }
    let _ = (width, height);
    Ok(merge_line_boxes(boxes))
}

fn det_input(image: &RgbaImage) -> (ort::value::Tensor<f32>, f32, f32, u32, u32) {
    let src_w = image.width().max(1);
    let src_h = image.height().max(1);
    let long_side = src_w.max(src_h);
    let ratio = if long_side > DET_LIMIT {
        DET_LIMIT as f32 / long_side as f32
    } else {
        1.0
    };
    let width = (((src_w as f32 * ratio) / 32.0).round() as u32 * 32).max(32);
    let height = (((src_h as f32 * ratio) / 32.0).round() as u32 * 32).max(32);
    let resized = image::imageops::resize(image, width, height, FilterType::Triangle);
    let mut data = vec![0f32; (3 * width * height) as usize];
    let plane = (width * height) as usize;
    for y in 0..height {
        for x in 0..width {
            let pixel = resized.get_pixel(x, y);
            let index = (y * width + x) as usize;
            data[index] = (pixel[0] as f32 / 255.0 - MEAN[0]) / STD[0];
            data[plane + index] = (pixel[1] as f32 / 255.0 - MEAN[1]) / STD[1];
            data[plane * 2 + index] = (pixel[2] as f32 / 255.0 - MEAN[2]) / STD[2];
        }
    }
    let array = Array4::from_shape_vec((1, 3, height as usize, width as usize), data)
        .expect("det input shape");
    let tensor = TensorRef::from_array_view(&array)
        .expect("det tensor")
        .to_owned();
    (
        tensor,
        width as f32 / src_w as f32,
        height as f32 / src_h as f32,
        width,
        height,
    )
}

#[derive(Clone, Copy)]
struct RawBox {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    score: f32,
}

fn boxes_from_map(map: &[f32], width: usize, height: usize) -> Vec<BBox> {
    let mut seen = vec![false; width * height];
    let mut boxes = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let start = y * width + x;
            if seen[start] || map[start] < DET_THRESH {
                continue;
            }
            let mut stack = vec![(x, y)];
            seen[start] = true;
            let mut min_x = x;
            let mut max_x = x;
            let mut min_y = y;
            let mut max_y = y;
            let mut score = 0f32;
            let mut count = 0usize;
            while let Some((cx, cy)) = stack.pop() {
                min_x = min_x.min(cx);
                max_x = max_x.max(cx);
                min_y = min_y.min(cy);
                max_y = max_y.max(cy);
                score += map[cy * width + cx];
                count += 1;
                for (nx, ny) in neighbors(cx, cy, width, height) {
                    let index = ny * width + nx;
                    if !seen[index] && map[index] >= DET_THRESH {
                        seen[index] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            let mean = score / count.max(1) as f32;
            let box_w = (max_x - min_x + 1) as i32;
            let box_h = (max_y - min_y + 1) as i32;
            if count < 8 || mean < BOX_THRESH || box_w < 2 || box_h < 2 {
                continue;
            }
            // Approximate DB unclip: vertical growth is large on thin text lines.
            let pad_x = ((box_h as f32) * 0.45).round().max(3.0) as i32;
            let pad_y = ((box_h as f32) * 0.8).round().max(4.0) as i32;
            boxes.push(RawBox {
                x: min_x as i32 - pad_x,
                y: min_y as i32 - pad_y,
                w: box_w + pad_x * 2,
                h: box_h + pad_y * 2,
                score: mean,
            });
        }
    }
    boxes.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    boxes.truncate(80);
    boxes
        .into_iter()
        .map(|bbox| BBox {
            x: bbox.x.max(0),
            y: bbox.y.max(0),
            width: bbox.w.max(1),
            height: bbox.h.max(1),
        })
        .collect()
}

fn neighbors(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> impl Iterator<Item = (usize, usize)> {
    let mut items = Vec::with_capacity(4);
    if x > 0 {
        items.push((x - 1, y));
    }
    if x + 1 < width {
        items.push((x + 1, y));
    }
    if y > 0 {
        items.push((x, y - 1));
    }
    if y + 1 < height {
        items.push((x, y + 1));
    }
    items.into_iter()
}

fn merge_line_boxes(mut boxes: Vec<BBox>) -> Vec<BBox> {
    boxes.sort_by(|left, right| left.y.cmp(&right.y).then(left.x.cmp(&right.x)));
    let mut merged: Vec<BBox> = Vec::new();
    for bbox in boxes {
        if let Some(last) = merged.last_mut() {
            let last_bottom = last.y + last.height;
            let next_bottom = bbox.y + bbox.height;
            let overlap = (last_bottom.min(next_bottom) - last.y.max(bbox.y)).max(0);
            let same_row = overlap * 2 >= last.height.min(bbox.height);
            let gap = bbox.x - (last.x + last.width);
            if same_row && gap < last.height.max(12) {
                let right = (last.x + last.width).max(bbox.x + bbox.width);
                let bottom = last_bottom.max(next_bottom);
                last.x = last.x.min(bbox.x);
                last.y = last.y.min(bbox.y);
                last.width = right - last.x;
                last.height = bottom - last.y;
                continue;
            }
        }
        merged.push(bbox);
    }
    merged
}

fn recognize_box(
    engine: &mut Engine,
    image: &RgbaImage,
    bbox: BBox,
) -> Result<(String, f32), String> {
    let x = bbox.x.clamp(0, image.width() as i32 - 1) as u32;
    let y = bbox.y.clamp(0, image.height() as i32 - 1) as u32;
    let width = (bbox.width as u32).clamp(1, image.width().saturating_sub(x));
    let height = (bbox.height as u32).clamp(1, image.height().saturating_sub(y));
    let crop = image::imageops::crop_imm(image, x, y, width, height).to_image();
    let target_width = ((REC_HEIGHT as f32) * (crop.width() as f32 / crop.height().max(1) as f32))
        .round()
        .clamp(8.0, 640.0) as u32;
    let target_width = target_width.max(8);
    let resized = image::imageops::resize(&crop, target_width, REC_HEIGHT, FilterType::Triangle);
    let mut data = vec![0f32; (3 * target_width * REC_HEIGHT) as usize];
    let plane = (target_width * REC_HEIGHT) as usize;
    for py in 0..REC_HEIGHT {
        for px in 0..target_width {
            let pixel = resized.get_pixel(px, py);
            let index = (py * target_width + px) as usize;
            data[index] = (pixel[0] as f32 / 255.0 - 0.5) / 0.5;
            data[plane + index] = (pixel[1] as f32 / 255.0 - 0.5) / 0.5;
            data[plane * 2 + index] = (pixel[2] as f32 / 255.0 - 0.5) / 0.5;
        }
    }
    let array = Array4::from_shape_vec((1, 3, REC_HEIGHT as usize, target_width as usize), data)
        .map_err(|error| error.to_string())?;
    let tensor = TensorRef::from_array_view(&array)
        .map_err(|error| error.to_string())?
        .to_owned();
    let outputs = engine
        .rec
        .run(ort::inputs![tensor])
        .map_err(|error| format!("rec run: {error}"))?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("rec output: {error}"))?;
    decode_ctc(&engine.keys, shape.as_ref(), data)
}

fn decode_ctc(keys: &[String], shape: &[i64], data: &[f32]) -> Result<(String, f32), String> {
    if shape.len() < 2 {
        return Err(format!("unexpected rec shape {shape:?}"));
    }
    let (time, classes) = if shape.len() == 3 {
        (shape[1] as usize, shape[2] as usize)
    } else {
        (shape[0] as usize, shape[1] as usize)
    };
    if time == 0 || classes == 0 || data.len() < time * classes {
        return Ok((String::new(), 0.0));
    }
    let mut text = String::new();
    let mut previous = 0usize;
    let mut confidence_sum = 0f32;
    let mut confidence_count = 0usize;
    for step in 0..time {
        let row = &data[step * classes..(step + 1) * classes];
        let (best, probability) = class_choice(row);
        if best != 0 && best != previous {
            if let Some(symbol) = keys.get(best - 1) {
                text.push_str(symbol);
            } else if best == keys.len() + 1 {
                text.push(' ');
            }
            confidence_sum += probability;
            confidence_count += 1;
        }
        previous = best;
    }
    let confidence = if confidence_count == 0 {
        0.0
    } else {
        confidence_sum / confidence_count as f32
    };
    Ok((text, confidence))
}

fn class_choice(row: &[f32]) -> (usize, f32) {
    let mut best = 0usize;
    let mut best_value = f32::MIN;
    let mut sum = 0f32;
    let mut min_value = f32::MAX;
    for (index, value) in row.iter().enumerate() {
        if *value > best_value {
            best_value = *value;
            best = index;
        }
        min_value = min_value.min(*value);
        sum += *value;
    }
    // PP-OCRv4 recognition already emits a probability distribution. Softmax on
    // those values collapses toward zero because thousands of near-zero classes
    // still contribute.
    let probability = if min_value >= -0.001 && (sum - 1.0).abs() < 0.2 {
        best_value.clamp(0.0, 1.0)
    } else {
        let mut denom = 0f32;
        for value in row {
            denom += (value - best_value).exp();
        }
        if denom == 0.0 {
            0.0
        } else {
            1.0 / denom
        }
    };
    (best, probability)
}

fn looks_like_text(text: &str) -> bool {
    text.chars().any(|ch| ch.is_alphanumeric())
}

fn _path_hint(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn blank_crops_are_not_text() {
        let mut loaded = engine().expect("engine");
        for (width, height, color) in [
            (220u32, 40u32, [248u8, 248, 246, 255]),
            (480, 64, [255, 255, 255, 255]),
            (120, 28, [230, 230, 230, 255]),
            (360, 48, [20, 22, 26, 255]),
            (640, 80, [245, 243, 238, 255]),
        ] {
            let image = RgbaImage::from_pixel(width, height, Rgba(color));
            let bbox = BBox {
                x: 0,
                y: 0,
                width: width as i32,
                height: height as i32,
            };
            let (text, confidence) = recognize_box(&mut loaded, &image, bbox).expect("rec");
            assert!(
                text.trim().is_empty() || confidence < REC_MIN_CONFIDENCE,
                "{width}x{height} {confidence} {text:?}"
            );
        }
    }

    #[test]
    fn blank_and_flat_color_have_no_text() {
        for color in [
            Rgba([255, 255, 255, 255]),
            Rgba([244, 246, 248, 255]),
            Rgba([32, 36, 42, 255]),
        ] {
            let image = RgbaImage::from_pixel(640, 360, color);
            let output = recognize(&image).expect("ocr");
            assert!(
                output.blocks.is_empty(),
                "color {color:?} produced {:?}",
                output
                    .blocks
                    .iter()
                    .map(|block| &block.text)
                    .collect::<Vec<_>>()
            );
        }
    }
}
