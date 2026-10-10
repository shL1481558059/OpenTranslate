use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const MAX_BODY_BYTES: usize = 128 * 1024;

const SOURCE_LANGUAGES: &[(&str, &str)] = &[
    ("AR", "Arabic"),
    ("BG", "Bulgarian"),
    ("CS", "Czech"),
    ("DA", "Danish"),
    ("DE", "German"),
    ("EL", "Greek"),
    ("EN", "English"),
    ("ES", "Spanish"),
    ("ET", "Estonian"),
    ("FI", "Finnish"),
    ("FR", "French"),
    ("HE", "Hebrew"),
    ("HU", "Hungarian"),
    ("ID", "Indonesian"),
    ("IT", "Italian"),
    ("JA", "Japanese"),
    ("KO", "Korean"),
    ("LT", "Lithuanian"),
    ("LV", "Latvian"),
    ("NB", "Norwegian (Bokmål)"),
    ("NL", "Dutch"),
    ("PL", "Polish"),
    ("PT", "Portuguese"),
    ("RO", "Romanian"),
    ("RU", "Russian"),
    ("SK", "Slovak"),
    ("SL", "Slovenian"),
    ("SV", "Swedish"),
    ("TH", "Thai"),
    ("TR", "Turkish"),
    ("UK", "Ukrainian"),
    ("VI", "Vietnamese"),
    ("ZH", "Chinese"),
];

const TARGET_EXTRAS: &[(&str, &str, bool)] = &[
    ("DE-DE", "German (Germany)", true),
    ("DE-CH", "German (Switzerland)", true),
    ("EN-GB", "English (British)", false),
    ("EN-US", "English (American)", false),
    ("ES-419", "Spanish (Latin American)", true),
    ("ES-ES", "Spanish (Spain)", true),
    ("FR-CA", "French (Canada)", true),
    ("FR-FR", "French (France)", true),
    ("PT-BR", "Portuguese (Brazilian)", true),
    ("PT-PT", "Portuguese (European)", true),
    ("ZH-HANS", "Chinese (simplified)", false),
    ("ZH-HANT", "Chinese (traditional)", false),
];

fn source_set() -> HashSet<&'static str> {
    SOURCE_LANGUAGES.iter().map(|(code, _)| *code).collect()
}

fn target_set() -> HashSet<&'static str> {
    let mut set = source_set();
    set.remove("EN");
    set.insert("ZH");
    for (code, _, _) in TARGET_EXTRAS {
        set.insert(*code);
    }
    set
}

fn source_aliases() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("ZH-CN", "ZH"),
        ("ZH-SG", "ZH"),
        ("ZH-HANS", "ZH"),
        ("ZH-TW", "ZH"),
        ("ZH-HK", "ZH"),
        ("ZH-MO", "ZH"),
        ("ZH-HANT", "ZH"),
        ("EN-US", "EN"),
        ("EN-GB", "EN"),
        ("PT-BR", "PT"),
        ("PT-PT", "PT"),
        ("DE-DE", "DE"),
        ("DE-CH", "DE"),
        ("ES-419", "ES"),
        ("ES-ES", "ES"),
        ("FR-CA", "FR"),
        ("FR-FR", "FR"),
        ("NO", "NB"),
        ("NB-NO", "NB"),
    ])
}

fn target_aliases() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("EN", "EN-US"),
        ("ZH-CN", "ZH"),
        ("ZH-SG", "ZH"),
        ("ZH-TW", "ZH-HANT"),
        ("ZH-HK", "ZH-HANT"),
        ("ZH-MO", "ZH-HANT"),
        ("EN-UK", "EN-GB"),
        ("NO", "NB"),
        ("NB-NO", "NB"),
    ])
}

fn formality_targets() -> HashSet<&'static str> {
    HashSet::from([
        "DE", "DE-DE", "DE-CH", "ES", "ES-419", "ES-ES", "FR", "FR-CA", "FR-FR", "IT", "JA", "NL", "PL", "PT-BR", "PT-PT", "RU",
    ])
}

fn engine_lang(code: &str) -> Option<&'static str> {
    Some(match code {
        "AR" => "ar",
        "BG" => "bg",
        "CS" => "cs",
        "DA" => "da",
        "DE" => "de",
        "EL" => "el",
        "EN" => "en",
        "ES" => "es",
        "ET" => "et",
        "FI" => "fi",
        "FR" => "fr",
        "HE" => "he",
        "HU" => "hu",
        "ID" => "id",
        "IT" => "it",
        "JA" => "ja",
        "KO" => "ko",
        "LT" => "lt",
        "LV" => "lv",
        "NB" => "nb",
        "NL" => "nl",
        "PL" => "pl",
        "PT" => "pt",
        "RO" => "ro",
        "RU" => "ru",
        "SK" => "sk",
        "SL" => "sl",
        "SV" => "sv",
        "TH" => "th",
        "TR" => "tr",
        "UK" => "uk",
        "VI" => "vi",
        "ZH" => "zh",
        _ => return None,
    })
}

