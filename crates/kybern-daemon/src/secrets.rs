//! `kybern_request_secret`: ask the user for one secret and write it to an env
//! file in the thread's workspace.
//!
//! The value travels only from the approval answer to the file. It is never
//! returned to the agent, stored (the persistence boundary redacts it, see
//! `ApprovalRequest::redacted_decision`), traced or put in an error message.
//! This module holds the pure parts: argument validation, target resolution
//! and the atomic `.env` writer. The prompt lives in
//! `orchestrator/secret_request.rs`.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use kybern_git::Repo;
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) const TOOL: &str = kybern_protocol::SECRET_REQUEST_TOOL;
const DEFAULT_FILE: &str = ".env";
const DEFAULT_TIMEOUT_SECONDS: u64 = 600;
const MIN_TIMEOUT_SECONDS: u64 = 10;
const MAX_TIMEOUT_SECONDS: u64 = 3600;
const MAX_LABEL_CHARS: usize = 80;
const MAX_REASON_CHARS: usize = 500;
const MAX_PLACEHOLDER_CHARS: usize = 100;
const MAX_KEY_BYTES: usize = 128;
const MAX_FILE_ARG_BYTES: usize = 512;
/// Larger files are not env files; refuse rather than rewrite them.
const MAX_ENV_FILE_BYTES: u64 = 1024 * 1024;
/// Slack on top of the user's wait for the tool call's own budget.
const CALL_SLACK: Duration = Duration::from_secs(30);

pub(crate) fn is_tool(name: &str) -> bool {
    name == TOOL
}

/// How long a call to `name` may run, when it is longer than an ordinary tool
/// call: the user's wait plus slack. Used by every transport that bounds calls.
pub(crate) fn call_budget(name: &str, arguments: &Value) -> Option<Duration> {
    is_tool(name).then(|| {
        let seconds = arguments
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_TIMEOUT_SECONDS, |seconds| seconds.clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS));
        Duration::from_secs(seconds) + CALL_SLACK
    })
}

pub(crate) fn tool_definition() -> kybern_drivers::NativeToolDefinition {
    kybern_drivers::NativeToolDefinition {
        name: TOOL.into(),
        description: concat!(
            "Ask the user for a secret (API key, token, password) and save it to an env file in this workspace. ",
            "Never ask for secrets in chat; use kybern_request_secret. The value is written to the file and never returned to you: ",
            "read it from the environment or the file at runtime, never print it. ",
            "label names the secret, reason says why you need it, env_key is the variable to set (letters, digits and underscores). ",
            "file is relative to the workspace and defaults to \".env\"; it must be inside the workspace and, in a git repository, ignored by git ",
            "(add it to .gitignore first or the call fails). An existing value for env_key is replaced. ",
            "The call waits for the user, up to timeout_seconds (default 600, 10 to 3600). ",
            "status is \"saved\", \"declined\" (the user said no: do not ask again unless they ask you to), \"cancelled\" (the run ended) or \"timed_out\" ",
            "(call again only if you still need it). Result: {status, env_key, file, replaced}."
        )
        .into(),
        input_schema: json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "label": {"type":"string","minLength":1,"maxLength":MAX_LABEL_CHARS,"description":"Short name shown as the card title, e.g. \"Stripe secret key\"."},
                "reason": {"type":"string","minLength":1,"maxLength":MAX_REASON_CHARS,"description":"Why you need it, in a sentence the user can judge."},
                "env_key": {"type":"string","pattern":"^[A-Za-z_][A-Za-z0-9_]*$","maxLength":MAX_KEY_BYTES,"description":"The variable to set, e.g. STRIPE_KEY."},
                "file": {"type":["string","null"],"maxLength":MAX_FILE_ARG_BYTES,"description":"Env file relative to the workspace. Default \".env\". Must be git-ignored."},
                "placeholder": {"type":["string","null"],"maxLength":MAX_PLACEHOLDER_CHARS,"description":"Hint for the empty field, e.g. \"sk_live_...\"."},
                "timeout_seconds": {"type":["integer","null"],"minimum":MIN_TIMEOUT_SECONDS,"maximum":MAX_TIMEOUT_SECONDS,"description":"How long to wait for the user. Default 600."}
            },
            "required": ["label", "reason", "env_key"]
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawArguments {
    label: String,
    reason: String,
    env_key: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

/// Validated arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SecretRequest {
    pub label: String,
    pub reason: String,
    pub env_key: String,
    pub file: String,
    pub placeholder: Option<String>,
    pub timeout: Duration,
}

impl SecretRequest {
    pub(crate) fn parse(arguments: Value) -> Result<Self> {
        let raw: RawArguments = serde_json::from_value(arguments).map_err(|error| {
            anyhow!(
                "Invalid arguments for kybern_request_secret: {error}. Pass label, reason and env_key (and optionally file, placeholder, timeout_seconds)."
            )
        })?;
        let label = raw.label.trim().to_owned();
        if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
            bail!("label must be 1 to {MAX_LABEL_CHARS} characters. Name the secret briefly, for example \"Stripe secret key\".");
        }
        let reason = raw.reason.trim().to_owned();
        if reason.is_empty() || reason.chars().count() > MAX_REASON_CHARS {
            bail!("reason must be 1 to {MAX_REASON_CHARS} characters. Say in a sentence why you need this secret.");
        }
        if !valid_key(&raw.env_key) {
            bail!("env_key must be letters, digits and underscores and not start with a digit (for example STRIPE_KEY).");
        }
        let file = raw.file.as_deref().map(str::trim).filter(|file| !file.is_empty()).unwrap_or(DEFAULT_FILE).to_owned();
        if file.len() > MAX_FILE_ARG_BYTES || file.contains('\0') {
            bail!("file must be a short path relative to the workspace, such as .env.");
        }
        let placeholder = raw.placeholder.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        if placeholder.as_ref().is_some_and(|text| text.chars().count() > MAX_PLACEHOLDER_CHARS) {
            bail!("placeholder must be at most {MAX_PLACEHOLDER_CHARS} characters.");
        }
        let seconds = raw.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS);
        if !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&seconds) {
            bail!("timeout_seconds must be between {MIN_TIMEOUT_SECONDS} and {MAX_TIMEOUT_SECONDS}.");
        }
        Ok(Self { label, reason, env_key: raw.env_key, file, placeholder, timeout: Duration::from_secs(seconds) })
    }
}

fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    key.len() <= MAX_KEY_BYTES
        && chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

// ---- target ----

/// Where a secret will be written, checked before the user is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SecretTarget {
    /// Absolute path inside the canonical workspace; its folder is canonical.
    pub path: PathBuf,
    /// The path relative to the workspace, with `/` separators, for display.
    pub display: String,
    /// The key is already in the file.
    pub replaces: bool,
}

/// Resolve and check the file before any prompt. Every failure says what to do next.
pub(crate) async fn resolve_target(cwd: &Path, file: &str, env_key: &str) -> Result<SecretTarget> {
    let check = inspect_target(cwd, file, env_key, "call kybern_request_secret again").await?;
    if check.in_repo && !check.ignored {
        let file = &check.target.display;
        bail!("`{file}` is not ignored by git. Add it to .gitignore, then call kybern_request_secret again.");
    }
    Ok(check.target)
}

/// A checked target and what git says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TargetCheck {
    pub target: SecretTarget,
    /// The file sits in a git work tree.
    pub in_repo: bool,
    /// Git ignores the file (always true outside a repository).
    pub ignored: bool,
    /// Git tracks the file, so a secret written to it would be committed.
    pub tracked: bool,
    /// The file already exists.
    pub exists: bool,
}

/// [`resolve_target`] without the ignore requirement: reports what git says
/// instead. `again` ends each error's next step ("try again").
pub(crate) async fn inspect_target(cwd: &Path, file: &str, env_key: &str, again: &str) -> Result<TargetCheck> {
    let root = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|_| anyhow!("This chat's workspace folder is missing. Ask the user to restore it, then {again}."))?;
    let requested = Path::new(file);
    let joined = if requested.is_absolute() { requested.to_path_buf() } else { root.join(requested) };
    let outside = || anyhow!("`{file}` is outside this workspace. Use a path inside the workspace folder, such as `.env`, then {again}.");
    let name = joined
        .file_name()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("`{file}` does not name a file. Pass a file name such as `.env`, then {again}."))?;
    let parent = joined.parent().ok_or_else(outside)?;
    let parent = match tokio::fs::canonicalize(parent).await {
        Ok(parent) => parent,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Without the folder there is nothing to compare against symlinks, so
            // a lexical `..` anywhere is refused as an escape attempt first.
            if requested.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
                return Err(outside());
            }
            bail!("The folder for `{file}` does not exist. Create it first, then {again}.");
        }
        Err(error) => {
            bail!("Cannot open the folder for `{file}` ({}). Check its permissions, then {again}.", error.kind())
        }
    };
    if !parent.starts_with(&root) {
        return Err(outside());
    }
    let path = parent.join(&name);
    let name = name.to_string_lossy().into_owned();

    let existing = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("`{file}` is a symbolic link. Point file at the real file inside the workspace, then {again}.")
        }
        Ok(metadata) if !metadata.is_file() => {
            bail!("`{file}` is not a regular file. Choose an env file such as `.env`, then {again}.")
        }
        Ok(metadata) if metadata.len() > MAX_ENV_FILE_BYTES => {
            bail!("`{file}` is larger than 1 MiB, so it is not an env file. Choose another file, then {again}.")
        }
        Ok(_) => Some(
            tokio::fs::read(&path)
                .await
                .map_err(|error| anyhow!("Cannot read `{file}` ({}). Check its permissions, then {again}.", error.kind()))
                .and_then(|bytes| {
                    String::from_utf8(bytes).map_err(|_| anyhow!("`{file}` is not UTF-8 text. Choose an env file, then {again}."))
                })?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => bail!("Cannot inspect `{file}` ({}). Check its permissions, then {again}.", error.kind()),
    };

    let in_repo = Repo::is_repo(&parent).await;
    let (mut ignored, mut tracked) = (true, false);
    if in_repo {
        let repo = Repo::new(&parent);
        // "./" keeps a file name from being read as a pathspec or an option.
        ignored = repo
            .is_ignored(&format!("./{name}"))
            .await
            .map_err(|error| anyhow!("Could not ask git whether `{file}` is ignored ({error}). Fix the repository, then {again}."))?;
        tracked = repo.is_tracked(&format!("./{name}")).await.unwrap_or(false);
    }

    // Fail before asking when the folder cannot take the write the answer needs.
    drop(
        TempFile::create(&path)
            .map_err(|error| anyhow!("Kybern cannot write next to `{file}` ({}). Make the folder writable, then {again}.", error.kind()))?,
    );

    let display = path.strip_prefix(&root).map(display_path).unwrap_or_else(|_| name.clone());
    let exists = existing.is_some();
    let target = SecretTarget { replaces: existing.as_deref().is_some_and(|text| env_has_key(text, env_key)), path, display };
    Ok(TargetCheck { target, in_repo, ignored, tracked, exists })
}

