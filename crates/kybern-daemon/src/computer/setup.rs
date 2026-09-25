//! Install and permission status for Settings, `kybern computer doctor`, and
//! the setup actions behind them.

use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use kybern_protocol::methods::{ComputerCheck, ComputerPermission, ComputerSetupAction, ComputerStatus};
use serde_json::{Value, json};
use tokio::process::Command;

use super::ComputerUse;
use super::driver::{self, Installation};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const GRANT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The Rust installer from the pinned release tag. The top-level
/// `install.sh` fetches whatever is newest, so Kybern skips it.
fn installer_url() -> String {
    format!(
        "https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v{0}/libs/cua-driver/scripts/_install-rust.sh",
        driver::INSTALL_VERSION
    )
}

pub(crate) async fn status(computer: &ComputerUse) -> ComputerStatus {
    let settings = computer.inner.settings.get();
    let mut status = ComputerStatus {
        supported: cfg!(target_os = "macos"),
        enabled: settings.computer_use.enabled,
        installed: false,
        app_path: None,
        version: None,
        required_version: driver::INSTALL_VERSION.into(),
        signed: false,
        accessibility: ComputerPermission::Unknown,
        screen_recording: ComputerPermission::Unknown,
        ready: false,
        checks: Vec::new(),
    };
    if !status.supported {
        status.checks.push(check("platform", false, "Computer use needs macOS.", None));
        return status;
    }
    let Some(installation) = Installation::find() else {
        status.checks.push(check(
            "installed",
            false,
            "CuaDriver is not installed.",
            Some(format!("Install CuaDriver {} from Settings → Computer use, or run `kybern computer install`.", driver::INSTALL_VERSION)),
        ));
        return status;
    };
    status.installed = true;
    status.app_path = Some(installation.app.display().to_string());
    status.version = installation.version.clone();
    let supported = installation.version_supported();
    status.checks.push(if supported {
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
    status.signed = signature.trusted();
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
    if !status.enabled {
        status.checks.push(check("enabled", false, "Computer use is turned off.", Some("Turn it on in Settings → Computer use.".into())));
    }
    let usable = supported && (signature.trusted() || driver::allow_unsigned());
    if usable && status.enabled {
        match computer.client().await {
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
    status.ready = usable && status.enabled && status.accessibility == ComputerPermission::Granted;
    status
}

pub(crate) async fn setup(computer: &ComputerUse, action: ComputerSetupAction) -> Result<ComputerStatus> {
    ensure!(cfg!(target_os = "macos"), "Computer use needs macOS.");
    match action {
        ComputerSetupAction::Install => install(computer).await?,
        ComputerSetupAction::GrantPermissions => grant().await?,
    }
    Ok(status(computer).await)
}

async fn install(computer: &ComputerUse) -> Result<()> {
    // Release the old driver before the installer replaces it.
    computer.inner.client.lock().await.take();
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
/// leaves it running and Settings polls the status.
async fn grant() -> Result<()> {
    let installation = Installation::find().context("Install CuaDriver first.")?;
    let mut child = Command::new(&installation.binary)
        .args(["permissions", "grant"])
        .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Could not start CuaDriver's permission setup")?;
    tokio::spawn(async move {
        if tokio::time::timeout(GRANT_TIMEOUT, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    });
    Ok(())
}

fn check(name: &str, ok: bool, message: &str, fix: Option<String>) -> ComputerCheck {
    ComputerCheck { name: name.into(), ok, message: message.into(), fix }
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
    let start = text.len().saturating_sub(max);
    let mut start = start;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
