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

/// What a chat link or file reference names in a thread's workspace.
enum Reference {
    /// An openable file, relative to the workspace root.
    Found(String),
    /// A file that exists but lies outside the workspace.
    Outside,
    /// A relative path that more than one workspace file ends with.
    Ambiguous,
    Missing,
}

/// `path` without a trailing line location (`#L10`, `#L10-L20`, `#L10C2`, `:10`, `:10:5`), and the line it named.
pub fn split_location(path: &str) -> (&str, Option<u32>) {
    fn digits(text: &str) -> Option<u32> {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())).then(|| text.parse().ok()).flatten()
    }
    // `10`, `10C2`, `10-L20`, `10-20C3`: a line, then an optional column, then an optional end line.
    fn fragment(text: &str) -> Option<u32> {
        let (start, end) = match text.split_once('-') {
            Some((start, end)) => (start, Some(end.strip_prefix('L').unwrap_or(end))),
            None => (text, None),
        };
        let line =
            |part: &str| digits(part.split_once('C').map_or(part, |(line, column)| if digits(column).is_some() { line } else { "" }));
        let first = line(start)?;
        end.is_none_or(|end| line(end).is_some()).then_some(first)
    }
    if let Some(at) = path.rfind("#L")
        && let Some(line) = fragment(&path[at + 2..])
    {
        return (&path[..at], Some(line));
    }
    if let Some((rest, last)) = path.rsplit_once(':')
        && let Some(line) = digits(last)
    {
        // `file:10:5` names a column too.
        if let Some((file, middle)) = rest.rsplit_once(':')
            && let Some(line) = digits(middle)
        {
            return (file, Some(line));
        }
        return (rest, Some(line));
    }
    (path, None)
}

/// Resolve one reference against the workspace root. The root is the only base: a link is written for the reader of the
/// conversation, and the folder the agent's shell happened to be in (`cd apps/gpuix/src` in a turn) is not recorded
/// anywhere the daemon can see. A path that does not exist from the root still opens when exactly one workspace file ends
/// with it, which is how an agent's `sidebar/rows.tsx` (written from its shell folder) finds `apps/gpuix/src/sidebar/rows.tsx`.
async fn resolve_reference(
    indexes: &FileIndexCache,
    cwd: &Path,
    root: &Path,
    index: &mut Option<Arc<Vec<String>>>,
    path: &str,
) -> Result<Reference> {
    let path = path.trim();
    if path.is_empty() || path.contains(['\0', '\\']) {
        return Ok(Reference::Missing);
    }
    // A file really named `a:1` or `a#L1` wins over the location reading.
    let (clean, _) = split_location(path);
    for candidate in [path, clean] {
        if candidate.is_empty() {
            continue;
        }
        if let Some(found) = existing_file(root, candidate).await {
            return Ok(Reference::Found(found));
        }
        if let Ok(canon) = tokio::fs::canonicalize(root.join(candidate)).await
            && canon.is_file()
            && !canon.starts_with(root)
        {
            return Ok(Reference::Outside);
        }
    }
    if clean.is_empty() || clean.starts_with('/') {
        return Ok(Reference::Missing);
    }
    if index.is_none() {
        *index = Some(indexes.list(cwd).await?);
    }
    let name = clean.trim_start_matches("./");
    let suffix = format!("/{name}");
    let mut matches = index.as_ref().unwrap().iter().filter(|file| *file == name || file.ends_with(&suffix));
    Ok(match (matches.next(), matches.next()) {
        (Some(only), None) if resolve(root, only).is_ok_and(|path| path.is_file()) => Reference::Found(only.clone()),
        (Some(_), Some(_)) => Reference::Ambiguous,
        _ => Reference::Missing,
    })
}

