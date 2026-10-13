use image::{imageops::crop_imm, Rgba, RgbaImage};
use serde::Serialize;
use xcap::{Monitor, Window};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
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
            if title == "Selection"
                || title == "Overlay"
                || title == "Desktop"
                || app.eq_ignore_ascii_case("xfdesktop")
                || (app.eq_ignore_ascii_case("opentranslate") && title.is_empty())
            {
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
    let pointer = pointer_space_monitors();
    if !pointer.is_empty() {
        return pointer
            .iter()
            .copied()
            .find(|rect| point_inside(x, y, *rect))
            .or_else(|| pointer.into_iter().next())
            .ok_or_else(|| "no monitor available".to_string());
    }
    xcap_monitor_at(x, y)
}

fn xcap_monitor_at(x: i32, y: i32) -> Result<Rect, String> {
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let frames = monitors
        .iter()
        .filter_map(|monitor| monitor_rect(monitor).ok())
        .collect::<Vec<_>>();
    let rect = frames
        .into_iter()
        .find(|rect| point_inside(x, y, *rect))
        .or_else(|| frames_first(&monitors))
        .ok_or_else(|| "no monitor available".to_string())?;
    Ok(clamp_monitor_to_root(rect, root_size()))
}

fn frames_first(monitors: &[Monitor]) -> Option<Rect> {
    monitors
        .iter()
        .find_map(|monitor| monitor_rect(monitor).ok())
}

fn monitor_rect(monitor: &Monitor) -> Result<Rect, String> {
    // xcap divides RandR pixels by Xft.dpi/96. That quotient is not the
    // pointer space: multiplying it back is right only when Xft.dpi matches
    // the framebuffer scale. Prefer XRRGetMonitors (see pointer_space_monitors)
    // and only use this path when RandR is unavailable. If the rebuilt rect
    // is larger than the root window, clamp_monitor_to_root puts it back.
    let scale = monitor.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        f64::from(scale)
    } else {
        1.0
    };
    let x = monitor.x().map_err(|error| error.to_string())?;
    let y = monitor.y().map_err(|error| error.to_string())?;
    let width = monitor.width().map_err(|error| error.to_string())?;
    let height = monitor.height().map_err(|error| error.to_string())?;
    Ok(Rect {
        x: (f64::from(x) * scale).round() as i32,
        y: (f64::from(y) * scale).round() as i32,
        width: (f64::from(width) * scale).round() as i32,
        height: (f64::from(height) * scale).round() as i32,
    })
}

fn point_inside(x: i32, y: i32, rect: Rect) -> bool {
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

#[derive(Debug, Clone, Copy)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[allow(dead_code)]
pub fn css_to_screen(origin_x: i32, origin_y: i32, scale: f64, css: CssRect) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    Rect {
        x: origin_x.saturating_add((css.x * scale).round() as i32),
        y: origin_y.saturating_add((css.y * scale).round() as i32),
        width: (css.width * scale).round().max(1.0) as i32,
        height: (css.height * scale).round().max(1.0) as i32,
    }
}

