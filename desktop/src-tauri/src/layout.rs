use serde_json::{json, Value};

pub fn render(blocks: &[Value], items: &[Value], selection: Value, display: Value) -> Value {
    let mapped = map_blocks(blocks, items, &selection);
    let display_bounds = if display.is_object() { display } else { selection.clone() };
    let overlay = build_overlay_layout(&selection, &display_bounds);
    json!({
        "blocks": mapped,
        "extraction": {
            "sourceText": build_extracted_text(blocks, false),
            "translatedText": build_extracted_text(&mapped, false)
        },
        "overlayBounds": display_bounds,
        "selectionRect": rect_relative(&selection, &display_bounds),
        "controlRect": rect_relative(overlay.get("controlBounds").unwrap_or(&Value::Null), &display_bounds),
        "controlSide": overlay.get("controlSide").cloned().unwrap_or(Value::Null)
    })
}

fn map_blocks(ocr_blocks: &[Value], items: &[Value], selection: &Value) -> Vec<Value> {
    let mut text_by_id = std::collections::HashMap::new();
    for item in items {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let text = item
            .get("translatedText")
            .or_else(|| item.get("translated_text"))
            .map(value_string)
            .unwrap_or_default();
        text_by_id.insert(id, text);
    }
    if should_use_compact_top_flow(ocr_blocks, selection) {
        if let Some(block) = build_compact_mask_replace(ocr_blocks, &text_by_id, selection) {
            return vec![block];
        }
    }
    let owned;
    let source: &[Value] = if should_reanchor(ocr_blocks, selection) {
        owned = reanchor_blocks(ocr_blocks, selection);
        &owned
    } else {
        ocr_blocks
    };
    source
        .iter()
        .map(|block| {
            let id = block.get("id").cloned().unwrap_or(Value::Null);
            let text = translated_text(&text_by_id, block);
            let line_count = line_count(block).max(1.0);
            let line_height = 1.1;
            let base_line_height = metric(block, "height") / line_count;
            let font_size = clamp(((base_line_height / line_height) * 0.92).floor(), 6.0, 36.0);
            let padding = clamp((font_size * 0.06).floor(), 0.0, 2.0);
            json!({
                "id": id,
                "bbox": block.get("bbox").cloned().unwrap_or(json!({})),
                "text": text,
                "styleHint": {
                    "baseFontSize": font_size,
                    "minFontSize": 6,
                    "fontSize": font_size,
                    "lineHeight": line_height,
                    "padding": padding,
                    "verticalOffset": (font_size * 0.12).round().max(1.0),
                    "background": "transparent",
                    "color": "#ffffff",
                    "textShadow": "0 1px 2px rgba(0,0,0,0.6)",
                    "layoutMode": "ocr"
                }
            })
        })
        .collect()
}

fn build_compact_mask_replace(ocr_blocks: &[Value], text_by_id: &std::collections::HashMap<String, String>, selection: &Value) -> Option<Value> {
    if ocr_blocks.is_empty() || !selection.is_object() {
        return None;
    }
    let selection_width = selection_metric(selection, "width");
    let selection_height = selection_metric(selection, "height");
    let mut source = probe_blocks(ocr_blocks, selection);
    source.sort_by(compare_blocks);
    let merged = source
        .iter()
        .map(|block| normalize_compact_text(&translated_text(text_by_id, block)))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if merged.is_empty() {
        return None;
    }
    let line_count = merged.split('\n').count().max(1) as f64;
    let estimated = selection_height / (line_count + 0.8).max(2.6);
    let font_size = clamp((estimated * 0.82).floor(), 10.0, 24.0);
    let padding = clamp((font_size * 0.5).floor(), 4.0, 10.0);
    Some(json!({
        "id": "compact-result",
        "bbox": { "x": 0, "y": 0, "width": selection_width, "height": selection_height },
        "text": merged,
        "styleHint": {
            "baseFontSize": font_size,
            "minFontSize": 8,
            "fontSize": font_size,
            "lineHeight": 1.22,
            "padding": padding,
            "verticalOffset": 0,
            "background": "transparent",
            "color": "#ffffff",
            "textShadow": "0 1px 2px rgba(0,0,0,0.72)",
            "layout": "center",
            "layoutMode": "compact-mask-replace"
        }
    }))
}

fn should_use_compact_top_flow(blocks: &[Value], selection: &Value) -> bool {
    if blocks.is_empty() || !selection.is_object() || !is_very_compact(selection) {
        return false;
    }
    let selection_height = selection_metric(selection, "height");
    let probe = probe_blocks(blocks, selection);
    let overall_min_y = blocks.iter().map(|block| metric(block, "y")).fold(f64::INFINITY, f64::min);
    let dominant = dominant_anchor_y(blocks, selection);
    let avg_y = probe.iter().map(|block| metric(block, "y")).sum::<f64>() / probe.len() as f64;
    let dominant_low = dominant >= selection_height * 0.28 && avg_y >= selection_height * 0.48;
    let large_top_gap = dominant >= selection_height * 0.24 && dominant - overall_min_y >= (selection_height * 0.16).max(14.0);
    dominant_low || large_top_gap
}

