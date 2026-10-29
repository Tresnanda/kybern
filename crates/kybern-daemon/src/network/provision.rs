//! Delivering "add a project to another machine" (ADE-86 provisioning), and serving it on the target.
//!
//! * **Source.** [`deliver`] is the outbox worker's delivery of a `provision` item. For each repository of
//!   the project (one, or each member of a group) it asks the target to prepare the folder
//!   (`peer.provision.prepare`: the target clones from the remote with its own credentials when it can).
//!   When the target lacks the commit it streams a bundle (`peer.provision.chunk`, resumable) and has it
//!   imported (`peer.provision.import`). Last, the chosen env files are read, sealed one by one to the
//!   target's machine key and sent with `peer.provision.finish`, which registers the project there. Each
//!   step is idempotent on the target, so a retry after a disconnect carries on. The progress is kept in
//!   [`Tracker`] and pushed as `projects.provision.changed`.
//! * **Target.** [`serve`] answers `peer.provision.*`: the orchestrator checks paths and runs git; this
//!   side only opens the sealed env files with the machine key.
//!
//! Env file contents are never logged, traced, stored in the outbox or put in a transcript: they exist in
//! memory between the read on the source and the write on the target, and sealed on the wire.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::Utc;
use kybern_git::Repo;
use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde_json::Value;
use uuid::Uuid;

use super::git_transfer;
use super::peers::PeerLink;
use crate::orchestrator::provision::{MAX_ENV_FILE_BYTES, SourceRepo, is_env_name, safe_relative, source_repos};
use crate::orchestrator::remote_delegation::{CallFailure, Delivery, RemoteHub};
use crate::state::AppState;

const TARGET: &str = "kybern::network::provision";

/// The latest state of each provisioning this machine is the source of.
#[derive(Default)]
pub struct Tracker {
    statuses: Mutex<HashMap<Uuid, ProvisionStatus>>,
}

impl Tracker {
    pub fn get(&self, operation_id: Uuid) -> Option<ProvisionStatus> {
        self.statuses.lock().unwrap_or_else(|error| error.into_inner()).get(&operation_id).cloned()
    }

    fn put(&self, status: ProvisionStatus) {
        let mut statuses = self.statuses.lock().unwrap_or_else(|error| error.into_inner());
        // Finished operations are read from the outbox; keep the map small.
        if statuses.len() > 256 {
            statuses.retain(|_, status| !matches!(status.phase, ProvisionPhase::Done | ProvisionPhase::Failed | ProvisionPhase::Cancelled));
        }
        statuses.insert(status.operation_id, status);
    }
}

fn publish(state: &AppState, status: ProvisionStatus) {
    state.network.provisions.put(status.clone());
    state.network.notify_utility(PROVISION_CHANGED_NOTIFICATION, serde_json::to_value(status).unwrap_or(Value::Null));
}

