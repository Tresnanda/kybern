//! Group projects keep the same repositories on every machine.
//!
//! A repository added to a group on one machine is cloned into that group on every other machine that has it,
//! and one removed from it is removed there too (its folder stays on disk). The member lists travel as signed
//! registers on their own exchange (`peer.groups.sync`, `groups.sync.v1`), with the Spaces signature domain and
//! Lamport ordering the preference files use.
//!
//! **Lineage.** The same group on several machines is one *lineage*: the group as it changes over time. Its
//! `group` register lists the group keys (the sorted repository identities clients merge projects by) the group
//! has had, so a machine whose group equals any of them, including an old one after a long time offline, joins
//! that lineage and catches up. A group no lineage knows starts one named after its key, so machines with the
//! same group start the same lineage. A group that matches no key (a different set of repositories) is left
//! alone: nothing is cloned into a group nobody synced.
//!
//! **Members.** Each repository is its own register (`member`), last writer wins per repository, so two machines
//! adding different repositories at once both keep theirs. Every machine remembers the identities it last saw
//! (`base`); a difference to what its group holds now is its own edit, written out; the registers' difference to
//! what the group holds is the other machines' edits, applied here.
//!
//! **Adding** clones from the member's `origin` with this machine's own git credentials, never a copy from another
//! machine, in the background. A failure is kept with a `Problem` and tried again after [`RETRY_AFTER`] or on
//! `projects.members.retry`; `projects.members.status` lists it under `pending`.

use super::{git_transfer, keys, ops, peers::PeerLink, repo_identity, spaces};
use crate::orchestrator::provision::{clone_remote, inside, safe_relative, strip_credentials};
use crate::orchestrator::{member_dir, probe_member};
use crate::state::AppState;
use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chrono::{DateTime, Utc};
use kybern_protocol::methods::*;
use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind, codes};
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The registers: entity → newest envelope.
const KEY: &str = "network.groups.v1";
/// This machine's view of each group: [`LocalGroup`] by project.
const LOCAL: &str = "network.groups.local.v1";
const GROUP_FIELD: &str = "group";
const MEMBER_FIELD: &str = "member";
/// Most registers kept and exchanged; a new name beyond it stays local.
const MAX_REGISTERS: usize = 4096;
/// Largest register body.
const MAX_BODY: usize = 4096;
/// Group keys a lineage remembers.
const MAX_HISTORY: usize = 16;
/// A group never shrinks below this many members by sync (as `projects.update` requires).
const MIN_MEMBERS: usize = 2;
/// How long a failed add waits before it is tried again by itself.
const RETRY_AFTER: chrono::TimeDelta = chrono::TimeDelta::minutes(30);
/// A repository this machine couldn't clone is copied from another machine without asking up to this size.
const AUTO_COPY_BYTES: u64 = 200 * 1024 * 1024;
/// The largest repository copied from another machine at all (as for Add to machine).
const MAX_COPY_BYTES: u64 = kybern_protocol::provision::MAX_PROVISION_BUNDLE_BYTES;
/// Bundles a machine made for others are deleted after this long.
const BUNDLE_KEEP: Duration = Duration::from_secs(6 * 60 * 60);
/// How long reading one member's identity may take.
const IDENTITY_BUDGET: Duration = Duration::from_secs(20);

type Registers = BTreeMap<String, OpEnvelope>;

/// The lock that orders reads and writes of the registers and local views, and the groups adding members now.
pub struct Local {
    lock: tokio::sync::Mutex<()>,
    busy: Mutex<BTreeSet<ProjectId>>,
    /// Bundles up to this size are copied from another machine without asking ([`AUTO_COPY_BYTES`]; tests lower it).
    auto_copy: AtomicU64,
}

impl Default for Local {
    fn default() -> Self {
        Self { lock: Default::default(), busy: Default::default(), auto_copy: AtomicU64::new(AUTO_COPY_BYTES) }
    }
}

/// The `group` register of a lineage.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct GroupValue {
    /// Group keys this lineage has had, oldest first.
    history: Vec<String>,
}

/// A `member` register: one repository of a lineage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct MemberValue {
    repo: RepoIdentity,
    /// Its path inside the group folder on the machine that added it.
    path: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_url: Option<String>,
    /// False once it was removed from the group.
    present: bool,
}

/// What this machine knows about one of its groups.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LocalGroup {
    lineage: String,
    /// The identities the group held when it was last synced.
    base: Vec<RepoIdentity>,
    /// Each member path's last identity, so a member whose folder is gone for a while is not taken as removed.
    #[serde(default)]
    known: BTreeMap<String, RepoIdentity>,
    #[serde(default)]
    failed: Vec<Failure>,
    /// The person allowed copying repositories over the automatic size for the next try.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    copy_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Failure {
    repo: RepoIdentity,
    at: DateTime<Utc>,
    problem: Problem,
}

/// One member of a group as this machine sees it now.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    name: String,
    repo: RepoIdentity,
}

// ---- keys ----

fn identity_key(repo: &RepoIdentity) -> Option<String> {
    if let Some(root) = repo.root_commit.as_ref().or(repo.root_commits.first()) {
        return Some(format!("root:{root}"));
    }
    repo.remote.as_ref().map(|remote| format!("remote:{remote}"))
}

