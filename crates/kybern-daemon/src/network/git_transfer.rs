//! Moving commits between machines as bundles (design §6.2, §7.1).
//!
//! A bundle carries the commits the other machine lacks: `git bundle create <file> <ref> --not
//! --remotes` leaves out everything a remote-tracking ref already reaches, so the usual case is a few
//! kilobytes: the snapshot of the parent's changes and the unpushed commits under it. The receiving
//! machine imports it into the checkout that matches the repository, under `refs/kybern/incoming/<op>`,
//! and never into a branch the user works on. Nothing is pushed to a shared remote.
//!
//! This module is shared: remote delegation (R1) uses it now, "Fork to a machine" (F1) calls it for the
//! hand-off branch. It has no network code of its own; callers stream the file in chunks
//! (`peer.git.bundle`) and ask for the import (`peer.git.import`).

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use kybern_git::Repo;
use kybern_protocol::{MAX_BUNDLE_BYTES, RepoIdentity};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Bytes sent per `peer.git.bundle` call (before base64).
pub const CHUNK_BYTES: usize = 512 * 1024;

/// The ref a bundle carries its commit under.
pub fn transfer_ref(operation_id: Uuid) -> String {
    format!("refs/kybern/transfer/{operation_id}")
}

/// Where an imported bundle's commit is kept on the receiving machine.
pub fn incoming_ref(operation_id: Uuid) -> String {
    format!("refs/kybern/incoming/{operation_id}")
}

/// Where a bundle is staged while it arrives or is sent.
pub fn staged_path(data_dir: &Path, operation_id: Uuid) -> PathBuf {
    data_dir.join("transfers").join(format!("{operation_id}.bundle"))
}

/// A bundle on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleFile {
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

/// Why an import did not happen.
#[derive(Debug)]
pub enum ImportError {
    /// The bundle's prerequisite commits are not in the checkout; a fuller bundle would work.
    MissingBase(String),
    Other(anyhow::Error),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::MissingBase(detail) => write!(f, "the checkout lacks the commits this bundle builds on: {detail}"),
            ImportError::Other(error) => write!(f, "{error:#}"),
        }
    }
}

impl std::error::Error for ImportError {}

impl From<anyhow::Error> for ImportError {
    fn from(error: anyhow::Error) -> Self {
        ImportError::Other(error)
    }
}

/// `host/owner/repo` for an `origin` URL: lowercase, no scheme, user or `.git` (design §4.4).
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let without_scheme = match url.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        // `git@github.com:owner/repo.git`
        None => url.replacen(':', "/", 1),
    };
    let without_user =
        without_scheme.rsplit_once('@').filter(|(user, _)| !user.contains('/')).map_or(without_scheme.as_str(), |(_, rest)| rest);
    // `ssh://git@host:22/owner/repo`: the port is not part of the identity.
    let mut parts = without_user.trim_matches('/').splitn(2, '/');
    let host = parts.next()?.split(':').next()?.to_lowercase();
    let path = parts.next()?.trim_matches('/').trim_end_matches(".git").to_lowercase();
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}"))
}

/// What identifies the repository at `path` across machines: the smallest root commit and the
/// normalized `origin`. Empty when `path` is not a repository.
pub async fn identity_of(path: &Path) -> RepoIdentity {
    let repo = Repo::new(path);
    let root_commit = match repo.output(&["rev-list", "--max-parents=0", "HEAD"]).await {
        Ok(out) if out.success => out.stdout.lines().map(str::trim).filter(|line| !line.is_empty()).min().map(str::to_string),
        _ => None,
    };
    let remote = repo.config_get("remote.origin.url").await.and_then(|url| normalize_remote(&url));
    RepoIdentity { root_commit, remote }
}

/// Whether `identity` names the same repository as `other`: the root commit decides when both have
/// one, then the remote.
pub fn same_repo(identity: &RepoIdentity, other: &RepoIdentity) -> bool {
    match (&identity.root_commit, &other.root_commit) {
        (Some(a), Some(b)) => a == b,
        _ => matches!((&identity.remote, &other.remote), (Some(a), Some(b)) if a == b),
    }
}

/// Whether `commit` exists in the checkout.
pub async fn has_commit(repo: &Repo, commit: &str) -> bool {
    repo.output(&["cat-file", "-e", &format!("{commit}^{{commit}}")]).await.is_ok_and(|out| out.success)
}

