# OpenTranslate

Screenshot translation for macOS, Windows, and Linux. The desktop app is Tauri v2. Translation is done only by calling an external API. The app does not ship a translation model or run a translation service.

## What it does

- Global shortcut: Command+Shift+T on macOS, Ctrl+Shift+T on Windows and Linux
- Drag a region or click a window to snap
- OCR on the captured image, then overlay the translation in place
- Copy the source or the translation, plus a manual translate window
- Settings for theme, languages, shortcut, and launch at login
- Tray icon
- DeepL, DeepLX, and OpenAI-compatible providers, with a connection test in Settings

## Layout

- `desktop/`: Tauri shell and the HTML UI
- `desktop/src-tauri/`: Rust app, screenshot capture, OCR, and the translation client
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
npm run start:desktop
```

Open Settings, pick a provider, and fill in the base URL. Manual translation and the overlay both point at Settings until that is done. The API key is stored in the system keychain when that is available. Otherwise it is written to an `api-key` file with mode `0600` next to the settings file. It is not written to `settings.json` and it is not logged.

Optional process environment variables, used only when a value has not already been saved: `OPENTRANSLATE_PROVIDER`, `OPENTRANSLATE_BASE_URL`, `OPENTRANSLATE_API_KEY`, `OPENTRANSLATE_MODEL`, `OPENTRANSLATE_PROMPT`. The app does not load a `.env` file by itself.

```bash
npm test
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib -- translate settings
```

## Translation providers

Each provider uses a 20 second timeout and retries once on network errors, timeouts, and HTTP 429/5xx. HTTP 401, 403, and 400 are not retried. Language codes are mapped for the provider in use.

### Official DeepL

Choose **DeepL**. The free base URL is `https://api-free.deepl.com`. The Pro base URL is `https://api.deepl.com`. The API key is required and is sent as `Authorization: DeepL-Auth-Key <key>`.

OCR blocks are posted together to `POST {base}/v2/translate` as a `text` array. `zh-CN` becomes `ZH`, and a target of `en` becomes `EN-US`. The connection test calls `GET {base}/v2/usage`.

### Local LinguaSpark (DeepLX)

Choose **DeepLX** and set the base URL to the full endpoint, for example `http://localhost:7100/deeplx`. The API key is optional. When it is set, the request adds `Authorization: Bearer`.

DeepLX translates one string per call. OCR blocks are requested concurrently, with at most 4 in flight. The body is `{ "text", "source_lang", "target_lang" }`, and the translation is the `data` field. A source of `auto` is sent as `auto`.

### OpenAI-compatible

Choose **OpenAI-compatible**. A base URL such as `https://api.openai.com` is posted to `{base}/v1/chat/completions`. A base that already ends in `/v1` is posted to `{base}/chat/completions` instead. The API key is sent as `Authorization: Bearer`. The model defaults to `gpt-4o-mini`. An optional custom prompt is appended after the fixed JSON instruction.

OCR blocks are merged into one request. The model must return `{"items":[{"id":"1","text":"..."}]}` so the blocks can be split back by id. If that parse fails, the client retries one block at a time.

## Installers

Release builds strip debug symbols. Installers include the Apple Vision Swift source. They do not include a translation model, a translation service, a Node runtime, or the PP-OCRv4 models. macOS and Windows use the system OCR engines. Linux downloads `det.onnx`, `rec.onnx`, and `keys.txt` on first OCR and reports a clear error if that download fails.

```bash
npm run dist
```

GitHub Actions (`.github/workflows/release.yml`) builds Windows, macOS arm64, macOS x64, and Linux installers when a `v*` tag is pushed or the workflow is run manually. Artifacts are uploaded to a draft release.

## Permissions

macOS needs Screen Recording. Window snapping uses the window list from the capture API. OCR language data for Windows must be installed in the system OCR languages if Simplified Chinese is not already present.
