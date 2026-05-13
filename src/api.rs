use std::{collections::BTreeMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, header},
    routing::{get, post, put},
};
use sqlx::{Row, SqlitePool};

use crate::{
    AppState,
    app_error::AppError,
    library::{read_book_content, require_book_path, scan_library},
    models::{
        BookContent, BookListQuery, BookSummary, FolderSummary, PublicConfig, ReadingProgress,
        SaveProgressRequest, SaveRatingRequest, ScanResult, ShelfResponse,
    },
};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(public_config))
        .route("/api/shelf", get(shelf))
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

async fn shelf(State(state): State<Arc<AppState>>) -> Result<Json<ShelfResponse>, AppError> {
    let all_books =
        list_books_internal(&state.db, None, None, None::<&str>, "title", None::<&str>).await?;

    let mut root_books: Vec<BookSummary> = Vec::new();
    let mut tag_books: BTreeMap<String, Vec<BookSummary>> = BTreeMap::new();

    for book in all_books {
        if let Some(ref tag) = book.folder_tag {
            tag_books.entry(tag.clone()).or_default().push(book);
        } else {
            root_books.push(book);
        }
    }

    let mut folders: Vec<FolderSummary> = Vec::new();
    for (tag, books) in tag_books {
        if books.len() == 1 {
            root_books.push(books.into_iter().next().unwrap());
        } else {
            let max_rating = books.iter().filter_map(|b| b.rating).max();
            let latest_activity = books
                .iter()
                .filter_map(|b| {
                    b.progress
                        .as_ref()
                        .map(|p| p.updated_at.clone())
                        .or_else(|| Some(b.updated_at.clone()))
                })
                .max();
            folders.push(FolderSummary {
                name: tag,
                book_count: books.len(),
                max_rating,
                latest_activity,
            });
        }
    }

    root_books.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(Json(ShelfResponse {
        books: root_books,
        folders,
    }))
}

