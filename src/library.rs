use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, anyhow};
use chardetng::EncodingDetector;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tokio::{fs, io::AsyncReadExt};

use crate::models::ScanResult;

pub async fn scan_library(db: &SqlitePool, library_dirs: &[String]) -> anyhow::Result<ScanResult> {
    let mut seen_paths = HashSet::new();
    let mut scanned = 0usize;

    for dir in library_dirs {
        let dir_path = PathBuf::from(dir);
        if !dir_path.exists() {
            fs::create_dir_all(&dir_path).await.with_context(|| {
                format!("failed to create library directory {}", dir_path.display())
            })?;
        }

        let mut entries = fs::read_dir(&dir_path)
            .await
            .with_context(|| format!("failed to read library directory {}", dir_path.display()))?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;
            if !metadata.is_file() || !is_txt_file(&path) {
                continue;
            }

            let canonical_path = path.canonicalize()?;
            let file_path = canonical_path.to_string_lossy().to_string();
            let title = path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Untitled")
                .to_string();

            let bytes = read_all(&path).await?;
            let file_hash = sha256_hex(&bytes);
            let encoding = detect_encoding(&bytes).name().to_string();
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();

            sqlx::query(
                r#"
                INSERT INTO books (title, file_path, file_hash, size, mtime, encoding)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(file_path) DO UPDATE SET
                    title = excluded.title,
                    file_hash = excluded.file_hash,
                    size = excluded.size,
                    mtime = excluded.mtime,
                    encoding = excluded.encoding,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                "#,
            )
            .bind(title)
            .bind(&file_path)
            .bind(file_hash)
            .bind(metadata.len() as i64)
            .bind(mtime)
            .bind(encoding)
            .execute(db)
            .await?;

            seen_paths.insert(file_path);
            scanned += 1;
        }
    }

    let removed = remove_missing_books(db, library_dirs, &seen_paths).await?;

    Ok(ScanResult { scanned, removed })
}

pub async fn read_book_content(path: &str) -> anyhow::Result<(String, String)> {
    let bytes = read_all(Path::new(path)).await?;
    let encoding = detect_encoding(&bytes);
    let (text, _, _) = encoding.decode(&bytes);
    Ok((text.into_owned(), encoding.name().to_string()))
}

async fn remove_missing_books(
    db: &SqlitePool,
    library_dirs: &[String],
    seen_paths: &HashSet<String>,
) -> anyhow::Result<usize> {
    let library_roots = canonical_library_roots(library_dirs)?;
    let rows = sqlx::query("SELECT id, file_path FROM books")
        .fetch_all(db)
        .await?;

    let mut removed = 0usize;
    for row in rows {
        let id: i64 = row.try_get("id")?;
        let file_path: String = row.try_get("file_path")?;
        let path = PathBuf::from(&file_path);

        if is_top_level_library_file(&path, &library_roots) && !seen_paths.contains(&file_path) {
            sqlx::query("DELETE FROM books WHERE id = ?1")
                .bind(id)
                .execute(db)
                .await?;
            removed += 1;
        }
    }

    Ok(removed)
}

fn canonical_library_roots(library_dirs: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    library_dirs
        .iter()
        .map(|dir| {
            PathBuf::from(dir)
                .canonicalize()
                .with_context(|| format!("failed to canonicalize library directory {dir}"))
        })
        .collect()
}

fn is_top_level_library_file(path: &Path, roots: &[PathBuf]) -> bool {
    if !is_txt_file(path) {
        return false;
    }

    path.parent()
        .map(|parent| roots.iter().any(|root| same_path(parent, root)))
        .unwrap_or(false)
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn is_txt_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("txt"))
        .unwrap_or(false)
}

async fn read_all(path: &Path) -> anyhow::Result<Vec<u8>> {
    let mut file = fs::File::open(path)
        .await
        .with_context(|| format!("failed to open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

fn detect_encoding(bytes: &[u8]) -> &'static encoding_rs::Encoding {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    detector.guess(Some(b"zh"), true)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub async fn require_book_path(db: &SqlitePool, id: i64) -> anyhow::Result<(String, String)> {
    let row = sqlx::query("SELECT title, file_path FROM books WHERE id = ?1")
        .bind(id)
        .fetch_optional(db)
        .await?;

    let row = row.ok_or_else(|| anyhow!("book not found"))?;
    Ok((row.try_get("title")?, row.try_get("file_path")?))
}
