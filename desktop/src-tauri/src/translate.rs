use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
const DEEPLX_CONCURRENCY: usize = 4;

#[derive(Clone)]
pub struct TranslateConfig {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub prompt: String,
    pub timeout: Duration,
}

impl std::fmt::Debug for TranslateConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TranslateConfig")
            .field("provider", &self.provider)
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .field("model", &self.model)
            .field("prompt", &self.prompt)
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl TranslateConfig {
    pub fn from_settings(
        provider: &str,
        base_url: &str,
        api_key: &str,
        model: &str,
        prompt: &str,
    ) -> Self {
        let model = model.trim();
        Self {
            provider: normalize_provider(provider),
            base_url: base_url.trim().to_string(),
            api_key: api_key.trim().to_string(),
            model: if model.is_empty() {
                "gpt-4o-mini".into()
            } else {
                model.to_string()
            },
            prompt: prompt.trim().to_string(),
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranslatedBlock {
    pub text: String,
    pub error: Option<String>,
}

impl TranslatedBlock {
    fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            error: None,
        }
    }

    fn failed(error: impl Into<String>) -> Self {
        Self {
            text: String::new(),
            error: Some(error.into()),
        }
    }
}

pub async fn translate(
    config: &TranslateConfig,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<TranslatedBlock>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    ensure_configured(config)?;
    let client = http_client(config.timeout)?;
    let translated = match config.provider.as_str() {
        "deepl" => translate_deepl(&client, config, texts, source_lang, target_lang)
            .await
            .map(|items| items.into_iter().map(TranslatedBlock::ok).collect()),
        "deeplx" => translate_deeplx(&client, config, texts, source_lang, target_lang).await,
        "openai" => translate_openai(&client, config, texts, source_lang, target_lang)
            .await
            .map(|items| items.into_iter().map(TranslatedBlock::ok).collect()),
        _ => Err("不支持的接口类型，请在设置中重新选择。".into()),
    };
    translated.map_err(|error| friendly_translate_error(&error, source_lang, target_lang))
}

pub async fn test_connection(config: &TranslateConfig) -> Result<String, String> {
    ensure_configured(config)?;
    let client = http_client(config.timeout)?;
    match config.provider.as_str() {
        "deepl" => {
            let url = format!("{}/v2/usage", deepl_base(&config.base_url));
            let _body = send_text(&config.api_key, || {
                client
                    .get(&url)
                    .header("Authorization", deepl_auth(&config.api_key))
            })
            .await?;
            Ok("连接成功。".into())
        }
        "deeplx" => {
            let text = translate_deeplx(&client, config, &["Hello".into()], "en", "zh-CN").await?;
            let empty = text
                .first()
                .is_none_or(|item| item.error.is_some() || item.text.trim().is_empty());
            if empty {
                return Err("DeepLX 没有返回译文。".into());
            }
            Ok("连接成功。".into())
        }
        "openai" => {
            let _text = translate_openai(&client, config, &["OK".into()], "en", "en").await?;
            Ok("连接成功。".into())
        }
        _ => Err("不支持的接口类型，请在设置中重新选择。".into()),
    }
}

fn ensure_configured(config: &TranslateConfig) -> Result<(), String> {
    if config.base_url.trim().is_empty() {
        return Err("尚未配置翻译接口，请打开设置填写接口类型和地址。".into());
    }
    match config.provider.as_str() {
        "deepl" | "deeplx" | "openai" => {}
        _ => return Err("不支持的接口类型，请在设置中重新选择。".into()),
    }
    if config.provider != "deeplx" && config.api_key.is_empty() {
        return Err("尚未填写 API Key，请打开设置。".into());
    }
    Ok(())
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "无法创建翻译客户端。".to_string())
}

async fn translate_deepl(
    client: &reqwest::Client,
    config: &TranslateConfig,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<String>, String> {
    let url = format!("{}/v2/translate", deepl_base(&config.base_url));
    let mut body = json!({
        "text": texts,
        "target_lang": deepl_target(target_lang),
    });
    if let Some(source) = deepl_source(source_lang) {
        body["source_lang"] = json!(source);
    }
    let payload = send_json(&config.api_key, || {
        client
            .post(&url)
            .header("Authorization", deepl_auth(&config.api_key))
            .json(&body)
    })
    .await?;
    let translations = payload
        .get("translations")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "DeepL 返回了无法识别的结果。".to_string())?;
    if translations.len() != texts.len() {
        return Err("DeepL 返回的译文数量和原文不一致。".into());
    }
    Ok(translations
        .iter()
        .map(|item| {
            item.get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect())
}

async fn translate_deeplx(
    client: &reqwest::Client,
    config: &TranslateConfig,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<TranslatedBlock>, String> {
    let url = deeplx_url(&config.base_url);
    let target = deeplx_lang(target_lang, false);
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(DEEPLX_CONCURRENCY));
    let mut tasks = tokio::task::JoinSet::new();
    for (index, text) in texts.iter().cloned().enumerate() {
        let client = client.clone();
        let url = url.clone();
        let key = config.api_key.clone();
        let configured = source_lang.to_string();
        let target = target.clone();
        let limit = limit.clone();
        tasks.spawn(async move {
            let permit = match limit.acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => return (index, TranslatedBlock::failed("翻译任务失败。")),
            };
            let source = deeplx_source_for(&configured, &text);
            let result = deeplx_one(&client, &url, &key, &text, source.as_deref(), &target).await;
            drop(permit);
            let block = match result {
                Ok(text) => TranslatedBlock::ok(text),
                Err(error) => {
                    TranslatedBlock::failed(friendly_translate_error(&error, &configured, &target))
                }
            };
            (index, block)
        });
    }
    let mut slots = vec![TranslatedBlock::failed("翻译任务失败。"); texts.len()];
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok((index, block)) => slots[index] = block,
            Err(_) => {}
        }
    }
    if slots.iter().all(|block| block.error.is_some()) {
        return Err(slots
            .into_iter()
            .find_map(|block| block.error)
            .unwrap_or_else(|| "翻译失败。".into()));
    }
    Ok(slots)
}

