use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
pub struct BookSummary {
    pub id: i64,
    pub title: String,
    pub file_path: String,
    pub file_hash: String,
    pub format: String,
    pub size: i64,
    pub mtime: i64,
    pub encoding: String,
    pub rating: Option<i64>,
    pub folder_tag: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub progress: Option<ReadingProgress>,
}

#[derive(Debug, Serialize)]
pub struct BookContent {
    pub book_id: i64,
    pub title: String,
    pub content: String,
    pub length: usize,
    pub encoding: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReadingProgress {
    pub book_id: i64,
    pub char_offset: i64,
    pub percent: f64,
    pub locator: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveProgressRequest {
    pub char_offset: i64,
    pub percent: f64,
    pub locator: Option<String>,
    pub source: Option<String>,
    pub client_id: Option<String>,
    pub session_id: Option<String>,
    pub allow_backward: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SaveRatingRequest {
    pub rating: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub scanned: usize,
    pub removed: usize,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct BookListQuery {
    pub search: Option<String>,
    pub status: Option<String>,
    pub min_rating: Option<i64>,
    pub sort: Option<String>,
    pub folder_tag: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AnimeScanResult {
    pub scanned: usize,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub marked_missing: usize,
    pub restored: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnimeVideoSummary {
    pub id: i64,
    pub title: String,
    pub file_path: String,
    pub extension: String,
    pub folder_tag: Option<String>,
    pub size: i64,
    pub mtime: i64,
    pub duration_seconds: Option<f64>,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub rating: Option<i64>,
    pub file_state: String,
    pub last_seen_at: String,
    pub missing_since: Option<String>,
    pub progress: Option<AnimeProgress>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnimeProgress {
    pub video_id: i64,
    pub position_seconds: f64,
    pub percent: f64,
    pub duration_seconds: Option<f64>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct AnimeListQuery {
    pub search: Option<String>,
    pub status: Option<String>,
    pub availability: Option<String>,
    pub min_rating: Option<i64>,
    pub sort: Option<String>,
    pub folder_tag: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveAnimeProgressRequest {
    pub position_seconds: f64,
    pub percent: f64,
    pub duration_seconds: Option<f64>,
    pub source: Option<String>,
    pub client_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AnimeWatchStartRequest {
    pub position_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct AnimeWatchStartResponse {
    pub history_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct AnimeWatchFinishRequest {
    pub last_position_seconds: f64,
    pub watched_seconds: f64,
    pub completed: bool,
}

#[derive(Debug, Deserialize)]
pub struct AnimeHistoryQuery {
    pub period: Option<String>,
    pub search: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AnimeWatchHistoryItem {
    pub id: i64,
    pub video_id: i64,
    pub title: String,
    pub file_state: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_position_seconds: f64,
    pub watched_seconds: f64,
    pub completed: bool,
}

#[derive(Debug, Deserialize)]
pub struct AnimeTranscodeQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct AnimePathRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct AnimeToolsStatus {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ShelfResponse {
    pub items: Vec<ShelfItem>,
    pub books: Vec<BookSummary>,
    pub folders: Vec<FolderSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FolderSummary {
    pub name: String,
    pub book_count: usize,
    pub max_rating: Option<i64>,
    pub max_progress: Option<f64>,
    pub latest_activity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShelfItem {
    Book { book: Box<BookSummary> },
    Folder { folder: FolderSummary },
}

#[derive(Debug, Serialize)]
pub struct PublicConfig {
    pub library_dirs: Vec<String>,
    pub scan_recursive: bool,
    pub scan_on_startup: bool,
    pub anime_dirs: Vec<String>,
    pub anime_scan_recursive: bool,
    pub anime_scan_on_startup: bool,
}
