//! One agent-desktop process per call.
//!
//! The binary is a canonical path (never a symlink: macOS attributes the
//! Accessibility grant to the binary or its responsible process, and a
//! symlink is open issue #398), the state root is Kybern's own private
//! directory, and every call is killed when it outlives the cap.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use kybern_protocol::process::NoWindow;
use tokio::process::Command;

use super::envelope::Envelope;
use super::install::{self, VerifyCache};

/// The commands whose parser accepts `--timeout-ms`.
const TIMEOUT_MS_COMMANDS: &[&str] = &[
    "snapshot",
    "find",
    "click",
    "double-click",
    "triple-click",
    "right-click",
    "type",
    "set-value",
    "clear",
    "select",
    "toggle",
    "check",
    "uncheck",
    "expand",
    "collapse",
    "scroll",
    "scroll-to",
    "focus",
    "list-windows",
    "list-apps",
];

/// A call that runs longer than this is killed (design §5).
pub(crate) const PROCESS_CAP: Duration = Duration::from_secs(20);
/// Room between the tool's own `--timeout-ms` and the kill.
const TIMEOUT_MARGIN: Duration = Duration::from_secs(4);

/// The command line of one call: `name flags… --session s [--headed]
/// [--timeout-ms n] -- positionals…`. Positionals follow `--` so text that
/// starts with a dash is never read as a flag.
#[derive(Debug, Clone, Default)]
pub(crate) struct Cmd {
    name: &'static str,
    sub: Option<&'static str>,
    flags: Vec<String>,
    positionals: Vec<String>,
    session: Option<String>,
    headed: bool,
    timeout: Option<(&'static str, u64)>,
}

impl Cmd {
    pub(crate) fn new(name: &'static str) -> Self {
        Self { name, ..Self::default() }
    }

    /// A subcommand, as in `session gc`.
    pub(crate) fn sub(mut self, name: &'static str) -> Self {
        self.sub = Some(name);
        self
    }

    pub(crate) fn flag(mut self, name: &str, value: impl ToString) -> Self {
        self.flags.push(name.to_owned());
        self.flags.push(value.to_string());
        self
    }

    pub(crate) fn switch(mut self, name: &str) -> Self {
        self.flags.push(name.to_owned());
        self
    }

    pub(crate) fn positional(mut self, value: impl Into<String>) -> Self {
        self.positionals.push(value.into());
        self
    }

    pub(crate) fn session(mut self, label: &str) -> Self {
        self.session = Some(session_id(label));
        self
    }

    pub(crate) fn headed(mut self, headed: bool) -> Self {
        self.headed = headed;
        self
    }

    /// `--timeout-ms n`. Only some commands take it: `status`, `get`, `press`,
    /// `screenshot`, `focus-window`, `mouse-click` and `permissions` reject it with
    /// exit 2 (checked against the 1.0.2 binary's argument parser).
    pub(crate) fn timeout_ms(mut self, ms: u64) -> Self {
        debug_assert!(TIMEOUT_MS_COMMANDS.contains(&self.name), "{} does not take --timeout-ms", self.name);
        self.timeout = Some(("--timeout-ms", ms));
        self
    }

    /// `--timeout n` (`launch`).
    pub(crate) fn launch_timeout_ms(mut self, ms: u64) -> Self {
        self.timeout = Some(("--timeout", ms));
        self
    }

    pub(crate) fn argv(&self) -> Vec<String> {
        let mut argv = vec![self.name.to_owned()];
        argv.extend(self.sub.map(str::to_owned));
        argv.extend(self.flags.iter().cloned());
        if let Some(session) = &self.session {
            argv.push("--session".into());
            argv.push(session.clone());
        }
        if self.headed {
            argv.push("--headed".into());
        }
        if let Some((flag, ms)) = self.timeout {
            argv.push(flag.into());
            argv.push(ms.to_string());
        }
        if !self.positionals.is_empty() {
            argv.push("--".into());
            argv.extend(self.positionals.iter().cloned());
        }
        argv
    }