/// The status an outbox item stands for, when nothing newer is known.
pub fn status_of_item(state: &AppState, item: &OutboxItem) -> ProvisionStatus {
    let request: Option<ProvisionRequest> = serde_json::from_value(item.payload.clone()).ok();
    let machine = state.orchestrator.remote_hub().and_then(|hub| hub.target(&item.target));
    let target_name = machine.as_ref().map_or_else(|| item.target.clone(), |t| t.name.clone());
    let result: Option<ProvisionResult> = item.result.clone().and_then(|value| serde_json::from_value(value).ok());
    let phase = match item.state {
        OutboxState::Queued | OutboxState::Sending => ProvisionPhase::Queued,
        OutboxState::Delivered => ProvisionPhase::Done,
        OutboxState::Failed | OutboxState::Expired => ProvisionPhase::Failed,
        OutboxState::Cancelled => ProvisionPhase::Cancelled,
    };
    let detail = match item.state {
        OutboxState::Queued if item.last_error.is_some() => item.last_error.clone(),
        // Worded by what is true now: an online machine is about to be reached, not waited for.
        OutboxState::Queued => Some(match &machine {
            Some(machine) if machine.paused => format!("{target_name} is paused. Resume it in Settings → Machines to send."),
            Some(machine) if machine.online => format!("Waiting to send to {target_name}"),
            _ => format!("Sends when {target_name} is online"),
        }),
        OutboxState::Expired => Some(format!("{target_name} did not come back in time. Retry it from Settings → Machines.")),
        _ => None,
    };
    ProvisionStatus {
        operation_id: item.operation_id,
        item_id: item.id,
        project_id: request.as_ref().map_or_else(Uuid::nil, |request| request.project_id),
        project_name: request.as_ref().map(|request| request.project_name.clone()).unwrap_or_default(),
        target: item.target.clone(),
        target_name,
        path: result.as_ref().map(|result| result.project.path.clone()).or_else(|| request.and_then(|request| request.path)),
        phase,
        detail,
        bytes_sent: 0,
        bytes_total: None,
        error: matches!(item.state, OutboxState::Failed | OutboxState::Expired).then(|| item.last_error.clone()).flatten(),
        result,
        updated_at: item.updated_at,
    }
}

/// `status` with the byte counts of the live status, which the outbox row does not keep.
fn with_progress(mut status: ProvisionStatus, live: Option<&ProvisionStatus>) -> ProvisionStatus {
    if let Some(live) = live {
        status.bytes_sent = live.bytes_sent;
        status.bytes_total = live.bytes_total;
    }
    status
}

/// `projects.provision.status`.
pub fn status(state: &AppState, operation_id: Uuid) -> Result<ProvisionStatus, RpcError> {
    let item = state
        .store
        .outbox_get_by_operation(operation_id)
        .map_err(RpcError::internal)?
        .filter(|item| item.kind == OutboxKind::Provision)
        .ok_or_else(|| RpcError::not_found("provisioning"))?;
    let live = state.network.provisions.get(operation_id);
    Ok(match live {
        Some(live) if !item.state.is_settled() => live,
        // A finished item is rebuilt from the outbox, which does not know how much was sent.
        live => with_progress(status_of_item(state, &item), live.as_ref()),
    })
}

/// `projects.provision`: queue the work and say so.
pub async fn start(state: &AppState, params: ProjectsProvisionParams) -> Result<ProvisionStatus, RpcError> {
    let hub = state
        .orchestrator
        .remote_hub()
        .cloned()
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?;
    let project = state.store.project_get(params.project_id).map_err(RpcError::internal)?.ok_or_else(|| RpcError::not_found("project"))?;
    let target = hub.resolve(&params.machine).map_err(|reason| RpcError::new(codes::NOT_FOUND, reason))?;
    if let Some(features) = &target.features
        && !features.iter().any(|feature| feature == features::PROVISION_V1)
    {
        return Err(RpcError::new(
            codes::CONFLICT,
            format!("{} needs a newer Kybern to add projects. Update it from Settings → Machines.", target.name),
        ));
    }
    let operation_id = params.operation_id.unwrap_or_else(Uuid::now_v7);
    let item = state.orchestrator.provision_enqueue(&project, &target, params.choice, operation_id, None).await?;
    let status = status_of_item(state, &item);
    publish(state, status.clone());
    state.network.notify_outbox(item);
    Ok(status)
}

/// An item settled (or was queued again): publish its final state and wake the work that waited for it.
pub fn settled(state: &AppState, item: &OutboxItem) {
    if item.state.is_settled() || item.state == OutboxState::Queued {
        let live = state.network.provisions.get(item.operation_id);
        let mut status = status_of_item(state, item);
        if item.state.is_settled() {
            status = with_progress(status, live.as_ref());
        } else if let Some(live) = &live {
            status.bytes_total = live.bytes_total;
        }
        publish(state, status);
    }
    state.orchestrator.provision_settled(item);
}

// ---- the source: delivering ----

