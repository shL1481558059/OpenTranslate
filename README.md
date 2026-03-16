# Snap Translate Mac (Electron)

Mac screenshot translate app:
- Global hotkey trigger
- Select screen region
- Local OCR via Apple Vision (Swift script)
- Batch translate by a small LLM API service or local Argos engine
- Overlay translated blocks at original positions

## Architecture

- `desktop/`: Electron client
- `api/`: translation API (`POST /v1/translate`)
- `desktop/scripts/vision_ocr.swift`: local OCR helper

## Quick start

1. Install deps:
   ```bash
   npm install
   ```
2. Configure env:
   ```bash
   cp .env.example .env
   # set LLM_API_KEY
   ```

   For local Argos engine:
   - set `TRANSLATION_ENGINE=local`
   - put `.argosmodel` files under `models/argos/`
   - first run will auto-create `./.venv` and install deps
3. Start translation API:
   ```bash
   export $(grep -v '^#' .env | xargs)
   npm run start:api
   ```
4. Start desktop app (new terminal):
   ```bash
   export $(grep -v '^#' .env | xargs)
   npm run start:desktop
   ```
5. Press `Command+Shift+T`, drag to select area.

## API contract

`POST /v1/translate`

Request:
```json
{
  "request_id": "uuid",
  "source_lang": "auto",
  "target_lang": "zh-CN",
  "items": [{ "id": "b1", "text": "Hello world" }]
}
```

Response:
```json
{
  "request_id": "uuid",
  "detected_source_lang": "auto",
  "items": [{ "id": "b1", "translated_text": "你好，世界", "confidence": 0.96 }],
  "model": "gpt-4o-mini",
  "latency_ms": 620,
  "error_code": null
}
```

## Notes

- Grant screen recording permission to the app process if screenshot capture fails.
- OCR is block-level for layout mapping; not pixel-perfect typography replacement.
- This version supports LLM or local Argos Translate.