/// The key of a set of repositories: the same set gives the same key on every machine.
fn group_key(repos: &[RepoIdentity]) -> String {
    let mut keys: Vec<String> = repos.iter().filter_map(identity_key).collect();
    keys.sort();
    keys.dedup();
    ops::digest_of(&keys)[..32].to_string()
}

fn member_entity(lineage: &str, repo: &RepoIdentity) -> Option<String> {
    identity_key(repo).map(|key| format!("{lineage}|{key}"))
}

fn contains(list: &[RepoIdentity], repo: &RepoIdentity) -> bool {
    list.iter().any(|other| git_transfer::same_repo(other, repo))
}

// ---- registers ----

fn field(e: &OpEnvelope) -> Result<SpaceField> {
    Ok(serde_json::from_str(&e.body)?)
}

fn stamp(e: &OpEnvelope) -> (u64, String, String) {
    (field(e).map(|f| f.lamport).unwrap_or(0), e.signer.clone(), e.id.clone())
}

fn load(state: &AppState) -> Result<Registers> {
    Ok(state.store.meta_get(KEY)?.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or_default())
}

fn save(state: &AppState, registers: &Registers) -> Result<()> {
    state.store.meta_set(KEY, &serde_json::to_string(registers)?)
}

fn load_local(state: &AppState) -> Result<BTreeMap<ProjectId, LocalGroup>> {
    Ok(state.store.meta_get(LOCAL)?.map(|s| serde_json::from_str(&s)).transpose()?.unwrap_or_default())
}

fn save_local(state: &AppState, local: &BTreeMap<ProjectId, LocalGroup>) -> Result<()> {
    state.store.meta_set(LOCAL, &serde_json::to_string(local)?)
}

fn history(registers: &Registers, lineage: &str) -> Vec<String> {
    registers
        .get(lineage)
        .and_then(|e| field(e).ok())
        .and_then(|f| serde_json::from_value::<GroupValue>(f.value).ok())
        .map(|g| g.history)
        .unwrap_or_default()
}

/// The `member` registers of `lineage`, by entity.
fn members(registers: &Registers, lineage: &str) -> Vec<(String, MemberValue)> {
    let prefix = format!("{lineage}|");
    registers
        .range(prefix.clone()..)
        .take_while(|(entity, _)| entity.starts_with(&prefix))
        .filter_map(|(entity, e)| Some((entity.clone(), serde_json::from_value(field(e).ok()?.value).ok()?)))
        .collect()
}

/// Validate and keep the newer of each incoming register. Returns whether anything changed.
fn merge(state: &AppState, registers: &mut Registers, incoming: &[OpEnvelope]) -> Result<bool> {
    anyhow::ensure!(incoming.len() <= MAX_REGISTERS, "Too many group registers");
    let m = state.network.membership().ok_or_else(|| anyhow::anyhow!("No network"))?;
    let projection = m.projection();
    let mut changed = false;
    for e in incoming {
        anyhow::ensure!(e.body.len() <= MAX_BODY && e.id == ops::op_id(&e.body), "Invalid group register hash or size");
        let f = field(e)?;
        anyhow::ensure!(f.lamport < i64::MAX as u64, "Invalid group register clock");
        match f.field.as_str() {
            GROUP_FIELD => {
                anyhow::ensure!(f.entity.starts_with("group:") && !f.entity.contains('|'), "Invalid group register");
                let g: GroupValue = serde_json::from_value(f.value.clone())?;
                anyhow::ensure!(g.history.len() <= MAX_HISTORY, "Invalid group register");
            }
            MEMBER_FIELD => {
                let v: MemberValue = serde_json::from_value(f.value.clone())?;
                let (lineage, _) = f.entity.split_once('|').ok_or_else(|| anyhow::anyhow!("Invalid member register"))?;
                anyhow::ensure!(
                    lineage.starts_with("group:") && member_entity(lineage, &v.repo).as_deref() == Some(f.entity.as_str()),
                    "Invalid member register"
                );
            }
            _ => anyhow::bail!("Invalid group register field"),
        }
        anyhow::ensure!(
            projection.network_id.as_ref() == Some(&f.network_id) || projection.merged_networks.contains(&f.network_id),
            "Foreign group register network"
        );
        let signer = projection.entry(&e.signer).ok_or_else(|| anyhow::anyhow!("Group register signer is not a member"))?;
        keys::verify_signature(&signer.descriptor.signing_key, &spaces::input(&e.body), &B64.decode(&e.signature)?)?;
        if !registers.contains_key(&f.entity) && registers.len() >= MAX_REGISTERS {
            continue;
        }
        if registers.get(&f.entity).is_none_or(|old| stamp(old) < stamp(e)) {
            registers.insert(f.entity, e.clone());
            changed = true;
        }
    }
    Ok(changed)
}

