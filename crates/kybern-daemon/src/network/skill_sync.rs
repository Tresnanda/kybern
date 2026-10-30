//! Your skills on every machine (ADE-86; the wire types and the model are in `kybern_protocol::skill_sync`).
//!
//! * **Homes.** The user skill folders of every harness (`SkillHome`), resolved by `skills::user_skill_home`
//!   from the daemon's environment ([`SkillHomes`]). Project skills are never listed or written.
//! * **Reading.** [`inventory`] finds each folder with a `SKILL.md` in each home (a skill is not searched
//!   inside), hashes the files a copy would carry ([`scan_skill`], [`digest`]) and notes links: a folder in
//!   `~/.claude/skills` that links to the same skill in `~/.agents/skills` is that copy, not another one.
//!   [`network_view`] asks every online member (`peer.skills.inventory`) and lays the answers out per skill.
//! * **Copying** is explicit only ([`copy`]): the source machine (asked with `peer.skills.copy` when it is
//!   another member) queues one `skill_copy` outbox item per target, so an offline target gets it when it
//!   returns; the source itself is copied to at once. Nothing here runs on its own and no agent tool reaches
//!   it: only a client's `skills.copy` does.
//! * **Transfer** is the file send (`files_push.rs`, `machine:files`) with a `PushDest::Skill` destination: the
//!   target checks the destination before any bytes move ([`preflight`]) and again when it lands ([`place`]).
//! * **Landing.** A home that lacks the skill gets it; one with the same hash is left alone; one with a different
//!   version keeps it unless that version's hash is in `replaces`, and a replaced folder is moved to
//!   `<data dir>/skills-replaced/<time>/<home>/<name>`, outside every home so no harness loads the backup as a
//!   skill. A link is never replaced. Every write stays under the canonical home folder, through no link.

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use chrono::Utc;
use kybern_protocol::methods::{Method, PeerSkillsCopy, PeerSkillsInventory};
use kybern_protocol::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::orchestrator::remote_delegation::{CallFailure, Delivery, MemberView, RemoteHub};
use crate::state::AppState;

const TARGET: &str = "kybern::network::skills";
/// How long a machine has to answer `peer.skills.inventory`.
const VIEW_WAIT: Duration = Duration::from_secs(5);
/// Where replaced skills go, under the data directory.
pub const BACKUPS: &str = "skills-replaced";
/// How deep a home is searched for skill folders (`team/review/SKILL.md` is depth 2).
const MAX_DEPTH: usize = 3;
/// How deep a skill's own files go.
const MAX_FILE_DEPTH: usize = 16;
const HASH_PREFIX: &[u8] = b"kybern-skill-v1\n";

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::invalid_params(message.into())
}

fn forbidden(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::FORBIDDEN, message.into())
}

// ---- where the homes are ----

/// The environment the homes are resolved from: the daemon's own, unless a test set another. Under `cfg(test)`
/// nothing resolves until one is set, so no test ever reads or writes the machine's real skill folders.
#[derive(Default)]
pub struct SkillHomes {
    set: RwLock<Option<(BTreeMap<String, String>, PathBuf)>>,
}

impl SkillHomes {
    /// Resolve the homes from `env` under `home` instead of the process's environment.
    pub fn set(&self, env: BTreeMap<String, String>, home: PathBuf) {
        *self.set.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((env, home));
    }

    fn context(&self) -> Option<(BTreeMap<String, String>, PathBuf)> {
        if let Some(set) = self.set.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
            return Some(set);
        }
        if cfg!(test) {
            return None;
        }
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let home = ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(|name| env.get(*name).map(|value| value.trim()).filter(|value| !value.is_empty()))
            .map(PathBuf::from)
            .find(|path| path.is_absolute())
            .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()))?;
        Some((env, home))
    }

    /// Every home with its folder (which may not exist yet).
    pub fn resolve(&self) -> Vec<(SkillHome, PathBuf)> {
        let Some((env, home)) = self.context() else { return Vec::new() };
        SkillHome::ALL.into_iter().filter_map(|kind| crate::skills::user_skill_home(kind, &env, &home).map(|path| (kind, path))).collect()
    }
}

fn root_of(roots: &[(SkillHome, PathBuf)], home: SkillHome) -> Option<&Path> {
    roots.iter().find(|(kind, _)| *kind == home).map(|(_, path)| path.as_path())
}

fn os_name() -> String {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
    .to_string()
}

/// A home folder for words: `~/.claude/skills` when it is under the home folder.
fn spelled(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The components of a skill name: relative, without `.`/`..`, a hidden folder or anything a send refuses.
pub fn check_name(name: &str) -> Result<Vec<&str>, RpcError> {
    let parts = super::files_push::clean_relative(name).map_err(|_| invalid("A skill is named by its folder, like better-ui."))?;
    if parts.len() > MAX_DEPTH || parts.iter().any(|part| part.starts_with('.') || *part == "node_modules") {
        return Err(invalid("A skill is named by its folder, like better-ui."));
    }
    if let Some(reason) = crate::files::refusal(&parts) {
        return Err(forbidden(reason));
    }
    Ok(parts)
}

fn check_hash(value: &str) -> Result<(), RpcError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(invalid("A skill version is a SHA-256."))
    }
}

/// The shape of a `PushDest::Skill`, checked when a send is announced.
pub fn check_dest(name: &str, homes: &[SkillHome], hash: &str, replaces: &[String]) -> Result<(), RpcError> {
    check_name(name)?;
    check_hash(hash)?;
    if homes.is_empty() || homes.len() > SkillHome::ALL.len() {
        return Err(invalid("Choose the skill folders it goes to."));
    }
    if replaces.len() > 32 {
        return Err(invalid("Too many versions to replace."));
    }
    replaces.iter().try_for_each(|value| check_hash(value))
}

// ---- reading a skill folder ----

/// One file a copy carries.
#[derive(Debug, Clone)]
pub struct SkillFile {
    pub path: PathBuf,
    /// Relative to the skill's folder, `/`-separated.
    pub rel: String,
    pub size: u64,
    pub executable: bool,
}

/// What a copy of a skill folder would carry.
#[derive(Debug, Clone, Default)]
pub struct SkillScan {
    /// Sorted by `rel`.
    pub files: Vec<SkillFile>,
    /// What is left out, for the user to see.
    pub skipped: Vec<String>,
    pub bytes: u64,
    /// Why it cannot be copied.
    pub problem: Option<String>,
}

/// Folders and files left out of every copy and listed: version control, installed dependencies, caches.
const SKIPPED_DIRS: &[&str] = &[".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", ".pytest_cache", ".mypy_cache"];
/// Operating system clutter, left out without a word so a Mac and a Windows copy hash the same.
const CLUTTER: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini"];

/// A file name that may hold a secret: env files and credential folders (`files::refusal`), keys and
/// certificates, and the usual token files.
fn looks_secret(rel_parts: &[&str]) -> bool {
    if crate::files::refusal(rel_parts).is_some() {
        return true;
    }
    let Some(name) = rel_parts.last() else { return false };
    let lower = name.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, extension)| extension).unwrap_or("");
    matches!(extension, "pem" | "key" | "p12" | "pfx" | "keystore" | "jks" | "kdbx" | "ppk" | "asc" | "gpg")
        || matches!(lower.as_str(), ".netrc" | ".npmrc" | ".pypirc" | ".pgpass" | ".git-credentials" | "credentials" | "token" | ".token")
        || ((lower.starts_with("id_rsa")
            || lower.starts_with("id_ed25519")
            || lower.starts_with("id_ecdsa")
            || lower.starts_with("id_dsa"))
            && !lower.ends_with(".pub"))
        || (lower.starts_with("credentials") && (extension == "json" || extension == "yaml" || extension == "yml" || extension == "toml"))
        || lower.starts_with("secret")
        || lower.ends_with(".secret")
        || lower.ends_with(".secrets")
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// List what a copy of `dir` carries. `dir` itself may be a link (it is read through); links inside it are
/// left out, so a copy never reaches outside the skill.
pub fn scan_skill(dir: &Path) -> SkillScan {
    let mut scan = SkillScan::default();
    match std::fs::canonicalize(dir) {
        Ok(canonical) if canonical.is_dir() => walk(&canonical, "", 0, &mut scan),
        _ => scan.problem = Some("The skill's folder cannot be read.".into()),
    }
    scan.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    if scan.problem.is_none() && !scan.files.iter().any(|file| file.rel == "SKILL.md") {
        scan.problem = Some("It has no SKILL.md.".into());
    }
    scan
}