/// Resolve chat links against the thread's workspace root (its worktree, when it has one). Canonical containment also
/// rejects symlinks escaping the workspace; the existing file browser policy still applies. `source` may carry a
/// `#L10` or `:10` location, which only the client uses.
pub async fn read_thread_file(
    indexes: &FileIndexCache,
    cwd: &Path,
    source: &str,
    max_bytes: u64,
) -> Result<kybern_protocol::methods::FilesReadResult> {
    let root = tokio::fs::canonicalize(cwd).await?;
    match resolve_reference(indexes, cwd, &root, &mut None, source).await? {
        Reference::Found(relative) => read_file(&root, &relative, max_bytes.clamp(1, 1024 * 1024)).await,
        Reference::Outside => {
            Err(anyhow::anyhow!("This file is outside the conversation's workspace. Ask the agent to copy it into the workspace."))
        }
        Reference::Ambiguous => Err(anyhow::anyhow!("Several files match this path. Ask the agent for the path from the workspace root.")),
        Reference::Missing => Err(anyhow::anyhow!("File not found. Check the path or ask the agent to recreate it.")),
    }
}

/// Most paths one `threads.files.resolve` call may ask about.
pub const MAX_RESOLVE_PATHS: usize = 200;

/// Which of an answer's file references name a file `read_thread_file` can
/// open, as paths relative to the thread cwd. A path that exists under the cwd
/// (or an absolute one inside it) resolves to itself; otherwise a relative
/// path or bare file name resolves when exactly one indexed file ends with it.
pub async fn resolve_thread_files(indexes: &FileIndexCache, cwd: &Path, paths: &[String]) -> Result<Vec<Option<String>>> {
    let root = tokio::fs::canonicalize(cwd).await?;
    let mut index = None;
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(match resolve_reference(indexes, cwd, &root, &mut index, path).await? {
            Reference::Found(found) => Some(found),
            _ => None,
        });
    }
    Ok(out)
}

