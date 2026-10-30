//! Project file listing for @mentions: `git ls-files` where there is a
//! repository (so ignores apply), a bounded walk otherwise.

use kybern_protocol::process::NoWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;

pub(crate) const MAX_FILES: usize = 20_000;
const MAX_INDEX_SLOTS: usize = 8;
const INDEX_CACHE_TTL: Duration = Duration::from_secs(3);
pub(crate) const SKIP_DIRS: &[&str] =
    &[".git", "node_modules", "target", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".cache"];

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
    if let Some(mut files) = git_files(root).await {
        // A repository folder that holds other repositories (a group folder that
        // is itself a member) lists each nested one as `name/`: list its files too.
        let nested: Vec<String> =
            files.iter().filter(|f| f.ends_with('/') && root.join(f.trim_end_matches('/')).join(".git").exists()).cloned().collect();
        files.retain(|f| !f.ends_with('/'));
        for repo in nested {
            add_nested(&mut files, root, repo.trim_end_matches('/')).await;
        }
        files.truncate(MAX_FILES);
        return Ok(files);
    }
    let walk_root = root.to_path_buf();
    let (mut files, repos) = tokio::task::spawn_blocking(move || walk(&walk_root)).await?;
    // A folder of repositories (a group project): each one's own ignores apply.
    for repo in repos {
        if files.len() >= MAX_FILES {
            break;
        }
        add_nested(&mut files, root, &repo).await;
    }
    files.sort();
    files.truncate(MAX_FILES);
    Ok(files)
}

/// `git ls-files` of a repository, or `None` when `dir` is not one.
async fn git_files(dir: &Path) -> Option<Vec<String>> {
    let out = tokio::process::Command::new("git")
        .no_window()
        .args(["-C"])
        .arg(dir)
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .output()
        .await
        .ok()?;
    out.status
        .success()
        .then(|| out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).to_string()).collect())
}

/// Add the files of the repository at `rel` (a '/'-separated path under `root`), prefixed.
async fn add_nested(files: &mut Vec<String>, root: &Path, rel: &str) {
    let dir = rel.split('/').fold(root.to_path_buf(), |dir, part| dir.join(part));
    let Some(nested) = git_files(&dir).await else { return };
    let room = MAX_FILES.saturating_sub(files.len());
    files.extend(nested.into_iter().filter(|f| !f.ends_with('/')).take(room).map(|f| format!("{rel}/{f}")));
}