fn walk(dir: &Path, prefix: &str, depth: usize, scan: &mut SkillScan) {
    if scan.problem.is_some() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        scan.problem = Some(format!("{} cannot be read.", if prefix.is_empty() { "The skill's folder" } else { prefix }));
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let lower = name.to_ascii_lowercase();
        if CLUTTER.contains(&lower.as_str()) || lower.starts_with("._") {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        let parts: Vec<&str> = rel.split('/').collect();
        if meta.file_type().is_symlink() || name.contains(['\\', ':']) || super::files_push::clean_name(&name).is_err() {
            scan.skipped.push(rel);
            continue;
        }
        if meta.is_dir() {
            if SKIPPED_DIRS.contains(&lower.as_str()) || crate::files::refusal(&parts).is_some() || depth + 1 > MAX_FILE_DEPTH {
                scan.skipped.push(format!("{rel}/"));
                continue;
            }
            walk(&entry.path(), &rel, depth + 1, scan);
            if scan.problem.is_some() {
                return;
            }
        } else if meta.is_file() {
            if looks_secret(&parts) {
                scan.skipped.push(rel);
                continue;
            }
            scan.bytes += meta.len();
            if scan.bytes > MAX_SKILL_COPY_BYTES {
                scan.problem = Some(format!("It is larger than {} MiB, so it can't be copied.", MAX_SKILL_COPY_BYTES / (1024 * 1024)));
                return;
            }
            if scan.files.len() >= MAX_SKILL_COPY_FILES {
                scan.problem = Some(format!("It holds more than {MAX_SKILL_COPY_FILES} files, so it can't be copied."));
                return;
            }
            scan.files.push(SkillFile { path: entry.path(), rel, size: meta.len(), executable: is_executable(&meta) });
        } else {
            scan.skipped.push(rel);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

/// The skill's hash from each file's path and SHA-256 (in `rel` order). Modes are left out: a Windows copy has none.
pub fn folder_hash<'a>(files: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(HASH_PREFIX);
    for (rel, sha256) in files {
        hasher.update(rel.as_bytes());
        hasher.update([0]);
        hasher.update(sha256.as_bytes());
        hasher.update(b"\n");
    }
    hex(&hasher.finalize())
}

/// The folder hash and each file's SHA-256.
pub fn digest(scan: &SkillScan) -> std::io::Result<(String, Vec<String>)> {
    let shas = scan.files.iter().map(|file| sha256_file(&file.path)).collect::<std::io::Result<Vec<_>>>()?;
    let hash = folder_hash(scan.files.iter().zip(&shas).map(|(file, sha)| (file.rel.as_str(), sha.as_str())));
    Ok((hash, shas))
}

/// Folder hashes by canonical folder, kept while the files' names, sizes and times stay the same, so a view
/// of many machines does not read every skill again.
fn cached_hash(canonical: &Path, scan: &SkillScan) -> std::io::Result<String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, String)>>> = OnceLock::new();
    let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
    for file in &scan.files {
        file.rel.hash(&mut fingerprint);
        file.size.hash(&mut fingerprint);
        std::fs::metadata(&file.path).and_then(|meta| meta.modified()).ok().hash(&mut fingerprint);
    }
    let fingerprint = fingerprint.finish();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((known, hash)) = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(canonical)
        && *known == fingerprint
    {
        return Ok(hash.clone());
    }
    let (hash, _) = digest(scan)?;
    let mut cache = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() > 4096 {
        cache.clear();
    }
    cache.insert(canonical.to_path_buf(), (fingerprint, hash.clone()));
    Ok(hash)
}

// ---- the inventory ----

/// The skill folders under one home: every folder with a `SKILL.md`, not searched inside. Hidden folders
/// (Codex's `.system`, a `.trash`) and `node_modules` are not searched.
fn find_skills(root: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    fn visit(dir: &Path, prefix: &str, depth: usize, found: &mut Vec<(String, PathBuf)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || super::files_push::clean_name(&name).is_err() || found.len() >= 4_000 {
                continue;
            }
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if path.join("SKILL.md").is_file() {
                found.push((rel, path));
            } else if depth + 1 < MAX_DEPTH {
                visit(&path, &rel, depth + 1, found);
            }
        }
    }
    visit(root, "", 0, &mut found);
    found
}

/// One copy of `name` at `path` in `home`, or `None` when nothing is there.
fn copy_at(
    roots: &[(SkillHome, PathBuf)],
    home: SkillHome,
    name: &str,
    path: &Path,
) -> Option<(SkillCopyInfo, Option<crate::skills::Frontmatter>)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    let is_link = meta.file_type().is_symlink();
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.join("SKILL.md").is_file() {
        return None;
    }
    let linked_to = if is_link {
        roots
            .iter()
            .filter(|(other, _)| *other != home)
            .find(|(_, root)| std::fs::canonicalize(root.join(name)).is_ok_and(|other| other == canonical))
            .map(|(other, _)| *other)
    } else {
        None
    };
    let scan = scan_skill(&canonical);
    let (hash, problem) = match &scan.problem {
        Some(problem) => (None, Some(problem.clone())),
        None => match cached_hash(&canonical, &scan) {
            Ok(hash) => (Some(hash), None),
            Err(error) => (None, Some(format!("It cannot be read: {error}"))),
        },
    };
    let frontmatter = std::fs::metadata(canonical.join("SKILL.md"))
        .ok()
        .filter(|meta| meta.len() <= 1_000_000)
        .and_then(|_| std::fs::read_to_string(canonical.join("SKILL.md")).ok())
        .map(|text| crate::skills::parse_frontmatter(&text));
    let info = SkillCopyInfo {
        home,
        path: path.to_string_lossy().into_owned(),
        hash,
        size: scan.bytes,
        files: scan.files.len() as u32,
        linked_to,
        is_link,
        skipped: scan.skipped.into_iter().take(50).collect(),
        problem,
    };
    Some((info, frontmatter))
}

/// This machine's user skills in every home.
pub fn inventory_of(roots: &[(SkillHome, PathBuf)]) -> SkillInventory {
    let homes = roots
        .iter()
        .map(|(home, path)| SkillHomeInfo { home: *home, path: path.to_string_lossy().into_owned(), exists: path.is_dir() })
        .collect();
    let mut skills: BTreeMap<String, MachineSkill> = BTreeMap::new();
    for (home, root) in roots {
        for (name, path) in find_skills(root) {
            let Some((copy, frontmatter)) = copy_at(roots, *home, &name, &path) else { continue };
            let skill = skills.entry(name.clone()).or_insert_with(|| MachineSkill {
                name: name.clone(),
                display_name: None,
                description: None,
                copies: Vec::new(),
            });
            if let Some(frontmatter) = frontmatter {
                if skill.display_name.is_none() {
                    skill.display_name = frontmatter.display_name.filter(|value| *value != name);
                }
                if skill.description.is_none() {
                    skill.description = frontmatter.description;
                }
            }
            skill.copies.push(copy);
        }
    }
    let mut skills: Vec<MachineSkill> = skills.into_values().collect();
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    SkillInventory { homes, skills, os: os_name() }
}