async fn list_books_internal(
    db: &SqlitePool,
    search: Option<String>,
    min_rating: Option<i64>,
    status: Option<&str>,
    sort: &str,
    folder_tag: Option<&str>,
) -> Result<Vec<BookSummary>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT
            b.id, b.title, b.file_path, b.file_hash, b.size, b.mtime, b.encoding,
            b.folder_tag,
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
            AND (?3 IS NULL OR b.folder_tag = ?3)
            AND (
                ?4 IS NULL
                OR (?4 = 'unread' AND p.book_id IS NULL)
                OR (?4 = 'reading' AND p.book_id IS NOT NULL AND p.percent < 1.0)
                OR (?4 = 'finished' AND p.percent >= 1.0)
            )
        ORDER BY
            CASE WHEN ?5 = 'title' THEN b.title END COLLATE NOCASE ASC,
            CASE WHEN ?5 = 'progress' THEN COALESCE(p.percent, 0.0) END DESC,
            CASE WHEN ?5 = 'rating' THEN COALESCE(b.rating, 0) END DESC,
            CASE WHEN ?5 = 'recent' THEN COALESCE(p.updated_at, b.updated_at) END DESC,
            b.title COLLATE NOCASE ASC
        "#,
    )
    .bind(search)
    .bind(min_rating)
    .bind(folder_tag)
    .bind(status)
    .bind(sort)
    .fetch_all(db)
    .await?;

    let books = rows
        .into_iter()
        .map(book_from_row)
        .collect::<Result<_, _>>()?;
    Ok(books)
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
    let status_str = normalize_status(query.status)?;
    let status = status_str.as_deref();
    let sort_str = normalize_sort(query.sort)?;
    let sort = sort_str.as_str();
    let min_rating = normalize_min_rating(query.min_rating)?;
    let folder_tag = query
        .folder_tag
        .as_deref()
        .filter(|value| !value.trim().is_empty());

    let books =
        list_books_internal(&state.db, search, min_rating, status, sort, folder_tag).await?;
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
            b.folder_tag,
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
    headers: HeaderMap,
    Json(payload): Json<SaveProgressRequest>,
) -> Result<Json<ReadingProgress>, AppError> {
    let (title, _) = require_book(&state.db, id).await?;

    if !payload.percent.is_finite() {
        return Err(AppError::BadRequest("percent must be finite".to_string()));
    }

    let char_offset = payload.char_offset.max(0);
    let percent = payload.percent.clamp(0.0, 1.0);
    let source = payload.source.as_deref().unwrap_or("unknown");
    let client_id = payload.client_id.as_deref().unwrap_or("unknown");
    let session_id = payload.session_id.as_deref().unwrap_or("unknown");
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");

    let current = fetch_progress(&state.db, id).await?;
    let allow_backward = payload.allow_backward.unwrap_or(false);

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
        title = %title,
        source,
        client_id,
        session_id,
        user_agent,
        percent = saved.percent,
        char_offset = saved.char_offset,
        allow_backward,
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
        folder_tag: row.try_get("folder_tag")?,
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
                folder_tag: None,
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
                folder_tag: None,
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
                folder_tag: None,
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
    async fn save_progress_overwrites_without_version_checks() {
        let fixture = TestFixture::new("progress-version").await;
        let id = fixture.insert_book("Book", -1.0, None).await;

        let Json(first) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 100,
                percent: 0.5,
                source: Some("test".to_string()),
                client_id: None,
                session_id: None,
                allow_backward: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(first.percent, 0.5);

        let Json(second) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 180,
                percent: 0.9,
                source: Some("test".to_string()),
                client_id: None,
                session_id: None,
                allow_backward: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(second.percent, 0.9);

        let Json(reset) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 0,
                percent: 0.0,
                source: Some("pagehide".to_string()),
                client_id: None,
                session_id: None,
                allow_backward: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(reset.percent, 0.0);

        let Json(explicit_seek) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 20,
                percent: 0.0005,
                source: Some("seek".to_string()),
                client_id: None,
                session_id: None,
                allow_backward: Some(true),
            }),
        )
        .await
        .unwrap();
        assert_eq!(explicit_seek.percent, 0.0005);

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn shelf_groups_books_and_collapses_single_book_folders() {
        let fixture = TestFixture::new("shelf-groups").await;
        fixture.insert_book("Root", -1.0, None).await;
        fixture.insert_tagged_book("Multi1", -1.0, "Author").await;
        fixture.insert_tagged_book("Multi2", -1.0, "Author").await;
        fixture.insert_tagged_book("Single", -1.0, "Loner").await;

        let Json(resp) = shelf(State(fixture.state.clone())).await.unwrap();

        assert_eq!(
            resp.books.len(),
            2,
            "Root and single-folder books should be in root"
        );
        let mut titles: Vec<String> = resp.books.iter().map(|b| b.title.clone()).collect();
        titles.sort();
        assert!(titles.contains(&"Root".to_string()));
        assert!(
            titles.contains(&"Single".to_string()),
            "Single-book folder should collapse to root"
        );

        assert_eq!(resp.folders.len(), 1, "Multi-book folder should appear");
        assert_eq!(resp.folders[0].name, "Author");
        assert_eq!(resp.folders[0].book_count, 2);

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

        async fn insert_tagged_book(&self, title: &str, percent: f64, folder_tag: &str) -> i64 {
            let file_path = self.root.join(format!("{folder_tag}/{title}.txt"));
            std::fs::create_dir_all(file_path.parent().unwrap()).unwrap();
            std::fs::write(&file_path, title).unwrap();
            let id: i64 = sqlx::query_scalar(
                r#"
                INSERT INTO books (title, file_path, file_hash, size, mtime, encoding, rating, folder_tag)
                VALUES (?1, ?2, ?3, 10, 1, 'UTF-8', NULL, ?4)
                RETURNING id
                "#,
            )
            .bind(title)
            .bind(file_path.to_string_lossy().to_string())
            .bind(format!("hash-{title}"))
            .bind(folder_tag)
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
