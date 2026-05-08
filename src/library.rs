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

use zhconv::{zhconv, Variant};

use crate::models::ScanResult;

#[derive(Debug)]
struct ExistingBook {
    id: i64,
    file_path: String,
    size: i64,
    mtime: i64,
}

#[derive(Debug)]
struct ScannedBookFile {
    title: String,
    file_path: String,
    file_hash: String,
    size: i64,
    mtime: i64,
    encoding: String,
    folder_tag: Option<String>,
}

pub async fn scan_library(
    db: &SqlitePool,
    library_dirs: &[String],
    recursive: bool,
) -> anyhow::Result<ScanResult> {
    let mut seen_paths = HashSet::new();
    let mut result = ScanResult {
        scanned: 0,
        removed: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        errors: Vec::new(),
    };

    let library_roots = canonical_library_roots(library_dirs)?;

    for dir in library_dirs {
        let dir_path = PathBuf::from(dir);
        if !dir_path.exists()
            && let Err(error) = fs::create_dir_all(&dir_path).await
        {
            result.errors.push(format!(
                "failed to create library directory {}: {error}",
                dir_path.display()
            ));
            continue;
        }

        let files = match collect_txt_files(&dir_path, recursive).await {
            Ok(files) => files,
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };

        for path in files {
            result.scanned += 1;

            match scan_book_file(db, &path, &mut seen_paths, &library_roots).await {
                Ok(BookScanOutcome::Added) => result.added += 1,
                Ok(BookScanOutcome::Updated) => result.updated += 1,
                Ok(BookScanOutcome::Skipped) => result.skipped += 1,
                Err(error) => result
                    .errors
                    .push(format!("failed to scan {}: {error:#}", path.display())),
            }
        }
    }

    result.removed = remove_missing_books(db, library_dirs, recursive, &seen_paths).await?;

    Ok(result)
}

#[derive(Debug, Eq, PartialEq)]
enum BookScanOutcome {
    Added,
    Updated,
    Skipped,
}

async fn collect_txt_files(root: &Path, recursive: bool) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];

    while let Some(dir) = dirs.pop() {
        let mut entries = fs::read_dir(&dir)
            .await
            .with_context(|| format!("failed to read library directory {}", dir.display()))?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let metadata = entry.metadata().await?;

            if metadata.is_file() && is_txt_file(&path) {
                files.push(path);
            } else if recursive && metadata.is_dir() {
                dirs.push(path);
            }
        }
    }

    files.sort_by(|left, right| {
        left.to_string_lossy()
            .to_lowercase()
            .cmp(&right.to_string_lossy().to_lowercase())
    });

    Ok(files)
}