async fn deeplx_one(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    text: &str,
    source_lang: Option<&str>,
    target_lang: &str,
) -> Result<String, String> {
    let mut body = json!({
        "text": text,
        "target_lang": target_lang
    });
    if let Some(source_lang) =
        source_lang.filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
    {
        body["source_lang"] = json!(source_lang);
    }
    let payload = send_json(key, || {
        let request = client.post(url).json(&body);
        if key.is_empty() {
            request
        } else {
            request.bearer_auth(key)
        }
    })
    .await?;
    if let Some(code) = payload.get("code").and_then(|value| value.as_i64()) {
        if code != 200 {
            let message = payload
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("接口返回了错误。");
            return Err(format!("DeepLX 翻译失败：{message}"));
        }
    }
    payload
        .get("data")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| "DeepLX 返回了无法识别的结果。".to_string())
}

async fn translate_openai(
    client: &reqwest::Client,
    config: &TranslateConfig,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<String>, String> {
    if texts.len() <= 1 {
        return openai_once(client, config, texts, source_lang, target_lang).await;
    }
    match openai_once(client, config, texts, source_lang, target_lang).await {
        Ok(items) => Ok(items),
        Err(error) if fallback_allowed(&error) => {
            let mut output = Vec::with_capacity(texts.len());
            for text in texts {
                let item = openai_once(
                    client,
                    config,
                    std::slice::from_ref(text),
                    source_lang,
                    target_lang,
                )
                .await?;
                output.push(item.into_iter().next().unwrap_or_default());
            }
            Ok(output)
        }
        Err(error) => Err(error),
    }
}

fn fallback_allowed(error: &str) -> bool {
    !error.contains("认证失败")
        && !error.contains("尚未")
        && !error.starts_with("当前翻译服务不支持")
        && !is_unsupported_language(error)
}

async fn openai_once(
    client: &reqwest::Client,
    config: &TranslateConfig,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<String>, String> {
    let url = openai_url(&config.base_url);
    let prompt = openai_prompt(config, texts, source_lang, target_lang);
    let body = json!({
        "model": config.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": "You are a translation engine. Output strict JSON only." },
            { "role": "user", "content": prompt }
        ]
    });
    let payload = send_json(&config.api_key, || {
        client.post(&url).bearer_auth(&config.api_key).json(&body)
    })
    .await?;
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "模型没有返回译文。".to_string())?;
    parse_openai_items(content, texts.len())
}

fn openai_prompt(
    config: &TranslateConfig,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> String {
    let items: Vec<Value> = texts
        .iter()
        .enumerate()
        .map(|(index, text)| json!({ "id": (index + 1).to_string(), "text": text }))
        .collect();
    let extra = if config.prompt.is_empty() {
        String::new()
    } else {
        format!("Additional instructions:\n{}\n\n", config.prompt)
    };
    format!(
        "{extra}Translate each item into the target language.\nReturn JSON only in this schema:\n{{\"items\":[{{\"id\":\"1\",\"text\":\"translated\"}}]}}\nKeep every id unchanged and return one item per input.\nsource_lang={}\ntarget_lang={}\nitems={}",
        language_label(source_lang),
        language_label(target_lang),
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
    )
}

fn parse_openai_items(content: &str, expected: usize) -> Result<Vec<String>, String> {
    let content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: Value =
        serde_json::from_str(content).map_err(|_| "模型没有返回可解析的 JSON。".to_string())?;
    let items = parsed
        .get("items")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "模型返回缺少 items。".to_string())?;
    let mut by_id = HashMap::new();
    let mut ordered = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .or_else(|| item.get("translated_text"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
            by_id.insert(id.to_string(), text.clone());
        } else if let Some(id) = item.get("id").and_then(|value| value.as_i64()) {
            by_id.insert(id.to_string(), text.clone());
        }
        ordered.push(text);
    }
    if (1..=expected).all(|index| by_id.contains_key(&index.to_string())) {
        return Ok((1..=expected)
            .map(|index| by_id.remove(&index.to_string()).unwrap_or_default())
            .collect());
    }
    if ordered.len() == expected {
        return Ok(ordered);
    }
    Err("模型返回的条目数量和原文不一致。".into())
}

