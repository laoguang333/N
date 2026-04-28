use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use sqlx::{Row, SqlitePool};

use crate::{
    AppState,
    app_error::AppError,
    library::{read_book_content, require_book_path, scan_library},
    models::{
        BookContent, BookListQuery, BookSummary, ReadingProgress, SaveProgressRequest, ScanResult,
    },
};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/books", get(list_books))
        .route("/api/books/{id}", get(get_book))
        .route("/api/books/{id}/content", get(get_book_content))
        .route(
            "/api/books/{id}/progress",
            get(get_progress).put(save_progress),
        )
        .route("/api/library/scan", post(scan))
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn scan(State(state): State<Arc<AppState>>) -> Result<Json<ScanResult>, AppError> {
    let result = scan_library(&state.db, &state.config.library_dirs).await?;
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

    let rows = sqlx::query(
        r#"
        SELECT
            b.id, b.title, b.file_path, b.file_hash, b.size, b.mtime, b.encoding,
            b.created_at, b.updated_at,
            p.char_offset AS progress_char_offset,
            p.percent AS progress_percent,
            p.updated_at AS progress_updated_at
        FROM books b
        LEFT JOIN reading_progress p ON p.book_id = b.id
        WHERE (?1 IS NULL OR b.title LIKE ?1)
        ORDER BY COALESCE(p.updated_at, b.updated_at) DESC, b.title COLLATE NOCASE ASC
        "#,
    )
    .bind(search)
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
    let row = sqlx::query(
        r#"
        SELECT
            b.id, b.title, b.file_path, b.file_hash, b.size, b.mtime, b.encoding,
            b.created_at, b.updated_at,
            p.char_offset AS progress_char_offset,
            p.percent AS progress_percent,
            p.updated_at AS progress_updated_at
        FROM books b
        LEFT JOIN reading_progress p ON p.book_id = b.id
        WHERE b.id = ?1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound("book not found".to_string()))?;
    Ok(Json(book_from_row(row)?))
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

    let row = sqlx::query(
        "SELECT book_id, char_offset, percent, updated_at FROM reading_progress WHERE book_id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(progress_from_row).transpose()?))
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

    sqlx::query(
        r#"
        INSERT INTO reading_progress (book_id, char_offset, percent)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(book_id) DO UPDATE SET
            char_offset = excluded.char_offset,
            percent = excluded.percent,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(id)
    .bind(char_offset)
    .bind(percent)
    .execute(&state.db)
    .await?;

    let row = sqlx::query(
        "SELECT book_id, char_offset, percent, updated_at FROM reading_progress WHERE book_id = ?1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(progress_from_row(row)?))
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
        updated_at: row.try_get("updated_at")?,
    })
}