async fn scan_book_file(
    db: &SqlitePool,
    path: &Path,
    seen_paths: &mut HashSet<String>,
    library_roots: &[PathBuf],
) -> anyhow::Result<BookScanOutcome> {
    let metadata = fs::metadata(path).await?;
    let canonical_path = path.canonicalize()?;
    let file_path = canonical_path.to_string_lossy().to_string();
    let size = metadata.len() as i64;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();
    let folder_tag = compute_folder_tag(&file_path, library_roots);

    if let Some(existing) = existing_book_by_path(db, &file_path).await? {
        seen_paths.insert(file_path.clone());
        if existing.size == size && existing.mtime == mtime {
            return Ok(BookScanOutcome::Skipped);
        }

        let scanned = read_scanned_book_file(path, file_path, size, mtime, folder_tag.as_deref()).await?;
        update_book(db, existing.id, &scanned).await?;
        return Ok(BookScanOutcome::Updated);
    }

    let scanned = read_scanned_book_file(path, file_path, size, mtime, folder_tag.as_deref()).await?;

    if let Some(existing) = moved_book_by_hash(db, &scanned.file_hash, &scanned.file_path).await? {
        update_book(db, existing.id, &scanned).await?;
        seen_paths.insert(scanned.file_path);
        return Ok(BookScanOutcome::Updated);
    }

    sqlx::query(
        r#"
        INSERT INTO books (title, file_path, file_hash, size, mtime, encoding, folder_tag)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(&scanned.title)
    .bind(&scanned.file_path)
    .bind(&scanned.file_hash)
    .bind(scanned.size)
    .bind(scanned.mtime)
    .bind(&scanned.encoding)
    .bind(&scanned.folder_tag)
    .execute(db)
    .await?;

    seen_paths.insert(scanned.file_path);
    Ok(BookScanOutcome::Added)
}

async fn read_scanned_book_file(
    path: &Path,
    file_path: String,
    size: i64,
    mtime: i64,
    folder_tag: Option<&str>,
) -> anyhow::Result<ScannedBookFile> {
    let bytes = read_all(path).await?;
    Ok(ScannedBookFile {
        title: title_from_path(path),
        file_path,
        file_hash: sha256_hex(&bytes),
        size,
        mtime,
        encoding: detect_encoding(&bytes).name().to_string(),
        folder_tag: folder_tag.map(|s| s.to_string()),
    })
}

async fn existing_book_by_path(
    db: &SqlitePool,
    file_path: &str,
) -> anyhow::Result<Option<ExistingBook>> {
    let row = sqlx::query("SELECT id, file_path, size, mtime FROM books WHERE file_path = ?1")
        .bind(file_path)
        .fetch_optional(db)
        .await?;

    Ok(row.map(existing_book_from_row).transpose()?)
}

async fn moved_book_by_hash(
    db: &SqlitePool,
    file_hash: &str,
    current_path: &str,
) -> anyhow::Result<Option<ExistingBook>> {
    let rows = sqlx::query(
        "SELECT id, file_path, size, mtime FROM books WHERE file_hash = ?1 AND file_path <> ?2",
    )
    .bind(file_hash)
    .bind(current_path)
    .fetch_all(db)
    .await?;

    for row in rows {
        let book = existing_book_from_row(row)?;
        if !Path::new(&book.file_path).exists() {
            return Ok(Some(book));
        }
    }

    Ok(None)
}

fn existing_book_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ExistingBook, sqlx::Error> {
    Ok(ExistingBook {
        id: row.try_get("id")?,
        file_path: row.try_get("file_path")?,
        size: row.try_get("size")?,
        mtime: row.try_get("mtime")?,
    })
}

async fn update_book(db: &SqlitePool, id: i64, scanned: &ScannedBookFile) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE books
        SET title = ?1,
            file_path = ?2,
            file_hash = ?3,
            size = ?4,
            mtime = ?5,
            encoding = ?6,
            folder_tag = ?7,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?8
        "#,
    )
    .bind(&scanned.title)
    .bind(&scanned.file_path)
    .bind(&scanned.file_hash)
    .bind(scanned.size)
    .bind(scanned.mtime)
    .bind(&scanned.encoding)
    .bind(&scanned.folder_tag)
    .bind(id)
    .execute(db)
    .await?;

    Ok(())
}

