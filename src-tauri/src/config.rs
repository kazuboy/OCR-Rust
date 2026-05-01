use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: Option<String>,
    pub model_id: String,
    pub dark_mode: bool,
    pub renamer_templates: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            model_id: "gemini-flash-latest".to_string(),
            dark_mode: true,
            renamer_templates: vec![
                "ファイル内容を読み取り、適切なファイル名と最適な保存先フォルダをセットで提案してください。".to_string(),
                "請求書・領収書は、日付_発行元_金額の形式でファイル名を提案し、保存先も提案してください。".to_string(),
                "契約書・申込書は、書類種別_相手先_日付の形式でファイル名を提案し、保存先も提案してください。".to_string(),
                "画像ファイルは内容を要約した短い日本語名を提案し、拡張子は維持してください。".to_string(),
                "不明な内容は無理に推測せず、汎用フォルダに分類して理由を短く添えてください。".to_string(),
            ],
        }
    }
}

pub struct ConfigManager {
    config_path: PathBuf,
}

impl ConfigManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        // AppDataDir is e.g. %APPDATA%\com.ocr-rust.dev
        let app_dir = app_handle
            .path()
            .app_data_dir()
            .context("Failed to get app data dir")?;

        if !app_dir.exists() {
            fs::create_dir_all(&app_dir).context("Failed to create app data dir")?;
        }

        let config_path = app_dir.join("config.json");
        Ok(Self { config_path })
    }

    pub fn load(&self) -> Result<AppConfig> {
        if !self.config_path.exists() {
            return Ok(AppConfig::default());
        }
        let content = fs::read_to_string(&self.config_path)?;
        let config: AppConfig = serde_json::from_str(&content).unwrap_or_default();
        Ok(config)
    }

    pub fn save(&self, config: &AppConfig) -> Result<()> {
        let content = serde_json::to_string_pretty(config)?;
        fs::write(&self.config_path, content)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSettings {
    pub model_id: String,
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListItem {
    pub id: String,
    pub display_name: String,
}

#[tauri::command]
pub fn get_templates(state: tauri::State<'_, crate::AppState>) -> Result<Vec<String>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.renamer_templates.clone())
}

#[tauri::command]
pub fn save_templates(
    templates: Vec<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.renamer_templates = templates;
    state
        .config_manager
        .save(&config)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_model_settings(state: tauri::State<'_, crate::AppState>) -> Result<ModelSettings, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let has_api_key = config
        .api_key
        .as_ref()
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
        || std::env::var("GEMINI_API_KEY")
            .ok()
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
    Ok(ModelSettings {
        model_id: config.model_id.clone(),
        has_api_key,
    })
}

#[tauri::command]
pub fn set_model_id(model_id: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return Err("Model ID cannot be empty".to_string());
    }
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.model_id = trimmed.to_string();
    state.config_manager.save(&config).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_available_models(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ModelListItem>, String> {
    let api_key = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config
            .api_key
            .clone()
            .or_else(|| std::env::var("GEMINI_API_KEY").ok())
            .ok_or_else(|| "API Key is not configured.".to_string())?
    };

    let resp = reqwest::Client::new()
        .get("https://generativelanguage.googleapis.com/v1beta/models")
        .query(&[("key", api_key)])
        .send()
        .await
        .map_err(|e| format!("Failed to call model list API: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Model list API error ({}): {}",
            status,
            body.chars().take(300).collect::<String>()
        ));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse model list response: {}", e))?;
    let models = json
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Unexpected model list response format".to_string())?;

    let mut out = Vec::new();
    for m in models {
        let methods = m
            .get("supportedGenerationMethods")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let supports_generate = methods
            .iter()
            .filter_map(|v| v.as_str())
            .any(|s| s.eq_ignore_ascii_case("generateContent"));
        if !supports_generate {
            continue;
        }

        let raw_name = m.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        if raw_name.is_empty() {
            continue;
        }
        let id = raw_name.strip_prefix("models/").unwrap_or(raw_name).to_string();
        let display_name = m
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.clone());
        out.push(ModelListItem { id, display_name });
    }

    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

