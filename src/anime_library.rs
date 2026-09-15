use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::UNIX_EPOCH,
};

use serde::Deserialize;
use sqlx::{Row, SqlitePool};
use tokio::process::Command;

use crate::models::AnimeScanResult;

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "rmvb",
];

#[derive(Default)]
struct ProbeMeta {
    duration_seconds: Option<f64>,
    container: Option<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    format: Option<FfprobeFormat>,
    streams: Option<Vec<FfprobeStream>>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    format_name: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

pub async fn scan_anime_library(
    db: &SqlitePool,
    dirs: &[String],
    recursive: bool,
    ffprobe: Option<PathBuf>,
) -> AnimeScanResult {
    let mut result = AnimeScanResult {
        scanned: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        marked_missing: 0,
        restored: 0,
        errors: Vec::new(),
    };
    let mut seen_paths = Vec::new();

    for dir in dirs {
        let root = PathBuf::from(dir);
        if !root.exists() {
            result
                .errors
                .push(format!("目录不存在: {}", root.display()));
            continue;
        }
        let mut files = Vec::new();
        collect_video_files(&root, recursive, &mut files, &mut result.errors);
        for path in files {
            result.scanned += 1;
            match upsert_video(db, &root, &path, ffprobe.as_deref()).await {
                Ok(ScanAction::Added) => result.added += 1,
                Ok(ScanAction::Updated) => result.updated += 1,
                Ok(ScanAction::Skipped) => result.skipped += 1,
                Ok(ScanAction::Restored) => result.restored += 1,
                Err(error) => result.errors.push(format!("{}: {error}", path.display())),
            }
            seen_paths.push(normalize_path(&path));
        }
    }

    match mark_missing(db, &seen_paths).await {
        Ok(count) => result.marked_missing = count,
        Err(error) => result.errors.push(format!("标记缺失失败: {error}")),
    }

    result
}

enum ScanAction {
    Added,
    Updated,
    Skipped,
    Restored,
}

fn collect_video_files(
    root: &Path,
    recursive: bool,
    files: &mut Vec<PathBuf>,
    errors: &mut Vec<String>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        errors.push(format!("无法读取目录: {}", root.display()));
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && recursive {
            collect_video_files(&path, recursive, files, errors);
        } else if path.is_file() && is_video_file(&path) {
            files.push(path);
        }
    }
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| VIDEO_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

async fn upsert_video(
    db: &SqlitePool,
    root: &Path,
    path: &Path,
    ffprobe: Option<&Path>,
) -> anyhow::Result<ScanAction> {
    let metadata = tokio::fs::metadata(path).await?;
    let size = metadata.len() as i64;
    let mtime = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let file_path = normalize_path(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();
    let folder_tag = path
        .parent()
        .filter(|parent| *parent != root)
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        .map(str::to_string);

    let existing =
        sqlx::query("SELECT id, size, mtime, file_state FROM anime_videos WHERE file_path = ?1")
            .bind(&file_path)
            .fetch_optional(db)
            .await?;

    if let Some(row) = existing {
        let id: i64 = row.try_get("id")?;
        let old_size: i64 = row.try_get("size")?;
        let old_mtime: i64 = row.try_get("mtime")?;
        let old_state: String = row.try_get("file_state")?;
        if old_size == size && old_mtime == mtime {
            sqlx::query(
                r#"
                UPDATE anime_videos
                SET file_state = 'available',
                    last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    missing_since = NULL,
                    missing_reason = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
            )
            .bind(id)
            .execute(db)
            .await?;
            return Ok(if old_state == "missing" {
                ScanAction::Restored
            } else {
                ScanAction::Skipped
            });
        }

        let meta = probe_video(ffprobe, path).await.unwrap_or_default();
        sqlx::query(
            r#"
            UPDATE anime_videos
            SET title = ?2, extension = ?3, folder_tag = ?4, size = ?5, mtime = ?6,
                duration_seconds = ?7, container = ?8, video_codec = ?9, audio_codec = ?10,
                width = ?11, height = ?12, file_state = 'available',
                last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                missing_since = NULL, missing_reason = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
            "#,
        )
        .bind(id)
        .bind(title)
        .bind(extension)
        .bind(folder_tag)
        .bind(size)
        .bind(mtime)
        .bind(meta.duration_seconds)
        .bind(meta.container)
        .bind(meta.video_codec)
        .bind(meta.audio_codec)
        .bind(meta.width)
        .bind(meta.height)
        .execute(db)
        .await?;
        return Ok(if old_state == "missing" {
            ScanAction::Restored
        } else {
            ScanAction::Updated
        });
    }

    let meta = probe_video(ffprobe, path).await.unwrap_or_default();
    sqlx::query(
        r#"
        INSERT INTO anime_videos (
            title, file_path, original_file_path, extension, folder_tag, size, mtime,
            duration_seconds, container, video_codec, audio_codec, width, height
        )
        VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        "#,
    )
    .bind(title)
    .bind(file_path)
    .bind(extension)
    .bind(folder_tag)
    .bind(size)
    .bind(mtime)
    .bind(meta.duration_seconds)
    .bind(meta.container)
    .bind(meta.video_codec)
    .bind(meta.audio_codec)
    .bind(meta.width)
    .bind(meta.height)
    .execute(db)
    .await?;
    Ok(ScanAction::Added)
}

async fn probe_video(ffprobe: Option<&Path>, path: &Path) -> anyhow::Result<ProbeMeta> {
    let Some(ffprobe) = ffprobe else {
        return Ok(ProbeMeta::default());
    };
    let output = Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration,format_name:stream=codec_type,codec_name,width,height")
        .arg("-of")
        .arg("json")
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .await?;
    if !output.status.success() {
        return Ok(ProbeMeta::default());
    }
    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)?;
    let mut meta = ProbeMeta {
        duration_seconds: parsed
            .format
            .as_ref()
            .and_then(|format| format.duration.as_deref())
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite()),
        container: parsed.format.and_then(|format| format.format_name),
        ..ProbeMeta::default()
    };
    for stream in parsed.streams.unwrap_or_default() {
        match stream.codec_type.as_deref() {
            Some("video") if meta.video_codec.is_none() => {
                meta.video_codec = stream.codec_name;
                meta.width = stream.width;
                meta.height = stream.height;
            }
            Some("audio") if meta.audio_codec.is_none() => meta.audio_codec = stream.codec_name,
            _ => {}
        }
    }
    Ok(meta)
}

async fn mark_missing(db: &SqlitePool, seen_paths: &[String]) -> anyhow::Result<usize> {
    let rows = sqlx::query("SELECT id, file_path FROM anime_videos WHERE file_state = 'available'")
        .fetch_all(db)
        .await?;
    let mut count = 0;
    for row in rows {
        let id: i64 = row.try_get("id")?;
        let path: String = row.try_get("file_path")?;
        if !seen_paths.contains(&path) && !Path::new(&path).exists() {
            sqlx::query(
                r#"
                UPDATE anime_videos
                SET file_state = 'missing',
                    missing_since = COALESCE(missing_since, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    missing_reason = 'not_found',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
            )
            .bind(id)
            .execute(db)
            .await?;
            count += 1;
        }
    }
    Ok(count)
}

fn normalize_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}