/// Sign and store one register, at a clock above every one this machine has seen.
fn write(state: &AppState, registers: &mut Registers, entity: String, field_name: &str, value: impl Serialize) -> Result<()> {
    let m = state.network.membership().ok_or_else(|| anyhow::anyhow!("No network"))?;
    if !registers.contains_key(&entity) && registers.len() >= MAX_REGISTERS {
        return Ok(());
    }
    let clock = registers.values().filter_map(|e| field(e).ok()).map(|f| f.lamport).max().unwrap_or(0).saturating_add(1);
    let e = spaces::seal(m, clock, entity.clone(), field_name, serde_json::to_value(value)?)?;
    anyhow::ensure!(e.body.len() <= MAX_BODY, "A group register is too large");
    registers.insert(entity, e);
    Ok(())
}

fn active(state: &AppState) -> bool {
    state.network.membership().is_some_and(|m| m.self_is_member() && !m.key_mismatch())
}

// ---- reconcile ----

/// Read what every group holds now. Runs without the lock: it only asks git.
async fn observe(state: &AppState) -> Result<Vec<(Project, Vec<Seen>)>> {
    let local = load_local(state)?;
    let mut out = Vec::new();
    for project in state.store.projects_list()?.into_iter().filter(|p| p.kind == ProjectKind::Group) {
        let folder = Path::new(&project.path);
        let known = local.get(&project.id).map(|l| &l.known);
        let mut seen = Vec::new();
        for member in &project.members {
            let cached = known.and_then(|known| known.get(&member.path));
            let read = if probe_member(folder, &member.path) == MemberStatus::Ok {
                let dir = member_dir(folder, &member.path);
                tokio::time::timeout(IDENTITY_BUDGET, repo_identity::identity_for(&dir, cached)).await.ok().filter(|r| !r.is_empty())
            } else {
                None
            };
            if let Some(repo) = read.or_else(|| cached.cloned()) {
                seen.push(Seen { path: member.path.clone(), name: member.name.clone(), repo });
            }
        }
        out.push((project, seen));
    }
    Ok(out)
}

async fn remote_url(folder: &Path, path: &str) -> Option<String> {
    kybern_git::Repo::new(member_dir(folder, path))
        .config_get("remote.origin.url")
        .await
        .map(|url| strip_credentials(&url))
        .filter(|url| !url.is_empty())
}

/// Bring every group and the registers together: write this machine's edits, apply the others'. Repositories
/// to clone are added in the background.
pub async fn reconcile(state: &AppState) {
    if !active(state) {
        return;
    }
    let observed = match observe(state).await {
        Ok(observed) => observed,
        Err(error) => {
            tracing::warn!(%error, "could not read the group projects to sync their repositories");
            return;
        }
    };
    let mut remote_urls = BTreeMap::new();
    for (project, seen) in &observed {
        for member in seen {
            if let Some(url) = remote_url(Path::new(&project.path), &member.path).await {
                remote_urls.insert((project.id, member.path.clone()), url);
            }
        }
    }
    let _guard = state.network.group_sync.lock.lock().await;
    match reconcile_locked(state, observed, &remote_urls) {
        Ok(adds) => {
            for (project_id, lineage, due) in adds {
                tokio::spawn(add_members(state.clone(), project_id, lineage, due));
            }
        }
        Err(error) => tracing::warn!(%error, "could not sync the repositories of group projects"),
    }
}

type Adds = Vec<(ProjectId, String, Vec<MemberValue>)>;

