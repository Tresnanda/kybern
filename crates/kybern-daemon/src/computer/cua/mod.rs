//! The CuaDriver backend: `CuaDriver.app` over `cua-driver mcp` on macOS.
//!
//! Kybern never bundles the driver. It owns CuaDriver's own daemon when it
//! started it (so it can stop it when idle and apply the cursor setting) and
//! leaves one it found running alone. Everything here speaks CuaDriver's
//! tool names and JSON; the tools above only see [`ComputerBackend`].

pub(crate) mod driver;
pub(crate) mod macos;
mod parse;

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail, ensure};
use async_trait::async_trait;
use kybern_protocol::methods::{ComputerCheck, ComputerPermission};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::Mode;
use super::backend::{
    Act, AppInfo, BackendKind, BackendStatus, Button, Capabilities, Direction, Effect, Escalation, Image, Launched, Outcome, ReadOptions,
    Region, Target, WindowInfo, WindowRead,
};
use crate::settings::SettingsStore;
use driver::{CallResult, DriverClient, Installation};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const GRANT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Gap between synthesized characters when a field lacks accessibility text
/// insertion. CuaDriver's 30 ms default made 50 characters take 1.5 s.
const TYPE_DELAY_MS: u64 = 8;

#[derive(Clone)]
pub(crate) struct CuaDriverBackend {
    inner: Arc<Inner>,
}

struct Inner {
    settings: SettingsStore,
    client: Mutex<Option<Arc<DriverClient>>>,
    /// Whether Kybern launched CuaDriver's daemon, so it stops it on release.
    /// A daemon that was already running belongs to someone else.
    owns_daemon: AtomicBool,
    /// Whether the daemon Kybern launched draws the agent cursor, so a change
    /// to `show_cursor` restarts it.
    daemon_cursor: AtomicBool,
}

impl CuaDriverBackend {
    pub(crate) fn new(settings: SettingsStore) -> Self {
        Self {
            inner: Arc::new(Inner {
                settings,
                client: Mutex::new(None),
                owns_daemon: AtomicBool::new(false),
                daemon_cursor: AtomicBool::new(false),
            }),
        }
    }

    /// Whether a `cua-driver mcp` proxy is open.
    #[cfg(test)]
    pub(crate) async fn is_open(&self) -> bool {
        self.inner.client.lock().await.is_some()
    }

    /// The live MCP client, started (with CuaDriver's daemon) when absent.
    pub(crate) async fn client(&self) -> Result<Arc<DriverClient>> {
        let show_cursor = self.inner.settings.get().computer_use.show_cursor;
        let mut slot = self.inner.client.lock().await;
        if self.inner.owns_daemon.load(Ordering::Relaxed) && self.inner.daemon_cursor.load(Ordering::Relaxed) != show_cursor {
            self.release_locked(&mut slot).await;
        }
        if let Some(client) = slot.as_ref()
            && client.alive().await
        {
            return Ok(client.clone());
        }
        *slot = None;
        let installation = Installation::find()
            .ok_or_else(|| anyhow!("CuaDriver is not installed. Ask the user to install it in Kybern Settings → Computer use."))?;
        ensure!(
            installation.version_supported(),
            "CuaDriver {} is too old; Kybern needs {} or newer. Ask the user to update it in Kybern Settings → Computer use.",
            installation.version.as_deref().unwrap_or("(unknown version)"),
            driver::INSTALL_VERSION
        );
        let signature = driver::read_signature(&installation.app).await;
        ensure!(
            signature.trusted() || driver::allow_unsigned(),
            "CuaDriver at {} is not signed by Cua AI. Reinstall it from Kybern Settings → Computer use.",
            installation.app.display()
        );
        // A daemon still running from an earlier client of ours stays ours.
        // Kybern starts it itself so its speed settings and cursor choice apply.
        if !driver::daemon_running(&installation).await {
            driver::launch_daemon(&installation, show_cursor).await?;
            self.inner.owns_daemon.store(true, Ordering::Relaxed);
            self.inner.daemon_cursor.store(show_cursor, Ordering::Relaxed);
        }
        let client = Arc::new(DriverClient::start(&installation, show_cursor).await?);
        *slot = Some(client.clone());
        Ok(client)
    }

