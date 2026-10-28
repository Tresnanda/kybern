//! Sending files and folders to another machine (ADE-86 M4 / U1, design §8.1).
//!
//! * **Sender.** `files.send` resolves a file or folder of a project, checks it against the 2 GiB cap and
//!   queues a `files_push` outbox item, so an offline target gets the files when it returns. [`deliver`]
//!   is the outbox worker's delivery: it announces the send (`peer.files.begin`), streams the bytes in
//!   4 MiB chunks from the offset the target already holds (`peer.files.chunk`) and settles it
//!   (`peer.files.finish`). A disconnect ends the attempt with a retry; the next attempt asks `begin`
//!   again and carries on from the staged bytes.
//! * **Target.** Bytes are staged under `<data dir>/incoming/<transfer id>/` with a manifest, so a half
//!   sent file never appears in a project and a restart loses nothing. `finish` checks every size and
//!   SHA-256, then moves the files into the destination root in one step. The destination is checked
//!   like `files.rs` and `previews/files.rs` check theirs: a canonical root, no `..`, no symlink in the
//!   path, and nothing in `.git`, credential folders or env files. A name that is taken becomes
//!   `name (2)`; nothing is overwritten.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::Utc;
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::peers::PeerLink;
use crate::orchestrator::remote_delegation::{CallFailure, Delivery, RemoteHub};
use crate::state::AppState;

const TARGET: &str = "kybern::network::files";
const STAGING: &str = "incoming";
/// Staged bytes and finished markers older than this are removed.
const STAGING_KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Progress notifications go out at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

// ---- the sender: scanning a source ----

/// What a send holds.
#[derive(Debug, Clone)]
pub struct Scanned {
    pub name: String,
    pub is_folder: bool,
    /// Absolute path, path relative to the send's root, size.
    pub files: Vec<(PathBuf, String, u64)>,
    /// Entries left out: symlinks, `.git`, credential folders and env files.
    pub skipped: u32,
    pub bytes: u64,
}

fn rpc_invalid(message: impl Into<String>) -> RpcError {
    RpcError::invalid_params(message.into())
}

/// Resolve `rel` inside a project root the way the file browser does (canonical containment, no `..`, the
/// same refusals), then scan it.
pub fn scan_in_project(root: &Path, rel: &str) -> Result<(PathBuf, Scanned), RpcError> {
    let rel = rel.trim_matches('/');
    let parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    for part in &parts {
        if *part == ".." || *part == "." || part.contains('\\') {
            return Err(rpc_invalid("Use the path from the project root, without `.`, `..` or backslashes."));
        }
    }
    if let Some(reason) = crate::files::refusal(&parts) {
        return Err(RpcError::new(codes::FORBIDDEN, reason));
    }
    let canonical_root = std::fs::canonicalize(root).map_err(|_| RpcError::not_found("project folder"))?;
    let mut path = canonical_root.clone();
    for part in &parts {
        path.push(part);
        // The path itself is never a symlink: what is sent is what the tree shows.
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(rpc_invalid("That path is a symbolic link. Send the file it points to instead."));
        }
    }
    let canonical = std::fs::canonicalize(&path).map_err(|_| RpcError::not_found("file"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(RpcError::new(codes::FORBIDDEN, "This path leads outside the project."));
    }
    let scanned = scan(&canonical)?;
    Ok((canonical, scanned))
}

/// List what is under `source` (a file, or a folder walked in sorted order).
pub fn scan(source: &Path) -> Result<Scanned, RpcError> {
    let meta = std::fs::symlink_metadata(source).map_err(|_| RpcError::not_found("file"))?;
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| rpc_invalid("Pick a file or a folder with a name."))?;
    if meta.is_file() {
        if meta.len() > MAX_PUSH_BYTES {
            return Err(too_big(meta.len()));
        }
        return Ok(Scanned {
            name: name.clone(),
            is_folder: false,
            files: vec![(source.to_path_buf(), name, meta.len())],
            skipped: 0,
            bytes: meta.len(),
        });
    }
    if !meta.is_dir() {
        return Err(rpc_invalid("Only files and folders can be sent."));
    }
    let mut scanned = Scanned { name, is_folder: true, files: Vec::new(), skipped: 0, bytes: 0 };
    walk(source, "", &mut scanned)?;
    scanned.files.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(scanned)
}

fn too_big(bytes: u64) -> RpcError {
    rpc_invalid(format!("That is {} GiB. A send is limited to 2 GiB.", bytes / (1024 * 1024 * 1024)))
}