fn display_path(relative: &Path) -> String {
    relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

// ---- env file ----

/// Serializes read-modify-write of env files in this daemon.
static ENV_WRITE: Mutex<()> = Mutex::new(());

/// The env assignment a line makes, if it is one: `KEY=...` or `export KEY=...`.
/// Returns the key and the byte offset where the key starts.
fn line_assignment(line: &str) -> Option<(&str, usize)> {
    let trimmed = line.trim_start();
    let after_export = trimmed.strip_prefix("export").filter(|rest| rest.starts_with(char::is_whitespace)).map_or(trimmed, str::trim_start);
    let start = line.len() - after_export.len();
    let end = after_export.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after_export.len());
    let (key, rest) = after_export.split_at(end);
    (valid_key(key) && rest.trim_start_matches([' ', '\t']).starts_with('=')).then_some((key, start))
}

pub(crate) fn env_has_key(contents: &str, key: &str) -> bool {
    contents.lines().any(|line| line_assignment(line).is_some_and(|(found, _)| found == key))
}

/// The value as one env line needs it: bare when it only holds characters no
/// parser treats specially, otherwise double-quoted with `\`, `"`, `$` and line
/// breaks escaped.
pub(crate) fn format_value(value: &str) -> String {
    let plain =
        !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | ':' | '@' | '+' | '-'));
    if plain {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '$' => out.push_str("\\$"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `contents` with `key` set to `value`: the first `KEY=` / `export KEY=` line is
/// replaced in place (keeping its indentation and `export`), later duplicates
/// are dropped, and without one the assignment is appended. Every other line,
/// comment and line ending is kept. Returns the text and whether a line was replaced.
pub(crate) fn apply_env_value(contents: &str, key: &str, value: &str) -> (String, bool) {
    let rendered = format_value(value);
    let newline = if contents.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(contents.len() + key.len() + rendered.len() + 3);
    let mut replaced = false;
    for line in contents.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let ending = &line[body.len()..];
        match line_assignment(body) {
            Some((found, start)) if found == key => {
                if !replaced {
                    replaced = true;
                    out.push_str(&body[..start]);
                    out.push_str(&format!("{key}={rendered}"));
                    out.push_str(ending);
                }
            }
            _ => out.push_str(line),
        }
    }
    if !replaced {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(newline);
        }
        out.push_str(&format!("{key}={rendered}{newline}"));
    }
    (out, replaced)
}

