use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post, put},
};
use sqlx::{Row, SqlitePool};

use crate::{
    AppState,
    app_error::AppError,
    library::{read_book_content, require_book_path, scan_library},
    models::{
        BookContent, BookListQuery, BookSummary, PublicConfig, ReadingProgress,
        SaveProgressRequest, SaveRatingRequest, ScanResult,
    },
};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(public_config))
        .route("/api/books", get(list_books))
        .route("/api/books/{id}", get(get_book))
        .route("/api/books/{id}/content", get(get_book_content))
        .route(
            "/api/books/{id}/progress",
            get(get_progress).put(save_progress).post(save_progress),
        )
        .route("/api/books/{id}/rating", put(save_rating))
        .route("/api/library/scan", post(scan))
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn public_config(State(state): State<Arc<AppState>>) -> Json<PublicConfig> {
    Json(PublicConfig {
        library_dirs: state.config.library_dirs.clone(),
        scan_recursive: state.config.scan_recursive,
        scan_on_startup: state.config.scan_on_startup,
    })
}

async fn scan(State(state): State<Arc<AppState>>) -> Result<Json<ScanResult>, AppError> {
    let result = scan_library(
        &state.db,
        &state.config.library_dirs,
        state.config.scan_recursive,
    )
    .await?;
    Ok(Json(result))
}

async fn list_books(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BookListQuery>,
) -> Result<Json<Vec<BookSummary>>, AppError> {
    let search = query
        .search
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let status = normalize_status(query.status)?;
    let sort = normalize_sort(query.sort)?;
    let min_rating = normalize_min_rating(query.min_rating)?;

    let rows = sqlx::query(
        r#"
        SELECT
            b.id, b.title, b.file_path, b.file_hash, b.size, b.mtime, b.encoding,
            b.rating,
            b.created_at, b.updated_at,
            p.char_offset AS progress_char_offset,
            p.percent AS progress_percent,
            p.version AS progress_version,
            p.updated_at AS progress_updated_at
        FROM books b
        LEFT JOIN reading_progress p ON p.book_id = b.id
        WHERE
            (?1 IS NULL OR b.title LIKE ?1)
            AND (?2 IS NULL OR b.rating >= ?2)
            AND (
                ?3 IS NULL
                OR (?3 = 'unread' AND p.book_id IS NULL)
                OR (?3 = 'reading' AND p.book_id IS NOT NULL AND p.percent < 1.0)
                OR (?3 = 'finished' AND p.percent >= 1.0)
            )
        ORDER BY
            CASE WHEN ?4 = 'title' THEN b.title END COLLATE NOCASE ASC,
            CASE WHEN ?4 = 'progress' THEN COALESCE(p.percent, 0.0) END DESC,
            CASE WHEN ?4 = 'rating' THEN COALESCE(b.rating, 0) END DESC,
            CASE WHEN ?4 = 'recent' THEN COALESCE(p.updated_at, b.updated_at) END DESC,
            b.title COLLATE NOCASE ASC
        "#,
    )
    .bind(search)
    .bind(min_rating)
    .bind(status)
    .bind(sort)
    .fetch_all(&state.db)
    .await?;

    let books = rows
        .into_iter()
        .map(book_from_row)
        .collect::<Result<_, _>>()?;
    Ok(Json(books))
}

