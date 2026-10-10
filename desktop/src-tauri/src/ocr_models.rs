use std::path::Path;

const FILES: &[(&str, &str)] = &[
    (
        "det.onnx",
        "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx?download=true",
    ),
    (
        "rec.onnx",
        "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx?download=true",
    ),
    (
        "keys.txt",
        "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt",
    ),
];

pub fn present(dir: &Path) -> bool {
    FILES.iter().all(|(name, _)| file_ready(&dir.join(name)))
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
    for (name, url) in FILES {
        let destination = dir.join(name);
        if file_ready(&destination) {
            continue;
        }
        download_one(&client, url, &destination, name, dir).await?;
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

fn missing_message(dir: &Path, detail: &str) -> String {
    format!(
        "OCR 模型下载失败（{detail}）。请检查网络后重试，或把 det.onnx、rec.onnx 和 keys.txt 放到 {}",
        dir.display()
    )
}