pub fn canonical_token(value: &str) -> String {
    value.trim().replace('_', "-").to_uppercase()
}

pub struct LangResult {
    pub ok: bool,
    pub code: Option<String>,
    pub message: String,
}

pub fn normalize_source_lang(value: Option<&str>) -> LangResult {
    let Some(raw) = value else {
        return LangResult { ok: true, code: None, message: String::new() };
    };
    if raw.trim().is_empty() {
        return LangResult { ok: true, code: None, message: String::new() };
    }
    let token = canonical_token(raw);
    let aliases = source_aliases();
    let code = aliases.get(token.as_str()).copied().unwrap_or(token.as_str()).to_string();
    if source_set().contains(code.as_str()) {
        LangResult { ok: true, code: Some(code), message: String::new() }
    } else {
        LangResult {
            ok: false,
            code: None,
            message: "Value for 'source_lang' not supported.".into(),
        }
    }
}

pub fn normalize_target_lang(value: Option<&str>) -> LangResult {
    let Some(raw) = value.map(str::trim).filter(|item| !item.is_empty()) else {
        return LangResult {
            ok: false,
            code: None,
            message: "Missing or empty 'target_lang' parameter.".into(),
        };
    };
    let token = canonical_token(raw);
    let aliases = target_aliases();
    let code = aliases.get(token.as_str()).copied().unwrap_or(token.as_str()).to_string();
    if target_set().contains(code.as_str()) {
        LangResult { ok: true, code: Some(code), message: String::new() }
    } else {
        LangResult {
            ok: false,
            code: None,
            message: "Value for 'target_lang' not supported.".into(),
        }
    }
}

pub fn to_engine_lang(code: &str) -> String {
    let token = canonical_token(code);
    let aliases = source_aliases();
    let source = if let Some(alias) = aliases.get(token.as_str()) {
        (*alias).to_string()
    } else if token.starts_with("ZH") {
        "ZH".into()
    } else {
        token.split('-').next().unwrap_or(&token).to_string()
    };
    if let Some(lang) = engine_lang(&source).or_else(|| engine_lang(&token)) {
        return lang.to_string();
    }
    source.to_lowercase()
}

pub fn to_detected_source_language(engine_or_code: &str) -> String {
    let token = canonical_token(engine_or_code);
    let sources = source_set();
    if sources.contains(token.as_str()) {
        return token;
    }
    if let Some(alias) = source_aliases().get(token.as_str()) {
        return (*alias).to_string();
    }
    let lower = engine_or_code.trim().to_lowercase();
    if lower.starts_with("zh") {
        return "ZH".into();
    }
    if lower.starts_with("en") {
        return "EN".into();
    }
    if lower.starts_with("pt") {
        return "PT".into();
    }
    if lower == "nb" || lower == "no" {
        return "NB".into();
    }
    let upper = token.split('-').next().unwrap_or("").to_string();
    if sources.contains(upper.as_str()) { upper } else { "EN".into() }
}

pub fn count_characters(text: &str) -> u64 {
    text.chars().count() as u64
}

pub fn detect_language(text: &str) -> Option<&'static str> {
    let input = text.trim();
    if input.is_empty() {
        return None;
    }
    if input.chars().any(|ch| ('\u{ac00}'..='\u{d7a3}').contains(&ch)) {
        return Some("ko");
    }
    if input.chars().any(|ch| ('\u{3041}'..='\u{309f}').contains(&ch) || ('\u{30a0}'..='\u{30ff}').contains(&ch)) {
        return Some("ja");
    }
    if input.chars().any(|ch| ('\u{3400}'..='\u{9fff}').contains(&ch)) {
        return Some("zh");
    }
    let lower = input.to_lowercase();
    let mut best: Option<&'static str> = None;
    let mut best_score = 0i32;
    for (lang, chars, words) in [
        ("fr", Some("àâæçéèêëîïôœùûüÿ"), Some(&["bonjour", "merci", "avec", "pour", "vous", "nous", "est", "une", "des", "les", "pas", "dans", "sur", "que", "qui", "mais", "tout", "monde"][..])),
        ("es", Some("áéíóúñ¿¡"), Some(&["hola", "gracias", "para", "usted", "que", "como", "esta", "está", "una", "unos", "unas", "los", "las", "con", "por", "del", "mundo"][..])),
        ("de", Some("äöüß"), Some(&["hallo", "danke", "und", "der", "die", "das", "ist", "nicht", "mit", "für", "eine", "einer", "einen", "welt"][..])),
        ("en", None, Some(&["hello", "thanks", "please", "the", "and", "with", "this", "that", "you", "your", "world", "how", "are"][..])),
    ] {
        let mut score = 0;
        if let Some(chars) = chars {
            if lower.chars().any(|ch| chars.contains(ch)) {
                score += 3;
            }
        }
        if let Some(words) = words {
            for word in words {
                let needle = format!(" {word} ");
                let padded = format!(" {lower} ");
                if padded.contains(&needle) {
                    score += 2;
                }
            }
        }
        if score > best_score {
            best = Some(lang);
            best_score = score;
        }
    }
    if best_score > 0 {
        return best;
    }
    if lower.chars().any(|ch| ch.is_ascii_alphabetic()) {
        Some("en")
    } else {
        None
    }
}