/// `skills.inventory` and `peer.skills.inventory`.
pub async fn inventory(state: &AppState) -> Result<SkillInventory, RpcError> {
    let roots = state.skill_homes.resolve();
    tokio::task::spawn_blocking(move || inventory_of(&roots)).await.map_err(RpcError::internal)
}

// ---- the network view ----

/// `skills.network_view`: this machine's skills and every member's that answers.
pub async fn network_view(state: &AppState) -> Result<SkillsNetworkView, RpcError> {
    let local = inventory(state).await?;
    let hub = state.orchestrator.remote_hub().cloned();
    let mut members = hub.as_ref().map(|hub| hub.members()).unwrap_or_default();
    let me = |inventory: &SkillInventory| SkillsMachineView {
        id: state.environment_id.clone(),
        name: crate::rpc::hostname(),
        is_self: true,
        state: SkillsMachineState::Reported,
        os: inventory.os.clone(),
        homes: inventory.homes.clone(),
        detail: None,
    };
    let Some(hub) = hub.filter(|_| !members.is_empty()) else {
        let machine = me(&local);
        return Ok(view_of(vec![(machine, Some(local))], &pending(state)));
    };
    members.sort_by(|a, b| b.is_self.cmp(&a.is_self).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let asked = members.iter().map(|member| {
        let (hub, local) = (hub.clone(), local.clone());
        async move {
            let view = |state, detail: Option<String>| SkillsMachineView {
                id: member.id.clone(),
                name: member.name.clone(),
                is_self: member.is_self,
                state,
                os: member.os.clone(),
                homes: Vec::new(),
                detail,
            };
            if member.is_self {
                let mut machine = view(SkillsMachineState::Reported, None);
                machine.homes = local.homes.clone();
                machine.os = local.os.clone();
                return (machine, Some(local));
            }
            if member.status != "online" {
                return (view(SkillsMachineState::Offline, None), None);
            }
            if !supports(member) {
                return (view(SkillsMachineState::Unsupported, None), None);
            }
            let call = hub.call(&member.id, PeerSkillsInventory::NAME, Value::Null);
            match tokio::time::timeout(VIEW_WAIT, call).await {
                Ok(Ok(value)) => match serde_json::from_value::<SkillInventory>(value) {
                    Ok(answer) => {
                        let mut machine = view(SkillsMachineState::Reported, None);
                        machine.homes = answer.homes.clone();
                        if !answer.os.is_empty() {
                            machine.os = answer.os.clone();
                        }
                        (machine, Some(answer))
                    }
                    Err(_) => (view(SkillsMachineState::Unreachable, Some("It answered with something unreadable.".into())), None),
                },
                Ok(Err(CallFailure::Remote(error))) if error.code == codes::METHOD_NOT_FOUND => {
                    (view(SkillsMachineState::Unsupported, None), None)
                }
                Ok(Err(CallFailure::Remote(error))) if error.code == codes::FORBIDDEN => {
                    (view(SkillsMachineState::Unreachable, Some(format!("Files is off for this machine on {}.", member.name))), None)
                }
                Ok(Err(failure)) => (view(SkillsMachineState::Unreachable, Some(failure_text(failure))), None),
                Err(_) => (view(SkillsMachineState::Unreachable, Some("It did not answer in time.".into())), None),
            }
        }
    });
    let answers = futures::future::join_all(asked).await;
    Ok(view_of(answers, &pending(state)))
}

fn failure_text(failure: CallFailure) -> String {
    match failure {
        CallFailure::Offline(reason) | CallFailure::Gone(reason) => reason,
        CallFailure::Remote(error) => error.message,
    }
}

/// A member that listed its features and lacks skill copies cannot take one; one that has not listed any yet
/// (offline, no presence) is assumed able, and a copy waits for it.
fn supports(member: &MemberView) -> bool {
    member.features.is_empty() || member.features.iter().any(|feature| feature == features::SKILLS_SYNC_V1)
}

/// The skill copies this machine still has in its outbox, by skill name.
fn pending(state: &AppState) -> BTreeMap<String, Vec<SkillPending>> {
    let mut pending: BTreeMap<String, Vec<SkillPending>> = BTreeMap::new();
    for outbox_state in [OutboxState::Queued, OutboxState::Sending] {
        for item in state.store.outbox_list(None, Some(outbox_state)).unwrap_or_default() {
            if item.kind != OutboxKind::SkillCopy {
                continue;
            }
            let Ok(payload) = serde_json::from_value::<SkillCopyPayload>(item.payload) else { continue };
            pending.entry(payload.name).or_default().push(SkillPending {
                machine_id: item.target,
                outbox_id: item.id,
                from: state.environment_id.clone(),
            });
        }
    }
    pending
}

/// Lay the answers out per skill, and count the versions.
pub fn view_of(
    answers: Vec<(SkillsMachineView, Option<SkillInventory>)>,
    pending: &BTreeMap<String, Vec<SkillPending>>,
) -> SkillsNetworkView {
    let mut skills: BTreeMap<String, SkillNetworkEntry> = BTreeMap::new();
    for (machine, inventory) in &answers {
        let Some(inventory) = inventory else { continue };
        for skill in &inventory.skills {
            let entry = skills.entry(skill.name.clone()).or_insert_with(|| SkillNetworkEntry {
                name: skill.name.clone(),
                display_name: None,
                description: None,
                machines: Vec::new(),
                versions: Vec::new(),
                differs: false,
                pending: Vec::new(),
            });
            if entry.display_name.is_none() {
                entry.display_name = skill.display_name.clone();
            }
            if entry.description.is_none() {
                entry.description = skill.description.clone();
            }
            entry.machines.push(SkillOnMachine { machine_id: machine.id.clone(), copies: skill.copies.clone() });
        }
    }
    for entry in skills.values_mut() {
        // Each machine counts a version once, however many homes hold it.
        let mut counts: Vec<(String, usize)> = Vec::new();
        for on in &entry.machines {
            let mut seen: Vec<&str> = Vec::new();
            for hash in on.copies.iter().filter_map(|copy| copy.hash.as_deref()) {
                if seen.contains(&hash) {
                    continue;
                }
                seen.push(hash);
                match counts.iter_mut().find(|(known, _)| known == hash) {
                    Some((_, count)) => *count += 1,
                    None => counts.push((hash.to_string(), 1)),
                }
            }
        }
        counts.sort_by_key(|count| std::cmp::Reverse(count.1));
        entry.versions = counts.into_iter().map(|(hash, _)| hash).collect();
        entry.differs = entry.versions.len() > 1;
        entry.pending = pending.get(&entry.name).cloned().unwrap_or_default();
    }
    let mut skills: Vec<SkillNetworkEntry> = skills.into_values().collect();
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    SkillsNetworkView { machines: answers.into_iter().map(|(machine, _)| machine).collect(), skills }
}

// ---- copying ----

/// The source copy a send reads: its home, its canonical folder and what it carries.
struct Source {
    home: SkillHome,
    homes: Vec<SkillHome>,
    scan: SkillScan,
    hash: String,
    shas: Vec<String>,
}

/// Find `name` on this machine and pick the copy to send.
fn source_of(roots: &[(SkillHome, PathBuf)], name: &str, from_home: Option<SkillHome>) -> Result<Source, RpcError> {
    check_name(name)?;
    let copies: Vec<SkillCopyInfo> =
        roots.iter().filter_map(|(home, root)| copy_at(roots, *home, name, &root.join(name)).map(|(copy, _)| copy)).collect();
    if copies.is_empty() {
        return Err(RpcError::new(codes::NOT_FOUND, format!("This machine has no skill called {name}.")));
    }
    let chosen = match from_home {
        Some(home) => copies
            .iter()
            .find(|copy| copy.home == home)
            .ok_or_else(|| RpcError::new(codes::NOT_FOUND, format!("This machine has no {name} in {}.", home.usual_path())))?,
        None => {
            let mut hashes: Vec<Option<&str>> = copies.iter().map(|copy| copy.hash.as_deref()).collect();
            hashes.dedup();
            hashes.sort();
            hashes.dedup();
            if hashes.len() > 1 {
                let places: Vec<&str> = copies.iter().map(|copy| copy.home.usual_path()).collect();
                return Err(invalid(format!("{name} differs between {} on this machine. Choose which one to copy.", places.join(" and "))));
            }
            copies.iter().find(|copy| copy.linked_to.is_none()).unwrap_or(&copies[0])
        }
    };
    if let Some(problem) = &chosen.problem {
        return Err(invalid(format!("{name} can't be copied. {problem}")));
    }
    let scan = scan_skill(Path::new(&chosen.path));
    if let Some(problem) = scan.problem {
        return Err(invalid(format!("{name} can't be copied. {problem}")));
    }
    let (hash, shas) = digest(&scan).map_err(|error| invalid(format!("{name} cannot be read: {error}")))?;
    let mut homes: Vec<SkillHome> =
        copies.iter().filter(|copy| copy.hash.as_deref() == Some(hash.as_str())).map(|copy| copy.home).collect();
    if homes.is_empty() {
        homes.push(chosen.home);
    }
    Ok(Source { home: chosen.home, homes, scan, hash, shas })
}

/// `skills.copy`: on this machine when it is the source, else asked of the source machine.
pub async fn copy(state: &AppState, mut params: SkillsCopyParams) -> Result<SkillsCopyResult, RpcError> {
    if params.to.is_empty() {
        return Err(invalid("Choose at least one machine to copy it to."));
    }
    let from = params.from.take().filter(|from| !from.trim().is_empty());
    let Some(from) = from else { return copy_here(state, params).await };
    if from == state.environment_id {
        return copy_here(state, params).await;
    }
    let hub = state
        .orchestrator
        .remote_hub()
        .cloned()
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "the machine network is not available"))?;
    let source = hub.resolve(&from).map_err(|reason| RpcError::new(codes::NOT_FOUND, reason))?;
    if source.id == state.environment_id {
        return copy_here(state, params).await;
    }
    if source
        .features
        .as_ref()
        .is_some_and(|features| !features.is_empty() && !features.iter().any(|feature| feature == features::SKILLS_SYNC_V1))
    {
        return Err(RpcError::new(
            codes::NOT_AVAILABLE,
            format!("{} needs a newer Kybern to copy skills. Update it from Settings → Machines.", source.name),
        ));
    }
    let request = serde_json::to_value(&params).map_err(RpcError::internal)?;
    match hub.call(&source.id, PeerSkillsCopy::NAME, request).await {
        Ok(value) => serde_json::from_value(value)
            .map_err(|error| RpcError::internal(format!("{} answered with something unreadable: {error}", source.name))),
        Err(CallFailure::Offline(_)) => Err(RpcError::new(
            codes::NOT_AVAILABLE,
            format!("{} is offline, so its skills can't be read. Copy it from a machine that is online.", source.name),
        )),
        Err(CallFailure::Gone(reason)) => Err(RpcError::new(codes::NOT_FOUND, reason)),
        Err(CallFailure::Remote(error)) => Err(match error.code {
            codes::METHOD_NOT_FOUND => RpcError::new(
                codes::NOT_AVAILABLE,
                format!("{} needs a newer Kybern to copy skills. Update it from Settings → Machines.", source.name),
            ),
            codes::FORBIDDEN if error.message.contains("scope") || error.message.contains("machine:") => RpcError::new(
                codes::FORBIDDEN,
                format!(
                    "{} doesn't let this machine read its files. Turn Files on for this machine in Settings → Machines on {}.",
                    source.name, source.name
                ),
            ),
            _ => error,
        }),
    }
}