fn walk(dir: &Path, prefix: &str, scanned: &mut Scanned) -> Result<(), RpcError> {
    let mut entries: Vec<_> =
        std::fs::read_dir(dir).map_err(|error| rpc_invalid(format!("Could not read the folder: {error}")))?.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let Ok(meta) = entry.metadata() else { continue };
        let rel_parts: Vec<&str> = rel.split('/').collect();
        if meta.file_type().is_symlink() || crate::files::refusal(&rel_parts).is_some() || name.contains('\\') {
            scanned.skipped += 1;
            continue;
        }
        if meta.is_dir() {
            walk(&entry.path(), &rel, scanned)?;
        } else if meta.is_file() {
            scanned.bytes += meta.len();
            if scanned.bytes > MAX_PUSH_BYTES {
                return Err(too_big(scanned.bytes));
            }
            if scanned.files.len() >= MAX_PUSH_FILES {
                return Err(rpc_invalid(format!("That folder holds more than {MAX_PUSH_FILES} files. Send fewer, or pack them first.")));
            }
            scanned.files.push((entry.path(), rel, meta.len()));
        } else {
            scanned.skipped += 1;
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---- the sender: files.send ----

/// `files.send`: resolve, check the cap, and queue the delivery.
pub fn send(state: &AppState, params: FilesSendParams) -> Result<FilesSendResult, RpcError> {
    let hub = state.orchestrator.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "the machine network is not available"))?;
    let target = hub.resolve(&params.machine).map_err(|message| RpcError::new(codes::NOT_FOUND, message))?;
    let project = state.store.project_get(params.project_id).map_err(RpcError::internal)?.ok_or_else(|| RpcError::not_found("project"))?;
    let (source, scanned) = scan_in_project(Path::new(&project.path), &params.path)?;
    if scanned.files.is_empty() && !scanned.is_folder {
        return Err(rpc_invalid("There is nothing to send."));
    }
    let dest = params.dest.unwrap_or(PushDest::Downloads);
    check_dest_shape(&dest)?;
    let payload =
        FilesPushPayload { source: source.to_string_lossy().into_owned(), name: scanned.name.clone(), is_folder: scanned.is_folder, dest };
    let item = super::outbox::queue(
        state,
        &target.id,
        OutboxKind::FilesPush,
        Uuid::now_v7(),
        serde_json::to_value(payload).map_err(RpcError::internal)?,
    )?;
    Ok(FilesSendResult { item, files: scanned.files.len() as u32, bytes: scanned.bytes, skipped: scanned.skipped })
}