/// Progress of one delivery.
struct Progress<'a> {
    state: &'a AppState,
    status: ProvisionStatus,
}

impl Progress<'_> {
    fn phase(&mut self, phase: ProvisionPhase, detail: impl Into<String>) {
        self.status.phase = phase;
        self.status.detail = Some(detail.into());
        self.status.updated_at = Utc::now();
        publish(self.state, self.status.clone());
    }

    fn bytes(&mut self, sent: u64, total: u64) {
        self.status.bytes_sent = sent;
        self.status.bytes_total = Some(total);
        self.status.updated_at = Utc::now();
        publish(self.state, self.status.clone());
    }
}

fn failure(error: CallFailure, target_name: &str) -> Delivery {
    match error {
        CallFailure::Offline(reason) => Delivery::Retry(reason),
        CallFailure::Gone(reason) => Delivery::Failed(reason),
        CallFailure::Remote(error) if error.code == codes::METHOD_NOT_FOUND => {
            Delivery::Failed(format!("{target_name} needs a newer Kybern to add projects. Update it from Settings → Machines."))
        }
        CallFailure::Remote(error) => crate::orchestrator::remote_delegation::remote_error_delivery(&error),
    }
}

async fn call<T: serde::de::DeserializeOwned>(
    hub: &dyn RemoteHub,
    target: &str,
    target_name: &str,
    method: &str,
    params: impl serde::Serialize,
) -> Result<T, Delivery> {
    let value = serde_json::to_value(params).map_err(|error| Delivery::Failed(error.to_string()))?;
    let answer = hub.call(target, method, value).await.map_err(|error| failure(error, target_name))?;
    serde_json::from_value(answer).map_err(|error| Delivery::Failed(format!("{target_name} answered with something unreadable: {error}")))
}

/// The outbox worker's delivery of a `provision` item.
pub async fn deliver(state: &AppState, item: &OutboxItem) -> Delivery {
    let Some(hub) = state.orchestrator.remote_hub().cloned() else {
        return Delivery::Failed("This daemon cannot reach other machines.".into());
    };
    let request: ProvisionRequest = match serde_json::from_value(item.payload.clone()) {
        Ok(request) => request,
        Err(error) => return Delivery::Failed(format!("The queued provisioning is unreadable: {error}")),
    };
    let target_name = hub.target(&item.target).map_or_else(|| item.target.clone(), |target| target.name);
    let project = match state.store.project_get(request.project_id) {
        Ok(Some(project)) => project,
        _ => return Delivery::Failed(format!("{} is no longer a project on this machine.", request.project_name)),
    };
    let mut progress = Progress { state, status: status_of_item(state, item) };
    let outcome = run(state, &*hub, item, &request, &project, &target_name, &mut progress).await;
    match &outcome {
        Delivery::Delivered(_) => {
            tracing::info!(target: TARGET, machine = %item.target, project = %project.id, "added a project to another machine")
        }
        Delivery::Retry(reason) | Delivery::Failed(reason) => {
            tracing::info!(target: TARGET, machine = %item.target, project = %project.id, %reason, "adding a project to another machine did not finish")
        }
    }
    outcome
}

