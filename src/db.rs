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
            format TEXT NOT NULL DEFAULT 'txt',
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
            last_mutation_id TEXT,
            position_kind TEXT,
            paragraph_fraction REAL,
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

    if !column_exists(db, "books", "folder_tag").await? {
        sqlx::query("ALTER TABLE books ADD COLUMN folder_tag TEXT;")
            .execute(db)
            .await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_folder_tag ON books(folder_tag);")
            .execute(db)
            .await?;
    }

    if !column_exists(db, "books", "format").await? {
        sqlx::query("ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'txt';")
            .execute(db)
            .await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_format ON books(format);")
            .execute(db)
            .await?;
    }

    if !column_exists(db, "reading_progress", "version").await? {
        sqlx::query("ALTER TABLE reading_progress ADD COLUMN version INTEGER NOT NULL DEFAULT 1;")
            .execute(db)
            .await?;
    }

    if !column_exists(db, "reading_progress", "locator").await? {
        sqlx::query("ALTER TABLE reading_progress ADD COLUMN locator TEXT;")
            .execute(db)
            .await?;
    }

    for column in ["last_mutation_id", "position_kind"] {
        if !column_exists(db, "reading_progress", column).await? {
            sqlx::query(&format!(
                "ALTER TABLE reading_progress ADD COLUMN {column} TEXT;"
            ))
            .execute(db)
            .await?;
        }
    }

    if !column_exists(db, "reading_progress", "paragraph_fraction").await? {
        sqlx::query("ALTER TABLE reading_progress ADD COLUMN paragraph_fraction REAL;")
            .execute(db)
            .await?;
    }

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_books_rating ON books(rating);")
        .execute(db)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS anime_videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            original_file_path TEXT,
            extension TEXT NOT NULL,
            folder_tag TEXT,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            duration_seconds REAL,
            container TEXT,
            video_codec TEXT,
            audio_codec TEXT,
            width INTEGER,
            height INTEGER,
            rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
            file_state TEXT NOT NULL DEFAULT 'available' CHECK (file_state IN ('available', 'missing')),
            last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            missing_since TEXT,
            missing_reason TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS anime_progress (
            video_id INTEGER PRIMARY KEY,
            position_seconds REAL NOT NULL DEFAULT 0,
            percent REAL NOT NULL DEFAULT 0,
            duration_seconds REAL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            FOREIGN KEY(video_id) REFERENCES anime_videos(id)
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS anime_watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id INTEGER NOT NULL,
            started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            ended_at TEXT,
            last_position_seconds REAL NOT NULL DEFAULT 0,
            watched_seconds REAL NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(video_id) REFERENCES anime_videos(id)
        );
        "#,
    )
    .execute(db)
    .await?;

    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_anime_videos_title ON anime_videos(title);",
        "CREATE INDEX IF NOT EXISTS idx_anime_videos_folder_tag ON anime_videos(folder_tag);",
        "CREATE INDEX IF NOT EXISTS idx_anime_videos_rating ON anime_videos(rating);",
        "CREATE INDEX IF NOT EXISTS idx_anime_videos_file_state ON anime_videos(file_state);",
        "CREATE INDEX IF NOT EXISTS idx_anime_videos_last_seen_at ON anime_videos(last_seen_at);",
        "CREATE INDEX IF NOT EXISTS idx_anime_videos_missing_since ON anime_videos(missing_since);",
        "CREATE INDEX IF NOT EXISTS idx_anime_progress_updated_at ON anime_progress(updated_at);",
        "CREATE INDEX IF NOT EXISTS idx_anime_watch_history_started_at ON anime_watch_history(started_at);",
    ] {
        sqlx::query(sql).execute(db).await?;
    }

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
        assert!(column_exists(&db, "books", "format").await.unwrap());
        assert!(
            column_exists(&db, "reading_progress", "version")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&db, "reading_progress", "locator")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&db, "reading_progress", "last_mutation_id")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&db, "reading_progress", "position_kind")
                .await
                .unwrap()
        );
        assert!(
            column_exists(&db, "reading_progress", "paragraph_fraction")
                .await
                .unwrap()
        );

        db.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn migrate_preserves_legacy_progress_values_and_is_idempotent() {
        let (dir, db_path) = temp_db_path("migrate-progress-fields");
        let db = connect_db(db_path.to_str().unwrap()).await.unwrap();

        sqlx::query(
            r#"
            CREATE TABLE books (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                file_path TEXT NOT NULL UNIQUE,
                file_hash TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                encoding TEXT NOT NULL
            );
            CREATE TABLE reading_progress (
                book_id INTEGER PRIMARY KEY,
                char_offset INTEGER NOT NULL,
                percent REAL NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT 'legacy-time',
                locator TEXT,
                FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
            );
            INSERT INTO books (id, title, file_path, file_hash, size, mtime, encoding)
            VALUES (7, 'Legacy', 'legacy.txt', 'legacy-hash', 12, 3, 'UTF-8');
            INSERT INTO reading_progress (book_id, char_offset, percent, version, locator)
            VALUES (7, 42, 0.42, 9, 'legacy-locator');
            "#,
        )
        .execute(&db)
        .await
        .unwrap();

        migrate(&db).await.unwrap();
        sqlx::query("UPDATE books SET rating = 5 WHERE id = 7")
            .execute(&db)
            .await
            .unwrap();
        migrate(&db).await.unwrap();

        let book = sqlx::query("SELECT title, rating FROM books WHERE id = 7")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(book.get::<String, _>("title"), "Legacy");
        assert_eq!(book.get::<Option<i64>, _>("rating"), Some(5));

        let row = sqlx::query(
            "SELECT char_offset, percent, version, locator, last_mutation_id, position_kind, paragraph_fraction FROM reading_progress WHERE book_id = 7",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row.get::<i64, _>("char_offset"), 42);
        assert_eq!(row.get::<f64, _>("percent"), 0.42);
        assert_eq!(row.get::<i64, _>("version"), 9);
        assert_eq!(
            row.get::<Option<String>, _>("locator").as_deref(),
            Some("legacy-locator")
        );
        assert_eq!(row.get::<Option<String>, _>("last_mutation_id"), None);
        assert_eq!(row.get::<Option<String>, _>("position_kind"), None);
        assert_eq!(row.get::<Option<f64>, _>("paragraph_fraction"), None);

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
