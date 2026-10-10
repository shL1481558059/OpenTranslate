# OpenTranslate

Screenshot translation for macOS, Windows, and Linux. The desktop app is Tauri v2. The translation HTTP service is embedded in the Tauri process, speaks the DeepL API v2 contract, and runs Argos through a local Python worker. The standalone Node server remains available for Docker and the test suite.

## What it does

- Global shortcut: Command+Shift+T on macOS, Ctrl+Shift+T on Windows and Linux
- Drag a region or click a window to snap
- OCR on the captured image, then overlay the translation in place
- Copy the source or the translation, plus a manual translate window
- Settings for theme, languages, shortcut, and launch at login
- Tray icon

## Layout

- `desktop/`: Tauri shell and the existing HTML UI
- `desktop/src-tauri/`: Rust app, screenshot capture, and OCR
- `api/`: DeepL-compatible translation service (`POST /v2/translate`)
- `desktop/src-tauri/models/ocr/`: optional local copy of the PP-OCRv4 models. Installers do not ship them; Linux downloads them on first OCR.

## OCR

| Platform | Engine |
| --- | --- |
| macOS | Apple Vision, compiled once with `swiftc` |
| Windows | `Windows.Media.Ocr` (Simplified Chinese, then English, then the user language) |
| Linux | PP-OCRv4 mobile detection + recognition ONNX via ONNX Runtime |

Linux recognition of a normal selection is well under a second after the model is loaded (about 60–80 ms on an x64 VM, plus about 150 ms the first time). The ONNX files are about 15 MB.

## Develop

Requirements: Node.js 20+, Rust stable, and the Tauri system packages for your OS. Linux OCR uses the ONNX models in `desktop/src-tauri/models/ocr/` during development (`node scripts/prepare-ocr-models.js` downloads them). A packaged Linux build downloads the same files into the app data directory the first time OCR runs.

```bash
npm install
cp .env.example .env
npm run start:desktop
```

`npm run start:desktop` serves the UI and starts the Tauri shell. The shell listens on `127.0.0.1:8787` from inside the app process. Environment variables in `.env` override `api/config.json`. Overlay layout runs inside the app and does not call Node.

For Argos, set `TRANSLATION_ENGINE=argos` and put `.argosmodel` files in `models/argos/`. The first translation creates `./.venv` and installs only `argostranslate`. Marian (`TRANSLATION_ENGINE=marian`) installs torch and transformers into that environment when it is first selected. The interpreter is `.venv/bin/python` on macOS and Linux, and `.venv\Scripts\python.exe` on Windows.

```bash
npm test
npm run start:api
```

## Translation API

`POST /v2/translate` accepts JSON and `application/x-www-form-urlencoded`.

```json
{ "text": ["Hello"], "target_lang": "ZH" }
```

```json
{ "translations": [{ "detected_source_language": "EN", "text": "你好" }] }
```

`target_lang` is required. `source_lang` is optional and language codes are case-insensitive (`ZH`, `ZH-HANS`, `ZH-HANT`, `EN-US`, `EN-GB`, and the other DeepL codes). Extra DeepL fields are accepted. `GET /v2/usage` and `GET /v2/languages` are included.

If `DEEPL_AUTH_KEY` (or `TRANSLATION_API_KEY`) is empty, only loopback clients may call `/v2/*`. Otherwise send `Authorization: DeepL-Auth-Key <key>`. `Authorization: Bearer <key>` and `auth_key` are also accepted.

The admin UI at `http://127.0.0.1:8787/admin` can try `/v2/translate` and still manages Argos and Marian models through `/v1/config` and `/v1/models/*`.

## How the API is packaged

The desktop process embeds the DeepL-compatible HTTP service and the overlay layout. Release builds strip debug symbols. Installers include `api/` (Python workers and the admin page) and the Apple Vision Swift source. They do not include a Node runtime or the PP-OCRv4 models. macOS and Windows use the system OCR engines. Linux downloads `det.onnx`, `rec.onnx`, and `keys.txt` on first OCR and reports a clear error if that download fails.

`npm run start:api` and Docker still run the Node server in `api/server.js`. The Node server is what `npm test` exercises. The packaged app does not start it.

```bash
npm run dist
```

GitHub Actions (`.github/workflows/release.yml`) builds Windows, macOS arm64, macOS x64, and Linux installers when a `v*` tag is pushed or the workflow is run manually. Artifacts are uploaded to a draft release.

## Permissions

macOS needs Screen Recording. Window snapping uses the window list from the capture API. OCR language data for Windows must be installed in the system OCR languages if Simplified Chinese is not already present.
