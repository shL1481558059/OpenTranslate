use image::{imageops::crop_imm, Rgba, RgbaImage};
use serde::Serialize;
use xcap::{Monitor, Window};

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapWindow {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub title: String,
}

pub fn list_windows(bounds: Rect) -> Vec<SnapWindow> {
    let windows = match Window::all() {
        Ok(windows) => windows,
        Err(error) => {
            eprintln!("[capture] window list failed: {error}");
            return Vec::new();
        }
    };
    windows
        .into_iter()
        .filter_map(|window| {
            let rect = window_rect(&window)?;
            if rect.width < 80 || rect.height < 60 {
                return None;
            }
            if window.is_minimized().unwrap_or(false) {
                return None;
            }
            let title = window.title().unwrap_or_default();
            let app = window.app_name().unwrap_or_default();
            if title == "Selection" || title == "Overlay" || (app == "OpenTranslate" && title.is_empty()) {
                return None;
            }
            if !intersects(rect, bounds) {
                return None;
            }
            Some(SnapWindow {
                id: format!("{}:{}:{}", window.id().unwrap_or(0), rect.x, rect.y),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                title,
            })
        })
        .collect()
}

fn window_rect(window: &Window) -> Option<Rect> {
    Some(Rect {
        x: window.x().ok()?,
        y: window.y().ok()?,
        width: window.width().ok()? as i32,
        height: window.height().ok()? as i32,
    })
}

pub fn monitor_at(x: i32, y: i32) -> Result<Rect, String> {
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let frames = monitors
        .iter()
        .filter_map(|monitor| monitor_rect(monitor).ok())
        .collect::<Vec<_>>();
    frames
        .into_iter()
        .find(|rect| point_inside(x, y, *rect))
        .or_else(|| frames_first(&monitors))
        .ok_or_else(|| "no monitor available".to_string())
}

fn frames_first(monitors: &[Monitor]) -> Option<Rect> {
    monitors.iter().find_map(|monitor| monitor_rect(monitor).ok())
}

fn monitor_rect(monitor: &Monitor) -> Result<Rect, String> {
    Ok(Rect {
        x: monitor.x().map_err(|error| error.to_string())?,
        y: monitor.y().map_err(|error| error.to_string())?,
        width: monitor.width().map_err(|error| error.to_string())? as i32,
        height: monitor.height().map_err(|error| error.to_string())? as i32,
    })
}

fn point_inside(x: i32, y: i32, rect: Rect) -> bool {
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

pub fn capture_rect(rect: Rect) -> Result<(RgbaImage, f64), String> {
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let monitor = monitors
        .iter()
        .find(|monitor| monitor_rect(monitor).ok().is_some_and(|bounds| intersects(rect, bounds)))
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitor available".to_string())?;
    let bounds = monitor_rect(monitor)?;
    let full = monitor.capture_image().map_err(|error| error.to_string())?;
    let scale_x = full.width() as f64 / bounds.width.max(1) as f64;
    let scale_y = full.height() as f64 / bounds.height.max(1) as f64;
    let crop_x = ((rect.x - bounds.x) as f64 * scale_x).round().max(0.0) as u32;
    let crop_y = ((rect.y - bounds.y) as f64 * scale_y).round().max(0.0) as u32;
    let crop_w = ((rect.width as f64) * scale_x).round().max(1.0) as u32;
    let crop_h = ((rect.height as f64) * scale_y).round().max(1.0) as u32;
    let crop_x = crop_x.min(full.width().saturating_sub(1));
    let crop_y = crop_y.min(full.height().saturating_sub(1));
    let crop_w = crop_w.min(full.width().saturating_sub(crop_x)).max(1);
    let crop_h = crop_h.min(full.height().saturating_sub(crop_y)).max(1);
    Ok((crop_imm(&full, crop_x, crop_y, crop_w, crop_h).to_image(), scale_x))
}

pub fn average_color(image: &RgbaImage, rect: Rect) -> Option<Rgba<u8>> {
    if image.width() == 0 || image.height() == 0 || rect.width <= 0 || rect.height <= 0 {
        return None;
    }
    let x0 = rect.x.clamp(0, image.width() as i32 - 1) as u32;
    let y0 = rect.y.clamp(0, image.height() as i32 - 1) as u32;
    let x1 = (rect.x + rect.width).clamp(1, image.width() as i32) as u32;
    let y1 = (rect.y + rect.height).clamp(1, image.height() as i32) as u32;
    let mut r = 0u64;
    let mut g = 0u64;
    let mut b = 0u64;
    let mut count = 0u64;
    let steps = 6u32;
    for iy in 0..steps {
        let y = y0 + ((iy as u64 * (y1 - y0) as u64) / steps as u64) as u32;
        for ix in 0..steps {
            let x = x0 + ((ix as u64 * (x1 - x0) as u64) / steps as u64) as u32;
            let pixel = image.get_pixel(x.min(image.width() - 1), y.min(image.height() - 1));
            if pixel[3] == 0 {
                continue;
            }
            r += pixel[0] as u64;
            g += pixel[1] as u64;
            b += pixel[2] as u64;
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }
    Some(Rgba([
        (r / count) as u8,
        (g / count) as u8,
        (b / count) as u8,
        255,
    ]))
}

fn intersects(left: Rect, right: Rect) -> bool {
    left.x < right.x + right.width
        && left.x + left.width > right.x
        && left.y < right.y + right.height
        && left.y + left.height > right.y
}
