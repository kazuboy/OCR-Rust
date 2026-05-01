use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use genai::chat::{ChatMessage, ChatRequest};
use genai::resolver::AuthData;
use genai::Client;
use tauri::{AppHandle, Manager, State};
use tokio::time::timeout;

use crate::AppState;

const AI_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Serialize)]
pub struct FileTextContext {
    pub id: usize,
    pub filename: String,
    pub source: String,
    pub text_excerpt: String,
    pub original_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiRenameSuggestion {
    pub id: Option<usize>,
    pub original: Option<String>,
    pub proposed: String,
    pub reason: String,
    #[serde(skip_deserializing)]
    pub original_path: String,
}

fn get_model_config(state: &State<'_, AppState>) -> Result<(String, String), String> {
    let config = state
        .config
        .lock()
        .map_err(|e| format!("Failed to lock config: {}", e))?;
    let api_key = config
        .api_key
        .clone()
        .or_else(|| std::env::var("GEMINI_API_KEY").ok())
        .ok_or_else(|| "API Key is not configured.".to_string())?;

    Ok((api_key, config.model_id.clone()))
}

pub(crate) fn build_client_with_api_key(api_key: String) -> Client {
    Client::builder()
        .with_auth_resolver_fn(move |_model| Ok(Some(AuthData::from_single(api_key.clone()))))
        .build()
}

fn has_forbidden_path_components(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}

fn collect_allowed_roots(app: &AppHandle) -> Vec<PathBuf> {
    let resolver = app.path();
    let mut roots = Vec::new();
    for candidate in [
        resolver.home_dir(),
        resolver.desktop_dir(),
        resolver.document_dir(),
        resolver.download_dir(),
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.temp_dir(),
    ] {
        if let Ok(path) = candidate {
            let canonical = fs::canonicalize(&path).unwrap_or(path);
            if canonical.is_absolute() {
                roots.push(canonical);
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn ensure_path_in_allowed_roots(app: &AppHandle, canonical_path: &Path) -> Result<(), String> {
    let roots = collect_allowed_roots(app);
    if roots.is_empty() {
        return Err("No allowed directories are available in this environment".to_string());
    }
    if roots.iter().any(|root| canonical_path.starts_with(root)) {
        return Ok(());
    }
    Err("file_path is outside allowed directories".to_string())
}

fn resolve_existing_file_path_in_scope(app: &AppHandle, path_str: &str) -> Result<PathBuf, String> {
    let path = Path::new(path_str);
    if !path.is_absolute() {
        return Err("file_path must be absolute".to_string());
    }
    if has_forbidden_path_components(path) {
        return Err("file_path must not include '.' or '..' components".to_string());
    }
    let canonical = fs::canonicalize(path).map_err(|e| format!("Failed to resolve file_path: {}", e))?;
    if !canonical.is_file() {
        return Err("file_path is not a file".to_string());
    }
    ensure_path_in_allowed_roots(app, &canonical)?;
    Ok(canonical)
}

fn resolve_existing_dir_path_in_scope(app: &AppHandle, path_str: &str) -> Result<PathBuf, String> {
    let path = Path::new(path_str);
    if !path.is_absolute() {
        return Err("destination_dir must be absolute".to_string());
    }
    if has_forbidden_path_components(path) {
        return Err("destination_dir must not include '.' or '..' components".to_string());
    }
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("Failed to resolve destination_dir: {}", e))?;
    if !canonical.is_dir() {
        return Err("destination_dir is not a directory".to_string());
    }
    ensure_path_in_allowed_roots(app, &canonical)?;
    Ok(canonical)
}

pub(crate) fn sanitize_file_paths_in_scope(
    app: &AppHandle,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = resolve_existing_file_path_in_scope(app, &path)?;
        out.push(canonical.to_string_lossy().to_string());
    }
    Ok(out)
}

pub(crate) fn sanitize_destination_dirs_in_scope(
    app: &AppHandle,
    dirs: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let canonical = resolve_existing_dir_path_in_scope(app, &dir)?;
        out.push(canonical.to_string_lossy().to_string());
    }
    Ok(out)
}

pub fn extract_file_context(
    app: &AppHandle,
    paths: Vec<String>,
    max_chars: usize,
) -> Result<Vec<FileTextContext>, String> {
    let mut contexts = Vec::new();
    let safe_paths = sanitize_file_paths_in_scope(app, paths)?;

    for (i, canonical_path_str) in safe_paths.into_iter().enumerate() {
        let canonical_path = PathBuf::from(&canonical_path_str);
        let path = canonical_path.as_path();
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();

        let mut source = "filename_only".to_string();
        let mut text_excerpt = String::new();

        if ext == "pdf" {
            if let Ok(bytes) = fs::read(path) {
                if let Ok(out) = pdf_extract::extract_text_from_mem(&bytes) {
                    text_excerpt = out;
                    source = "pdf_text".to_string();
                } else {
                    source = "pdf_error".to_string();
                }
            }
        } else if ext == "txt" || ext == "md" || ext == "csv" || ext == "json" {
            if let Ok(content) = fs::read_to_string(path) {
                text_excerpt = content;
                source = "plain_text".to_string();
            }
        }

        if text_excerpt.chars().count() > max_chars {
            text_excerpt = text_excerpt.chars().take(max_chars).collect();
        }

        contexts.push(FileTextContext {
            id: i + 1,
            filename,
            source,
            text_excerpt,
            original_path: canonical_path_str,
        });
    }

    Ok(contexts)
}

#[tauri::command]
pub async fn propose_renames(
    app: AppHandle,
    prompt: String,
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<AiRenameSuggestion>, String> {
    if file_paths.is_empty() {
        return Ok(vec![]);
    }

    let (api_key, model_id) = get_model_config(&state)?;

    let contexts = extract_file_context(&app, file_paths, 2500)?;

    let payload_json = serde_json::to_string_pretty(&serde_json::json!({
        "user_instruction": prompt,
        "files": contexts.iter().map(|c| serde_json::json!({
            "id": c.id,
            "filename": c.filename,
            "source": c.source,
            "text_excerpt": c.text_excerpt
        })).collect::<Vec<_>>()
    }))
    .map_err(|e| format!("Failed to build payload: {}", e))?;

    let system_prompt = "You are a file-renaming agent.
Return JSON array only. No markdown.
Each item must be: {\"id\": number, \"original\": string, \"proposed\": string, \"reason\": string}.
Use `id` from the given file list whenever possible.
If a file should not be renamed, omit it from the response.";

    let client = build_client_with_api_key(api_key);
    let chat_req = ChatRequest::new(vec![
        ChatMessage::system(system_prompt),
        ChatMessage::user(payload_json),
    ]);

    let res = timeout(
        Duration::from_secs(AI_TIMEOUT_SECS),
        client.exec_chat(&model_id, chat_req, None),
    )
    .await
    .map_err(|_| format!("API Timeout: {}s exceeded", AI_TIMEOUT_SECS))?
    .map_err(|e| format!("API Error: {}", e))?;

    let response_text = res
        .into_first_text()
        .ok_or_else(|| "No response text".to_string())?;
    let cleaned = response_text
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();

    let parsed: Vec<AiRenameSuggestion> = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Failed to parse JSON: {}\nRaw: {}", e, cleaned))?;

    let mut results = Vec::new();
    for mut suggestion in parsed {
        if let Some(id) = suggestion.id {
            if let Some(ctx) = contexts.iter().find(|c| c.id == id) {
                suggestion.original_path = ctx.original_path.clone();
                results.push(suggestion);
                continue;
            }
        }

        if let Some(ref orig) = suggestion.original {
            if let Some(ctx) = contexts.iter().find(|c| c.filename == *orig) {
                suggestion.original_path = ctx.original_path.clone();
                results.push(suggestion);
            }
        }
    }

    Ok(results)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HybridExtractedVars {
    pub id: usize,
    pub vars: HashMap<String, String>,
}

#[tauri::command]
pub async fn propose_hybrid_renames(
    app: AppHandle,
    template: String,
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<AiRenameSuggestion>, String> {
    if file_paths.is_empty() || template.trim().is_empty() {
        return Ok(vec![]);
    }

    let mut variables = Vec::new();
    let mut in_var = false;
    let mut current_var = String::new();
    for c in template.chars() {
        if c == '[' {
            in_var = true;
            current_var.clear();
        } else if c == ']' && in_var {
            in_var = false;
            variables.push(current_var.clone());
        } else if in_var {
            current_var.push(c);
        }
    }

    let contexts = extract_file_context(&app, file_paths, 2500)?;
    let mut extracted_vars_map: HashMap<usize, HashMap<String, String>> = HashMap::new();

    if !variables.is_empty() {
        let (api_key, model_id) = get_model_config(&state)?;

        let payload_json = serde_json::to_string_pretty(&serde_json::json!({
            "variables_to_extract": variables,
            "files": contexts.iter().map(|c| serde_json::json!({
                "id": c.id,
                "text_excerpt": c.text_excerpt
            })).collect::<Vec<_>>()
        }))
        .map_err(|e| format!("Failed to build payload: {}", e))?;

        let system_prompt = "You are a data extraction agent.
Return JSON array only. No markdown.
Extract the requested `variables_to_extract` from each file's text.
Each item must be: {\"id\": number, \"vars\": {\"VarName\": \"ExtractedValue\"}}.
If a value is not found, use \"Unknown\".";

        let client = build_client_with_api_key(api_key);
        let chat_req = ChatRequest::new(vec![
            ChatMessage::system(system_prompt),
            ChatMessage::user(payload_json),
        ]);

        let res = timeout(
            Duration::from_secs(AI_TIMEOUT_SECS),
            client.exec_chat(&model_id, chat_req, None),
        )
        .await
        .map_err(|_| format!("API Timeout: {}s exceeded", AI_TIMEOUT_SECS))?
        .map_err(|e| format!("API Error: {}", e))?;

        let response_text = res
            .into_first_text()
            .ok_or_else(|| "No response text".to_string())?;
        let cleaned = response_text
            .replace("```json", "")
            .replace("```", "")
            .trim()
            .to_string();

        let parsed: Vec<HybridExtractedVars> = serde_json::from_str(&cleaned)
            .map_err(|e| format!("Failed to parse JSON: {}\nRaw: {}", e, cleaned))?;

        for item in parsed {
            extracted_vars_map.insert(item.id, item.vars);
        }
    }

    use crate::renamer_rules::build_bulk_manual_rename_items;

    let mut base_names = Vec::new();
    for ctx in &contexts {
        let mut final_name = template.clone();
        if let Some(vars) = extracted_vars_map.get(&ctx.id) {
            for (k, v) in vars {
                final_name = final_name.replace(&format!("[{}]", k), v);
            }
        }
        for v in &variables {
            final_name = final_name.replace(&format!("[{}]", v), "Unknown");
        }
        base_names.push((ctx.original_path.clone(), final_name));
    }

    let mut grouped_requests: HashMap<String, Vec<String>> = HashMap::new();
    for (path, base_name) in base_names {
        grouped_requests.entry(base_name).or_default().push(path);
    }

    let mut results = Vec::new();
    let mut suggestion_id = 1;
    for (base_name, paths) in grouped_requests {
        let plans = build_bulk_manual_rename_items(paths, &base_name, 3)?;
        for (original_path, proposed_name) in plans {
            results.push(AiRenameSuggestion {
                id: Some(suggestion_id),
                original: None,
                proposed: proposed_name,
                reason: "Hybrid template applied".to_string(),
                original_path,
            });
            suggestion_id += 1;
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn generate_text(prompt: String, state: State<'_, AppState>) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt is empty".to_string());
    }

    let (api_key, model_id) = get_model_config(&state)?;
    let client = build_client_with_api_key(api_key);
    let chat_req = ChatRequest::new(vec![ChatMessage::user(prompt)]);

    let res = timeout(
        Duration::from_secs(AI_TIMEOUT_SECS),
        client.exec_chat(&model_id, chat_req, None),
    )
    .await
    .map_err(|_| format!("API Timeout: {}s exceeded", AI_TIMEOUT_SECS))?
    .map_err(|e| format!("API Error: {}", e))?;

    res.into_first_text()
        .ok_or_else(|| "No response text".to_string())
}