/// `path` under `root` (canonical) when it is an openable file inside it.
async fn existing_file(root: &Path, path: &str) -> Option<String> {
    let canon = tokio::fs::canonicalize(root.join(path)).await.ok()?;
    let relative = canon.strip_prefix(root).ok()?.to_string_lossy().into_owned();
    (canon.is_file() && resolve(root, &relative).is_ok()).then_some(relative)
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

    use super::{CachedIndex, FileIndexCache, MAX_INDEX_SLOTS, rank, read_thread_file, resolve_thread_files, split_location};

    #[tokio::test]
    async fn resolves_answer_file_references_against_the_workspace() {
        let base = std::env::temp_dir().join(format!("kybern-resolve-test-{}", uuid::Uuid::new_v4()));
        let dir = &base.join("workspace");
        for file in
            ["src/dashboard/UnlockPremium.tsx", "src/server/email/templates.ts", "a/index.ts", "b/index.ts", ".env", "docs/My File.md"]
        {
            std::fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
            std::fs::write(dir.join(file), "x").unwrap();
        }
        std::fs::create_dir_all(dir.join("panduan")).unwrap();
        std::fs::write(base.join("secret.ts"), "x").unwrap();
        let canonical = std::fs::canonicalize(dir).unwrap();
        let paths = [
            "src/dashboard/UnlockPremium.tsx",
            "UnlockPremium.tsx",
            "email/templates.ts",
            "index.ts",
            "/panduan",
            "/api/health",
            "panduan",
            ".env",
            "docs/My File.md",
            &canonical.join("src/server/email/templates.ts").to_string_lossy(),
            &base.join("secret.ts").to_string_lossy(),
            "../secret.ts",
            "test.everlace.cc",
        ]
        .map(String::from);
        let resolved = resolve_thread_files(&FileIndexCache::default(), dir, &paths).await.unwrap();
        assert_eq!(
            resolved,
            [
                Some("src/dashboard/UnlockPremium.tsx"),
                Some("src/dashboard/UnlockPremium.tsx"),
                Some("src/server/email/templates.ts"),
                None,
                None,
                None,
                None,
                None,
                Some("docs/My File.md"),
                Some("src/server/email/templates.ts"),
                None,
                None,
                None,
            ]
            .map(|path| path.map(String::from))
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn splits_line_locations_off_a_path() {
        for (path, expected) in [
            ("apps/gpuix/src/sidebar/rows.tsx#L390", ("apps/gpuix/src/sidebar/rows.tsx", Some(390))),
            ("rows.tsx#L10-L20", ("rows.tsx", Some(10))),
            ("rows.tsx#L10-20", ("rows.tsx", Some(10))),
            ("rows.tsx#L10C4-L12C2", ("rows.tsx", Some(10))),
            ("src/a.rs:42", ("src/a.rs", Some(42))),
            ("src/a.rs:42:7", ("src/a.rs", Some(42))),
            ("src/a.rs", ("src/a.rs", None)),
            ("src/a.rs#readme", ("src/a.rs#readme", None)),
            ("src/a.rs#L", ("src/a.rs#L", None)),
            ("src/a.rs#L1x", ("src/a.rs#L1x", None)),
            ("src/a.rs:", ("src/a.rs:", None)),
        ] {
            assert_eq!(split_location(path), expected, "{path}");
        }
    }

    /// ADE-66: the agent had `cd`'d into `apps/gpuix/src` and wrote its links from there.
    #[tokio::test]
    async fn opens_links_from_the_workspace_root_whatever_folder_the_agent_was_in() {
        let base = std::env::temp_dir().join(format!("kybern-thread-file-test-{}", uuid::Uuid::new_v4()));
        let dir = &base.join("workspace");
        for file in ["apps/gpuix/src/sidebar/rows.tsx", "apps/gpuix/src/ui.tsx", "crates/x/src/ui.tsx", "weird:3.txt"] {
            std::fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
            std::fs::write(dir.join(file), format!("// {file}")).unwrap();
        }
        std::fs::write(base.join("outside.png"), "x").unwrap();
        let indexes = FileIndexCache::default();
        let read = |source: String| {
            let indexes = indexes.clone();
            async move { read_thread_file(&indexes, dir, &source, 1024).await.map(|file| file.content).map_err(|e| e.to_string()) }
        };
        let rows = "// apps/gpuix/src/sidebar/rows.tsx";
        // From the root, with and without a location.
        assert_eq!(read("apps/gpuix/src/sidebar/rows.tsx".into()).await.as_deref(), Ok(rows));
        assert_eq!(read("apps/gpuix/src/sidebar/rows.tsx#L390".into()).await.as_deref(), Ok(rows));
        assert_eq!(read("apps/gpuix/src/sidebar/rows.tsx:390:2".into()).await.as_deref(), Ok(rows));
        assert_eq!(read("./apps/gpuix/src/sidebar/rows.tsx#L3-L9".into()).await.as_deref(), Ok(rows));
        // Absolute, inside the workspace.
        let absolute = std::fs::canonicalize(dir).unwrap().join("apps/gpuix/src/sidebar/rows.tsx");
        assert_eq!(read(format!("{}#L1", absolute.display())).await.as_deref(), Ok(rows));
        // Written from the shell's folder: the only file that ends with it.
        assert_eq!(read("sidebar/rows.tsx#L390".into()).await.as_deref(), Ok(rows));
        // Two files end with it: say so instead of guessing.
        assert!(read("src/ui.tsx".into()).await.unwrap_err().starts_with("Several files match"));
        assert_eq!(read("gpuix/src/ui.tsx".into()).await.as_deref(), Ok("// apps/gpuix/src/ui.tsx"));
        // A file whose name contains a location-like suffix still opens as itself.
        assert_eq!(read("weird:3.txt".into()).await.as_deref(), Ok("// weird:3.txt"));
        // Missing and outside answer differently, and a relative escape stays refused.
        assert!(read("sidebar/missing.tsx#L1".into()).await.unwrap_err().starts_with("File not found"));
        assert!(read(base.join("outside.png").display().to_string()).await.unwrap_err().contains("outside the conversation's workspace"));
        assert!(read("../outside.png".into()).await.unwrap_err().contains("outside the conversation's workspace"));
        std::fs::remove_dir_all(&base).unwrap();
    }

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