async fn send_json(
    secret: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<Value, String> {
    let body = send_text(secret, build).await?;
    serde_json::from_str(&body).map_err(|_| "翻译接口返回了无法解析的内容。".to_string())
}

async fn send_text(
    secret: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<String, String> {
    let mut last = "翻译请求失败。".to_string();
    for attempt in 0..2 {
        match build().send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if status.is_success() {
                    return Ok(body);
                }
                last = redact(http_error(status.as_u16(), &body), secret);
                if is_unsupported_language(&body) || is_unsupported_language(&last) {
                    return Err(last);
                }
                let retry = matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504 | 529);
                if attempt == 0 && retry {
                    continue;
                }
                return Err(last);
            }
            Err(error) => {
                last = redact(transport_error(&error), secret);
                if attempt == 0 && (error.is_timeout() || error.is_connect() || error.is_request())
                {
                    continue;
                }
                return Err(last);
            }
        }
    }
    Err(last)
}

fn http_error(status: u16, body: &str) -> String {
    let detail = json_message(body);
    match status {
        401 | 403 => "认证失败，请检查 API Key。".into(),
        404 => "接口地址不正确（404），请检查 Base URL。".into(),
        429 => "请求过于频繁，请稍后重试。".into(),
        500..=599 => {
            if detail.is_empty() {
                format!("翻译服务暂时不可用（{status}）。")
            } else {
                format!("翻译服务暂时不可用（{status}）：{detail}")
            }
        }
        _ => {
            if detail.is_empty() {
                format!("翻译失败（{status}）。")
            } else {
                format!("翻译失败（{status}）：{detail}")
            }
        }
    }
}

fn json_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.pointer("/error/message"))
                .or_else(|| value.get("error"))
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
        })
        .unwrap_or_else(|| {
            let trimmed = body.trim();
            if trimmed.chars().count() > 180 {
                String::new()
            } else {
                trimmed.to_string()
            }
        })
}

fn transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "翻译超时，请稍后重试。".into();
    }
    if error.is_connect() {
        return "无法连接翻译接口，请检查地址是否可访问。".into();
    }
    "翻译请求失败，请检查网络和接口地址。".into()
}

fn redact(message: String, secret: &str) -> String {
    let secret = secret.trim();
    if secret.len() < 4 {
        return message;
    }
    message.replace(secret, "****")
}

fn deepl_auth(key: &str) -> String {
    format!("DeepL-Auth-Key {key}")
}

fn deepl_base(base: &str) -> String {
    let base = with_scheme(base).trim_end_matches('/').to_string();
    base.trim_end_matches("/v2/translate")
        .trim_end_matches('/')
        .to_string()
}

fn deeplx_url(base: &str) -> String {
    with_scheme(base).trim_end_matches('/').to_string()
}

