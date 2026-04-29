use std::{path::Path, str::FromStr};

use anyhow::Context;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

pub async fn connect_db(database_path: &str) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = Path::new(database_path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent).await?;
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{database_path}"))?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);

    SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .with_context(|| format!("failed to open sqlite database {database_path}"))
}

pub async fn migrate(db: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            file_hash TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            encoding TEXT NOT NULL,
            rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS reading_progress (
            book_id INTEGER PRIMARY KEY,
            char_offset INTEGER NOT NULL,
            percent REAL NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);")
        .execute(db)
        .await?;

    if !column_exists(db, "books", "rating").await? {
        sqlx::query(
            "ALTER TABLE books ADD COLUMN rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5));",
        )
        .execute(db)
        .await?;
    }

    if !column_exists(db, "reading_progress", "version").await? {
        sqlx::query("ALTER TABLE reading_progress ADD COLUMN version INTEGER NOT NULL DEFAULT 1;")
            .execute(db)
            .await?;
    }

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_rating ON books(rating);")
        .execute(db)
        .await?;

    Ok(())
}

async fn column_exists(db: &SqlitePool, table: &str, column: &str) -> anyhow::Result<bool> {
    let pragma = format!("PRAGMA table_info({table})");
    let rows = sqlx::query(&pragma).fetch_all(db).await?;

    Ok(rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == column)
    }))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[tokio::test]
    async fn migrate_creates_progress_version_and_rating_columns() {
        let (dir, db_path) = temp_db_path("migrate-rating");
        let db = connect_db(db_path.to_str().unwrap()).await.unwrap();

        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();

        assert!(column_exists(&db, "books", "rating").await.unwrap());
        assert!(
            column_exists(&db, "reading_progress", "version")
                .await
                .unwrap()
        );

        db.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    fn temp_db_path(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "txt-reader-test-{}-{stamp}-{name}",
            std::process::id()
        ));
        let db_path = dir.join("reader.sqlite");
        (dir, db_path)
    }
}