/// Files under a folder that is not a repository, and the repositories inside
/// it ('/'-separated, relative), which are listed with git instead of walked.
fn walk(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut out = Vec::new();
    let mut repos = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                if path.join(".git").exists()
                    && let Ok(rel) = path.strip_prefix(root)
                {
                    repos.push(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
                } else {
                    stack.push(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(relative_wire_path(rel));
                if out.len() >= MAX_FILES {
                    return (out, repos);
                }
            }
        }
    }
    out.sort();
    repos.sort();
    (out, repos)
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

fn relative_wire_path(path: &Path) -> String {
    path.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Resolve a file or folder someone named: a file tab, a chat link, an agent's
/// read. Anything inside the project opens, dot-folders such as
/// `.kybern-artifacts/` and `.screenshots/` and generated folders included,
/// except what [`refusal`] keeps closed. The canonical path must stay inside
/// the canonical root and pass the same check, so a symlink cannot reach
/// `.git` or `.env` either. Listing a folder still hides dotfiles and
/// generated folders (`list_dir`); that is browsing, not naming.
fn resolve(root: &Path, rel: &str) -> Result<std::path::PathBuf> {
    let rel = rel.trim_matches('/');
    let mut path = root.to_path_buf();
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    for part in &parts {
        if *part == ".." || *part == "." || part.contains('\\') {
            anyhow::bail!("Use the path from the workspace root, without `.`, `..` or backslashes.");
        }
        path.push(part);
    }
    if let Some(reason) = refusal(&parts) {
        anyhow::bail!(reason);
    }
    let canon_root = std::fs::canonicalize(root)?;
    let canon = std::fs::canonicalize(&path)
        .map_err(|_| anyhow::anyhow!("{rel} does not exist. Check the path or ask the agent to recreate it."))?;
    let real = canon.strip_prefix(&canon_root).map_err(|_| anyhow::anyhow!(OUTSIDE))?;
    let real: Vec<String> = real.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
    if let Some(reason) = refusal(&real.iter().map(String::as_str).collect::<Vec<_>>()) {
        anyhow::bail!(reason);
    }
    Ok(path)
}

const OUTSIDE: &str = "This path leads outside the project. Use a path inside the workspace.";

/// Folders that hold credentials rather than project files.
pub(crate) const CREDENTIAL_DIRS: &[&str] = &[".ssh", ".gnupg", ".aws"];

/// Why Kybern will not open the file or folder at `parts` (relative to the
/// project root), whoever names it: the repository's own `.git`, credential
/// folders, and env files. `.env.example` and similar templates are meant to
/// be shared and stay open.
pub(crate) fn refusal(parts: &[&str]) -> Option<String> {
    for part in parts {
        let lower = part.to_ascii_lowercase();
        if lower == ".git" {
            return Some("Kybern doesn't open files inside .git. Use git in a terminal to inspect the repository.".into());
        }
        if CREDENTIAL_DIRS.contains(&lower.as_str()) {
            return Some(format!("{part} holds credentials, so Kybern doesn't open it. Open it in your own editor if you need it."));
        }
    }
    let name = parts.last()?;
    let lower = name.to_ascii_lowercase();
    let template = [".example", ".sample", ".template"].iter().any(|suffix| lower.ends_with(suffix));
    ((lower.starts_with(".env") || lower.ends_with(".env")) && !template).then(|| {
        format!("{name} may hold secrets, so Kybern doesn't open it. Open it in your own editor, or ask the agent for the variable names instead.")
    })
}

/// Generated output, which Kybern opens but does not save into.
fn generated_folder<'a>(parts: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    parts.into_iter().find(|part| *part != ".git" && SKIP_DIRS.contains(part))
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
    /// A file inside the workspace that Kybern keeps closed, and why.
    Refused(String),
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
    if path.is_empty() || path.contains('\0') || (cfg!(unix) && path.contains('\\')) {
        return Ok(Reference::Missing);
    }
    // A file really named `a:1` or `a#L1` wins over the location reading.
    let (clean, _) = split_location(path);
    for candidate in [path, clean] {
        if candidate.is_empty() {
            continue;
        }
        match existing_file(root, candidate).await {
            Some(Ok(found)) => return Ok(Reference::Found(found)),
            Some(Err(reason)) => return Ok(Reference::Refused(reason)),
            None => {}
        }
        if let Ok(canon) = tokio::fs::canonicalize(root.join(candidate)).await
            && canon.is_file()
            && !canon.starts_with(root)
        {
            return Ok(Reference::Outside);
        }
    }
    if clean.is_empty() || Path::new(clean).is_absolute() {
        return Ok(Reference::Missing);
    }
    if index.is_none() {
        *index = Some(indexes.list(cwd).await?);
    }
    let normalized = if cfg!(windows) { clean.replace('\\', "/") } else { clean.into() };
    let name = normalized.trim_start_matches("./");
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
    if_version: Option<&str>,
) -> Result<kybern_protocol::methods::FilesReadResult> {
    let root = tokio::fs::canonicalize(cwd).await?;
    match resolve_reference(indexes, cwd, &root, &mut None, source).await? {
        Reference::Found(relative) => read_file(&root, &relative, max_bytes.clamp(1, MAX_WRITE_BYTES as u64), if_version).await,
        Reference::Outside => {
            Err(anyhow::anyhow!("This file is outside the conversation's workspace. Ask the agent to copy it into the workspace."))
        }
        Reference::Refused(reason) => Err(anyhow::anyhow!(reason)),
        Reference::Ambiguous => Err(anyhow::anyhow!("Several files match this path. Ask the agent for the path from the workspace root.")),
        Reference::Missing => Err(anyhow::anyhow!("File not found. Check the path or ask the agent to recreate it.")),
    }
}

/// `source` (relative to the thread cwd or absolute inside it) as a path
/// relative to the canonical cwd. Canonical containment rejects symlinks that
/// escape the workspace. Writes use this exact form only: a tab saves the root-relative
/// path `threads.files.resolve` gave it, never a suffix match.
async fn thread_relative(root: &Path, source: &str) -> Result<(std::path::PathBuf, String)> {
    let root = tokio::fs::canonicalize(root).await?;
    let candidate = root.join(source);
    let path = tokio::fs::canonicalize(candidate)
        .await
        .map_err(|_| anyhow::anyhow!("File not found. Check the path or ask the agent to recreate it."))?;
    let relative =
        relative_wire_path(path.strip_prefix(&root).map_err(|_| {
            anyhow::anyhow!("This file is outside the conversation's workspace. Ask the agent to copy it into the workspace.")
        })?);
    Ok((root, relative))
}

/// Save an existing file of a conversation workspace; see `write_file`.
pub async fn write_thread_file(
    root: &Path,
    source: &str,
    content: String,
    expected_version: Option<&str>,
) -> Result<kybern_protocol::methods::FilesWriteResult> {
    let (root, relative) = thread_relative(root, source).await?;
    write_file(&root, &relative, content, expected_version).await
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

/// `path` under `root` (canonical) when it is a file inside it: its relative
/// path when it opens, or why it is refused.
async fn existing_file(root: &Path, path: &str) -> Option<Result<String, String>> {
    let canon = tokio::fs::canonicalize(root.join(path)).await.ok()?;
    let relative = relative_wire_path(canon.strip_prefix(root).ok()?);
    canon.is_file().then(|| resolve(root, &relative).map(|_| relative).map_err(|error| error.to_string()))
}

/// Largest file a client may save (the editor's syntax limit).
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;

/// An opaque on-disk version: modification time (ns), size and, on Unix, the inode and change time. Cheap to read. Timestamps
/// can be coarse (a same-length save within one clock tick keeps both), so the inode is what makes an atomic replace always
/// change it, and the change time catches in-place writes that restore the old modification time.
fn file_version(meta: &std::fs::Metadata) -> String {
    let modified =
        meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{modified:x}-{:x}-{:x}-{:x}.{:x}", meta.len(), meta.ino(), meta.ctime(), meta.ctime_nsec())
    }
    #[cfg(not(unix))]
    format!("{modified:x}-{:x}", meta.len())
}

/// Read up to `max_bytes` of a project file; binary files return no content.
/// When the file's version still equals `if_version`, nothing is read.
pub async fn read_file(
    root: &Path,
    rel: &str,
    max_bytes: u64,
    if_version: Option<&str>,
) -> Result<kybern_protocol::methods::FilesReadResult> {
    use std::io::Read;
    let path = resolve(root, rel)?;
    if !path.is_file() {
        anyhow::bail!("not a file: {rel}");
    }
    let if_version = if_version.map(str::to_owned);
    tokio::task::spawn_blocking(move || -> Result<kybern_protocol::methods::FilesReadResult> {
        let meta = std::fs::metadata(&path)?;
        let size = meta.len();
        let version = file_version(&meta);
        if if_version.as_deref() == Some(version.as_str()) {
            return Ok(kybern_protocol::methods::FilesReadResult {
                content: String::new(),
                truncated: false,
                binary: false,
                size,
                version: Some(version),
                unchanged: true,
            });
        }
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
            version: Some(version),
            unchanged: false,
        })
    })
    .await?
}