pub fn list_languages(kind: &str) -> Vec<Value> {
    if kind.eq_ignore_ascii_case("target") {
        let formality = formality_targets();
        let mut items: Vec<Value> = SOURCE_LANGUAGES
            .iter()
            .filter(|(code, _)| *code != "EN" && *code != "ZH")
            .map(|(language, name)| {
                json!({
                    "language": language,
                    "name": name,
                    "supports_formality": formality.contains(language)
                })
            })
            .collect();
        items.push(json!({
            "language": "ZH",
            "name": "Chinese (simplified)",
            "supports_formality": false
        }));
        for (language, name, supports) in TARGET_EXTRAS {
            items.push(json!({
                "language": language,
                "name": name,
                "supports_formality": supports
            }));
        }
        return items;
    }
    SOURCE_LANGUAGES
        .iter()
        .map(|(language, name)| json!({ "language": language, "name": name }))
        .collect()
}

pub struct TranslateBody {
    pub texts: Vec<String>,
    pub source_lang: Option<String>,
    pub target_lang: String,
    pub show_billed_characters: bool,
    pub model_type_used: Option<String>,
    pub tag_handling_version: Option<String>,
}

pub fn normalize_translate_body(body: &Value) -> Result<TranslateBody, (u16, String)> {
    if !body.is_object() {
        return Err((400, "Bad request. Please check error message and your parameters.".into()));
    }
    let texts = string_list(body.get("text"));
    if texts.is_empty() {
        return Err((400, "Missing or empty 'text' parameter.".into()));
    }
    let source = normalize_source_lang(body.get("source_lang").and_then(value_as_str));
    if !source.ok {
        return Err((400, source.message));
    }
    let target = normalize_target_lang(body.get("target_lang").and_then(value_as_str));
    if !target.ok {
        return Err((400, target.message));
    }
    let model_type = body.get("model_type").and_then(value_as_str).map(str::trim).filter(|item| !item.is_empty());
    let model_type_used = model_type.map(|model| {
        if model == "quality_optimized" || model == "prefer_quality_optimized" {
            "quality_optimized".into()
        } else {
            "latency_optimized".into()
        }
    });
    let tag_handling = body
        .get("tag_handling")
        .and_then(value_as_str)
        .unwrap_or("")
        .to_lowercase();
    let tag_handling_version = if tag_handling == "xml" || tag_handling == "html" {
        let version = body.get("tag_handling_version").and_then(value_as_str).unwrap_or("v2").to_lowercase();
        Some(if version == "v1" { "v1".into() } else { "v2".into() })
    } else {
        None
    };
    Ok(TranslateBody {
        texts,
        source_lang: source.code,
        target_lang: target.code.unwrap_or_default(),
        show_billed_characters: truthy(body.get("show_billed_characters")),
        model_type_used,
        tag_handling_version,
    })
}

fn value_as_str(value: &Value) -> Option<&str> {
    value.as_str()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| match item {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }).collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(Value::String(text)) if text.is_empty() => Vec::new(),
        Some(other) => vec![match other {
            Value::String(text) => text.clone(),
            value => value.to_string(),
        }],
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64() == Some(1),
        Some(Value::String(text)) => matches!(text.trim().to_lowercase().as_str(), "1" | "true" | "yes"),
        _ => false,
    }
}

pub fn parse_request_body(raw: &[u8], content_type: &str) -> Result<Value, ()> {
    let text = String::from_utf8_lossy(raw);
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let kind = content_type.split(';').next().unwrap_or("").trim().to_lowercase();
    if kind == "application/json" || (kind.is_empty() && text.trim_start().starts_with('{')) {
        let parsed: Value = serde_json::from_str(&text).map_err(|_| ())?;
        if !parsed.is_object() {
            return Err(());
        }
        return Ok(parsed);
    }
    if kind == "multipart/form-data" {
        return parse_multipart(&text, content_type).map_err(|_| ());
    }
    Ok(form_to_body(&text))
}

