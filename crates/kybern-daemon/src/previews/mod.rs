//! In-app browser preview (ADE-34): ticketed file serving, probing, port
//! discovery and the dev-server proxy. See the module docs of each file.
//!
//! This file holds the shared, security-sensitive pieces: the address
//! classifier (`is_local_or_private_host`), target resolution for
//! `previews.open` and the agent tool, root selection and folder grants.

pub mod agent;
pub mod discovery;
pub mod files;
pub mod mime;
pub mod probe;
pub mod proxy;
pub mod tickets;

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Component, Path, PathBuf};

use kybern_protocol::methods::{PreviewFolderRequest, PreviewTargetInfo};

// ---- address classification ----

/// Whether `host` (a URL host as written: no port, no userinfo) is a loopback
/// or private-network address that the daemon may probe, forward to and
/// strip frame headers for. SSRF-critical, so deliberately strict:
///
/// - IPv4 must be strict dotted decimal (127/8, 0.0.0.0, 10/8, 172.16/12,
///   192.168/16, 100.64/10). Decimal, hex and octal forms are not local here.
/// - IPv6: `::1`, `::`, `fe80::/10`, `fc00::/7`. IPv4-mapped and
///   IPv4-compatible forms are rejected.
/// - Names: only `localhost`, `*.localhost` and `*.local`. No other name is
///   ever resolved or trusted, so a DNS name cannot point inside.
/// - Trailing dots, userinfo, ports, paths, whitespace and percent escapes
///   are rejected outright.
pub fn is_local_or_private_host(host: &str) -> bool {
    classify_host(host).is_some()
}

/// Loopback only (the proxy can reach these on the daemon host).
pub fn is_loopback_host(host: &str) -> bool {
    matches!(classify_host(host), Some(HostClass::Loopback))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HostClass {
    Loopback,
    Private,
}

fn classify_host(host: &str) -> Option<HostClass> {
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let bracketed = host.starts_with('[') && host.ends_with(']');
    let inner = if bracketed { &host[1..host.len() - 1] } else { host };
    if inner.contains(':') {
        let ip: Ipv6Addr = inner.parse().ok()?;
        return classify_v6(ip);
    }
    if bracketed {
        return None;
    }
    if !inner.is_ascii() || inner.ends_with('.') || inner.starts_with('.') {
        return None;
    }
    if let Ok(ip) = inner.parse::<Ipv4Addr>() {
        // `Ipv4Addr::from_str` only accepts strict dotted decimal without
        // leading zeros, so `0177.0.0.1`, `0x7f.1` and `2130706433` fall
        // through to the name rules below and fail them.
        return classify_v4(ip);
    }
    let lower = inner.to_ascii_lowercase();
    let valid_labels = lower.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    });
    if !valid_labels {
        return None;
    }
    if lower == "localhost" || lower.ends_with(".localhost") {
        return Some(HostClass::Loopback);
    }
    if lower.ends_with(".local") {
        return Some(HostClass::Private);
    }
    None
}

fn classify_v4(ip: Ipv4Addr) -> Option<HostClass> {
    let o = ip.octets();
    if o[0] == 127 || ip.is_unspecified() {
        Some(HostClass::Loopback)
    } else if o[0] == 10
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 100 && (64..=127).contains(&o[1]))
    {
        Some(HostClass::Private)
    } else {
        None
    }
}

fn classify_v6(ip: Ipv6Addr) -> Option<HostClass> {
    if ip == Ipv6Addr::LOCALHOST || ip == Ipv6Addr::UNSPECIFIED {
        return Some(HostClass::Loopback);
    }
    let segments = ip.segments();
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
    if segments[..5] == [0, 0, 0, 0, 0] && (segments[5] == 0xffff || segments[5] == 0) {
        return None;
    }
    if segments[0] & 0xffc0 == 0xfe80 || segments[0] & 0xfe00 == 0xfc00 {
        return Some(HostClass::Private);
    }
    None
}

