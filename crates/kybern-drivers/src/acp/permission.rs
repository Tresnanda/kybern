//! Permission requests: which ones Kybern answers itself, the Accept edits path check, and picking the
//! agent's option for a decision.

use std::path::{Component, Path, PathBuf};

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
    ToolCallUpdateFields, ToolKind,
};
use kybern_protocol::{ApprovalDecision, PermissionMode};
use serde_json::Value;

/// What a card Kybern raised for the agent waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ask {
    /// `session/request_permission`.
    Permission,
    /// The agent's own question, shown as a question card. Only this takes a `Submit` answer.
    Question,
    /// The agent's plan, shown as a plan to start implementing.
    Plan,
}

/// The answer Kybern gives without asking, if any: everything in Full access (the agent should not ask
/// there), and an edit inside the workspace in Accept edits. Auto's requests are the agent's own
/// classifier refusing something, so they always reach the user.
pub(crate) fn auto_decision(mode: PermissionMode, fields: &ToolCallUpdateFields, cwd: &Path) -> Option<ApprovalDecision> {
    match mode {
        PermissionMode::FullAccess => Some(ApprovalDecision::AllowOnce),
        PermissionMode::AcceptEdits if is_workspace_edit(fields, cwd) => Some(ApprovalDecision::AllowOnce),
        _ => None,
    }
}

/// An edit, delete or move whose every named path lies inside `cwd`: each of its `locations` and each
/// path its `raw_input` names. A move counts only when its destination was found and checked, since its
/// `locations` name the source alone. A request that names no path, or one outside the workspace, still asks.
fn is_workspace_edit(fields: &ToolCallUpdateFields, cwd: &Path) -> bool {
    let Some(kind) = fields.kind.filter(|kind| matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move)) else {
        return false;
    };
    let mut paths: Vec<PathBuf> = fields.locations.iter().flatten().map(|location| location.path.clone()).collect();
    let named = fields.raw_input.as_ref().map(input_paths).unwrap_or_default();
    if kind == ToolKind::Move && !named.iter().any(|named| named.destination) {
        return false;
    }
    paths.extend(named.into_iter().map(|named| PathBuf::from(named.text)));
    !paths.is_empty() && paths.iter().all(|path| inside_workspace(path, cwd))
}

/// Parts of a key that mark its value as a path: `file_path`, `targetDir`, `new_location`, `outputUri`.
/// Matched anywhere in the key, so an unlisted spelling still counts; a false match only makes a
/// relative value be checked as a path too.
const PATH_KEY_PARTS: &[&str] =
    &["path", "file", "dir", "folder", "uri", "url", "location", "dest", "target", "output", "source", "src", "name", "from"];