fn openai_url(base: &str) -> String {
    let base = with_scheme(base).trim_end_matches('/').to_string();
    if base.ends_with("/chat/completions") {
        base
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn with_scheme(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if trimmed.contains("localhost")
        || trimmed.starts_with("127.")
        || trimmed.starts_with("[::1]")
    {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    }
}

fn normalize_provider(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "deeplx" => "deeplx".into(),
        "openai" | "llm" => "openai".into(),
        _ => "deepl".into(),
    }
}

pub fn deepl_target(value: &str) -> String {
    let token = value.trim().replace('_', "-").to_uppercase();
    match token.as_str() {
        "" => "ZH".into(),
        "EN" => "EN-US".into(),
        "ZH-CN" | "ZH-SG" | "ZH-HANS" => "ZH".into(),
        "ZH-TW" | "ZH-HK" | "ZH-MO" | "ZH-HANT" => "ZH-HANT".into(),
        "EN-UK" => "EN-GB".into(),
        "NO" | "NB-NO" => "NB".into(),
        other => other.to_string(),
    }
}

pub fn deepl_source(value: &str) -> Option<String> {
    let token = value.trim().replace('_', "-").to_uppercase();
    if token.is_empty() || token == "AUTO" {
        return None;
    }
    Some(match token.as_str() {
        "ZH-CN" | "ZH-SG" | "ZH-HANS" | "ZH-TW" | "ZH-HK" | "ZH-HANT" => "ZH".into(),
        "EN-US" | "EN-GB" | "EN-UK" => "EN".into(),
        "PT-BR" | "PT-PT" => "PT".into(),
        "NO" | "NB-NO" => "NB".into(),
        other => other.to_string(),
    })
}

fn deeplx_source_for(configured: &str, text: &str) -> Option<String> {
    let token = configured.trim();
    if !token.is_empty() && !token.eq_ignore_ascii_case("auto") {
        return Some(deeplx_lang(token, true));
    }
    detect_iso639_1(text)
}

fn detect_iso639_1(text: &str) -> Option<String> {
    let mut cjk = 0usize;
    let mut kana = 0usize;
    let mut hangul = 0usize;
    let mut letters = 0usize;
    for ch in text.chars() {
        match ch {
            '\u{3040}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}' => kana += 1,
            '\u{ac00}'..='\u{d7af}' | '\u{1100}'..='\u{11ff}' => hangul += 1,
            '\u{4e00}'..='\u{9fff}' => cjk += 1,
            _ if ch.is_alphabetic() => letters += 1,
            _ => {}
        }
    }
    if kana > 0 && kana * 4 >= cjk {
        return Some("JA".into());
    }
    if hangul > 0 && hangul * 4 >= cjk {
        return Some("KO".into());
    }
    if cjk > 0 {
        return Some("ZH".into());
    }
    if letters < 2 {
        return None;
    }
    Some(whichlang_code(
        whichlang::detect_language(text).three_letter_code(),
    ))
}

fn whichlang_code(code: &str) -> String {
    match code {
        "cmn" | "zho" => "ZH",
        "eng" => "EN",
        "jpn" => "JA",
        "kor" => "KO",
        "deu" => "DE",
        "fra" => "FR",
        "spa" => "ES",
        "por" => "PT",
        "ita" => "IT",
        "rus" => "RU",
        "nld" => "NL",
        "pol" => "PL",
        "ukr" => "UK",
        "ces" => "CS",
        "swe" => "SV",
        "dan" => "DA",
        "fin" => "FI",
        "hun" => "HU",
        "ron" => "RO",
        "ell" => "EL",
        "bul" => "BG",
        "tur" => "TR",
        "ara" => "AR",
        "heb" => "HE",
        "tha" => "TH",
        "vie" => "VI",
        "ind" => "ID",
        "hin" => "HI",
        "fas" => "FA",
        "nob" | "nno" | "nor" => "NB",
        _ => "EN",
    }
    .into()
}

fn deeplx_lang(value: &str, source: bool) -> String {
    let token = value.trim().replace('_', "-");
    if token.is_empty() || token.eq_ignore_ascii_case("auto") {
        return if source { "auto".into() } else { "ZH".into() };
    }
    let upper = token.to_uppercase();
    match upper.as_str() {
        "ZH" | "ZH-CN" | "ZH-SG" | "ZH-HANS" | "ZH-TW" | "ZH-HK" | "ZH-MO" | "ZH-HANT" => {
            "ZH".into()
        }
        "EN" | "EN-US" | "EN-GB" | "EN-UK" => "EN".into(),
        "PT-BR" | "PT-PT" => "PT".into(),
        "NB" | "NB-NO" | "NO" => "NB".into(),
        other => other.split('-').next().unwrap_or(other).to_string(),
    }
}

fn is_unsupported_language(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if lower.contains("translation from")
        && (lower.contains("not supported") || lower.contains("unsupported"))
    {
        return true;
    }
    let about_language = lower.contains("language")
        || lower.contains("target_lang")
        || lower.contains("source_lang")
        || lower.contains("语言");
    let rejected = lower.contains("not supported")
        || lower.contains("unsupported")
        || lower.contains("not support")
        || lower.contains("不支持");
    about_language && rejected
}

fn friendly_translate_error(error: &str, source_lang: &str, target_lang: &str) -> String {
    if error.starts_with("当前翻译服务不支持") || !is_unsupported_language(error) {
        return error.to_string();
    }
    let (from, to) = quoted_language_pair(error).unwrap_or_else(|| {
        (
            language_name_zh(source_lang),
            language_name_zh(target_lang),
        )
    });
    format!("当前翻译服务不支持 {from}→{to}，请换目标语言或更换接口")
}

fn quoted_language_pair(message: &str) -> Option<(String, String)> {
    let lower = message.to_ascii_lowercase();
    let from_at = lower.find("from ")?;
    let after_from = &message[from_at + 5..];
    let (source, rest) = next_quoted(after_from)?;
    let to_at = rest.to_ascii_lowercase().find("to ")?;
    let (target, _) = next_quoted(&rest[to_at + 3..])?;
    if source.is_empty() || target.is_empty() {
        return None;
    }
    Some((language_name_zh(&source), language_name_zh(&target)))
}

fn next_quoted(text: &str) -> Option<(String, &str)> {
    let bytes = text.as_bytes();
    let mut open_at = None;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\'' && *byte != b'"' {
            continue;
        }
        if let Some(open) = open_at {
            if *byte == bytes[open] {
                return Some((text[open + 1..index].to_string(), &text[index + 1..]));
            }
        } else {
            open_at = Some(index);
        }
    }
    None
}

