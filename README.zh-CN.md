# OpenTranslate

跨平台截图翻译。桌面端是 Tauri v2。翻译只调用外部接口，应用本身不部署翻译模型，也不启动翻译服务。

## 功能

- 全局快捷键：macOS 为 Command+Shift+T，Windows 和 Linux 为 Ctrl+Shift+T
- 拖拽框选，或单击吸附窗口
- 对截图像做 OCR，译文按原位置浮层覆盖
- 复制原文、复制译文、手动翻译窗口
- 主题、语言、快捷键、开机自启
- 托盘菜单
- DeepL、DeepLX、OpenAI 兼容三种翻译接口，设置页可测试连接

## 目录

- `desktop/`：Tauri 壳和 HTML 界面
- `desktop/src-tauri/`：Rust 进程、截图、OCR 和翻译客户端
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
npm run start:desktop
```

打开设置，选择接口类型并填写 Base URL。未配置时，手动翻译和截图翻译都会提示去设置。API Key 优先写入系统钥匙串；钥匙串不可用时写到配置目录下权限为 `0600` 的 `api-key` 文件。它不会进入 `settings.json`，也不会打进日志。

可选环境变量（进程环境，应用不会自动读取 `.env`）：`OPENTRANSLATE_PROVIDER`、`OPENTRANSLATE_BASE_URL`、`OPENTRANSLATE_API_KEY`、`OPENTRANSLATE_MODEL`、`OPENTRANSLATE_PROMPT`。只有还没有保存过对应值时才会用到。

```bash
npm test
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib -- translate settings
```

## 翻译接口

三种接口都有 20 秒超时，网络错误、超时和 429/5xx 会重试一次。401、403 和 400 不重试。语言码按各自接口转换。

### DeepL 官方

设置里选 **DeepL**。免费版 Base URL 为 `https://api-free.deepl.com`，专业版为 `https://api.deepl.com`。API Key 必填，请求头是 `Authorization: DeepL-Auth-Key <key>`。

多个 OCR 块一次提交到 `POST {base}/v2/translate`，正文是 `text` 数组。`zh-CN` 会映射成 `ZH`，`en` 作为目标语言会映射成 `EN-US`。测试连接请求 `GET {base}/v2/usage`。

### 本地 LinguaSpark（DeepLX）

设置里选 **DeepLX**。Base URL 填完整地址，例如 `http://localhost:7100/deeplx`。API Key 可留空；填写后会加 `Authorization: Bearer`。

这是单条接口。多个 OCR 块会并发请求，同时最多 4 个。请求体是 `{ "text", "source_lang", "target_lang" }`，译文取返回里的 `data`。源语言 `auto` 会传 `auto`。

### OpenAI 兼容

设置里选 **OpenAI 兼容**。Base URL 例如 `https://api.openai.com`。如果地址已经以 `/v1` 结尾，则请求 `{base}/chat/completions`，否则请求 `{base}/v1/chat/completions`。API Key 放在 `Authorization: Bearer`。Model 默认 `gpt-4o-mini`，也可以改成兼容服务要求的名字。自定义提示词可选，会附加在固定的 JSON 指令后面。

多个 OCR 块合并成一次请求，要求模型按 `{"items":[{"id":"1","text":"..."}]}` 返回，再按编号拆回。解析失败时改为逐块请求。

## 安装包

发布构建会去掉调试符号。安装包包含 Apple Vision 的 Swift 源文件，不包含翻译模型、翻译服务或 Node 运行时，也不包含 PP-OCRv4 模型。macOS 和 Windows 使用系统 OCR。Linux 在第一次 OCR 时下载 `det.onnx`、`rec.onnx` 和 `keys.txt`，下载失败会给出明确错误。

```bash
npm run dist
```

`.github/workflows/release.yml` 在推送 `v*` 标签或手动触发时，用 tauri-action 构建 Windows、macOS arm64、macOS x64 和 Linux 安装包，并上传到草稿 Release。

## 权限

macOS 需要屏幕录制权限。Windows 若未安装简体中文 OCR 语言包，中文识别会退回到系统已启用的 OCR 语言。