async fn get_book(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BookSummary>, AppError> {
    Ok(Json(fetch_book_summary(&state.db, id).await?))
}

async fn fetch_book_summary(db: &SqlitePool, id: i64) -> Result<BookSummary, AppError> {
    let row = sqlx::query(
        r#"
        SELECT
            b.id, b.title, b.file_path, b.file_hash, b.size, b.mtime, b.encoding,
            b.rating,
            b.created_at, b.updated_at,
            p.char_offset AS progress_char_offset,
            p.percent AS progress_percent,
            p.version AS progress_version,
            p.updated_at AS progress_updated_at
        FROM books b
        LEFT JOIN reading_progress p ON p.book_id = b.id
        WHERE b.id = ?1
        "#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound("book not found".to_string()))?;
    Ok(book_from_row(row)?)
}

async fn get_book_content(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BookContent>, AppError> {
    let (title, file_path) = require_book(&state.db, id).await?;
    let (content, encoding) = read_book_content(&file_path).await?;
    let length = content.chars().count();

    Ok(Json(BookContent {
        book_id: id,
        title,
        content,
        length,
        encoding,
    }))
}

async fn get_progress(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<Option<ReadingProgress>>, AppError> {
    require_book(&state.db, id).await?;

    Ok(Json(fetch_progress(&state.db, id).await?))
}

async fn save_progress(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(payload): Json<SaveProgressRequest>,
) -> Result<Json<ReadingProgress>, AppError> {
    require_book(&state.db, id).await?;

    if !payload.percent.is_finite() {
        return Err(AppError::BadRequest("percent must be finite".to_string()));
    }

    let char_offset = payload.char_offset.max(0);
    let percent = payload.percent.clamp(0.0, 1.0);

    let current = fetch_progress(&state.db, id).await?;
    if let Some(current) = current.as_ref() {
        let stale_writer = payload.base_version != Some(current.version);
        let backward_write = percent + 0.005 < current.percent;
        if stale_writer && backward_write {
            tracing::warn!(
                book_id = id,
                current_version = current.version,
                base_version = payload.base_version,
                current_percent = current.percent,
                attempted_percent = percent,
                current_offset = current.char_offset,
                attempted_offset = char_offset,
                "ignored stale backward progress save"
            );
            return Ok(Json(current.clone()));
        }
    }

    if current.is_some() {
        sqlx::query(
            r#"
            UPDATE reading_progress
            SET
                char_offset = ?2,
                percent = ?3,
                version = version + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE book_id = ?1
            "#,
        )
        .bind(id)
        .bind(char_offset)
        .bind(percent)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO reading_progress (book_id, char_offset, percent, version)
            VALUES (?1, ?2, ?3, 1)
            "#,
        )
        .bind(id)
        .bind(char_offset)
        .bind(percent)
        .execute(&state.db)
        .await?;
    }

    let saved = fetch_progress(&state.db, id)
        .await?
        .expect("progress exists after save");
    tracing::info!(
        book_id = id,
        version = saved.version,
        base_version = payload.base_version,
        percent = saved.percent,
        char_offset = saved.char_offset,
        "saved reading progress"
    );

    Ok(Json(saved))
}

async fn save_rating(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(payload): Json<SaveRatingRequest>,
) -> Result<Json<BookSummary>, AppError> {
    require_book(&state.db, id).await?;

    if let Some(rating) = payload.rating
        && !(1..=5).contains(&rating)
    {
        return Err(AppError::BadRequest(
            "rating must be between 1 and 5".to_string(),
        ));
    }

    sqlx::query("UPDATE books SET rating = ?1 WHERE id = ?2")
        .bind(payload.rating)
        .bind(id)
        .execute(&state.db)
        .await?;

    Ok(Json(fetch_book_summary(&state.db, id).await?))
}

async fn require_book(db: &SqlitePool, id: i64) -> Result<(String, String), AppError> {
    require_book_path(db, id).await.map_err(|error| {
        if error.to_string().contains("book not found") {
            AppError::NotFound("book not found".to_string())
        } else {
            AppError::Internal(error)
        }
    })
}

fn book_from_row(row: sqlx::sqlite::SqliteRow) -> Result<BookSummary, sqlx::Error> {
    let id = row.try_get("id")?;
    let progress = match row.try_get::<Option<i64>, _>("progress_char_offset")? {
        Some(char_offset) => Some(ReadingProgress {
            book_id: id,
            char_offset,
            percent: row.try_get("progress_percent")?,
            version: row.try_get("progress_version")?,
            updated_at: row.try_get("progress_updated_at")?,
        }),
        None => None,
    };

    Ok(BookSummary {
        id,
        title: row.try_get("title")?,
        file_path: row.try_get("file_path")?,
        file_hash: row.try_get("file_hash")?,
        size: row.try_get("size")?,
        mtime: row.try_get("mtime")?,
        encoding: row.try_get("encoding")?,
        rating: row.try_get("rating")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        progress,
    })
}

fn progress_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ReadingProgress, sqlx::Error> {
    Ok(ReadingProgress {
        book_id: row.try_get("book_id")?,
        char_offset: row.try_get("char_offset")?,
        percent: row.try_get("percent")?,
        version: row.try_get("version")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn fetch_progress(db: &SqlitePool, id: i64) -> Result<Option<ReadingProgress>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT book_id, char_offset, percent, version, updated_at FROM reading_progress WHERE book_id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;

    row.map(progress_from_row).transpose()
}

fn normalize_status(status: Option<String>) -> Result<Option<String>, AppError> {
    let Some(status) = status.map(|value| value.trim().to_lowercase()) else {
        return Ok(None);
    };

    match status.as_str() {
        "" | "all" => Ok(None),
        "unread" | "reading" | "finished" => Ok(Some(status)),
        _ => Err(AppError::BadRequest(
            "status must be one of all, unread, reading, finished".to_string(),
        )),
    }
}

fn normalize_sort(sort: Option<String>) -> Result<String, AppError> {
    let sort = sort
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "recent".to_string());

    match sort.as_str() {
        "recent" | "title" | "progress" | "rating" => Ok(sort),
        _ => Err(AppError::BadRequest(
            "sort must be one of recent, title, progress, rating".to_string(),
        )),
    }
}

fn normalize_min_rating(min_rating: Option<i64>) -> Result<Option<i64>, AppError> {
    match min_rating {
        Some(rating) if !(1..=5).contains(&rating) => Err(AppError::BadRequest(
            "min_rating must be between 1 and 5".to_string(),
        )),
        _ => Ok(min_rating),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use axum::extract::{Path, Query, State};

    use crate::{
        AppState,
        config::Config,
        db::{connect_db, migrate},
        models::{BookListQuery, SaveProgressRequest, SaveRatingRequest},
    };

    use super::*;

    #[tokio::test]
    async fn save_rating_accepts_clear_and_rejects_out_of_range() {
        let fixture = TestFixture::new("rating").await;
        let id = fixture.insert_book("Book", 0.25, None).await;

        let error = save_rating(
            State(fixture.state.clone()),
            Path(id),
            Json(SaveRatingRequest { rating: Some(6) }),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));

        let Json(book) = save_rating(
            State(fixture.state.clone()),
            Path(id),
            Json(SaveRatingRequest { rating: Some(5) }),
        )
        .await
        .unwrap();
        assert_eq!(book.rating, Some(5));

        let Json(book) = save_rating(
            State(fixture.state.clone()),
            Path(id),
            Json(SaveRatingRequest { rating: None }),
        )
        .await
        .unwrap();
        assert_eq!(book.rating, None);

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn list_books_filters_and_sorts_by_rating_and_status() {
        let fixture = TestFixture::new("list-filters").await;
        fixture.insert_book("Alpha", -1.0, Some(2)).await;
        fixture.insert_book("Opened", 0.0, Some(3)).await;
        fixture.insert_book("Beta", 0.5, Some(5)).await;
        fixture.insert_book("Gamma", 1.0, Some(4)).await;

        let Json(rated) = list_books(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: None,
                min_rating: Some(4),
                sort: Some("rating".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            rated
                .iter()
                .map(|book| book.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Beta", "Gamma"]
        );

        let Json(reading) = list_books(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: Some("reading".to_string()),
                min_rating: None,
                sort: Some("title".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(reading.len(), 2);
        assert_eq!(
            reading
                .iter()
                .map(|book| book.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Beta", "Opened"]
        );

        let Json(unread) = list_books(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: Some("unread".to_string()),
                min_rating: None,
                sort: Some("title".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].title, "Alpha");

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn save_progress_versions_prevent_stale_backward_overwrite() {
        let fixture = TestFixture::new("progress-version").await;
        let id = fixture.insert_book("Book", -1.0, None).await;

        let Json(first) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            Json(SaveProgressRequest {
                char_offset: 100,
                percent: 0.5,
                base_version: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(first.version, 1);

        let Json(second) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            Json(SaveProgressRequest {
                char_offset: 180,
                percent: 0.9,
                base_version: Some(first.version),
            }),
        )
        .await
        .unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.percent, 0.9);

        let Json(stale) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            Json(SaveProgressRequest {
                char_offset: 10,
                percent: 0.1,
                base_version: Some(first.version),
            }),
        )
        .await
        .unwrap();
        assert_eq!(stale.version, second.version);
        assert_eq!(stale.char_offset, second.char_offset);
        assert_eq!(stale.percent, second.percent);

        fixture.cleanup().await;
    }

    struct TestFixture {
        root: std::path::PathBuf,
        state: Arc<AppState>,
    }

    impl TestFixture {
        async fn new(name: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "txt-reader-test-{}-{stamp}-{name}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let db_path = root.join("reader.sqlite");
            let db = connect_db(db_path.to_str().unwrap()).await.unwrap();
            migrate(&db).await.unwrap();
            let state = Arc::new(AppState {
                config: Config::default(),
                db,
            });

            Self { root, state }
        }

        async fn insert_book(&self, title: &str, percent: f64, rating: Option<i64>) -> i64 {
            let file_path = self.root.join(format!("{title}.txt"));
            std::fs::write(&file_path, title).unwrap();
            let id: i64 = sqlx::query_scalar(
                r#"
                INSERT INTO books (title, file_path, file_hash, size, mtime, encoding, rating)
                VALUES (?1, ?2, ?3, 10, 1, 'UTF-8', ?4)
                RETURNING id
                "#,
            )
            .bind(title)
            .bind(file_path.to_string_lossy().to_string())
            .bind(format!("hash-{title}"))
            .bind(rating)
            .fetch_one(&self.state.db)
            .await
            .unwrap();

            if percent >= 0.0 {
                sqlx::query(
                    "INSERT INTO reading_progress (book_id, char_offset, percent) VALUES (?1, 10, ?2)",
                )
                .bind(id)
                .bind(percent)
                .execute(&self.state.db)
                .await
                .unwrap();
            }

            id
        }

        async fn cleanup(self) {
            self.state.db.close().await;
            let _ = std::fs::remove_dir_all(self.root);
        }
    }
}
