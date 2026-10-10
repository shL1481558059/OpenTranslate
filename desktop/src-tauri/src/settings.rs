use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const THEMES: &[&str] = &["system", "light", "dark"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub engine: String,
    pub theme: String,
    pub source_lang: String,
    pub target_lang: String,
    pub translation_api_url: String,
    pub llm_api_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub hotkey: String,
}

impl Settings {
    pub fn defaults() -> Self {
        let engine = match std::env::var("DESKTOP_TRANSLATION_ENGINE")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "llm" => "llm",
            _ => "api",
        };
        let theme = normalize_theme(&std::env::var("SNAP_TRANSLATE_THEME").unwrap_or_default(), "system");
        Self {
            engine: engine.to_string(),
            theme,
            source_lang: env_or("SOURCE_LANG", "auto"),
            target_lang: env_or("TARGET_LANG", "zh-CN"),
            translation_api_url: env_or("TRANSLATION_API_URL", "http://127.0.0.1:8787/v2/translate"),
            llm_api_url: env_or("LLM_API_URL", "https://api.openai.com/v1"),
            llm_api_key: env_or("LLM_API_KEY", ""),
            llm_model: env_or("LLM_MODEL", "gpt-4o-mini"),
            hotkey: env_or("SNAP_TRANSLATE_HOTKEY", "CommandOrControl+Shift+T"),
        }
    }

    pub fn load(path: &Path) -> Self {
        let defaults = Self::defaults();
        let Ok(raw) = fs::read_to_string(path) else {
            return defaults;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return defaults;
        };
        defaults.merged(&parsed)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        fs::write(path, raw).map_err(|error| error.to_string())
    }

    pub fn merged(&self, patch: &Value) -> Self {
        let mut next = self.clone();
        if let Some(engine) = patch.get("engine").and_then(|value| value.as_str()) {
            let engine = engine.to_ascii_lowercase();
            if engine == "api" || engine == "llm" {
                next.engine = engine;
            }
        }
        if let Some(theme) = patch.get("theme").and_then(|value| value.as_str()) {
            next.theme = normalize_theme(theme, &next.theme);
        }
        assign_string(&mut next.translation_api_url, patch, "translationApiUrl");
        assign_string(&mut next.llm_api_url, patch, "llmApiUrl");
        assign_string(&mut next.llm_api_key, patch, "llmApiKey");
        assign_string(&mut next.llm_model, patch, "llmModel");
        assign_string(&mut next.source_lang, patch, "sourceLang");
        assign_string(&mut next.target_lang, patch, "targetLang");
        assign_string(&mut next.hotkey, patch, "hotkey");
        if next.translation_api_url.trim().is_empty() {
            next.translation_api_url = "http://127.0.0.1:8787/v2/translate".into();
        }
        if next.source_lang.trim().is_empty() {
            next.source_lang = "auto".into();
        }
        if next.target_lang.trim().is_empty() {
            next.target_lang = "zh-CN".into();
        }
        next
    }

    pub fn to_public(&self, launch: Value) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let (Some(object), Some(launch)) = (value.as_object_mut(), launch.as_object()) {
            for (key, item) in launch {
                object.insert(key.clone(), item.clone());
            }
        }
        value
    }
}

fn assign_string(slot: &mut String, patch: &Value, key: &str) {
    if let Some(value) = patch.get(key).and_then(|value| value.as_str()) {
        *slot = value.trim().to_string();
    }
}

fn normalize_theme(value: &str, fallback: &str) -> String {
    let trimmed = value.trim().to_ascii_lowercase();
    if THEMES.contains(&trimmed.as_str()) {
        trimmed
    } else {
        fallback.to_string()
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| fallback.to_string())
}