fn reconcile_locked(
    state: &AppState,
    observed: Vec<(Project, Vec<Seen>)>,
    remote_urls: &BTreeMap<(ProjectId, String), String>,
) -> Result<Adds> {
    let mut registers = load(state)?;
    let mut locals = load_local(state)?;
    let before = registers.clone();
    locals.retain(|id, _| observed.iter().any(|(p, _)| p.id == *id));
    let mut adds = Vec::new();
    let mut projects_changed = false;
    let now = Utc::now();
    for (mut project, seen) in observed {
        if state.network.group_sync.busy.lock().unwrap_or_else(|e| e.into_inner()).contains(&project.id) {
            continue;
        }
        // Members changed since they were read (an add just finished, or a person edited them): a stale reading
        // would look like a removal, so this group waits for the next pass.
        let paths = |p: &Project| p.members.iter().map(|m| m.path.clone()).collect::<Vec<_>>();
        if state.store.project_get(project.id)?.is_none_or(|fresh| paths(&fresh) != paths(&project)) {
            continue;
        }
        let mut local = locals.remove(&project.id).unwrap_or_default();
        local.known = seen.iter().map(|s| (s.path.clone(), s.repo.clone())).collect();
        if seen.is_empty() {
            locals.insert(project.id, local);
            continue;
        }
        let ids: Vec<RepoIdentity> = seen.iter().map(|s| s.repo.clone()).collect();
        let value_of = |s: &Seen| MemberValue {
            repo: s.repo.clone(),
            path: s.path.clone(),
            name: s.name.clone(),
            remote_url: remote_urls.get(&(project.id, s.path.clone())).cloned(),
            present: true,
        };

        // Join a lineage: the one that had this exact group, else a new one named after it.
        if local.lineage.is_empty() || !registers.contains_key(&local.lineage) {
            let key = group_key(&ids);
            let found = registers
                .iter()
                .filter(|(entity, e)| !entity.contains('|') && field(e).is_ok_and(|f| f.field == GROUP_FIELD))
                .filter(|(entity, _)| history(&registers, entity).contains(&key))
                .max_by_key(|(_, e)| stamp(e))
                .map(|(entity, _)| entity.clone());
            let lineage = found.unwrap_or_else(|| format!("group:{key}"));
            if !registers.contains_key(&lineage) {
                write(state, &mut registers, lineage.clone(), GROUP_FIELD, GroupValue { history: vec![key] })?;
                for s in &seen {
                    if let Some(entity) = member_entity(&lineage, &s.repo) {
                        write(state, &mut registers, entity, MEMBER_FIELD, value_of(s))?;
                    }
                }
            }
            local.lineage = lineage;
            local.base = ids.clone();
        }
        let lineage = local.lineage.clone();

        // This machine's own edits since the last sync, and repositories a concurrent write left out.
        let registered = members(&registers, &lineage);
        let mut edited = false;
        for s in &seen {
            let present = registered.iter().any(|(_, m)| m.present && git_transfer::same_repo(&m.repo, &s.repo));
            let removed = !present && registered.iter().any(|(_, m)| git_transfer::same_repo(&m.repo, &s.repo));
            // Added here, or here before and never removed anywhere: make sure it is registered.
            if !present
                && (!contains(&local.base, &s.repo) || !removed)
                && let Some(entity) = member_entity(&lineage, &s.repo)
            {
                write(state, &mut registers, entity, MEMBER_FIELD, value_of(s))?;
                edited = true;
            }
        }
        for gone in local.base.iter().filter(|b| !contains(&ids, b)) {
            for (entity, mut m) in registered.iter().filter(|(_, m)| m.present && git_transfer::same_repo(&m.repo, gone)).cloned() {
                m.present = false;
                write(state, &mut registers, entity, MEMBER_FIELD, m)?;
                edited = true;
            }
        }
        if edited {
            let present: Vec<RepoIdentity> =
                members(&registers, &lineage).into_iter().filter(|(_, m)| m.present).map(|(_, m)| m.repo).collect();
            let mut history = history(&registers, &lineage);
            let key = group_key(&present);
            history.retain(|k| *k != key);
            history.push(key);
            let skip = history.len().saturating_sub(MAX_HISTORY);
            write(state, &mut registers, lineage.clone(), GROUP_FIELD, GroupValue { history: history.split_off(skip) })?;
        }
        local.base = ids.clone();

        // The other machines' edits: drop what they removed, add what they added.
        let registered = members(&registers, &lineage);
        let wanted = |repo: &RepoIdentity| registered.iter().any(|(_, m)| m.present && git_transfer::same_repo(&m.repo, repo));
        let dropped: Vec<&Seen> =
            seen.iter().filter(|s| !wanted(&s.repo) && registered.iter().any(|(_, m)| git_transfer::same_repo(&m.repo, &s.repo))).collect();
        if !dropped.is_empty() && project.members.len() - dropped.len() >= MIN_MEMBERS {
            let keep: Vec<String> =
                project.members.iter().map(|m| m.path.clone()).filter(|p| !dropped.iter().any(|d| d.path == *p)).collect();
            match state.orchestrator.apply_group_update(&mut project, Some(keep), None, None) {
                Ok(Some(paths)) => {
                    project.updated_at = now;
                    state.store.project_update(&project)?;
                    state.store.project_set_members(project.id, &paths)?;
                    local.base.retain(|b| !dropped.iter().any(|d| git_transfer::same_repo(&d.repo, b)));
                    for d in &dropped {
                        local.known.remove(&d.path);
                    }
                    projects_changed = true;
                    tracing::info!(project = %project.id, removed = dropped.len(), "removed repositories another machine removed from a group");
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(project = %project.id, error = %error.message, "could not remove repositories from a group"),
            }
        }
        let missing: Vec<MemberValue> = registered.into_iter().map(|(_, m)| m).filter(|m| m.present && !contains(&ids, &m.repo)).collect();
        local.failed.retain(|f| missing.iter().any(|m| git_transfer::same_repo(&m.repo, &f.repo)));
        let due: Vec<MemberValue> = missing
            .into_iter()
            .filter(|m| local.failed.iter().find(|f| git_transfer::same_repo(&f.repo, &m.repo)).is_none_or(|f| now - f.at >= RETRY_AFTER))
            .collect();
        if !due.is_empty() {
            state.network.group_sync.busy.lock().unwrap_or_else(|e| e.into_inner()).insert(project.id);
            adds.push((project.id, lineage.clone(), due));
        }
        locals.insert(project.id, local);
    }
    if registers != before {
        save(state, &registers)?;
        state.network.wake();
    }
    save_local(state, &locals)?;
    if projects_changed {
        state.orchestrator.publish_projects();
    }
    Ok(adds)
}

// ---- adding ----

/// `retry` is `projects.members.retry` for this group.
fn retry_action(project_id: ProjectId) -> ProblemAction {
    ProblemAction { id: "retry".into(), label: "Try again".into(), params: Some(serde_json::json!({ "project_id": project_id })) }
}

fn problem(project_id: ProjectId, member: &MemberValue, kind: ProblemKind, hint: String, detail: String) -> Box<Problem> {
    Box::new(Problem {
        kind,
        subject: Some("group_member".into()),
        title: Some(format!("Couldn't add {} to this group here", member.name)),
        hint: Some(hint),
        action: Some(retry_action(project_id)),
        secondary: None,
        detail: Some(detail).filter(|d| !d.is_empty()),
        retryable: true,
    })
}

/// What a failed clone's text means for the person.
fn clone_problem(project_id: ProjectId, member: &MemberValue, error: String) -> Box<Problem> {
    let text = error.to_lowercase();
    let host = member.remote_url.as_deref().and_then(git_transfer::normalize_remote).and_then(|r| r.split('/').next().map(str::to_string));
    let host = host.unwrap_or_else(|| "its host".into());
    let (kind, hint) = if ["could not resolve host", "unable to access", "network is unreachable", "timed out", "connection refused"]
        .iter()
        .any(|needle| text.contains(needle))
    {
        (ProblemKind::Offline, format!("This machine couldn't reach {host}. Check its connection, then try again."))
    } else if [
        "permission denied",
        "authentication failed",
        "could not read username",
        "repository not found",
        "access denied",
        "publickey",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        (ProblemKind::SignedOut, format!("Sign in to {host} with git on this machine, then try again."))
    } else {
        (ProblemKind::Internal, "Kybern couldn't clone it. Try again, or clone it into the group folder yourself.".into())
    };
    problem(project_id, member, kind, hint, error)
}

/// A remote this machine may hand to git: never a transport helper (`ext::…` runs a command), never an option.
fn plain_remote(url: &str) -> bool {
    !url.contains("::") && !url.starts_with('-')
}

fn megabytes(bytes: u64) -> u64 {
    bytes.div_ceil(1024 * 1024)
}

/// Put one member into the group folder: clone it from its remote, else copy it from a machine that has it.
/// Returns the member path it went to.
async fn add_one(
    state: &AppState,
    project_id: ProjectId,
    folder: &Path,
    lineage: &str,
    member: &MemberValue,
    copy_large: bool,
) -> Result<String, Box<Problem>> {
    let refuse = |kind, hint: &str| problem(project_id, member, kind, hint.to_string(), String::new());
    if member.path == "." {
        return Err(refuse(
            ProblemKind::Conflict,
            "It is the group folder's own repository on the other machine. Make this group's folder a clone of it, then add it in Repositories.",
        ));
    }
    let rel = safe_relative(&member.path).ok_or_else(|| refuse(ProblemKind::InvalidInput, "Its folder name can't be used here."))?;
    let wanted = inside(folder, &rel).map_err(|_| refuse(ProblemKind::InvalidInput, "Its folder name can't be used here."))?;
    // Its own folder name, else the first free `-2`, `-3`… beside it. A folder that already is this repository is used as it is.
    let mut dir = None;
    for n in 1..10 {
        let candidate = if n == 1 {
            wanted.clone()
        } else {
            wanted.with_file_name(format!("{}-{n}", wanted.file_name().unwrap_or_default().to_string_lossy()))
        };
        match std::fs::symlink_metadata(&candidate) {
            Err(_) => {
                dir = Some((candidate, false));
                break;
            }
            Ok(meta) if meta.is_dir() && candidate.join(".git").exists() => {
                if git_transfer::same_repo(&member.repo, &git_transfer::identity_of(&candidate).await) {
                    dir = Some((candidate, true));
                    break;
                }
            }
            Ok(_) => {}
        }
    }
    let (dir, present) = dir.ok_or_else(|| {
        refuse(ProblemKind::Conflict, "Its folder name is taken in this group's folder. Clone it yourself, then add it in Repositories.")
    })?;
    if !present {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                problem(
                    project_id,
                    member,
                    ProblemKind::Internal,
                    "Kybern couldn't create its folder. Try again.".into(),
                    error.to_string(),
                )
            })?;
        }
        let url = member.remote_url.as_deref().filter(|url| plain_remote(url));
        let cloned = match url {
            Some(url) => match clone_remote(&dir, url).await {
                Ok(()) if git_transfer::same_repo(&member.repo, &git_transfer::identity_of(&dir).await) => Ok(()),
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&dir);
                    Err(refuse(
                        ProblemKind::Conflict,
                        "Its remote holds a different repository than the one in the group. Check its origin on the machine that added it.",
                    ))
                }
                Err(error) => Err(clone_problem(project_id, member, error)),
            },
            None if member.remote_url.is_some() => Err(refuse(
                ProblemKind::InvalidInput,
                "Its remote isn't one Kybern clones by itself. Clone it into the group folder yourself.",
            )),
            None => {
                Err(refuse(ProblemKind::NotFound, "It has no remote, and no machine that has it is online. Kybern copies it when one is."))
            }
        };
        // No clone: copy it from a machine of the group that has it.
        if let Err(clone_failed) = cloned {
            match copy_from_peer(state, lineage, member, &dir, url, copy_large).await {
                Ok(()) => {}
                Err(Copy::Unavailable) => return Err(clone_failed),
                Err(Copy::Large(size)) => {
                    let mut p = refuse(
                        ProblemKind::Conflict,
                        &format!("It's {} MB, so Kybern didn't copy it from another machine by itself.", megabytes(size)),
                    );
                    p.action = Some(ProblemAction {
                        id: "retry".into(),
                        label: format!("Copy it ({} MB)", megabytes(size)),
                        params: Some(serde_json::json!({ "project_id": project_id, "copy_large": true })),
                    });
                    p.detail = clone_failed.detail;
                    return Err(p);
                }
                Err(Copy::Failed(detail)) => {
                    return Err(problem(
                        project_id,
                        member,
                        ProblemKind::Internal,
                        "Kybern couldn't clone it or copy it from another machine. Try again.".into(),
                        detail,
                    ));
                }
            }
        }
    }
    let rest = dir.strip_prefix(folder).map_err(|_| refuse(ProblemKind::InvalidInput, "Its folder name can't be used here."))?;
    Ok(rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}