/// `peer.skills.copy`: another member asks this machine to send one of its skills.
pub async fn serve_copy(state: &AppState, from_machine: &str, mut params: SkillsCopyParams) -> Result<SkillsCopyResult, RpcError> {
    params.from = None;
    tracing::info!(target: TARGET, machine = %from_machine, skill = %params.name, "a member asked this machine to copy a skill");
    copy_here(state, params).await
}

/// Copy one of this machine's skills: here at once, to every other target through the outbox.
async fn copy_here(state: &AppState, params: SkillsCopyParams) -> Result<SkillsCopyResult, RpcError> {
    let roots = state.skill_homes.resolve();
    if roots.is_empty() {
        return Err(RpcError::new(codes::NOT_AVAILABLE, "This machine has no home folder for skills."));
    }
    let source = {
        let (roots, name, from_home) = (roots.clone(), params.name.clone(), params.from_home);
        tokio::task::spawn_blocking(move || source_of(&roots, &name, from_home)).await.map_err(RpcError::internal)??
    };
    let hub = state.orchestrator.remote_hub().cloned();
    let members: Vec<MemberView> = hub.as_ref().map(|hub| hub.members()).unwrap_or_default();
    // Resolve every machine first, so a typo copies nothing.
    let mut chosen: Vec<(String, String, SkillCopyTarget)> = Vec::new();
    for target in &params.to {
        let (id, name) =
            if target.machine == state.environment_id || target.machine.eq_ignore_ascii_case(&crate::rpc::hostname()) && hub.is_none() {
                (state.environment_id.clone(), crate::rpc::hostname())
            } else {
                let hub = hub.as_ref().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "the machine network is not available"))?;
                let resolved = hub.resolve(&target.machine).map_err(|reason| RpcError::new(codes::NOT_FOUND, reason))?;
                (resolved.id, resolved.name)
            };
        let homes = if target.homes.is_empty() { source.homes.clone() } else { target.homes.clone() };
        let mut unique = Vec::new();
        for home in homes {
            if !unique.contains(&home) {
                unique.push(home);
            }
        }
        check_dest(&params.name, &unique, &source.hash, &target.replaces)?;
        if !chosen.iter().any(|(known, _, _)| *known == id) {
            chosen.push((id, name, SkillCopyTarget { machine: target.machine.clone(), homes: unique, replaces: target.replaces.clone() }));
        }
    }
    let mut targets = Vec::new();
    for (id, machine_name, target) in chosen {
        let outcome = |state, outbox_id, placed, error| SkillCopyOutcome {
            machine_id: id.clone(),
            name: machine_name.clone(),
            state,
            outbox_id,
            placed,
            error,
        };
        if id == state.environment_id {
            let files: Vec<PlaceFile> = source
                .scan
                .files
                .iter()
                .zip(&source.shas)
                .map(|(file, sha)| PlaceFile {
                    src: file.path.clone(),
                    rel: file.rel.clone(),
                    sha256: sha.clone(),
                    executable: file.executable,
                })
                .collect();
            let (roots, name, hash, backups) = (roots.clone(), params.name.clone(), source.hash.clone(), state.paths.root.join(BACKUPS));
            let placed =
                tokio::task::spawn_blocking(move || place(&roots, &files, &name, &target.homes, &hash, &target.replaces, &backups))
                    .await
                    .map_err(RpcError::internal)?;
            targets.push(match placed {
                Ok(placed) => outcome(SkillCopyState::Done, None, placed, None),
                Err(error) => outcome(SkillCopyState::Failed, None, Vec::new(), Some(error.message)),
            });
            continue;
        }
        if let Some(member) = members.iter().find(|member| member.id == id)
            && !supports(member)
        {
            targets.push(outcome(
                SkillCopyState::Unsupported,
                None,
                Vec::new(),
                Some(format!("{machine_name} needs a newer Kybern to take skills.")),
            ));
            continue;
        }
        let payload = SkillCopyPayload {
            name: params.name.clone(),
            from_home: source.home,
            homes: target.homes.clone(),
            replaces: target.replaces.clone(),
        };
        supersede_queued(state, &id, &params.name);
        let item = super::outbox::queue(
            state,
            &id,
            OutboxKind::SkillCopy,
            Uuid::now_v7(),
            serde_json::to_value(&payload).map_err(RpcError::internal)?,
        )?;
        targets.push(outcome(SkillCopyState::Queued, Some(item.id), Vec::new(), None));
    }
    Ok(SkillsCopyResult {
        source: state.environment_id.clone(),
        name: params.name,
        hash: source.hash,
        files: source.scan.files.len() as u32,
        bytes: source.scan.bytes,
        skipped: source.scan.skipped,
        targets,
    })
}

