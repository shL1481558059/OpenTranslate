use serde_json::{json, Value};
use std::fs;
use std::path::Path;

use crate::secrets;
use crate::translate::TranslateConfig;

const THEMES: &[&str] = &["system", "light", "dark"];
const PROVIDERS: &[&str] = &["deepl", "deeplx", "openai"];

#[derive(Clone)]
pub struct Settings {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub prompt: String,
    pub theme: String,
    pub source_lang: String,
    pub target_lang: String,
    pub hotkey: String,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Settings")
            .field("provider", &self.provider)
            .field("base_url", &self.base_url)
            .field("api_key", &"<redacted>")
            .field("model", &self.model)
            .field("prompt", &self.prompt)
            .field("theme", &self.theme)
            .field("source_lang", &self.source_lang)
            .field("target_lang", &self.target_lang)
            .field("hotkey", &self.hotkey)
            .finish()
    }
}

impl Settings {
    pub fn defaults() -> Self {
        Self {
            provider: normalize_provider(&env_or("OPENTRANSLATE_PROVIDER", "deepl")),
            base_url: env_or("OPENTRANSLATE_BASE_URL", ""),
            api_key: String::new(),
            model: env_or("OPENTRANSLATE_MODEL", "gpt-4o-mini"),
            prompt: env_or("OPENTRANSLATE_PROMPT", ""),
            theme: normalize_theme(&std::env::var("SNAP_TRANSLATE_THEME").unwrap_or_default(), "system"),
            source_lang: env_or("SOURCE_LANG", "auto"),
            target_lang: env_or("TARGET_LANG", "zh-CN"),
            hotkey: env_or("SNAP_TRANSLATE_HOTKEY", "CommandOrControl+Shift+T"),
        }
    }

    pub fn load(path: &Path) -> Self {
        let defaults = Self::defaults();
        let Ok(raw) = fs::read_to_string(path) else {
            let mut settings = defaults;
            if settings.api_key.is_empty() {
                settings.api_key = secrets::load(path);
            }
            if settings.api_key.is_empty() {
                settings.api_key = env_key();
            }
            return settings;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return defaults;
        };
        let legacy_key = first_string(&parsed, &["apiKey", "llmApiKey"]);
        let mut settings = if parsed.get("provider").and_then(|value| value.as_str()).is_some() {
            defaults.merged(&parsed)
        } else {
            defaults.merged(&legacy_patch(&parsed))
        };
        if settings.api_key.is_empty() {
            settings.api_key = secrets::load(path);
        }
        if settings.api_key.is_empty() {
            settings.api_key = legacy_key.clone();
        }
        if settings.api_key.is_empty() {
            settings.api_key = env_key();
        }
        let stored_has_secret = parsed.get("apiKey").and_then(|value| value.as_str()).is_some_and(|value| !value.is_empty())
            || parsed.get("llmApiKey").and_then(|value| value.as_str()).is_some_and(|value| !value.is_empty());
        if !legacy_key.is_empty() {
            let _ = secrets::store(path, &settings.api_key);
        }
        if stored_has_secret || parsed.get("provider").is_none() {
            let _ = settings.save(path);
        }
        settings
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建设置目录。".to_string())?;
        }
        let stored = json!({
            "provider": self.provider,
            "baseUrl": self.base_url,
            "model": self.model,
            "prompt": self.prompt,
            "theme": self.theme,
            "sourceLang": self.source_lang,
            "targetLang": self.target_lang,
            "hotkey": self.hotkey
        });
        let raw = serde_json::to_string_pretty(&stored).map_err(|_| "无法序列化设置。".to_string())?;
        fs::write(path, raw).map_err(|_| "无法保存设置。".to_string())
    }

    pub fn merged(&self, patch: &Value) -> Self {
        let mut next = self.clone();
        if let Some(provider) = patch.get("provider").and_then(|value| value.as_str()) {
            let provider = normalize_provider(provider);
            if PROVIDERS.contains(&provider.as_str()) {
                next.provider = provider;
            }
        }
        if let Some(theme) = patch.get("theme").and_then(|value| value.as_str()) {
            next.theme = normalize_theme(theme, &next.theme);
        }
        assign_string(&mut next.base_url, patch, "baseUrl");
        assign_string(&mut next.model, patch, "model");
        assign_string(&mut next.prompt, patch, "prompt");
        assign_string(&mut next.source_lang, patch, "sourceLang");
        assign_string(&mut next.target_lang, patch, "targetLang");
        assign_string(&mut next.hotkey, patch, "hotkey");
        if patch.get("apiKey").and_then(|value| value.as_str()).is_some() {
            assign_string(&mut next.api_key, patch, "apiKey");
        }
        if next.source_lang.trim().is_empty() {
            next.source_lang = "auto".into();
        }
        if next.target_lang.trim().is_empty() {
            next.target_lang = "zh-CN".into();
        }
        if next.model.trim().is_empty() {
            next.model = "gpt-4o-mini".into();
        }
        next
    }

    pub fn is_configured(&self) -> bool {
        if self.base_url.trim().is_empty() {
            return false;
        }
        if self.provider != "deeplx" && self.api_key.trim().is_empty() {
            return false;
        }
        PROVIDERS.contains(&self.provider.as_str())
    }

    pub fn translation(&self) -> TranslateConfig {
        TranslateConfig::from_settings(&self.provider, &self.base_url, &self.api_key, &self.model, &self.prompt)
    }

    pub fn to_public(&self, launch: Value) -> Value {
        let mut value = json!({
            "provider": self.provider,
            "baseUrl": self.base_url,
            "apiKey": self.api_key,
            "model": self.model,
            "prompt": self.prompt,
            "theme": self.theme,
            "sourceLang": self.source_lang,
            "targetLang": self.target_lang,
            "hotkey": self.hotkey,
            "configured": self.is_configured()
        });
        if let (Some(object), Some(launch)) = (value.as_object_mut(), launch.as_object()) {
            for (key, item) in launch {
                object.insert(key.clone(), item.clone());
            }
        }
        value
    }
}

