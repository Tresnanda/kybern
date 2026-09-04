//! Project file listing for @mentions: `git ls-files` where there is a
//! repository (so ignores apply), a bounded walk otherwise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;

const MAX_FILES: usize = 20_000;
const INDEX_CACHE_TTL: Duration = Duration::from_secs(3);
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".cache"];

struct CachedIndex {
    loaded_at: Instant,
    files: Arc<Vec<String>>,
}

type IndexSlot = Arc<tokio::sync::Mutex<Option<CachedIndex>>>;

fn index_slots() -> &'static tokio::sync::Mutex<HashMap<PathBuf, IndexSlot>> {
    static SLOTS: OnceLock<tokio::sync::Mutex<HashMap<PathBuf, IndexSlot>>> = OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// Relative paths of files under `root`.
pub async fn list(root: &Path) -> Result<Arc<Vec<String>>> {
    let slot = {
        let mut slots = index_slots().lock().await;
        slots.entry(root.to_path_buf()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None))).clone()
    };
    let mut cached = slot.lock().await;
    if let Some(index) = cached.as_ref()
        && index.loaded_at.elapsed() < INDEX_CACHE_TTL
    {
        return Ok(Arc::clone(&index.files));
    }

    let files = Arc::new(list_uncached(root).await?);
    *cached = Some(CachedIndex { loaded_at: Instant::now(), files: Arc::clone(&files) });
    Ok(files)
}

async fn list_uncached(root: &Path) -> Result<Vec<String>> {
    let git = tokio::process::Command::new("git")
        .args(["-C"])
        .arg(root)
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .output()
        .await;
    if let Ok(out) = git
        && out.status.success()
    {
        let mut files: Vec<String> =
            out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).to_string()).collect();
        files.truncate(MAX_FILES);
        return Ok(files);
    }
    let root = root.to_path_buf();
    let files = tokio::task::spawn_blocking(move || walk(&root)).await?;
    Ok(files)
}

fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

/// Score paths against a query: file-name prefix, then file-name contains,
/// then a subsequence match on the whole path. Shorter paths win ties.
pub fn rank(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let query = query.trim().to_ascii_lowercase();
    let mut scored: Vec<(u32, usize, &str)> = files
        .iter()
        .filter_map(|path| {
            let lower = path.to_ascii_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
            let score = if query.is_empty() {
                1
            } else if name.starts_with(&query) {
                4
            } else if name.contains(&query) {
                3
            } else if lower.contains(&query) {
                2
            } else if is_subsequence(&query, &lower) {
                1
            } else {
                return None;
            };
            Some((score, path.len(), path.as_str()))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(b.2)));
    scored.into_iter().take(limit).map(|(_, _, path)| path.to_string()).collect()
}

/// Resolve `rel` under `root`, refusing anything that escapes the project.
fn resolve(root: &Path, rel: &str) -> Result<std::path::PathBuf> {
    let rel = rel.trim_matches('/');
    let mut path = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        if part == ".." || part == "." || part.contains('\\') {
            anyhow::bail!("path must stay inside the project");
        }
        if (part.starts_with('.') && !HIDDEN_ALLOWED.contains(&part)) || SKIP_DIRS.contains(&part) {
            anyhow::bail!("hidden or generated folders are not browsable: {part}");
        }
        path.push(part);
    }
    let canon_root = std::fs::canonicalize(root)?;
    let canon = std::fs::canonicalize(&path).map_err(|_| anyhow::anyhow!("no such path: {rel}"))?;
    if !canon.starts_with(&canon_root) {
        anyhow::bail!("path must stay inside the project");
    }
    Ok(path)
}

const HIDDEN_ALLOWED: &[&str] = &[".github", ".claude", ".env.example", ".gitignore", ".editorconfig", ".npmrc", ".nvmrc"];

/// One level of a project directory: directories first, then files, by name.
pub async fn list_dir(root: &Path, rel: &str) -> Result<Vec<kybern_protocol::methods::FileEntry>> {
    use kybern_protocol::methods::{FileEntry, FileEntryKind};
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        anyhow::bail!("not a directory: {rel}");
    }
    let rel = rel.trim_matches('/').to_string();
    let entries = tokio::task::spawn_blocking(move || -> Result<Vec<FileEntry>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && !HIDDEN_ALLOWED.contains(&name.as_str()) {
                continue;
            }
            let meta = entry.metadata()?;
            let is_dir = meta.is_dir();
            if is_dir && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            out.push(FileEntry {
                name,
                path,
                kind: if is_dir { FileEntryKind::Directory } else { FileEntryKind::File },
                size: if is_dir { None } else { Some(meta.len()) },
            });
        }
        out.sort_by(|a, b| {
            let da = a.kind == FileEntryKind::Directory;
            let db = b.kind == FileEntryKind::Directory;
            db.cmp(&da).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    })
    .await??;
    Ok(entries)
}

/// Read up to `max_bytes` of a project file; binary files return no content.
pub async fn read_file(root: &Path, rel: &str, max_bytes: u64) -> Result<kybern_protocol::methods::FilesReadResult> {
    use std::io::Read;
    let path = resolve(root, rel)?;
    if !path.is_file() {
        anyhow::bail!("not a file: {rel}");
    }
    tokio::task::spawn_blocking(move || -> Result<kybern_protocol::methods::FilesReadResult> {
        let size = std::fs::metadata(&path)?.len();
        let mut file = std::fs::File::open(&path)?;
        let mut buf = Vec::with_capacity(size.min(max_bytes) as usize);
        file.by_ref().take(max_bytes).read_to_end(&mut buf)?;
        let probe = &buf[..buf.len().min(8192)];
        let binary = probe.contains(&0);
        Ok(kybern_protocol::methods::FilesReadResult {
            content: if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() },
            truncated: size > max_bytes,
            binary,
            size,
        })
    })
    .await?
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = needle.chars();
    let mut current = chars.next();
    for c in haystack.chars() {
        if Some(c) == current {
            current = chars.next();
            if current.is_none() {
                return true;
            }
        }
    }
    current.is_none()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::rank;

    #[test]
    fn ranks_file_name_matches_first() {
        let files = vec!["src/views/sidebar.rs".into(), "docs/side-notes.md".into(), "src/app.rs".into(), "README.md".into()];
        let ranked = rank(&files, "side", 10);
        assert_eq!(ranked, vec!["docs/side-notes.md", "src/views/sidebar.rs"]);
    }

    #[test]
    fn subsequence_matches_paths() {
        let files = vec!["crates/kybern-app/src/views/composer.rs".into(), "Cargo.toml".into()];
        let ranked = rank(&files, "kacomp", 10);
        assert_eq!(ranked, vec!["crates/kybern-app/src/views/composer.rs"]);
    }

    #[test]
    fn empty_query_keeps_short_paths_first() {
        let files = vec!["src/very/deep/file.rs".into(), "a.rs".into()];
        assert_eq!(rank(&files, "", 10), vec!["a.rs", "src/very/deep/file.rs"]);
    }

    #[tokio::test]
    async fn reuses_a_recent_project_file_index() {
        let dir = std::env::temp_dir().join(format!("kybern-file-cache-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("one.txt"), "one").unwrap();
        let first = super::list(&dir).await.unwrap();
        let second = super::list(&dir).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