fn should_reanchor(blocks: &[Value], selection: &Value) -> bool {
    if blocks.is_empty() || !selection.is_object() || !is_compact(selection) || should_use_compact_top_flow(blocks, selection) {
        return false;
    }
    let selection_height = selection_metric(selection, "height");
    let probe = probe_blocks(blocks, selection);
    let values = probe.iter().map(|block| metric(block, "y")).collect::<Vec<_>>();
    let min_y = values.iter().copied().fold(f64::INFINITY, f64::min);
    let avg_y = values.iter().sum::<f64>() / values.len() as f64;
    min_y >= selection_height * 0.45 && avg_y >= selection_height * 0.58
}

fn reanchor_blocks(blocks: &[Value], selection: &Value) -> Vec<Value> {
    let min_y = dominant_anchor_y(blocks, selection);
    blocks
        .iter()
        .map(|block| {
            let mut next = block.clone();
            if let Some(bbox) = next.get_mut("bbox") {
                bbox["y"] = json!((metric(block, "y") - min_y).max(0.0));
            }
            next
        })
        .collect()
}

fn dominant_anchor_y(blocks: &[Value], selection: &Value) -> f64 {
    let mut probe = probe_blocks(blocks, selection)
        .into_iter()
        .map(|block| (metric(&block, "y").max(0.0), block_area(&block)))
        .collect::<Vec<_>>();
    probe.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(std::cmp::Ordering::Equal));
    if probe.is_empty() {
        return 0.0;
    }
    let total: f64 = probe.iter().map(|item| item.1).sum();
    let threshold = (total * 0.3).max(1.0);
    let mut consumed = 0.0;
    for (y, area) in probe {
        consumed += area;
        if consumed >= threshold {
            return y;
        }
    }
    0.0
}

fn probe_blocks(blocks: &[Value], selection: &Value) -> Vec<Value> {
    let significant = significant_blocks(blocks, selection);
    if significant.is_empty() { blocks.to_vec() } else { significant }
}

fn significant_blocks(blocks: &[Value], selection: &Value) -> Vec<Value> {
    if blocks.is_empty() || !selection.is_object() {
        return Vec::new();
    }
    let selection_width = selection_metric(selection, "width");
    let areas = blocks.iter().map(block_area).collect::<Vec<_>>();
    let max_area = areas.iter().copied().fold(1.0, f64::max);
    blocks
        .iter()
        .enumerate()
        .filter(|(index, block)| {
            let width = metric(block, "width").max(1.0);
            width >= selection_width * 0.55 || areas[*index] >= max_area * 0.6
        })
        .map(|(_, block)| block.clone())
        .collect()
}

fn build_overlay_layout(rect: &Value, display: &Value) -> Value {
    let spaces = available_spaces(rect, display);
    let side = choose_control_side(&spaces);
    let origin = control_origin(rect, side);
    let max_x = number(display, "x") + number(display, "width") - CONTROL_WIDTH;
    let max_y = number(display, "y") + number(display, "height") - CONTROL_HEIGHT;
    json!({
        "overlayBounds": {
            "x": number(rect, "x"),
            "y": number(rect, "y"),
            "width": number(rect, "width"),
            "height": number(rect, "height")
        },
        "controlSide": side,
        "controlBounds": {
            "x": clamp(origin.0, number(display, "x"), max_x),
            "y": clamp(origin.1, number(display, "y"), max_y),
            "width": CONTROL_WIDTH,
            "height": CONTROL_HEIGHT
        }
    })
}

const CONTROL_WIDTH: f64 = 262.0;
const CONTROL_HEIGHT: f64 = 36.0;

fn available_spaces(rect: &Value, display: &Value) -> [(&'static str, f64); 4] {
    let rx = number(rect, "x");
    let ry = number(rect, "y");
    let rw = number(rect, "width");
    let rh = number(rect, "height");
    let dx = number(display, "x");
    let dy = number(display, "y");
    let dw = number(display, "width");
    let dh = number(display, "height");
    [
        ("left", (rx - dx).max(0.0)),
        ("right", (dx + dw - (rx + rw)).max(0.0)),
        ("top", (ry - dy).max(0.0)),
        ("bottom", (dy + dh - (ry + rh)).max(0.0)),
    ]
}

fn choose_control_side(spaces: &[(&str, f64)]) -> &'static str {
    let requirement = |side: &str| if side == "top" || side == "bottom" { CONTROL_HEIGHT } else { CONTROL_WIDTH };
    for side in ["top", "bottom", "right", "left"] {
        if spaces.iter().any(|(name, value)| *name == side && *value >= requirement(side)) {
            return side;
        }
    }
    let mut best = "top";
    let mut best_fit = f64::NEG_INFINITY;
    for side in ["top", "bottom", "right", "left"] {
        let space = spaces.iter().find(|(name, _)| *name == side).map(|(_, value)| *value).unwrap_or(0.0);
        let fit = space / requirement(side);
        if fit > best_fit {
            best = side;
            best_fit = fit;
        }
    }
    best
}