/// Deliver a queued `files_push` item.
pub async fn deliver(state: &AppState, item: &OutboxItem) -> Delivery {
    let Some(hub) = state.orchestrator.remote_hub().cloned() else {
        return Delivery::Failed("This daemon cannot reach other machines.".into());
    };
    let payload: FilesPushPayload = match serde_json::from_value(item.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => return Delivery::Failed(format!("The queued send is unreadable: {error}")),
    };
    let source = PathBuf::from(&payload.source);
    let scanned = match tokio::task::spawn_blocking({
        let source = source.clone();
        move || scan(&source)
    })
    .await
    {
        Ok(Ok(scanned)) => scanned,
        Ok(Err(_)) => return Delivery::Failed(format!("{} is gone or cannot be read any more.", payload.name)),
        Err(_) => return Delivery::Retry("The scan was interrupted.".into()),
    };
    // Hash on a blocking thread: a 2 GiB send is a few seconds of reading.
    let files = scanned.files.clone();
    let entries = match tokio::task::spawn_blocking(move || {
        files
            .iter()
            .map(|(path, rel, size)| sha256_file(path).map(|sha256| PushEntry { path: rel.clone(), size: *size, sha256 }))
            .collect::<std::io::Result<Vec<_>>>()
    })
    .await
    {
        Ok(Ok(entries)) => entries,
        Ok(Err(error)) => return Delivery::Failed(format!("Could not read {}: {error}", payload.name)),
        Err(_) => return Delivery::Retry("The scan was interrupted.".into()),
    };
    let total: u64 = entries.iter().map(|entry| entry.size).sum();
    let begin = PeerFilesBeginParams {
        transfer_id: item.operation_id,
        name: payload.name.clone(),
        is_folder: payload.is_folder,
        dest: payload.dest.clone(),
        entries: entries.clone(),
    };
    let began: PeerFilesBeginResult = match call(&hub, &item.target, PeerFilesBegin::NAME, &begin).await {
        Ok(began) => began,
        Err(delivery) => return delivery,
    };
    if began.complete {
        let done = json!({ "dest_path": began.dest_path, "files": entries.len(), "bytes": total });
        return Delivery::Delivered(done);
    }
    let mut offsets = began.offsets;
    offsets.resize(entries.len(), 0);
    let mut sent: u64 = offsets.iter().zip(&entries).map(|(offset, entry)| (*offset).min(entry.size)).sum();
    let mut last_progress = Instant::now() - PROGRESS_EVERY;
    progress(state, item.id, sent, total);
    for (index, (entry, (path, _, _))) in entries.iter().zip(&scanned.files).enumerate() {
        let mut offset = offsets[index].min(entry.size);
        if offset == entry.size {
            continue;
        }
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) => return Delivery::Retry(format!("Could not read {}: {error}", entry.path)),
        };
        let mut resyncs = 0;
        while offset < entry.size {
            // A cancel ends the attempt; the target drops what it staged.
            if state.store.outbox_get(item.id).ok().flatten().is_some_and(|current| current.state != OutboxState::Sending) {
                let _ = hub.call(&item.target, PeerFilesAbort::NAME, json!({ "transfer_id": item.operation_id })).await;
                return Delivery::Failed("The send was cancelled.".into());
            }
            let want = ((entry.size - offset) as usize).min(PUSH_CHUNK_BYTES);
            let mut chunk = vec![0u8; want];
            let read = file.seek(SeekFrom::Start(offset)).and_then(|_| file.read_exact(&mut chunk));
            if let Err(error) = read {
                return Delivery::Retry(format!("{} changed while it was being sent ({error}). Trying again.", entry.path));
            }
            let request = PeerFilesChunkParams { transfer_id: item.operation_id, index: index as u32, offset, data: B64.encode(&chunk) };
            match call_raw(&hub, &item.target, PeerFilesChunk::NAME, &request).await {
                Ok(value) => {
                    let next = value["offset"].as_u64().unwrap_or(offset + want as u64);
                    sent += next.saturating_sub(offset);
                    offset = next;
                }
                // The target holds a different offset (an earlier attempt's chunk landed after all): carry on from it.
                Err(CallFailure::Remote(error)) if error.code == codes::CONFLICT && resyncs < 3 => {
                    let Some(expected) = error.data.as_ref().and_then(|data| data["offset"].as_u64()) else {
                        return Delivery::Retry(error.message);
                    };
                    resyncs += 1;
                    sent = (sent + expected).saturating_sub(offset);
                    offset = expected;
                    continue;
                }
                Err(failure) => return failure_delivery(&hub, &item.target, failure),
            }
            if last_progress.elapsed() >= PROGRESS_EVERY {
                last_progress = Instant::now();
                progress(state, item.id, sent.min(total), total);
            }
        }
    }
    progress(state, item.id, total, total);
    match call::<PeerFilesFinishResult>(
        &hub,
        &item.target,
        PeerFilesFinish::NAME,
        &PeerFilesTransferParams { transfer_id: item.operation_id },
    )
    .await
    {
        Ok(done) => Delivery::Delivered(serde_json::to_value(done).unwrap_or(Value::Null)),
        Err(delivery) => delivery,
    }
}

fn progress(state: &AppState, item_id: Uuid, sent: u64, total: u64) {
    state
        .network
        .notify_utility(FILES_PROGRESS_NOTIFICATION, serde_json::to_value(FilesProgress { item_id, sent, total }).unwrap_or(Value::Null));
}

async fn call_raw<P: Serialize>(hub: &Arc<dyn RemoteHub>, target: &str, method: &str, params: &P) -> Result<Value, CallFailure> {
    hub.call(target, method, serde_json::to_value(params).unwrap_or(Value::Null)).await
}

async fn call<R: serde::de::DeserializeOwned>(
    hub: &Arc<dyn RemoteHub>,
    target: &str,
    method: &str,
    params: &impl Serialize,
) -> Result<R, Delivery> {
    match call_raw(hub, target, method, params).await {
        Ok(value) => serde_json::from_value(value)
            .map_err(|error| Delivery::Failed(format!("The machine answered with something unreadable: {error}"))),
        Err(failure) => Err(failure_delivery(hub, target, failure)),
    }
}