/// Why a copy from another machine did not happen.
#[derive(Debug)]
enum Copy {
    /// No machine online has it (or lets this one copy it).
    Unavailable,
    /// Over the automatic size; the person can allow it.
    Large(u64),
    Failed(String),
}

fn branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.ends_with(".lock")
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_./".contains(&c))
}

/// Pull a bundle of `member` from the first machine that has it, into the new folder `dir`.
async fn copy_from_peer(
    state: &AppState,
    lineage: &str,
    member: &MemberValue,
    dir: &Path,
    url: Option<&str>,
    copy_large: bool,
) -> Result<(), Copy> {
    let staged = state.paths.root.join("transfers").join(format!("group-in-{}.bundle", uuid::Uuid::now_v7()));
    let mut failed = None;
    for link in state.network.peers.links() {
        if !state.network.peers.status(&link.machine_id).presence.is_some_and(|p| p.features.iter().any(|f| f == features::GROUPS_SYNC_V1))
        {
            continue;
        }
        let ask = |offset| PeerGroupBundleParams { lineage: lineage.to_string(), repo: member.repo.clone(), offset };
        let Ok(first) = link.call::<PeerGroupBundle>(ask(0)).await else { continue };
        if first.total > MAX_COPY_BYTES {
            return Err(Copy::Failed(format!(
                "the repository is {} MB, over the {} MB limit",
                megabytes(first.total),
                megabytes(MAX_COPY_BYTES)
            )));
        }
        if first.total > state.network.group_sync.auto_copy.load(Ordering::Relaxed) && !copy_large {
            return Err(Copy::Large(first.total));
        }
        let received = async {
            let mut chunk = first.clone();
            let mut held = 0;
            loop {
                let data = B64.decode(chunk.data.as_bytes()).map_err(|e| format!("a chunk is not base64: {e}"))?;
                if chunk.total != first.total || chunk.sha256 != first.sha256 {
                    return Err("the repository changed while it was being copied; try again".to_string());
                }
                held =
                    git_transfer::append_chunk_within(&staged, held, first.total, &data, MAX_COPY_BYTES).map_err(|e| format!("{e:#}"))?;
                if held >= first.total {
                    break;
                }
                if data.is_empty() {
                    return Err("the other machine sent an empty chunk".into());
                }
                chunk = link.call::<PeerGroupBundle>(ask(held)).await.map_err(|e| e.message)?;
            }
            let file = git_transfer::describe(&staged).map_err(|e| format!("{e:#}"))?;
            if file.sha256 != first.sha256 {
                return Err("the copied repository is damaged; try again".into());
            }
            unpack(&staged, dir, &first, url).await
        }
        .await;
        let _ = std::fs::remove_file(&staged);
        match received {
            Ok(()) => {
                tracing::info!(machine = %link.machine_id, member = %member.name, bytes = first.total, "copied a group repository from another machine");
                return Ok(());
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(dir);
                failed = Some(error);
            }
        }
    }
    Err(failed.map_or(Copy::Unavailable, Copy::Failed))
}