/// The commit a worktree child should start from: HEAD when the checkout is clean, else a snapshot
/// of the changes (a commit in the object store that no branch points to).
pub async fn base_commit(repo: &Repo) -> Result<String> {
    match repo.head().await {
        Some(head) if repo.is_clean().await.unwrap_or(false) => Ok(head),
        _ => repo.snapshot("kybern delegation base").await,
    }
}

/// Write the commits `commit` needs that no remote-tracking ref reaches (`full` sends the whole history).
/// `None` when a remote already has everything: the other machine can fetch it from there.
pub async fn create_bundle(repo: &Repo, commit: &str, operation_id: Uuid, out: &Path, full: bool) -> Result<Option<BundleFile>> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = transfer_ref(operation_id);
    repo.update_ref(&name, commit).await.context("name the commit to bundle")?;
    let _ = std::fs::remove_file(out);
    let out_arg = out.to_string_lossy().into_owned();
    let mut args = vec!["bundle", "create", out_arg.as_str(), name.as_str()];
    if !full {
        args.extend(["--not", "--remotes"]);
    }
    let result = repo.output(&args).await;
    let _ = repo.delete_ref(&name).await;
    let result = result?;
    if !result.success {
        if result.stderr.contains("empty bundle") {
            return Ok(None);
        }
        bail!("git bundle create failed: {}", result.stderr.trim());
    }
    let file = describe(out)?;
    if file.size > MAX_BUNDLE_BYTES {
        let _ = std::fs::remove_file(out);
        bail!(
            "the changes to send are {} MiB, over the {} MiB limit. Push the branch and delegate from a clean checkout, or delegate on this machine",
            file.size / (1024 * 1024),
            MAX_BUNDLE_BYTES / (1024 * 1024)
        );
    }
    Ok(Some(file))
}

