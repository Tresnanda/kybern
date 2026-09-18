//! Project file listing for @mentions: `git ls-files` where there is a
//! repository (so ignores apply), a bounded walk otherwise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;

const MAX_FILES: usize = 20_000;
const MAX_INDEX_SLOTS: usize = 8;
const INDEX_CACHE_TTL: Duration = Duration::from_secs(3);
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".cache"];

struct CachedIndex {
    loaded_at: Instant,
    files: Arc<Vec<String>>,
}

type IndexSlot = Arc<tokio::sync::Mutex<Option<CachedIndex>>>;

struct SlotEntry {
    last_used: Instant,
    slot: IndexSlot,
}

/// Short-lived file indexes shared by composer searches.
///
/// The path map and the cached indexes are both bounded. Each index also drops
/// its file list after the TTL without needing another search to trigger
/// cleanup, so a one-off search of a large repository does not set the
/// daemon's idle memory floor.
#[derive(Clone, Default)]
pub struct FileIndexCache {
    slots: Arc<tokio::sync::Mutex<HashMap<PathBuf, SlotEntry>>>,
}

impl FileIndexCache {
    async fn slot(&self, root: &Path) -> IndexSlot {
        let now = Instant::now();
        let mut slots = self.slots.lock().await;
        slots.retain(|_, entry| now.duration_since(entry.last_used) < INDEX_CACHE_TTL || Arc::strong_count(&entry.slot) > 1);
        if let Some(entry) = slots.get_mut(root) {
            entry.last_used = now;
            return Arc::clone(&entry.slot);
        }
        if slots.len() >= MAX_INDEX_SLOTS
            && let Some(oldest) = slots.iter().min_by_key(|(_, entry)| entry.last_used).map(|(path, _)| path.clone())
        {
            slots.remove(&oldest);
        }
        let slot = Arc::new(tokio::sync::Mutex::new(None));
        slots.insert(root.to_path_buf(), SlotEntry { last_used: now, slot: Arc::clone(&slot) });
        slot
    }

    /// Relative paths of files under `root`.
    pub async fn list(&self, root: &Path) -> Result<Arc<Vec<String>>> {
        let slot = self.slot(root).await;
        let mut cached = slot.lock().await;
        if let Some(index) = cached.as_ref()
            && index.loaded_at.elapsed() < INDEX_CACHE_TTL
        {
            return Ok(Arc::clone(&index.files));
        }

        let files = Arc::new(list_uncached(root).await?);
        let loaded_at = Instant::now();
        *cached = Some(CachedIndex { loaded_at, files: Arc::clone(&files) });
        drop(cached);

        // Expire the payload even if this repository is never searched again.
        // A later refresh changes `loaded_at`, so an older cleanup task cannot
        // discard the newer index.
        // Do not keep an LRU-evicted slot alive until the timer fires.
        let expiring = Arc::downgrade(&slot);
        tokio::spawn(async move {
            tokio::time::sleep(INDEX_CACHE_TTL).await;
            if let Some(slot) = expiring.upgrade() {
                Self::expire(&slot, loaded_at).await;
            }
        });
        Ok(files)
    }