#[allow(dead_code)]
pub fn hits_control(x: i32, y: i32, rect: Rect) -> bool {
    const PAD: i32 = 14;
    x >= rect.x.saturating_sub(PAD)
        && y >= rect.y.saturating_sub(PAD)
        && x < rect.x + rect.width + PAD
        && y < rect.y + rect.height + PAD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_hit_includes_padding_and_rejects_the_page() {
        let rect = Rect {
            x: 400,
            y: 80,
            width: 246,
            height: 36,
        };
        assert!(hits_control(630, 90, rect));
        assert!(hits_control(394, 78, rect));
        assert!(!hits_control(200, 200, rect));
        assert!(!hits_control(700, 90, rect));
    }

    #[test]
    fn shrunk_framebuffer_replaces_inflated_bounds() {
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1200,
        };
        assert_eq!(
            reconcile_bounds(bounds, 1280, 800),
            Rect {
                x: 0,
                y: 0,
                width: 1280,
                height: 800
            }
        );
    }

    #[test]
    fn matching_and_hidpi_framebuffers_keep_their_bounds() {
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1200,
        };
        assert_eq!(reconcile_bounds(bounds, 1920, 1200), bounds);
        let logical = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        };
        assert_eq!(reconcile_bounds(logical, 2560, 1600), logical);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn root_frame_matches_the_pointer_space_screen() {
        let Some(xid) = x11_root_xid() else {
            return;
        };
        let Some(frame) = x11_frame_of(xid) else {
            return;
        };
        let Some((root_w, root_h)) = x11_root_size() else {
            return;
        };
        assert_eq!(frame.x, 0);
        assert_eq!(frame.y, 0);
        assert_eq!((frame.width, frame.height), (root_w, root_h));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pointer_monitor_matches_the_root_on_this_display() {
        let Some((root_w, root_h)) = x11_root_size() else {
            return;
        };
        let monitor = monitor_at(1, 1).expect("monitor");
        assert_eq!(
            (monitor.width, monitor.height),
            (root_w, root_h),
            "host {}x{} drifted from root {}x{}",
            monitor.width,
            monitor.height,
            root_w,
            root_h
        );
    }

    #[test]
    fn inflated_primary_monitor_is_clipped_to_the_root() {
        let inflated = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1200,
        };
        assert_eq!(
            clamp_monitor_to_root(inflated, Some((1280, 800))),
            Rect {
                x: 0,
                y: 0,
                width: 1280,
                height: 800
            }
        );
    }

    #[test]
    fn matching_monitor_and_second_display_stay_put() {
        let primary = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1200,
        };
        assert_eq!(
            clamp_monitor_to_root(primary, Some((1920, 1200))),
            primary
        );
        let secondary = Rect {
            x: 1920,
            y: 0,
            width: 1920,
            height: 1200,
        };
        assert_eq!(
            clamp_monitor_to_root(secondary, Some((3840, 1200))),
            secondary
        );
    }

    #[test]
    fn short_selection_grows_without_leaving_the_monitor() {
        let selection = Rect {
            x: 40,
            y: 108,
            width: 1205,
            height: 47,
        };
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        };
        let grab = ocr_grab(selection, bounds);
        assert!(grab.rect.height >= selection.height);
        assert!(grab.rect.height >= 47 + 12);
        assert_eq!(grab.pad_x, selection.x - grab.rect.x);
        assert_eq!(grab.pad_y, selection.y - grab.rect.y);
        assert!(grab.rect.x >= bounds.x);
        assert!(grab.rect.y >= bounds.y);
        assert!(grab.rect.x + grab.rect.width <= bounds.x + bounds.width);
    }

    #[test]
    fn grab_at_the_top_edge_does_not_go_negative() {
        let selection = Rect {
            x: 4,
            y: 2,
            width: 400,
            height: 30,
        };
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        };
        let grab = ocr_grab(selection, bounds);
        assert_eq!(grab.rect.x, 0);
        assert_eq!(grab.rect.y, 0);
        assert_eq!(grab.pad_x, 4);
        assert_eq!(grab.pad_y, 2);
    }

    #[test]
    fn visible_toolbar_tracks_the_webview_frame() {
        let css = CssRect {
            x: 810.0,
            y: 235.0,
            width: 96.0,
            height: 36.0,
        };
        let screen = css_to_screen(0, 29, 1.0, css);
        assert_eq!(
            screen,
            Rect {
                x: 810,
                y: 264,
                width: 96,
                height: 36
            }
        );
        assert!(hits_control(850, 280, screen));
        assert!(!hits_control(400, 280, screen));
    }
}

pub struct CapturedFrame {
    pub image: RgbaImage,
    pub bounds: Rect,
    pub scale_x: f64,
    pub scale_y: f64,
}

pub struct OcrGrab {
    pub rect: Rect,
    pub pad_x: i32,
    pub pad_y: i32,
}

