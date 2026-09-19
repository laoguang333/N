use std::{
    collections::BTreeMap,
    env,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::{get, post, put},
};
use sqlx::{Row, SqlitePool};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use crate::{
    AppState,
    anime_library::scan_anime_library,
    app_error::AppError,
    library::{read_book_content, require_book_path, scan_library},
    models::{
        AnimeHistoryQuery, AnimeListQuery, AnimePathRequest, AnimeProgress, AnimeToolsStatus,
        AnimeTranscodeQuery, AnimeVideoSummary, AnimeWatchFinishRequest, AnimeWatchHistoryItem,
        AnimeWatchStartRequest, AnimeWatchStartResponse, BookContent, BookListQuery, BookSummary,
        FolderSummary, PublicConfig, ReadingProgress, SaveAnimeProgressRequest,
        SaveProgressRequest, SaveRatingRequest, ScanResult, ShelfItem, ShelfResponse,
    },
};

const PARAGRAPH_POSITION_KIND: &str = "paragraph_utf16_lf_v1";

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(public_config))
        .route("/api/shelf", get(shelf))
        .route("/api/books", get(list_books))
        .route("/api/books/{id}", get(get_book))
        .route("/api/books/{id}/content", get(get_book_content))
        .route("/api/books/{id}/file", get(stream_book_file))
        .route(
            "/api/books/{id}/progress",
            get(get_progress).put(save_progress).post(save_progress),
        )
        .route("/api/books/{id}/rating", put(save_rating))
        .route("/api/library/scan", post(scan))
        .route("/api/anime/tools", get(anime_tools))
        .route("/api/anime/library/scan", post(scan_anime))
        .route("/api/anime/videos", get(list_anime_videos))
        .route("/api/anime/shelf", get(anime_shelf))
        .route("/api/anime/videos/{id}", get(get_anime_video))
        .route("/api/anime/videos/{id}/file", get(stream_anime_video_file))
        .route(
            "/api/anime/videos/{id}/progress",
            get(get_anime_progress).put(save_anime_progress),
        )
        .route("/api/anime/videos/{id}/rating", put(save_anime_rating))
        .route(
            "/api/anime/videos/{id}/watch/start",
            post(start_anime_watch),
        )
        .route(
            "/api/anime/watch-history/{id}/finish",
            put(finish_anime_watch),
        )
        .route("/api/anime/watch-history", get(list_anime_history))
        .route("/api/anime/transcode", get(transcode_anime))
        .route("/api/anime/probe", get(probe_anime))
        .route("/api/anime/file", get(stream_anime_file))
        .route("/api/anime/hls/prepare", post(prepare_anime_hls))
        .route("/api/anime/hls/status", get(anime_hls_status))
        .route(
            "/api/anime/hls/{key}/playlist.m3u8",
            get(anime_hls_playlist),
        )
        .route("/api/anime/hls/{key}/{segment}", get(anime_hls_segment))
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
        anime_dirs: state.config.anime_dirs.clone(),
        anime_scan_recursive: state.config.anime_scan_recursive,
        anime_scan_on_startup: state.config.anime_scan_on_startup,
    })
}

async fn scan(State(state): State<Arc<AppState>>) -> Result<Json<ScanResult>, AppError> {
    let _scan_guard = state
        .scan_lock
        .try_lock()
        .map_err(|_| AppError::ConflictCode {
            message: "a library scan is already in progress".to_string(),
            code: "scan_in_progress".to_string(),
        })?;
    let result = scan_library(
        &state.db,
        &state.config.library_dirs,
        state.config.scan_recursive,
    )
    .await?;
    Ok(Json(result))
}

async fn anime_tools() -> Json<AnimeToolsStatus> {
    Json(AnimeToolsStatus {
        ffmpeg: find_command("ffmpeg").map(|path| path.to_string_lossy().to_string()),
        ffprobe: find_command("ffprobe").map(|path| path.to_string_lossy().to_string()),
    })
}

async fn scan_anime(State(state): State<Arc<AppState>>) -> Json<crate::models::AnimeScanResult> {
    Json(
        scan_anime_library(
            &state.db,
            &state.config.anime_dirs,
            state.config.anime_scan_recursive,
            find_command("ffprobe"),
        )
        .await,
    )
}

async fn list_anime_videos(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnimeListQuery>,
) -> Result<Json<Vec<AnimeVideoSummary>>, AppError> {
    Ok(Json(list_anime_videos_internal(&state.db, query).await?))
}

async fn anime_shelf(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnimeListQuery>,
) -> Result<Json<Vec<AnimeVideoSummary>>, AppError> {
    Ok(Json(list_anime_videos_internal(&state.db, query).await?))
}

