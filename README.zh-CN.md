# OpenTranslate

跨平台截图翻译。桌面端是 Tauri v2，内置的 Node 服务按 DeepL API v2 提供翻译，本地引擎可以是 Argos 或 Marian。

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
- `desktop/src-tauri/models/ocr/`：Linux 使用的 PP-OCRv4 mobile ONNX 模型

## OCR

| 平台 | 引擎 |
| --- | --- |
| macOS | Apple Vision，首次用 `swiftc` 编译后缓存 |
| Windows | `Windows.Media.Ocr`（优先简体中文，其次英语和用户语言） |
| Linux | PP-OCRv4 mobile 检测 + 识别，ONNX Runtime |

Linux 上模型预热后，常见框选大约 60–80 毫秒，首次加载大约再加 150 毫秒。模型文件大约 15 MB。

## 开发

需要 Node.js 20+、Rust stable，以及当前系统的 Tauri 依赖。Linux OCR 模型在 `desktop/src-tauri/models/ocr/`，缺失时运行 `node scripts/prepare-ocr-models.js`。

```bash
npm install
cp .env.example .env
npm run start:desktop
```

桌面端会拉起界面，并用系统里的 `node` 启动 `api/server.js`。`.env` 里的变量优先于 `api/config.json`。

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

开发时用系统 `node` 和仓库里的 `api/`。

发布时 `node scripts/prepare-node-sidecar.js` 会把对应平台的 Node 放到 `desktop/src-tauri/binaries/opentranslate-node-<triple>`。Tauri 把它作为 sidecar 打进安装包，安装后的文件名是 `opentranslate-node`，不会覆盖系统里的 `node`。同时打包 `api/`、`load-env.js`、`desktop/lib/`、Linux OCR 模型和 Vision 的 Swift 源文件。打包后的进程会设置 `SNAP_TRANSLATE_IS_PACKAGED=1`，并在应用数据目录用系统 `python3` 创建 Argos 或 Marian 虚拟环境。只有选择 Marian 时才会安装体积很大的 PyTorch。

```bash
npm run dist
```

`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时，用 tauri-action 构建 Windows、macOS arm64、macOS x64 和 Linux 安装包，并上传到草稿 Release。

## 权限

macOS 需要屏幕录制权限。Windows 若未安装简体中文 OCR 语言包，中文识别会退回到系统已启用的 OCR 语言。
