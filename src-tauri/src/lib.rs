pub mod ai_renamer;
pub mod config;
pub mod db;
pub mod file_ops;
pub mod renamer_rules;

pub mod ai_filing;

use crate::config::{AppConfig, ConfigManager};
use crate::db::DbManager;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub config_manager: ConfigManager,
    pub db_manager: DbManager,
    pub config: Mutex<AppConfig>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ai_renamer::generate_text,
            ai_renamer::propose_renames,
            ai_renamer::propose_hybrid_renames,
            renamer_rules::propose_advanced_renames,
            file_ops::execute_renames,
            file_ops::list_files_in_directory,
            file_ops::get_files_metadata,
            file_ops::read_file_preview,
            file_ops::save_extracted_data,
            ai_filing::propose_filing,
            ai_filing::propose_organize,
            file_ops::execute_filing,
            file_ops::organize_file,
            file_ops::delete_exact_duplicates,
            file_ops::move_files_to_trash,
            config::get_templates,
            config::save_templates,
            config::get_model_settings,
            config::set_model_id,
            config::list_available_models
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let config_manager =
                ConfigManager::new(app.handle()).expect("Failed to init config manager");
            let db_manager = DbManager::new(app.handle()).expect("Failed to init db manager");
            let config = config_manager.load().unwrap_or_default();

            app.manage(AppState {
                config_manager,
                db_manager,
                config: Mutex::new(config),
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