/// A newer copy of the same skill to the same machine replaces one still waiting, so a machine that stays away
/// gets the last copy the user made, once.
fn supersede_queued(state: &AppState, target: &str, name: &str) {
    for item in state.store.outbox_list(Some(target), Some(OutboxState::Queued)).unwrap_or_default() {
        if item.kind == OutboxKind::SkillCopy
            && serde_json::from_value::<SkillCopyPayload>(item.payload.clone()).is_ok_and(|payload| payload.name == name)
        {
            let _ = super::outbox::cancel(state, OutboxIdParams { id: item.id });
        }
    }
}

// ---- delivery (the outbox worker, on the source) ----

/// Deliver a queued `skill_copy` item: the skill as it is now, sent with the file send.
pub async fn deliver(state: &AppState, item: &OutboxItem) -> Delivery {
    let Some(hub) = state.orchestrator.remote_hub().cloned() else {
        return Delivery::Failed("This daemon cannot reach other machines.".into());
    };
    let payload: SkillCopyPayload = match serde_json::from_value(item.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => return Delivery::Failed(format!("The queued copy is unreadable: {error}")),
    };
    let roots = state.skill_homes.resolve();
    let Some(root) = root_of(&roots, payload.from_home).map(Path::to_path_buf) else {
        return Delivery::Failed("This machine has no home folder for skills.".into());
    };
    let dir = root.join(&payload.name);
    let scanned = tokio::task::spawn_blocking(move || {
        let scan = scan_skill(&dir);
        if let Some(problem) = &scan.problem {
            return Err(problem.clone());
        }
        digest(&scan).map(|(hash, shas)| (scan, hash, shas)).map_err(|error| format!("It cannot be read: {error}"))
    })
    .await;
    let (scan, hash, shas) = match scanned {
        Ok(Ok(found)) => found,
        Ok(Err(problem)) => {
            return Delivery::Failed(format!("{} in {} can't be copied any more. {problem}", payload.name, payload.from_home.usual_path()));
        }
        Err(_) => return Delivery::Retry("The scan was interrupted.".into()),
    };
    let leaf = payload.name.rsplit('/').next().unwrap_or(&payload.name).to_string();
    let entries: Vec<PushEntry> = scan
        .files
        .iter()
        .zip(&shas)
        .map(|(file, sha)| PushEntry { path: file.rel.clone(), size: file.size, sha256: sha.clone(), executable: file.executable })
        .collect();
    let begin = PeerFilesBeginParams {
        transfer_id: item.operation_id,
        name: leaf,
        is_folder: true,
        dest: PushDest::Skill {
            name: payload.name.clone(),
            homes: payload.homes.clone(),
            hash: hash.clone(),
            replaces: payload.replaces.clone(),
        },
        entries,
    };
    let paths: Vec<PathBuf> = scan.files.iter().map(|file| file.path.clone()).collect();
    let name = payload.name.clone();
    let map = |hub: &std::sync::Arc<dyn RemoteHub>, target: &str, failure: CallFailure| -> Delivery {
        if let CallFailure::Remote(error) = &failure
            && error.code == codes::CONFLICT
            && let Some(conflict) = error
                .data
                .as_ref()
                .and_then(|data| data.get("skill_conflict"))
                .and_then(|value| serde_json::from_value::<SkillConflict>(value.clone()).ok())
        {
            let machine = hub.target(target).map_or_else(|| "That machine".to_string(), |target| target.name);
            return Delivery::Failed(format!(
                "{machine} has a different {name} in {} now, so it was kept. Look at the skills again and choose Replace to copy over it.",
                conflict.home.usual_path()
            ));
        }
        super::files_push::failure_delivery(hub, target, failure)
    };
    match super::files_push::stream(state, &hub, item, &begin, &paths, &map).await {
        Ok(finished) => match finished.skill {
            Some(landed) => Delivery::Delivered(serde_json::to_value(landed).unwrap_or(Value::Null)),
            None => Delivery::Delivered(json!({ "name": payload.name, "hash": hash, "placed": [] })),
        },
        Err(delivery) => delivery,
    }
}

// ---- landing (the target) ----

/// One file to put in place: where its bytes are now, and its path in the skill.
#[derive(Debug, Clone)]
pub struct PlaceFile {
    pub src: PathBuf,
    pub rel: String,
    pub sha256: String,
    pub executable: bool,
}

enum Plan {
    Write,
    Replace,
    Same,
    Linked,
}

fn conflict(home: SkillHome, path: &Path, hash: Option<String>, message: String) -> RpcError {
    let data = SkillConflict { home, path: path.to_string_lossy().into_owned(), hash };
    RpcError::new(codes::CONFLICT, message).with_data(json!({ "skill_conflict": data }))
}

/// Where `name` goes in `home`, and what is there: checked without writing anything.
fn plan_home(
    roots: &[(SkillHome, PathBuf)],
    parts: &[&str],
    name: &str,
    home: SkillHome,
    homes: &[SkillHome],
    hash: &str,
    replaces: &[String],
) -> Result<(PathBuf, PathBuf, Plan), RpcError> {
    let root = root_of(roots, home)
        .ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, format!("This machine has no {} folder.", home.usual_path())))?;
    // The home folder itself may be a link (a dotfiles checkout); what is under it may not.
    let base = match std::fs::canonicalize(root) {
        Ok(base) if base.is_dir() => base,
        Ok(_) => return Err(RpcError::new(codes::CONFLICT, format!("{} is a file, not a folder.", spelled(root)))),
        Err(_) => root.to_path_buf(),
    };
    let mut dest = base.clone();
    for part in &parts[..parts.len() - 1] {
        dest.push(part);
        match std::fs::symlink_metadata(&dest) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(forbidden(format!("{} goes through a link, so nothing is written there.", spelled(&dest))));
            }
            Ok(meta) if !meta.is_dir() => {
                return Err(RpcError::new(codes::CONFLICT, format!("{} is a file, not a folder.", spelled(&dest))));
            }
            _ => {}
        }
    }
    dest.push(parts[parts.len() - 1]);
    let plan = match std::fs::symlink_metadata(&dest) {
        Err(_) => Plan::Write,
        Ok(meta) if meta.file_type().is_symlink() => {
            let resolved = std::fs::canonicalize(&dest).ok();
            // A link to this skill in another home that this copy also writes is that copy.
            let into_chosen = resolved.as_ref().is_some_and(|resolved| {
                homes
                    .iter()
                    .filter(|other| **other != home)
                    .filter_map(|other| root_of(roots, *other))
                    .any(|root| std::fs::canonicalize(root.join(name)).is_ok_and(|target| &target == resolved))
            });
            if into_chosen {
                Plan::Linked
            } else {
                let there = resolved
                    .filter(|path| path.is_dir())
                    .map(|path| scan_skill(&path))
                    .filter(|scan| scan.problem.is_none())
                    .and_then(|scan| digest(&scan).ok())
                    .map(|(hash, _)| hash);
                if there.as_deref() == Some(hash) {
                    Plan::Same
                } else {
                    return Err(conflict(
                        home,
                        &dest,
                        there,
                        format!(
                            "{} is a link to another folder, so Kybern doesn't replace it. Change it there, or remove the link first.",
                            spelled(&dest)
                        ),
                    ));
                }
            }
        }
        Ok(meta) if meta.is_dir() => {
            let scan = scan_skill(&dest);
            let there = if scan.problem.is_none() { digest(&scan).ok().map(|(hash, _)| hash) } else { None };
            match there {
                Some(there) if there == hash => Plan::Same,
                Some(there) if replaces.contains(&there) => Plan::Replace,
                there => {
                    return Err(conflict(
                        home,
                        &dest,
                        there,
                        format!("{} holds a different version, so it was kept. Choose Replace to copy over it.", spelled(&dest)),
                    ));
                }
            }
        }
        Ok(_) => return Err(conflict(home, &dest, None, format!("{} is a file, not a skill folder.", spelled(&dest)))),
    };
    Ok((base, dest, plan))
}