// ---- errors ----

/// A user-facing preview failure. `code` is one of `not_found`,
/// `unsupported_file`, `folder_not_grantable`, `invalid_address`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewError {
    pub code: &'static str,
    pub message: String,
}

impl PreviewError {
    fn new(code: &'static str, message: &str) -> Self {
        Self { code, message: message.to_owned() }
    }
    pub fn not_found() -> Self {
        Self::new("not_found", "That file doesn't exist.")
    }
    pub fn unsupported_file() -> Self {
        Self::new("unsupported_file", "Preview an HTML or SVG file.")
    }
    pub fn folder_not_grantable() -> Self {
        Self::new("folder_not_grantable", "Kybern can't preview files from this folder. Move the file into your project or a subfolder.")
    }
    pub fn internal(message: &str) -> Self {
        Self::new("internal_error", message)
    }
    pub fn invalid_address() -> Self {
        Self::new("invalid_address", "Kybern can't open this kind of address.")
    }
}

impl std::fmt::Display for PreviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PreviewError {}

// ---- folder grants ----

/// Where grants may never point. Built once from the daemon's environment.
#[derive(Debug, Clone)]
pub struct GrantPolicy {
    pub home: Option<PathBuf>,
    pub data_dir: PathBuf,
    /// System directories (canonical or not; both forms are compared).
    pub system: Vec<PathBuf>,
}

impl GrantPolicy {
    pub fn new(data_dir: &Path) -> Self {
        let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
        let list: &[&str] = if cfg!(target_os = "macos") {
            &["/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/var", "/private/var", "/dev", "/Library"]
        } else {
            &["/usr", "/bin", "/sbin", "/etc", "/var", "/proc", "/sys", "/dev", "/boot", "/lib", "/lib64"]
        };
        Self {
            home: home.map(|home| home.canonicalize().unwrap_or(home)),
            data_dir: data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf()),
            system: list.iter().map(PathBuf::from).collect(),
        }
    }

    /// Whether `folder` (canonical) may be granted.
    pub fn grantable(&self, folder: &Path) -> bool {
        if !folder.is_absolute() || folder.parent().is_none() {
            return false;
        }
        if folder.components().any(|c| match c {
            Component::Normal(name) => name.to_str().is_none_or(|name| name.starts_with('.')),
            Component::ParentDir | Component::CurDir => true,
            _ => false,
        }) {
            return false;
        }
        // Never an ancestor of the home directory or the data directory
        // (`/`, `/Users`, home itself): that would cover them.
        if let Some(home) = &self.home
            && (home.starts_with(folder) || folder.starts_with(home.join("Library")))
        {
            return false;
        }
        if self.data_dir.starts_with(folder) || folder.starts_with(&self.data_dir) {
            return false;
        }
        !self.system.iter().any(|system| folder.starts_with(system))
    }

    /// Whether a thread's own folder (canonical) may be served whole without a
    /// grant. Unlike a grant it may sit in a dot folder or in the data
    /// directory's worktrees, but it must never cover the home directory, the
    /// data directory (with `daemon.token`) or sit in `~/Library`:
    /// a thread opened on `~` or `/` would otherwise expose every file below it
    /// to the previewed page.
    pub fn servable_thread_root(&self, root: &Path) -> bool {
        if !root.is_absolute() || root.parent().is_none() {
            return false;
        }
        if let Some(home) = &self.home
            && (home.starts_with(root) || root.starts_with(home.join("Library")))
        {
            return false;
        }
        // Projects may live under system prefixes (`/usr/local/src`, temp
        // folders under `/private/var`), so only coverage is refused here.
        !(self.data_dir.starts_with(root) || (root.starts_with(&self.data_dir) && !root.starts_with(self.data_dir.join("worktrees"))))
    }
}