async fn run(
    state: &AppState,
    hub: &dyn RemoteHub,
    item: &OutboxItem,
    request: &ProvisionRequest,
    project: &Project,
    target_name: &str,
    progress: &mut Progress<'_>,
) -> Delivery {
    let target = item.target.as_str();
    let repos = source_repos(project).await;
    if repos.is_empty() || repos.iter().any(|repo| repo.commit.is_none() || repo.identity.is_empty()) {
        return Delivery::Failed(format!(
            "{} has no git commits yet, so there is nothing to copy. Commit once, then try again.",
            project.name
        ));
    }
    // The folder: the one asked for, else the one the target proposes (or the project it already has).
    progress.phase(ProvisionPhase::Cloning, format!("Checking {target_name}"));
    let probe = PeerProvisionProbeParams {
        repos: repos.iter().map(|repo| repo.identity.clone()).collect(),
        members: repos.iter().map(|repo| repo.rel.clone()).collect(),
        kind: project.kind,
        name: project.name.clone(),
        path: request.path.clone(),
    };
    let probe: PeerProvisionProbe = match call(hub, target, target_name, PeerProvisionProbeMethod::NAME, probe).await {
        Ok(probe) => probe,
        Err(delivery) => return delivery,
    };
    let path = match &request.path {
        Some(_) if probe.path_check.state == PathState::Forbidden || probe.path_check.state == PathState::NotEmpty => {
            return Delivery::Failed(format!("{}: {}", probe.path_check.path, probe.path_check.message));
        }
        Some(_) => probe.path_check.path.clone(),
        None => probe.existing.first().map(|existing| existing.path.clone()).unwrap_or_else(|| probe.suggested_path.clone()),
    };
    progress.status.path = Some(path.clone());

    let mut cloned_from_remote = true;
    for repo in &repos {
        match provision_repo(state, hub, item, repo, &path, target_name, progress).await {
            Ok(cloned) => cloned_from_remote &= cloned,
            Err(delivery) => return delivery,
        }
    }

    // Env files, sealed to the target.
    let sealed = if request.env_files.is_empty() {
        Vec::new()
    } else {
        progress
            .phase(ProvisionPhase::CopyingEnv, format!("Copying {} env file{}", request.env_files.len(), plural(request.env_files.len())));
        match seal_env_files(state, target, item.operation_id, Path::new(&project.path), &request.env_files) {
            Ok(sealed) => sealed,
            Err(delivery) => return delivery,
        }
    };
    let finish = PeerProvisionFinishParams {
        operation_id: item.operation_id,
        path,
        name: project.name.clone(),
        kind: project.kind,
        members: if project.kind.is_single() { Vec::new() } else { repos.iter().map(|repo| repo.rel.clone()).collect() },
        env_files: sealed,
        cloned_from_remote,
    };
    let result: ProvisionResult = match call(hub, target, target_name, PeerProvisionFinish::NAME, finish).await {
        Ok(result) => result,
        Err(delivery) => return delivery,
    };
    match serde_json::to_value(&result) {
        Ok(value) => Delivery::Delivered(value),
        Err(error) => Delivery::Failed(error.to_string()),
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// Set up one repository on the target. Returns whether it came from its remote.
async fn provision_repo(
    state: &AppState,
    hub: &dyn RemoteHub,
    item: &OutboxItem,
    repo: &SourceRepo,
    path: &str,
    target_name: &str,
    progress: &mut Progress<'_>,
) -> Result<bool, Delivery> {
    let target = item.target.as_str();
    let commit = repo.commit.clone().unwrap_or_default();
    let label = if repo.rel == "." { "the repository".to_string() } else { repo.rel.clone() };
    progress.phase(
        ProvisionPhase::Cloning,
        match &repo.identity.remote {
            Some(remote) => format!("{target_name} is cloning {label} from {remote}"),
            None => format!("Preparing {label} on {target_name}"),
        },
    );
    let prepare = PeerProvisionPrepareParams {
        operation_id: item.operation_id,
        path: path.to_string(),
        rel: repo.rel.clone(),
        repo: repo.identity.clone(),
        remote_url: repo.remote_url.clone(),
        branch: repo.branch.clone(),
        commit: commit.clone(),
    };
    let prepared: PeerProvisionPrepareResult = call(hub, target, target_name, PeerProvisionPrepare::NAME, prepare).await?;
    match prepared.state {
        PrepareState::Ready => return Ok(prepared.cloned),
        PrepareState::Existing => return Ok(true),
        PrepareState::NeedsBundle => {}
    }
    // The target could not get the commit from a remote: send it.
    let transfer_id = if repo.rel == "." { item.operation_id } else { git_transfer::member_transfer_id(item.operation_id, &repo.rel) };
    let source = Repo::new(&repo.dir);
    let staged = git_transfer::staged_path(&state.paths.root, transfer_id);
    let mut full = prepared.full;
    loop {
        let bundle = match git_transfer::create_bundle_within(&source, &commit, transfer_id, &staged, full, MAX_PROVISION_BUNDLE_BYTES)
            .await
        {
            Ok(Some(bundle)) => bundle,
            Ok(None) if !full => {
                full = true;
                continue;
            }
            Ok(None) => return Err(Delivery::Failed("There was nothing to send, yet the target lacks the commit.".into())),
            Err(error) if error.downcast_ref::<git_transfer::TooLarge>().is_some() => {
                return Err(Delivery::Failed(format!(
                    "{error:#}, more than Kybern sends between machines. Sign in to git on {target_name} so it can clone from the remote, then retry.{}",
                    prepared.clone_error.as_deref().map(|why| format!(" (Cloning said: {why})")).unwrap_or_default()
                )));
            }
            Err(error) => return Err(Delivery::Failed(format!("{error:#}"))),
        };
        progress.phase(ProvisionPhase::Sending, format!("Sending {label} to {target_name}"));
        let sent = stream(hub, target, target_name, transfer_id, &bundle, progress).await;
        let imported = match sent {
            Ok(()) => {
                progress.phase(ProvisionPhase::Importing, format!("{target_name} is unpacking {label}"));
                let import = PeerProvisionImportParams {
                    operation_id: item.operation_id,
                    transfer_id,
                    path: path.to_string(),
                    rel: repo.rel.clone(),
                    total: bundle.size,
                    sha256: bundle.sha256.clone(),
                    branch: repo.branch.clone(),
                    commit: commit.clone(),
                    remote_url: repo.remote_url.clone(),
                };
                let value = serde_json::to_value(import).unwrap_or(Value::Null);
                hub.call(target, PeerProvisionImport::NAME, value).await.map(|_| ())
            }
            Err(error) => Err(error),
        };
        let _ = std::fs::remove_file(&staged);
        match imported {
            Ok(()) => return Ok(false),
            Err(CallFailure::Remote(error))
                if !full && error.data.as_ref().and_then(|data| data.get("needs")).and_then(Value::as_str) == Some("full_bundle") =>
            {
                full = true;
            }
            Err(error) => return Err(failure(error, target_name)),
        }
    }
}

/// Stream a bundle in chunks from the offset the target already holds.
async fn stream(
    hub: &dyn RemoteHub,
    target: &str,
    target_name: &str,
    transfer_id: Uuid,
    bundle: &git_transfer::BundleFile,
    progress: &mut Progress<'_>,
) -> Result<(), CallFailure> {
    let chunk =
        |offset: u64, data: &[u8]| PeerGitBundleParams { operation_id: transfer_id, offset, total: bundle.size, data: B64.encode(data) };
    let started = hub.call(target, PeerProvisionChunk::NAME, serde_json::to_value(chunk(0, &[])).unwrap_or(Value::Null)).await?;
    let mut offset = serde_json::from_value::<PeerGitBundleResult>(started).map(|result| result.received).unwrap_or(0).min(bundle.size);
    let mut reported = 0u64;
    while offset < bundle.size {
        let data = git_transfer::read_chunk(&bundle.path, offset).map_err(|error| CallFailure::Gone(format!("{error:#}")))?;
        if data.is_empty() {
            break;
        }
        let answer = hub.call(target, PeerProvisionChunk::NAME, serde_json::to_value(chunk(offset, &data)).unwrap_or(Value::Null)).await?;
        offset = serde_json::from_value::<PeerGitBundleResult>(answer).map(|result| result.received).unwrap_or(offset + data.len() as u64);
        // About every 4 MiB, and at the end.
        if offset - reported >= 4 * 1024 * 1024 || offset >= bundle.size {
            reported = offset;
            progress.bytes(offset, bundle.size);
        }
    }
    let _ = target_name;
    Ok(())
}

/// Read and seal each chosen env file to the target's machine key. A file that is gone is left out.
fn seal_env_files(
    state: &AppState,
    target: &str,
    operation_id: Uuid,
    root: &Path,
    files: &[String],
) -> Result<Vec<SealedEnvFile>, Delivery> {
    let Some(membership) = state.network.membership() else {
        return Err(Delivery::Failed("The machine network is unavailable on this machine.".into()));
    };
    let me = membership.machine_id();
    let Some(entry) = membership.projection().entry(target).filter(|entry| entry.removed.is_none()).cloned() else {
        return Err(Delivery::Failed("That machine is not in your network any more.".into()));
    };
    let recipient: [u8; 32] = match B64.decode(&entry.descriptor.sealing_key).ok().and_then(|raw| raw.try_into().ok()) {
        Some(key) => key,
        None => return Err(Delivery::Failed("That machine has no key to seal env files to. Update Kybern there.".into())),
    };
    let mut sealed = Vec::new();
    for rel in files {
        let Some(part) = safe_relative(rel).filter(|part| part.file_name().is_some_and(|name| is_env_name(&name.to_string_lossy()))) else {
            return Err(Delivery::Failed(format!("{rel} is not an env file in the project.")));
        };
        let path: PathBuf = root.join(part);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_ENV_FILE_BYTES {
            continue;
        }
        let Ok(contents) = std::fs::read(&path) else { continue };
        let context = env_file_context(operation_id, &me, target, rel);
        let blob = crate::secret_store::seal(&recipient, &context, &contents).map_err(|error| Delivery::Failed(format!("{error:#}")))?;
        sealed.push(SealedEnvFile { path: rel.clone(), sealed: B64.encode(blob) });
    }
    Ok(sealed)
}

// ---- the target ----

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(if params.is_null() { serde_json::json!({}) } else { params }).map_err(RpcError::invalid_params)
}

/// Answer one `peer.provision.*` request from `link`'s machine.
pub async fn serve(state: &AppState, link: &Arc<PeerLink>, method: &str, params: Value) -> Result<Value, RpcError> {
    let ok = |value: Result<Value, serde_json::Error>| value.map_err(RpcError::internal);
    let orchestrator = &state.orchestrator;
    match method {
        PeerProvisionProbeMethod::NAME => ok(serde_json::to_value(orchestrator.serve_provision_probe(parse(params)?).await?)),
        PeerProvisionPrepare::NAME => ok(serde_json::to_value(orchestrator.serve_provision_prepare(parse(params)?).await?)),
        PeerProvisionChunk::NAME => ok(serde_json::to_value(orchestrator.serve_provision_chunk(parse(params)?)?)),
        PeerProvisionImport::NAME => ok(serde_json::to_value(orchestrator.serve_provision_import(parse(params)?).await?)),
        PeerProvisionFinish::NAME => {
            let params: PeerProvisionFinishParams = parse(params)?;
            let membership = state.network.membership().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "no network"))?;
            let me = membership.machine_id();
            let keys = membership.keys();
            let mut files = Vec::new();
            for file in &params.env_files {
                let blob = B64.decode(&file.sealed).map_err(|_| RpcError::invalid_params(format!("{} is not sealed base64", file.path)))?;
                let context = env_file_context(params.operation_id, &link.machine_id, &me, &file.path);
                let plain = crate::secret_store::open(&keys, &context, &blob)
                    .map_err(|_| RpcError::new(codes::FORBIDDEN, format!("{} was not sealed for this machine.", file.path)))?;
                files.push((file.path.clone(), plain));
            }
            ok(serde_json::to_value(orchestrator.serve_provision_finish(&params, files).await?))
        }
        _ => Err(RpcError::method_not_found(method)),
    }
}