async fn get_anime_video(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<AnimeVideoSummary>, AppError> {
    Ok(Json(fetch_anime_video(&state.db, id).await?))
}

async fn stream_anime_video_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response<Body>, AppError> {
    let video = fetch_anime_video(&state.db, id).await?;
    if video.file_state == "missing" {
        return Err(AppError::NotFound(
            "video file is missing; rescan or confirm the file location".to_string(),
        ));
    }
    stream_file_path(PathBuf::from(video.file_path), headers).await
}

async fn get_anime_progress(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<Option<AnimeProgress>>, AppError> {
    require_anime_video(&state.db, id).await?;
    Ok(Json(fetch_anime_progress(&state.db, id).await?))
}

async fn save_anime_progress(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(payload): Json<SaveAnimeProgressRequest>,
) -> Result<Json<AnimeProgress>, AppError> {
    require_anime_video(&state.db, id).await?;
    if !payload.position_seconds.is_finite()
        || !payload.percent.is_finite()
        || payload
            .duration_seconds
            .is_some_and(|value| !value.is_finite())
    {
        return Err(AppError::BadRequest(
            "progress values must be finite".to_string(),
        ));
    }
    let position = payload.position_seconds.max(0.0);
    let percent = payload.percent.clamp(0.0, 1.0);
    let _source = payload.source.as_deref().unwrap_or("unknown");
    let _client_id = payload.client_id.as_deref().unwrap_or("unknown");
    let _session_id = payload.session_id.as_deref().unwrap_or("unknown");
    sqlx::query(
        r#"
        INSERT INTO anime_progress (video_id, position_seconds, percent, duration_seconds, version)
        VALUES (?1, ?2, ?3, ?4, 1)
        ON CONFLICT(video_id) DO UPDATE SET
            position_seconds = excluded.position_seconds,
            percent = excluded.percent,
            duration_seconds = excluded.duration_seconds,
            version = anime_progress.version + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
    )
    .bind(id)
    .bind(position)
    .bind(percent)
    .bind(payload.duration_seconds)
    .execute(&state.db)
    .await?;
    Ok(Json(fetch_anime_progress(&state.db, id).await?.unwrap()))
}

async fn save_anime_rating(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(payload): Json<SaveRatingRequest>,
) -> Result<Json<AnimeVideoSummary>, AppError> {
    require_anime_video(&state.db, id).await?;
    if let Some(rating) = payload.rating
        && !(1..=5).contains(&rating)
    {
        return Err(AppError::BadRequest(
            "rating must be between 1 and 5".to_string(),
        ));
    }
    sqlx::query(
        "UPDATE anime_videos SET rating = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
    )
    .bind(payload.rating)
    .bind(id)
    .execute(&state.db)
    .await?;
    Ok(Json(fetch_anime_video(&state.db, id).await?))
}

async fn start_anime_watch(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(payload): Json<AnimeWatchStartRequest>,
) -> Result<Json<AnimeWatchStartResponse>, AppError> {
    require_anime_video(&state.db, id).await?;
    let position = payload.position_seconds.unwrap_or(0.0).max(0.0);
    let history_id: i64 = sqlx::query_scalar(
        "INSERT INTO anime_watch_history (video_id, last_position_seconds) VALUES (?1, ?2) RETURNING id",
    )
    .bind(id)
    .bind(position)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(AnimeWatchStartResponse { history_id }))
}

async fn finish_anime_watch(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(payload): Json<AnimeWatchFinishRequest>,
) -> Result<StatusCode, AppError> {
    if !payload.last_position_seconds.is_finite() || !payload.watched_seconds.is_finite() {
        return Err(AppError::BadRequest(
            "history values must be finite".to_string(),
        ));
    }
    sqlx::query(
        r#"
        UPDATE anime_watch_history
        SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            last_position_seconds = ?2,
            watched_seconds = ?3,
            completed = ?4
        WHERE id = ?1
        "#,
    )
    .bind(id)
    .bind(payload.last_position_seconds.max(0.0))
    .bind(payload.watched_seconds.max(0.0))
    .bind(if payload.completed { 1 } else { 0 })
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_anime_history(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AnimeHistoryQuery>,
) -> Result<Json<Vec<AnimeWatchHistoryItem>>, AppError> {
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let period = query.period.as_deref().unwrap_or("all");
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows = sqlx::query(
        r#"
        SELECT h.id, h.video_id, v.title, v.file_state, h.started_at, h.ended_at,
               h.last_position_seconds, h.watched_seconds, h.completed
        FROM anime_watch_history h
        JOIN anime_videos v ON v.id = h.video_id
        WHERE (?1 IS NULL OR v.title LIKE ?1)
          AND (
              ?2 = 'all'
              OR (?2 = 'today' AND h.started_at >= datetime('now', 'start of day'))
              OR (?2 = 'week' AND h.started_at >= datetime('now', '-7 day'))
              OR (?2 = 'month' AND h.started_at >= datetime('now', '-30 day'))
          )
        ORDER BY h.started_at DESC
        LIMIT ?3
        "#,
    )
    .bind(search)
    .bind(period)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                Ok(AnimeWatchHistoryItem {
                    id: row.try_get("id")?,
                    video_id: row.try_get("video_id")?,
                    title: row.try_get("title")?,
                    file_state: row.try_get("file_state")?,
                    started_at: row.try_get("started_at")?,
                    ended_at: row.try_get("ended_at")?,
                    last_position_seconds: row.try_get("last_position_seconds")?,
                    watched_seconds: row.try_get("watched_seconds")?,
                    completed: row.try_get::<i64, _>("completed")? != 0,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?,
    ))
}

async fn transcode_anime(
    Query(query): Query<AnimeTranscodeQuery>,
) -> Result<Response<Body>, AppError> {
    let path = normalize_video_path(&query.path)?;
    let mut child = Command::new("ffmpeg")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&path)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("veryfast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("160k")
        .arg("-movflags")
        .arg("frag_keyframe+empty_moov+faststart")
        .arg("-f")
        .arg("mp4")
        .arg("pipe:1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::BadRequest("ffmpeg not found in PATH".to_string())
            } else {
                AppError::Internal(error.into())
            }
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("failed to capture ffmpeg stdout")))?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    let body = Body::from_stream(ReaderStream::new(stdout));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .map_err(|error| AppError::Internal(error.into()))
}

fn normalize_video_path(path: &str) -> Result<PathBuf, AppError> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("video path is required".to_string()));
    }

    let path = PathBuf::from(trimmed);
    if !path.is_file() {
        return Err(AppError::BadRequest("video file not found".to_string()));
    }

    Ok(path)
}

async fn probe_anime(
    Query(query): Query<AnimeTranscodeQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let path = normalize_video_path(&query.path)?;
    let ffprobe = find_command("ffprobe")
        .ok_or_else(|| AppError::BadRequest("ffprobe not found in PATH".to_string()))?;
    let output = Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(&path)
        .output()
        .await
        .map_err(|error| AppError::Internal(error.into()))?;

    let duration = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite());
    Ok(Json(serde_json::json!({
        "path": path.to_string_lossy(),
        "duration": duration,
        "size": tokio::fs::metadata(&path).await?.len()
    })))
}

async fn stream_anime_file(
    Query(query): Query<AnimeTranscodeQuery>,
    headers: HeaderMap,
) -> Result<Response<Body>, AppError> {
    let path = normalize_video_path(&query.path)?;
    stream_file_path(path, headers).await
}