/// A sibling file created exclusively (mode 0600 on Unix); removed on drop unless kept.
struct TempFile {
    path: PathBuf,
    file: Option<std::fs::File>,
    keep: bool,
}

impl TempFile {
    fn create(target: &Path) -> std::io::Result<Self> {
        let dir = target.parent().unwrap_or_else(|| Path::new("."));
        let name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let path = dir.join(format!(".{name}.kybern-{}.tmp", uuid::Uuid::now_v7()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options.open(&path)?;
        Ok(Self { path, file: Some(file), keep: false })
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        self.file.take();
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Set `key` to `value` in the env file at `path`, atomically (temp file in the
/// same folder, then rename). A new file is created with mode 0600; an existing
/// file keeps its mode. Returns whether an existing assignment was replaced.
/// The caller has resolved `path` with [`resolve_target`]; blocking.
pub(crate) fn write_env_value(path: &Path, key: &str, value: &str) -> Result<bool> {
    let _guard = ENV_WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (existing, metadata) = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!("The env file changed while waiting: it is no longer a regular file. Nothing was saved.")
        }
        Ok(metadata) => {
            let text = String::from_utf8(std::fs::read(path).context("read the env file")?)
                .map_err(|_| anyhow!("The env file is not UTF-8 text. Nothing was saved."))?;
            (text, Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), None),
        Err(error) => return Err(error).context("inspect the env file"),
    };
    let (updated, replaced) = apply_env_value(&existing, key, value);
    let mut temp = TempFile::create(path).context("create a temporary file next to the env file")?;
    let file = temp.file.as_mut().expect("temp file is open");
    file.write_all(updated.as_bytes()).context("write the env file")?;
    if let Some(metadata) = &metadata {
        file.set_permissions(metadata.permissions()).context("keep the env file mode")?;
    }
    file.sync_all().context("flush the env file")?;
    std::fs::rename(&temp.path, path).context("replace the env file")?;
    temp.keep = true;
    Ok(replaced)
}

// ---- pasted secrets ----

const TRY_AGAIN: &str = "try again";

/// What storing `env_key` in `file` would do, for the composer's strip. Never sees a value.
pub(crate) async fn check_pasted(cwd: &Path, file: Option<&str>, env_key: &str) -> Result<kybern_protocol::methods::SecretsTargetResult> {
    if !valid_key(env_key) {
        bail!("Use letters, digits and underscores for the name, and do not start with a digit.");
    }
    let check = inspect_target(cwd, file_or_default(file), env_key, TRY_AGAIN).await?;
    Ok(kybern_protocol::methods::SecretsTargetResult {
        file: check.target.display,
        replaces: check.target.replaces,
        ignored: check.ignored,
        tracked: check.tracked,
        exists: check.exists,
    })
}

/// Save a secret the user pasted into the composer. Same file rules as the
/// request card (inside the workspace, ignored by git), plus: a tracked file is
/// always refused, and `add_to_gitignore` first lists the file in the
/// `.gitignore` beside it. The value goes only to the file.
pub(crate) async fn store_pasted(
    cwd: &Path,
    file: Option<&str>,
    env_key: &str,
    value: String,
    add_to_gitignore: bool,
) -> Result<kybern_protocol::methods::SecretsStoreResult> {
    if !valid_key(env_key) {
        bail!("Use letters, digits and underscores for the name, and do not start with a digit.");
    }
    if value.is_empty() || value.len() > kybern_protocol::MAX_SECRET_BYTES || value.contains('\0') {
        bail!("Paste a value of up to {} KiB.", kybern_protocol::MAX_SECRET_BYTES / 1024);
    }
    let mut check = inspect_target(cwd, file_or_default(file), env_key, TRY_AGAIN).await?;
    if check.tracked {
        let name = &check.target.display;
        bail!(
            "Git tracks `{name}`, so a key stored there would be committed. Choose a file Git ignores, such as `.env.local`, then try again."
        );
    }
    let mut gitignore_updated = false;
    if check.in_repo && !check.ignored {
        let name = check.target.display.clone();
        if !add_to_gitignore {
            bail!("`{name}` is not ignored by git. Add it to .gitignore, then try again.");
        }
        let file_name = check.target.path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let folder = check.target.path.parent().map(Path::to_path_buf).unwrap_or_default();
        let entry = format!("/{file_name}");
        let ignore_file = folder.join(".gitignore");
        let line = entry.clone();
        tokio::task::spawn_blocking(move || append_gitignore(&ignore_file, &line))
            .await
            .map_err(|_| anyhow!("Kybern could not update .gitignore. Add `{entry}` to it yourself, then try again."))??;
        gitignore_updated = true;
        check = inspect_target(cwd, file_or_default(file), env_key, TRY_AGAIN).await?;
        if !check.ignored {
            bail!("`{name}` is still not ignored by git after updating .gitignore. Check your ignore rules, then try again.");
        }
    }
    let target = check.target;
    let (path, key) = (target.path.clone(), env_key.to_owned());
    let replaced = tokio::task::spawn_blocking(move || write_env_value(&path, &key, &value))
        .await
        .map_err(|_| anyhow!("Kybern could not save the key. Nothing was written; try again."))?
        .map_err(|error| {
            anyhow!(
                "Kybern could not save the key to {}: {error:#}. The value was discarded; fix the problem, then try again.",
                target.display
            )
        })?;
    Ok(kybern_protocol::methods::SecretsStoreResult { env_key: env_key.to_owned(), file: target.display, replaced, gitignore_updated })
}

fn file_or_default(file: Option<&str>) -> &str {
    file.map(str::trim).filter(|file| !file.is_empty()).unwrap_or(DEFAULT_FILE)
}

/// Append `line` to `.gitignore` unless a line already says it. Keeps the file's other content.
fn append_gitignore(path: &Path, line: &str) -> Result<()> {
    let _guard = ENV_WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut text = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!("`.gitignore` is not a regular file. Add `{line}` to your ignore rules yourself, then try again.")
        }
        Ok(_) => std::fs::read_to_string(path).map_err(|_| anyhow!("Cannot read .gitignore. Check its permissions, then try again."))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).context("inspect .gitignore"),
    };
    if text.lines().any(|existing| existing.trim() == line) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(line);
    text.push('\n');
    std::fs::write(path, text).context("write .gitignore")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);

    impl Dir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("kybern-secrets-test-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir_all(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn write(&self, name: &str, text: &str) -> PathBuf {
            let path = self.path(name);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, text).unwrap();
            path
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn apply(contents: &str, value: &str) -> (String, bool) {
        apply_env_value(contents, "STRIPE_KEY", value)
    }

    #[test]
    fn appends_to_an_empty_file_and_keeps_other_lines() {
        assert_eq!(apply("", "abc"), ("STRIPE_KEY=abc\n".into(), false));
        assert_eq!(apply("# comment\nA=1\n\nB=2\n", "abc"), ("# comment\nA=1\n\nB=2\nSTRIPE_KEY=abc\n".into(), false));
    }

    #[test]
    fn appending_adds_the_missing_trailing_newline_first() {
        assert_eq!(apply("A=1", "abc"), ("A=1\nSTRIPE_KEY=abc\n".into(), false));
    }

    #[test]
    fn replaces_the_first_assignment_in_place() {
        let (text, replaced) = apply("A=1\nSTRIPE_KEY=old\nB=2\n", "new");
        assert!(replaced);
        assert_eq!(text, "A=1\nSTRIPE_KEY=new\nB=2\n");
    }

    #[test]
    fn replaces_the_export_form_and_keeps_it() {
        assert_eq!(apply("A=1\n  export STRIPE_KEY=old # note\nB=2\n", "new"), ("A=1\n  export STRIPE_KEY=new\nB=2\n".into(), true));
        assert_eq!(apply("export   STRIPE_KEY = old\n", "new").0, "export   STRIPE_KEY=new\n");
    }

    #[test]
    fn drops_later_duplicates_of_the_key() {
        let (text, replaced) = apply("STRIPE_KEY=one\nA=1\nexport STRIPE_KEY=two\nSTRIPE_KEY=three", "new");
        assert!(replaced);
        assert_eq!(text, "STRIPE_KEY=new\nA=1\n");
    }

    #[test]
    fn does_not_touch_comments_prefixes_or_other_keys() {
        let input = "# STRIPE_KEY=commented\nSTRIPE_KEY_TEST=1\nMY_STRIPE_KEY=2\nexport=3\n";
        let (text, replaced) = apply(input, "abc");
        assert!(!replaced);
        assert_eq!(text, format!("{input}STRIPE_KEY=abc\n"));
        assert!(env_has_key("export STRIPE_KEY=1", "STRIPE_KEY"));
        assert!(!env_has_key(input, "STRIPE_KEY"));
    }

    #[test]
    fn preserves_crlf_files() {
        assert_eq!(apply("A=1\r\nSTRIPE_KEY=old\r\nB=2\r\n", "new").0, "A=1\r\nSTRIPE_KEY=new\r\nB=2\r\n");
        assert_eq!(apply("A=1\r\nB=2", "new").0, "A=1\r\nB=2\r\nSTRIPE_KEY=new\r\n");
    }

    #[test]
    fn quotes_only_what_needs_it() {
        for plain in ["abc", "sk_live_AbC123", "https://example.com:8080/p", "a@b.c+d-e", "/usr/local/bin"] {
            assert_eq!(format_value(plain), plain);
        }
        assert_eq!(format_value(""), "\"\"");
        assert_eq!(format_value("has space"), "\"has space\"");
        assert_eq!(format_value("a\"b"), "\"a\\\"b\"");
        assert_eq!(format_value("a\\b"), "\"a\\\\b\"");
        assert_eq!(format_value("pa$$word"), "\"pa\\$\\$word\"");
        assert_eq!(format_value("line1\nline2\r"), "\"line1\\nline2\\r\"");
        assert_eq!(format_value("#hash"), "\"#hash\"");
        assert_eq!(format_value("a=b"), "\"a=b\"");
        assert_eq!(format_value("é"), "\"é\"");
    }

    #[test]
    fn written_files_round_trip_through_the_writer() {
        let dir = Dir::new();
        let path = dir.path(".env");
        assert!(!write_env_value(&path, "STRIPE_KEY", "one two").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "STRIPE_KEY=\"one two\"\n");
        assert!(write_env_value(&path, "STRIPE_KEY", "three").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "STRIPE_KEY=three\n");
        let leftovers: Vec<_> = std::fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers.len(), 1, "temporary files are cleaned up: {leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn new_files_are_private_and_existing_modes_are_kept() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Dir::new();
        let created = dir.path(".env");
        write_env_value(&created, "A", "1").unwrap();
        assert_eq!(std::fs::metadata(&created).unwrap().permissions().mode() & 0o777, 0o600);

        let shared = dir.write("shared.env", "A=1\n");
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_env_value(&shared, "A", "2").unwrap();
        assert_eq!(std::fs::metadata(&shared).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(std::fs::read_to_string(&shared).unwrap(), "A=2\n");
    }

    #[test]
    fn arguments_are_validated_with_next_steps() {
        let ok = SecretRequest::parse(json!({"label":" Stripe key ","reason":"Run the checkout test","env_key":"STRIPE_KEY"})).unwrap();
        assert_eq!((ok.label.as_str(), ok.file.as_str(), ok.timeout), ("Stripe key", ".env", Duration::from_secs(600)));
        let custom = SecretRequest::parse(
            json!({"label":"a","reason":"b","env_key":"_K1","file":"apps/web/.env.local","placeholder":"sk_...","timeout_seconds":10}),
        )
        .unwrap();
        assert_eq!(
            (custom.file.as_str(), custom.placeholder.as_deref(), custom.timeout),
            ("apps/web/.env.local", Some("sk_..."), Duration::from_secs(10))
        );
        for bad in [
            json!({"label":"a","reason":"b","env_key":"1BAD"}),
            json!({"label":"a","reason":"b","env_key":"HAS-DASH"}),
            json!({"label":"a","reason":"b","env_key":""}),
            json!({"label":"","reason":"b","env_key":"K"}),
            json!({"label":"a","reason":" ","env_key":"K"}),
            json!({"label":"a","reason":"b","env_key":"K","timeout_seconds":9}),
            json!({"label":"a","reason":"b","env_key":"K","timeout_seconds":3601}),
            json!({"label":"a","reason":"b","env_key":"K","value":"sneaky"}),
            json!({"label":"a","reason":"b"}),
        ] {
            assert!(SecretRequest::parse(bad.clone()).is_err(), "{bad}");
        }
        assert_eq!(call_budget(TOOL, &json!({"timeout_seconds": 100})), Some(Duration::from_secs(130)));
        assert_eq!(call_budget(TOOL, &json!({})), Some(Duration::from_secs(630)));
        assert_eq!(call_budget("kybern_read_file", &json!({})), None);
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[tokio::test]
    async fn pasted_keys_go_to_an_ignored_file_and_never_to_a_tracked_one() {
        let dir = Dir::new();
        // Outside a repository any file inside the workspace works, and the check never needs a value.
        let check = check_pasted(&dir.0, None, "STRIPE_SECRET_KEY").await.unwrap();
        assert_eq!((check.file.as_str(), check.ignored, check.tracked, check.exists, check.replaces), (".env", true, false, false, false));
        let stored = store_pasted(&dir.0, Some(".env.local"), "STRIPE_SECRET_KEY", "sk_live_abc".into(), false).await.unwrap();
        assert_eq!((stored.file.as_str(), stored.replaced, stored.gitignore_updated), (".env.local", false, false));
        assert_eq!(std::fs::read_to_string(dir.path(".env.local")).unwrap(), "STRIPE_SECRET_KEY=sk_live_abc\n");
        let again = store_pasted(&dir.0, Some(".env.local"), "STRIPE_SECRET_KEY", "sk_live_def".into(), false).await.unwrap();
        assert!(again.replaced);
        assert!(check_pasted(&dir.0, Some(".env.local"), "STRIPE_SECRET_KEY").await.unwrap().replaces);

        // In a repository an unignored file is refused until the person lets Kybern list it.
        git(&dir.0, &["init", "-q"]);
        let error = store_pasted(&dir.0, Some("app.secrets"), "K", "v".into(), false).await.unwrap_err().to_string();
        assert!(error.contains("`app.secrets` is not ignored by git. Add it to .gitignore, then try again."), "{error}");
        assert!(!check_pasted(&dir.0, Some("app.secrets"), "K").await.unwrap().ignored);
        let stored = store_pasted(&dir.0, Some("app.secrets"), "K", "v".into(), true).await.unwrap();
        assert!(stored.gitignore_updated);
        assert_eq!(std::fs::read_to_string(dir.path(".gitignore")).unwrap(), "/app.secrets\n");
        assert_eq!(std::fs::read_to_string(dir.path("app.secrets")).unwrap(), "K=v\n");
        // Listing it twice does not duplicate the line, and an existing .gitignore keeps its other lines.
        dir.write(".gitignore", "target");
        store_pasted(&dir.0, Some("other"), "K", "v".into(), true).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.path(".gitignore")).unwrap(), "target\n/other\n");
        append_gitignore(&dir.path(".gitignore"), "/other").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path(".gitignore")).unwrap(), "target\n/other\n");

        // A tracked file is refused even when .gitignore lists it.
        dir.write("tracked.env", "A=1\n");
        git(&dir.0, &["add", "-f", "tracked.env"]);
        dir.write(".gitignore", "tracked.env\n");
        assert!(check_pasted(&dir.0, Some("tracked.env"), "K").await.unwrap().tracked);
        let error = store_pasted(&dir.0, Some("tracked.env"), "K", "v".into(), true).await.unwrap_err().to_string();
        assert!(error.contains("Git tracks `tracked.env`"), "{error}");
        assert_eq!(std::fs::read_to_string(dir.path("tracked.env")).unwrap(), "A=1\n");
    }

    #[tokio::test]
    async fn pasted_keys_are_validated_before_anything_is_written() {
        let dir = Dir::new();
        assert!(
            store_pasted(&dir.0, None, "1BAD", "v".into(), false)
                .await
                .unwrap_err()
                .to_string()
                .contains("letters, digits and underscores")
        );
        assert!(store_pasted(&dir.0, None, "OK", String::new(), false).await.is_err());
        assert!(store_pasted(&dir.0, None, "OK", "a\0b".into(), false).await.is_err());
        assert!(store_pasted(&dir.0, Some("../outside"), "OK", "v".into(), false).await.is_err());
        assert!(!dir.path(".env").exists());
    }

    #[tokio::test]
    async fn paths_must_stay_inside_the_workspace() {
        let dir = Dir::new();
        let outside = Dir::new();
        let outside_env = outside.path(".env");
        let message = |error: anyhow::Error| error.to_string();

        let target = resolve_target(&dir.0, "", "K").await;
        assert!(target.is_err(), "an empty name is not a file");
        let ok = resolve_target(&dir.0, ".env", "K").await.unwrap();
        assert_eq!((ok.display.as_str(), ok.replaces, ok.path.clone()), (".env", false, dir.path(".env")));

        // Absolute path outside, `..` escape, and a not-yet-existing escape.
        let error = message(resolve_target(&dir.0, outside_env.to_str().unwrap(), "K").await.unwrap_err());
        assert!(error.contains("outside this workspace") && error.contains("call kybern_request_secret again"), "{error}");
        let escape = format!("../{}/.env", outside.0.file_name().unwrap().to_string_lossy());
        assert!(message(resolve_target(&dir.0, &escape, "K").await.unwrap_err()).contains("outside this workspace"));
        assert!(message(resolve_target(&dir.0, "nope/../../x/.env", "K").await.unwrap_err()).contains("outside this workspace"));
        assert!(message(resolve_target(&dir.0, "missing/.env", "K").await.unwrap_err()).contains("Create it first"));
        assert!(resolve_target(&dir.0, "..", "K").await.is_err());

        // An absolute path inside the workspace and a dotted-but-inside path are fine.
        dir.write("apps/web/keep", "");
        let inside = resolve_target(&dir.0, dir.path("apps/web/.env").to_str().unwrap(), "K").await.unwrap();
        assert_eq!(inside.display, "apps/web/.env");
        let dotted = resolve_target(&dir.0, "apps/../apps/web/.env", "K").await.unwrap();
        assert_eq!(dotted.display, "apps/web/.env");

        // Existing key detection.
        dir.write(".env.local", "export K=1\n");
        assert!(resolve_target(&dir.0, ".env.local", "K").await.unwrap().replaces);
        assert!(!resolve_target(&dir.0, ".env.local", "OTHER").await.unwrap().replaces);

        // A directory is not a file.
        assert!(message(resolve_target(&dir.0, "apps", "K").await.unwrap_err()).contains("not a regular file"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_cannot_escape_the_workspace() {
        let dir = Dir::new();
        let outside = Dir::new();
        outside.write(".env", "SECRET=1\n");
        std::os::unix::fs::symlink(&outside.0, dir.path("link")).unwrap();
        std::os::unix::fs::symlink(outside.path(".env"), dir.path(".env")).unwrap();
        // A symlinked folder leading out.
        let error = resolve_target(&dir.0, "link/.env", "K").await.unwrap_err().to_string();
        assert!(error.contains("outside this workspace"), "{error}");
        // A symlinked file, even one that points inside.
        let error = resolve_target(&dir.0, ".env", "K").await.unwrap_err().to_string();
        assert!(error.contains("symbolic link"), "{error}");
        dir.write("real.env", "");
        std::os::unix::fs::symlink(dir.path("real.env"), dir.path("alias.env")).unwrap();
        assert!(resolve_target(&dir.0, "alias.env", "K").await.unwrap_err().to_string().contains("symbolic link"));
    }

    #[tokio::test]
    async fn git_repositories_require_an_ignored_file() {
        let dir = Dir::new();
        git(&dir.0, &["init", "-q"]);
        // (A name the machine's global gitignore is unlikely to cover.)
        let error = resolve_target(&dir.0, "app.secrets", "K").await.unwrap_err().to_string();
        assert!(
            error.contains("`app.secrets` is not ignored by git. Add it to .gitignore, then call kybern_request_secret again."),
            "{error}"
        );
        dir.write(".gitignore", "app.secrets\n*.local\n");
        assert!(resolve_target(&dir.0, "app.secrets", "K").await.is_ok());
        assert!(resolve_target(&dir.0, "x.local", "K").await.is_ok());
        assert!(resolve_target(&dir.0, "config.json", "K").await.unwrap_err().to_string().contains("not ignored"));
        // A subfolder of the repository uses the repository's rules.
        dir.write("apps/web/keep", "");
        assert!(resolve_target(&dir.0, "apps/web/app.secrets", "K").await.is_ok());
        assert!(resolve_target(&dir.0, "apps/web/other.secrets", "K").await.is_err());
        // A tracked file is not ignored, however it is matched.
        dir.write("tracked.local", "A=1\n");
        git(&dir.0, &["add", "-f", "tracked.local"]);
        assert!(resolve_target(&dir.0, "tracked.local", "K").await.unwrap_err().to_string().contains("not ignored"));
    }

    #[tokio::test]
    async fn non_git_folders_are_allowed() {
        let dir = Dir::new();
        let target = resolve_target(&dir.0, ".env", "K").await.unwrap();
        assert_eq!(target.path, dir.path(".env"));
    }

    #[tokio::test]
    async fn existing_files_must_be_text() {
        let dir = Dir::new();
        std::fs::write(dir.path(".env"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(resolve_target(&dir.0, ".env", "K").await.unwrap_err().to_string().contains("not UTF-8"));
    }
}
