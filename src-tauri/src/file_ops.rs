use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

const WINDOWS_INVALID_FILENAME_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_windows_reserved_name(file_name: &str) -> bool {
    let stem = file_name.split('.').next().unwrap_or(file_name);
    WINDOWS_RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str())
}

fn validate_proposed_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Proposed filename cannot be empty".to_string());
    }
    if Path::new(trimmed).is_absolute() {
        return Err("Proposed filename must not be an absolute path".to_string());
    }

    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => {
            return Err(
                "Proposed filename must be a single file name (no path separators)".to_string(),
            )
        }
    }

    if trimmed
        .chars()
        .any(|c| WINDOWS_INVALID_FILENAME_CHARS.contains(&c))
    {
        return Err("Proposed filename includes invalid characters".to_string());
    }
    if trimmed.ends_with(' ') || trimmed.ends_with('.') {
        return Err("Proposed filename cannot end with a space or period".to_string());
    }
    if is_windows_reserved_name(trimmed) {
        return Err("Proposed filename is a reserved Windows name".to_string());
    }

    Ok(trimmed.to_string())
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

fn ensure_path_in_allowed_roots(
    app: &AppHandle,
    canonical_path: &Path,
    field_name: &str,
) -> Result<(), String> {
    let roots = collect_allowed_roots(app);
    if roots.is_empty() {
        return Err("No allowed directories are available in this environment".to_string());
    }
    if roots.iter().any(|root| canonical_path.starts_with(root)) {
        return Ok(());
    }
    Err(format!("{} is outside allowed directories", field_name))
}

fn resolve_existing_path_in_scope(
    app: &AppHandle,
    path_str: &str,
    field_name: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(path_str);
    if !path.is_absolute() {
        return Err(format!("{} must be absolute", field_name));
    }
    if has_forbidden_path_components(path) {
        return Err(format!(
            "{} must not include '.' or '..' components",
            field_name
        ));
    }
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("Failed to resolve {}: {}", field_name, e))?;
    ensure_path_in_allowed_roots(app, &canonical, field_name)?;
    Ok(canonical)
}

fn resolve_existing_file_path_in_scope(
    app: &AppHandle,
    path_str: &str,
    field_name: &str,
) -> Result<PathBuf, String> {
    let canonical = resolve_existing_path_in_scope(app, path_str, field_name)?;
    if !canonical.is_file() {
        return Err(format!("{} is not a file", field_name));
    }
    Ok(canonical)
}

fn resolve_existing_dir_path_in_scope(
    app: &AppHandle,
    path_str: &str,
    field_name: &str,
) -> Result<PathBuf, String> {
    let canonical = resolve_existing_path_in_scope(app, path_str, field_name)?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a directory", field_name));
    }
    Ok(canonical)
}

fn resolve_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.exists() {
            return fs::canonicalize(candidate)
                .map_err(|e| format!("Failed to resolve ancestor path: {}", e));
        }
        current = candidate.parent();
    }
    Err("Path has no existing ancestor".to_string())
}

fn resolve_writable_file_path_in_scope(
    app: &AppHandle,
    path_str: &str,
    field_name: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(path_str);
    if !path.is_absolute() {
        return Err(format!("{} must be absolute", field_name));
    }
    if has_forbidden_path_components(path) {
        return Err(format!(
            "{} must not include '.' or '..' components",
            field_name
        ));
    }

    if path.exists() {
        let canonical =
            fs::canonicalize(path).map_err(|e| format!("Failed to resolve {}: {}", field_name, e))?;
        if canonical.is_dir() {
            return Err(format!("{} cannot be a directory", field_name));
        }
        ensure_path_in_allowed_roots(app, &canonical, field_name)?;
        return Ok(canonical);
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("{} must have a parent directory", field_name))?;
    let ancestor = resolve_existing_ancestor(parent)?;
    ensure_path_in_allowed_roots(app, &ancestor, field_name)?;
    Ok(path.to_path_buf())
}