fn compute_folder_tag(file_path: &str, library_roots: &[PathBuf]) -> Option<String> {
    let path = Path::new(file_path);
    for root in library_roots {
        if let Ok(relative) = path.strip_prefix(root) {
            let mut components = relative.components();
            if let Some(first) = components.next() {
                if components.next().is_some() {
                    return Some(first.as_os_str().to_string_lossy().to_string());
                }
            }
            return None;
        }
    }
    None
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

pub async fn read_book_content(path: &str) -> anyhow::Result<(String, String)> {
    let bytes = read_all(Path::new(path)).await?;
    let encoding = detect_encoding(&bytes);
    let (text, _, _) = encoding.decode(&bytes);
    let simplified = zhconv(&text, Variant::ZhCN);
    Ok((simplified, encoding.name().to_string()))
}

async fn remove_missing_books(
    db: &SqlitePool,
    library_dirs: &[String],
    recursive: bool,
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

        if is_library_file(&path, &library_roots, recursive) && !seen_paths.contains(&file_path) {
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

fn is_library_file(path: &Path, roots: &[PathBuf], recursive: bool) -> bool {
    if recursive {
        is_txt_file(path) && roots.iter().any(|root| is_under_root(path, root))
    } else {
        is_top_level_library_file(path, roots)
    }
}

fn is_under_root(path: &Path, root: &Path) -> bool {
    if path.starts_with(root) {
        return true;
    }

    let path = path.to_string_lossy().to_lowercase();
    let mut root = root.to_string_lossy().to_lowercase();
    if !root.ends_with(std::path::MAIN_SEPARATOR) {
        root.push(std::path::MAIN_SEPARATOR);
    }
    path.starts_with(&root)
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

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::db::{connect_db, migrate};

    use super::*;

    #[tokio::test]
    async fn scan_skips_unchanged_files_and_removes_missing_books() {
        let fixture = TestFixture::new("scan-skip-remove").await;
        let book_path = fixture.library.join("Book.txt");
        fs::write(&book_path, "hello").await.unwrap();
        fs::create_dir_all(fixture.library.join("nested"))
            .await
            .unwrap();
        fs::write(
            fixture.library.join("nested").join("Ignored.txt"),
            "ignored",
        )
        .await
        .unwrap();

        let first = scan_library(&fixture.db, &[fixture.library_dir()], false)
            .await
            .unwrap();
        assert_eq!(first.scanned, 1);
        assert_eq!(first.added, 1);
        assert_eq!(first.updated, 0);
        assert_eq!(first.skipped, 0);
        assert!(first.errors.is_empty());

        let second = scan_library(&fixture.db, &[fixture.library_dir()], false)
            .await
            .unwrap();
        assert_eq!(second.scanned, 1);
        assert_eq!(second.added, 0);
        assert_eq!(second.skipped, 1);

        fs::remove_file(&book_path).await.unwrap();
        let third = scan_library(&fixture.db, &[fixture.library_dir()], false)
            .await
            .unwrap();
        assert_eq!(third.scanned, 0);
        assert_eq!(third.removed, 1);

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn recursive_scan_includes_nested_txt_files() {
        let fixture = TestFixture::new("scan-recursive").await;
        fs::create_dir_all(fixture.library.join("nested"))
            .await
            .unwrap();
        fs::write(fixture.library.join("nested").join("Book.txt"), "hello")
            .await
            .unwrap();

        let top_level = scan_library(&fixture.db, &[fixture.library_dir()], false)
            .await
            .unwrap();
        assert_eq!(top_level.scanned, 0);

        let recursive = scan_library(&fixture.db, &[fixture.library_dir()], true)
            .await
            .unwrap();
        assert_eq!(recursive.scanned, 1);
        assert_eq!(recursive.added, 1);

        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn moved_file_keeps_existing_book_and_progress() {
        let fixture = TestFixture::new("scan-move").await;
        let old_path = fixture.library.join("Old.txt");
        let new_path = fixture.library.join("New.txt");
        fs::write(&old_path, "same content").await.unwrap();

        scan_library(&fixture.db, &[fixture.library_dir()], false)
            .await
            .unwrap();
        let id: i64 = sqlx::query_scalar("SELECT id FROM books WHERE title = 'Old'")
            .fetch_one(&fixture.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO reading_progress (book_id, char_offset, percent) VALUES (?1, 4, 0.5)",
        )
        .bind(id)
        .execute(&fixture.db)
        .await
        .unwrap();

        fs::rename(&old_path, &new_path).await.unwrap();
        let result = scan_library(&fixture.db, &[fixture.library_dir()], false)
            .await
            .unwrap();
        assert_eq!(result.updated, 1);
        assert_eq!(result.removed, 0);

        let moved_id: i64 = sqlx::query_scalar("SELECT id FROM books WHERE title = 'New'")
            .fetch_one(&fixture.db)
            .await
            .unwrap();
        assert_eq!(id, moved_id);

        let char_offset: i64 =
            sqlx::query_scalar("SELECT char_offset FROM reading_progress WHERE book_id = ?1")
                .bind(id)
                .fetch_one(&fixture.db)
                .await
                .unwrap();
        assert_eq!(char_offset, 4);

        fixture.cleanup().await;
    }

    struct TestFixture {
        root: PathBuf,
        library: PathBuf,
        db: SqlitePool,
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
            let library = root.join("novels");
            fs::create_dir_all(&library).await.unwrap();
            let db_path = root.join("reader.sqlite");
            let db = connect_db(db_path.to_str().unwrap()).await.unwrap();
            migrate(&db).await.unwrap();

            Self { root, library, db }
        }

        fn library_dir(&self) -> String {
            self.library.to_string_lossy().to_string()
        }

        async fn cleanup(self) {
            self.db.close().await;
            let _ = fs::remove_dir_all(self.root).await;
        }
    }
}
