use std::path::Path;

fn model_files() -> Vec<(&'static str, String)> {
    vec![
        (
            "det.onnx",
            std::env::var("OPENTRANSLATE_OCR_DET_URL").unwrap_or_else(|_| {
                "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx?download=true".into()
            }),
        ),
        (
            "rec.onnx",
            std::env::var("OPENTRANSLATE_OCR_REC_URL").unwrap_or_else(|_| {
                "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx?download=true".into()
            }),
        ),
        (
            "keys.txt",
            std::env::var("OPENTRANSLATE_OCR_KEYS_URL").unwrap_or_else(|_| {
                "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt".into()
            }),
        ),
    ]
}

pub fn present(dir: &Path) -> bool {
    model_files().iter().all(|(name, _)| file_ready(&dir.join(name)))
}

fn file_ready(path: &Path) -> bool {
    std::fs::metadata(path).map(|meta| meta.len() > 1000).unwrap_or(false)
}

pub async fn ensure(dir: &Path) -> Result<(), String> {
    if present(dir) {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|error| format!("无法创建 OCR 模型目录 {}: {error}", dir.display()))?;
    let client = reqwest::Client::builder()
        .user_agent("OpenTranslate")
        .build()
        .map_err(|error| format!("OCR 模型下载失败：{error}"))?;
    for (name, url) in model_files() {
        let destination = dir.join(name);
        if file_ready(&destination) {
            continue;
        }
        download_one(&client, &url, &destination, name, dir).await?;
    }
    if !present(dir) {
        return Err(missing_message(dir, "下载结束后模型文件仍不完整"));
    }
    Ok(())
}

async fn download_one(client: &reqwest::Client, url: &str, destination: &Path, name: &str, dir: &Path) -> Result<(), String> {
    let response = client.get(url).send().await.map_err(|error| missing_message(dir, &format!("{name}：{error}")))?;
    if !response.status().is_success() {
        return Err(missing_message(dir, &format!("{name}：HTTP {}", response.status())));
    }
    let bytes = response.bytes().await.map_err(|error| missing_message(dir, &format!("{name}：{error}")))?;
    if bytes.len() <= 1000 {
        return Err(missing_message(dir, &format!("{name}：响应为空")));
    }
    let temporary = destination.with_extension("partial");
    std::fs::write(&temporary, &bytes).map_err(|error| missing_message(dir, &format!("{name}：{error}")))?;
    std::fs::rename(&temporary, destination).map_err(|error| missing_message(dir, &format!("{name}：{error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_a_clear_error_when_the_download_fails_and_then_downloads() {
        let dir = std::env::temp_dir().join(format!("ot-ocr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("OPENTRANSLATE_OCR_DET_URL", "http://127.0.0.1:9/det.onnx");
        std::env::set_var("OPENTRANSLATE_OCR_REC_URL", "http://127.0.0.1:9/rec.onnx");
        std::env::set_var("OPENTRANSLATE_OCR_KEYS_URL", "http://127.0.0.1:9/keys.txt");
        let error = ensure(&dir).await.expect_err("offline download should fail");
        assert!(error.contains("OCR 模型下载失败"), "{error}");
        assert!(error.contains(&dir.display().to_string()), "{error}");
        std::env::remove_var("OPENTRANSLATE_OCR_DET_URL");
        std::env::remove_var("OPENTRANSLATE_OCR_REC_URL");
        std::env::remove_var("OPENTRANSLATE_OCR_KEYS_URL");
        let _ = std::fs::remove_dir_all(&dir);
        ensure(&dir).await.expect("first OCR download");
        assert!(present(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn missing_message(dir: &Path, detail: &str) -> String {
    format!(
        "OCR 模型下载失败（{detail}）。请检查网络后重试，或把 det.onnx、rec.onnx 和 keys.txt 放到 {}",
        dir.display()
    )
}
