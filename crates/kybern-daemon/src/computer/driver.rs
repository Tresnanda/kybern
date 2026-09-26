//! CuaDriver discovery and a minimal MCP stdio client.
//!
//! Kybern never bundles the driver. The user installs `CuaDriver.app`, which
//! owns the Accessibility and Screen Recording grants (`com.trycua.driver`).
//! `cua-driver mcp` is a thin proxy that launches the driver's own daemon
//! through LaunchServices, so the grants apply no matter how `kybernd` was
//! started.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

pub(crate) const BUNDLE_ID: &str = "com.trycua.driver";
pub(crate) const TEAM_ID: &str = "YCK386LBJ7";
/// Oldest release with the element-token contract and a notarized macOS build.
pub(crate) const MIN_VERSION: (u64, u64, u64) = (0, 28, 2);
/// Newest minor line Kybern was tested against. Newer versions still run.
pub(crate) const TESTED_MINOR: (u64, u64) = (0, 28);
pub(crate) const INSTALL_VERSION: &str = "0.28.2";
const CALL_TIMEOUT: Duration = Duration::from_secs(45);
/// CuaDriver's automatic glide takes about 1.2 s per click, and the call
/// waits for it even with the cursor hidden. A short glide keeps the cursor
/// visible and legible while halving each click (0 means automatic).
const CURSOR_GLIDE_MS: u64 = 120;
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

/// Where the installed app lives and what it claims to be.
#[derive(Debug, Clone)]
pub(crate) struct Installation {
    pub app: PathBuf,
    pub binary: PathBuf,
    pub version: Option<String>,
}

impl Installation {
    pub(crate) fn find() -> Option<Self> {
        let mut candidates = Vec::new();
        if let Some(app) = std::env::var_os("KYBERN_CUA_DRIVER_APP") {
            candidates.push(PathBuf::from(app));
        }
        candidates.push(PathBuf::from("/Applications/CuaDriver.app"));
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(Path::new(&home).join("Applications/CuaDriver.app"));
        }
        candidates.into_iter().find_map(|app| {
            let binary = app.join("Contents/MacOS/cua-driver");
            binary.is_file().then(|| Self { version: read_version(&app), app, binary })
        })
    }

    pub(crate) fn parsed_version(&self) -> Option<(u64, u64, u64)> {
        self.version.as_deref().and_then(parse_version)
    }

    pub(crate) fn version_supported(&self) -> bool {
        self.parsed_version().is_some_and(|version| version >= MIN_VERSION)
    }
}

/// `CFBundleShortVersionString` from the bundle, without running the binary.
fn read_version(app: &Path) -> Option<String> {
    let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).ok()?;
    let key = plist.find("<key>CFBundleShortVersionString</key>")?;
    let rest = &plist[key..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")?;
    Some(rest[start..start + end].trim().to_owned())
}

pub(crate) fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)))
}

/// Signature facts read with `codesign`, the same check Hermes applies.
#[derive(Debug, Clone, Default)]
pub(crate) struct Signature {
    pub valid: bool,
    pub identifier: Option<String>,
    pub team: Option<String>,
}

impl Signature {
    pub(crate) fn trusted(&self) -> bool {
        self.valid && self.identifier.as_deref() == Some(BUNDLE_ID) && self.team.as_deref() == Some(TEAM_ID)
    }
}

pub(crate) async fn read_signature(app: &Path) -> Signature {
    let valid = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(app)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success());
    let details = Command::new("/usr/bin/codesign").arg("-dv").arg(app).output().await;
    let text = details.map(|output| String::from_utf8_lossy(&output.stderr).into_owned()).unwrap_or_default();
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "not set")
            .map(str::to_owned)
    };
    Signature { valid, identifier: field("Identifier="), team: field("TeamIdentifier=") }
}

/// Whether CuaDriver's own daemon (`cua-driver serve`) is running. `status`
/// asks the daemon's socket and never starts it.
pub(crate) async fn daemon_running(installation: &Installation) -> bool {
    run_quietly(installation, "status").await
}

/// Stop CuaDriver's daemon. It outlives the `mcp` proxy and keeps its capture
/// buffers until it exits; the next proxy launches it again.
pub(crate) async fn stop_daemon(installation: &Installation) -> bool {
    run_quietly(installation, "stop").await
}

