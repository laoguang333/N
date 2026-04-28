use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct BookSummary {
    pub id: i64,
    pub title: String,
    pub file_path: String,
    pub file_hash: String,
    pub size: i64,
    pub mtime: i64,
    pub encoding: String,
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

#[derive(Debug, Serialize)]
pub struct ReadingProgress {
    pub book_id: i64,
    pub char_offset: i64,
    pub percent: f64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveProgressRequest {
    pub char_offset: i64,
    pub percent: f64,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub scanned: usize,
    pub removed: usize,
}

#[derive(Debug, Deserialize)]
pub struct BookListQuery {
    pub search: Option<String>,
}