fn validate_destination_dir(app: &AppHandle, path_str: &str) -> Result<PathBuf, String> {
    let dir = Path::new(path_str);
    if !dir.is_absolute() {
        return Err("Destination path must be absolute".to_string());
    }
    if has_forbidden_path_components(dir) {
        return Err("Destination path must not include '.' or '..' components".to_string());
    }
    if !dir.exists() {
        return Err("Destination directory does not exist".to_string());
    }
    if !dir.is_dir() {
        return Err("Destination path is not a directory".to_string());
    }

    let canonical =
        fs::canonicalize(dir).map_err(|e| format!("Failed to resolve destination directory: {}", e))?;
    ensure_path_in_allowed_roots(app, &canonical, "destination_path")?;
    Ok(canonical)
}

fn ensure_destination_dir(app: &AppHandle, path_str: &str) -> Result<PathBuf, String> {
    let dir = Path::new(path_str);
    if !dir.is_absolute() {
        return Err("Destination path must be absolute".to_string());
    }
    if has_forbidden_path_components(dir) {
        return Err("Destination path must not include '.' or '..' components".to_string());
    }
    if dir.exists() && !dir.is_dir() {
        return Err("Destination path is not a directory".to_string());
    }
    let existing_ancestor = resolve_existing_ancestor(dir)?;
    ensure_path_in_allowed_roots(app, &existing_ancestor, "target_dir")?;
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    let canonical =
        fs::canonicalize(dir).map_err(|e| format!("Failed to resolve destination directory: {}", e))?;
    ensure_path_in_allowed_roots(app, &canonical, "target_dir")?;
    Ok(canonical)
}

fn build_available_destination_path(target_dir: &Path, requested_name: &str, source_path: &Path) -> PathBuf {
    let initial = target_dir.join(requested_name);
    if !initial.exists() || initial == source_path {
        return initial;
    }

    let requested_path = Path::new(requested_name);
    let stem = requested_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(requested_name);
    let ext = requested_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    for i in 1..=9999 {
        let candidate_name = if ext.is_empty() {
            format!("{}_{:03}", stem, i)
        } else {
            format!("{}_{:03}.{}", stem, i, ext)
        };
        let candidate = target_dir.join(candidate_name);
        if !candidate.exists() || candidate == source_path {
            return candidate;
        }
    }

    initial
}

fn move_or_copy_with_rollback(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    match fs::rename(source_path, destination_path) {
        Ok(_) => Ok(()),
        Err(rename_err) => {
            fs::copy(source_path, destination_path).map_err(|copy_err| {
                format!(
                    "OS Copy Error (fallback after rename failed: {}): {}",
                    rename_err, copy_err
                )
            })?;
            if let Err(remove_err) = fs::remove_file(source_path) {
                let _ = fs::remove_file(destination_path);
                return Err(format!(
                    "Failed to remove original after copy (destination rolled back): {}",
                    remove_err
                ));
            }
            Ok(())
        }
    }
}

fn compute_sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn file_time_ms(t: std::io::Result<std::time::SystemTime>) -> u128 {
    t.ok()
        .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(u128::MAX)
}

fn pick_keeper_path(paths: &[String]) -> String {
    let mut sorted = paths.to_vec();
    sorted.sort_by(|a, b| {
        let ma = fs::metadata(a).ok();
        let mb = fs::metadata(b).ok();
        let ka = (
            ma.as_ref()
                .map(|m| file_time_ms(m.created()))
                .unwrap_or(u128::MAX),
            ma.as_ref()
                .map(|m| file_time_ms(m.modified()))
                .unwrap_or(u128::MAX),
            a.to_lowercase(),
        );
        let kb = (
            mb.as_ref()
                .map(|m| file_time_ms(m.created()))
                .unwrap_or(u128::MAX),
            mb.as_ref()
                .map(|m| file_time_ms(m.modified()))
                .unwrap_or(u128::MAX),
            b.to_lowercase(),
        );
        ka.cmp(&kb)
    });
    sorted.first().cloned().unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub original_path: String,
    pub proposed_name: String,
}