/// How a failed call ends a delivery: a machine that is away waits, a refusal is final.
fn failure_delivery(hub: &Arc<dyn RemoteHub>, target: &str, failure: CallFailure) -> Delivery {
    let name = || hub.target(target).map_or_else(|| "That machine".to_string(), |target| target.name);
    match failure {
        CallFailure::Offline(reason) => Delivery::Retry(reason),
        CallFailure::Gone(reason) => Delivery::Failed(reason),
        CallFailure::Remote(error) => match error.code {
            codes::METHOD_NOT_FOUND => {
                Delivery::Retry("That machine needs a newer Kybern to receive files. Update it from Settings → Machines.".into())
            }
            codes::FORBIDDEN => Delivery::Failed(format!(
                "{} does not let this machine send it files here. Turn Files on for this machine in Settings → Machines on {}, then retry. ({})",
                name(),
                name(),
                error.message
            )),
            codes::INTERNAL_ERROR | codes::THREAD_BUSY | codes::NOT_AVAILABLE | codes::CONFLICT => Delivery::Retry(error.message),
            _ => Delivery::Failed(error.message),
        },
    }
}

// ---- the target ----

/// What a send announced, kept beside its staged bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Manifest {
    from: String,
    from_name: String,
    name: String,
    is_folder: bool,
    dest: PushDest,
    entries: Vec<PushEntry>,
}

#[derive(Serialize, Deserialize)]
struct Done {
    dest_path: String,
    files: u32,
    bytes: u64,
}

/// The sends this machine is receiving. The manifests are cached, since a chunk is a hot request.
#[derive(Default)]
pub struct Incoming {
    cache: Mutex<HashMap<Uuid, Arc<Manifest>>>,
}

impl Incoming {
    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Arc<Manifest>>> {
        self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn staging_dir(state: &AppState, id: Uuid) -> PathBuf {
    state.paths.root.join(STAGING).join(id.to_string())
}

fn part_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("{index}.part"))
}

fn forbidden(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::FORBIDDEN, message.into())
}

/// A file or folder name that stays inside one directory.
pub fn clean_name(name: &str) -> Result<&str, RpcError> {
    let ok = !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0', ':'])
        && !name.chars().any(char::is_control);
    if ok { Ok(name) } else { Err(rpc_invalid("That name cannot be used as a file name.")) }
}

/// The components of a `/`-separated relative path that cannot climb out of its root.
pub fn clean_relative(path: &str) -> Result<Vec<&str>, RpcError> {
    if path.is_empty() || path.len() > 1024 || path.starts_with('/') {
        return Err(rpc_invalid("A path inside a send must be relative."));
    }
    path.split('/').map(clean_name).collect()
}

fn check_dest_shape(dest: &PushDest) -> Result<(), RpcError> {
    if let PushDest::Project { project, subdir } = dest {
        if project.trim().is_empty() {
            return Err(rpc_invalid("Name the project the files go to."));
        }
        if let Some(subdir) = subdir.as_deref().filter(|subdir| !subdir.is_empty()) {
            clean_relative(subdir)?;
        }
    }
    Ok(())
}

fn sanitize_dir_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() { "machine".to_string() } else { cleaned }
}

fn downloads_root() -> Option<PathBuf> {
    directories::UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))
        .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().join("Downloads")))
}