fn legacy_patch(raw: &Value) -> Value {
    let mut patch = raw.clone();
    let engine = raw.get("engine").and_then(|value| value.as_str()).unwrap_or("api");
    if engine.eq_ignore_ascii_case("llm") {
        patch["provider"] = json!("openai");
        if let Some(url) = raw.get("llmApiUrl") {
            patch["baseUrl"] = url.clone();
        }
        if let Some(model) = raw.get("llmModel") {
            patch["model"] = model.clone();
        }
        if let Some(key) = raw.get("llmApiKey") {
            patch["apiKey"] = key.clone();
        }
    } else {
        patch["provider"] = json!("deepl");
        let url = raw.get("translationApiUrl").and_then(|value| value.as_str()).unwrap_or("");
        patch["baseUrl"] = json!(strip_legacy_url(url));
    }
    patch
}

fn strip_legacy_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains("127.0.0.1:8787") || trimmed.contains("localhost:8787") {
        return String::new();
    }
    trimmed.trim_end_matches("/v2/translate").trim_end_matches('/').to_string()
}

fn first_string(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|item| item.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn assign_string(slot: &mut String, patch: &Value, key: &str) {
    if let Some(value) = patch.get(key).and_then(|value| value.as_str()) {
        *slot = value.trim().to_string();
    }
}

fn normalize_provider(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "deeplx" => "deeplx".into(),
        "openai" | "llm" => "openai".into(),
        "deepl" | "api" => "deepl".into(),
        other => other.to_string(),
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
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn env_key() -> String {
    for key in ["OPENTRANSLATE_API_KEY", "TRANSLATION_API_KEY", "DEEPL_AUTH_KEY"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_settings(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ot-settings-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn save_omits_the_api_key_and_stores_it_beside_settings() {
        let path = temp_settings("save");
        let mut settings = Settings::defaults();
        settings.provider = "deepl".into();
        settings.base_url = "https://api-free.deepl.com".into();
        settings.api_key = "super-secret-key".into();
        settings.save(&path).unwrap();
        secrets::store(&path, &settings.api_key).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("super-secret-key"));
        assert!(!raw.contains("apiKey"));
        let secret = path.parent().unwrap().join("api-key");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "super-secret-key");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&secret).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let loaded = Settings::load(&path);
        assert_eq!(loaded.api_key, "super-secret-key");
        assert!(!format!("{loaded:?}").contains("super-secret-key"));
    }

    #[test]
    fn migrates_an_old_llm_settings_file_and_strips_the_key() {
        let path = temp_settings("llm");
        fs::write(
            &path,
            r#"{"engine":"llm","llmApiUrl":"https://api.openai.com/v1","llmApiKey":"sk-legacy","llmModel":"gpt-4o-mini","theme":"dark","sourceLang":"en","targetLang":"ja","hotkey":"Control+Shift+T"}"#,
        )
        .unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.provider, "openai");
        assert_eq!(loaded.base_url, "https://api.openai.com/v1");
        assert_eq!(loaded.model, "gpt-4o-mini");
        assert_eq!(loaded.api_key, "sk-legacy");
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("sk-legacy"));
        assert!(!raw.contains("llmApiKey"));
        assert!(raw.contains("\"provider\": \"openai\""));
    }

    #[test]
    fn drops_the_removed_local_api_and_keeps_an_external_deepl_base() {
        let local = temp_settings("local");
        fs::write(
            &local,
            r#"{"engine":"api","translationApiUrl":"http://127.0.0.1:8787/v2/translate"}"#,
        )
        .unwrap();
        let loaded = Settings::load(&local);
        assert_eq!(loaded.provider, "deepl");
        assert_eq!(loaded.base_url, "");
        assert!(!loaded.is_configured());

        let remote = temp_settings("remote");
        fs::write(
            &remote,
            r#"{"engine":"api","translationApiUrl":"https://api-free.deepl.com/v2/translate"}"#,
        )
        .unwrap();
        let loaded = Settings::load(&remote);
        assert_eq!(loaded.base_url, "https://api-free.deepl.com");
    }
}
