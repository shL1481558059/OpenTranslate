use image::RgbaImage;
use serde::Serialize;
use std::path::Path;
use std::time::Instant;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, Serialize)]
pub struct OcrBlock {
    pub id: String,
    pub text: String,
    pub lines: Vec<String>,
    pub bbox: BBox,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct BBox {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrOutput {
    pub blocks: Vec<OcrBlock>,
    pub image_width: u32,
    pub image_height: u32,
    pub elapsed_ms: u128,
}

pub fn recognize_image(image: &RgbaImage) -> Result<OcrOutput, String> {
    let started = Instant::now();
    let image_width = image.width();
    let image_height = image.height();
    #[cfg(target_os = "linux")]
    let mut output = linux::recognize(image)?;
    #[cfg(target_os = "macos")]
    let mut output = macos::recognize(image)?;
    #[cfg(target_os = "windows")]
    let mut output = windows::recognize(image)?;
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let mut output = Err::<OcrOutput, String>("OCR is not implemented for this platform".into())?;
    output.image_width = image_width;
    output.image_height = image_height;
    output.elapsed_ms = started.elapsed().as_millis();
    Ok(output)
}

pub fn recognize_path(path: &Path) -> Result<OcrOutput, String> {
    let image = image::open(path).map_err(|error| error.to_string())?.to_rgba8();
    recognize_image(&image)
}

pub fn preload() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux::preload()?;
    }
    Ok(())
}
