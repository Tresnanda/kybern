//! Install, permission and environment checks for Settings, `computer.status`
//! and `kybern computer doctor` (design §5, "Doctor checks").

use std::path::Path;
use std::time::Duration;

use kybern_protocol::methods::{ComputerCheck, ComputerPermission};
use kybern_protocol::process::NoWindow;
use serde_json::Value;

use super::super::backend::{BackendStatus, Os};
use super::runner::Cmd;
use super::{AgentDesktopBackend, Display, install};

/// The Linux archive loader floor.
const GLIBC_FLOOR: (u32, u32) = (2, 35);

fn check(name: &str, ok: bool, message: impl Into<String>, fix: Option<&str>) -> ComputerCheck {
    ComputerCheck { name: name.into(), ok, message: message.into(), fix: fix.map(str::to_owned) }
}

/// `granted`/`not_required` count as allowed; `denied` is missing.
pub(super) fn permission(state: Option<&str>) -> ComputerPermission {
    match state {
        Some("granted" | "not_required") => ComputerPermission::Granted,
        Some("denied") => ComputerPermission::Missing,
        _ => ComputerPermission::Unknown,
    }
}

// ---- Linux ----

/// `ldd (Ubuntu GLIBC 2.39-0ubuntu8) 2.39` → (2, 39).
pub(super) fn parse_glibc(output: &str) -> Option<(u32, u32)> {
    let first = output.lines().next()?;
    if !first.to_lowercase().contains("glibc") && !first.to_lowercase().contains("gnu libc") {
        return None;
    }
    let version = first.split_whitespace().last()?;
    let mut parts = version.split(|character: char| !character.is_ascii_digit());
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DesktopSupport {
    Supported,
    BestEffort,
    Unsupported,
    Unknown,
}

/// Classify `XDG_CURRENT_DESKTOP` (a colon-separated list such as `ubuntu:GNOME`).
pub(super) fn classify_desktop(current: &str) -> (DesktopSupport, &'static str) {
    let lower = current.to_lowercase();
    let has = |names: &[&str]| lower.split(':').any(|part| names.contains(&part));
    if has(&["sway", "hyprland", "river", "wayfire", "labwc", "niri", "wlroots", "dwl", "cage"]) {
        (DesktopSupport::Unsupported, "wlroots compositors do not provide the input and screenshot services agent-desktop needs")
    } else if has(&["gnome", "ubuntu", "unity", "pop", "gnome-classic"]) && !has(&["kde"]) {
        (DesktopSupport::Supported, "GNOME is the supported desktop")
    } else if has(&["kde", "plasma"]) {
        (
            DesktopSupport::BestEffort,
            "KDE Plasma works on a best-effort basis: reading apps is expected to work, input and screenshots have gaps",
        )
    } else if lower.is_empty() {
        (DesktopSupport::Unknown, "the desktop is not named (XDG_CURRENT_DESKTOP is empty)")
    } else {
        (DesktopSupport::Unknown, "this desktop is untested")
    }
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

// ---- macOS: who holds the grants ----

/// The app System Settings lists for Accessibility and Screen Recording when
/// `agent-desktop` is started from `chain[0]` (an executable path), where
/// `chain` runs from the daemon up through its parents. macOS attributes the
/// grant to the responsible process: the nearest ancestor that is a GUI app
/// bundle; a daemon with no app above it (parent `launchd`) is its own.
pub(super) fn holder_from_chain(chain: &[String], daemon: &str) -> String {
    for path in chain {
        if let Some(end) = path.find(".app/").or_else(|| path.strip_suffix(".app").map(str::len)) {
            let bundle = &path[..end + 4];
            let name = Path::new(bundle).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| bundle.to_owned());
            return format!("{name} ({bundle})");
        }
    }
    format!("kybernd ({daemon})")
}

async fn process_ancestry(start: u32) -> Vec<String> {
    let mut chain = Vec::new();
    let mut pid = start;
    for _ in 0..16 {
        let Ok(output) = tokio::process::Command::new("/bin/ps")
            .no_window()
            .args(["-o", "ppid=,comm=", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
        else {
            break;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.trim();
        let Some((parent, comm)) = line.split_once(char::is_whitespace) else { break };
        chain.push(comm.trim().to_owned());
        match parent.trim().parse::<u32>() {
            Ok(parent) if parent > 1 => pid = parent,
            _ => break,
        }
    }
    chain
}

async fn mac_permission_holder() -> String {
    let daemon = std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_else(|_| "kybernd".into());
    holder_from_chain(&process_ancestry(std::process::id()).await, &daemon)
}

async fn glibc_output() -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("ldd").arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    Some(format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

// ---- Windows ----

/// A service or SYSTEM task has a machine account (`HOST$`) for a user name
/// and no console session name: there is no desktop to drive.
pub(super) fn windows_session_ok(username: Option<&str>, session_name: Option<&str>) -> bool {
    let machine = username.is_some_and(|name| name.ends_with('$') || name.eq_ignore_ascii_case("system"));
    !machine && (session_name.is_some() || username.is_some())
}

pub(super) async fn status(backend: &AgentDesktopBackend) -> BackendStatus {
    let os = backend.os;
    let binary = backend.runner.binary();
    let mut checks = Vec::new();
    let mut status = BackendStatus {
        installed: binary.is_some(),
        path: binary.as_ref().map(|binary| binary.path.display().to_string()),
        version: None,
        required_version: install::VERSION.to_owned(),
        verified: false,
        accessibility: ComputerPermission::Unknown,
        screen_recording: ComputerPermission::Unknown,
        permission_holder: None,
        session: None,
        ready: false,
        checks: Vec::new(),
    };
    let Some(binary) = binary else {
        let supported = install::current_pin().is_some();
        checks.push(check(
            "installed",
            false,
            if supported {
                format!("agent-desktop {} is not installed.", install::VERSION)
            } else {
                "agent-desktop has no build for this machine.".to_owned()
            },
            supported.then_some("Install it from Settings → Computer use, or run `kybern computer install`."),
        ));
        status.checks = checks;
        return status;
    };
    checks.push(check("installed", true, format!("agent-desktop is at {}.", binary.path.display()), None));

    status.verified = backend.runner.verified();
    checks.push(if binary.overridden {
        check(
            "verified",
            false,
            "unverified (override): KYBERN_AGENT_DESKTOP_BIN points at a build Kybern did not install.",
            Some("Unset KYBERN_AGENT_DESKTOP_BIN to use the pinned build."),
        )
    } else if status.verified {
        let unsigned =
            if os == Os::Windows { " The Windows build is unsigned, so SmartScreen may warn if you run it by hand." } else { "" };
        check(
            "verified",
            true,
            format!("The installed files match the pinned agent-desktop {} checksums.{unsigned}", install::VERSION),
            None,
        )
    } else {
        check(
            "verified",
            false,
            "The installed agent-desktop does not match the pinned checksums.",
            Some("Reinstall it from Settings → Computer use."),
        )
    });

    // One `status` call carries the version, the permissions and the surfaces.
    let report = backend.run(Cmd::new("status")).await;
    let data = match report.map(|envelope| envelope.into_data()) {
        Ok(Ok(data)) => Some(data),
        Ok(Err(error)) | Err(error) => {
            checks.push(check(
                "version",
                false,
                format!("agent-desktop did not answer `status`: {error}"),
                Some("Reinstall it from Settings → Computer use."),
            ));
            None
        }
    };
    let surfaces_empty =
        data.as_ref().and_then(|data| data.get("supported_surfaces")).and_then(Value::as_array).is_some_and(|surfaces| surfaces.is_empty());
    if let Some(data) = &data {
        status.version = data.get("version").and_then(Value::as_str).map(str::to_owned);
        let version = status.version.as_deref().unwrap_or("unknown");
        checks.push(if version == install::VERSION || binary.overridden {
            check("version", true, format!("agent-desktop {version}"), None)
        } else {
            check(
                "version",
                false,
                format!("agent-desktop {version} is installed; Kybern expects {}.", install::VERSION),
                Some("Reinstall it from Settings → Computer use."),
            )
        });
        let state = |name: &str| data.pointer(&format!("/permissions/{name}/state")).and_then(Value::as_str);
        status.accessibility = permission(state("accessibility"));
        status.screen_recording = permission(state("screen_recording"));
    }

    match os {
        Os::Mac => {
            let holder = mac_permission_holder().await;
            checks.push(check(
                "accessibility",
                status.accessibility == ComputerPermission::Granted,
                match status.accessibility {
                    ComputerPermission::Granted => "Accessibility is allowed.".to_owned(),
                    _ => "Kybern needs Accessibility to use agent-desktop.".to_owned(),
                },
                (status.accessibility != ComputerPermission::Granted)
                    .then_some("Open System Settings → Privacy & Security → Accessibility and turn on the entry named below."),
            ));
            checks.push(check(
                "screen_recording",
                status.screen_recording == ComputerPermission::Granted,
                match status.screen_recording {
                    ComputerPermission::Granted => "Screen Recording is allowed.".to_owned(),
                    _ => "Kybern needs Screen Recording to use agent-desktop for screenshots.".to_owned(),
                },
                (status.screen_recording != ComputerPermission::Granted)
                    .then_some("Open System Settings → Privacy & Security → Screen Recording and turn on the entry named below."),
            ));
            checks.push(check(
                "permission_holder",
                true,
                format!("macOS lists {holder} for these permissions. If it also lists the agent-desktop binary, turn that on too."),
                None,
            ));
            status.permission_holder = Some(holder);
        }
        Os::Windows => {
            let ok = windows_session_ok(std::env::var("USERNAME").ok().as_deref(), std::env::var("SESSIONNAME").ok().as_deref());
            checks.push(check(
                "session",
                ok,
                if ok {
                    "Kybern runs in an interactive desktop session."
                } else {
                    "Kybern is running as a service or SYSTEM task, which has no desktop to drive."
                },
                (!ok).then_some("Start Kybern from the signed-in user's desktop session."),
            ));
            checks.push(check(
                "elevation",
                true,
                "Apps run as administrator cannot be controlled from a normal session; Kybern says so instead of retrying.",
                None,
            ));
            if std::env::consts::ARCH == "aarch64" {
                checks.push(check(
                    "arm64",
                    false,
                    "agent-desktop on Windows ARM64 can crash when it exits (upstream issue #417); results are still delivered.",
                    None,
                ));
            }
        }
        Os::Linux | Os::Other => {
            let glibc = glibc_output().await.as_deref().and_then(parse_glibc);
            checks.push(match glibc {
                Some(version) if version >= GLIBC_FLOOR => check("glibc", true, format!("glibc {}.{}", version.0, version.1), None),
                Some(version) => check(
                    "glibc",
                    false,
                    format!("glibc {}.{} is older than the 2.35 agent-desktop needs.", version.0, version.1),
                    Some("Use Ubuntu 24.04 or newer."),
                ),
                None => check(
                    "glibc",
                    false,
                    "glibc 2.35 or newer was not found (musl systems are not supported).",
                    Some("Use Ubuntu 24.04 or newer."),
                ),
            });
            let (display, desktop) = (backend.display, std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default());
            checks.push(match display {
                Display::X11 => check("display", true, "X11 session.", None),
                Display::Wayland => check("display", true, "Wayland session: windows are read through accessibility, screenshots show the whole display after a one-time permission, and pixel clicks are not available.", None),
                Display::None => check("display", false, "No graphical session was found (DISPLAY and WAYLAND_DISPLAY are unset).", Some("Start Kybern from the signed-in user's desktop session, not over SSH or from a TTY.")),
            });
            let (support, why) = classify_desktop(&desktop);
            checks.push(check(
                "desktop",
                !matches!(support, DesktopSupport::Unsupported),
                format!("{}: {why}.", if desktop.is_empty() { "unknown desktop" } else { &desktop }),
                matches!(support, DesktopSupport::Unsupported).then_some("Use a GNOME session."),
            ));
            if data.is_some() {
                checks.push(if surfaces_empty {
                    check(
                        "atspi",
                        false,
                        "The accessibility bus did not answer, so no app can be read.",
                        Some("Run `gsettings set org.gnome.desktop.interface toolkit-accessibility true`, then sign out and in. Restart apps that were open before."),
                    )
                } else {
                    check("atspi", true, "The accessibility bus is on.", None)
                });
            }
            if backend.wayland() {
                let present = on_path("wl-copy") && on_path("wl-paste");
                checks.push(check(
                    "clipboard",
                    true,
                    if present {
                        "wl-clipboard is installed."
                    } else {
                        "wl-clipboard is not installed; clipboard commands are unavailable (Kybern's tools do not use them)."
                    },
                    None,
                ));
            }
            status.session = Some(match (display, desktop.split(':').next_back().filter(|name| !name.is_empty())) {
                (Display::Wayland, Some(name)) => format!("wayland ({name})"),
                (Display::X11, Some(name)) => format!("x11 ({name})"),
                (Display::Wayland, None) => "wayland".into(),
                (Display::X11, None) => "x11".into(),
                (Display::None, _) => "none".into(),
            });
        }
    }

    let linux_unusable = os == Os::Linux
        && (surfaces_empty || checks.iter().any(|check| matches!(check.name.as_str(), "glibc" | "display" | "desktop") && !check.ok));
    status.ready = status.installed
        && (status.verified || binary.overridden)
        && status.accessibility == ComputerPermission::Granted
        && data.is_some()
        && !linux_unusable;
    status.checks = checks;
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_states_map() {
        assert_eq!(permission(Some("granted")), ComputerPermission::Granted);
        assert_eq!(permission(Some("not_required")), ComputerPermission::Granted);
        assert_eq!(permission(Some("denied")), ComputerPermission::Missing);
        assert_eq!(permission(Some("unknown")), ComputerPermission::Unknown);
        assert_eq!(permission(None), ComputerPermission::Unknown);
    }

    #[test]
    fn recorded_status_envelopes_map_to_permissions() {
        let mac: Value = serde_json::from_str(include_str!("fixtures/macos/status_denied.json")).unwrap();
        let state =
            |data: &Value, name: &str| data.pointer(&format!("/data/permissions/{name}/state")).and_then(Value::as_str).map(str::to_owned);
        assert_eq!(permission(state(&mac, "accessibility").as_deref()), ComputerPermission::Missing);
        assert_eq!(permission(state(&mac, "screen_recording").as_deref()), ComputerPermission::Missing);
        let windows: Value = serde_json::from_str(include_str!("fixtures/windows/status.json")).unwrap();
        assert_eq!(permission(state(&windows, "accessibility").as_deref()), ComputerPermission::Granted);
        assert_eq!(permission(state(&windows, "screen_recording").as_deref()), ComputerPermission::Granted);
    }

    #[test]
    fn glibc_versions_parse_and_other_libcs_do_not() {
        assert_eq!(parse_glibc("ldd (Ubuntu GLIBC 2.39-0ubuntu8.3) 2.39\nCopyright (C) 2024"), Some((2, 39)));
        assert_eq!(parse_glibc("ldd (GNU libc) 2.35"), Some((2, 35)));
        assert_eq!(parse_glibc("ldd (Debian GLIBC 2.31-13+deb11u5) 2.31"), Some((2, 31)));
        assert_eq!(parse_glibc("musl libc (x86_64)\nVersion 1.2.4"), None);
        assert_eq!(parse_glibc(""), None);
        assert!(parse_glibc("ldd (Ubuntu GLIBC 2.39) 2.39").unwrap() >= GLIBC_FLOOR);
        assert!(parse_glibc("ldd (Debian GLIBC 2.31) 2.31").unwrap() < GLIBC_FLOOR);
    }

    #[test]
    fn desktops_are_classified() {
        assert_eq!(classify_desktop("ubuntu:GNOME").0, DesktopSupport::Supported);
        assert_eq!(classify_desktop("GNOME").0, DesktopSupport::Supported);
        assert_eq!(classify_desktop("KDE").0, DesktopSupport::BestEffort);
        assert_eq!(classify_desktop("sway").0, DesktopSupport::Unsupported);
        assert_eq!(classify_desktop("Hyprland").0, DesktopSupport::Unsupported);
        assert_eq!(classify_desktop("XFCE").0, DesktopSupport::Unknown);
        assert_eq!(classify_desktop("").0, DesktopSupport::Unknown);
    }

    #[test]
    fn the_mac_permission_holder_is_the_nearest_app_above_the_daemon() {
        let chain = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect::<Vec<_>>();
        assert_eq!(
            holder_from_chain(
                &chain(&["/Applications/Kybern.app/Contents/Resources/kybernd", "/Applications/Kybern.app/Contents/MacOS/kybern"]),
                "/x/kybernd"
            ),
            "Kybern (/Applications/Kybern.app)"
        );
        assert_eq!(
            holder_from_chain(
                &chain(&["/usr/local/bin/kybernd", "/bin/zsh", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]),
                "/usr/local/bin/kybernd"
            ),
            "Terminal (/System/Applications/Utilities/Terminal.app)"
        );
        // Started by launchd with no app above: the daemon holds its own grant.
        assert_eq!(holder_from_chain(&chain(&["/usr/local/bin/kybernd"]), "/usr/local/bin/kybernd"), "kybernd (/usr/local/bin/kybernd)");
        assert_eq!(holder_from_chain(&[], "/opt/kybernd"), "kybernd (/opt/kybernd)");
    }

    #[test]
    fn a_service_account_has_no_desktop() {
        assert!(windows_session_ok(Some("satya"), Some("Console")));
        assert!(windows_session_ok(Some("satya"), None));
        assert!(!windows_session_ok(Some("DESKTOP-ABC$"), None));
        assert!(!windows_session_ok(Some("SYSTEM"), None));
        assert!(!windows_session_ok(None, None));
    }
}