/// Canonical folders from `Settings.preview_allowed_folders` that are still
/// valid grants. Re-validated on every open: a stale or tampered entry that is
/// no longer grantable, missing, or not a directory is ignored.
fn valid_grants(allowed: &[String], policy: &GrantPolicy) -> Vec<PathBuf> {
    allowed
        .iter()
        .filter_map(|raw| {
            let path = Path::new(raw);
            let canonical = path.canonicalize().ok()?;
            (canonical.is_dir() && policy.grantable(&canonical)).then_some(canonical)
        })
        .collect()
}

// ---- resolution ----

/// The folders a thread works in.
#[derive(Debug, Clone)]
pub struct ThreadRoots {
    /// The thread's working directory (its worktree or the project path).
    pub cwd: PathBuf,
    /// The project root, when different from `cwd`.
    pub project: Option<PathBuf>,
}

/// How a file target will be served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePlan {
    /// Canonical root the ticket serves.
    pub root: PathBuf,
    /// Entry document relative to `root`, `/`-separated, not encoded.
    pub rel: String,
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub info: PreviewTargetInfo,
    pub file: Option<FilePlan>,
    pub needs_permission: Option<PreviewFolderRequest>,
    /// A new grant the caller must persist (only with `allow_folder`).
    pub grant: Option<PathBuf>,
}

const REJECTED_SCHEMES: [&str; 7] = ["javascript", "data", "blob", "about", "tauri", "ipc", "kybern"];

/// Resolve the user's raw `target` for `thread`. Pure apart from file system
/// reads; never mints tickets or persists grants.
pub fn resolve(
    input: &str,
    roots: &ThreadRoots,
    allowed_folders: &[String],
    allow_folder: bool,
    policy: &GrantPolicy,
) -> Result<Resolved, PreviewError> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2048 || input.contains('\0') {
        return Err(PreviewError::invalid_address());
    }
    if let Some((scheme, _)) = input.split_once(':') {
        let scheme = scheme.to_ascii_lowercase();
        if REJECTED_SCHEMES.contains(&scheme.as_str()) {
            return Err(PreviewError::invalid_address());
        }
        if scheme == "file" {
            return resolve_file(&file_url_path(input)?, roots, allowed_folders, allow_folder, policy);
        }
        if scheme == "http" || scheme == "https" {
            return resolve_url(input);
        }
        // Any other `scheme://` (ftp, ws, ssh, ...) is not something to preview.
        if input[scheme.len()..].starts_with("://") {
            return Err(PreviewError::invalid_address());
        }
        // `localhost:3000` has a "scheme" of localhost; fall through to host rules.
    }
    if looks_like_path(input) || (has_entry_extension(input) && !input.contains(':')) {
        return resolve_file(input, roots, allowed_folders, allow_folder, policy);
    }
    if let Some(port) = input.strip_prefix(':').unwrap_or(input).parse::<u16>().ok().filter(|port| *port != 0) {
        return resolve_url(&format!("http://localhost:{port}"));
    }
    if (input.contains('.')
        || input.rsplit_once(':').is_some_and(|(_, port)| port.split('/').next().is_some_and(|p| p.parse::<u16>().is_ok())))
        && !input.contains(char::is_whitespace)
    {
        return resolve_url(&format!("http://{input}"));
    }
    Err(PreviewError::invalid_address())
}

fn has_entry_extension(input: &str) -> bool {
    let lower = input.to_ascii_lowercase();
    [".html", ".htm", ".svg", ".xhtml"].iter().any(|ext| lower.ends_with(ext))
}

fn looks_like_path(input: &str) -> bool {
    input.starts_with('/')
        || input.starts_with('~')
        || input.starts_with("./")
        || input.starts_with("../")
        || (input.contains('/') && has_entry_extension(input))
}