/// Replace an existing project file with `content`: same directory temp file,
/// fsync, permissions kept, then an atomic rename over the original. Paths go
/// through `resolve` (no `..`, `.git`, secrets or symlink escapes), and
/// generated folders are not saved into. A symlinked file is written through
/// to its target, which must itself pass both checks, so a link cannot reach
/// `.env` or `.git`. With
/// `expected_version`, a file that changed since is left alone and the write
/// fails with a conflict; daemon saves are serialized so two clients racing on
/// one version cannot both win.
pub async fn write_file(
    root: &Path,
    rel: &str,
    content: String,
    expected_version: Option<&str>,
) -> Result<kybern_protocol::methods::FilesWriteResult> {
    use std::io::Write;
    anyhow::ensure!(content.len() <= MAX_WRITE_BYTES, "This file is over 2 MiB. Edit it in your editor instead.");
    let path = resolve(root, rel)?;
    let target = std::fs::canonicalize(&path)?;
    if !target.is_file() {
        anyhow::bail!("not a file: {rel}");
    }
    let canon_root = std::fs::canonicalize(root)?;
    let real = target.strip_prefix(&canon_root).map_err(|_| anyhow::anyhow!(OUTSIDE))?;
    resolve(&canon_root, &relative_wire_path(real))?;
    let named = rel.split('/').chain(real.components().filter_map(|part| part.as_os_str().to_str()));
    if let Some(folder) = generated_folder(named) {
        anyhow::bail!("{folder} holds generated files, so Kybern doesn't save into it. Change the source that generates it instead.");
    }
    let expected = expected_version.map(str::to_owned);
    let rel = rel.to_string();
    tokio::task::spawn_blocking(move || -> Result<kybern_protocol::methods::FilesWriteResult> {
        use std::io::Read;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _saving = SAVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let meta = std::fs::metadata(&target)?;
        if let Some(expected) = expected
            && expected != file_version(&meta)
        {
            return Err(WriteConflict.into());
        }
        // The editor shows a lossy UTF-8 decoding, so saving over a file in another encoding would replace its every
        // non-UTF-8 byte; such files (and binary ones) are refused. A cut inside a character at the cap is fine.
        let mut existing = Vec::with_capacity((meta.len() as usize).min(4 * MAX_WRITE_BYTES));
        std::fs::File::open(&target)?.take(4 * MAX_WRITE_BYTES as u64).read_to_end(&mut existing)?;
        anyhow::ensure!(!existing[..existing.len().min(8192)].contains(&0), "This is a binary file. Edit it in your editor instead.");
        anyhow::ensure!(
            std::str::from_utf8(&existing).map_or_else(|error| error.error_len().is_none(), |_| true),
            "This file is not UTF-8 text. Edit it in your editor instead."
        );
        let dir = target.parent().ok_or_else(|| anyhow::anyhow!("not a file: {rel}"))?;
        let name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp = dir.join(format!(".{name}.kybern-{}-{unique}.tmp", std::process::id()));
        let written = (|| -> std::io::Result<()> {
            // `create_new` never follows a planted link; the original's mode is set before any content lands.
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            file.set_permissions(meta.permissions())?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temp, &target)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temp);
            return Err(error.into());
        }
        let meta = std::fs::metadata(&target)?;
        Ok(kybern_protocol::methods::FilesWriteResult { version: file_version(&meta), size: meta.len() })
    })
    .await?
}