/// `file_path`, `filePath` and `FilePath` alike.
fn normalized_key(key: &str) -> String {
    key.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

/// A key (normalized) whose value is a path. `to` counts as a whole key or a key's end (`to`, `moveTo`),
/// since inside a word it is too common (`total`, `token`).
fn is_path_key(key: &str) -> bool {
    PATH_KEY_PARTS.iter().any(|part| key.contains(part)) || key.ends_with("to")
}

/// A path key (normalized) that names where a move puts the file.
fn is_destination_key(key: &str) -> bool {
    ["dest", "target", "output"].iter().any(|part| key.contains(part)) || key.starts_with("new") || key.ends_with("to")
}

/// A path a tool's input names.
#[derive(Debug)]
struct NamedPath {
    text: String,
    /// It sits under a key that names a move's destination.
    destination: bool,
}

/// Every path a tool's input names, at any depth. A string is a path when it sits under a path key, at
/// any depth below it (`{"file": {"value": "x"}}`, `{"paths": ["a", "b"]}`), or when it looks like an
/// absolute or home path under any key at all: an unknown key must not carry a write out of the workspace.
fn input_paths(input: &Value) -> Vec<NamedPath> {
    fn walk(value: &Value, path: bool, destination: bool, out: &mut Vec<NamedPath>) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    let key = normalized_key(key);
                    let is_path = is_path_key(&key);
                    walk(value, path || is_path, destination || (is_path && is_destination_key(&key)), out);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, path, destination, out)),
            Value::String(text) => {
                let text = text.trim();
                if !text.is_empty() && (path || looks_like_path(text)) {
                    out.push(NamedPath { text: text.to_owned(), destination: path && destination });
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(input, false, false, &mut out);
    out
}

/// A string under no path key that still reads as an absolute path, a home path or a `file:` URI. Text
/// over several lines is content, not a path, and so is a one-line code comment (`// x`, `/* x */`),
/// which as a path would only name a folder at the root whose name starts with a space or `*`.
fn looks_like_path(text: &str) -> bool {
    if text.contains(['\n', '\r']) {
        return false;
    }
    let comment = text.strip_prefix("//").is_some_and(|rest| rest.starts_with(char::is_whitespace)) || text.starts_with("/*");
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\');
    !comment && (text.starts_with(['/', '\\', '~']) || drive || text.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:")))
}

/// A path whose meaning Kybern can't settle without expanding or interpreting it the way some other
/// program might: `~` and environment variables (`$HOME`, `%USERPROFILE%`), URIs (`file:///etc`), Windows
/// verbatim, device and UNC prefixes (`\\?\`, `\\.\`, `\\server`), and drive-relative paths (`C:foo`).
fn needs_interpretation(text: &str) -> bool {
    if text.starts_with('~') || text.contains('$') || text.starts_with(r"\\") || has_percent_variable(text) {
        return true;
    }
    if cfg!(windows) && text.starts_with("//") {
        return true;
    }
    // `scheme:` as URIs spell it. One letter is a drive: only `C:\` and `C:/` on Windows are plain paths.
    let scheme = text.find(':').map(|colon| &text[..colon]).filter(|scheme| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    match scheme {
        Some(scheme) if scheme.len() == 1 => !(cfg!(windows) && text[2..].starts_with(['/', '\\'])),
        Some(_) => true,
        None => false,
    }
}

/// `%NAME%`, as Windows expands it.
fn has_percent_variable(text: &str) -> bool {
    let parts: Vec<&str> = text.split('%').collect();
    // Only the parts with a `%` on both sides can be names.
    parts.len() >= 3
        && parts[1..parts.len() - 1]
            .iter()
            .any(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '(' | ')')))
}

/// A `.git` folder or file, which holds hooks and config that run code later. Windows drops trailing dots
/// and spaces and ignores case, so `.GIT.` is the same name there.
fn is_git_dir(component: Component<'_>) -> bool {
    matches!(component, Component::Normal(name) if name.to_string_lossy().trim_end_matches(['.', ' ']).eq_ignore_ascii_case(".git"))
}

/// Whether `path` (relative to `cwd`, or absolute) is inside `cwd` once every symlink on the way is followed.
/// The workspace folder itself and anything in a `.git` folder don't count: deleting the root or writing a
/// hook is not an ordinary edit. Nor does a path that needs expanding or interpreting first.
///
/// This checks the file system as it is now. A symlink created between this check and the agent's write
/// can't be prevented here; Accept edits trusts the workspace's own contents that far.
fn inside_workspace(path: &Path, cwd: &Path) -> bool {
    if needs_interpretation(&path.to_string_lossy()) {
        return false;
    }
    let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return false;
    }
    let (Some(path), Ok(root)) = (canonical_existing(&path, 0), cwd.canonicalize()) else {
        return false;
    };
    match path.strip_prefix(&root) {
        Ok(rest) => rest.components().next().is_some() && !rest.components().any(is_git_dir),
        Err(_) => false,
    }
}

/// How many symlinks `canonical_existing` follows before it gives up (the usual `MAXSYMLINKS`).
const MAX_SYMLINKS: usize = 40;

/// `path` with every symlink resolved: its nearest existing ancestor made canonical, with the names that
/// don't exist yet appended. A dangling symlink counts where it points, so a write through it is checked
/// against its target. `None` when that can't be worked out safely (a link loop, an unreadable folder).
fn canonical_existing(path: &Path, links: usize) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(found) = current.canonicalize() {
            return Some(missing.iter().rev().fold(found, |path: PathBuf, part| path.join(part)));
        }
        match std::fs::symlink_metadata(&current) {
            // A dangling link: follow it, from the folder it sits in, and resolve the rest from there.
            Ok(meta) if meta.file_type().is_symlink() => {
                if links >= MAX_SYMLINKS {
                    return None;
                }
                let target = std::fs::read_link(&current).ok()?;
                let target = if target.is_absolute() { target } else { current.parent()?.join(target) };
                let target = missing.iter().rev().fold(target, |path: PathBuf, part| path.join(part));
                return canonical_existing(&target, links + 1);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            // It exists but can't be resolved (permissions, a file used as a folder): don't guess.
            _ => return None,
        }
        let name = match current.components().next_back()? {
            Component::Normal(name) => name.to_owned(),
            // A `..` from a link's target: step back lexically, which the canonical parent then resolves.
            Component::ParentDir => return canonical_parent_dir(&current, &missing, links),
            _ => return None,
        };
        missing.push(name);
        current = current.parent()?.to_path_buf();
    }
}