async fn run_quietly(installation: &Installation, subcommand: &str) -> bool {
    let status = Command::new(&installation.binary)
        .arg(subcommand)
        .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
        .env("CUA_TELEMETRY_ENABLED", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    matches!(tokio::time::timeout(Duration::from_secs(10), status).await, Ok(Ok(status)) if status.success())
}

pub(crate) fn allow_unsigned() -> bool {
    std::env::var_os("KYBERN_CUA_DRIVER_ALLOW_UNSIGNED").is_some_and(|value| value == "1")
}

/// Result of one `tools/call`.
#[derive(Debug, Clone)]
pub(crate) struct CallResult {
    pub is_error: bool,
    pub text: String,
    pub structured: Value,
    /// Base64 image payloads with their MIME type.
    pub images: Vec<(String, String)>,
}

impl CallResult {
    fn from_value(value: &Value) -> Self {
        let mut text = Vec::new();
        let mut images = Vec::new();
        for item in value.get("content").and_then(Value::as_array).into_iter().flatten() {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => text.extend(item.get("text").and_then(Value::as_str).map(str::to_owned)),
                Some("image") => {
                    if let (Some(data), Some(mime)) =
                        (item.get("data").and_then(Value::as_str), item.get("mimeType").and_then(Value::as_str))
                    {
                        images.push((mime.to_owned(), data.to_owned()));
                    }
                }
                _ => {}
            }
        }
        Self {
            is_error: value.get("isError").and_then(Value::as_bool).unwrap_or(false),
            text: text.join("\n"),
            structured: value.get("structuredContent").cloned().unwrap_or(Value::Null),
            images,
        }
    }

    /// The driver's own error message, trimmed to something a model can act on.
    pub(crate) fn error_message(&self) -> String {
        let code = self.structured.pointer("/error/code").or_else(|| self.structured.get("code")).and_then(Value::as_str);
        let message = self
            .structured
            .pointer("/error/message")
            .or_else(|| self.structured.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| self.text.clone());
        let message = message.lines().next().unwrap_or("").chars().take(600).collect::<String>();
        match code {
            Some(code) if !message.contains(code) => format!("{code}: {message}"),
            _ => message,
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;

/// One live `cua-driver mcp` process.
pub(crate) struct DriverClient {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    /// Driver-side names for the caller's session labels. CuaDriver binds a
    /// named session to the process that created it, ends it with that
    /// process, and never lets another process revive the name. Each client
    /// therefore adds its own suffix, and picks a new name when a session it
    /// cannot revive ends under it.
    sessions: Mutex<HashMap<String, String>>,
    tag: String,
    renames: AtomicU64,
}

impl DriverClient {
    pub(crate) async fn start(installation: &Installation) -> Result<Self> {
        let mut command = Command::new(&installation.binary);
        command
            .arg("mcp")
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
            .env("CUA_TELEMETRY_ENABLED", "0")
            .env_remove("CUA_DRIVER_PERMISSION_MODE")
            .env_remove("CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().with_context(|| format!("start {}", installation.binary.display()))?;
        let tag = child.id().map_or_else(|| "0".to_owned(), |id| id.to_string());
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("CuaDriver stdin is unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("CuaDriver stdout is unavailable"))?;
        let pending: Pending = Arc::default();
        let client = Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            sessions: Mutex::default(),
            tag,
            renames: AtomicU64::new(0),
        };
        tokio::spawn(read_loop(stdout, pending));
        let init = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "kybern", "version": env!("CARGO_PKG_VERSION") },
                }),
                Duration::from_secs(20),
            )
            .await
            .context("CuaDriver did not finish starting")?;
        if init.get("protocolVersion").is_none() {
            bail!("CuaDriver returned an invalid initialize response");
        }
        client.notify("notifications/initialized", json!({})).await?;
        Ok(client)
    }

    pub(crate) async fn alive(&self) -> bool {
        matches!(self.child.lock().await.try_wait(), Ok(None))
    }

    /// Call a tool. A `session` argument is the caller's label; it is sent
    /// under this client's name for it, and a session that has ended is
    /// revived or replaced once before the call is sent again. The driver
    /// rejects calls on an ended session before acting, so the retry cannot
    /// run a step twice.
    pub(crate) async fn call(&self, tool: &str, mut arguments: Value) -> Result<CallResult> {
        let Some(label) = arguments.get("session").and_then(Value::as_str).map(str::to_owned) else {
            return self.call_raw(tool, arguments).await;
        };
        let (name, fresh) = self.session_name(&label).await;
        if fresh {
            self.prepare_session(&name).await;
        }
        arguments["session"] = json!(name);
        let result = self.call_raw(tool, arguments.clone()).await?;
        if !session_ended(&result) {
            return Ok(result);
        }
        arguments["session"] = json!(self.renew_session(&label).await);
        self.call_raw(tool, arguments).await
    }

    /// This client's name for `label`, and whether it was just made.
    async fn session_name(&self, label: &str) -> (String, bool) {
        let mut sessions = self.sessions.lock().await;
        if let Some(name) = sessions.get(label) {
            return (name.clone(), false);
        }
        let name = format!("{label}-{}", self.tag);
        sessions.insert(label.to_owned(), name.clone());
        (name, true)
    }

    async fn renew_session(&self, label: &str) -> String {
        let (current, _) = self.session_name(label).await;
        if self.call_raw("start_session", json!({ "session": current })).await.is_ok_and(|result| !result.is_error) {
            tracing::debug!(target: "kybern::computer", session = current, "revived ended CuaDriver session");
            self.prepare_session(&current).await;
            return current;
        }
        let renamed = format!("{label}-{}-{}", self.tag, self.renames.fetch_add(1, Ordering::Relaxed) + 1);
        tracing::debug!(target: "kybern::computer", from = current, to = renamed, "replaced ended CuaDriver session");
        self.sessions.lock().await.insert(label.to_owned(), renamed.clone());
        self.prepare_session(&renamed).await;
        renamed
    }

    /// Session settings Kybern relies on. Best effort: an older driver
    /// without the tool still works, only slower.
    async fn prepare_session(&self, name: &str) {
        let motion = json!({ "session": name, "glide_duration_ms": CURSOR_GLIDE_MS, "dwell_after_click_ms": 0 });
        if let Err(error) = self.call_raw("set_agent_cursor_motion", motion).await {
            tracing::debug!(target: "kybern::computer", session = name, %error, "could not set the cursor motion");
        }
    }

    async fn call_raw(&self, tool: &str, arguments: Value) -> Result<CallResult> {
        let started = std::time::Instant::now();
        let value = self.request("tools/call", json!({ "name": tool, "arguments": arguments }), CALL_TIMEOUT).await;
        tracing::debug!(target: "kybern::computer", tool, elapsed_ms = started.elapsed().as_millis() as u64, ok = value.is_ok(), "CuaDriver call");
        Ok(CallResult::from_value(&value?))
    }

    /// Call a tool and fail on a tool-level error.
    pub(crate) async fn call_ok(&self, tool: &str, arguments: Value) -> Result<CallResult> {
        let result = self.call(tool, arguments).await?;
        if result.is_error {
            bail!("{}", result.error_message());
        }
        Ok(result)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(anyhow!("CuaDriver exited while handling {method}")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(anyhow!("CuaDriver did not answer {method} within {}s", timeout.as_secs()))
            }
        }
    }

    async fn write(&self, message: Value) -> Result<()> {
        let mut line = serde_json::to_vec(&message)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await.context("CuaDriver closed its input")?;
        stdin.flush().await?;
        Ok(())
    }
}