async fn stream_file_path(path: PathBuf, headers: HeaderMap) -> Result<Response<Body>, AppError> {
    if !path.is_file() {
        return Err(AppError::NotFound("video file not found".to_string()));
    }
    let metadata = tokio::fs::metadata(&path).await?;
    let size = metadata.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_byte_range(value, size));
    let (start, end) = range.unwrap_or((0, size.saturating_sub(1)));
    let length = end.saturating_sub(start) + 1;
    let mut file = tokio::fs::File::open(&path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let body = Body::from_stream(ReaderStream::new(file.take(length)));

    let mut builder = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type_for_path(&path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string());
    if range.is_some() {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    builder
        .body(body)
        .map_err(|error| AppError::Internal(error.into()))
}

async fn list_anime_videos_internal(
    db: &SqlitePool,
    query: AnimeListQuery,
) -> Result<Vec<AnimeVideoSummary>, AppError> {
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));
    let availability = normalize_anime_availability(query.availability)?;
    let status = normalize_anime_status(query.status)?;
    let sort = normalize_anime_sort(query.sort)?;
    let min_rating = normalize_min_rating(query.min_rating)?;
    let folder_tag = query
        .folder_tag
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let rows = sqlx::query(
        r#"
        SELECT v.id, v.title, v.file_path, v.extension, v.folder_tag, v.size, v.mtime,
               v.duration_seconds, v.container, v.video_codec, v.audio_codec, v.width, v.height,
               v.rating, v.file_state, v.last_seen_at, v.missing_since, v.created_at, v.updated_at,
               p.position_seconds AS progress_position_seconds,
               p.percent AS progress_percent,
               p.duration_seconds AS progress_duration_seconds,
               p.updated_at AS progress_updated_at
        FROM anime_videos v
        LEFT JOIN anime_progress p ON p.video_id = v.id
        WHERE (?1 IS NULL OR v.title LIKE ?1 OR v.folder_tag LIKE ?1 OR v.file_path LIKE ?1)
          AND (?2 = 'all' OR v.file_state = ?2)
          AND (?3 IS NULL OR v.rating >= ?3)
          AND (?4 IS NULL OR v.folder_tag = ?4)
          AND (
              ?5 = 'all'
              OR (?5 = 'unwatched' AND p.video_id IS NULL)
              OR (?5 = 'watching' AND p.video_id IS NOT NULL AND p.percent < 0.95)
              OR (?5 = 'finished' AND p.percent >= 0.95)
          )
        ORDER BY
          CASE WHEN ?6 = 'title' THEN v.title END COLLATE NOCASE ASC,
          CASE WHEN ?6 = 'progress' THEN COALESCE(p.percent, 0.0) END DESC,
          CASE WHEN ?6 = 'rating' THEN COALESCE(v.rating, 0) END DESC,
          CASE WHEN ?6 = 'duration' THEN COALESCE(v.duration_seconds, 0.0) END DESC,
          CASE WHEN ?6 = 'size' THEN v.size END DESC,
          CASE WHEN ?6 = 'recent' THEN COALESCE(p.updated_at, v.updated_at) END DESC,
          v.title COLLATE NOCASE ASC
        "#,
    )
    .bind(search)
    .bind(availability)
    .bind(min_rating)
    .bind(folder_tag)
    .bind(status)
    .bind(sort)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(anime_video_from_row)
        .collect::<Result<Vec<_>, sqlx::Error>>()?)
}

async fn fetch_anime_video(db: &SqlitePool, id: i64) -> Result<AnimeVideoSummary, AppError> {
    let row = sqlx::query(
        r#"
        SELECT v.id, v.title, v.file_path, v.extension, v.folder_tag, v.size, v.mtime,
               v.duration_seconds, v.container, v.video_codec, v.audio_codec, v.width, v.height,
               v.rating, v.file_state, v.last_seen_at, v.missing_since, v.created_at, v.updated_at,
               p.position_seconds AS progress_position_seconds,
               p.percent AS progress_percent,
               p.duration_seconds AS progress_duration_seconds,
               p.updated_at AS progress_updated_at
        FROM anime_videos v
        LEFT JOIN anime_progress p ON p.video_id = v.id
        WHERE v.id = ?1
        "#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let row = row.ok_or_else(|| AppError::NotFound("video not found".to_string()))?;
    Ok(anime_video_from_row(row)?)
}

async fn require_anime_video(db: &SqlitePool, id: i64) -> Result<(), AppError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM anime_videos WHERE id = ?1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    exists
        .map(|_| ())
        .ok_or_else(|| AppError::NotFound("video not found".to_string()))
}

async fn fetch_anime_progress(
    db: &SqlitePool,
    id: i64,
) -> Result<Option<AnimeProgress>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT video_id, position_seconds, percent, duration_seconds, updated_at FROM anime_progress WHERE video_id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(anime_progress_from_row).transpose()
}

fn anime_video_from_row(row: sqlx::sqlite::SqliteRow) -> Result<AnimeVideoSummary, sqlx::Error> {
    let id = row.try_get("id")?;
    let progress = match row.try_get::<Option<f64>, _>("progress_position_seconds")? {
        Some(position_seconds) => Some(AnimeProgress {
            video_id: id,
            position_seconds,
            percent: row.try_get("progress_percent")?,
            duration_seconds: row.try_get("progress_duration_seconds")?,
            updated_at: row.try_get("progress_updated_at")?,
        }),
        None => None,
    };
    Ok(AnimeVideoSummary {
        id,
        title: row.try_get("title")?,
        file_path: row.try_get("file_path")?,
        extension: row.try_get("extension")?,
        folder_tag: row.try_get("folder_tag")?,
        size: row.try_get("size")?,
        mtime: row.try_get("mtime")?,
        duration_seconds: row.try_get("duration_seconds")?,
        container: row.try_get("container")?,
        video_codec: row.try_get("video_codec")?,
        audio_codec: row.try_get("audio_codec")?,
        width: row.try_get("width")?,
        height: row.try_get("height")?,
        rating: row.try_get("rating")?,
        file_state: row.try_get("file_state")?,
        last_seen_at: row.try_get("last_seen_at")?,
        missing_since: row.try_get("missing_since")?,
        progress,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn anime_progress_from_row(row: sqlx::sqlite::SqliteRow) -> Result<AnimeProgress, sqlx::Error> {
    Ok(AnimeProgress {
        video_id: row.try_get("video_id")?,
        position_seconds: row.try_get("position_seconds")?,
        percent: row.try_get("percent")?,
        duration_seconds: row.try_get("duration_seconds")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn normalize_anime_status(status: Option<String>) -> Result<String, AppError> {
    let status = status
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "all".to_string());
    match status.as_str() {
        "all" | "unwatched" | "watching" | "finished" => Ok(status),
        _ => Err(AppError::BadRequest(
            "status must be one of all, unwatched, watching, finished".to_string(),
        )),
    }
}

fn normalize_anime_availability(availability: Option<String>) -> Result<String, AppError> {
    let availability = availability
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "available".to_string());
    match availability.as_str() {
        "available" | "missing" | "all" => Ok(availability),
        _ => Err(AppError::BadRequest(
            "availability must be one of available, missing, all".to_string(),
        )),
    }
}

fn normalize_anime_sort(sort: Option<String>) -> Result<String, AppError> {
    let sort = sort
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "recent".to_string());
    match sort.as_str() {
        "recent" | "title" | "progress" | "rating" | "duration" | "size" => Ok(sort),
        _ => Err(AppError::BadRequest(
            "sort must be one of recent, title, progress, rating, duration, size".to_string(),
        )),
    }
}

fn parse_byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        let start = size.saturating_sub(suffix);
        return Some((start, size.saturating_sub(1)));
    }
    let start = start.parse::<u64>().ok()?;
    let end = end
        .parse::<u64>()
        .ok()
        .unwrap_or_else(|| size.saturating_sub(1))
        .min(size.saturating_sub(1));
    (start <= end).then_some((start, end))
}

fn content_type_for_path(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("webm") => "video/webm",
        Some("m4v") | Some("mov") | Some("mp4") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("epub") => "application/epub+zip",
        _ => "application/octet-stream",
    }
}