    fn cap(&self) -> Duration {
        match self.timeout {
            Some((_, ms)) => (Duration::from_millis(ms) + TIMEOUT_MARGIN).min(PROCESS_CAP),
            None => PROCESS_CAP,
        }
    }
}

/// `kybern-<label>` with only characters a session id allows.
pub(crate) fn session_id(label: &str) -> String {
    let clean: String =
        label.chars().filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')).take(48).collect();
    if clean.is_empty() { "kybern-default".into() } else { format!("kybern-{clean}") }
}

/// Where the binary is and whether its hash is a pinned one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Binary {
    pub path: PathBuf,
    /// `KYBERN_AGENT_DESKTOP_BIN` or a test binary: not hash-checked.
    pub overridden: bool,
}

pub(crate) struct Runner {
    data_dir: PathBuf,
    override_bin: Option<PathBuf>,
    cache: VerifyCache,
}

impl Runner {
    pub(crate) fn new(data_dir: &Path, override_bin: Option<PathBuf>) -> Self {
        Self { data_dir: data_dir.to_path_buf(), override_bin, cache: VerifyCache::default() }
    }

    pub(crate) fn state_dir(&self) -> PathBuf {
        install::tools_dir(&self.data_dir).join("state")
    }

    /// The binary to run, canonical. `None` when nothing is installed.
    pub(crate) fn binary(&self) -> Option<Binary> {
        if let Some(path) = &self.override_bin {
            return path.canonicalize().ok().filter(|path| path.is_file()).map(|path| Binary { path, overridden: true });
        }
        let pin = install::current_pin()?;
        let path = install::install_dir(&self.data_dir).join(pin.binary_name());
        path.canonicalize().ok().filter(|path| path.is_file()).map(|path| Binary { path, overridden: false })
    }

    /// Is the installed build the pinned one? Overrides are never verified.
    pub(crate) fn verified(&self) -> bool {
        let Some(binary) = self.binary() else { return false };
        if binary.overridden {
            return false;
        }
        let Some(pin) = install::current_pin() else { return false };
        binary.path.parent().is_some_and(|dir| install::verify_dir(&self.cache, dir, pin).is_ok())
    }