    async fn expire(slot: &IndexSlot, loaded_at: Instant) {
        let mut cached = slot.lock().await;
        if cached.as_ref().is_some_and(|index| index.loaded_at == loaded_at) {
            *cached = None;
        }
    }
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

/// Resolve chat links against the thread cwd. Canonical containment also rejects
/// symlinks escaping the workspace; the existing file browser policy still applies.
pub async fn read_thread_file(root: &Path, source: &str, max_bytes: u64) -> Result<kybern_protocol::methods::FilesReadResult> {
    let root = tokio::fs::canonicalize(root).await?;
    let candidate = root.join(source);
    let path = tokio::fs::canonicalize(candidate)
        .await
        .map_err(|_| anyhow::anyhow!("File not found. Check the path or ask the agent to recreate it."))?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| anyhow::anyhow!("This file is outside the conversation's workspace. Ask the agent to copy it into the workspace."))?;
    read_file(&root, &relative.to_string_lossy(), max_bytes.clamp(1, 1024 * 1024)).await
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

/// Browse on the host that will execute the project, including directories
/// outside existing projects. No shell expansion or subprocess is involved.
pub async fn browse_directories(path: Option<String>) -> anyhow::Result<kybern_protocol::methods::ProjectsBrowseResult> {
    use kybern_protocol::methods::{ProjectDirectory, ProjectsBrowseResult};
    let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_owned());
    let root = match path.as_deref().filter(|value| !value.is_empty()) {
        None | Some("~") => home.clone().ok_or_else(|| anyhow::anyhow!("Enter an absolute directory path"))?,
        Some(value) if value.starts_with("~/") => home.ok_or_else(|| anyhow::anyhow!("Home directory is unavailable"))?.join(&value[2..]),
        Some(value) => std::path::PathBuf::from(value),
    };
    anyhow::ensure!(root.is_absolute(), "Enter an absolute directory path on this environment");
    let root = tokio::fs::canonicalize(root).await?;
    let mut reader = tokio::fs::read_dir(&root).await?;
    let mut directories = Vec::new();
    let mut has_more = false;
    while let Some(entry) = reader.next_entry().await? {
        let kind = entry.file_type().await?;
        if kind.is_dir() || (kind.is_symlink() && tokio::fs::metadata(entry.path()).await.is_ok_and(|metadata| metadata.is_dir())) {
            if directories.len() >= 1000 {
                has_more = true;
                break;
            }
            directories
                .push(ProjectDirectory { name: entry.file_name().to_string_lossy().into(), path: entry.path().to_string_lossy().into() });
        }
    }
    directories.sort_by_key(|directory| directory.name.to_lowercase());
    Ok(ProjectsBrowseResult {
        path: root.to_string_lossy().into(),
        parent: root.parent().map(|path| path.to_string_lossy().into()),
        directories,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{CachedIndex, FileIndexCache, MAX_INDEX_SLOTS, rank};

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
        let cache = FileIndexCache::default();
        let first = cache.list(&dir).await.unwrap();
        let second = cache.list(&dir).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn bounds_project_file_index_slots() {
        let cache = FileIndexCache::default();
        for index in 0..MAX_INDEX_SLOTS + 3 {
            cache.slot(std::path::Path::new(&format!("/project-{index}"))).await;
        }
        assert_eq!(cache.slots.lock().await.len(), MAX_INDEX_SLOTS);
    }

    #[tokio::test]
    async fn expiry_timer_does_not_retain_an_evicted_slot() {
        let root = std::env::temp_dir().join(format!("kybern-index-eviction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("one.txt"), "one").unwrap();
        let cache = FileIndexCache::default();
        let files = cache.list(&root).await.unwrap();
        let evicted = Arc::downgrade(&cache.slot(&root).await);
        for index in 0..MAX_INDEX_SLOTS {
            cache.slot(std::path::Path::new(&format!("/other-project-{index}"))).await;
        }
        assert!(evicted.upgrade().is_none(), "expiry task must not retain the evicted index");
        assert_eq!(files.as_slice(), ["one.txt"], "active callers retain their shared result");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn keeps_an_in_flight_index_slot_past_the_ttl() {
        let cache = FileIndexCache::default();
        let root = std::path::Path::new("/slow-project");
        let in_flight = cache.slot(root).await;
        cache.slots.lock().await.get_mut(root).unwrap().last_used = std::time::Instant::now() - super::INDEX_CACHE_TTL;
        let reused = cache.slot(root).await;
        assert!(Arc::ptr_eq(&in_flight, &reused));
    }

    #[tokio::test]
    async fn expiry_releases_only_the_matching_file_index() {
        let cache = FileIndexCache::default();
        let slot = cache.slot(std::path::Path::new("/project")).await;
        let first_at = std::time::Instant::now();
        *slot.lock().await = Some(CachedIndex { loaded_at: first_at, files: Arc::new(vec!["large/file.txt".into()]) });
        FileIndexCache::expire(&slot, first_at).await;
        assert!(slot.lock().await.is_none());

        let newer_at = std::time::Instant::now();
        *slot.lock().await = Some(CachedIndex { loaded_at: newer_at, files: Arc::new(vec!["new/file.txt".into()]) });
        FileIndexCache::expire(&slot, first_at).await;
        assert_eq!(slot.lock().await.as_ref().unwrap().files[0], "new/file.txt");
    }
}