    /// Close the `mcp` proxy, then stop CuaDriver's daemon if Kybern launched
    /// it. The caller holds the client slot, so no new client starts between.
    async fn release_locked(&self, slot: &mut Option<Arc<DriverClient>>) {
        slot.take();
        if self.inner.owns_daemon.swap(false, Ordering::Relaxed)
            && let Some(installation) = Installation::find()
            && !driver::stop_daemon(&installation).await
        {
            tracing::debug!("CuaDriver daemon did not stop");
        }
    }

    /// Treat a daemon started by CuaDriver's finished permission setup as
    /// Kybern's. It draws the cursor, so the next client restarts it without
    /// one unless the setting asks for it.
    pub(crate) async fn adopt_setup_daemon(&self, installation: &Installation) {
        let _client = self.inner.client.lock().await;
        if !self.inner.owns_daemon.load(Ordering::Relaxed) && driver::daemon_running(installation).await {
            self.inner.owns_daemon.store(true, Ordering::Relaxed);
            self.inner.daemon_cursor.store(true, Ordering::Relaxed);
        }
    }

    async fn windows_of(&self, client: &DriverClient, pid: Option<i64>) -> Result<Vec<WindowInfo>> {
        let arguments = match pid {
            Some(pid) => json!({ "pid": pid }),
            None => json!({}),
        };
        let result = client.call_ok("list_windows", arguments).await?;
        Ok(parse_windows(result.structured.get("windows")))
    }
}