/// Make `dir` a repository holding the bundle's commit on its branch, with `origin` set when there is one.
async fn unpack(bundle: &Path, dir: &Path, sent: &PeerGroupBundleResult, url: Option<&str>) -> Result<(), String> {
    if !sent.ref_name.starts_with("refs/kybern/transfer/") {
        return Err("the other machine named an unexpected ref".into());
    }
    let branch = sent.branch.as_deref().filter(|b| branch_name(b)).unwrap_or("main");
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let repo = kybern_git::Repo::new(dir);
    let bundle_arg = bundle.to_string_lossy().into_owned();
    // Into a ref of its own first: a new repository is already "on" its default branch, which git won't fetch into.
    let incoming = "refs/kybern/incoming/group-copy";
    let refspec = format!("{}:{incoming}", sent.ref_name);
    for args in [
        vec!["init", "-q"],
        vec!["fetch", "-q", bundle_arg.as_str(), refspec.as_str()],
        vec!["checkout", "-q", "-B", branch, incoming],
        vec!["update-ref", "-d", incoming],
    ] {
        let out = repo.output(&args).await.map_err(|e| format!("{e:#}"))?;
        if !out.success {
            return Err(format!("git {}: {}", args[0], out.stderr.trim()));
        }
    }
    if let Some(url) = url {
        let _ = repo.output(&["remote", "add", "origin", url]).await;
    }
    Ok(())
}

