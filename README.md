# OpenTranslate (Electron for macOS)

Mac screenshot translate app:
- Global hotkey trigger
- Select screen region
- Local OCR via Apple Vision (Swift script)
- Built-in local translation API (Argos), auto-started by the desktop app
- Overlay translated blocks at original positions

## Architecture

- `desktop/`: Electron client
- `api/`: translation API (`POST /v1/translate`)
- `desktop/scripts/vision_ocr.swift`: local OCR helper

## Quick start (dev)

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
3. Start desktop app:
   ```bash
   export $(grep -v '^#' .env | xargs)
   npm run start:desktop
   ```
4. Press `Command+Shift+T`, drag to select area.

Optional: run API service standalone for debugging
```bash
export $(grep -v '^#' .env | xargs)
npm run start:api
```

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

## Packaging (DMG)

Build DMG with electron-builder:
```bash
npm run dist
```

Notes:
- Desktop app auto-starts the local API.
- First launch downloads Argos model (network required).
- Model path: `app.getPath('userData')/models/argos`.
- No code signing / notarization by default.

## Settings additions

- LAN access toggle (binds API to `0.0.0.0`)
- API port (default `8787`)
- Translation API URL is kept as `http://127.0.0.1:${port}/v1/translate`

LAN access example:
```
http://<host-ip>:<port>/v1/translate
```