#[async_trait]
impl super::backend::ComputerBackend for CuaDriverBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::CuaDriver
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            menu_bar: true,
            background_pixels: true,
            pixels: true,
            background_typing: true,
            background_keys: true,
            background_scroll: true,
            window_capture: true,
            zoom: true,
        }
    }

    fn installed(&self) -> bool {
        Installation::find().is_some_and(|installation| installation.version_supported())
    }

    async fn status(&self) -> BackendStatus {
        let enabled = self.inner.settings.get().computer_use.enabled;
        let mut status = BackendStatus {
            installed: false,
            path: None,
            version: None,
            required_version: driver::INSTALL_VERSION.into(),
            verified: false,
            accessibility: ComputerPermission::Unknown,
            screen_recording: ComputerPermission::Unknown,
            permission_holder: None,
            session: None,
            ready: false,
            checks: Vec::new(),
        };
        if !cfg!(target_os = "macos") {
            status.checks.push(check("platform", false, "CuaDriver needs macOS.", None));
            return status;
        }
        let Some(installation) = Installation::find() else {
            status.checks.push(check(
                "installed",
                false,
                "CuaDriver is not installed.",
                Some(format!(
                    "Install CuaDriver {} from Settings → Computer use, or run `kybern computer install`.",
                    driver::INSTALL_VERSION
                )),
            ));
            return status;
        };
        status.installed = true;
        status.path = Some(installation.app.display().to_string());
        status.version = installation.version.clone();
        let supported = installation.version_supported();
        let slow = installation.parsed_version().is_some_and(|version| version < driver::FAST_VERSION);
        status.checks.push(if supported && slow {
            // Still usable; failing the check is what makes Settings offer the update.
            check(
                "version",
                false,
                &format!(
                    "CuaDriver {} works, but {} makes each action about four times faster.",
                    installation.version.as_deref().unwrap_or("?"),
                    driver::INSTALL_VERSION
                ),
                Some("Update it from Settings → Computer use, or run `kybern computer install`.".into()),
            )
        } else if supported {
            let newer = installation.parsed_version().is_some_and(|(major, minor, _)| (major, minor) > driver::TESTED_MINOR);
            check(
                "version",
                true,
                &format!(
                    "CuaDriver {}{}",
                    installation.version.as_deref().unwrap_or("?"),
                    if newer { " is newer than Kybern has tested; report problems if actions misbehave." } else { "" }
                ),
                None,
            )
        } else {
            check(
                "version",
                false,
                &format!(
                    "CuaDriver {} is too old; Kybern needs {} or newer.",
                    installation.version.as_deref().unwrap_or("(unknown)"),
                    driver::INSTALL_VERSION
                ),
                Some("Update it from Settings → Computer use, or run `kybern computer install`.".into()),
            )
        });
        let signature = driver::read_signature(&installation.app).await;
        status.verified = signature.trusted();
        status.checks.push(if signature.trusted() {
            check("signature", true, "Signed by Cua AI, Inc.", None)
        } else if driver::allow_unsigned() {
            check("signature", true, "Unsigned build allowed by KYBERN_CUA_DRIVER_ALLOW_UNSIGNED.", None)
        } else {
            check(
                "signature",
                false,
                &format!(
                    "CuaDriver is not signed by Cua AI (identifier {}, team {}).",
                    signature.identifier.as_deref().unwrap_or("none"),
                    signature.team.as_deref().unwrap_or("none")
                ),
                Some("Reinstall it from Settings → Computer use.".into()),
            )
        });
        let usable = supported && (signature.trusted() || driver::allow_unsigned());
        // Asking CuaDriver about its permissions starts it, so a turned-off
        // feature never does.
        if usable && enabled {
            match self.client().await {
                Ok(client) => {
                    match client.call_ok("health_report", json!({ "include": ["tcc_accessibility", "tcc_screen_recording"] })).await {
                        Ok(report) => {
                            let checks = health_checks(&report.structured, &report.text);
                            status.accessibility = permission(&checks, "tcc_accessibility");
                            status.screen_recording = permission(&checks, "tcc_screen_recording");
                        }
                        Err(error) => {
                            status.checks.push(check("driver", false, &format!("CuaDriver did not report its status: {error}"), None))
                        }
                    }
                }
                Err(error) => status.checks.push(check("driver", false, &format!("CuaDriver did not start: {error}"), None)),
            }
            let grant_fix = || Some("Choose Grant access in Settings → Computer use, or run `kybern computer grant`.".to_owned());
            status.checks.push(match status.accessibility {
                ComputerPermission::Granted => check("accessibility", true, "Accessibility is allowed for CuaDriver.", None),
                _ => check("accessibility", false, "CuaDriver needs Accessibility permission to read and control apps.", grant_fix()),
            });
            status.checks.push(match status.screen_recording {
                ComputerPermission::Granted => check("screen_recording", true, "Screen Recording is allowed for CuaDriver.", None),
                _ => check("screen_recording", false, "CuaDriver needs Screen Recording permission for screenshots.", grant_fix()),
            });
        }
        status.ready = usable && status.accessibility == ComputerPermission::Granted;
        status
    }

    async fn install(&self) -> Result<()> {
        ensure!(cfg!(target_os = "macos"), "CuaDriver needs macOS. Use agent-desktop on this computer.");
        // Release the old driver before the installer replaces it.
        {
            let mut slot = self.inner.client.lock().await;
            self.release_locked(&mut slot).await;
        }
        let script = reqwest::get(installer_url())
            .await
            .and_then(reqwest::Response::error_for_status)
            .context("Could not download the CuaDriver installer. Check the network connection and try again.")?
            .text()
            .await?;
        ensure!(script.starts_with("#!"), "The CuaDriver installer download was not a script. Try again later.");
        let mut child = Command::new("/bin/bash")
            .arg("-c")
            .arg(&script)
            .arg("cua-driver-rs-install")
            .arg("--no-modify-path")
            .env("CUA_DRIVER_RS_VERSION", driver::INSTALL_VERSION)
            .env("CUA_DRIVER_RS_NO_MODIFY_PATH", "1")
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
            .env("CUA_TELEMETRY_ENABLED", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start the CuaDriver installer")?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let collect = |pipe: Option<tokio::process::ChildStdout>| async move {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_string(&mut text).await;
            }
            text
        };
        let collect_err = |pipe: Option<tokio::process::ChildStderr>| async move {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_string(&mut text).await;
            }
            text
        };
        let (status, out, err) = match tokio::time::timeout(INSTALL_TIMEOUT, async {
            let (out, err) = tokio::join!(collect(stdout), collect_err(stderr));
            (child.wait().await, out, err)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => bail!("The CuaDriver installer did not finish within 10 minutes. Try again, or install it from a terminal."),
        };
        tracing::info!(target: "kybern::computer", output = %tail(&format!("{out}\n{err}"), 4000), "CuaDriver installer finished");
        if !status?.success() {
            let detail = tail(&err, 600);
            let hint = if detail.contains("/Applications") && (detail.contains("not writable") || detail.contains("Permission denied")) {
                " Installing into /Applications needs an administrator account."
            } else {
                ""
            };
            bail!("The CuaDriver installer failed: {}{hint}", detail.trim());
        }
        ensure!(
            Installation::find().is_some_and(|installation| installation.version_supported()),
            "The installer finished but CuaDriver {} was not found in /Applications.",
            driver::INSTALL_VERSION
        );
        Ok(())
    }

    /// Launch the driver's own grant flow through LaunchServices so macOS
    /// attributes the dialogs to CuaDriver. It waits for the user, so Kybern
    /// leaves it running and Settings polls the status. A daemon the flow
    /// started becomes Kybern's once it finishes.
    async fn grant(&self) -> Result<()> {
        let installation = Installation::find().context("Install CuaDriver first.")?;
        let was_running = driver::daemon_running(&installation).await;
        let mut child = Command::new(&installation.binary)
            .args(["permissions", "grant"])
            .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start CuaDriver's permission setup")?;
        let backend = self.clone();
        tokio::spawn(async move {
            if tokio::time::timeout(GRANT_TIMEOUT, child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
            if !was_running {
                backend.adopt_setup_daemon(&installation).await;
            }
        });
        Ok(())
    }

    async fn warm(&self) -> Result<()> {
        self.client().await.map(|_| ())
    }

    async fn release(&self) {
        let mut slot = self.inner.client.lock().await;
        self.release_locked(&mut slot).await;
    }

    async fn windows(&self, pid: Option<i64>) -> Result<Vec<WindowInfo>> {
        let client = self.client().await?;
        self.windows_of(&client, pid).await
    }

    async fn apps(&self) -> Result<Vec<AppInfo>> {
        let client = self.client().await?;
        let result = client.call_ok("list_apps", json!({})).await?;
        Ok(result
            .structured
            .get("apps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|app| {
                let name = app.get("name").and_then(Value::as_str)?.to_owned();
                let app_id = app.get("bundle_id").and_then(Value::as_str).map(str::to_owned);
                Some(AppInfo {
                    regular: app_id.is_some(),
                    app_id,
                    pid: app.get("pid").and_then(Value::as_i64).filter(|pid| *pid > 0),
                    name,
                })
            })
            .collect())
    }

    async fn app_id_of(&self, pid: i64) -> Option<String> {
        macos::regular_app_bundle(pid).await
    }

    async fn find_app(&self, requested: &str) -> Option<(String, String)> {
        macos::spotlight_app(requested).await
    }

    async fn launch(&self, app: &str, app_id: Option<&str>) -> Result<Launched> {
        let client = self.client().await?;
        let arguments = match app_id {
            Some(bundle) => json!({ "bundle_id": bundle }),
            None => json!({ "name": app }),
        };
        let launched = client.call_ok("launch_app", arguments).await?;
        Ok(Launched {
            name: launched.structured.get("name").and_then(Value::as_str).unwrap_or(app).to_owned(),
            app_id: launched.structured.get("bundle_id").and_then(Value::as_str).map(str::to_owned),
            pid: launched.structured.get("pid").and_then(Value::as_i64),
            windows: parse_windows(launched.structured.get("windows")),
        })
    }

    async fn read(&self, target: Target, options: ReadOptions<'_>, session: &str) -> Result<WindowRead> {
        let client = self.client().await?;
        let mut request = json!({
            "pid": target.pid,
            "window_id": target.window_id,
            "include_screenshot": options.image_edge.is_some(),
            "session": session,
        });
        if !options.tree {
            request["include_accessibility_tree"] = json!(false);
        }
        if let Some(edge) = options.image_edge {
            request["max_image_dimension"] = json!(edge);
        }
        if let Some(query) = options.query {
            request["query"] = json!(query);
        }
        let result = client.call_ok("get_window_state", request).await?;
        Ok(WindowRead { snapshot: parse::parse_snapshot(&result.structured), image: image_of(&result) })
    }

    async fn zoom(&self, target: Target, region: Region, _edge: u32, session: &str) -> Result<Image> {
        let client = self.client().await?;
        let [x1, y1, x2, y2] = region;
        let result = client
            .call_ok(
                "zoom",
                json!({ "pid": target.pid, "window_id": target.window_id, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "session": session }),
            )
            .await?;
        image_of(&result).ok_or_else(|| anyhow!("CuaDriver returned no picture for the region"))
    }

    async fn act(&self, target: Target, act: &Act, mode: Mode, session: &str) -> Result<Outcome> {
        let client = self.client().await?;
        let (pid, window_id) = (target.pid, target.window_id);
        let delivery = mode.as_str();
        let window = json!({ "kind": "window", "pid": pid, "window_id": window_id });
        let (tool, arguments) = match act {
            Act::Press { token, button, count } => match (*count, button) {
                (2, _) => ("double_click", json!({ "pid": pid, "window_id": window_id, "element_token": token, "session": session })),
                (_, Button::Right) => {
                    ("right_click", json!({ "pid": pid, "window_id": window_id, "element_token": token, "session": session }))
                }
                _ => ("click", json!({ "target": window, "element_token": token, "delivery_mode": delivery, "session": session })),
            },
            Act::ClickAt { x, y, button, count, from_zoom } => {
                let mut arguments = json!({ "target": window, "x": x, "y": y, "delivery_mode": delivery, "session": session });
                if *from_zoom {
                    arguments["from_zoom"] = json!(true);
                }
                match button {
                    Button::Left => {}
                    Button::Right => arguments["button"] = json!("right"),
                    Button::Middle => arguments["button"] = json!("middle"),
                }
                if *count != 1 {
                    arguments["count"] = json!(count);
                }
                ("click", arguments)
            }
            Act::Type { text, into } => {
                let mut arguments =
                    json!({ "target": window, "text": text, "delay_ms": TYPE_DELAY_MS, "delivery_mode": delivery, "session": session });
                if let Some(token) = into {
                    arguments["element_token"] = json!(token);
                }
                ("type_text", arguments)
            }
            Act::Set { token, value } => {
                ("set_value", json!({ "pid": pid, "window_id": window_id, "element_token": token, "value": value, "session": session }))
            }
            Act::Key { keys, on } => {
                ensure!(!keys.is_empty(), "key is empty");
                let mut arguments = if keys.len() == 1 {
                    json!({ "target": window, "key": keys[0], "delivery_mode": delivery, "session": session })
                } else {
                    json!({ "target": window, "keys": keys, "delivery_mode": delivery, "session": session })
                };
                if let Some(token) = on {
                    arguments["element_token"] = json!(token);
                }
                (if keys.len() == 1 { "press_key" } else { "hotkey" }, arguments)
            }
            Act::Scroll { direction, amount, on } => {
                let direction = match direction {
                    Direction::Up => "up",
                    Direction::Down => "down",
                    Direction::Left => "left",
                    Direction::Right => "right",
                };
                let mut arguments =
                    json!({ "target": window, "direction": direction, "amount": amount, "delivery_mode": delivery, "session": session });
                if let Some(token) = on {
                    arguments["element_token"] = json!(token);
                }
                ("scroll", arguments)
            }
            Act::Menu { path } => ("invoke_menu", json!({ "pid": pid, "window_id": window_id, "path": path, "session": session })),
        };
        let result = client.call(tool, arguments).await?;
        Ok(outcome_of(&result))
    }
}