/// The directory a send lands in on this machine. With `create` the directories are made (the last step
/// of a send); without it the path is only checked. Every existing component is a real directory and the
/// result stays under the canonical root.
fn resolve_dest(state: &AppState, dest: &PushDest, from_name: &str, create: bool) -> Result<PathBuf, RpcError> {
    match dest {
        PushDest::Downloads => {
            let base = downloads_root().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This machine has no Downloads folder."))?;
            let dir = base.join("Kybern").join(sanitize_dir_name(from_name));
            if create {
                std::fs::create_dir_all(&dir).map_err(RpcError::internal)?;
                return std::fs::canonicalize(&dir).map_err(RpcError::internal);
            }
            Ok(dir)
        }
        PushDest::Project { project, subdir } => {
            let hint = project.trim();
            let matches: Vec<Project> = state
                .store
                .projects_list()
                .map_err(RpcError::internal)?
                .into_iter()
                .filter(|candidate| candidate.id.to_string() == hint || candidate.name.eq_ignore_ascii_case(hint) || candidate.path == hint)
                .collect();
            let project = match matches.as_slice() {
                [only] => only,
                [] => return Err(RpcError::new(codes::NOT_FOUND, format!("This machine has no project \"{hint}\"."))),
                _ => return Err(RpcError::new(codes::CONFLICT, format!("Several projects are called \"{hint}\". Use its id."))),
            };
            let root = std::fs::canonicalize(&project.path).map_err(|_| RpcError::not_found("project folder"))?;
            let mut dir = root.clone();
            let parts = match subdir.as_deref().filter(|subdir| !subdir.is_empty()) {
                Some(subdir) => clean_relative(subdir)?,
                None => Vec::new(),
            };
            if let Some(reason) = crate::files::refusal(&parts) {
                return Err(forbidden(reason));
            }
            for part in parts {
                dir.push(part);
                match std::fs::symlink_metadata(&dir) {
                    Ok(meta) if meta.file_type().is_symlink() => return Err(forbidden("The destination goes through a symbolic link.")),
                    Ok(meta) if !meta.is_dir() => return Err(RpcError::new(codes::CONFLICT, "The destination folder is a file.")),
                    Ok(_) => {}
                    Err(_) if create => std::fs::create_dir(&dir).map_err(RpcError::internal)?,
                    Err(_) => {}
                }
            }
            if create {
                let canonical = std::fs::canonicalize(&dir).map_err(RpcError::internal)?;
                if !canonical.starts_with(&root) {
                    return Err(forbidden("The destination leads outside the project."));
                }
                return Ok(canonical);
            }
            Ok(dir)
        }
    }
}

fn validate_manifest(params: &PeerFilesBeginParams) -> Result<(), RpcError> {
    clean_name(&params.name)?;
    check_dest_shape(&params.dest)?;
    if params.entries.len() > MAX_PUSH_FILES {
        return Err(rpc_invalid("Too many files in one send."));
    }
    let mut total: u64 = 0;
    let mut seen = std::collections::HashSet::new();
    for entry in &params.entries {
        let parts = clean_relative(&entry.path)?;
        if let Some(reason) = crate::files::refusal(&parts) {
            return Err(forbidden(reason));
        }
        if !seen.insert(entry.path.to_lowercase()) {
            return Err(rpc_invalid("Two files in this send have the same name."));
        }
        if entry.sha256.len() != 64 || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(rpc_invalid("A checksum is not a SHA-256."));
        }
        total = total.saturating_add(entry.size);
    }
    if total > MAX_PUSH_BYTES {
        return Err(rpc_invalid("A send is limited to 2 GiB."));
    }
    if !params.is_folder && params.entries.len() != 1 {
        return Err(rpc_invalid("A single file is one entry."));
    }
    if !params.is_folder && params.entries[0].path != params.name {
        return Err(rpc_invalid("A single file keeps its own name."));
    }
    Ok(())
}

fn machine_name(state: &AppState, machine: &str) -> String {
    state
        .network
        .membership()
        .and_then(|membership| membership.projection().entry(machine).map(|entry| entry.descriptor.name.clone()))
        .unwrap_or_else(|| machine.to_string())
}

/// Answer one `peer.files.*` request.
pub async fn serve(state: &AppState, link: &Arc<PeerLink>, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        PeerFilesBegin::NAME => to_value(begin(state, link, from_value(params)?).await?),
        PeerFilesChunk::NAME => to_value(chunk(state, link, from_value(params)?).await?),
        PeerFilesFinish::NAME => {
            let request: PeerFilesTransferParams = from_value(params)?;
            to_value(finish(state, link, request.transfer_id).await?)
        }
        PeerFilesAbort::NAME => {
            let request: PeerFilesTransferParams = from_value(params)?;
            abort(state, request.transfer_id);
            to_value(Empty {})
        }
        _ => Err(RpcError::method_not_found(method)),
    }
}

fn from_value<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(if value.is_null() { json!({}) } else { value }).map_err(RpcError::invalid_params)
}

fn to_value<T: Serialize>(value: T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(RpcError::internal)
}