/// Size and SHA-256 of a file.
pub fn describe(path: &Path) -> Result<BundleFile> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok(BundleFile { path: path.to_path_buf(), size, sha256: hex(&hasher.finalize()) })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Read the chunk of a staged bundle that starts at `offset`.
pub fn read_chunk(path: &Path, offset: u64) -> Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut filled = 0;
    while filled < buffer.len() {
        let read = file.read(&mut buffer[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    buffer.truncate(filled);
    Ok(buffer)
}

/// Add a received chunk to the staged file. A chunk that starts before the end is a resend of data
/// already held and changes nothing; one that starts after it is a gap and is refused. Returns how many
/// bytes the file holds.
pub fn append_chunk(path: &Path, offset: u64, total: u64, data: &[u8]) -> Result<u64> {
    ensure_total(total)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if offset == 0 && !path.exists() {
        std::fs::File::create(path)?;
    }
    let mut file = OpenOptions::new().append(false).write(true).open(path).context("the transfer was not started")?;
    let held = file.metadata()?.len();
    if offset > held {
        bail!("the transfer skipped ahead: expected offset {held}, got {offset}");
    }
    let end = offset + data.len() as u64;
    if end > total {
        bail!("the transfer is larger than announced");
    }
    if end > held {
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)?;
        file.flush()?;
    }
    Ok(file.metadata()?.len())
}

fn ensure_total(total: u64) -> Result<()> {
    if total > MAX_BUNDLE_BYTES {
        bail!("the bundle is {} MiB, over the {} MiB limit", total / (1024 * 1024), MAX_BUNDLE_BYTES / (1024 * 1024));
    }
    Ok(())
}

/// Check a staged bundle and import its commit into `repo` under `incoming_ref(operation_id)`. If the
/// bundle builds on commits the checkout lacks, `origin` is fetched once before giving up with
/// [`ImportError::MissingBase`].
pub async fn import_bundle(repo: &Repo, bundle: &Path, operation_id: Uuid, commit: &str) -> Result<String, ImportError> {
    let bundle_arg = bundle.to_string_lossy().into_owned();
    let mut fetched_origin = false;
    loop {
        let verify = repo.output(&["bundle", "verify", &bundle_arg]).await?;
        if verify.success {
            break;
        }
        let missing = verify.stderr.contains("prerequisite") || verify.stderr.contains("lacks");
        if !missing {
            return Err(ImportError::Other(anyhow!("the bundle is not valid: {}", verify.stderr.trim())));
        }
        if fetched_origin {
            return Err(ImportError::MissingBase(verify.stderr.trim().to_string()));
        }
        fetched_origin = true;
        // Best effort: the base is usually on the shared remote.
        let _ = repo.output(&["fetch", "--quiet", "origin"]).await;
    }
    let incoming = incoming_ref(operation_id);
    let refspec = format!("+{}:{incoming}", transfer_ref(operation_id));
    let fetch = repo.output(&["fetch", "--quiet", &bundle_arg, &refspec]).await?;
    if !fetch.success {
        return Err(ImportError::Other(anyhow!("could not import the bundle: {}", fetch.stderr.trim())));
    }
    if !has_commit(repo, commit).await {
        return Err(ImportError::Other(anyhow!("the bundle does not contain commit {commit}")));
    }
    Ok(incoming)
}

/// Remove the refs and the staged file of a transfer that is over.
pub async fn forget(repo: Option<&Repo>, data_dir: &Path, operation_id: Uuid) {
    let _ = std::fs::remove_file(staged_path(data_dir, operation_id));
    if let Some(repo) = repo {
        let _ = repo.delete_ref(&incoming_ref(operation_id)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;
    use crate::network::testutil::TempDir;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A bare "origin" with one commit, and two clones of it (the two machines' checkouts).
    fn machines(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let origin = root.join("origin.git");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "--bare", "-b", "main"]);
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-b", "main"]);
        std::fs::write(seed.join("a.txt"), "one\n").unwrap();
        git(&seed, &["add", "a.txt"]);
        git(&seed, &["commit", "-m", "first"]);
        git(&seed, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git(&seed, &["push", "origin", "main"]);
        let a = root.join("a");
        let b = root.join("b");
        for dir in [&a, &b] {
            git(root, &["clone", "-q", origin.to_str().unwrap(), dir.to_str().unwrap()]);
        }
        (origin, a, b)
    }

    #[test]
    fn remotes_are_normalized_to_host_owner_repo() {
        for (url, expected) in [
            ("https://GitHub.com/Tresnanda/Kybern.git", "github.com/tresnanda/kybern"),
            ("git@github.com:Tresnanda/kybern.git", "github.com/tresnanda/kybern"),
            ("ssh://git@github.com:22/tresnanda/kybern", "github.com/tresnanda/kybern"),
            ("https://user:pw@gitlab.example.com/group/sub/repo/", "gitlab.example.com/group/sub/repo"),
        ] {
            assert_eq!(normalize_remote(url).as_deref(), Some(expected), "{url}");
        }
        assert_eq!(normalize_remote(""), None);
        assert_eq!(normalize_remote("localhost"), None);
    }

    #[tokio::test]
    async fn identity_is_the_smallest_root_commit_and_the_normalized_origin() {
        let dir = TempDir::new("identity");
        let (_origin, a, b) = machines(dir.path());
        let ida = identity_of(&a).await;
        let idb = identity_of(&b).await;
        assert!(ida.root_commit.is_some());
        assert_eq!(ida.root_commit, idb.root_commit);
        assert!(same_repo(&ida, &idb));
        assert!(!same_repo(&ida, &RepoIdentity { root_commit: Some("0".into()), remote: None }));
        assert!(same_repo(
            &RepoIdentity { root_commit: None, remote: Some("github.com/a/b".into()) },
            &RepoIdentity { root_commit: Some("x".into()), remote: Some("github.com/a/b".into()) }
        ));
        assert_eq!(identity_of(dir.path()).await, RepoIdentity::default(), "a folder that is not a repository has no identity");
    }

    #[tokio::test]
    async fn a_bundle_carries_unpushed_commits_and_the_wip_snapshot() {
        let dir = TempDir::new("bundle");
        let (_origin, a, b) = machines(dir.path());
        // A has one unpushed commit and uncommitted work, including an untracked file.
        std::fs::write(a.join("a.txt"), "one\ntwo\n").unwrap();
        git(&a, &["commit", "-am", "second"]);
        std::fs::write(a.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(a.join("new.txt"), "untracked\n").unwrap();
        let repo_a = Repo::new(&a);
        let remote_before = git(&a, &["ls-remote", "origin"]);
        let snapshot = base_commit(&repo_a).await.unwrap();
        assert_ne!(Some(snapshot.clone()), repo_a.head().await, "a dirty checkout is snapshotted");

        let op = Uuid::now_v7();
        let out = staged_path(dir.path(), op);
        let bundle = create_bundle(&repo_a, &snapshot, op, &out, false).await.unwrap().expect("something to send");
        assert!(bundle.size < 50_000, "only the unpushed commits travel: {} bytes", bundle.size);
        assert!(repo_a.output(&["rev-parse", "--verify", &transfer_ref(op)]).await.unwrap().stdout.is_empty(), "the temporary ref is gone");

        // Stream it the way the peers do, including a resent chunk.
        let received = dir.path().join("received.bundle");
        let mut offset = 0;
        loop {
            let chunk = read_chunk(&bundle.path, offset).unwrap();
            if chunk.is_empty() {
                break;
            }
            assert_eq!(append_chunk(&received, offset, bundle.size, &chunk).unwrap(), offset + chunk.len() as u64);
            assert_eq!(
                append_chunk(&received, offset, bundle.size, &chunk).unwrap(),
                offset + chunk.len() as u64,
                "a resend changes nothing"
            );
            offset += chunk.len() as u64;
        }
        assert_eq!(describe(&received).unwrap().sha256, bundle.sha256);
        assert!(append_chunk(&received, offset + 10, bundle.size, b"x").is_err(), "a gap is refused");

        let repo_b = Repo::new(&b);
        assert!(!has_commit(&repo_b, &snapshot).await);
        let imported = import_bundle(&repo_b, &received, op, &snapshot).await.unwrap();
        assert_eq!(imported, incoming_ref(op));
        assert_eq!(repo_b.rev_parse(&imported).await.unwrap(), snapshot);
        // The WIP files are in the snapshot, and B's branches were not touched.
        assert_eq!(git(&b, &["show", &format!("{snapshot}:a.txt")]), "one\ntwo\nthree");
        assert_eq!(git(&b, &["show", &format!("{snapshot}:new.txt")]), "untracked");
        assert_eq!(git(&b, &["rev-parse", "main"]), git(&b, &["rev-parse", "origin/main"]));
        // Nothing was pushed to the shared remote.
        assert_eq!(git(&a, &["ls-remote", "origin"]), remote_before);
        assert_eq!(git(&a, &["status", "--porcelain"]).lines().count(), 2, "A's working tree is as it was");
    }

    #[tokio::test]
    async fn a_pushed_commit_needs_no_bundle() {
        let dir = TempDir::new("pushed");
        let (_origin, a, _b) = machines(dir.path());
        let repo = Repo::new(&a);
        let head = base_commit(&repo).await.unwrap();
        assert_eq!(Some(head.clone()), repo.head().await, "a clean checkout starts from HEAD");
        let op = Uuid::now_v7();
        assert!(create_bundle(&repo, &head, op, &staged_path(dir.path(), op), false).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_checkout_that_lacks_the_base_gets_a_full_bundle() {
        let dir = TempDir::new("missing");
        let (_origin, a, _b) = machines(dir.path());
        // C is an unrelated checkout with its own history: nothing of A's is there.
        let c = dir.path().join("c");
        std::fs::create_dir_all(&c).unwrap();
        git(&c, &["init", "-b", "main"]);
        std::fs::write(c.join("z.txt"), "z\n").unwrap();
        git(&c, &["add", "z.txt"]);
        git(&c, &["commit", "-m", "elsewhere"]);

        std::fs::write(a.join("a.txt"), "changed\n").unwrap();
        let repo_a = Repo::new(&a);
        let snapshot = base_commit(&repo_a).await.unwrap();
        let op = Uuid::now_v7();
        let thin = create_bundle(&repo_a, &snapshot, op, &staged_path(dir.path(), op), false).await.unwrap().unwrap();
        let repo_c = Repo::new(&c);
        match import_bundle(&repo_c, &thin.path, op, &snapshot).await {
            Err(ImportError::MissingBase(_)) => {}
            other => panic!("expected a missing base, got {other:?}"),
        }
        let full = create_bundle(&repo_a, &snapshot, op, &staged_path(dir.path(), op), true).await.unwrap().unwrap();
        assert!(full.size > thin.size);
        import_bundle(&repo_c, &full.path, op, &snapshot).await.unwrap();
        assert!(has_commit(&repo_c, &snapshot).await);

        forget(Some(&repo_c), dir.path(), op).await;
        assert!(!staged_path(dir.path(), op).exists());
        assert!(repo_c.rev_parse(&incoming_ref(op)).await.is_err());
    }
}