async fn prepare_anime_hls(
    Json(payload): Json<AnimePathRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let path = normalize_video_path(&payload.path)?;
    let key = anime_cache_key(&path).await?;
    let dir = anime_cache_dir(&key);
    let playlist = dir.join("playlist.m3u8");
    let processing = dir.join(".processing");
    tokio::fs::create_dir_all(&dir).await?;

    if !playlist.exists() && !processing.exists() {
        tokio::fs::write(&processing, b"processing").await?;
        let processing_path = processing.clone();
        tokio::spawn(async move {
            let Some(ffmpeg) = find_command("ffmpeg") else {
                let _ = tokio::fs::remove_file(processing_path).await;
                return;
            };
            let result = Command::new(ffmpeg)
                .arg("-y")
                .arg("-hide_banner")
                .arg("-loglevel")
                .arg("error")
                .arg("-i")
                .arg(&path)
                .arg("-map")
                .arg("0:v:0")
                .arg("-map")
                .arg("0:a:0?")
                .arg("-c:v")
                .arg("libx264")
                .arg("-preset")
                .arg("veryfast")
                .arg("-pix_fmt")
                .arg("yuv420p")
                .arg("-c:a")
                .arg("aac")
                .arg("-b:a")
                .arg("160k")
                .arg("-f")
                .arg("hls")
                .arg("-hls_time")
                .arg("6")
                .arg("-hls_playlist_type")
                .arg("vod")
                .arg("-hls_segment_filename")
                .arg(dir.join("segment_%05d.ts"))
                .arg(&playlist)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            if !matches!(result, Ok(status) if status.success()) {
                let _ = tokio::fs::remove_file(&playlist).await;
            }
            let _ = tokio::fs::remove_file(processing_path).await;
        });
    }

    Ok(Json(hls_status_payload(&key).await?))
}

async fn anime_hls_status(
    Query(query): Query<AnimeTranscodeQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let path = normalize_video_path(&query.path)?;
    let key = anime_cache_key(&path).await?;
    Ok(Json(hls_status_payload(&key).await?))
}

async fn hls_status_payload(key: &str) -> Result<serde_json::Value, AppError> {
    let dir = anime_cache_dir(key);
    let playlist = dir.join("playlist.m3u8");
    let processing = dir.join(".processing");
    Ok(serde_json::json!({
        "key": key,
        "ready": playlist.exists(),
        "processing": processing.exists(),
        "playlist_url": format!("/api/anime/hls/{key}/playlist.m3u8")
    }))
}

async fn anime_hls_playlist(Path(key): Path<String>) -> Result<Response<Body>, AppError> {
    let path = anime_cache_dir(&safe_hls_key(&key)?).join("playlist.m3u8");
    if !path.is_file() {
        return Err(AppError::NotFound("HLS playlist not ready".to_string()));
    }
    let body = tokio::fs::read(path).await?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .map_err(|error| AppError::Internal(error.into()))
}

async fn anime_hls_segment(
    Path((key, segment)): Path<(String, String)>,
) -> Result<Response<Body>, AppError> {
    let segment = safe_hls_segment(&segment)?;
    let path = anime_cache_dir(&safe_hls_key(&key)?).join(segment);
    if !path.is_file() {
        return Err(AppError::NotFound("HLS segment not found".to_string()));
    }
    let body = Body::from_stream(ReaderStream::new(tokio::fs::File::open(path).await?));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp2t")
        .body(body)
        .map_err(|error| AppError::Internal(error.into()))
}

async fn anime_cache_key(path: &FsPath) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};
    let metadata = tokio::fs::metadata(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified()
        && let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH)
    {
        hasher.update(duration.as_secs().to_le_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn anime_cache_dir(key: &str) -> PathBuf {
    PathBuf::from("target").join("anime-hls").join(key)
}

fn find_command(name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    let mut candidates = Vec::new();
    if let Ok(current_exe) = env::current_exe()
        && let Some(dir) = current_exe.parent()
    {
        candidates.push(dir.join(&exe_name));
        candidates.push(dir.join("tools").join("ffmpeg").join("bin").join(&exe_name));
    }

    if let Some(path_var) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path_var).map(|dir| dir.join(&exe_name)));
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn safe_hls_key(key: &str) -> Result<String, AppError> {
    if key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(key.to_string())
    } else {
        Err(AppError::BadRequest("invalid HLS key".to_string()))
    }
}

fn safe_hls_segment(segment: &str) -> Result<String, AppError> {
    if segment.starts_with("segment_")
        && segment.ends_with(".ts")
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'))
    {
        Ok(segment.to_string())
    } else {
        Err(AppError::BadRequest("invalid HLS segment".to_string()))
    }
}