fn resolve_url(input: &str) -> Result<Resolved, PreviewError> {
    let url = reqwest::Url::parse(input).map_err(|_| PreviewError::invalid_address())?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err(PreviewError::invalid_address());
    }
    let host = url.host_str().ok_or_else(PreviewError::invalid_address)?;
    let normalized = url.to_string();
    let info = if is_local_or_private_host(host) {
        let port = url.port_or_known_default().ok_or_else(PreviewError::invalid_address)?;
        PreviewTargetInfo::Server { url: normalized, port }
    } else {
        PreviewTargetInfo::External { url: normalized }
    };
    Ok(Resolved { info, file: None, needs_permission: None, grant: None })
}

/// `file:///a/b%20c.html` to `/a/b c.html`. Only an empty or `localhost` host.
fn file_url_path(input: &str) -> Result<String, PreviewError> {
    let rest = input.get(5..).ok_or_else(PreviewError::invalid_address)?.strip_prefix("//").ok_or_else(PreviewError::invalid_address)?;
    let slash = rest.find('/').ok_or_else(PreviewError::invalid_address)?;
    let (host, path) = rest.split_at(slash);
    if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
        return Err(PreviewError::invalid_address());
    }
    let path = path.split(['?', '#']).next().unwrap_or(path);
    percent_decode(path).ok_or_else(PreviewError::invalid_address)
}

fn expand_home(raw: &str, policy: &GrantPolicy) -> Option<PathBuf> {
    if raw == "~" {
        return policy.home.clone();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return policy.home.as_ref().map(|home| home.join(rest));
    }
    if raw.starts_with('~') {
        return None;
    }
    Some(PathBuf::from(raw))
}

fn resolve_file(
    raw: &str,
    roots: &ThreadRoots,
    allowed_folders: &[String],
    allow_folder: bool,
    policy: &GrantPolicy,
) -> Result<Resolved, PreviewError> {
    let expanded = expand_home(raw, policy).ok_or_else(PreviewError::invalid_address)?;
    let absolute = if expanded.is_absolute() { expanded } else { roots.cwd.join(expanded) };
    let entry = absolute.canonicalize().map_err(|_| PreviewError::not_found())?;
    let meta = std::fs::metadata(&entry).map_err(|_| PreviewError::not_found())?;
    if !meta.is_file() || !mime::is_entry_document(&entry) {
        return Err(PreviewError::unsupported_file());
    }
    let canonical_cwd = roots.cwd.canonicalize().ok();
    let canonical_project = roots.project.as_ref().and_then(|project| project.canonicalize().ok());
    let in_root =
        [canonical_cwd, canonical_project].into_iter().flatten().find(|root| entry.starts_with(root) && policy.servable_thread_root(root));
    let (root, in_project) = match in_root {
        Some(root) => (root, true),
        None => (entry.parent().ok_or_else(PreviewError::not_found)?.to_path_buf(), false),
    };
    let rel = relative_entry(&root, &entry)?;
    let info =
        PreviewTargetInfo::File { path: entry.to_string_lossy().into_owned(), root: root.to_string_lossy().into_owned(), in_project };
    if in_project {
        return Ok(Resolved { info, file: Some(FilePlan { root, rel }), needs_permission: None, grant: None });
    }
    let granted = valid_grants(allowed_folders, policy).iter().any(|grant| root.starts_with(grant));
    if granted {
        return Ok(Resolved { info, file: Some(FilePlan { root, rel }), needs_permission: None, grant: None });
    }
    if !policy.grantable(&root) {
        return Err(PreviewError::folder_not_grantable());
    }
    if allow_folder {
        let grant = Some(root.clone());
        return Ok(Resolved { info, file: Some(FilePlan { root, rel }), needs_permission: None, grant });
    }
    let folder = root.to_string_lossy().into_owned();
    Ok(Resolved { info, file: None, needs_permission: Some(PreviewFolderRequest { folder, grantable: true }), grant: None })
}