/// `session 'x' has ended; tool call 'y' was rejected. Call start_session …`
fn session_ended(result: &CallResult) -> bool {
    result.is_error && result.text.contains("has ended") && result.text.contains("start_session")
}

async fn read_loop(stdout: tokio::process::ChildStdout, pending: Pending) {
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_LINE_BYTES => continue,
            Ok(_) => {}
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        // Server-initiated requests (ping, roots, elicitation) are not
        // answered; the driver treats a missing reply as unsupported.
        if message.get("method").is_some() {
            continue;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else { continue };
        let Some(sender) = pending.lock().await.remove(&id) else { continue };
        let result = match message.get("error") {
            Some(error) => Err(anyhow!(
                "CuaDriver error: {}",
                error.get("message").and_then(Value::as_str).unwrap_or("request failed").chars().take(600).collect::<String>()
            )),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(result);
    }
    for (_, sender) in pending.lock().await.drain() {
        let _ = sender.send(Err(anyhow!("CuaDriver exited")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_driver_versions() {
        assert_eq!(parse_version("0.28.2"), Some((0, 28, 2)));
        assert_eq!(parse_version("v0.28.3-nightly.4"), Some((0, 28, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("cua"), None);
        assert!(parse_version("0.5.3").unwrap() < MIN_VERSION);
    }

    #[test]
    fn call_results_split_text_images_and_errors() {
        let result = CallResult::from_value(&json!({
            "isError": true,
            "content": [{"type":"text","text":"stale token"},{"type":"image","data":"AAAA","mimeType":"image/png"}],
            "structuredContent": {"error": {"code": "stale_element_token", "message": "Take a new snapshot."}}
        }));
        assert!(result.is_error);
        assert_eq!(result.images, vec![("image/png".to_owned(), "AAAA".to_owned())]);
        assert_eq!(result.error_message(), "stale_element_token: Take a new snapshot.");
    }

    #[test]
    fn recognizes_ended_sessions() {
        let ended = CallResult::from_value(&json!({
            "isError": true,
            "content": [{"type":"text","text":"session 'kybern-01a0d8351002' has ended; tool call 'hotkey' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}],
            "structuredContent": {"code": "tool_invocation_failed", "exit_code": 1}
        }));
        assert!(session_ended(&ended));
        let other = CallResult::from_value(&json!({
            "isError": true,
            "content": [{"type":"text","text":"session is not available to this transport"}],
            "structuredContent": {"code": "session_unavailable"}
        }));
        assert!(!session_ended(&other));
    }
}