fn language_name_zh(value: &str) -> String {
    let token = value.trim().to_ascii_lowercase().replace('_', "-");
    match token.as_str() {
        "" | "auto" | "auto-detect" => "自动".into(),
        "zh-tw" | "zh-hk" | "zh-mo" | "zh-hant" => "中文繁体".into(),
        "zh" | "zh-cn" | "zh-sg" | "zh-hans" | "cmn" | "zho" => "中文简体".into(),
        "en" | "en-us" | "en-gb" | "en-uk" | "eng" => "英文".into(),
        "ja" | "jpn" => "日文".into(),
        "ko" | "kor" => "韩文".into(),
        "fr" | "fra" => "法文".into(),
        "de" | "deu" => "德文".into(),
        "es" | "spa" => "西班牙文".into(),
        "pt" | "pt-br" | "pt-pt" | "por" => "葡萄牙文".into(),
        "it" | "ita" => "意大利文".into(),
        "ru" | "rus" => "俄文".into(),
        "ar" | "ara" => "阿拉伯文".into(),
        "th" | "tha" => "泰文".into(),
        "vi" | "vie" => "越南文".into(),
        "id" | "ind" => "印尼文".into(),
        _ => match token.split('-').next().unwrap_or("") {
            "zh" => "中文简体".into(),
            "en" => "英文".into(),
            "ja" => "日文".into(),
            "ko" => "韩文".into(),
            other if !other.is_empty() => other.to_string(),
            _ => value.trim().to_string(),
        },
    }
}

