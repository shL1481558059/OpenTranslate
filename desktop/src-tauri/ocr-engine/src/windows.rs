use super::{BBox, OcrBlock, OcrOutput};
use image::RgbaImage;
use pollster::block_on;
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

pub fn recognize(image: &RgbaImage) -> Result<OcrOutput, String> {
    block_on(recognize_async(image))
}

async fn recognize_async(image: &RgbaImage) -> Result<OcrOutput, String> {
    let mut png = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png);
        image::DynamicImage::ImageRgba8(image.clone())
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
    }
    let stream = InMemoryRandomAccessStream::new().map_err(|error| error.to_string())?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|error| error.to_string())?;
    writer.WriteBytes(&png).map_err(|error| error.to_string())?;
    writer.StoreAsync().map_err(|error| error.to_string())?.await.map_err(|error| error.to_string())?;
    writer.DetachStream().map_err(|error| error.to_string())?;
    stream.Seek(0).map_err(|error| error.to_string())?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    let _ = BitmapPixelFormat::Bgra8;
    let engine = ocr_engine().map_err(|error| format!("Windows.Media.Ocr is unavailable: {error}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    let lines = result.Lines().map_err(|error| error.to_string())?;
    let mut blocks = Vec::new();
    for index in 0..lines.Size().map_err(|error| error.to_string())? {
        let line = lines.GetAt(index).map_err(|error| error.to_string())?;
        let text = line.Text().map_err(|error| error.to_string())?.to_string();
        if text.trim().is_empty() {
            continue;
        }
        let words = line.Words().map_err(|error| error.to_string())?;
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = 0i32;
        let mut max_y = 0i32;
        let count = words.Size().unwrap_or(0);
        for word_index in 0..count {
            if let Ok(word) = words.GetAt(word_index) {
                if let Ok(rect) = word.BoundingRect() {
                    min_x = min_x.min(rect.X);
                    min_y = min_y.min(rect.Y);
                    max_x = max_x.max(rect.X + rect.Width);
                    max_y = max_y.max(rect.Y + rect.Height);
                }
            }
        }
        if min_x == i32::MAX {
            continue;
        }
        blocks.push(OcrBlock {
            id: format!("b{}", blocks.len() + 1),
            lines: vec![text.clone()],
            text,
            bbox: BBox {
                x: min_x,
                y: min_y,
                width: (max_x - min_x).max(1),
                height: (max_y - min_y).max(1),
            },
        });
    }
    let _ = index_hint(image.width(), image.height());
    Ok(OcrOutput {
        blocks,
        image_width: image.width(),
        image_height: image.height(),
        elapsed_ms: 0,
    })
}

fn ocr_engine() -> windows::core::Result<OcrEngine> {
    for tag in ["zh-Hans", "zh-Hans-CN", "en-US"] {
        if let Ok(language) = Language::CreateLanguage(&HSTRING::from(tag)) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&language) {
                return Ok(engine);
            }
        }
    }
    OcrEngine::TryCreateFromUserProfileLanguages()
}

fn index_hint(width: u32, height: u32) -> (u32, u32) {
    (width, height)
}