/// Check every home before a send moves its bytes: the same checks [`place`] makes, writing nothing.
pub fn preflight(roots: &[(SkillHome, PathBuf)], name: &str, homes: &[SkillHome], hash: &str, replaces: &[String]) -> Result<(), RpcError> {
    let parts = check_name(name)?;
    for home in homes {
        plan_home(roots, &parts, name, *home, homes, hash, replaces)?;
    }
    Ok(())
}

/// Put a skill in each home. Every home is checked before anything is written, so a conflict in one leaves
/// all of them as they were. `files` must hash to `hash`.
pub fn place(
    roots: &[(SkillHome, PathBuf)],
    files: &[PlaceFile],
    name: &str,
    homes: &[SkillHome],
    hash: &str,
    replaces: &[String],
    backups: &Path,
) -> Result<Vec<SkillPlaced>, RpcError> {
    let parts = check_name(name)?;
    if folder_hash(files.iter().map(|file| (file.rel.as_str(), file.sha256.as_str()))) != hash
        || !files.iter().any(|file| file.rel == "SKILL.md")
    {
        return Err(invalid("The skill's files do not match its version."));
    }
    for file in files {
        let rel_parts = super::files_push::clean_relative(&file.rel)?;
        if looks_secret(&rel_parts) {
            return Err(forbidden(format!("{} looks like a secret, so it is not copied.", file.rel)));
        }
    }
    let mut plans = Vec::new();
    for home in homes {
        if plans.iter().any(|(known, _, _, _)| known == home) {
            continue;
        }
        let (base, dest, plan) = plan_home(roots, &parts, name, *home, homes, hash, replaces)?;
        plans.push((*home, base, dest, plan));
    }
    let stamp = format!("{}-{}", Utc::now().format("%Y%m%dT%H%M%S"), &Uuid::now_v7().simple().to_string()[24..]);
    let mut placed = Vec::new();
    for (home, base, dest, plan) in plans {
        let path = dest.to_string_lossy().into_owned();
        match plan {
            Plan::Same => placed.push(SkillPlaced { home, path, action: SkillPlaceAction::Same, backup: None }),
            Plan::Linked => placed.push(SkillPlaced { home, path, action: SkillPlaceAction::Linked, backup: None }),
            Plan::Write => {
                write_skill(&base, &dest, files)?;
                placed.push(SkillPlaced { home, path, action: SkillPlaceAction::Written, backup: None });
            }
            Plan::Replace => {
                let backup = backups.join(&stamp).join(home.as_str()).join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
                if let Some(parent) = backup.parent() {
                    std::fs::create_dir_all(parent).map_err(RpcError::internal)?;
                }
                move_dir(&dest, &backup).map_err(|error| RpcError::internal(format!("Could not set the old {name} aside: {error}")))?;
                if let Err(error) = write_skill(&base, &dest, files) {
                    // Put the old version back: a failed copy changes nothing.
                    let _ = std::fs::remove_dir_all(&dest);
                    let _ = move_dir(&backup, &dest);
                    return Err(error);
                }
                tracing::info!(target: TARGET, skill = %name, home = %home, backup = %backup.display(), "replaced a skill");
                placed.push(SkillPlaced {
                    home,
                    path,
                    action: SkillPlaceAction::Replaced,
                    backup: Some(backup.to_string_lossy().into_owned()),
                });
            }
        }
    }
    Ok(placed)
}