pub fn capture_frame(probe: Rect) -> Result<CapturedFrame, String> {
    let bounds = monitor_containing(probe)?;
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let monitor = monitors
        .iter()
        .find(|monitor| {
            monitor_rect(monitor)
                .ok()
                .is_some_and(|candidate| intersects(probe, candidate) || intersects(bounds, candidate))
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitor available".to_string())?;
    let full = monitor.capture_image().map_err(|error| error.to_string())?;
    let bounds = reconcile_bounds(bounds, full.width(), full.height());
    let scale_x = full.width() as f64 / bounds.width.max(1) as f64;
    let scale_y = full.height() as f64 / bounds.height.max(1) as f64;
    if (scale_x - 1.0).abs() > 0.04 || (scale_y - 1.0).abs() > 0.04 {
        eprintln!(
            "[capture] image {}x{} monitor {}x{} at {},{} scale {:.3},{:.3}",
            full.width(),
            full.height(),
            bounds.width,
            bounds.height,
            bounds.x,
            bounds.y,
            scale_x,
            scale_y
        );
    }
    Ok(CapturedFrame {
        image: full,
        bounds,
        scale_x,
        scale_y,
    })
}

pub fn crop_frame(frame: &CapturedFrame, rect: Rect) -> RgbaImage {
    let crop_x = ((rect.x - frame.bounds.x) as f64 * frame.scale_x)
        .round()
        .max(0.0) as u32;
    let crop_y = ((rect.y - frame.bounds.y) as f64 * frame.scale_y)
        .round()
        .max(0.0) as u32;
    let crop_w = (rect.width as f64 * frame.scale_x).round().max(1.0) as u32;
    let crop_h = (rect.height as f64 * frame.scale_y).round().max(1.0) as u32;
    let crop_x = crop_x.min(frame.image.width().saturating_sub(1));
    let crop_y = crop_y.min(frame.image.height().saturating_sub(1));
    let crop_w = crop_w
        .min(frame.image.width().saturating_sub(crop_x))
        .max(1);
    let crop_h = crop_h
        .min(frame.image.height().saturating_sub(crop_y))
        .max(1);
    crop_imm(&frame.image, crop_x, crop_y, crop_w, crop_h).to_image()
}

pub fn capture_rect(rect: Rect) -> Result<(RgbaImage, f64), String> {
    let frame = capture_frame(rect)?;
    let scale_x = frame.scale_x;
    Ok((crop_frame(&frame, rect), scale_x))
}

/// Grow a short or edge-tight selection before OCR. The returned pad is the
/// number of screen pixels added on the left and top, so recognized boxes can
/// be mapped back onto the original selection.
pub fn ocr_grab(selection: Rect, bounds: Rect) -> OcrGrab {
    const PAD_X: i32 = 8;
    const MIN_PAD_Y: i32 = 12;
    const MAX_PAD_Y: i32 = 28;
    const MIN_HEIGHT: i32 = 72;
    let needed = (MIN_HEIGHT - selection.height).max(0);
    let pad_y = (needed / 2).clamp(MIN_PAD_Y, MAX_PAD_Y);
    let x = (selection.x - PAD_X).max(bounds.x);
    let y = (selection.y - pad_y).max(bounds.y);
    let right = (selection.x + selection.width + PAD_X).min(bounds.x + bounds.width.max(0));
    let bottom = (selection.y + selection.height + pad_y).min(bounds.y + bounds.height.max(0));
    let rect = Rect {
        x,
        y,
        width: (right - x).max(1),
        height: (bottom - y).max(1),
    };
    OcrGrab {
        rect,
        pad_x: selection.x - rect.x,
        pad_y: selection.y - rect.y,
    }
}

fn monitor_containing(rect: Rect) -> Result<Rect, String> {
    let pointer = pointer_space_monitors();
    if !pointer.is_empty() {
        return pointer
            .iter()
            .copied()
            .find(|bounds| intersects(rect, *bounds))
            .or_else(|| pointer.into_iter().next())
            .ok_or_else(|| "no monitor available".to_string());
    }
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let rect = monitors
        .iter()
        .find_map(|monitor| {
            let bounds = monitor_rect(monitor).ok()?;
            intersects(rect, bounds).then_some(bounds)
        })
        .or_else(|| frames_first(&monitors))
        .ok_or_else(|| "no monitor available".to_string())?;
    Ok(clamp_monitor_to_root(rect, root_size()))
}

/// Xft.dpi can inflate a monitor past the root window the pointer lives on
/// (1280x800 reported as 1920x1200). A monitor that starts at the origin and
/// is a uniform enlargement of the root is that bug; clip it back. A monitor
/// that already fits, including one on a second display, stays put.
pub fn clamp_monitor_to_root(rect: Rect, root: Option<(i32, i32)>) -> Rect {
    let Some((root_w, root_h)) = root else {
        return rect;
    };
    if root_w <= 0 || root_h <= 0 || rect.width <= 0 || rect.height <= 0 {
        return rect;
    }
    let right = rect.x.saturating_add(rect.width);
    let bottom = rect.y.saturating_add(rect.height);
    if rect.x >= 0 && rect.y >= 0 && right <= root_w && bottom <= root_h {
        return rect;
    }
    if rect.x == 0 && rect.y == 0 && rect.width > root_w && rect.height > root_h {
        let sx = root_w as f64 / rect.width as f64;
        let sy = root_h as f64 / rect.height as f64;
        if (sx - sy).abs() < 0.02 {
            return Rect {
                x: 0,
                y: 0,
                width: root_w,
                height: root_h,
            };
        }
    }
    let x = rect.x.clamp(0, root_w.saturating_sub(1));
    let y = rect.y.clamp(0, root_h.saturating_sub(1));
    Rect {
        x,
        y,
        width: rect.width.min(root_w - x).max(1),
        height: rect.height.min(root_h - y).max(1),
    }
}

fn reconcile_bounds(bounds: Rect, image_w: u32, image_h: u32) -> Rect {
    if image_w == 0 || image_h == 0 || bounds.width <= 1 || bounds.height <= 1 {
        return bounds;
    }
    let sx = image_w as f64 / bounds.width as f64;
    let sy = image_h as f64 / bounds.height as f64;
    // An inflated monitor (1920x1200 reported over a 1280x800 framebuffer)
    // makes the crop scale 1280/1920, so a full line is cut off at the tail.
    // HiDPI is the other way around — the image is larger — and must stay.
    if sx < 0.98 && sy < 0.98 && (sx - sy).abs() < 0.02 {
        eprintln!(
            "[capture] bounds {}x{} @ {},{} shrink the {}x{} framebuffer; using the image size",
            bounds.width, bounds.height, bounds.x, bounds.y, image_w, image_h
        );
        return Rect {
            x: bounds.x,
            y: bounds.y,
            width: image_w as i32,
            height: image_h as i32,
        };
    }
    bounds
}

fn pointer_space_monitors() -> Vec<Rect> {
    #[cfg(target_os = "linux")]
    {
        let root = x11_root_size();
        return x11_monitors()
            .into_iter()
            .map(|rect| clamp_monitor_to_root(rect, root))
            .collect();
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

fn root_size() -> Option<(i32, i32)> {
    #[cfg(target_os = "linux")]
    {
        return x11_root_size();
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn x11_monitors() -> Vec<Rect> {
    use std::ffi::{c_int, c_ulong, c_void};

    #[repr(C)]
    struct XrrMonitorInfo {
        name: c_ulong,
        primary: c_int,
        automatic: c_int,
        noutput: c_int,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        mwidth: c_int,
        mheight: c_int,
        outputs: *mut c_ulong,
    }

    #[link(name = "X11")]
    unsafe extern "C" {
        fn XOpenDisplay(name: *const i8) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
        fn XDefaultRootWindow(display: *mut c_void) -> u64;
    }
    #[link(name = "Xrandr")]
    unsafe extern "C" {
        fn XRRGetMonitors(
            display: *mut c_void,
            window: u64,
            get_active: c_int,
            nmonitors: *mut c_int,
        ) -> *mut XrrMonitorInfo;
        fn XRRFreeMonitors(monitors: *mut XrrMonitorInfo);
    }

    unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return Vec::new();
        }
        let root = XDefaultRootWindow(display);
        let mut count = 0;
        let info = XRRGetMonitors(display, root, 1, &mut count);
        let mut rects = Vec::new();
        if !info.is_null() && count > 0 {
            for index in 0..count {
                let monitor = &*info.add(index as usize);
                if monitor.width > 0 && monitor.height > 0 {
                    rects.push(Rect {
                        x: monitor.x,
                        y: monitor.y,
                        width: monitor.width,
                        height: monitor.height,
                    });
                }
            }
            XRRFreeMonitors(info);
        }
        XCloseDisplay(display);
        rects
    }
}

#[cfg(target_os = "linux")]
fn x11_root_size() -> Option<(i32, i32)> {
    use std::ffi::{c_int, c_void};

    #[link(name = "X11")]
    unsafe extern "C" {
        fn XOpenDisplay(name: *const i8) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
        fn XDefaultScreen(display: *mut c_void) -> c_int;
        fn XDisplayWidth(display: *mut c_void, screen: c_int) -> c_int;
        fn XDisplayHeight(display: *mut c_void, screen: c_int) -> c_int;
    }

    unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let screen = XDefaultScreen(display);
        let width = XDisplayWidth(display, screen);
        let height = XDisplayHeight(display, screen);
        XCloseDisplay(display);
        (width > 0 && height > 0).then_some((width, height))
    }
}

/// X11 root coordinates and size of a window. `XGetGeometry` reports the size
/// in device pixels but its x/y are parent-relative, so the origin comes from
/// `XTranslateCoordinates`. This is the pointer space used by captures.
#[cfg(target_os = "linux")]
pub fn x11_frame_of(xid: u64) -> Option<Rect> {
    use std::ffi::{c_int, c_uint, c_void};

    #[link(name = "X11")]
    unsafe extern "C" {
        fn XOpenDisplay(name: *const i8) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
        fn XDefaultRootWindow(display: *mut c_void) -> u64;
        fn XGetGeometry(
            display: *mut c_void,
            window: u64,
            root: *mut u64,
            x: *mut c_int,
            y: *mut c_int,
            width: *mut c_uint,
            height: *mut c_uint,
            border: *mut c_uint,
            depth: *mut c_uint,
        ) -> c_int;
        fn XTranslateCoordinates(
            display: *mut c_void,
            src: u64,
            dest: u64,
            src_x: c_int,
            src_y: c_int,
            dest_x: *mut c_int,
            dest_y: *mut c_int,
            child: *mut u64,
        ) -> c_int;
    }

    if xid == 0 {
        return None;
    }
    unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let mut root_ret = 0u64;
        let mut parent_x = 0;
        let mut parent_y = 0;
        let mut width = 0u32;
        let mut height = 0u32;
        let mut border = 0u32;
        let mut depth = 0u32;
        let geometry = XGetGeometry(
            display,
            xid,
            &mut root_ret,
            &mut parent_x,
            &mut parent_y,
            &mut width,
            &mut height,
            &mut border,
            &mut depth,
        );
        if geometry == 0 || width == 0 || height == 0 {
            XCloseDisplay(display);
            return None;
        }
        let root = XDefaultRootWindow(display);
        let mut x = 0;
        let mut y = 0;
        let mut child = 0u64;
        let translated =
            XTranslateCoordinates(display, xid, root, 0, 0, &mut x, &mut y, &mut child);
        XCloseDisplay(display);
        if translated == 0 {
            return None;
        }
        Some(Rect {
            x,
            y,
            width: width as i32,
            height: height as i32,
        })
    }
}

#[cfg(all(target_os = "linux", test))]
fn x11_root_xid() -> Option<u64> {
    use std::ffi::{c_int, c_void};

    #[link(name = "X11")]
    unsafe extern "C" {
        fn XOpenDisplay(name: *const i8) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
        fn XDefaultRootWindow(display: *mut c_void) -> u64;
    }

    unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return None;
        }
        let root = XDefaultRootWindow(display);
        XCloseDisplay(display);
        (root != 0).then_some(root)
    }
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
