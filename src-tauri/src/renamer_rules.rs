use std::collections::HashSet;
use std::path::Path;
use tauri::AppHandle;

const WINDOWS_INVALID_FILENAME_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

pub fn normalize_requested_stem(requested_name: &str) -> Result<String, String> {
    let raw = requested_name.trim();
    if raw.is_empty() {
        return Err("新しいファイル名を入力してください。".to_string());
    }

    // 無効な文字をアンダースコアに置換
    let mut stem: String = raw
        .chars()
        .map(|c| {
            if WINDOWS_INVALID_FILENAME_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();

    stem = stem.trim_end_matches(&[' ', '.'][..]).to_string();

    if stem.is_empty() {
        return Err("有効なファイル名を入力してください。".to_string());
    }

    Ok(stem)
}

pub fn build_bulk_manual_rename_items(
    source_paths: Vec<String>,
    requested_name: &str,
    sequence_digits: usize,
) -> Result<Vec<(String, String)>, String> {
    let base_stem = normalize_requested_stem(requested_name)?;
    let width = sequence_digits.max(1);

    let mut plans = Vec::new();
    let mut reserved_dest_keys = HashSet::new();

    // 元ファイルのキーを収集（大文字小文字を区別しない比較用）
    let source_keys: HashSet<String> = source_paths.iter().map(|p| p.to_lowercase()).collect();

    for src_path in source_paths {
        let path = Path::new(&src_path);
        let src_key = src_path.to_lowercase();

        // 拡張子の取得
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let mut seq = 0;
        loop {
            let stem = if seq == 0 {
                base_stem.clone()
            } else {
                format!("{}_{:0width$}", base_stem, seq, width = width)
            };

            let dest_name = format!("{}{}", stem, ext);
            let dest_path = path.with_file_name(&dest_name);
            let dest_key = dest_path.to_string_lossy().to_lowercase();

            if reserved_dest_keys.contains(&dest_key) {
                seq += 1;
                continue;
            }

            if dest_key != src_key {
                if source_keys.contains(&dest_key) {
                    seq += 1;
                    continue;
                }
                if dest_path.exists() {
                    seq += 1;
                    continue;
                }
            }

            reserved_dest_keys.insert(dest_key);
            plans.push((src_path, dest_name)); // 元のパスと提案されるファイル名
            break;
        }
    }

    Ok(plans)
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct AdvancedRenameOptions {
    pub replace_old: String,
    pub replace_new: String,
    pub remove_text: String,
    pub use_regex: bool,
    pub regex_pattern: String,
    pub regex_repl: String,
    pub prefix: String,
    pub suffix: String,
    pub metadata_format: String,
    pub case_mode: String, // "none", "upper", "lower", "title"
    pub sequence_enabled: bool,
    pub sequence_start: usize,
    pub sequence_digits: usize,
    pub sequence_separator: String,
}

impl Default for AdvancedRenameOptions {
    fn default() -> Self {
        Self {
            replace_old: String::new(),
            replace_new: String::new(),
            remove_text: String::new(),
            use_regex: false,
            regex_pattern: String::new(),
            regex_repl: String::new(),
            prefix: String::new(),
            suffix: String::new(),
            metadata_format: String::new(),
            case_mode: "none".to_string(),
            sequence_enabled: false,
            sequence_start: 1,
            sequence_digits: 3,
            sequence_separator: "_".to_string(),
        }
    }
}

pub fn apply_metadata(path: &str, format_str: &str) -> String {
    if format_str.is_empty() {
        return String::new();
    }

    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return format_str.to_string(),
    };

    let mut result = format_str.to_string();

    let format_time = |sys_time: std::time::SystemTime| -> Option<chrono::DateTime<chrono::Local>> {
        let dt: chrono::DateTime<chrono::Utc> = sys_time.into();
        Some(dt.with_timezone(&chrono::Local))
    };

    let created = metadata.created().ok().or_else(|| metadata.modified().ok());
    let modified = metadata.modified().ok();

    if let Some(c) = created.and_then(format_time) {
        result = result.replace("{created:%Y%m%d}", &c.format("%Y%m%d").to_string());
        result = result.replace("{created:%Y%m}", &c.format("%Y%m").to_string());
        result = result.replace("{created:%Y}", &c.format("%Y").to_string());
        result = result.replace("{created}", &c.format("%Y%m%d").to_string());
    }

    if let Some(m) = modified.and_then(format_time) {
        result = result.replace("{modified:%Y%m%d}", &m.format("%Y%m%d").to_string());
        result = result.replace("{modified:%Y%m}", &m.format("%Y%m").to_string());
        result = result.replace("{modified:%Y}", &m.format("%Y").to_string());
        result = result.replace("{modified}", &m.format("%Y%m%d").to_string());
    }

    result
}

pub fn apply_case(name: &str, mode: &str) -> String {
    match mode.to_lowercase().as_str() {
        "upper" => name.to_uppercase(),
        "lower" => name.to_lowercase(),
        "title" => {
            let mut c = name.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f
                    .to_uppercase()
                    .chain(c.flat_map(|c| c.to_lowercase()))
                    .collect(),
            }
        }
        _ => name.to_string(),
    }
}

pub fn build_new_name(
    path: &str,
    index: usize,
    options: &AdvancedRenameOptions,
) -> Result<String, String> {
    let p = Path::new(path);
    let file_name = p.file_name().unwrap_or_default().to_string_lossy();

    let stem = p
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let mut new_stem = stem.clone();

    // 1. 正規表現
    if options.use_regex && !options.regex_pattern.is_empty() {
        if let Ok(re) = regex::Regex::new(&options.regex_pattern) {
            new_stem = re
                .replace_all(&new_stem, options.regex_repl.as_str())
                .to_string();
        }
    }

    // 2. 文字列置換 & 削除
    if !options.replace_old.is_empty() {
        new_stem = new_stem.replace(&options.replace_old, &options.replace_new);
    }
    if !options.remove_text.is_empty() {
        new_stem = new_stem.replace(&options.remove_text, "");
    }

    // 3. メタデータ展開と Prefix / Suffix
    let metadata_text = apply_metadata(path, &options.metadata_format);
    new_stem = format!(
        "{}{}{}{}",
        options.prefix, metadata_text, new_stem, options.suffix
    );

    // 4. 大文字小文字
    new_stem = apply_case(&new_stem, &options.case_mode).trim().to_string();

    // 5. 連番
    if options.sequence_enabled {
        let seq_num = options.sequence_start + index;
        let width = options.sequence_digits.max(1);
        let seq_str = format!("{:0width$}", seq_num, width = width);

        if new_stem.contains("{n}") {
            new_stem = new_stem.replace("{n}", &seq_str);
        } else {
            new_stem = format!("{}{}{}", new_stem, options.sequence_separator, seq_str);
        }
    }

    // 6. サニタイズ
    new_stem = normalize_requested_stem(&new_stem).unwrap_or(new_stem);

    if new_stem.is_empty() {
        return Err(format!("変換後のファイル名が空になりました: {}", file_name));
    }

    Ok(format!("{}{}", new_stem, ext))
}

pub fn build_advanced_rename_items(
    source_paths: Vec<String>,
    options: AdvancedRenameOptions,
) -> Result<Vec<(String, String)>, String> {
    let mut plans = Vec::new();
    let mut seen_dest = HashSet::new();

    for (index, src_path) in source_paths.into_iter().enumerate() {
        let new_name = build_new_name(&src_path, index, &options)?;

        let p = Path::new(&src_path);
        let dst_path = p.with_file_name(&new_name);
        let dest_key = dst_path.to_string_lossy().to_lowercase();

        if src_path.to_lowercase() != dest_key {
            if seen_dest.contains(&dest_key) {
                return Err(format!("変換後に重複ファイル名が発生します: {}", new_name));
            }
            if dst_path.exists() {
                return Err(format!("同名ファイルが既に存在します: {}", new_name));
            }
        }

        seen_dest.insert(dest_key);
        plans.push((src_path, new_name));
    }

    Ok(plans)
}

use crate::ai_renamer::AiRenameSuggestion;

#[tauri::command]
pub async fn propose_advanced_renames(
    app: AppHandle,
    options: AdvancedRenameOptions,
    file_paths: Vec<String>,
) -> Result<Vec<AiRenameSuggestion>, String> {
    if file_paths.is_empty() {
        return Ok(vec![]);
    }

    let safe_paths = crate::ai_renamer::sanitize_file_paths_in_scope(&app, file_paths)?;
    let plans = build_advanced_rename_items(safe_paths, options)?;

    let mut results = Vec::new();
    let mut suggestion_id = 1;

    for (original_path, proposed_name) in plans {
        results.push(AiRenameSuggestion {
            id: Some(suggestion_id),
            original: None,
            proposed: proposed_name,
            reason: "ルールベース適用".to_string(),
            original_path,
        });
        suggestion_id += 1;
    }

    Ok(results)
}