async fn begin(state: &AppState, link: &Arc<PeerLink>, params: PeerFilesBeginParams) -> Result<PeerFilesBeginResult, RpcError> {
    validate_manifest(&params)?;
    let from_name = machine_name(state, &link.machine_id);
    // The destination is checked now, so a send that cannot land fails before any bytes move.
    resolve_dest(state, &params.dest, &from_name, false)?;
    let dir = staging_dir(state, params.transfer_id);
    let manifest = Manifest {
        from: link.machine_id.clone(),
        from_name,
        name: params.name,
        is_folder: params.is_folder,
        dest: params.dest,
        entries: params.entries,
    };
    let staging_state = state.clone();
    let transfer_id = params.transfer_id;
    let result = tokio::task::spawn_blocking(move || -> Result<PeerFilesBeginResult, RpcError> {
        prune_staging(&staging_state);
        let old = std::fs::read_to_string(dir.join("manifest.json")).ok().and_then(|text| serde_json::from_str::<Manifest>(&text).ok());
        let same = old.is_some_and(|old| old.from == manifest.from && old.entries == manifest.entries);
        if same
            && let Ok(text) = std::fs::read_to_string(dir.join("done.json"))
            && let Ok(done) = serde_json::from_str::<Done>(&text)
        {
            return Ok(PeerFilesBeginResult { offsets: Vec::new(), complete: true, dest_path: Some(done.dest_path) });
        }
        if !same {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).map_err(RpcError::internal)?;
            std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&manifest).map_err(RpcError::internal)?)
                .map_err(RpcError::internal)?;
        }
        let mut offsets = Vec::with_capacity(manifest.entries.len());
        for (index, entry) in manifest.entries.iter().enumerate() {
            let path = part_path(&dir, index);
            let held = match std::fs::metadata(&path) {
                Ok(meta) => meta.len(),
                Err(_) => {
                    std::fs::File::create(&path).map_err(RpcError::internal)?;
                    0
                }
            };
            // A part longer than the file is wrong: start it again.
            if held > entry.size {
                std::fs::File::create(&path).map_err(RpcError::internal)?;
                offsets.push(0);
            } else {
                offsets.push(held);
            }
        }
        Ok(PeerFilesBeginResult { offsets, complete: false, dest_path: None })
    })
    .await
    .map_err(RpcError::internal)??;
    // A changed manifest replaces the cached one.
    state.network.files.lock().remove(&transfer_id);
    Ok(result)
}

fn load_manifest(dir: &Path) -> Result<Manifest, RpcError> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).map_err(|_| RpcError::not_found("transfer"))?;
    serde_json::from_str(&text).map_err(RpcError::internal)
}

fn manifest_of(state: &AppState, id: Uuid) -> Result<Arc<Manifest>, RpcError> {
    if let Some(found) = state.network.files.lock().get(&id) {
        return Ok(found.clone());
    }
    let manifest = Arc::new(load_manifest(&staging_dir(state, id))?);
    state.network.files.lock().insert(id, manifest.clone());
    Ok(manifest)
}

async fn chunk(state: &AppState, link: &Arc<PeerLink>, params: PeerFilesChunkParams) -> Result<PeerFilesChunkResult, RpcError> {
    let manifest = manifest_of(state, params.transfer_id)?;
    if manifest.from != link.machine_id {
        return Err(forbidden("That send belongs to another machine."));
    }
    let index = params.index as usize;
    let entry = manifest.entries.get(index).ok_or_else(|| rpc_invalid("There is no such file in this send."))?.clone();
    let bytes = B64.decode(params.data.as_bytes()).map_err(|_| rpc_invalid("data is not base64"))?;
    if bytes.len() > PUSH_CHUNK_BYTES {
        return Err(rpc_invalid("A chunk is at most 4 MiB."));
    }
    let path = part_path(&staging_dir(state, params.transfer_id), index);
    let offset = params.offset;
    tokio::task::spawn_blocking(move || -> Result<PeerFilesChunkResult, RpcError> {
        let held = std::fs::metadata(&path).map_err(|_| RpcError::not_found("transfer"))?.len();
        if held != offset {
            return Err(RpcError::new(codes::CONFLICT, format!("this machine holds {held} bytes of that file, not {offset}"))
                .with_data(json!({ "offset": held })));
        }
        if offset + bytes.len() as u64 > entry.size {
            return Err(rpc_invalid("That chunk is longer than the file."));
        }
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).map_err(RpcError::internal)?;
        file.write_all(&bytes).map_err(RpcError::internal)?;
        Ok(PeerFilesChunkResult { offset: offset + bytes.len() as u64 })
    })
    .await
    .map_err(RpcError::internal)?
}