fn language_label(value: &str) -> String {
    let token = value.trim();
    if token.is_empty() || token.eq_ignore_ascii_case("auto") {
        return "auto-detect".into();
    }
    match token.to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-hans" => format!("Simplified Chinese ({token})"),
        "zh-tw" | "zh-hk" | "zh-hant" => format!("Traditional Chinese ({token})"),
        "en" | "en-us" | "en-gb" => format!("English ({token})"),
        "ja" => format!("Japanese ({token})"),
        "ko" => format!("Korean ({token})"),
        _ => token.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::StatusCode,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("http://{addr}")
    }

    fn plain(items: Vec<TranslatedBlock>) -> Vec<String> {
        items.into_iter().map(|item| item.text).collect()
    }

    fn config(provider: &str, base: &str, key: &str) -> TranslateConfig {
        let mut config = TranslateConfig::from_settings(provider, base, key, "gpt-4o-mini", "");
        config.timeout = Duration::from_secs(2);
        config
    }

    #[derive(Clone)]
    struct Hits {
        hits: Arc<AtomicUsize>,
        fail_first: bool,
        key: String,
        seen: Arc<Mutex<Vec<Value>>>,
    }

    async fn deepl_handler(
        State(state): State<Hits>,
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
        state.hits.fetch_add(1, Ordering::SeqCst);
        let auth = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if auth != format!("DeepL-Auth-Key {}", state.key) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"message": format!("bad {}", state.key)})),
            ));
        }
        if state.fail_first && state.hits.load(Ordering::SeqCst) == 1 {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"message": state.key})),
            ));
        }
        state.seen.lock().expect("seen").push(body.clone());
        let texts = body
            .get("text")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let translations: Vec<Value> = texts
            .iter()
            .map(|item| json!({"detected_source_language": "EN", "text": format!("译:{}", item.as_str().unwrap_or(""))}))
            .collect();
        Ok(Json(json!({"translations": translations})))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deepl_batches_maps_languages_and_retries_once() {
        let state = Hits {
            hits: Arc::new(AtomicUsize::new(0)),
            fail_first: true,
            key: "deepl-secret".into(),
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let hits = state.hits.clone();
        let seen = state.seen.clone();
        let base = serve(
            Router::new()
                .route("/v2/translate", post(deepl_handler))
                .with_state(state),
        )
        .await;
        let config = config("deepl", &base, "deepl-secret");
        let output = translate(&config, &["Hello".into(), "World".into()], "zh-CN", "en")
            .await
            .expect("translate");
        assert_eq!(
            plain(output),
            vec!["译:Hello".to_string(), "译:World".to_string()]
        );
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let body = seen
            .lock()
            .expect("seen")
            .last()
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            body.get("source_lang").and_then(|value| value.as_str()),
            Some("ZH")
        );
        assert_eq!(
            body.get("target_lang").and_then(|value| value.as_str()),
            Some("EN-US")
        );
        let debug = format!("{config:?}");
        assert!(!debug.contains("deepl-secret"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deepl_auth_failure_is_not_retried_and_hides_the_key() {
        let state = Hits {
            hits: Arc::new(AtomicUsize::new(0)),
            fail_first: false,
            key: "expected".into(),
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let hits = state.hits.clone();
        let base = serve(
            Router::new()
                .route("/v2/translate", post(deepl_handler))
                .with_state(state),
        )
        .await;
        let error = translate(
            &config("deepl", &base, "leaked-key-value"),
            &["Hi".into()],
            "en",
            "zh-CN",
        )
        .await
        .expect_err("auth");
        assert!(error.contains("认证失败"));
        assert!(!error.contains("leaked-key-value"));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deepl_usage_probe_succeeds() {
        let base = serve(Router::new().route(
            "/v2/usage",
            get(|headers: axum::http::HeaderMap| async move {
                let auth = headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("");
                if auth == "DeepL-Auth-Key usage-key" {
                    (
                        StatusCode::OK,
                        Json(json!({"character_count": 1, "character_limit": 10})),
                    )
                } else {
                    (StatusCode::FORBIDDEN, Json(json!({"message": "no"})))
                }
            }),
        ))
        .await;
        let message = test_connection(&config("deepl", &base, "usage-key"))
            .await
            .expect("usage");
        assert!(message.contains("连接成功"));
    }

    #[derive(Clone)]
    struct DeeplxState {
        in_flight: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
        hits: Arc<AtomicUsize>,
        seen: Arc<Mutex<Vec<Value>>>,
        auths: Arc<Mutex<Vec<String>>>,
    }

    async fn deeplx_handler(
        State(state): State<DeeplxState>,
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        let now = state.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        state.max_in_flight.fetch_max(now, Ordering::SeqCst);
        state.hits.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(40)).await;
        state.in_flight.fetch_sub(1, Ordering::SeqCst);
        state.seen.lock().expect("seen").push(body.clone());
        let auth = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        state.auths.lock().expect("auths").push(auth);
        let text = body
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        Json(json!({"code": 200, "data": format!("X:{text}")}))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deeplx_limits_concurrency_and_keeps_order() {
        let state = DeeplxState {
            in_flight: Arc::new(AtomicUsize::new(0)),
            max_in_flight: Arc::new(AtomicUsize::new(0)),
            hits: Arc::new(AtomicUsize::new(0)),
            seen: Arc::new(Mutex::new(Vec::new())),
            auths: Arc::new(Mutex::new(Vec::new())),
        };
        let max_in_flight = state.max_in_flight.clone();
        let seen = state.seen.clone();
        let auths = state.auths.clone();
        let base = serve(
            Router::new()
                .route("/deeplx", post(deeplx_handler))
                .with_state(state),
        )
        .await;
        let texts: Vec<String> = (0..8).map(|index| format!("t{index}")).collect();
        let output = translate(
            &config("deeplx", &format!("{base}/deeplx"), "deeplx-token"),
            &texts,
            "en",
            "zh-CN",
        )
        .await
        .expect("deeplx");
        assert_eq!(
            plain(output),
            texts
                .iter()
                .map(|text| format!("X:{text}"))
                .collect::<Vec<_>>()
        );
        let max = max_in_flight.load(Ordering::SeqCst);
        assert!(max >= 2 && max <= DEEPLX_CONCURRENCY, "max in flight {max}");
        let bodies = seen.lock().expect("seen");
        assert!(bodies
            .iter()
            .all(|body| body.get("source_lang").and_then(|value| value.as_str()) == Some("EN")));
        assert!(bodies
            .iter()
            .all(|body| body.get("target_lang").and_then(|value| value.as_str()) == Some("ZH")));
        let auths = auths.lock().expect("auths");
        assert!(auths.iter().all(|value| value == "Bearer deeplx-token"));
    }

    #[derive(Clone)]
    struct OpenAiState {
        hits: Arc<AtomicUsize>,
        mode: &'static str,
        seen: Arc<Mutex<Vec<(String, String)>>>,
    }

    async fn openai_handler(
        State(state): State<OpenAiState>,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, StatusCode> {
        state.hits.fetch_add(1, Ordering::SeqCst);
        let content = body
            .pointer("/messages/1/content")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        state
            .seen
            .lock()
            .expect("seen")
            .push((uri.path().to_string(), content.clone()));
        let auth = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if auth != "Bearer openai-secret" {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if state.mode == "batch-broken" && content.contains("\"id\":\"2\"") {
            return Ok(Json(
                json!({"choices": [{"message": {"content": "not json"}}]}),
            ));
        }
        if state.mode == "shuffled" {
            return Ok(Json(
                json!({"choices": [{"message": {"content": "{\"items\":[{\"id\":\"2\",\"text\":\"二\"},{\"id\":\"1\",\"text\":\"一\"}]}"}}]}),
            ));
        }
        let parsed = content.split("items=").nth(1).unwrap_or("[]");
        let items: Value = serde_json::from_str(parsed).unwrap_or_else(|_| json!([]));
        let translated = items
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|item| {
                json!({
                    "id": item.get("id").cloned().unwrap_or(json!("")),
                    "text": format!("译{}", item.get("text").and_then(|value| value.as_str()).unwrap_or(""))
                })
            })
            .collect::<Vec<_>>();
        let payload =
            serde_json::to_string(&json!({"items": translated})).unwrap_or_else(|_| "{}".into());
        Ok(Json(
            json!({"choices": [{"message": {"content": payload}}]}),
        ))
    }

    fn openai_router(state: OpenAiState) -> Router {
        Router::new()
            .route("/v1/chat/completions", post(openai_handler))
            .route("/v1/v1/chat/completions", post(openai_handler))
            .with_state(state)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn openai_splits_a_shuffled_batch_by_id_and_uses_v1_once() {
        let state = OpenAiState {
            hits: Arc::new(AtomicUsize::new(0)),
            mode: "shuffled",
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let hits = state.hits.clone();
        let seen = state.seen.clone();
        let base = serve(openai_router(state)).await;
        let mut config = config("openai", &format!("{base}/v1"), "openai-secret");
        config.prompt = "keep names".into();
        let output = translate(&config, &["甲".into(), "乙".into()], "zh-CN", "en")
            .await
            .expect("openai");
        assert_eq!(plain(output), vec!["一".to_string(), "二".to_string()]);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let seen = seen.lock().expect("seen");
        assert!(
            seen.iter()
                .all(|(url, content)| url == "/v1/chat/completions"
                    && content.contains("keep names")),
            "{seen:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn openai_falls_back_to_one_block_at_a_time() {
        let state = OpenAiState {
            hits: Arc::new(AtomicUsize::new(0)),
            mode: "batch-broken",
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let hits = state.hits.clone();
        let base = serve(openai_router(state)).await;
        let output = translate(
            &config("openai", &base, "openai-secret"),
            &["A".into(), "B".into()],
            "en",
            "zh-CN",
        )
        .await
        .expect("fallback");
        assert_eq!(plain(output), vec!["译A".to_string(), "译B".to_string()]);
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timeout_is_retried_once() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let base = serve(Router::new().route(
            "/v2/translate",
            post(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    Json(json!({"translations": []}))
                }
            }),
        ))
        .await;
        let mut config = config("deepl", &base, "slow-key");
        config.timeout = Duration::from_millis(150);
        let error = translate(&config, &["Hi".into()], "en", "zh-CN")
            .await
            .expect_err("timeout");
        assert!(error.contains("超时"), "{error}");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unsupported_language_is_not_retried() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let base = serve(Router::new().route(
            "/v2/translate",
            post(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"message": "Translation from 'en' to 'ja' is not supported"})),
                    )
                }
            }),
        ))
        .await;
        let error = translate(&config("deepl", &base, "deepl-secret"), &["Hi".into()], "en", "ja")
            .await
            .expect_err("unsupported");
        assert_eq!(
            error,
            "当前翻译服务不支持 英文→日文，请换目标语言或更换接口"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(!error.contains("翻译失败：翻译失败"), "{error}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deeplx_and_openai_unsupported_pairs_stay_friendly() {
        let deeplx_hits = Arc::new(AtomicUsize::new(0));
        let counted = deeplx_hits.clone();
        let deeplx = serve(Router::new().route(
            "/deeplx",
            post(move || {
                let counted = counted.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::BAD_REQUEST,
                        Json(
                            json!({"error": "Translation from 'en' to 'ja' is not supported"}),
                        ),
                    )
                }
            }),
        ))
        .await;
        let error = translate(
            &config("deeplx", &format!("{deeplx}/deeplx"), ""),
            &["Hello".into(), "World".into()],
            "en",
            "ja",
        )
        .await
        .expect_err("deeplx unsupported");
        assert_eq!(
            error,
            "当前翻译服务不支持 英文→日文，请换目标语言或更换接口"
        );
        assert_eq!(deeplx_hits.load(Ordering::SeqCst), 2);

        let openai_hits = Arc::new(AtomicUsize::new(0));
        let counted = openai_hits.clone();
        let openai = serve(Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let counted = counted.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error": {"message": "Unsupported language pair"}})),
                    )
                }
            }),
        ))
        .await;
        let error = translate(
            &config("openai", &openai, "openai-secret"),
            &["Hello".into(), "World".into()],
            "zh-CN",
            "ja",
        )
        .await
        .expect_err("openai unsupported");
        assert_eq!(
            error,
            "当前翻译服务不支持 中文简体→日文，请换目标语言或更换接口"
        );
        assert_eq!(openai_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn missing_endpoint_points_at_settings() {
        let error = translate(&config("deepl", "", "key"), &["Hi".into()], "en", "zh-CN")
            .await
            .expect_err("missing");
        assert!(error.contains("打开设置"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "talks to a local LinguaSpark on 127.0.0.1:7100"]
    async fn live_linguaspark_deeplx() {
        let mut config = config("deeplx", "http://127.0.0.1:7100/deeplx", "");
        config.timeout = Duration::from_secs(20);
        let output = translate(
            &config,
            &["Hello world".into(), "Good morning".into()],
            "en",
            "zh-CN",
        )
        .await
        .expect("linguaspark");
        assert_eq!(output.len(), 2);
        assert!(output[0].text.contains('你'), "{output:?}");
        assert!(!output[1].text.is_empty(), "{output:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deepl_auto_omits_source_lang() {
        let state = Hits {
            hits: Arc::new(AtomicUsize::new(0)),
            fail_first: false,
            key: "deepl-secret".into(),
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let seen = state.seen.clone();
        let base = serve(
            Router::new()
                .route("/v2/translate", post(deepl_handler))
                .with_state(state),
        )
        .await;
        let _ = translate(
            &config("deepl", &base, "deepl-secret"),
            &["你好，今天天气很好。".into()],
            "auto",
            "en",
        )
        .await
        .expect("deepl auto");
        let body = seen
            .lock()
            .expect("seen")
            .last()
            .cloned()
            .unwrap_or_default();
        assert!(body.get("source_lang").is_none(), "{body}");
        assert_eq!(
            body.get("target_lang").and_then(|value| value.as_str()),
            Some("EN-US")
        );
    }

    async fn strict_deeplx(
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
        let source = body
            .get("source_lang")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let text = body
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if source.is_empty()
            || source.eq_ignore_ascii_case("auto")
            || source.eq_ignore_ascii_case("cmn")
        {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(
                    json!({"message": format!("Translation from '{source}' to 'en' is not supported")}),
                ),
            ));
        }
        if text.contains("FAIL") {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"message": "block failed"})),
            ));
        }
        Ok(Json(json!({"code": 200, "data": format!("ok:{text}")})))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deeplx_auto_sends_detected_code_and_keeps_other_blocks() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let base = serve(Router::new().route(
            "/deeplx",
            post(move |body: Json<Value>| {
                let seen = recorded.clone();
                async move {
                    seen.lock().expect("seen").push(body.0.clone());
                    strict_deeplx(body).await
                }
            }),
        ))
        .await;
        let output = translate(
            &config("deeplx", &format!("{base}/deeplx"), ""),
            &[
                "你好，今天天气很好。".into(),
                "FAIL this block".into(),
                "Hello world, this is a screenshot translation tool.".into(),
            ],
            "auto",
            "en",
        )
        .await
        .expect("partial");
        assert!(output[0].error.is_none(), "{output:?}");
        assert!(output[0].text.contains("你好"), "{output:?}");
        assert!(
            output[1]
                .error
                .as_deref()
                .unwrap_or("")
                .contains("block failed"),
            "{output:?}"
        );
        assert!(
            output[2].error.is_none() && output[2].text.contains("Hello"),
            "{output:?}"
        );
        let bodies = seen.lock().expect("seen");
        let source_of = |needle: &str| {
            bodies.iter().find_map(|body| {
                let text = body
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                text.contains(needle).then(|| {
                    body.get("source_lang")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                })
            })
        };
        assert_eq!(source_of("你好"), Some("ZH"), "{bodies:?}");
        assert_eq!(source_of("Hello world"), Some("EN"), "{bodies:?}");
        assert_eq!(source_of("FAIL"), Some("EN"), "{bodies:?}");
        assert!(bodies
            .iter()
            .all(|body| body.get("source_lang").and_then(|value| value.as_str()) != Some("auto")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn openai_auto_asks_the_model_to_detect() {
        let state = OpenAiState {
            hits: Arc::new(AtomicUsize::new(0)),
            mode: "ok",
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let seen = state.seen.clone();
        let base = serve(openai_router(state)).await;
        let _ = translate(
            &config("openai", &base, "openai-secret"),
            &["你好，今天天气很好。".into()],
            "auto",
            "en",
        )
        .await
        .expect("openai auto");
        let prompt = seen
            .lock()
            .expect("seen")
            .last()
            .map(|(_, content)| content.clone())
            .unwrap_or_default();
        assert!(prompt.contains("source_lang=auto-detect"), "{prompt}");
        assert!(!prompt.contains("Simplified Chinese (auto)"), "{prompt}");
    }

    #[test]
    fn language_maps_cover_deepl_and_deeplx() {
        assert_eq!(deepl_target("zh-CN"), "ZH");
        assert_eq!(deepl_target("en"), "EN-US");
        assert_eq!(deepl_target("zh-TW"), "ZH-HANT");
        assert_eq!(deepl_source("auto"), None);
        assert_eq!(deepl_source("en-GB").as_deref(), Some("EN"));
        assert_eq!(deeplx_lang("zh-CN", false), "ZH");
        assert_eq!(deeplx_lang("auto", true), "auto");
        assert_eq!(
            deeplx_source_for("auto", "你好，今天天气很好。").as_deref(),
            Some("ZH")
        );
        assert_eq!(
            deeplx_source_for(
                "auto",
                "Hello world, this is a screenshot translation tool."
            )
            .as_deref(),
            Some("EN")
        );
        assert_eq!(deeplx_source_for("zh-CN", "hello").as_deref(), Some("ZH"));
        assert_eq!(deeplx_source_for("auto", "。。").as_deref(), None);
        assert_eq!(language_label("auto"), "auto-detect");
        assert_eq!(deeplx_lang("ja", false), "JA");
        let linguaspark = friendly_translate_error(
            "翻译失败（400）：Translation from 'en' to 'ja' is not supported",
            "auto",
            "ja",
        );
        assert_eq!(
            linguaspark,
            "当前翻译服务不支持 英文→日文，请换目标语言或更换接口"
        );
        assert_eq!(
            friendly_translate_error(
                "翻译失败（400）：Value for 'target_lang' not supported.",
                "en",
                "ja"
            ),
            "当前翻译服务不支持 英文→日文，请换目标语言或更换接口"
        );
        assert_eq!(
            friendly_translate_error("翻译失败（400）：Unsupported language pair", "zh-CN", "ja"),
            "当前翻译服务不支持 中文简体→日文，请换目标语言或更换接口"
        );
        assert_eq!(
            friendly_translate_error("翻译失败（400）：block failed", "en", "ja"),
            "翻译失败（400）：block failed"
        );
        assert_eq!(linguaspark, friendly_translate_error(&linguaspark, "en", "ja"));
        assert_eq!(
            openai_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_url("https://example.com/v1/"),
            "https://example.com/v1/chat/completions"
        );
    }
}
