use anyhow::{Context, Result};
use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub struct DbManager {
    db_path: PathBuf,
}

impl DbManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let app_dir = app_handle
            .path()
            .app_data_dir()
            .context("Failed to get app data dir")?;

        if !app_dir.exists() {
            std::fs::create_dir_all(&app_dir).context("Failed to create app data dir")?;
        }

        let db_path = app_dir.join("ocr_data.db");
        let manager = Self { db_path };
        manager.init_db().context("Failed to initialize database")?;
        Ok(manager)
    }

    pub fn get_connection(&self) -> SqlResult<Connection> {
        Connection::open(&self.db_path)
    }

    fn init_db(&self) -> SqlResult<()> {
        let conn = self.get_connection()?;

        // ファイル履歴用テーブル
        conn.execute(
            "CREATE TABLE IF NOT EXISTS file_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                original_name TEXT NOT NULL,
                new_name TEXT,
                file_path TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            (),
        )?;

        // FTS5 (全文検索) 用の仮想テーブル（将来用）
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(
                filename,
                content,
                tokenize='unicode61'
            )",
            (),
        )?;

        Ok(())
    }
}