fn check(name: &str, ok: bool, message: &str, fix: Option<String>) -> ComputerCheck {
    ComputerCheck { name: name.into(), ok, message: message.into(), fix }
}

/// The pinned release's Rust installer. The top-level `install.sh` fetches
/// whatever is newest, so Kybern skips it.
fn installer_url() -> String {
    format!(
        "https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v{0}/libs/cua-driver/scripts/_install-rust.sh",
        driver::INSTALL_VERSION
    )
}

fn parse_windows(value: Option<&Value>) -> Vec<WindowInfo> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|window| {
            Some(WindowInfo {
                window_id: window.get("window_id")?.as_u64()?,
                pid: window.get("pid")?.as_i64()?,
                app: window.get("app_name").and_then(Value::as_str).unwrap_or("").to_owned(),
                title: window.get("title").and_then(Value::as_str).unwrap_or("").trim().to_owned(),
                on_screen: window.get("is_on_screen").and_then(Value::as_bool).unwrap_or(true),
                elsewhere: !window.get("on_current_space").and_then(Value::as_bool).unwrap_or(true),
                z_index: window.get("z_index").and_then(Value::as_i64),
            })
        })
        .collect()
}

fn image_of(result: &CallResult) -> Option<Image> {
    let (mime, data) = result.images.first()?;
    let size = |key: &str| result.structured.get(key).and_then(Value::as_u64).unwrap_or(0) as u32;
    Some(Image { mime: mime.clone(), data: data.clone(), width: size("screenshot_width"), height: size("screenshot_height") })
}