#[derive(Debug, Serialize)]
pub struct RenameResult {
    pub original_path: String,
    pub success: bool,
    pub new_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExactDuplicateDeleteResult {
    pub path: String,
    pub action: String,
    pub kept_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TrashMoveResult {
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn delete_exact_duplicates(
    app: AppHandle,
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ExactDuplicateDeleteResult>, String> {
    let conn = state
        .db_manager
        .get_connection()
        .map_err(|e| format!("DB Error: {}", e))?;

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let unique_paths: Vec<String> = file_paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect();

    if unique_paths.is_empty() {
        return Ok(results);
    }

    let mut size_groups: HashMap<u64, Vec<String>> = HashMap::new();
    for path in unique_paths {
        let canonical_path = match resolve_existing_file_path_in_scope(&app, &path, "file_path") {
            Ok(p) => p,
            Err(err) => {
                results.push(ExactDuplicateDeleteResult {
                    path,
                    action: "error".to_string(),
                    kept_path: None,
                    error: Some(err),
                });
                continue;
            }
        };
        match fs::metadata(&canonical_path) {
            Ok(meta) => {
                size_groups
                    .entry(meta.len())
                    .or_default()
                    .push(canonical_path.to_string_lossy().to_string());
            }
            Err(e) => {
                results.push(ExactDuplicateDeleteResult {
                    path: canonical_path.to_string_lossy().to_string(),
                    action: "error".to_string(),
                    kept_path: None,
                    error: Some(format!("Failed to read metadata: {}", e)),
                });
            }
        }
    }

    for (_, same_size_paths) in size_groups {
        if same_size_paths.len() == 1 {
            results.push(ExactDuplicateDeleteResult {
                path: same_size_paths[0].clone(),
                action: "unique".to_string(),
                kept_path: None,
                error: None,
            });
            continue;
        }

        let mut hash_groups: HashMap<String, Vec<String>> = HashMap::new();
        for path in same_size_paths {
            match compute_sha256_hex(Path::new(&path)) {
                Ok(hash) => hash_groups.entry(hash).or_default().push(path),
                Err(err) => results.push(ExactDuplicateDeleteResult {
                    path,
                    action: "error".to_string(),
                    kept_path: None,
                    error: Some(err),
                }),
            }
        }

        for (_, dup_paths) in hash_groups {
            if dup_paths.len() == 1 {
                results.push(ExactDuplicateDeleteResult {
                    path: dup_paths[0].clone(),
                    action: "unique".to_string(),
                    kept_path: None,
                    error: None,
                });
                continue;
            }

            let keeper = pick_keeper_path(&dup_paths);
            for path in dup_paths {
                if path == keeper {
                    results.push(ExactDuplicateDeleteResult {
                        path,
                        action: "kept".to_string(),
                        kept_path: Some(keeper.clone()),
                        error: None,
                    });
                    continue;
                }

                match fs::remove_file(&path) {
                    Ok(_) => {
                        let original_name = Path::new(&path)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let kept_name = Path::new(&keeper)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let _ = conn.execute(
                            "INSERT INTO file_history (original_name, new_name, file_path, status) VALUES (?1, ?2, ?3, ?4)",
                            (&original_name, &kept_name, &path, "DUPLICATE_REMOVED"),
                        );
                        results.push(ExactDuplicateDeleteResult {
                            path,
                            action: "deleted".to_string(),
                            kept_path: Some(keeper.clone()),
                            error: None,
                        });
                    }
                    Err(e) => results.push(ExactDuplicateDeleteResult {
                        path,
                        action: "error".to_string(),
                        kept_path: Some(keeper.clone()),
                        error: Some(format!("Failed to delete duplicate file: {}", e)),
                    }),
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn move_files_to_trash(
    app: AppHandle,
    file_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<TrashMoveResult>, String> {
    let conn = state
        .db_manager
        .get_connection()
        .map_err(|e| format!("DB Error: {}", e))?;

    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let unique_paths: Vec<String> = file_paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect();

    for path_str in unique_paths {
        let path = match resolve_existing_file_path_in_scope(&app, &path_str, "file_path") {
            Ok(p) => p,
            Err(err) => {
                results.push(TrashMoveResult {
                    path: path_str,
                    success: false,
                    error: Some(err),
                });
                continue;
            }
        };
        let canonical_path_str = path.to_string_lossy().to_string();

        let original_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        match trash::delete(&path) {
            Ok(_) => {
                let _ = conn.execute(
                    "INSERT INTO file_history (original_name, new_name, file_path, status) VALUES (?1, ?2, ?3, ?4)",
                    (
                        &original_name,
                        &"(trashed)".to_string(),
                        &canonical_path_str,
                        "TRASHED",
                    ),
                );
                results.push(TrashMoveResult {
                    path: canonical_path_str,
                    success: true,
                    error: None,
                });
            }
            Err(e) => results.push(TrashMoveResult {
                path: canonical_path_str,
                success: false,
                error: Some(format!("Failed to move file to trash: {}", e)),
            }),
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn execute_renames(
    app: AppHandle,
    requests: Vec<RenameRequest>,
    state: State<'_, AppState>,
) -> Result<Vec<RenameResult>, String> {
    let mut results = Vec::new();
    let conn = state
        .db_manager
        .get_connection()
        .map_err(|e| format!("DB Error: {}", e))?;

    for req in requests {
        let path = match resolve_existing_file_path_in_scope(&app, &req.original_path, "original_path")
        {
            Ok(p) => p,
            Err(err) => {
                results.push(RenameResult {
                    original_path: req.original_path,
                    success: false,
                    new_path: None,
                    error: Some(err),
                });
                continue;
            }
        };
        let canonical_original_path = path.to_string_lossy().to_string();

        let proposed_name = match validate_proposed_name(&req.proposed_name) {
            Ok(name) => name,
            Err(err) => {
                results.push(RenameResult {
                    original_path: canonical_original_path,
                    success: false,
                    new_path: None,
                    error: Some(err),
                });
                continue;
            }
        };

        let parent = match path.parent() {
            Some(parent) => parent,
            None => {
                results.push(RenameResult {
                    original_path: canonical_original_path,
                    success: false,
                    new_path: None,
                    error: Some("Original file has no parent directory".to_string()),
                });
                continue;
            }
        };

        let new_path = parent.join(&proposed_name);
        if new_path.exists() {
            results.push(RenameResult {
                original_path: canonical_original_path.clone(),
                success: false,
                new_path: None,
                error: Some("A file with the proposed name already exists".to_string()),
            });
            continue;
        }

        let original_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        match fs::rename(path, &new_path) {
            Ok(_) => {
                let new_path_str = new_path.to_string_lossy().to_string();

                let _ = conn.execute(
                    "INSERT INTO file_history (original_name, new_name, file_path, status) VALUES (?1, ?2, ?3, ?4)",
                    (&original_name, &proposed_name, &new_path_str, "SUCCESS"),
                );

                results.push(RenameResult {
                    original_path: canonical_original_path,
                    success: true,
                    new_path: Some(new_path_str),
                    error: None,
                });
            }
            Err(e) => {
                results.push(RenameResult {
                    original_path: canonical_original_path,
                    success: false,
                    new_path: None,
                    error: Some(format!("OS Rename Error: {}", e)),
                });
            }
        }
    }

    Ok(results)
}

#[derive(Debug, Deserialize)]
pub struct FilingRequest {
    pub original_path: String,
    pub destination_path: String,
}

#[derive(Debug, Deserialize)]
pub struct OrganizeRequest {
    pub original_path: String,
    pub target_dir: String,
    pub new_filename: String,
    pub is_move: bool,
}

#[tauri::command]
pub async fn organize_file(
    app: AppHandle,
    request: OrganizeRequest,
    state: State<'_, AppState>,
) -> Result<RenameResult, String> {
    let conn = state
        .db_manager
        .get_connection()
        .map_err(|e| format!("DB Error: {}", e))?;

    let path = match resolve_existing_file_path_in_scope(&app, &request.original_path, "original_path") {
        Ok(p) => p,
        Err(err) => {
            return Ok(RenameResult {
                original_path: request.original_path,
                success: false,
                new_path: None,
                error: Some(err),
            })
        }
    };
    let canonical_original_path = path.to_string_lossy().to_string();

    let new_filename = match validate_proposed_name(&request.new_filename) {
        Ok(name) => name,
        Err(err) => {
            return Ok(RenameResult {
                original_path: canonical_original_path.clone(),
                success: false,
                new_path: None,
                error: Some(err),
            })
        }
    };

    let target_dir = match ensure_destination_dir(&app, &request.target_dir) {
        Ok(dir) => dir,
        Err(err) => {
            return Ok(RenameResult {
                original_path: canonical_original_path.clone(),
                success: false,
                new_path: None,
                error: Some(err),
            })
        }
    };

    let new_path = build_available_destination_path(&target_dir, &new_filename, &path);

    if new_path == path {
        return Ok(RenameResult {
            original_path: canonical_original_path,
            success: true,
            new_path: Some(new_path.to_string_lossy().to_string()),
            error: None,
        });
    }

    let original_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let op_result = if request.is_move {
        move_or_copy_with_rollback(&path, &new_path)
    } else {
        fs::copy(&path, &new_path)
            .map(|_| ())
            .map_err(|e| format!("OS Copy Error: {}", e))
    };

    match op_result {
        Ok(_) => {
            let new_path_str = new_path.to_string_lossy().to_string();
            let final_name = new_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let status = if request.is_move { "ORGANIZE_MOVED" } else { "ORGANIZE_COPIED" };
            let _ = conn.execute(
                "INSERT INTO file_history (original_name, new_name, file_path, status) VALUES (?1, ?2, ?3, ?4)",
                (&original_name, &final_name, &new_path_str, status),
            );

            Ok(RenameResult {
                original_path: path.to_string_lossy().to_string(),
                success: true,
                new_path: Some(new_path_str),
                error: None,
            })
        }
        Err(err) => Ok(RenameResult {
            original_path: path.to_string_lossy().to_string(),
            success: false,
            new_path: None,
            error: Some(err),
        }),
    }
}

#[tauri::command]
pub async fn execute_filing(
    app: AppHandle,
    requests: Vec<FilingRequest>,
    state: State<'_, AppState>,
) -> Result<Vec<RenameResult>, String> {
    let mut results = Vec::new();
    let conn = state
        .db_manager
        .get_connection()
        .map_err(|e| format!("DB Error: {}", e))?;

    for req in requests {
        let path = match resolve_existing_file_path_in_scope(&app, &req.original_path, "original_path")
        {
            Ok(p) => p,
            Err(err) => {
                results.push(RenameResult {
                    original_path: req.original_path,
                    success: false,
                    new_path: None,
                    error: Some(err),
                });
                continue;
            }
        };
        let canonical_original_path = path.to_string_lossy().to_string();

        let dest_dir = match validate_destination_dir(&app, &req.destination_path) {
            Ok(path) => path,
            Err(err) => {
                results.push(RenameResult {
                    original_path: canonical_original_path.clone(),
                    success: false,
                    new_path: None,
                    error: Some(err),
                });
                continue;
            }
        };

        let original_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let new_path = build_available_destination_path(&dest_dir, &original_name, &path);

        match move_or_copy_with_rollback(&path, &new_path) {
            Ok(_) => {
                let new_path_str = new_path.to_string_lossy().to_string();
                let final_name = new_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let _ = conn.execute(
                    "INSERT INTO file_history (original_name, new_name, file_path, status) VALUES (?1, ?2, ?3, ?4)",
                    (&original_name, &final_name, &new_path_str, "FILING_SUCCESS"),
                );

                results.push(RenameResult {
                    original_path: canonical_original_path,
                    success: true,
                    new_path: Some(new_path_str),
                    error: None,
                });
            }
            Err(e) => {
                results.push(RenameResult {
                    original_path: canonical_original_path,
                    success: false,
                    new_path: None,
                    error: Some(e),
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn list_files_in_directory(app: AppHandle, directory_path: String) -> Result<Vec<String>, String> {
    let dir = resolve_existing_dir_path_in_scope(&app, &directory_path, "directory_path")?;

    let mut files = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            files.push(path.to_string_lossy().to_string());
        }
    }

    files.sort();
    Ok(files)
}

#[derive(Debug, Serialize)]
pub struct FileMetadata {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
}

#[tauri::command]
pub async fn get_files_metadata(app: AppHandle, file_paths: Vec<String>) -> Result<Vec<FileMetadata>, String> {
    let mut results = Vec::new();

    for path_str in file_paths {
        let canonical_path = match resolve_existing_path_in_scope(&app, &path_str, "file_path") {
            Ok(p) => p,
            Err(_) => {
                let raw_path = Path::new(&path_str);
                results.push(FileMetadata {
                    path: path_str.clone(),
                    file_name: raw_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    extension: raw_path
                        .extension()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                        .to_lowercase(),
                    size_bytes: 0,
                    created_ms: None,
                    modified_ms: None,
                });
                continue;
            }
        };
        let canonical_path_str = canonical_path.to_string_lossy().to_string();
        let path = canonical_path.as_path();
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
            .to_lowercase();

        let (size_bytes, created_ms, modified_ms) = match fs::metadata(path) {
            Ok(meta) => {
                let size = meta.len();
                let created = meta.created().ok().map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64
                });
                let modified = meta.modified().ok().map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64
                });
                (size, created, modified)
            }
            Err(_) => (0, None, None),
        };

        results.push(FileMetadata {
            path: canonical_path_str,
            file_name,
            extension,
            size_bytes,
            created_ms,
            modified_ms,
        });
    }

    Ok(results)
}

#[derive(Debug, Serialize)]
pub struct FilePreview {
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub preview_type: String,
    pub content: Option<String>,
}

#[tauri::command]
pub async fn save_extracted_data(
    app: AppHandle,
    file_path: String,
    content: String,
    append: bool,
) -> Result<(), String> {
    let path = resolve_writable_file_path_in_scope(&app, &file_path, "file_path")?;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    if append {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("Failed to open file for append: {}", e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to append content: {}", e))?;
    } else {
        fs::write(&path, content).map_err(|e| format!("Failed to write content: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn read_file_preview(app: AppHandle, file_path: String) -> Result<FilePreview, String> {
    use base64::{engine::general_purpose, Engine as _};

    let path = resolve_existing_file_path_in_scope(&app, &file_path, "file_path")?;
    let path = path.as_path();

    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
        .to_lowercase();

    let meta = fs::metadata(path).map_err(|e| format!("Failed to read metadata: {}", e))?;
    let size_bytes = meta.len();

    let format_time = |t: std::io::Result<std::time::SystemTime>| -> Option<String> {
        t.ok().map(|st| {
            let duration = st.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
            let secs = duration.as_secs() as i64;
            chrono::DateTime::from_timestamp(secs, 0)
                .map(|dt: chrono::DateTime<chrono::Utc>| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default()
        })
    };

    let created = format_time(meta.created());
    let modified = format_time(meta.modified());

    let image_exts = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg"];
    let text_exts = [
        "txt", "md", "csv", "json", "xml", "html", "log", "toml", "yaml", "yml", "rs", "py", "js",
        "ts",
    ];

    let (preview_type, content) = if image_exts.contains(&extension.as_str()) {
        if size_bytes > 10 * 1024 * 1024 {
            ("image".to_string(), Some("FILE_TOO_LARGE".to_string()))
        } else {
            match fs::read(path) {
                Ok(bytes) => {
                    let b64 = general_purpose::STANDARD.encode(&bytes);
                    let mime = match extension.as_str() {
                        "png" => "image/png",
                        "gif" => "image/gif",
                        "bmp" => "image/bmp",
                        "webp" => "image/webp",
                        "svg" => "image/svg+xml",
                        _ => "image/jpeg",
                    };
                    (
                        "image".to_string(),
                        Some(format!("data:{};base64,{}", mime, b64)),
                    )
                }
                Err(e) => ("image".to_string(), Some(format!("READ_ERROR: {}", e))),
            }
        }
    } else if text_exts.contains(&extension.as_str()) {
        match fs::read(path) {
            Ok(bytes) => {
                let (utf8_text, _, malformed) = encoding_rs::UTF_8.decode(&bytes);
                let text = if malformed {
                    let (sjis_text, _, _) = encoding_rs::SHIFT_JIS.decode(&bytes);
                    sjis_text.into_owned()
                } else {
                    utf8_text.into_owned()
                };

                let truncated: String = text.chars().take(5000).collect();
                let suffix = if text.chars().count() > 5000 {
                    "\n\n... (truncated)"
                } else {
                    ""
                };
                ("text".to_string(), Some(format!("{}{}", truncated, suffix)))
            }
            Err(e) => ("text".to_string(), Some(format!("READ_ERROR: {}", e))),
        }
    } else if extension == "pdf" {
        match pdf_extract::extract_text(path) {
            Ok(text) => {
                let truncated: String = text.chars().take(5000).collect();
                let suffix = if text.chars().count() > 5000 {
                    "\n\n... (truncated)"
                } else {
                    ""
                };
                (
                    "text".to_string(),
                    Some(format!(
                        "--- Extracted text from PDF ---\n\n{}{}",
                        truncated, suffix
                    )),
                )
            }
            Err(e) => ("text".to_string(), Some(format!("PDF_TEXT_ERROR: {}", e))),
        }
    } else {
        ("unsupported".to_string(), None)
    };

    Ok(FilePreview {
        file_name,
        extension,
        size_bytes,
        created,
        modified,
        preview_type,
        content,
    })
}