/// Write the files into a hidden folder beside `dest`, then rename it into place.
fn write_skill(base: &Path, dest: &Path, files: &[PlaceFile]) -> Result<(), RpcError> {
    let parent = dest.parent().ok_or_else(|| RpcError::internal("no parent folder"))?;
    std::fs::create_dir_all(parent).map_err(RpcError::internal)?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(RpcError::internal)?;
    let canonical_base = std::fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    if !canonical_parent.starts_with(&canonical_base) {
        return Err(forbidden("The destination leads outside the skill folder."));
    }
    let hold = canonical_parent.join(format!(".kybern-skill-{}", Uuid::now_v7().simple()));
    std::fs::create_dir(&hold).map_err(RpcError::internal)?;
    let written = (|| -> std::io::Result<()> {
        for file in files {
            let target = hold.join(file.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(dir) = target.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::copy(&file.src, &target)?;
            set_mode(&target, file.executable)?;
        }
        std::fs::rename(&hold, dest)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&hold);
        return Err(RpcError::internal(format!("Could not write the skill: {error}")));
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, executable: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _executable: bool) -> std::io::Result<()> {
    Ok(())
}

/// Rename a folder, or copy it and remove the original when it is on another file system.
fn move_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_tree(from, to)?;
    std::fs::remove_dir_all(from)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let meta = std::fs::symlink_metadata(entry.path())?;
        let target = to.join(entry.file_name());
        if meta.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if meta.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::testutil::TempDir;

    /// A fake home folder and the homes in it. Nothing here reads the real ones: `SkillHomes` resolves nothing
    /// under `cfg(test)` until a test sets its own.
    fn homes_in(dir: &Path, env: &[(&str, String)]) -> Vec<(SkillHome, PathBuf)> {
        let homes = SkillHomes::default();
        assert!(homes.resolve().is_empty(), "tests never see the machine's own homes");
        let mut vars: BTreeMap<String, String> = env.iter().map(|(key, value)| (key.to_string(), value.clone())).collect();
        vars.insert("OMP_PROFILE".into(), String::new());
        homes.set(vars, dir.to_path_buf());
        homes.resolve()
    }

    fn skill(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn canonical(dir: &TempDir) -> PathBuf {
        std::fs::canonicalize(dir.path()).unwrap()
    }

    fn files_of(dir: &Path) -> (Vec<PlaceFile>, String) {
        let scan = scan_skill(dir);
        assert!(scan.problem.is_none(), "{:?}", scan.problem);
        let (hash, shas) = digest(&scan).unwrap();
        let files = scan
            .files
            .iter()
            .zip(shas)
            .map(|(file, sha256)| PlaceFile { src: file.path.clone(), rel: file.rel.clone(), sha256, executable: file.executable })
            .collect();
        (files, hash)
    }

    #[test]
    fn every_harness_home_is_found_under_the_home_folder_and_follows_its_variables() {
        let dir = TempDir::new("skill-homes");
        let home = canonical(&dir);
        let roots = homes_in(&home, &[]);
        let path = |kind| root_of(&roots, kind).unwrap().to_path_buf();
        assert_eq!(path(SkillHome::Agents), home.join(".agents/skills"));
        assert_eq!(path(SkillHome::Claude), home.join(".claude/skills"));
        assert_eq!(path(SkillHome::Codex), home.join(".codex/skills"));
        assert_eq!(path(SkillHome::Cursor), home.join(".cursor/skills"));
        assert_eq!(path(SkillHome::Opencode), home.join(".config/opencode/skills"));
        assert_eq!(path(SkillHome::Pi), home.join(".pi/agent/skills"));
        assert_eq!(path(SkillHome::Omp), home.join(".omp/agent/skills"));

        let moved = homes_in(
            &home,
            &[
                ("CLAUDE_CONFIG_DIR", home.join("cc").to_string_lossy().into_owned()),
                ("CODEX_HOME", "~/cx".into()),
                ("XDG_CONFIG_HOME", home.join("xdg").to_string_lossy().into_owned()),
                ("PI_CODING_AGENT_DIR", home.join("pa").to_string_lossy().into_owned()),
            ],
        );
        let path = |kind| root_of(&moved, kind).unwrap().to_path_buf();
        assert_eq!(path(SkillHome::Claude), home.join("cc/skills"));
        assert_eq!(path(SkillHome::Codex), home.join("cx/skills"));
        assert_eq!(path(SkillHome::Opencode), home.join("xdg/opencode/skills"));
        assert_eq!(path(SkillHome::Pi), home.join("pa/skills"));
    }

    #[test]
    fn the_inventory_lists_user_skills_per_home_with_links_and_hashes() {
        let dir = TempDir::new("skill-inventory");
        let home = canonical(&dir);
        let roots = homes_in(&home, &[]);
        skill(&home.join(".agents/skills/review"), "---\nname: Review\ndescription: Reviews code.\n---\nBody");
        skill(&home.join(".codex/skills/review"), "---\nname: Review\ndescription: Reviews code.\n---\nBody");
        skill(&home.join(".cursor/skills/team/deploy"), "---\ndescription: Ships it.\n---\n");
        skill(&home.join(".config/opencode/skills/review"), "---\nname: Review\n---\nAn older body");
        // Codex's built-in skills and a trash folder are not the user's.
        skill(&home.join(".codex/skills/.system/builtin"), "x");
        skill(&home.join(".claude/skills/.trash/old"), "x");
        // A folder without SKILL.md is searched (a category), a skill is not searched inside.
        skill(&home.join(".agents/skills/review/examples/nested"), "x");
        skill(&home.join(".codex/skills/review/examples/nested"), "x");
        #[cfg(unix)]
        std::os::unix::fs::symlink(home.join(".agents/skills/review"), home.join(".claude/skills/review")).unwrap();

        let inventory = inventory_of(&roots);
        let names: Vec<&str> = inventory.skills.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, ["review", "team/deploy"]);
        let review = &inventory.skills[0];
        assert_eq!(review.description.as_deref(), Some("Reviews code."));
        assert_eq!(review.display_name.as_deref(), Some("Review"));
        let by_home = |home| review.copies.iter().find(|copy| copy.home == home).unwrap();
        assert_eq!(by_home(SkillHome::Agents).hash, by_home(SkillHome::Codex).hash, "the same files hash the same in any home");
        assert_ne!(by_home(SkillHome::Agents).hash, by_home(SkillHome::Opencode).hash);
        assert_eq!(by_home(SkillHome::Agents).files, 2, "SKILL.md and the nested example");
        #[cfg(unix)]
        {
            let linked = by_home(SkillHome::Claude);
            assert!(linked.is_link);
            assert_eq!(linked.linked_to, Some(SkillHome::Agents));
            assert_eq!(linked.hash, by_home(SkillHome::Agents).hash);
        }
        assert!(inventory.homes.iter().any(|info| info.home == SkillHome::Omp && !info.exists));
    }

    #[test]
    fn a_copy_leaves_out_links_version_control_dependencies_and_secrets_and_lists_them() {
        let dir = TempDir::new("skill-scan");
        let root = canonical(&dir).join("s");
        skill(&root, "---\nname: s\n---\n");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/index.js"), "x").unwrap();
        std::fs::write(root.join(".env"), "TOKEN=1").unwrap();
        std::fs::write(root.join(".env.example"), "TOKEN=").unwrap();
        std::fs::write(root.join("id_ed25519"), "key").unwrap();
        std::fs::write(root.join("id_ed25519.pub"), "pub").unwrap();
        std::fs::write(root.join("cert.pem"), "pem").unwrap();
        std::fs::write(root.join("credentials.json"), "{}").unwrap();
        std::fs::write(root.join(".DS_Store"), "mac").unwrap();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts/run.sh"), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("scripts/run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", root.join("hosts")).unwrap();
        }
        let scan = scan_skill(&root);
        assert!(scan.problem.is_none());
        let rels: Vec<&str> = scan.files.iter().map(|file| file.rel.as_str()).collect();
        assert_eq!(rels, [".env.example", "SKILL.md", "id_ed25519.pub", "scripts/run.sh"]);
        for left_out in [".git/", "node_modules/", ".env", "id_ed25519", "cert.pem", "credentials.json"] {
            assert!(scan.skipped.iter().any(|skipped| skipped == left_out), "{left_out} in {:?}", scan.skipped);
        }
        assert!(!scan.skipped.iter().any(|skipped| skipped == ".DS_Store"), "clutter is left out quietly");
        #[cfg(unix)]
        {
            assert!(scan.skipped.iter().any(|skipped| skipped == "hosts"), "a link inside a skill is never followed");
            assert!(scan.files.iter().find(|file| file.rel == "scripts/run.sh").unwrap().executable);
        }
        // Clutter and modes do not change the version.
        let (before, _) = digest(&scan).unwrap();
        std::fs::remove_file(root.join(".DS_Store")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.join("scripts/run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        assert_eq!(digest(&scan_skill(&root)).unwrap().0, before);
        std::fs::write(root.join("SKILL.md"), "---\nname: s\n---\nchanged").unwrap();
        assert_ne!(digest(&scan_skill(&root)).unwrap().0, before);
    }

    #[test]
    fn a_skill_over_the_cap_cannot_be_copied() {
        let dir = TempDir::new("skill-cap");
        let root = canonical(&dir).join("big");
        skill(&root, "x");
        let file = std::fs::File::create(root.join("blob.bin")).unwrap();
        file.set_len(MAX_SKILL_COPY_BYTES + 1).unwrap();
        let scan = scan_skill(&root);
        assert!(scan.problem.as_deref().is_some_and(|problem| problem.contains("20 MiB")), "{:?}", scan.problem);
        let roots = homes_in(&canonical(&dir), &[]);
        std::fs::create_dir_all(canonical(&dir).join(".agents/skills")).unwrap();
        std::fs::rename(&root, canonical(&dir).join(".agents/skills/big")).unwrap();
        let error = source_of(&roots, "big", None).err().unwrap();
        assert!(error.message.contains("20 MiB"), "{}", error.message);
    }

    #[test]
    fn names_cannot_climb_out_of_a_home_or_name_hidden_folders() {
        for bad in ["", "..", "../x", "a/../b", "/etc", ".system/x", "a/.git", "node_modules", "a\\b", "C:", "a/b/c/d", ".env"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(check_name("team/review").unwrap(), ["team", "review"]);
    }

    #[test]
    fn placing_writes_keeps_the_same_refuses_a_different_version_and_replaces_with_a_backup() {
        let dir = TempDir::new("skill-place");
        let base = canonical(&dir);
        let source = base.join("source/review");
        skill(&source, "---\nname: review\n---\nv2");
        std::fs::create_dir_all(source.join("bin")).unwrap();
        std::fs::write(source.join("bin/tool"), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(source.join("bin/tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (files, hash) = files_of(&source);
        let home = base.join("home");
        let roots = homes_in(&home, &[]);
        let backups = base.join("data").join(BACKUPS);

        // Missing in both homes: written to both, executable bit kept.
        let placed = place(&roots, &files, "review", &[SkillHome::Agents, SkillHome::Claude], &hash, &[], &backups).unwrap();
        assert_eq!(placed.iter().map(|placed| placed.action).collect::<Vec<_>>(), [SkillPlaceAction::Written, SkillPlaceAction::Written]);
        let landed = home.join(".claude/skills/review");
        assert_eq!(std::fs::read_to_string(landed.join("SKILL.md")).unwrap(), "---\nname: review\n---\nv2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(landed.join("bin/tool")).unwrap().permissions().mode() & 0o777, 0o755);
            assert_eq!(std::fs::metadata(landed.join("SKILL.md")).unwrap().permissions().mode() & 0o777, 0o644);
        }
        // Again: the same version is left alone.
        let again = place(&roots, &files, "review", &[SkillHome::Claude], &hash, &[], &backups).unwrap();
        assert_eq!(again[0].action, SkillPlaceAction::Same);

        // A different version in Codex is kept unless its hash was agreed to, and then nothing else is written.
        let old = home.join(".codex/skills/review");
        skill(&old, "mine");
        let old_hash = digest(&scan_skill(&old)).unwrap().0;
        let refused = place(&roots, &files, "review", &[SkillHome::Cursor, SkillHome::Codex], &hash, &[], &backups).unwrap_err();
        assert_eq!(refused.code, codes::CONFLICT);
        let data: SkillConflict = serde_json::from_value(refused.data.unwrap()["skill_conflict"].clone()).unwrap();
        assert_eq!((data.home, data.hash.as_deref()), (SkillHome::Codex, Some(old_hash.as_str())));
        assert!(!home.join(".cursor/skills/review").exists(), "a conflict in one home writes no home");
        assert_eq!(std::fs::read_to_string(old.join("SKILL.md")).unwrap(), "mine");
        assert!(preflight(&roots, "review", &[SkillHome::Codex], &hash, &[]).is_err(), "the announcement is refused the same way");

        let replaced = place(&roots, &files, "review", &[SkillHome::Codex], &hash, std::slice::from_ref(&old_hash), &backups).unwrap();
        assert_eq!(replaced[0].action, SkillPlaceAction::Replaced);
        let backup = PathBuf::from(replaced[0].backup.as_ref().unwrap());
        assert!(backup.starts_with(&backups), "the backup is outside every home: {backup:?}");
        assert_eq!(std::fs::read_to_string(backup.join("SKILL.md")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(old.join("SKILL.md")).unwrap(), "---\nname: review\n---\nv2");
        assert!(
            std::fs::read_dir(home.join(".codex/skills"))
                .unwrap()
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().starts_with(".kybern"))
        );

        // Files that do not hash to the announced version are refused.
        let mut tampered = files.clone();
        tampered[0].sha256 = "0".repeat(64);
        assert!(place(&roots, &tampered, "review", &[SkillHome::Pi], &hash, &[], &backups).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_never_replaced_or_written_through() {
        let dir = TempDir::new("skill-links");
        let base = canonical(&dir);
        let source = base.join("source/review");
        skill(&source, "v2");
        let (files, hash) = files_of(&source);
        let home = base.join("home");
        let roots = homes_in(&home, &[]);
        let backups = base.join(BACKUPS);
        let outside = base.join("outside");
        skill(&outside.join("review"), "elsewhere");
        let outside_hash = digest(&scan_skill(&outside.join("review"))).unwrap().0;

        // A skill folder that links elsewhere is kept, even when its version was agreed to.
        std::fs::create_dir_all(home.join(".claude/skills")).unwrap();
        std::os::unix::fs::symlink(outside.join("review"), home.join(".claude/skills/review")).unwrap();
        let refused =
            place(&roots, &files, "review", &[SkillHome::Claude], &hash, std::slice::from_ref(&outside_hash), &backups).unwrap_err();
        assert_eq!(refused.code, codes::CONFLICT);
        assert_eq!(std::fs::read_to_string(outside.join("review/SKILL.md")).unwrap(), "elsewhere");

        // A link to this skill in another home that is also written is that copy.
        std::fs::remove_file(home.join(".claude/skills/review")).unwrap();
        std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
        std::os::unix::fs::symlink(home.join(".agents/skills/review"), home.join(".claude/skills/review")).unwrap();
        skill(&home.join(".agents/skills/review"), "v1");
        let v1 = digest(&scan_skill(&home.join(".agents/skills/review"))).unwrap().0;
        let placed = place(&roots, &files, "review", &[SkillHome::Agents, SkillHome::Claude], &hash, &[v1], &backups).unwrap();
        assert_eq!(placed.iter().map(|placed| placed.action).collect::<Vec<_>>(), [SkillPlaceAction::Replaced, SkillPlaceAction::Linked]);
        assert!(std::fs::symlink_metadata(home.join(".claude/skills/review")).unwrap().file_type().is_symlink(), "the link stays a link");
        assert_eq!(std::fs::read_to_string(home.join(".claude/skills/review/SKILL.md")).unwrap(), "v2");

        // A category folder that is a link is not written through.
        std::os::unix::fs::symlink(&outside, home.join(".cursor-team")).unwrap();
        std::fs::create_dir_all(home.join(".cursor/skills")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".cursor/skills/team")).unwrap();
        let through = place(&roots, &files, "team/review", &[SkillHome::Cursor], &hash, &[], &backups).unwrap_err();
        assert_eq!(through.code, codes::FORBIDDEN);
    }

    #[test]
    fn the_view_counts_each_machines_version_once_and_marks_differences() {
        let machine = |id: &str| SkillsMachineView {
            id: id.into(),
            name: id.into(),
            is_self: id == "a",
            state: SkillsMachineState::Reported,
            os: "linux".into(),
            homes: Vec::new(),
            detail: None,
        };
        let copy = |home, hash: &str| SkillCopyInfo {
            home,
            path: String::new(),
            hash: Some(hash.into()),
            size: 1,
            files: 1,
            linked_to: None,
            is_link: false,
            skipped: Vec::new(),
            problem: None,
        };
        let inventory = |skills: Vec<(&str, Vec<SkillCopyInfo>)>| SkillInventory {
            homes: Vec::new(),
            skills: skills
                .into_iter()
                .map(|(name, copies)| MachineSkill { name: name.into(), display_name: None, description: None, copies })
                .collect(),
            os: "linux".into(),
        };
        let view = view_of(
            vec![
                (
                    machine("a"),
                    Some(inventory(vec![
                        ("x", vec![copy(SkillHome::Agents, "h1"), copy(SkillHome::Claude, "h1")]),
                        ("y", vec![copy(SkillHome::Agents, "h3")]),
                    ])),
                ),
                (machine("b"), Some(inventory(vec![("x", vec![copy(SkillHome::Agents, "h1")])]))),
                (machine("c"), Some(inventory(vec![("x", vec![copy(SkillHome::Claude, "h2")])]))),
                (SkillsMachineView { state: SkillsMachineState::Offline, ..machine("d") }, None),
            ],
            &BTreeMap::new(),
        );
        assert_eq!(view.machines.len(), 4);
        let x = &view.skills[0];
        assert_eq!(x.versions, ["h1", "h2"], "the most common first, one count per machine");
        assert!(x.differs);
        assert_eq!(x.machines.len(), 3);
        assert!(!view.skills[1].differs);
    }
}
