# OpenTranslate

Screenshot translation for macOS, Windows, and Linux. The desktop app is Tauri v2. A bundled Node service speaks the DeepL API v2 translate contract and runs Argos or Marian locally.

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
- `desktop/src-tauri/models/ocr/`: PP-OCRv4 mobile ONNX models used on Linux

## OCR

| Platform | Engine |
| --- | --- |
| macOS | Apple Vision, compiled once with `swiftc` |
| Windows | `Windows.Media.Ocr` (Simplified Chinese, then English, then the user language) |
| Linux | PP-OCRv4 mobile detection + recognition ONNX via ONNX Runtime |

Linux recognition of a normal selection is well under a second after the model is loaded (about 60–80 ms on an x64 VM, plus about 150 ms the first time). The ONNX files are about 15 MB.

## Develop

Requirements: Node.js 20+, Rust stable, and the Tauri system packages for your OS. Linux OCR also needs the ONNX models in `desktop/src-tauri/models/ocr/` (`node scripts/prepare-ocr-models.js` downloads them).

```bash
npm install
cp .env.example .env
npm run start:desktop
```

`npm run start:desktop` serves the UI and starts the Tauri shell. The shell starts `api/server.js` with the system Node binary. Environment variables in `.env` override `api/config.json`.

For Argos, set `TRANSLATION_ENGINE=argos`, put `.argosmodel` files in `models/argos/`, and let the first request create `./.venv`. Marian is selected with `TRANSLATION_ENGINE=marian`.

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

Development uses the system `node` executable and the repository `api/` tree.

Release builds download a Node binary into `desktop/src-tauri/binaries/opentranslate-node-<target>` (`node scripts/prepare-node-sidecar.js`) and Tauri ships it as an external sidecar named `opentranslate-node`, so the package does not replace a system `node` binary. The installer also contains `api/`, `load-env.js`, `desktop/lib/`, the Linux OCR models, and the Apple Vision Swift source. On first launch the packaged app sets `SNAP_TRANSLATE_IS_PACKAGED=1` and creates the Argos or Marian virtualenv under the app data directory, using the system `python3`. PyTorch is only installed when Marian is selected, because that dependency is large.

```bash
npm run dist
```

GitHub Actions (`.github/workflows/release.yml`) builds Windows, macOS arm64, macOS x64, and Linux installers when a `v*` tag is pushed or the workflow is run manually. Artifacts are uploaded to a draft release.

## Permissions

macOS needs Screen Recording. Window snapping uses the window list from the capture API. OCR language data for Windows must be installed in the system OCR languages if Simplified Chinese is not already present.