async fn finish(state: &AppState, link: &Arc<PeerLink>, id: Uuid) -> Result<PeerFilesFinishResult, RpcError> {
    let dir = staging_dir(state, id);
    let manifest = Arc::new(load_manifest(&dir)?);
    if manifest.from != link.machine_id {
        return Err(forbidden("That send belongs to another machine."));
    }
    if let Ok(text) = std::fs::read_to_string(dir.join("done.json"))
        && let Ok(done) = serde_json::from_str::<Done>(&text)
    {
        return Ok(PeerFilesFinishResult { dest_path: done.dest_path, files: done.files, bytes: done.bytes });
    }
    let state_for_move = state.clone();
    let manifest_for_move = manifest.clone();
    let result = tokio::task::spawn_blocking(move || land(&state_for_move, id, &manifest_for_move)).await.map_err(RpcError::internal)??;
    state.network.files.lock().remove(&id);
    let received = FilesReceived {
        transfer_id: id,
        from_machine: manifest.from.clone(),
        from_name: manifest.from_name.clone(),
        name: manifest.name.clone(),
        files: result.files,
        bytes: result.bytes,
        dest_path: result.dest_path.clone(),
        at: Utc::now(),
    };
    state.network.notify_utility(FILES_RECEIVED_NOTIFICATION, serde_json::to_value(received).unwrap_or(Value::Null));
    tracing::info!(target: TARGET, machine = %manifest.from, files = result.files, bytes = result.bytes, "received files");
    Ok(result)
}

/// Check every staged file and move the send into its destination.
fn land(state: &AppState, id: Uuid, manifest: &Manifest) -> Result<PeerFilesFinishResult, RpcError> {
    let dir = staging_dir(state, id);
    let mut bytes = 0u64;
    for (index, entry) in manifest.entries.iter().enumerate() {
        let part = part_path(&dir, index);
        let held = std::fs::metadata(&part).map_err(|_| RpcError::not_found("transfer"))?.len();
        if held != entry.size {
            return Err(RpcError::new(codes::CONFLICT, format!("{} is incomplete ({held} of {} bytes)", entry.path, entry.size)));
        }
        let actual = sha256_file(&part).map_err(RpcError::internal)?;
        if actual != entry.sha256.to_lowercase() {
            // Bytes that do not match cannot be resumed: start the file again.
            let _ = std::fs::File::create(&part);
            return Err(RpcError::new(codes::CONFLICT, format!("{} arrived damaged, so it will be sent again", entry.path)));
        }
        bytes += entry.size;
    }
    let root = resolve_dest(state, &manifest.dest, &manifest.from_name, true)?;
    let hold = root.join(format!(".kybern-recv-{id}"));
    let _ = std::fs::remove_dir_all(&hold);
    std::fs::create_dir(&hold).map_err(RpcError::internal)?;
    let landed = (|| -> Result<PathBuf, RpcError> {
        for (index, entry) in manifest.entries.iter().enumerate() {
            let target = hold.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(RpcError::internal)?;
            }
            move_file(&part_path(&dir, index), &target).map_err(RpcError::internal)?;
        }
        let name = clean_name(&manifest.name)?;
        let final_path = unique_path(&root, name, manifest.is_folder);
        if manifest.is_folder {
            std::fs::rename(&hold, &final_path).map_err(RpcError::internal)?;
        } else {
            std::fs::rename(hold.join(name), &final_path).map_err(RpcError::internal)?;
        }
        Ok(final_path)
    })();
    let _ = std::fs::remove_dir_all(&hold);
    let final_path = landed?;
    let done = Done { dest_path: final_path.to_string_lossy().into_owned(), files: manifest.entries.len() as u32, bytes };
    // Keep the manifest and the marker so a repeated finish or begin answers the same; drop the bytes.
    for index in 0..manifest.entries.len() {
        let _ = std::fs::remove_file(part_path(&dir, index));
    }
    let _ = std::fs::write(dir.join("done.json"), serde_json::to_vec(&done).unwrap_or_default());
    Ok(PeerFilesFinishResult { dest_path: done.dest_path, files: done.files, bytes })
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Another filesystem: copy, then remove the staged part.
    std::fs::copy(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// `dir/name`, or `dir/name (2)` and up when something is there. A file keeps its extension.
pub fn unique_path(dir: &Path, name: &str, is_folder: bool) -> PathBuf {
    let first = dir.join(name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let (stem, extension) = match (is_folder, name.rsplit_once('.')) {
        (false, Some((stem, extension))) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.to_string(), String::new()),
    };
    for number in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({number}){extension}"));
        if std::fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}){extension}", Uuid::now_v7()))
}

fn abort(state: &AppState, id: Uuid) {
    state.network.files.lock().remove(&id);
    let _ = std::fs::remove_dir_all(staging_dir(state, id));
}