/// `current` ends in `..` and doesn't exist: resolve what's before it, step up, and add the missing names.
fn canonical_parent_dir(current: &Path, missing: &[std::ffi::OsString], links: usize) -> Option<PathBuf> {
    let before = current.parent()?;
    let resolved = canonical_existing(before, links)?;
    let up = resolved.parent()?.to_path_buf();
    Some(missing.iter().rev().fold(up, |path, part| path.join(part)))
}

/// The agent's option for a Kybern decision, or `None` when it offers none that grants exactly that.
/// Allow for this thread takes `session_grant` only (else allows once): an agent's other allow-always
/// options may save a grant that outlives the thread. Allow once never widens to a session grant. Deny rejects.
pub(crate) fn permission_option<'a>(
    options: &'a [PermissionOption],
    decision: &ApprovalDecision,
    session_grant: Option<&str>,
) -> Option<&'a PermissionOption> {
    let of_kind = |kind: PermissionOptionKind| options.iter().find(|option| option.kind == kind);
    let session = || session_grant.and_then(|grant| options.iter().find(|option| option.option_id.0.trim() == grant));
    match decision {
        ApprovalDecision::AllowOnce => of_kind(PermissionOptionKind::AllowOnce),
        ApprovalDecision::AllowAlways => session().or_else(|| of_kind(PermissionOptionKind::AllowOnce)),
        ApprovalDecision::Deny { .. } | ApprovalDecision::Submit { .. } => {
            of_kind(PermissionOptionKind::RejectOnce).or_else(|| of_kind(PermissionOptionKind::RejectAlways))
        }
    }
}

pub(crate) fn selected(option: &PermissionOption) -> RequestPermissionResponse {
    RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone())))
}

pub(crate) fn cancelled() -> RequestPermissionResponse {
    RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
}

/// What Kybern tells the agent (`name` in the notice) for a decision, and the notice to show when it
/// offered nothing that matches it. A decision the agent can't take is declined (rejected once, else
/// cancelled), never widened; no answer (the turn ended) cancels.
pub(crate) fn permission_response(
    name: &str,
    session_grant: Option<&str>,
    options: &[PermissionOption],
    decision: Option<&ApprovalDecision>,
) -> (RequestPermissionResponse, Option<String>) {
    let Some(decision) = decision else { return (cancelled(), None) };
    if let Some(option) = permission_option(options, decision, session_grant) {
        return (selected(option), None);
    }
    match decision {
        ApprovalDecision::AllowOnce => {
            let decline = permission_option(options, &ApprovalDecision::Deny { reason: None }, session_grant);
            let notice = format!(
                "{name} couldn't allow this just once, so Kybern declined it. To let it run, choose Allow for this thread when it asks again."
            );
            (decline.map_or_else(cancelled, selected), Some(notice))
        }
        _ => (cancelled(), None),
    }
}

/// The answer Kybern sends without showing a card, if any. Full access takes the agent's narrowest allow
/// option; Accept edits allows a workspace edit once, and asks when the agent can't allow it just once.
pub(crate) fn auto_response(
    mode: PermissionMode,
    fields: &ToolCallUpdateFields,
    cwd: &Path,
    options: &[PermissionOption],
    session_grant: Option<&str>,
) -> Option<RequestPermissionResponse> {
    let decision = auto_decision(mode, fields, cwd)?;
    let option = permission_option(options, &decision, session_grant).or_else(|| match mode {
        PermissionMode::FullAccess => permission_option(options, &ApprovalDecision::AllowAlways, session_grant),
        _ => None,
    })?;
    Some(selected(option))
}

#[cfg(test)]
#[path = "permission_tests.rs"]
mod tests;
