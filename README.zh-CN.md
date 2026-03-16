# OpenTranslate（Mac / Electron）中文文档

本项目是一个 Mac 端截图翻译工具：
- 全局快捷键触发
- 框选屏幕区域
- 本地 OCR（Apple Vision）提取文本块
- 内置本地翻译 API（Argos），桌面端启动时自动拉起
- 译文覆盖在原区域（块级布局）

## 功能概览

- 全局快捷键：默认 `Command+Shift+T`
- 框选截图后自动翻译、无需二次点击
- 译文覆盖原位置，块级对齐
- 单次批量请求，超时 + 1 次重试
- API 契约统一，可替换翻译后端

## 目录结构

- `api/`：翻译 API 服务（`POST /v1/translate`）
- `desktop/`：Electron 客户端
- `desktop/scripts/vision_ocr.swift`：本地 OCR 脚本
- `tests/`：基础测试

## 环境与依赖

- Node.js `>= 20`
- macOS（需要屏幕录制权限）
- Xcode Command Line Tools（用于 `xcrun swift`）
- （可选）Python 3（使用本地 Argos 翻译引擎时需要）

## 快速开始（开发模式）

1. 安装依赖
```bash
npm install
```

2. 配置环境变量
```bash
cp .env.example .env
# 填入 LLM_API_KEY
```

如果使用本地翻译引擎：
- 设置 `TRANSLATION_ENGINE=local`
- 将 Argos 模型（`.argosmodel`）放入 `models/argos/`
- 首次运行会自动创建 `./.venv` 并安装依赖

3. 启动桌面端
```bash
export $(grep -v '^#' .env | xargs)
npm run start:desktop
```

4. 使用
- 按 `Command+Shift+T`
- 拖拽框选区域
- 等待译文覆盖

可选：单独启动翻译 API（用于独立调试）
```bash
export $(grep -v '^#' .env | xargs)
npm run start:api
```

## 翻译 API 说明

`POST /v1/translate`

请求体：
```json
{
  "request_id": "uuid",
  "source_lang": "auto",
  "target_lang": "zh-CN",
  "items": [{ "id": "b1", "text": "Hello world" }]
}
```

响应体：
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

错误码（`error_code`）：
- `timeout`：请求超时
- `auth_required`：未配置密钥
- `rate_limited`：触发限流
- `provider_down`：上游不可用

## 客户端流程（概览）

1. 全局快捷键触发选区层
2. 本地截图 -> OCR 提取文本块与坐标
3. 批量调用翻译 API
4. 译文按块级布局覆盖到原区域

## 关键可配置项

见 `.env.example`：
- `TRANSLATION_API_URL`：翻译 API 地址
- `TRANSLATION_ENGINE`：`llm` 或 `local`
- `LLM_API_URL`：大模型 API 基址
- `LLM_API_KEY`：大模型密钥
- `LLM_MODEL`：模型名称（默认 `gpt-4o-mini`）
- `LOCAL_TRANSLATE_MODEL_DIR`：本地翻译模型目录（Argos）
- `LOCAL_TRANSLATE_VENV`：本地翻译引擎的虚拟环境目录
- `SNAP_TRANSLATE_HOTKEY`：全局快捷键

## 打包与发布（DMG）

使用 `electron-builder` 生成 DMG：
```bash
npm run dist
```

输出目录：`dist/`

说明：
- DMG 内置本地翻译 API，桌面端启动时自动拉起
- 首次启动会自动下载 Argos 模型（需要联网）
- 模型存放于 `app.getPath('userData')/models/argos`
- 未做签名/公证（本地分发场景）

## 设置页新增项

- 允许局域网访问：开启后 API 监听 `0.0.0.0`，局域网可访问
- API 端口：默认 `8787`
- 翻译接口地址自动保持为 `http://127.0.0.1:${端口}/v1/translate`

局域网访问示例：
```
http://<本机IP>:<端口>/v1/translate
```

## 常见问题

1. 截图失败 / 无法识别文本
- 检查系统“屏幕录制权限”是否授予给 Electron 进程

2. 翻译失败提示
- `TRANSLATION_ENGINE=llm` 时检查 `.env` 中 `LLM_API_KEY`
- `TRANSLATION_ENGINE=local` 时检查模型是否放入 `models/argos/`
- 检查翻译 API 是否运行

3. 译文位置偏差
- 当前为块级映射，非像素级复刻
- 可通过优化 OCR 或布局策略改善

## 设计取舍说明

- V1 使用单一小型 LLM：实现最快，但速度不如专用翻译 API。
- 版式映射为块级：保证稳定与速度，不做字符级回填。

## 后续可扩展方向

- 多 Provider 路由（专用翻译 API + LLM 兜底）
- 术语表与行业词库
- 历史记录与快捷重译
- 复杂排版识别（表格/公式）

## 运行测试

```bash
npm test
```

通过测试表示布局映射与接口契约基本正确。
