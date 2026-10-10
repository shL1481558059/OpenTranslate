use serde_json::{json, Value};

pub fn normalize_target(value: &str) -> String {
    let token = value.trim().replace('_', "-").to_uppercase();
    match token.as_str() {
        "" => "ZH".into(),
        "EN" => "EN-US".into(),
        "ZH-CN" | "ZH-SG" => "ZH".into(),
        "ZH-TW" | "ZH-HK" | "ZH-MO" => "ZH-HANT".into(),
        "EN-UK" => "EN-GB".into(),
        "NO" | "NB-NO" => "NB".into(),
        other => other.to_string(),
    }
}

pub fn normalize_source(value: &str) -> Option<String> {
    let token = value.trim().replace('_', "-").to_uppercase();
    if token.is_empty() || token == "AUTO" {
        return None;
    }
    Some(match token.as_str() {
        "ZH-CN" | "ZH-SG" | "ZH-HANS" | "ZH-TW" | "ZH-HK" | "ZH-HANT" => "ZH".into(),
        "EN-US" | "EN-GB" => "EN".into(),
        "PT-BR" | "PT-PT" => "PT".into(),
        "NO" | "NB-NO" => "NB".into(),
        other => other.to_string(),
    })
}

pub async fn translate_texts(
    api_url: &str,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<String>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut body = json!({
        "text": texts,
        "target_lang": normalize_target(target_lang),
    });
    if let Some(source) = normalize_source(source_lang) {
        body["source_lang"] = json!(source);
    }
    let client = reqwest::Client::new();
    let mut last_error = "translation failed".to_string();
    for attempt in 0..2 {
        let response = match client.post(api_url).json(&body).send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                if attempt == 0 {
                    continue;
                }
                return Err(last_error);
            }
        };
        let status = response.status();
        if status.is_success() {
            let payload: Value = response.json().await.map_err(|error| error.to_string())?;
            let translations = payload
                .get("translations")
                .and_then(|value| value.as_array())
                .ok_or_else(|| "DeepL response is missing translations".to_string())?;
            return Ok(translations
                .iter()
                .map(|item| item.get("text").and_then(|value| value.as_str()).unwrap_or("").to_string())
                .collect());
        }
        let payload = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&payload)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string())
            })
            .unwrap_or(payload);
        last_error = message;
        let retry = status.as_u16() == 429 || status.as_u16() == 500 || status.as_u16() == 504 || status.as_u16() == 529;
        if attempt == 0 && retry {
            continue;
        }
        return Err(last_error);
    }
    Err(last_error)
}

pub async fn translate_with_llm(
    api_url: &str,
    api_key: &str,
    model: &str,
    texts: &[String],
    source_lang: &str,
    target_lang: &str,
) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Err("auth_required".into());
    }
    let items: Vec<Value> = texts
        .iter()
        .enumerate()
        .map(|(index, text)| json!({ "id": format!("t{}", index + 1), "text": text }))
        .collect();
    let prompt = format!(
        "Translate each input text segment into the target language.\nReturn JSON only in this schema:\n{{\"items\":[{{\"id\":\"string\",\"translated_text\":\"string\"}}]}}\nKeep ids unchanged.\nsource_lang={source_lang}\ntarget_lang={target_lang}\nitems={}",
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
    );
    let endpoint = format!("{}/chat/completions", api_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "temperature": 0,
            "response_format": { "type": "json_object" },
            "messages": [
                { "role": "system", "content": "You are a translation engine. Output strict JSON only." },
                { "role": "user", "content": prompt }
            ]
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("llm_api_{}", response.status()));
    }
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: Value = serde_json::from_str(content).map_err(|error| error.to_string())?;
    let items = parsed
        .get("items")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "invalid_model_payload".to_string())?;
    Ok(items
        .iter()
        .map(|item| {
            item.get("translated_text")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect())
}