/// The entry path under `root`. Dot segments cannot be served, so refuse early.
fn relative_entry(root: &Path, entry: &Path) -> Result<String, PreviewError> {
    let rel = entry.strip_prefix(root).map_err(|_| PreviewError::not_found())?;
    let mut parts = Vec::new();
    for component in rel.components() {
        let Component::Normal(name) = component else { return Err(PreviewError::not_found()) };
        let name = name.to_str().ok_or_else(PreviewError::not_found)?;
        if name.starts_with('.') || name.contains('\\') {
            return Err(PreviewError { code: "not_found", message: "Kybern can't preview files in hidden folders.".into() });
        }
        parts.push(name);
    }
    Ok(parts.join("/"))
}

// ---- encoding helpers ----

/// Percent-decode to UTF-8. `None` for malformed escapes or invalid UTF-8.
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Percent-encode each `/`-separated segment (unreserved characters stay).
pub fn encode_path(rel: &str) -> String {
    rel.split('/')
        .map(|segment| {
            segment
                .bytes()
                .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The HTTP path a client loads for a file ticket.
pub fn file_path_for(ticket: &str, rel: &str) -> String {
    format!("/preview-files/{ticket}/{}", encode_path(rel))
}

// ---- daemon glue ----

/// Roots for a thread: its cwd (worktree or project) and its project path.
pub fn thread_roots(store: &kybern_store::Store, thread: &kybern_protocol::Thread) -> ThreadRoots {
    let project = store.project_get(thread.project_id).ok().flatten().map(|project| PathBuf::from(project.path));
    ThreadRoots { cwd: PathBuf::from(&thread.cwd), project }
}

/// Persist a folder grant (canonical) in `settings.json`. Idempotent.
pub fn persist_grant(settings: &crate::settings::SettingsStore, folder: &Path) -> anyhow::Result<()> {
    let mut current = settings.get();
    let value = folder.to_string_lossy().into_owned();
    if !current.preview_allowed_folders.contains(&value) {
        current.preview_allowed_folders.push(value);
        settings.set(current)?;
    }
    Ok(())
}

/// `previews.open`: classify, check grants, persist an approved grant, and
/// mint the ticket a client loads the page with.
pub async fn open(
    state: &crate::state::AppState,
    principal: Option<uuid::Uuid>,
    thread: &kybern_protocol::Thread,
    params: &kybern_protocol::methods::PreviewOpenParams,
) -> Result<kybern_protocol::methods::PreviewOpenResult, PreviewError> {
    use kybern_protocol::methods::PreviewOpenResult;
    let roots = thread_roots(&state.store, thread);
    let policy = GrantPolicy::new(&state.paths.root);
    let allowed = state.settings.get().preview_allowed_folders;
    let resolved = resolve(&params.target, &roots, &allowed, params.allow_folder, &policy)?;
    if let Some(folder) = &resolved.grant {
        persist_grant(&state.settings, folder).map_err(|error| PreviewError::internal(&error.to_string()))?;
    }
    let mut result =
        PreviewOpenResult { target: resolved.info.clone(), ticket: None, path: None, needs_permission: resolved.needs_permission };
    if let Some(plan) = resolved.file {
        let ticket = state.previews.mint(tickets::TicketKind::Files { root: plan.root }, thread.id, principal);
        result.path = Some(file_path_for(&ticket, &plan.rel));
        result.ticket = Some(ticket);
    } else if let (true, PreviewTargetInfo::Server { url, port }) = (params.proxy, &resolved.info) {
        let host = reqwest::Url::parse(url).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default();
        // The proxy only ever reaches loopback on the daemon host.
        if is_loopback_host(&host) {
            // Never a proxy into the daemon's own HTTP API.
            if *port == state.port.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(PreviewError::invalid_address());
            }
            if proxy::listener_addr(*port).await.is_none() {
                return Err(PreviewError { code: "not_found", message: "Nothing is listening on that port yet.".into() });
            }
            let ticket = state.previews.mint(tickets::TicketKind::Proxy { port: *port }, thread.id, principal);
            result.path = Some(format!("/preview-proxy/{ticket}/"));
            result.ticket = Some(ticket);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