/// `peer.groups.bundle`: a chunk of a bundle of one member of a synced group, for `peer` that couldn't clone it.
pub async fn serve_bundle(state: &AppState, peer: &str, p: PeerGroupBundleParams) -> Result<PeerGroupBundleResult, RpcError> {
    let missing = || RpcError::not_found("This machine doesn't have that repository in a synced group.");
    let dir = {
        let locals = load_local(state).map_err(RpcError::internal)?;
        let projects = state.store.projects_list().map_err(RpcError::internal)?;
        locals
            .iter()
            .filter(|(_, l)| l.lineage == p.lineage)
            .find_map(|(id, l)| {
                let project = projects.iter().find(|project| project.id == *id)?;
                let (path, _) = l.known.iter().find(|(_, repo)| git_transfer::same_repo(repo, &p.repo))?;
                (probe_member(Path::new(&project.path), path) == MemberStatus::Ok).then(|| member_dir(Path::new(&project.path), path))
            })
            .ok_or_else(missing)?
    };
    let transfers = state.paths.root.join("transfers");
    let id = {
        let key = format!("{peer}\0{}\0{}", p.lineage, identity_key(&p.repo).unwrap_or_default());
        let digest = ops::digest_of(&[key]);
        uuid::Uuid::parse_str(&digest[..32]).map_err(RpcError::internal)?
    };
    let out = transfers.join(format!("group-{id}.bundle"));
    let sum = out.with_extension("sha256");
    let repo = kybern_git::Repo::new(&dir);
    if p.offset == 0 || !out.exists() || !sum.exists() {
        // Old bundles this machine made for others go first.
        if let Ok(entries) = std::fs::read_dir(&transfers) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let old =
                    entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > BUNDLE_KEEP);
                if name.starts_with("group-") && !name.starts_with("group-in-") && old {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let head = repo.head().await.ok_or_else(|| RpcError::new(codes::CONFLICT, "That repository has no commits yet."))?;
        let file = git_transfer::create_bundle_within(&repo, &head, id, &out, true, MAX_COPY_BYTES)
            .await
            .map_err(|e| RpcError::new(codes::CONFLICT, format!("{e:#}")))?
            .ok_or_else(|| RpcError::new(codes::CONFLICT, "That repository has nothing to copy."))?;
        std::fs::write(&sum, &file.sha256).map_err(RpcError::internal)?;
    }
    let total = std::fs::metadata(&out).map_err(RpcError::internal)?.len();
    let sha256 = std::fs::read_to_string(&sum).map_err(RpcError::internal)?;
    if p.offset > total {
        return Err(RpcError::invalid_params("offset past the end of the bundle"));
    }
    let data = git_transfer::read_chunk(&out, p.offset).map_err(RpcError::internal)?;
    let branch =
        repo.output(&["symbolic-ref", "--short", "-q", "HEAD"]).await.ok().filter(|o| o.success).map(|o| o.stdout.trim().to_string());
    Ok(PeerGroupBundleResult { total, sha256, data: B64.encode(data), ref_name: git_transfer::transfer_ref(id), branch })
}

/// Clears a group's busy mark when its adding ends, however it ends.
struct Busy<'a>(&'a AppState, ProjectId);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.network.group_sync.busy.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.1);
    }
}