async fn shelf(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BookListQuery>,
) -> Result<Json<ShelfResponse>, AppError> {
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let status_str = normalize_status(query.status)?;
    let status = status_str.as_deref();
    let sort_str = normalize_sort(query.sort)?;
    let sort = sort_str.as_str();
    let min_rating = normalize_min_rating(query.min_rating)?;
    let all_books =
        list_books_internal(&state.db, None, min_rating, status, sort, None::<&str>).await?;

    let mut root_books: Vec<BookSummary> = Vec::new();
    let mut tag_books: BTreeMap<String, Vec<BookSummary>> = BTreeMap::new();

    for book in all_books {
        if !matches_shelf_search(&book, search) {
            continue;
        }
        if let Some(ref tag) = book.folder_tag {
            tag_books.entry(tag.clone()).or_default().push(book);
        } else {
            root_books.push(book);
        }
    }

    let mut items: Vec<ShelfItem> = root_books
        .into_iter()
        .map(|book| ShelfItem::Book {
            book: Box::new(book),
        })
        .collect();
    for (tag, books) in tag_books {
        let tag_matches = search
            .map(|search| contains_case_insensitive(&tag, search))
            .unwrap_or(false);
        let matching_books: Vec<BookSummary> = if tag_matches {
            books
        } else {
            books
                .into_iter()
                .filter(|book| matches_shelf_search(book, search))
                .collect()
        };

        if matching_books.len() == 1 {
            items.push(ShelfItem::Book {
                book: Box::new(matching_books.into_iter().next().unwrap()),
            });
        } else if !matching_books.is_empty() {
            let folder = folder_summary(tag, &matching_books);
            items.push(ShelfItem::Folder { folder });
        }
    }

    sort_shelf_items(&mut items, sort);

    let mut books = Vec::new();
    let mut folders = Vec::new();
    for item in &items {
        match item {
            ShelfItem::Book { book } => books.push((**book).clone()),
            ShelfItem::Folder { folder } => folders.push(folder.clone()),
        }
    }

    Ok(Json(ShelfResponse {
        items,
        books,
        folders,
    }))
}

fn folder_summary(tag: String, books: &[BookSummary]) -> FolderSummary {
    let max_rating = books.iter().filter_map(|b| b.rating).max();
    let max_progress = books
        .iter()
        .filter_map(|b| b.progress.as_ref().map(|p| p.percent))
        .max_by(|a, b| a.total_cmp(b));
    let latest_activity = books
        .iter()
        .filter_map(|b| {
            b.progress
                .as_ref()
                .map(|p| p.updated_at.clone())
                .or_else(|| Some(b.updated_at.clone()))
        })
        .max();

    FolderSummary {
        name: tag,
        book_count: books.len(),
        max_rating,
        max_progress,
        latest_activity,
    }
}

fn sort_shelf_items(items: &mut [ShelfItem], sort: &str) {
    items.sort_by(|a, b| {
        let primary = match sort {
            "progress" => shelf_item_progress(b).total_cmp(&shelf_item_progress(a)),
            "rating" => shelf_item_rating(b).cmp(&shelf_item_rating(a)),
            "recent" => shelf_item_activity(b).cmp(&shelf_item_activity(a)),
            _ => std::cmp::Ordering::Equal,
        };

        primary
            .then_with(|| shelf_item_name(a).cmp(&shelf_item_name(b)))
            .then_with(|| shelf_item_type_order(a).cmp(&shelf_item_type_order(b)))
            .then_with(|| shelf_item_id(a).cmp(&shelf_item_id(b)))
    });
}

fn shelf_item_name(item: &ShelfItem) -> String {
    match item {
        ShelfItem::Book { book } => book.title.to_lowercase(),
        ShelfItem::Folder { folder } => folder.name.to_lowercase(),
    }
}

fn shelf_item_type_order(item: &ShelfItem) -> i32 {
    match item {
        ShelfItem::Folder { .. } => 0,
        ShelfItem::Book { .. } => 1,
    }
}

fn shelf_item_id(item: &ShelfItem) -> i64 {
    match item {
        ShelfItem::Book { book } => book.id,
        ShelfItem::Folder { .. } => 0,
    }
}

fn shelf_item_progress(item: &ShelfItem) -> f64 {
    match item {
        ShelfItem::Book { book } => book.progress.as_ref().map(|p| p.percent).unwrap_or(0.0),
        ShelfItem::Folder { folder } => folder.max_progress.unwrap_or(0.0),
    }
}

fn shelf_item_rating(item: &ShelfItem) -> i64 {
    match item {
        ShelfItem::Book { book } => book.rating.unwrap_or(0),
        ShelfItem::Folder { folder } => folder.max_rating.unwrap_or(0),
    }
}

fn shelf_item_activity(item: &ShelfItem) -> String {
    match item {
        ShelfItem::Book { book } => book
            .progress
            .as_ref()
            .map(|progress| progress.updated_at.clone())
            .unwrap_or_else(|| book.updated_at.clone()),
        ShelfItem::Folder { folder } => folder.latest_activity.clone().unwrap_or_default(),
    }
}

fn matches_shelf_search(book: &BookSummary, search: Option<&str>) -> bool {
    let Some(search) = search else {
        return true;
    };

    contains_case_insensitive(&book.title, search)
        || book
            .folder_tag
            .as_deref()
            .map(|tag| contains_case_insensitive(tag, search))
            .unwrap_or(false)
}

