use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

use genai::chat::{ChatMessage, ChatRequest};
use tauri::{AppHandle, State};
use tokio::time::timeout;

use crate::ai_renamer::{
    build_client_with_api_key, extract_file_context, sanitize_destination_dirs_in_scope,
};
use crate::AppState;

const AI_ORGANIZE_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiFilingSuggestion {
    pub file_id: Option<usize>,
    pub destination_id: Option<usize>,
    pub reason: String,
    #[serde(skip_deserializing)]
    pub original_path: String,
    #[serde(skip_deserializing)]
    pub destination_path: String,
    #[serde(skip_deserializing)]
    pub destination_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiOrganizeSuggestion {
    pub file_id: Option<usize>,
    pub suggested_name: String,
    pub suggested_folder: String,
    pub reason: Option<String>,
    #[serde(skip_deserializing)]
    pub original_path: String,
    #[serde(skip_deserializing)]
    pub destination_path: String,
}

#[derive(Debug, Serialize)]
struct DestinationInfo {
    destination_id: usize,
    label: String,
    path: String,
}

#[tauri::command]
pub async fn propose_filing(
    app: AppHandle,
    prompt: String,
    file_paths: Vec<String>,
    destination_dirs: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<AiFilingSuggestion>, String> {
    if file_paths.is_empty() || destination_dirs.is_empty() {
        return Ok(vec![]);
    }

    let (api_key, model_id) = {
        let config = state
            .config
            .lock()
            .map_err(|e| format!("Failed to lock config: {}", e))?;
        let api_key = config
            .api_key
            .clone()
            .or_else(|| std::env::var("GEMINI_API_KEY").ok())
            .ok_or_else(|| "API Key is not configured.".to_string())?;
        (api_key, config.model_id.clone())
    };

    let file_contexts = extract_file_context(&app, file_paths, 2500)?;

    let safe_destination_dirs = sanitize_destination_dirs_in_scope(&app, destination_dirs)?;

    let mut dest_infos = Vec::new();
    for (i, dir_str) in safe_destination_dirs.into_iter().enumerate() {
        let path = Path::new(&dir_str);
        let label = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        dest_infos.push(DestinationInfo {
            destination_id: i + 1,
            label,
            path: dir_str,
        });
    }

    let payload_json = serde_json::to_string_pretty(&serde_json::json!({
        "instruction": prompt,
        "files": file_contexts.iter().map(|c| serde_json::json!({
            "file_id": c.id,
            "filename": c.filename,
            "text_excerpt": c.text_excerpt
        })).collect::<Vec<_>>(),
        "destinations": dest_infos
    }))
    .map_err(|e| format!("Failed to build payload: {}", e))?;

    let system_prompt = "You are a file-filing assistant.
Read files and destinations from input JSON and return destination proposals.
Return only a JSON array. Do not return markdown.
Each row must have: {\"file_id\": number, \"destination_id\": number, \"reason\": string}.
Omit files that do not need to move.";

    let client = build_client_with_api_key(api_key);
    let chat_req = ChatRequest::new(vec![
        ChatMessage::system(system_prompt),
        ChatMessage::user(payload_json),
    ]);

    let res = timeout(
        Duration::from_secs(AI_ORGANIZE_TIMEOUT_SECS),
        client.exec_chat(&model_id, chat_req, None),
    )
    .await
    .map_err(|_| format!("API Timeout: {}s exceeded", AI_ORGANIZE_TIMEOUT_SECS))?
    .map_err(|e| format!("API Error: {}", e))?;

    let response_text = res
        .into_first_text()
        .ok_or_else(|| "No response text".to_string())?;
    let cleaned = response_text
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();

    let parsed: Vec<AiFilingSuggestion> = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Failed to parse JSON: {}\nRaw: {}", e, cleaned))?;

    let mut results = Vec::new();
    for mut suggestion in parsed {
        let f_id = match suggestion.file_id {
            Some(id) => id,
            None => continue,
        };
        let d_id = match suggestion.destination_id {
            Some(id) => id,
            None => continue,
        };

        let file_ctx = file_contexts.iter().find(|c| c.id == f_id);
        let dest_ctx = dest_infos.iter().find(|d| d.destination_id == d_id);

        if let (Some(f), Some(d)) = (file_ctx, dest_ctx) {
            suggestion.original_path = f.original_path.clone();
            suggestion.destination_path = d.path.clone();
            suggestion.destination_name = d.label.clone();
            results.push(suggestion);
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn propose_organize(
    app: AppHandle,
    prompt: String,
    file_paths: Vec<String>,
    destination_dirs: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<AiOrganizeSuggestion>, String> {
    if file_paths.is_empty() || destination_dirs.is_empty() {
        return Ok(vec![]);
    }

    let (api_key, model_id) = {
        let config = state
            .config
            .lock()
            .map_err(|e| format!("Failed to lock config: {}", e))?;
        let api_key = config
            .api_key
            .clone()
            .or_else(|| std::env::var("GEMINI_API_KEY").ok())
            .ok_or_else(|| "API Key is not configured.".to_string())?;
        (api_key, config.model_id.clone())
    };

    let file_contexts = extract_file_context(&app, file_paths, 3000)?;
    let safe_destination_dirs = sanitize_destination_dirs_in_scope(&app, destination_dirs)?;
    let mut dest_infos = Vec::new();
    for (i, dir_str) in safe_destination_dirs.into_iter().enumerate() {
        let path = Path::new(&dir_str);
        let label = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        dest_infos.push(DestinationInfo {
            destination_id: i + 1,
            label,
            path: dir_str,
        });
    }

    let payload_json = serde_json::to_string_pretty(&serde_json::json!({
        "user_instruction": prompt,
        "files": file_contexts.iter().map(|c| serde_json::json!({
            "file_id": c.id,
            "filename": c.filename,
            "text_excerpt": c.text_excerpt
        })).collect::<Vec<_>>(),
        "destinations": dest_infos.iter().map(|d| serde_json::json!({
            "destination_id": d.destination_id,
            "label": d.label
        })).collect::<Vec<_>>()
    }))
    .map_err(|e| format!("Failed to build payload: {}", e))?;

    let system_prompt = "You are a document organization assistant.
Return ONLY a JSON array (no markdown).
For each input file, suggest both filename and destination in one item.
Use this schema:
[{\"file_id\": number, \"suggested_name\": string, \"suggested_folder\": string, \"reason\": string}]

Rules:
- `suggested_folder` MUST be one of the destination labels from input.
- Keep file extensions consistent with the original file unless user instruction says otherwise.
- Do not include path separators in `suggested_name`.
- If uncertain, still provide the best guess and include short reason.";

    let client = build_client_with_api_key(api_key);
    let chat_req = ChatRequest::new(vec![
        ChatMessage::system(system_prompt),
        ChatMessage::user(payload_json),
    ]);

    let res = timeout(
        Duration::from_secs(AI_ORGANIZE_TIMEOUT_SECS),
        client.exec_chat(&model_id, chat_req, None),
    )
    .await
    .map_err(|_| format!("API Timeout: {}s exceeded", AI_ORGANIZE_TIMEOUT_SECS))?
    .map_err(|e| format!("API Error: {}", e))?;

    let response_text = res
        .into_first_text()
        .ok_or_else(|| "No response text".to_string())?;
    let cleaned = response_text
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();

    let parsed: Vec<AiOrganizeSuggestion> = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Failed to parse JSON: {}\nRaw: {}", e, cleaned))?;

    let mut results = Vec::new();
    for mut suggestion in parsed {
        let file_id = match suggestion.file_id {
            Some(id) => id,
            None => continue,
        };

        let file_ctx = match file_contexts.iter().find(|c| c.id == file_id) {
            Some(f) => f,
            None => continue,
        };

        let dest_ctx = match dest_infos
            .iter()
            .find(|d| d.label == suggestion.suggested_folder)
        {
            Some(d) => d,
            None => continue,
        };

        suggestion.original_path = file_ctx.original_path.clone();
        suggestion.destination_path = dest_ctx.path.clone();
        results.push(suggestion);
    }

    Ok(results)
}