/// The file changed on disk after the client read it.
#[derive(Debug)]
pub struct WriteConflict;
impl std::fmt::Display for WriteConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The file changed on disk since you opened it. Reload it, or save again to overwrite.")
    }
}
impl std::error::Error for WriteConflict {}

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

    use super::{
        CachedIndex, FileIndexCache, MAX_INDEX_SLOTS, WriteConflict, list_dir, rank, read_file, read_thread_file, resolve_thread_files,
        split_location, write_file, write_thread_file,
    };

    #[tokio::test]
    async fn writes_replace_files_atomically_and_detect_changes_on_disk() {
        let base = std::env::temp_dir().join(format!("kybern-write-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/app.ts"), "const a = 1;\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("src/app.ts"), std::fs::Permissions::from_mode(0o750)).unwrap();
        }
        let read = read_file(&root, "src/app.ts", 1024, None).await.unwrap();
        let version = read.version.clone().unwrap();
        // A matching `if_version` skips the read.
        let same = read_file(&root, "src/app.ts", 1024, Some(&version)).await.unwrap();
        assert!(same.unchanged && same.content.is_empty());

        let saved = write_file(&root, "src/app.ts", "const a = 2;\n".into(), Some(&version)).await.unwrap();
        assert_ne!(saved.version, version);
        assert_eq!(saved.size, 13);
        assert_eq!(std::fs::read_to_string(root.join("src/app.ts")).unwrap(), "const a = 2;\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(root.join("src/app.ts")).unwrap().permissions().mode() & 0o777, 0o750);
        }
        let after = read_file(&root, "src/app.ts", 1024, Some(&version)).await.unwrap();
        assert!(!after.unchanged);
        assert_eq!(after.version.as_deref(), Some(saved.version.as_str()));
        // No temp file is left behind.
        assert_eq!(std::fs::read_dir(root.join("src")).unwrap().count(), 1);

        // The old version is stale now: a write based on it is a conflict and changes nothing.
        let conflict = write_file(&root, "src/app.ts", "lost".into(), Some(&version)).await.unwrap_err();
        assert!(conflict.is::<WriteConflict>());
        assert_eq!(std::fs::read_to_string(root.join("src/app.ts")).unwrap(), "const a = 2;\n");
        // Without a version the write overwrites ("Keep mine").
        write_file(&root, "src/app.ts", "mine".into(), None).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/app.ts")).unwrap(), "mine");

        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        std::fs::write(root.join("blob.bin"), b"\0\x01").unwrap();
        std::fs::write(root.join("latin1.txt"), b"caf\xe9\n").unwrap();
        std::fs::write(base.join("outside.ts"), "x").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        for path in ["../outside.ts", ".env", "missing.ts", "src", "node_modules/pkg/index.js", "blob.bin", "latin1.txt"] {
            assert!(write_file(&root, path, "x".into(), None).await.is_err(), "{path} must not be writable");
        }
        assert!(write_file(&root, "src/app.ts", "x".repeat(super::MAX_WRITE_BYTES + 1), None).await.is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("outside.ts"), root.join("escape.ts")).unwrap();
            assert!(write_file(&root, "escape.ts", "x".into(), None).await.is_err());
            assert!(write_thread_file(&root, "escape.ts", "x".into(), None).await.is_err());
            assert_eq!(std::fs::read_to_string(base.join("outside.ts")).unwrap(), "x");
            // A link inside the project may not reach a hidden or generated file either.
            std::os::unix::fs::symlink(root.join(".env"), root.join("src/env.ts")).unwrap();
            assert!(write_file(&root, "src/env.ts", "x".into(), None).await.is_err());
            assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "SECRET=1");
            std::fs::remove_file(root.join("src/env.ts")).unwrap();
        }

        // Thread files resolve against the cwd, absolute paths inside it included.
        let absolute = std::fs::canonicalize(root.join("src/app.ts")).unwrap();
        let indexes = FileIndexCache::default();
        let thread = read_thread_file(&indexes, &root, &absolute.to_string_lossy(), 1024, None).await.unwrap();
        let saved = write_thread_file(&root, &absolute.to_string_lossy(), "thread".into(), thread.version.as_deref()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&absolute).unwrap(), "thread");
        assert!(write_thread_file(&root, "../outside.ts", "x".into(), None).await.is_err());
        assert!(write_thread_file(&root, "src/app.ts", "x".into(), thread.version.as_deref()).await.unwrap_err().is::<WriteConflict>());
        assert!(read_thread_file(&indexes, &root, "src/app.ts", 1024, Some(&saved.version)).await.unwrap().unchanged);
        std::fs::remove_dir_all(base).unwrap();
    }

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

    /// ADE-74: agents link files in dot-folders such as `.kybern-artifacts/` and `.screenshots/`. Naming one opens it;
    /// `.git`, credential folders and env files stay closed, with the reason instead of "not found".
    #[tokio::test]
    async fn named_files_in_dot_folders_open_and_git_and_secrets_stay_closed() {
        let base = std::env::temp_dir().join(format!("kybern-dot-folder-test-{}", uuid::Uuid::new_v4()));
        let dir = &base.join("workspace");
        for file in [
            ".kybern-artifacts/ade-74/mockup.html",
            ".screenshots/home.png",
            ".claude/notes/plan.md",
            ".git/config",
            ".git/HEAD",
            ".ssh/id_ed25519",
            ".env",
            ".env.local",
            ".envrc",
            "apps/web/.env.production",
            "deploy/prod.env",
            ".env.example",
            "apps/web/.env.sample",
            "src/app.ts",
            "dist/report.html",
        ] {
            std::fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
            std::fs::write(dir.join(file), format!("<!-- {file} -->")).unwrap();
        }
        std::fs::write(base.join("outside.html"), "x").unwrap();
        let indexes = FileIndexCache::default();
        let read = |source: &str| {
            let (indexes, source) = (indexes.clone(), source.to_string());
            async move { read_thread_file(&indexes, dir, &source, 1024, None).await.map(|file| file.content).map_err(|e| e.to_string()) }
        };

        // Chat links, project reads and saves all open agent dot-folders, and generated output opens to read.
        for file in [
            ".kybern-artifacts/ade-74/mockup.html",
            ".screenshots/home.png",
            ".claude/notes/plan.md",
            ".env.example",
            "apps/web/.env.sample",
            "dist/report.html",
        ] {
            assert_eq!(read(file).await, Ok(format!("<!-- {file} -->")), "{file}");
            assert_eq!(read(&format!("{file}#L1")).await, Ok(format!("<!-- {file} -->")), "{file} with a location");
            assert!(read_file(dir, file, 1024, None).await.is_ok(), "{file} through files.read");
        }
        let resolved =
            resolve_thread_files(&indexes, dir, &[".kybern-artifacts/ade-74/mockup.html".into(), ".env".into(), ".git/config".into()])
                .await
                .unwrap();
        assert_eq!(resolved, [Some(".kybern-artifacts/ade-74/mockup.html".to_string()), None, None]);
        let read_back = read_file(dir, ".kybern-artifacts/ade-74/mockup.html", 1024, None).await.unwrap();
        write_thread_file(dir, ".kybern-artifacts/ade-74/mockup.html", "<p>edited</p>".into(), read_back.version.as_deref()).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".kybern-artifacts/ade-74/mockup.html")).unwrap(), "<p>edited</p>");
        let saved = write_file(dir, "dist/report.html", "x".into(), None).await.unwrap_err().to_string();
        assert!(saved.contains("generated files"), "{saved}");

        // Refusals say why, and never that an existing file is missing.
        let refused = |message: &str, reason: &str| {
            assert!(message.contains(reason), "{message:?} should say {reason:?}");
            assert!(!message.contains("not found") && !message.contains("does not exist"), "{message:?}");
        };
        for file in [".git/config", ".git/HEAD"] {
            refused(&read(file).await.unwrap_err(), "inside .git");
            refused(&read_file(dir, file, 1024, None).await.unwrap_err().to_string(), "inside .git");
            refused(&write_thread_file(dir, file, "x".into(), None).await.unwrap_err().to_string(), "inside .git");
        }
        refused(&read(".ssh/id_ed25519").await.unwrap_err(), "holds credentials");
        for file in [".env", ".env.local", ".envrc", "apps/web/.env.production", "deploy/prod.env"] {
            refused(&read(file).await.unwrap_err(), "may hold secrets");
            refused(&read_file(dir, file, 1024, None).await.unwrap_err().to_string(), "may hold secrets");
            refused(&write_file(dir, file, "x".into(), None).await.unwrap_err().to_string(), "may hold secrets");
        }
        // `..` through an agent folder reaches the same refusal, and leaving the project is still refused.
        refused(&read(".kybern-artifacts/../.env").await.unwrap_err(), "may hold secrets");
        refused(&read_file(dir, ".kybern-artifacts/../.env", 1024, None).await.unwrap_err().to_string(), "without `.`, `..`");
        refused(&read_file(dir, "../outside.html", 1024, None).await.unwrap_err().to_string(), "without `.`, `..`");
        assert!(read("../outside.html").await.unwrap_err().contains("outside the conversation's workspace"));
        // A missing file is still reported as missing.
        assert!(read(".kybern-artifacts/ade-74/gone.html").await.unwrap_err().starts_with("File not found"));
        assert!(read_file(dir, ".screenshots/gone.png", 1024, None).await.unwrap_err().to_string().contains("does not exist"));

        #[cfg(unix)]
        {
            // Links inside the project cannot reach .git, secrets or the outside, whatever they are called.
            std::os::unix::fs::symlink(dir.join(".env"), dir.join("src/settings.txt")).unwrap();
            std::os::unix::fs::symlink(dir.join(".git"), dir.join("src/repo")).unwrap();
            std::os::unix::fs::symlink(base.join("outside.html"), dir.join(".kybern-artifacts/escape.html")).unwrap();
            refused(&read("src/settings.txt").await.unwrap_err(), "may hold secrets");
            refused(&read_file(dir, "src/settings.txt", 1024, None).await.unwrap_err().to_string(), "may hold secrets");
            refused(&write_file(dir, "src/settings.txt", "x".into(), None).await.unwrap_err().to_string(), "may hold secrets");
            refused(&read("src/repo/config").await.unwrap_err(), "inside .git");
            refused(&read_file(dir, "src/repo/config", 1024, None).await.unwrap_err().to_string(), "inside .git");
            refused(&read_file(dir, ".kybern-artifacts/escape.html", 1024, None).await.unwrap_err().to_string(), "outside the project");
            assert!(read(".kybern-artifacts/escape.html").await.unwrap_err().contains("outside the conversation's workspace"));
            assert_eq!(std::fs::read_to_string(dir.join(".env")).unwrap(), "<!-- .env -->");
        }

        // The tree still hides dotfiles, but a named agent folder lists, and .git does not.
        let names = |entries: Vec<kybern_protocol::methods::FileEntry>| entries.into_iter().map(|entry| entry.name).collect::<Vec<_>>();
        let top = names(list_dir(dir, "").await.unwrap());
        assert!(!top.iter().any(|name| name == ".kybern-artifacts" || name == ".git" || name == ".env"), "{top:?}");
        assert!(top.iter().any(|name| name == ".env.example"), "{top:?}");
        assert_eq!(
            names(list_dir(dir, ".kybern-artifacts").await.unwrap()),
            ["ade-74", "escape.html"].map(String::from).into_iter().filter(|name| cfg!(unix) || name != "escape.html").collect::<Vec<_>>()
        );
        refused(&list_dir(dir, ".git").await.unwrap_err().to_string(), "inside .git");
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
            async move { read_thread_file(&indexes, dir, &source, 1024, None).await.map(|file| file.content).map_err(|e| e.to_string()) }
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

    #[tokio::test]
    async fn a_folder_of_repositories_is_indexed_with_each_repository_s_ignores() {
        let root = std::env::temp_dir().join(format!("kybern-files-group-{}", uuid::Uuid::now_v7()));
        let git = |dir: &std::path::Path, args: &[&str]| {
            assert!(std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
        };
        for member in ["api", "services/web"] {
            let dir = root.join(member);
            std::fs::create_dir_all(dir.join("target")).unwrap();
            git(&dir, &["init", "-q"]);
            std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
            std::fs::write(dir.join("main.rs"), "").unwrap();
            std::fs::write(dir.join("target/big.o"), "").unwrap();
        }
        std::fs::write(root.join("AGENTS.md"), "").unwrap();
        let files = super::list_uncached(&root).await.unwrap();
        assert_eq!(files, ["AGENTS.md", "api/.gitignore", "api/main.rs", "services/web/.gitignore", "services/web/main.rs"]);

        // The group folder itself a repository: nested repositories are listed, not skipped.
        git(&root, &["init", "-q"]);
        let mut files = super::list_uncached(&root).await.unwrap().to_vec();
        files.sort();
        assert_eq!(files, ["AGENTS.md", "api/.gitignore", "api/main.rs", "services/web/.gitignore", "services/web/main.rs"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