/// CuaDriver's structured `effect/route/escalation` as an [`Outcome`].
fn outcome_of(result: &CallResult) -> Outcome {
    let structured = &result.structured;
    let field = |key: &str| {
        structured
            .get(key)
            .or_else(|| structured.pointer(&format!("/delivery/{key}")))
            .or_else(|| structured.pointer(&format!("/action/{key}")))
            .and_then(Value::as_str)
    };
    let physical = field("route") == Some("global_input");
    let escalation = match structured.pointer("/escalation/target").and_then(Value::as_str) {
        Some("foreground") => Some(Escalation::Foreground),
        Some("pixel") => Some(Escalation::Pixel),
        _ => None,
    };
    if result.is_error {
        let message = result.error_message();
        // These refusals deliver nothing; the tools read the window again
        // and try once more.
        if needs_fresh_snapshot(structured, &message) {
            return Outcome::stale(message);
        }
        return Outcome { physical, ..Outcome::refused(message, escalation) };
    }
    let effect = match field("effect").unwrap_or("unverifiable") {
        "confirmed" => Effect::Confirmed,
        "partial" => Effect::Partial,
        "suspected_noop" => Effect::SuspectedNoop,
        "timeout" => Effect::Timeout,
        "refused" => Effect::Refused,
        _ => Effect::Unverifiable,
    };
    Outcome { effect, physical, escalation, note: None, stale: false }
}

