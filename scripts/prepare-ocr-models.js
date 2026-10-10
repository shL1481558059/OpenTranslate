const fs = require('node:fs');
const path = require('node:path');

const targetDir = path.join(__dirname, '../desktop/src-tauri/models/ocr');
const files = {
  'det.onnx':
    'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx?download=true',
  'rec.onnx':
    'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx?download=true',
  'keys.txt': 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/ppocr_keys_v1.txt'
};

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) {
    throw new Error(`empty response ${url}`);
  }
  fs.writeFileSync(destination, data);
}

async function main() {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [name, url] of Object.entries(files)) {
    const destination = path.join(targetDir, name);
    if (fs.existsSync(destination) && fs.statSync(destination).size > 1000) {
      console.log(`[ocr-models] keep ${name}`);
      continue;
    }
    console.log(`[ocr-models] download ${name}`);
    await download(url, destination);
  }
}

main().catch((error) => {
  console.error(`[ocr-models] ${error.message}`);
  process.exit(1);
});