/// Remove staged sends and finished markers that nobody came back for.
fn prune_staging(state: &AppState) {
    let root = state.paths.root.join(STAGING);
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let old =
            entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > STAGING_KEEP);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-push-{label}-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn names_and_relative_paths_cannot_climb_or_name_a_drive() {
        for bad in ["", ".", "..", "a/b", "a\\b", "C:", "x\0y", "a\nb"] {
            assert!(clean_name(bad).is_err(), "{bad:?}");
        }
        assert!(clean_name("notes (2).md").is_ok());
        for bad in ["", "/etc/passwd", "a/../b", "a//b", "../a", "a/./b", "C:/x", "a\\b"] {
            assert!(clean_relative(bad).is_err(), "{bad:?}");
        }
        assert_eq!(clean_relative("src/lib/x.rs").unwrap(), ["src", "lib", "x.rs"]);
    }

    #[test]
    fn a_taken_name_gets_a_number_and_keeps_its_extension() {
        let dir = temp("unique");
        assert_eq!(unique_path(&dir, "a.txt", false), dir.join("a.txt"));
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt", false), dir.join("a (2).txt"));
        std::fs::write(dir.join("a (2).txt"), "x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt", false), dir.join("a (3).txt"));
        std::fs::create_dir(dir.join("pics")).unwrap();
        assert_eq!(unique_path(&dir, "pics", true), dir.join("pics (2)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_scan_skips_symlinks_git_and_secrets_and_enforces_the_cap() {
        let root = temp("scan");
        std::fs::create_dir_all(root.join("app/.git")).unwrap();
        std::fs::write(root.join("app/.git/config"), "x").unwrap();
        std::fs::write(root.join("app/.env"), "KEY=secret").unwrap();
        std::fs::write(root.join("app/.env.example"), "KEY=").unwrap();
        std::fs::write(root.join("app/main.rs"), "fn main() {}").unwrap();
        std::fs::create_dir_all(root.join("app/src")).unwrap();
        std::fs::write(root.join("app/src/lib.rs"), "pub fn x() {}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", root.join("app/link")).unwrap();
        let (source, scanned) = scan_in_project(&root, "app").unwrap();
        assert_eq!(source, root.join("app"));
        assert!(scanned.is_folder && scanned.name == "app");
        let rels: Vec<&str> = scanned.files.iter().map(|file| file.1.as_str()).collect();
        assert_eq!(rels, [".env.example", "main.rs", "src/lib.rs"]);
        assert!(scanned.skipped >= 2, "{}", scanned.skipped);
        // A secret cannot be named directly, nor a path outside the project.
        assert!(scan_in_project(&root, "app/.env").is_err());
        assert!(scan_in_project(&root, "app/.git/config").is_err());
        assert!(scan_in_project(&root, "../x").is_err());
        #[cfg(unix)]
        assert!(scan_in_project(&root, "app/link").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_manifest_is_checked_before_a_byte_moves() {
        let entry = |path: &str, size: u64| PushEntry { path: path.into(), size, sha256: "0".repeat(64) };
        let base = |entries: Vec<PushEntry>, is_folder: bool, name: &str| PeerFilesBeginParams {
            transfer_id: Uuid::now_v7(),
            name: name.into(),
            is_folder,
            dest: PushDest::Downloads,
            entries,
        };
        assert!(validate_manifest(&base(vec![entry("a.txt", 3)], false, "a.txt")).is_ok());
        assert!(validate_manifest(&base(vec![entry("a.txt", 3)], false, "b.txt")).is_err(), "a file keeps its name");
        assert!(validate_manifest(&base(vec![entry("../a", 3)], true, "d")).is_err());
        assert!(validate_manifest(&base(vec![entry(".git/config", 3)], true, "d")).is_err());
        assert!(validate_manifest(&base(vec![entry("a", 1), entry("A", 1)], true, "d")).is_err(), "case-insensitive duplicates");
        assert!(validate_manifest(&base(vec![entry("a", MAX_PUSH_BYTES), entry("b", 1)], true, "d")).is_err(), "2 GiB cap");
        assert!(validate_manifest(&base(vec![entry("a", MAX_PUSH_BYTES)], true, "d")).is_ok());
        let mut bad_sum = entry("a", 1);
        bad_sum.sha256 = "zz".into();
        assert!(validate_manifest(&base(vec![bad_sum], true, "d")).is_err());
    }
}
