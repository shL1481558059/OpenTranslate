# OpenTranslate

跨平台截图翻译。桌面端是 Tauri v2，翻译 HTTP 服务嵌在 Tauri 进程里，接口兼容 DeepL API v2，本地 Argos 仍通过 Python 子进程运行。独立的 Node 服务留给 Docker 和测试。

## 功能

- 全局快捷键：macOS 为 Command+Shift+T，Windows 和 Linux 为 Ctrl+Shift+T
- 拖拽框选，或单击吸附窗口
- 对截图像做 OCR，译文按原位置浮层覆盖
- 复制原文、复制译文、手动翻译窗口
- 主题、语言、快捷键、开机自启
- 托盘菜单

## 目录

- `desktop/`：Tauri 壳和原来的 HTML 界面
- `desktop/src-tauri/`：Rust 进程、截图和 OCR
- `api/`：DeepL 兼容翻译服务（`POST /v2/translate`）
- `desktop/src-tauri/models/ocr/`：开发时可选的 PP-OCRv4 模型。安装包不再内嵌；Linux 首次 OCR 时下载。

## OCR

| 平台 | 引擎 |
| --- | --- |
| macOS | Apple Vision，首次用 `swiftc` 编译后缓存 |
| Windows | `Windows.Media.Ocr`（优先简体中文，其次英语和用户语言） |
| Linux | PP-OCRv4 mobile 检测 + 识别，ONNX Runtime |

Linux 上模型预热后，常见框选大约 60–80 毫秒，首次加载大约再加 150 毫秒。模型文件大约 15 MB。

## 开发

需要 Node.js 20+、Rust stable，以及当前系统的 Tauri 依赖。开发时 Linux OCR 模型在 `desktop/src-tauri/models/ocr/`，缺失时运行 `node scripts/prepare-ocr-models.js`。安装后的 Linux 版本会在第一次 OCR 时把同样的文件下载到应用数据目录。

```bash
npm install
cp .env.example .env
npm run start:desktop
```

桌面端会拉起界面，并在本进程监听 `127.0.0.1:8787`。`.env` 里的变量优先于 `api/config.json`。浮层排版在系统装有 `node` 时仍会调用它，否则使用内置排版。

Argos：`TRANSLATION_ENGINE=argos`，把 `.argosmodel` 放到 `models/argos/`，第一次翻译会创建 `./.venv`。Marian：`TRANSLATION_ENGINE=marian`。

```bash
npm test
npm run start:api
```

## 翻译接口

`POST /v2/translate` 同时接受 JSON 和 `application/x-www-form-urlencoded`。

```json
{ "text": ["Hello"], "target_lang": "ZH" }
```

```json
{ "translations": [{ "detected_source_language": "EN", "text": "你好" }] }
```

`target_lang` 必填，`source_lang` 可省略并自动检测。语言码大小写不敏感，按 DeepL 规范映射（`ZH`、`ZH-HANS`、`ZH-HANT`、`EN-US`、`EN-GB` 等）。其他 DeepL 字段会接受，不会因为不认识而报错。另外提供 `GET /v2/usage` 和 `GET /v2/languages`。

未配置 `DEEPL_AUTH_KEY`（或 `TRANSLATION_API_KEY`）时，`/v2/*` 只允许本机访问。配置之后使用 `Authorization: DeepL-Auth-Key <key>`，也接受 `Bearer` 和 `auth_key`。

管理页 `http://127.0.0.1:8787/admin` 可以用 `/v2/translate` 试译。模型管理仍走 `/v1/config` 和 `/v1/models/*`。

## 安装包里的翻译服务

桌面进程内嵌 DeepL 兼容 HTTP 服务。发布构建会去掉调试符号。安装包包含 `api/`（Python worker 和管理页）、`desktop/lib/` 和 Apple Vision 的 Swift 源文件，不再包含 Node 运行时，也不再包含 PP-OCRv4 模型。macOS 和 Windows 使用系统 OCR。Linux 在第一次 OCR 时下载 `det.onnx`、`rec.onnx` 和 `keys.txt`，下载失败会给出明确错误。

`npm run start:api` 和 Docker 仍然运行 `api/server.js`。`npm test` 测的是这个 Node 服务。安装包不会启动它。

```bash
npm run dist
```

`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时，用 tauri-action 构建 Windows、macOS arm64、macOS x64 和 Linux 安装包，并上传到草稿 Release。

## 权限

macOS 需要屏幕录制权限。Windows 若未安装简体中文 OCR 语言包，中文识别会退回到系统已启用的 OCR 语言。