fn contains_case_insensitive(value: &str, search: &str) -> bool {
    value.to_lowercase().contains(&search.to_lowercase())
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
            b.id, b.title, b.file_path, b.file_hash, b.format, b.size, b.mtime, b.encoding,
            b.folder_tag,
            b.rating,
            b.created_at, b.updated_at,
            p.char_offset AS progress_char_offset,
            p.percent AS progress_percent,
            p.locator AS progress_locator,
            p.version AS progress_version,
            p.last_mutation_id AS progress_mutation_id,
            p.position_kind AS progress_position_kind,
            p.paragraph_fraction AS progress_paragraph_fraction,
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
            b.id, b.title, b.file_path, b.file_hash, b.format, b.size, b.mtime, b.encoding,
            b.folder_tag,
            b.rating,
            b.created_at, b.updated_at,
            p.char_offset AS progress_char_offset,
            p.percent AS progress_percent,
            p.locator AS progress_locator,
            p.version AS progress_version,
            p.last_mutation_id AS progress_mutation_id,
            p.position_kind AS progress_position_kind,
            p.paragraph_fraction AS progress_paragraph_fraction,
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
    let (title, file_path, format) = require_book(&state.db, id).await?;
    if format != "txt" {
        return Err(AppError::BadRequest(
            "book content endpoint is only available for txt books".to_string(),
        ));
    }
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

async fn stream_book_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Result<Response<Body>, AppError> {
    let (_, file_path, format) = require_book(&state.db, id).await?;
    if format != "epub" {
        return Err(AppError::BadRequest(
            "book file endpoint is only available for epub books".to_string(),
        ));
    }
    stream_file_path(PathBuf::from(file_path), headers).await
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
    let Some(base_version) = payload.base_version else {
        return Err(AppError::ProgressProtocolUpgradeRequired {
            message: "base_version is required for progress writes".to_string(),
            current: None,
        });
    };
    if base_version < 0 {
        return Err(AppError::BadRequest(
            "base_version must be non-negative".to_string(),
        ));
    }

    let Some(mutation_id) = payload
        .mutation_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Err(AppError::ProgressProtocolUpgradeRequired {
            message: "mutation_id is required for progress writes".to_string(),
            current: None,
        });
    };
    if mutation_id.len() > 128 {
        return Err(AppError::BadRequest(
            "mutation_id must be between 1 and 128 bytes".to_string(),
        ));
    }

    if !payload.percent.is_finite() {
        return Err(AppError::BadRequest("percent must be finite".to_string()));
    }

    let position_kind = payload.position_kind.as_deref();
    match position_kind {
        None if payload.paragraph_fraction.is_some() => {
            return Err(AppError::BadRequest(
                "paragraph_fraction requires position_kind".to_string(),
            ));
        }
        None => {}
        Some(PARAGRAPH_POSITION_KIND) => {
            let Some(fraction) = payload.paragraph_fraction else {
                return Err(AppError::BadRequest(
                    "paragraph_fraction is required for paragraph_utf16_lf_v1".to_string(),
                ));
            };
            if !fraction.is_finite() || !(0.0..=1.0).contains(&fraction) {
                return Err(AppError::BadRequest(
                    "paragraph_fraction must be finite and between 0 and 1".to_string(),
                ));
            }
        }
        Some(_) => {
            return Err(AppError::BadRequest(
                "unknown progress position_kind".to_string(),
            ));
        }
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
    let allow_backward = payload.allow_backward.unwrap_or(false);

    let (title, _, _) = require_book(&state.db, id).await?;
    let mut tx = state.db.begin().await?;

    let saved = if base_version == 0 {
        sqlx::query(
            r#"
            INSERT INTO reading_progress (
                book_id, char_offset, percent, locator, version,
                last_mutation_id, position_kind, paragraph_fraction
            )
            VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)
            ON CONFLICT(book_id) DO NOTHING
            RETURNING book_id, char_offset, percent, locator, version,
                      last_mutation_id, position_kind, paragraph_fraction, updated_at
            "#,
        )
        .bind(id)
        .bind(char_offset)
        .bind(percent)
        .bind(payload.locator.as_deref())
        .bind(mutation_id)
        .bind(position_kind)
        .bind(payload.paragraph_fraction)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_progress_write_error)?
        .map(progress_from_row)
        .transpose()?
    } else {
        sqlx::query(
            r#"
            UPDATE reading_progress
            SET
                char_offset = ?2,
                percent = ?3,
                locator = ?4,
                last_mutation_id = ?5,
                position_kind = ?6,
                paragraph_fraction = ?7,
                version = version + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE book_id = ?1
              AND version = ?8
              AND (last_mutation_id IS NULL OR last_mutation_id <> ?5)
            RETURNING book_id, char_offset, percent, locator, version,
                      last_mutation_id, position_kind, paragraph_fraction, updated_at
            "#,
        )
        .bind(id)
        .bind(char_offset)
        .bind(percent)
        .bind(payload.locator.as_deref())
        .bind(mutation_id)
        .bind(position_kind)
        .bind(payload.paragraph_fraction)
        .bind(base_version)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_progress_write_error)?
        .map(progress_from_row)
        .transpose()?
    };

    let saved = match saved {
        Some(saved) => saved,
        None => {
            let current = fetch_progress_with_connection(&mut tx, id).await?;
            if let Some(current) = current {
                if current.mutation_id.as_deref() == Some(mutation_id)
                    && progress_payload_matches(
                        &current,
                        char_offset,
                        percent,
                        payload.locator.as_deref(),
                        position_kind,
                        payload.paragraph_fraction,
                    )
                {
                    tx.commit().await?;
                    return Ok(Json(current));
                }

                return Err(AppError::ProgressConflict {
                    message: format!(
                        "reading progress changed (expected version {base_version}, current version {})",
                        current.version
                    ),
                    current: Some(Box::new(current)),
                });
            }

            let book_exists: Option<i64> = sqlx::query_scalar("SELECT id FROM books WHERE id = ?1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
            if book_exists.is_none() {
                return Err(AppError::NotFound("book not found".to_string()));
            }

            return Err(AppError::ProgressConflict {
                message: format!("reading progress is missing (expected version {base_version})"),
                current: None,
            });
        }
    };

    tx.commit().await?;
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

fn map_progress_write_error(error: sqlx::Error) -> AppError {
    let is_missing_book = matches!(
        &error,
        sqlx::Error::Database(database)
            if database.code().as_deref() == Some("787")
    );
    if is_missing_book {
        AppError::NotFound("book not found".to_string())
    } else {
        AppError::Internal(error.into())
    }
}

fn progress_payload_matches(
    current: &ReadingProgress,
    char_offset: i64,
    percent: f64,
    locator: Option<&str>,
    position_kind: Option<&str>,
    paragraph_fraction: Option<f64>,
) -> bool {
    current.char_offset == char_offset
        && current.percent == percent
        && current.locator.as_deref() == locator
        && current.position_kind.as_deref() == position_kind
        && current.paragraph_fraction == paragraph_fraction
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

async fn require_book(db: &SqlitePool, id: i64) -> Result<(String, String, String), AppError> {
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
            locator: row.try_get("progress_locator")?,
            version: row.try_get("progress_version")?,
            mutation_id: row.try_get("progress_mutation_id")?,
            position_kind: row.try_get("progress_position_kind")?,
            paragraph_fraction: row.try_get("progress_paragraph_fraction")?,
            updated_at: row.try_get("progress_updated_at")?,
        }),
        None => None,
    };

    Ok(BookSummary {
        id,
        title: row.try_get("title")?,
        file_path: row.try_get("file_path")?,
        file_hash: row.try_get("file_hash")?,
        format: row.try_get("format")?,
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
        locator: row.try_get("locator")?,
        version: row.try_get("version")?,
        mutation_id: row.try_get("last_mutation_id")?,
        position_kind: row.try_get("position_kind")?,
        paragraph_fraction: row.try_get("paragraph_fraction")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn fetch_progress(db: &SqlitePool, id: i64) -> Result<Option<ReadingProgress>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT book_id, char_offset, percent, locator, version, last_mutation_id, position_kind, paragraph_fraction, updated_at FROM reading_progress WHERE book_id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;

    row.map(progress_from_row).transpose()
}

async fn fetch_progress_with_connection(
    db: &mut sqlx::SqliteConnection,
    id: i64,
) -> Result<Option<ReadingProgress>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT book_id, char_offset, percent, locator, version, last_mutation_id, position_kind, paragraph_fraction, updated_at FROM reading_progress WHERE book_id = ?1",
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
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};

    use crate::{
        AppState,
        config::Config,
        db::{connect_db, migrate},
        models::{BookListQuery, SaveProgressRequest, SaveRatingRequest},
    };

    use super::*;

    #[tokio::test]
    async fn scan_lock_rejects_overlapping_scan() {
        let fixture = TestFixture::new("scan-lock").await;
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
            .fetch_one(&fixture.state.db)
            .await
            .unwrap();
        let guard = fixture.state.scan_lock.lock().await;

        let error = scan(State(fixture.state.clone())).await.unwrap_err();
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "scan_in_progress");
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
            .fetch_one(&fixture.state.db)
            .await
            .unwrap();
        assert_eq!(after, before);

        drop(guard);
        let Json(result) = scan(State(fixture.state.clone())).await.unwrap();
        assert!(result.errors.is_empty());

        fixture.cleanup().await;
    }

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
    async fn save_progress_requires_the_versioned_protocol() {
        let fixture = TestFixture::new("progress-version").await;
        let id = fixture.insert_book("Book", -1.0, None).await;

        let missing_version = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 100,
                percent: 0.5,
                locator: None,
                mutation_id: Some("m1".to_string()),
                position_kind: None,
                paragraph_fraction: None,
                source: Some("test".to_string()),
                client_id: None,
                session_id: None,
                allow_backward: None,
                base_version: None,
            }),
        )
        .await
        .unwrap_err();
        let response = missing_version.into_response();
        assert_eq!(response.status(), StatusCode::PRECONDITION_REQUIRED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "progress_protocol_upgrade_required");

        let missing_mutation = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 100,
                percent: 0.5,
                locator: None,
                mutation_id: None,
                position_kind: None,
                paragraph_fraction: None,
                source: None,
                client_id: None,
                session_id: None,
                allow_backward: None,
                base_version: Some(0),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            missing_mutation.into_response().status(),
            StatusCode::PRECONDITION_REQUIRED
        );

        let empty_mutation = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                mutation_id: Some(String::new()),
                ..progress_request_defaults()
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            empty_mutation.into_response().status(),
            StatusCode::PRECONDITION_REQUIRED
        );

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn save_progress_is_idempotent_and_conflict_safe() {
        let fixture = TestFixture::new("progress-idempotency").await;
        let id = fixture.insert_book("Book", -1.0, None).await;
        let first_payload = SaveProgressRequest {
            char_offset: 100,
            percent: 0.5,
            locator: None,
            mutation_id: Some("m1".to_string()),
            position_kind: Some("paragraph_utf16_lf_v1".to_string()),
            paragraph_fraction: Some(0.25),
            source: Some("test".to_string()),
            client_id: None,
            session_id: None,
            allow_backward: None,
            base_version: Some(0),
        };

        let Json(first) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(first_payload.clone()),
        )
        .await
        .unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(first.mutation_id.as_deref(), Some("m1"));
        assert_eq!(
            first.position_kind.as_deref(),
            Some("paragraph_utf16_lf_v1")
        );
        assert_eq!(first.paragraph_fraction, Some(0.25));

        let Json(retry) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(first_payload.clone()),
        )
        .await
        .unwrap();
        assert_eq!(retry.version, first.version);
        assert_eq!(retry.updated_at, first.updated_at);

        let changed_mutation = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 101,
                ..first_payload.clone()
            }),
        )
        .await
        .unwrap_err();
        let response = changed_mutation.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "progress_conflict");
        assert_eq!(body["current"]["version"], 1);

        let Json(second) = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 20,
                percent: 0.1,
                mutation_id: Some("m2".to_string()),
                base_version: Some(first.version),
                allow_backward: Some(true),
                ..first_payload.clone()
            }),
        )
        .await
        .unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.percent, 0.1);

        let stale = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 120,
                percent: 0.6,
                mutation_id: Some("m3".to_string()),
                base_version: Some(first.version),
                ..first_payload.clone()
            }),
        )
        .await
        .unwrap_err();
        let response = stale.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["current"]["version"], 2);

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn save_progress_rejects_invalid_protocol_values() {
        let fixture = TestFixture::new("progress-validation").await;
        let id = fixture.insert_book("Book", -1.0, None).await;
        let cases = [
            SaveProgressRequest {
                base_version: Some(-1),
                mutation_id: Some("m".to_string()),
                ..progress_request_defaults()
            },
            SaveProgressRequest {
                base_version: Some(0),
                mutation_id: Some("x".repeat(129)),
                ..progress_request_defaults()
            },
            SaveProgressRequest {
                base_version: Some(0),
                mutation_id: Some("m".to_string()),
                position_kind: Some("unknown".to_string()),
                ..progress_request_defaults()
            },
            SaveProgressRequest {
                base_version: Some(0),
                mutation_id: Some("m".to_string()),
                position_kind: Some("paragraph_utf16_lf_v1".to_string()),
                paragraph_fraction: Some(1.1),
                ..progress_request_defaults()
            },
            SaveProgressRequest {
                base_version: Some(0),
                mutation_id: Some("m".to_string()),
                position_kind: Some("paragraph_utf16_lf_v1".to_string()),
                paragraph_fraction: None,
                ..progress_request_defaults()
            },
        ];
        for payload in cases {
            let error = save_progress(
                State(fixture.state.clone()),
                Path(id),
                HeaderMap::new(),
                Json(payload),
            )
            .await
            .unwrap_err();
            assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        }

        let error = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                paragraph_fraction: Some(f64::NAN),
                ..progress_request_defaults()
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn progress_fields_are_mapped_by_all_book_endpoints() {
        let fixture = TestFixture::new("progress-mapping").await;
        let id = fixture.insert_book("Book", -1.0, None).await;
        sqlx::query(
            "INSERT INTO reading_progress (book_id, char_offset, percent, version, last_mutation_id, position_kind, paragraph_fraction) VALUES (?1, 11, 0.4, 7, 'm7', 'paragraph_utf16_lf_v1', 0.75)",
        )
        .bind(id)
        .execute(&fixture.state.db)
        .await
        .unwrap();

        let Json(list) = list_books(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: None,
                min_rating: None,
                folder_tag: None,
                sort: None,
            }),
        )
        .await
        .unwrap();
        let progress = list[0].progress.as_ref().unwrap();
        assert_eq!(progress.version, 7);
        assert_eq!(progress.mutation_id.as_deref(), Some("m7"));
        assert_eq!(
            progress.position_kind.as_deref(),
            Some("paragraph_utf16_lf_v1")
        );
        assert_eq!(progress.paragraph_fraction, Some(0.75));

        let Json(book) = get_book(State(fixture.state.clone()), Path(id))
            .await
            .unwrap();
        assert_eq!(book.progress.unwrap().mutation_id.as_deref(), Some("m7"));

        let Json(shelf) = shelf(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: None,
                min_rating: None,
                folder_tag: None,
                sort: None,
            }),
        )
        .await
        .unwrap();
        match &shelf.items[0] {
            ShelfItem::Book { book } => {
                assert_eq!(
                    book.progress.as_ref().unwrap().position_kind.as_deref(),
                    Some("paragraph_utf16_lf_v1")
                );
            }
            ShelfItem::Folder { .. } => panic!("expected book shelf item"),
        }

        let Json(progress) = get_progress(State(fixture.state.clone()), Path(id))
            .await
            .unwrap();
        assert_eq!(progress.unwrap().paragraph_fraction, Some(0.75));

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn concurrent_first_progress_writes_are_insert_or_conflict() {
        let fixture = TestFixture::new("progress-concurrency").await;
        let id = fixture.insert_book("Book", -1.0, None).await;
        let left = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 10,
                percent: 0.1,
                mutation_id: Some("left".to_string()),
                base_version: Some(0),
                ..progress_request_defaults()
            }),
        );
        let right = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                char_offset: 20,
                percent: 0.2,
                mutation_id: Some("right".to_string()),
                base_version: Some(0),
                ..progress_request_defaults()
            }),
        );
        let (left, right) = tokio::join!(left, right);
        let statuses = [
            left.map(|_| StatusCode::OK)
                .unwrap_or_else(|error| error.into_response().status()),
            right
                .map(|_| StatusCode::OK)
                .unwrap_or_else(|error| error.into_response().status()),
        ];
        assert!(statuses.contains(&StatusCode::OK), "statuses: {statuses:?}");
        assert!(
            statuses.contains(&StatusCode::CONFLICT),
            "statuses: {statuses:?}"
        );

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn save_progress_missing_book_or_progress_returns_structured_error() {
        let fixture = TestFixture::new("progress-disappears").await;
        let missing_book = save_progress(
            State(fixture.state.clone()),
            Path(999_999),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                base_version: Some(0),
                mutation_id: Some("m".to_string()),
                ..progress_request_defaults()
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(missing_book.into_response().status(), StatusCode::NOT_FOUND);

        let id = fixture.insert_book("Book", -1.0, None).await;
        let disappeared_progress = save_progress(
            State(fixture.state.clone()),
            Path(id),
            HeaderMap::new(),
            Json(SaveProgressRequest {
                base_version: Some(1),
                mutation_id: Some("m".to_string()),
                ..progress_request_defaults()
            }),
        )
        .await
        .unwrap_err();
        let response = disappeared_progress.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "progress_conflict");
        assert!(body["current"].is_null());

        fixture.cleanup().await;
    }

    fn progress_request_defaults() -> SaveProgressRequest {
        SaveProgressRequest {
            char_offset: 100,
            percent: 0.5,
            locator: None,
            mutation_id: Some("default".to_string()),
            position_kind: None,
            paragraph_fraction: None,
            source: None,
            client_id: None,
            session_id: None,
            allow_backward: None,
            base_version: Some(0),
        }
    }

    #[tokio::test]
    async fn shelf_groups_books_and_collapses_single_book_folders() {
        let fixture = TestFixture::new("shelf-groups").await;
        fixture.insert_book("Root", -1.0, None).await;
        fixture.insert_tagged_book("Multi1", -1.0, "Author").await;
        fixture.insert_tagged_book("Multi2", -1.0, "Author").await;
        fixture.insert_tagged_book("Single", -1.0, "Loner").await;

        let Json(resp) = shelf(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: None,
                min_rating: None,
                folder_tag: None,
                sort: Some("title".to_string()),
            }),
        )
        .await
        .unwrap();

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

    #[tokio::test]
    async fn shelf_sorts_folders_and_books_together_by_progress() {
        let fixture = TestFixture::new("shelf-mixed-sort").await;
        fixture.insert_book("Root", 0.8, None).await;
        fixture.insert_tagged_book("Low1", 0.1, "Folder").await;
        fixture.insert_tagged_book("Low2", 0.2, "Folder").await;

        let Json(resp) = shelf(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: None,
                status: None,
                min_rating: None,
                folder_tag: None,
                sort: Some("progress".to_string()),
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 2);
        match &resp.items[0] {
            ShelfItem::Book { book } => assert_eq!(book.title, "Root"),
            _ => panic!("root book should sort before lower-progress folder"),
        }

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn shelf_search_collapses_folder_to_single_matching_book() {
        let fixture = TestFixture::new("shelf-search-collapse").await;
        fixture.insert_tagged_book("Needle", -1.0, "Folder").await;
        fixture.insert_tagged_book("Other", -1.0, "Folder").await;

        let Json(resp) = shelf(
            State(fixture.state.clone()),
            Query(BookListQuery {
                search: Some("Need".to_string()),
                status: None,
                min_rating: None,
                folder_tag: None,
                sort: Some("title".to_string()),
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 1);
        match &resp.items[0] {
            ShelfItem::Book { book } => assert_eq!(book.title, "Needle"),
            _ => panic!("single matching folder book should collapse to a book item"),
        }

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
            let config = Config {
                library_dirs: vec![root.join("novels").to_string_lossy().into_owned()],
                ..Config::default()
            };
            let state = Arc::new(AppState {
                config,
                db,
                scan_lock: Arc::new(tokio::sync::Mutex::new(())),
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