fn form_to_body(text: &str) -> Value {
    let mut map = Map::new();
    let mut texts = Vec::new();
    for (key, value) in form_urlencoded::parse(text.as_bytes()) {
        if key == "text" {
            texts.push(Value::String(value.into_owned()));
            continue;
        }
        push_field(&mut map, key.into_owned(), Value::String(value.into_owned()));
    }
    map.insert("text".into(), Value::Array(texts));
    Value::Object(map)
}

fn parse_multipart(text: &str, content_type: &str) -> Result<Value, ()> {
    let boundary = content_type
        .split(';')
        .filter_map(|part| part.trim().strip_prefix("boundary="))
        .map(|value| value.trim_matches('"'))
        .next()
        .ok_or(())?;
    let mut map = Map::new();
    let mut texts = Vec::new();
    for part in text.split(&format!("--{boundary}")) {
        if part.is_empty() || part == "--" || part == "--\r\n" {
            continue;
        }
        let Some((headers, body)) = part.split_once("\r\n\r\n") else { continue };
        let mut body = body.trim_end_matches("\r\n").trim_end_matches("--").to_string();
        if body.ends_with("--") {
            body.truncate(body.len().saturating_sub(2));
        }
        let Some(name) = headers.split("name=\"").nth(1).and_then(|rest| rest.split('"').next()) else { continue };
        if name == "text" {
            texts.push(Value::String(body));
        } else {
            push_field(&mut map, name.to_string(), Value::String(body));
        }
    }
    map.insert("text".into(), Value::Array(texts));
    Ok(Value::Object(map))
}

fn push_field(map: &mut Map<String, Value>, key: String, value: Value) {
    match map.get_mut(&key) {
        Some(Value::Array(items)) => items.push(value),
        Some(existing) => {
            let previous = existing.clone();
            *existing = json!([previous, value]);
        }
        None => {
            map.insert(key, value);
        }
    }
}

pub fn error_payload(message: &str, code: Option<&str>) -> Value {
    let mut payload = json!({ "message": message });
    if let Some(code) = code {
        payload["code"] = json!(code);
    }
    payload
}

pub fn status_code_for(status: u16) -> &'static str {
    match status {
        400 => "bad_request",
        403 => "authorization_failed",
        404 => "not_found",
        413 => "payload_too_large",
        429 | 529 => "too_many_requests",
        456 => "quota_exceeded",
        504 => "service_unavailable",
        _ => "internal_error",
    }
}

pub fn provider_failure(message: &str) -> (u16, String, &'static str) {
    if message.contains("missing_model:") || message.contains("no_translation_pair:") || message.contains("timeout") {
        return (504, "Resource currently unavailable. Try again later.".into(), "service_unavailable");
    }
    if message.contains("429") || message.contains("rate") {
        return (429, "Too many requests. Please wait and resend your request.".into(), "too_many_requests");
    }
    (500, "Internal error.".into(), "internal_error")
}

pub fn configured_auth_key() -> String {
    std::env::var("DEEPL_AUTH_KEY")
        .or_else(|_| std::env::var("TRANSLATION_API_KEY"))
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn is_loopback(address: &str) -> bool {
    let ip = address.trim().trim_start_matches("::ffff:");
    ip == "127.0.0.1" || ip == "::1" || address.trim() == "::1"
}

pub fn authorize(remote: &str, authorization: &str, query_key: Option<&str>, body: Option<&Value>) -> Result<(), (u16, String)> {
    let expected = configured_auth_key();
    let denied = "Authorization failed. Please supply a valid DeepL-Auth-Key via the Authorization header.".to_string();
    if expected.is_empty() {
        if is_loopback(remote) {
            return Ok(());
        }
        return Err((403, denied));
    }
    let provided = extract_auth_key(authorization, query_key, body);
    if !provided.is_empty() && keys_match(&provided, &expected) {
        return Ok(());
    }
    Err((403, denied))
}

fn extract_auth_key(authorization: &str, query_key: Option<&str>, body: Option<&Value>) -> String {
    if let Some(rest) = strip_prefix_ignore_case(authorization.trim(), "DeepL-Auth-Key") {
        return rest.trim().to_string();
    }
    if let Some(rest) = strip_prefix_ignore_case(authorization.trim(), "Bearer") {
        return rest.trim().to_string();
    }
    if let Some(value) = body.and_then(|item| item.get("auth_key")).and_then(|item| item.as_str()) {
        if !value.trim().is_empty() {
            return value.trim().to_string();
        }
    }
    query_key.unwrap_or("").trim().to_string()
}

fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&value[prefix.len()..])
    } else {
        None
    }
}

fn keys_match(provided: &str, expected: &str) -> bool {
    let left = provided.as_bytes();
    let right = expected.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

pub fn trace_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|item| item.as_nanos()).unwrap_or(0);
    format!("{nanos:032x}")
}