    fn ensure_state_dir(&self) -> Result<PathBuf> {
        let dir = self.state_dir();
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The Linux build refuses a group-readable state root.
            for path in [&dir, &install::tools_dir(&self.data_dir)] {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                    .with_context(|| format!("restrict {}", path.display()))?;
            }
        }
        Ok(dir)
    }

    /// Run one call and parse its envelope. Errors mean the program could not
    /// run or printed no envelope; an `ok:false` envelope is returned as is.
    pub(crate) async fn run(&self, cmd: &Cmd) -> Result<Envelope> {
        let binary = self.binary().ok_or_else(|| {
            anyhow!("agent-desktop is not installed. Install it from Settings → Computer use, or run `kybern computer install`.")
        })?;
        if !binary.overridden {
            let pin = install::current_pin().ok_or_else(|| anyhow!("agent-desktop has no build for this machine"))?;
            let dir = binary.path.parent().ok_or_else(|| anyhow!("agent-desktop path has no directory"))?;
            install::verify_dir(&self.cache, dir, pin)
                .context("agent-desktop failed its integrity check. Reinstall it from Settings → Computer use.")?;
        }
        let state = self.ensure_state_dir()?;
        let argv = cmd.argv();
        let mut command = Command::new(&binary.path).no_window();
        command
            .args(&argv)
            .env("AGENT_DESKTOP_HOME", &state)
            .env_remove("AGENT_DESKTOP_SESSION")
            .env_remove("AGENT_DESKTOP_AGENT_ID")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().with_context(|| format!("start {}", binary.path.display()))?;
        let output = match tokio::time::timeout(cmd.cap(), child.wait_with_output()).await {
            Ok(output) => output.context("wait for agent-desktop")?,
            Err(_) => bail!("agent-desktop {} did not answer within {} s and was stopped", cmd.name, cmd.cap().as_secs()),
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let envelope = Envelope::parse(&stdout).with_context(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!(
                "agent-desktop {} exited with {} and stderr {:?}",
                cmd.name,
                output.status,
                stderr.trim().chars().take(200).collect::<String>()
            )
        })?;
        // Exit 2 is an argument error: Kybern built a bad command line.
        if output.status.code() == Some(2) {
            let note = envelope.error.as_ref().map(|error| error.note()).unwrap_or_else(|| "argument error".into());
            bail!("agent-desktop rejected the arguments of {}: {note}", cmd.name);
        }
        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_puts_flags_before_the_separator_and_text_after_it() {
        let cmd = Cmd::new("type").session("abc 123!").headed(true).timeout_ms(5300).positional("@s1:e2").positional("-rm -rf");
        assert_eq!(cmd.argv(), ["type", "--session", "kybern-abc123", "--headed", "--timeout-ms", "5300", "--", "@s1:e2", "-rm -rf"]);
        let launch = Cmd::new("launch").flag("--arg", "x").launch_timeout_ms(9000).positional("calc");
        assert_eq!(launch.argv(), ["launch", "--arg", "x", "--timeout", "9000", "--", "calc"]);
        let gc = Cmd::new("session").sub("gc").switch("--ended");
        assert_eq!(gc.argv(), ["session", "gc", "--ended"]);
        let plain = Cmd::new("list-apps").session("t1");
        assert_eq!(plain.argv(), ["list-apps", "--session", "kybern-t1"]);
    }

    #[test]
    fn session_ids_are_clean_and_never_empty() {
        assert_eq!(session_id("0123456789ab"), "kybern-0123456789ab");
        assert_eq!(session_id("../../etc"), "kybern-etc");
        assert_eq!(session_id(""), "kybern-default");
        assert_eq!(session_id(&"x".repeat(100)).len(), "kybern-".len() + 48);
    }

    #[test]
    fn the_process_cap_follows_the_tools_timeout_but_never_passes_twenty_seconds() {
        assert_eq!(Cmd::new("click").timeout_ms(5000).cap(), Duration::from_secs(9));
        assert_eq!(Cmd::new("snapshot").timeout_ms(25_000).cap(), PROCESS_CAP);
        assert_eq!(Cmd::new("screenshot").cap(), PROCESS_CAP);
    }

    #[test]
    #[should_panic(expected = "does not take --timeout-ms")]
    fn a_timeout_on_a_command_that_rejects_it_is_caught_in_tests() {
        let _ = Cmd::new("press").timeout_ms(1000);
    }

    #[cfg(unix)]
    mod fake {
        use std::os::unix::fs::PermissionsExt;

        use super::*;

        pub(crate) fn scratch() -> PathBuf {
            let dir = std::env::temp_dir().join(format!("kybern-ad-run-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        pub(crate) fn script(dir: &Path, body: &str) -> PathBuf {
            let path = dir.join("agent-desktop");
            kybern_protocol::process::write_executable(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            path
        }

        #[tokio::test]
        async fn a_call_gets_the_private_state_root_and_returns_its_envelope() {
            let dir = scratch();
            let bin = script(&dir, r#"printf '{"ok":true,"data":{"home":"%s","args":"%s"}}' "$AGENT_DESKTOP_HOME" "$*""#);
            let runner = Runner::new(&dir, Some(bin));
            let envelope = runner.run(&Cmd::new("status").session("t")).await.unwrap();
            let data = envelope.into_data().unwrap();
            assert_eq!(Path::new(data["home"].as_str().unwrap()), runner.state_dir());
            assert_eq!(data["args"], "status --session kybern-t");
            let mode = std::fs::metadata(runner.state_dir()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
            assert!(!runner.verified(), "an override is never verified");
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[tokio::test]
        async fn exit_two_is_an_argument_error_and_garbage_is_an_error() {
            let dir = scratch();
            let bin = script(&dir, r#"printf '{"ok":false,"error":{"code":"INVALID_ARGS","message":"bad flag"}}'; exit 2"#);
            let error = Runner::new(&dir, Some(bin)).run(&Cmd::new("click")).await.unwrap_err();
            assert!(error.to_string().contains("rejected the arguments") && error.to_string().contains("bad flag"), "{error}");
            let bin = script(&dir, "echo oops >&2; exit 1");
            assert!(Runner::new(&dir, Some(bin)).run(&Cmd::new("click")).await.is_err());
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[tokio::test]
        async fn a_missing_binary_says_how_to_install_it() {
            let dir = scratch();
            let error = Runner::new(&dir, Some(dir.join("nope"))).run(&Cmd::new("status")).await.unwrap_err();
            assert!(error.to_string().contains("not installed"), "{error}");
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
