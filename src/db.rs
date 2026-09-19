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

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS reading_progress_mutations (
            mutation_id TEXT PRIMARY KEY NOT NULL,
            book_id INTEGER NOT NULL,
            char_offset INTEGER NOT NULL,
            percent REAL NOT NULL,
            locator TEXT,
            position_kind TEXT,
            paragraph_fraction REAL,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        DELETE FROM reading_progress_mutations
        WHERE mutation_id IN (
            SELECT last_mutation_id
            FROM reading_progress
            WHERE last_mutation_id IS NOT NULL
            GROUP BY last_mutation_id
            HAVING COUNT(*) > 1
        );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        UPDATE reading_progress
        SET
            last_mutation_id = NULL,
            position_kind = NULL,
            paragraph_fraction = NULL
        WHERE last_mutation_id IS NOT NULL
          AND rowid NOT IN (
              SELECT MIN(rowid)
              FROM reading_progress
              WHERE last_mutation_id IS NOT NULL
              GROUP BY last_mutation_id
          );
        "#,
    )
    .execute(db)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO reading_progress_mutations (
            mutation_id, book_id, char_offset, percent, locator,
            position_kind, paragraph_fraction, version, updated_at
        )
        SELECT
            last_mutation_id, book_id, char_offset, percent, locator,
            position_kind, paragraph_fraction, version, updated_at
        FROM reading_progress
        WHERE last_mutation_id IS NOT NULL
        ON CONFLICT(mutation_id) DO NOTHING;
        "#,
    )
    .execute(db)
    .await?;

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
        sqlx::query(
            "UPDATE reading_progress SET last_mutation_id = 'legacy-mutation' WHERE book_id = 7",
        )
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
        assert_eq!(
            row.get::<Option<String>, _>("last_mutation_id").as_deref(),
            Some("legacy-mutation")
        );
        assert_eq!(row.get::<Option<String>, _>("position_kind"), None);
        assert_eq!(row.get::<Option<f64>, _>("paragraph_fraction"), None);

        let mutation = sqlx::query(
            "SELECT mutation_id, book_id, char_offset, version FROM reading_progress_mutations WHERE mutation_id = 'legacy-mutation'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(mutation.get::<String, _>("mutation_id"), "legacy-mutation");
        assert_eq!(mutation.get::<i64, _>("book_id"), 7);
        assert_eq!(mutation.get::<i64, _>("char_offset"), 42);
        assert_eq!(mutation.get::<i64, _>("version"), 9);

        db.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn migrate_deduplicates_legacy_mutations_by_lowest_rowid() {
        let (dir, db_path) = temp_db_path("migrate-duplicate-mutations");
        let db = connect_db(db_path.to_str().unwrap()).await.unwrap();
        migrate(&db).await.unwrap();

        for (id, title, rating) in [(10_i64, "Owner", 4_i64), (20_i64, "Duplicate", 5_i64)] {
            sqlx::query(
                r#"
                INSERT INTO books (
                    id, title, file_path, file_hash, format, size, mtime, encoding, rating
                ) VALUES (?1, ?2, ?3, ?4, 'txt', 10, 1, 'UTF-8', ?5)
                "#,
            )
            .bind(id)
            .bind(title)
            .bind(format!("{title}.txt"))
            .bind(format!("hash-{id}"))
            .bind(rating)
            .execute(&db)
            .await
            .unwrap();
        }
        sqlx::query(
            r#"
            INSERT INTO reading_progress (
                book_id, char_offset, percent, version, last_mutation_id,
                position_kind, paragraph_fraction
            ) VALUES
                (10, 10, 0.1, 3, 'duplicate-mutation', 'paragraph_utf16_lf_v1', 0.2),
                (20, 20, 0.2, 4, 'duplicate-mutation', 'paragraph_utf16_lf_v1', 0.8)
            "#,
        )
        .execute(&db)
        .await
        .unwrap();

        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();

        let rows = sqlx::query(
            "SELECT book_id, char_offset, percent, version, last_mutation_id, position_kind, paragraph_fraction FROM reading_progress ORDER BY rowid",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        let owner = rows
            .iter()
            .find(|row| row.get::<i64, _>("book_id") == 10)
            .unwrap();
        let duplicate = rows
            .iter()
            .find(|row| row.get::<i64, _>("book_id") == 20)
            .unwrap();
        assert_eq!(
            owner
                .get::<Option<String>, _>("last_mutation_id")
                .as_deref(),
            Some("duplicate-mutation")
        );
        assert_eq!(
            owner.get::<Option<String>, _>("position_kind").as_deref(),
            Some("paragraph_utf16_lf_v1")
        );
        assert_eq!(owner.get::<Option<f64>, _>("paragraph_fraction"), Some(0.2));
        assert_eq!(duplicate.get::<i64, _>("char_offset"), 20);
        assert_eq!(duplicate.get::<f64, _>("percent"), 0.2);
        assert_eq!(duplicate.get::<i64, _>("version"), 4);
        assert_eq!(duplicate.get::<Option<String>, _>("last_mutation_id"), None);
        assert_eq!(duplicate.get::<Option<String>, _>("position_kind"), None);
        assert_eq!(duplicate.get::<Option<f64>, _>("paragraph_fraction"), None);

        let active_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM reading_progress WHERE last_mutation_id = 'duplicate-mutation'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(active_count, 1);

        let ledger = sqlx::query(
            "SELECT book_id, char_offset, percent, version FROM reading_progress_mutations WHERE mutation_id = 'duplicate-mutation'",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].get::<i64, _>("book_id"), 10);
        assert_eq!(ledger[0].get::<i64, _>("char_offset"), 10);
        assert_eq!(ledger[0].get::<f64, _>("percent"), 0.1);
        assert_eq!(ledger[0].get::<i64, _>("version"), 3);

        let books = sqlx::query("SELECT title, rating FROM books ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(books[0].get::<String, _>("title"), "Owner");
        assert_eq!(books[0].get::<Option<i64>, _>("rating"), Some(4));
        assert_eq!(books[1].get::<String, _>("title"), "Duplicate");
        assert_eq!(books[1].get::<Option<i64>, _>("rating"), Some(5));

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