/// The driver refused because its element snapshot no longer matches the
/// window, which Kybern can repair without the model's help.
fn needs_fresh_snapshot(structured: &Value, message: &str) -> bool {
    let code = structured.get("code").or_else(|| structured.pointer("/error/code")).and_then(Value::as_str).unwrap_or("");
    matches!(code, "stale_element_token" | "element_outside_target_window" | "snapshot_id_required" | "snapshot_stale")
        || structured.pointer("/escalation/recommended").and_then(Value::as_str) == Some("get_window_state")
        || message.contains("stale")
        || message.contains("no cached")
}

/// `health_report` returns `checks: [{name, status: pass|fail|skip}]`,
/// in structured content or as JSON text.
fn health_checks(structured: &Value, text: &str) -> Vec<(String, String)> {
    let parsed;
    let report = if structured.get("checks").is_some() {
        structured
    } else {
        parsed = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
        &parsed
    };
    report
        .get("checks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|check| Some((check.get("name")?.as_str()?.to_owned(), check.get("status")?.as_str()?.to_owned())))
        .collect()
}

fn permission(checks: &[(String, String)], name: &str) -> ComputerPermission {
    match checks.iter().find(|(check, _)| check == name).map(|(_, status)| status.as_str()) {
        Some("pass") => ComputerPermission::Granted,
        Some("fail") => ComputerPermission::Missing,
        _ => ComputerPermission::Unknown,
    }
}

fn tail(text: &str, max: usize) -> String {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(value: Value) -> CallResult {
        CallResult::from_value(&value)
    }

    #[test]
    fn reads_permission_checks_from_either_payload() {
        let structured = json!({"checks":[{"name":"tcc_accessibility","status":"pass"},{"name":"tcc_screen_recording","status":"fail"}]});
        let checks = health_checks(&structured, "");
        assert_eq!(permission(&checks, "tcc_accessibility"), ComputerPermission::Granted);
        assert_eq!(permission(&checks, "tcc_screen_recording"), ComputerPermission::Missing);
        let checks = health_checks(&Value::Null, &structured.to_string());
        assert_eq!(checks.len(), 2);
        assert_eq!(permission(&checks, "bundle_identity"), ComputerPermission::Unknown);
    }

    #[test]
    fn installer_is_pinned_to_the_release_tag() {
        assert!(installer_url().contains(&format!("cua-driver-rs-v{}", driver::INSTALL_VERSION)));
        assert!(!installer_url().contains("/main/"));
    }

    #[test]
    fn structured_effects_become_outcomes() {
        let confirmed = outcome_of(&result(json!({"structuredContent":{"effect":"confirmed","route":"accessibility"}})));
        assert_eq!(confirmed, Outcome::of(Effect::Confirmed));
        let physical = outcome_of(&result(json!({"structuredContent":{"effect":"unverifiable","route":"global_input"}})));
        assert!(physical.physical && physical.effect == Effect::Unverifiable);
        let nested =
            outcome_of(&result(json!({"structuredContent":{"delivery":{"effect":"partial"},"escalation":{"target":"foreground"}}})));
        assert_eq!((nested.effect, nested.escalation), (Effect::Partial, Some(Escalation::Foreground)));
        let none = outcome_of(&result(json!({"structuredContent":{}})));
        assert_eq!(none.effect, Effect::Unverifiable);
    }

    #[test]
    fn refusals_carry_their_reason_and_stale_ones_repair() {
        let refused = outcome_of(&result(json!({
            "isError": true,
            "content": [{"type":"text","text":"background_unavailable"}],
            "structuredContent": {"escalation":{"target":"pixel"}}
        })));
        assert_eq!((refused.effect, refused.escalation, refused.stale), (Effect::Refused, Some(Escalation::Pixel), false));
        assert_eq!(refused.note.as_deref(), Some("background_unavailable"));
        let stale = outcome_of(&result(json!({
            "isError": true,
            "content": [{"type":"text","text":"Background input refused"}],
            "structuredContent": {"code":"element_outside_target_window","effect":"refused","escalation":{"recommended":"get_window_state"}}
        })));
        assert!(stale.stale);
        assert!(needs_fresh_snapshot(&json!({}), "stale_element_token: take a new snapshot"));
        assert!(!needs_fresh_snapshot(&json!({"code":"background_unavailable","escalation":{"target":"foreground"}}), "refused"));
    }

    #[test]
    fn window_lists_name_spaces_and_hidden_windows() {
        let windows = parse_windows(Some(&json!([
            {"window_id": 7, "pid": 3, "app_name": "Notes", "title": " Todo ", "is_on_screen": true, "on_current_space": false, "z_index": 2},
            {"window_id": 8, "pid": 3},
        ])));
        assert_eq!(windows.len(), 2);
        assert!(windows[0].elsewhere && windows[0].on_screen && windows[0].title == "Todo");
        assert!(!windows[1].elsewhere && windows[1].on_screen);
    }
}