fn control_origin(rect: &Value, side: &str) -> (f64, f64) {
    let x = number(rect, "x");
    let y = number(rect, "y");
    match side {
        "right" => (x + number(rect, "width"), y),
        "bottom" => (x + number(rect, "width") - CONTROL_WIDTH, y + number(rect, "height")),
        "left" => (x - CONTROL_WIDTH, y),
        _ => (x + number(rect, "width") - CONTROL_WIDTH, y - CONTROL_HEIGHT),
    }
}

fn build_extracted_text(blocks: &[Value], _translated: bool) -> String {
    if blocks.is_empty() {
        return String::new();
    }
    let mut ordered = blocks.to_vec();
    ordered.sort_by(compare_extraction);
    ordered
        .iter()
        .map(|block| normalize_block_text(&value_string(block.get("text").unwrap_or(&Value::Null))))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn compare_extraction(left: &Value, right: &Value) -> std::cmp::Ordering {
    if same_row(left, right) {
        let x_diff = metric(left, "x") - metric(right, "x");
        if x_diff != 0.0 {
            return x_diff.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
    }
    compare_blocks(left, right)
}

fn same_row(left: &Value, right: &Value) -> bool {
    let left_height = metric(left, "height").max(1.0);
    let right_height = metric(right, "height").max(1.0);
    let threshold = 12.0_f64.max(left_height.min(right_height) * 0.45);
    (metric(left, "y") - metric(right, "y")).abs() <= threshold
}

fn compare_blocks(left: &Value, right: &Value) -> std::cmp::Ordering {
    let y_diff = metric(left, "y") - metric(right, "y");
    if y_diff != 0.0 {
        return y_diff.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
    }
    (metric(left, "x") - metric(right, "x")).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
}

fn rect_relative(rect: &Value, bounds: &Value) -> Value {
    json!({
        "x": js_round(number(rect, "x")) - js_round(number(bounds, "x")),
        "y": js_round(number(rect, "y")) - js_round(number(bounds, "y")),
        "width": js_round(number(rect, "width")).max(0.0),
        "height": js_round(number(rect, "height")).max(0.0)
    })
}

fn translated_text(text_by_id: &std::collections::HashMap<String, String>, block: &Value) -> String {
    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
    text_by_id.get(id).cloned().unwrap_or_default()
}

fn line_count(block: &Value) -> f64 {
    if let Some(lines) = block.get("lines").and_then(Value::as_array) {
        if !lines.is_empty() {
            return lines.len() as f64;
        }
    }
    let text = value_string(block.get("text").unwrap_or(&Value::Null));
    if text.is_empty() {
        1.0
    } else {
        text.split('\n').count().max(1) as f64
    }
}

fn is_compact(selection: &Value) -> bool {
    selection_metric(selection, "height") <= 180.0 || selection_metric(selection, "width") <= 220.0
}

fn is_very_compact(selection: &Value) -> bool {
    selection_metric(selection, "height") <= 140.0 || selection_metric(selection, "width") <= 160.0
}

fn selection_metric(selection: &Value, key: &str) -> f64 {
    number(selection, key).max(1.0)
}

fn block_area(block: &Value) -> f64 {
    metric(block, "width").max(1.0) * metric(block, "height").max(1.0)
}

fn metric(block: &Value, key: &str) -> f64 {
    block.get("bbox").and_then(|bbox| bbox.get(key)).map(number_value).unwrap_or(0.0)
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).map(number_value).unwrap_or(0.0)
}

fn number_value(value: &Value) -> f64 {
    value.as_f64().or_else(|| value.as_i64().map(|item| item as f64)).unwrap_or(0.0)
}

fn value_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn normalize_compact_text(text: &str) -> String {
    text.split('\n').map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n").trim().to_string()
}

fn normalize_block_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn js_round(value: f64) -> f64 {
    value.floor() + if value.fract() >= 0.5 { 1.0 } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_ids_and_translated_text() {
        let blocks = vec![
            json!({"id": "b1", "text": "Hello", "bbox": {"x": 10, "y": 10, "width": 100, "height": 30}}),
            json!({"id": "b2", "text": "World", "bbox": {"x": 10, "y": 50, "width": 100, "height": 30}}),
        ];
        let items = vec![json!({"id": "b1", "translatedText": "你好"}), json!({"id": "b2", "translatedText": "世界"})];
        let mapped = map_blocks(&blocks, &items, &Value::Null);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0]["id"], "b1");
        assert_eq!(mapped[0]["text"], "你好");
        assert_eq!(mapped[1]["text"], "世界");
        assert_eq!(mapped[0]["styleHint"]["fontSize"], 25.0);
        assert_eq!(mapped[0]["styleHint"]["layoutMode"], "ocr");
    }

    #[test]
    fn missing_translation_stays_empty() {
        let blocks = vec![json!({"id": "b1", "text": "Hello", "bbox": {"x": 0, "y": 0, "width": 60, "height": 20}})];
        let mapped = map_blocks(&blocks, &[], &Value::Null);
        assert_eq!(mapped[0]["text"], "");
    }

    #[test]
    fn reanchors_compact_layout() {
        let blocks = vec![
            json!({"id": "b1", "text": "Hello", "bbox": {"x": 0, "y": 92, "width": 140, "height": 24}}),
            json!({"id": "b2", "text": "World", "bbox": {"x": 10, "y": 120, "width": 140, "height": 22}}),
        ];
        let items = vec![json!({"id": "b1", "translatedText": "你好"}), json!({"id": "b2", "translatedText": "世界"})];
        let selection = json!({"x": 0, "y": 0, "width": 210, "height": 170});
        let mapped = map_blocks(&blocks, &items, &selection);
        assert_eq!(mapped[0]["bbox"]["y"], 0.0);
        assert_eq!(mapped[1]["bbox"]["y"], 28.0);
    }

    #[test]
    fn replaces_very_compact_layout() {
        let blocks = vec![
            json!({"id": "b1", "text": ".", "bbox": {"x": 4, "y": 19, "width": 14, "height": 10}}),
            json!({"id": "b2", "text": "Hello", "bbox": {"x": 0, "y": 70, "width": 80, "height": 20}}),
            json!({"id": "b3", "text": "World", "bbox": {"x": 10, "y": 93, "width": 82, "height": 18}}),
        ];
        let items = vec![
            json!({"id": "b1", "translatedText": "。"}),
            json!({"id": "b2", "translatedText": "你好"}),
            json!({"id": "b3", "translatedText": "世界"}),
        ];
        let selection = json!({"x": 0, "y": 0, "width": 103, "height": 115});
        let mapped = map_blocks(&blocks, &items, &selection);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["id"], "compact-result");
        assert_eq!(mapped[0]["text"], "你好\n世界");
        assert_eq!(mapped[0]["styleHint"]["layoutMode"], "compact-mask-replace");
        assert_eq!(mapped[0]["bbox"]["width"], 103.0);
        assert_eq!(mapped[0]["bbox"]["height"], 115.0);
    }

    #[test]
    fn keeps_accurate_compact_layout() {
        let blocks = vec![
            json!({"id": "b1", "text": "Hello", "bbox": {"x": 0, "y": 8, "width": 120, "height": 18}}),
            json!({"id": "b2", "text": "World", "bbox": {"x": 0, "y": 34, "width": 120, "height": 18}}),
        ];
        let items = vec![json!({"id": "b1", "translatedText": "你好"}), json!({"id": "b2", "translatedText": "世界"})];
        let selection = json!({"x": 0, "y": 0, "width": 140, "height": 90});
        let mapped = map_blocks(&blocks, &items, &selection);
        assert_eq!(mapped[0]["bbox"]["y"], 8);
        assert_eq!(mapped[1]["bbox"]["y"], 34);
        assert_eq!(mapped[0]["styleHint"]["layoutMode"], "ocr");
    }

    #[test]
    fn overlay_control_matches_the_javascript_layout() {
        let open = build_overlay_layout(
            &json!({"x": 100, "y": 100, "width": 120, "height": 60}),
            &json!({"x": 0, "y": 0, "width": 1440, "height": 900}),
        );
        assert_eq!(open["controlSide"], "top");
        assert_eq!(open["controlBounds"]["x"], 0.0);
        assert_eq!(open["controlBounds"]["y"], 64.0);
        assert_eq!(open["controlBounds"]["width"], 262.0);
        let edge = build_overlay_layout(
            &json!({"x": 1360, "y": 4, "width": 70, "height": 40}),
            &json!({"x": 0, "y": 0, "width": 1440, "height": 900}),
        );
        assert_eq!(edge["controlSide"], "bottom");
        assert_eq!(edge["controlBounds"]["x"], 1168.0);
        assert_eq!(edge["controlBounds"]["y"], 44.0);
    }
}