async fn add_members(state: AppState, project_id: ProjectId, lineage: String, due: Vec<MemberValue>) {
    let _busy = Busy(&state, project_id);
    let Ok(Some(project)) = state.store.project_get(project_id) else { return };
    let folder = std::path::PathBuf::from(&project.path);
    let copy_large = load_local(&state).ok().and_then(|l| l.get(&project_id).map(|l| l.copy_large)).unwrap_or(false);
    let mut added = Vec::new();
    let mut failed = Vec::new();
    for member in due {
        match add_one(&state, project_id, &folder, &lineage, &member, copy_large).await {
            Ok(path) => added.push((path, member)),
            Err(problem) => {
                tracing::info!(project = %project_id, member = %member.name, hint = ?problem.hint, "could not add a repository another machine added to a group");
                failed.push(Failure { repo: member.repo, at: Utc::now(), problem: *problem });
            }
        }
    }
    let _guard = state.network.group_sync.lock.lock().await;
    let result: Result<()> = (|| {
        let mut locals = load_local(&state)?;
        let local = locals.entry(project_id).or_default();
        if !added.is_empty()
            && let Some(mut project) = state.store.project_get(project_id)?
        {
            let mut paths: Vec<String> = project.members.iter().map(|m| m.path.clone()).collect();
            for (path, _) in &added {
                if !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
            match state.orchestrator.apply_group_update(&mut project, Some(paths), None, None) {
                Ok(Some(paths)) => {
                    project.updated_at = Utc::now();
                    state.store.project_update(&project)?;
                    state.store.project_set_members(project_id, &paths)?;
                    for (path, member) in &added {
                        local.base.push(member.repo.clone());
                        local.known.insert(path.clone(), member.repo.clone());
                    }
                    tracing::info!(project = %project_id, added = added.len(), "added repositories another machine added to a group");
                }
                Ok(None) => {}
                Err(error) => anyhow::bail!("{}", error.message),
            }
        }
        local.copy_large = false;
        local.failed.retain(|f| !added.iter().any(|(_, m)| git_transfer::same_repo(&m.repo, &f.repo)));
        for failure in failed {
            local.failed.retain(|f| !git_transfer::same_repo(&f.repo, &failure.repo));
            local.failed.push(failure);
        }
        save_local(&state, &locals)
    })();
    if let Err(error) = result {
        tracing::warn!(project = %project_id, %error, "could not record the repositories added to a group");
    }
    state.orchestrator.publish_projects();
    if !added.is_empty() {
        state.orchestrator.spawn_repo_identity(project_id);
    }
}

// ---- clients ----

/// The repositories `projects.members.status` lists as on their way to this machine.
pub fn pending(state: &AppState, project_id: ProjectId) -> Vec<PendingMember> {
    if !active(state) {
        return Vec::new();
    }
    let (Ok(registers), Ok(locals)) = (load(state), load_local(state)) else { return Vec::new() };
    let Some(local) = locals.get(&project_id).filter(|l| !l.lineage.is_empty()) else { return Vec::new() };
    let mut out: Vec<PendingMember> = Vec::new();
    for (_, m) in members(&registers, &local.lineage) {
        if !m.present || contains(&local.base, &m.repo) || out.iter().any(|p| p.path == m.path) {
            continue;
        }
        let problem = local.failed.iter().find(|f| git_transfer::same_repo(&f.repo, &m.repo)).map(|f| f.problem.clone());
        out.push(PendingMember { path: m.path, name: m.name, remote_url: m.remote_url, problem });
    }
    out
}

/// `projects.members.retry`: forget the group's failures and try now.
pub async fn retry(state: &AppState, project_id: ProjectId, copy_large: bool) -> Result<(), RpcError> {
    {
        let _guard = state.network.group_sync.lock.lock().await;
        let mut locals = load_local(state).map_err(RpcError::internal)?;
        if let Some(local) = locals.get_mut(&project_id) {
            local.failed.clear();
            local.copy_large |= copy_large;
            save_local(state, &locals).map_err(RpcError::internal)?;
        }
    }
    let state = state.clone();
    tokio::spawn(async move { reconcile(&state).await });
    Ok(())
}

// ---- the exchange ----

fn ids_of(registers: &Registers) -> Vec<String> {
    registers.values().map(|e| e.id.clone()).collect()
}

/// `peer.groups.sync`: take the caller's registers, answer with the ones it lacks.
pub async fn serve(state: &AppState, p: PeerSpacesSyncParams) -> Result<PeerSpacesSyncResult, RpcError> {
    if p.ids.len() > MAX_REGISTERS {
        return Err(RpcError::invalid_params("Too many group registers"));
    }
    let (registers, changed) = {
        let _guard = state.network.group_sync.lock.lock().await;
        let mut registers = load(state).map_err(RpcError::internal)?;
        let changed = merge(state, &mut registers, &p.fields).map_err(RpcError::invalid_params)?;
        if changed {
            save(state, &registers).map_err(RpcError::internal)?;
        }
        (registers, changed)
    };
    if changed {
        let state = state.clone();
        tokio::spawn(async move { reconcile(&state).await });
    }
    let ids = ids_of(&registers);
    let digest = ops::digest_of(&ids);
    let theirs: HashSet<&String> = p.ids.iter().collect();
    let fields = if digest == p.digest { Vec::new() } else { registers.into_values().filter(|e| !theirs.contains(&e.id)).collect() };
    Ok(PeerSpacesSyncResult { digest, ids, fields })
}

/// Exchange registers with one machine: one call when both hold the same, two when they differ.
pub async fn sync(state: &AppState, link: &Arc<PeerLink>) {
    if !active(state)
        || !state.network.peers.status(&link.machine_id).presence.is_some_and(|p| p.features.iter().any(|f| f == features::GROUPS_SYNC_V1))
    {
        return;
    }
    let Ok(registers) = load(state) else { return };
    let ids = ids_of(&registers);
    let digest = ops::digest_of(&ids);
    let Ok(answer) = link.call::<PeerGroupsSync>(PeerSpacesSyncParams { digest: digest.clone(), ids, fields: Vec::new() }).await else {
        return;
    };
    if answer.digest == digest {
        return;
    }
    let registers = {
        let _guard = state.network.group_sync.lock.lock().await;
        let Ok(mut registers) = load(state) else { return };
        match merge(state, &mut registers, &answer.fields) {
            Ok(true) => {
                if let Err(error) = save(state, &registers) {
                    tracing::warn!(%error, "could not store group registers");
                }
            }
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(machine = %link.machine_id, %error, "a machine sent group registers this one does not take");
                return;
            }
        }
        registers
    };
    let theirs: HashSet<&String> = answer.ids.iter().collect();
    let lacking: Vec<OpEnvelope> = registers.values().filter(|e| !theirs.contains(&e.id)).cloned().collect();
    if !lacking.is_empty() {
        let ids = ids_of(&registers);
        let _ = link.call::<PeerGroupsSync>(PeerSpacesSyncParams { digest: ops::digest_of(&ids), ids, fields: lacking }).await;
    }
}

#[cfg(test)]
#[path = "group_sync_tests.rs"]
mod tests;
