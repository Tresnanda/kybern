//! Machines reached over SSH. `remote_bootstrap` turns `user@host` into a
//! paired environment: it probes the machine, installs `kybernd` when missing,
//! starts it, opens a loopback port-forward tunnel, mints a pairing code
//! through that tunnel with the daemon's bootstrap token, and pairs this
//! desktop like any other device. The tunnel stays open, and is respawned,
//! for as long as the environment is in use; the WebSocket client only ever
//! sees `ws://127.0.0.1:<port>/ws`.
//!
//! Everything goes through the user's own `ssh` (keys, agent, `~/.ssh/config`
//! aliases, jump hosts). Kybern never handles an SSH password.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::{DaemonInfo, DaemonInfoMethod, Empty, PairingCreate, PairingCreateParams};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::environments::{EnvironmentProfile, SaveEnvironment};

/// Where a fresh machine downloads the daemon from. `KYBERN_REMOTE_INSTALL_URL`
/// overrides it for testing against an unpublished build.
const INSTALL_URL: &str = "https://github.com/Tresnanda/kybern/releases/latest/download/kybern-remote-install.sh";
const DEFAULT_REMOTE_PORT: u16 = 4173;
const PROGRESS_EVENT: &str = "remote-bootstrap";
const REMOTE_PATH: &str = r#"PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH"#;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshConfig {
    /// `user@host` or a `Host` alias from `~/.ssh/config`.
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Port `kybernd` listens on at the remote loopback.
    pub remote_port: u16,
    /// Loopback port on this machine the tunnel prefers; another one is used when it is taken.
    pub local_port: u16,
    /// Daemon data directory on that machine when it is not `~/.kybern`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct BootstrapInput {
    pub id: Option<String>,
    pub name: String,
    pub target: String,
    #[serde(default)]
    pub data_dir: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    step: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

// ---- targets -----------------------------------------------------------------

/// Accepts `host`, `user@host`, `host:port`, `user@host:port` and an `ssh://`
/// prefix. Rejects anything `ssh` could read as an option.
pub fn parse_target(input: &str) -> Result<(String, Option<u16>)> {
    let value = input.trim();
    let value = value.strip_prefix("ssh://").unwrap_or(value).trim_end_matches('/');
    if value.is_empty() {
        bail!("Enter the machine as user@host");
    }
    let (target, port) = match value.rsplit_once(':') {
        Some((head, tail)) if !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
            let port: u16 = tail.parse().ok().filter(|p| *p > 0).context("Enter an SSH port between 1 and 65535")?;
            (head, Some(port))
        }
        _ => (value, None),
    };
    let (user, host) = match target.rsplit_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, target),
    };
    let valid = |part: &str| {
        !part.is_empty() && !part.starts_with('-') && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    if !valid(host) || user.is_some_and(|u| !valid(u)) {
        bail!("Enter the machine as user@host, using only letters, digits, dots, dashes and underscores");
    }
    Ok((target.to_string(), port))
}

// ---- ssh ---------------------------------------------------------------------

fn ssh_binary() -> std::ffi::OsString {
    std::env::var_os("KYBERN_SSH").unwrap_or_else(|| "ssh".into())
}

fn ssh(config: &SshConfig) -> Command {
    let mut cmd = Command::new(ssh_binary());
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "LogLevel=ERROR",
    ]);
    if let Some(port) = config.port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.kill_on_drop(true);
    cmd
}

/// Run a POSIX `sh` script on the machine and return its stdout.
async fn ssh_run(config: &SshConfig, script: &str, timeout: Duration) -> Result<String> {
    let mut child = ssh(config)
        .arg(&config.target)
        .arg("sh")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Start ssh; install OpenSSH and make sure `ssh` is on PATH")?;
    let mut stdin = child.stdin.take().context("ssh stdin")?;
    let data_dir = match &config.data_dir {
        Some(dir) => format!("KYBERN_DATA_DIR={}", shell_quote(dir)),
        None => "KYBERN_DATA_DIR=\"$HOME/.kybern\"".into(),
    };
    let script = format!("{REMOTE_PATH}\n{data_dir}; export KYBERN_DATA_DIR\n{script}\n");
    tokio::spawn(async move {
        let _ = stdin.write_all(script.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("{} did not answer within {} seconds", config.target, timeout.as_secs()))??;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        bail!("{}", explain_ssh_failure(&config.target, output.status.code(), &stderr));
    }
    Ok(stdout)
}

/// Single-quote a value for POSIX sh.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn explain_ssh_failure(target: &str, code: Option<i32>, stderr: &str) -> String {
    let host = target.rsplit('@').next().unwrap_or(target);
    if stderr.contains("Permission denied") {
        return format!(
            "SSH could not sign in to {target} without a password. Copy your key there with `ssh-copy-id {target}` or load it in ssh-agent, then try again"
        );
    }
    if stderr.contains("Could not resolve hostname") || stderr.contains("Name or service not known") {
        return format!("Unable to resolve {host}. Check the address");
    }
    if stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") || stderr.contains("Host key verification failed") {
        return format!("The SSH host key for {host} changed. Verify the machine, then remove its old entry from ~/.ssh/known_hosts");
    }
    if stderr.contains("Connection refused") || stderr.contains("timed out") || stderr.contains("No route to host") {
        return format!("Unable to reach {target} over SSH. Check that the machine is on and its SSH port is open");
    }
    let detail = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    match code {
        Some(255) if detail.is_empty() => format!("SSH to {target} failed"),
        Some(255) => format!("SSH to {target} failed: {detail}"),
        Some(code) if detail.is_empty() => format!("The command on {target} exited with status {code} and no output"),
        None if detail.is_empty() => format!("The command on {target} was killed by a signal"),
        _ => format!("{target}: {detail}"),
    }
}

// ---- remote scripts ----------------------------------------------------------

#[derive(Debug, Default)]
struct Probe {
    os: String,
    arch: String,
    kybernd: Option<String>,
    version: Option<String>,
    curl: bool,
    port: Option<u16>,
    token: Option<String>,
}

const PROBE_SCRIPT: &str = r#"
set -u
printf 'os=%s\n' "$(uname -s)"
printf 'arch=%s\n' "$(uname -m)"
if command -v kybernd >/dev/null 2>&1; then
  printf 'kybernd=%s\n' "$(command -v kybernd)"
  printf 'version=%s\n' "$(kybernd --version 2>/dev/null | awk '{print $NF}')"
fi
command -v curl >/dev/null 2>&1 && echo curl=1
[ -f "$KYBERN_DATA_DIR/daemon.port" ] && printf 'port=%s\n' "$(cat "$KYBERN_DATA_DIR/daemon.port")"
[ -f "$KYBERN_DATA_DIR/daemon.token" ] && printf 'token=%s\n' "$(cat "$KYBERN_DATA_DIR/daemon.token")"
exit 0
"#;

fn parse_probe(output: &str) -> Probe {
    let mut probe = Probe::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "os" => probe.os = value.into(),
            "arch" => probe.arch = value.into(),
            "kybernd" => probe.kybernd = Some(value.into()),
            "version" if !value.is_empty() => probe.version = Some(value.into()),
            "curl" => probe.curl = value == "1",
            "port" => probe.port = value.parse().ok(),
            "token" if !value.is_empty() => probe.token = Some(value.into()),
            _ => {}
        }
    }
    probe
}

async fn probe(config: &SshConfig) -> Result<Probe> {
    Ok(parse_probe(&ssh_run(config, PROBE_SCRIPT, Duration::from_secs(45)).await?))
}

fn install_script() -> String {
    let url = std::env::var("KYBERN_REMOTE_INSTALL_URL").unwrap_or_else(|_| INSTALL_URL.into());
    format!(
        r#"set -eu
command -v curl >/dev/null 2>&1 || {{ echo "curl is not installed on this machine; install it and try again" >&2; exit 1; }}
curl --proto '=https' --tlsv1.2 -LsSf '{url}' | sh
"#
    )
}

/// Starts the daemon on the remote loopback: as a systemd user service where
/// one is available (surviving logout and reboot), otherwise detached with
/// nohup. The service inherits the SSH session's PATH so the agent CLIs it
/// finds are the ones the user has installed.
fn start_script(port: u16) -> String {
    format!(
        r#"set -eu
mkdir -p "$KYBERN_DATA_DIR"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  unit="$HOME/.config/systemd/user/kybernd.service"
  if [ ! -f "$unit" ]; then
    mkdir -p "$(dirname "$unit")"
    cat > "$unit" <<UNIT
[Unit]
Description=Kybern agent daemon

[Service]
ExecStart=$(command -v kybernd) --bind 127.0.0.1 --port {port} --data-dir $KYBERN_DATA_DIR
WorkingDirectory=%h
Environment="PATH=$PATH"
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now kybernd >/dev/null 2>&1 || systemctl --user restart kybernd
  command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
else
  nohup kybernd --bind 127.0.0.1 --port {port} --data-dir "$KYBERN_DATA_DIR" >>"$KYBERN_DATA_DIR/daemon.log" 2>&1 </dev/null &
fi
"#
    )
}

// ---- tunnels -----------------------------------------------------------------

#[derive(Clone, Debug)]
enum TunnelStatus {
    Starting,
    Ready,
    Failed(String),
}

struct Tunnel {
    config: SshConfig,
    local_port: u16,
    status: Arc<std::sync::Mutex<TunnelStatus>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        // Aborting the task drops its ssh child, which is kill_on_drop.
        self.task.abort();
    }
}

static TUNNELS: Mutex<Option<HashMap<String, Tunnel>>> = Mutex::const_new(None);

fn free_port() -> Result<u16> {
    Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?.local_addr()?.port())
}

fn port_is_free(port: u16) -> bool {
    port != 0 && TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

async fn port_accepts(port: u16) -> bool {
    tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))))
        .await
        .is_ok_and(|r| r.is_ok())
}

/// `ssh -N -L` for one tunnel. Resolves once the local port accepts
/// connections (ssh only listens after it has authenticated).
///
/// Multiplexing is off for this process on purpose: through a `ControlMaster`
/// socket from the user's ssh config, `ssh -N -L` hands the forward to the
/// master and exits 0 within a second, so the child's lifetime would no longer
/// track the forward and the keeper would report the tunnel as failed.
async fn spawn_tunnel(config: &SshConfig, local_port: u16) -> Result<Child> {
    let mut child = ssh(config)
        .args(["-o", "ControlMaster=no", "-o", "ControlPath=none", "-N", "-o", "ExitOnForwardFailure=yes", "-L"])
        .arg(format!("127.0.0.1:{local_port}:127.0.0.1:{}", config.remote_port))
        .arg(&config.target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("Start ssh; install OpenSSH and make sure `ssh` is on PATH")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait()? {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let _ = pipe.read_to_string(&mut stderr).await;
            }
            bail!("{}", explain_ssh_failure(&config.target, status.code(), stderr.trim()));
        }
        if port_accepts(local_port).await {
            return Ok(child);
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("The SSH tunnel to {} did not open within 30 seconds", config.target);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Keeps one tunnel alive on a fixed local port until the task is aborted, so
/// the saved `ws://127.0.0.1:<port>/ws` address stays valid across network
/// changes and sleep.
async fn keep_tunnel(config: SshConfig, local_port: u16, status: Arc<std::sync::Mutex<TunnelStatus>>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match spawn_tunnel(&config, local_port).await {
            Ok(mut child) => {
                *status.lock().unwrap() = TunnelStatus::Ready;
                backoff = Duration::from_secs(1);
                let exit = child.wait().await;
                log::warn!("ssh tunnel to {} ended ({exit:?}); reconnecting", config.target);
                *status.lock().unwrap() = TunnelStatus::Starting;
            }
            Err(error) => {
                log::warn!("ssh tunnel to {}: {error:#}", config.target);
                *status.lock().unwrap() = TunnelStatus::Failed(format!("{error:#}"));
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// Make sure a tunnel for this environment is up and return its local port.
pub async fn ensure_tunnel(id: &str, config: &SshConfig) -> Result<u16> {
    let mut guard = TUNNELS.lock().await;
    let tunnels = guard.get_or_insert_with(HashMap::new);
    if let Some(existing) = tunnels.get(id) {
        let same = existing.config.target == config.target
            && existing.config.port == config.port
            && existing.config.remote_port == config.remote_port;
        if same {
            let status = existing.status.clone();
            let port = existing.local_port;
            drop(guard);
            return wait_ready(port, &status).await.map(|()| port);
        }
        tunnels.remove(id);
    }
    let local_port = if port_is_free(config.local_port) { config.local_port } else { free_port()? };
    let status = Arc::new(std::sync::Mutex::new(TunnelStatus::Starting));
    let task = tokio::spawn(keep_tunnel(config.clone(), local_port, status.clone()));
    tunnels.insert(id.to_string(), Tunnel { config: config.clone(), local_port, status: status.clone(), task });
    drop(guard);
    wait_ready(local_port, &status).await.map(|()| local_port)
}

async fn wait_ready(port: u16, status: &Arc<std::sync::Mutex<TunnelStatus>>) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(35);
    loop {
        match status.lock().unwrap().clone() {
            TunnelStatus::Ready => return Ok(()),
            TunnelStatus::Failed(error) => bail!("{error}"),
            TunnelStatus::Starting => {}
        }
        if port_accepts(port).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("The SSH tunnel did not open in time");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

pub async fn stop_tunnel(id: &str) {
    if let Some(tunnels) = TUNNELS.lock().await.as_mut() {
        tunnels.remove(id);
    }
}

// ---- bootstrap ---------------------------------------------------------------

fn report<R: tauri::Runtime>(app: &tauri::AppHandle<R>, step: &'static str, state: &'static str, detail: Option<String>) {
    let _ = app.emit(PROGRESS_EVENT, Progress { step, state, detail });
}

fn endpoint(local_port: u16, token: &str) -> Endpoint {
    Endpoint { url: format!("ws://127.0.0.1:{local_port}/ws"), token: token.to_string() }
}

async fn daemon_info(local_port: u16, token: &str) -> Result<DaemonInfo> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let client = Client::connect(&endpoint(local_port, token)).await?;
        client.call::<DaemonInfoMethod>(Empty {}).await
    })
    .await
    .context("The daemon did not answer through the tunnel")?
}

/// Everything after the machine is reachable over SSH, so a failure can tear
/// the tunnel down and the caller can report the failed step.
async fn bootstrap<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    name: &str,
    config: &mut SshConfig,
) -> Result<EnvironmentProfile> {
    report(app, "connect", "running", None);
    let mut machine = probe(config).await?;
    report(app, "connect", "done", Some(format!("{} {}", machine.os, machine.arch)));

    report(app, "install", "running", None);
    if machine.kybernd.is_none() {
        if !machine.curl {
            bail!("curl is not installed on {}; install it and try again", config.target);
        }
        ssh_run(config, &install_script(), Duration::from_secs(600)).await?;
        machine = probe(config).await?;
        if machine.kybernd.is_none() {
            bail!("The installer finished but kybernd is not on PATH for non-interactive shells on {}", config.target);
        }
        report(app, "install", "done", Some(format!("Installed kybernd {}", machine.version.as_deref().unwrap_or("")).trim().to_string()));
    } else {
        report(
            app,
            "install",
            "done",
            Some(format!("kybernd {} is installed", machine.version.as_deref().unwrap_or("")).trim().to_string()),
        );
    }

    report(app, "start", "running", None);
    config.remote_port = machine.port.unwrap_or(DEFAULT_REMOTE_PORT);
    let mut info: Option<DaemonInfo> = None;
    if let (Some(token), Some(_)) = (&machine.token, machine.port) {
        let port = ensure_tunnel(id, config).await?;
        info = daemon_info(port, token).await.ok();
    }
    if info.is_none() {
        stop_tunnel(id).await;
        ssh_run(config, &start_script(config.remote_port), Duration::from_secs(60)).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            machine = probe(config).await?;
            if let (Some(token), Some(port)) = (&machine.token, machine.port) {
                config.remote_port = port;
                let local = ensure_tunnel(id, config).await?;
                if let Ok(found) = daemon_info(local, token).await {
                    info = Some(found);
                    break;
                }
                stop_tunnel(id).await;
            }
            if tokio::time::Instant::now() >= deadline {
                bail!(
                    "kybernd did not start on {}. Check {}/daemon.log there",
                    config.target,
                    config.data_dir.as_deref().unwrap_or("~/.kybern")
                );
            }
        }
    }
    let info = info.context("daemon info")?;
    crate::ensure_compatible(&info)?;
    report(app, "start", "done", Some(format!("kybernd {} on {}", info.version, info.hostname)));

    report(app, "pair", "running", None);
    let token = machine.token.clone().context("The daemon's bootstrap token was not readable")?;
    let local_port = ensure_tunnel(id, config).await?;
    config.local_port = local_port;
    let client = Client::connect(&endpoint(local_port, &token)).await?;
    let pairing = client.call::<PairingCreate>(PairingCreateParams { label: Some(format!("Kybern desktop · {name}")) }).await?;
    drop(client);
    let profile = crate::environments::save_environment(
        app,
        SaveEnvironment {
            id: Some(id.to_string()),
            name: name.to_string(),
            url: format!("ws://127.0.0.1:{local_port}/ws"),
            code: Some(pairing.code),
            expected_environment_id: Some(info.environment_id),
            token: None,
            ssh: Some(config.clone()),
        },
    )
    .await?;
    report(app, "pair", "done", None);
    Ok(profile)
}

/// Set up a machine over SSH and save it as an environment, emitting
/// `remote-bootstrap` progress events on the way.
#[tauri::command]
pub async fn remote_bootstrap<R: tauri::Runtime>(app: tauri::AppHandle<R>, input: BootstrapInput) -> Result<EnvironmentProfile, String> {
    async fn inner<R: tauri::Runtime>(app: tauri::AppHandle<R>, input: BootstrapInput) -> Result<EnvironmentProfile> {
        let name = input.name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            bail!("Enter an environment name of 1–80 characters");
        }
        let (target, port) = parse_target(&input.target)?;
        let id = input.id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let data_dir = input.data_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
        let mut config = SshConfig { target, port, remote_port: DEFAULT_REMOTE_PORT, local_port: 0, data_dir };
        match bootstrap(&app, &id, &name, &mut config).await {
            Ok(profile) => Ok(profile),
            Err(error) => {
                stop_tunnel(&id).await;
                Err(error)
            }
        }
    }
    inner(app.clone(), input).await.map_err(|e| {
        let message = format!("{e:#}");
        report(&app, "failed", "failed", Some(message.clone()));
        message
    })
}

/// `Host` aliases from `~/.ssh/config`, for the address suggestions.
#[tauri::command]
pub async fn remote_ssh_hosts() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else { return vec![] };
    let Ok(text) = std::fs::read_to_string(std::path::Path::new(&home).join(".ssh").join("config")) else { return vec![] };
    ssh_config_hosts(&text)
}

fn ssh_config_hosts(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Host ").or_else(|| line.strip_prefix("Host\t")) else { continue };
        for host in rest.split_whitespace() {
            let plain = !host.contains(['*', '?', '!']) && parse_target(host).is_ok();
            if plain && !hosts.iter().any(|h| h == host) {
                hosts.push(host.to_string());
            }
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_targets_and_rejects_option_lookalikes() {
        assert_eq!(parse_target("deploy@build.example.com").unwrap(), ("deploy@build.example.com".into(), None));
        assert_eq!(parse_target("ssh://deploy@10.0.0.4:2222").unwrap(), ("deploy@10.0.0.4".into(), Some(2222)));
        assert_eq!(parse_target("  vps  ").unwrap(), ("vps".into(), None));
        assert!(parse_target("-oProxyCommand=evil").is_err());
        assert!(parse_target("user@-host").is_err());
        assert!(parse_target("host name").is_err());
        assert!(parse_target("").is_err());
    }

    #[test]
    fn reads_probe_output_and_ssh_config_hosts() {
        let probe = parse_probe("os=Linux\narch=x86_64\nkybernd=/home/u/.cargo/bin/kybernd\nversion=0.2.0\ncurl=1\nport=4173\ntoken=abc\n");
        assert_eq!(probe.version.as_deref(), Some("0.2.0"));
        assert_eq!(probe.port, Some(4173));
        assert!(probe.curl);
        let hosts = ssh_config_hosts("Host *\n  ServerAliveInterval 30\nHost vps build.internal\n  User deploy\nHost vps\n");
        assert_eq!(hosts, vec!["vps".to_string(), "build.internal".to_string()]);
    }

    /// End-to-end against a real SSH server. Set `KYBERN_SSH_TEST_TARGET` (for
    /// example `localhost`, with `KYBERN_SSH` pointing at a wrapper that adds
    /// the right key) and make sure `kybernd` is on that machine's PATH:
    /// `KYBERN_SSH_TEST_TARGET=localhost cargo test -p kybern-desktop bootstrap_over_ssh -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bootstrap_over_ssh() {
        let target = std::env::var("KYBERN_SSH_TEST_TARGET").expect("KYBERN_SSH_TEST_TARGET");
        let scratch = std::env::temp_dir().join(format!("kybern-ssh-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&scratch).unwrap();
        // SAFETY: the test process is single-threaded at this point.
        unsafe { std::env::set_var("KYBERN_CLIENT_CONFIG_DIR", scratch.join("client")) };
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let remote_data_dir = scratch.join("remote-data").display().to_string();
        tauri::async_runtime::block_on(async move {
            let profile = remote_bootstrap(
                handle.clone(),
                BootstrapInput { id: None, name: "SSH test".into(), target: target.clone(), data_dir: Some(remote_data_dir.clone()) },
            )
            .await
            .expect("bootstrap");
            let ssh = profile.ssh.clone().expect("ssh config saved");
            assert_eq!(ssh.data_dir.as_deref(), Some(remote_data_dir.as_str()));
            assert!(profile.url.as_deref().unwrap().starts_with("ws://127.0.0.1:"));
            assert!(std::path::Path::new(&remote_data_dir).join("daemon.token").exists());

            // Opening it again reuses the tunnel and connects with the paired credential.
            let opened = crate::environments::environment_open(handle.clone(), profile.id.clone()).await.expect("open");
            assert_eq!(opened.endpoint.url, profile.url.clone().unwrap());
            let info = daemon_info(ssh.local_port, &opened.endpoint.token).await.expect("daemon info through tunnel");
            assert_eq!(Some(info.environment_id), profile.environment_id);

            // A dropped tunnel comes back on the same port.
            {
                let mut guard = TUNNELS.lock().await;
                let tunnel = guard.as_mut().unwrap().get_mut(&profile.id).unwrap();
                tunnel.task.abort();
                let status = tunnel.status.clone();
                let config = tunnel.config.clone();
                tunnel.task = tokio::spawn(keep_tunnel(config, ssh.local_port, status));
            }
            let again = ensure_tunnel(&profile.id, &ssh).await.expect("tunnel respawn");
            assert_eq!(again, ssh.local_port);

            crate::environments::environment_remove(handle.clone(), profile.id.clone()).await.expect("remove");
            assert!(TUNNELS.lock().await.as_ref().unwrap().get(&profile.id).is_none());
            // Stop the daemon the test started so the scratch directory can go.
            let bootstrap_token = std::fs::read_to_string(std::path::Path::new(&remote_data_dir).join("daemon.token")).unwrap();
            let client = Client::connect(&endpoint(ensure_tunnel("cleanup", &ssh).await.unwrap(), bootstrap_token.trim())).await.unwrap();
            let _ = client.call::<kybern_protocol::methods::DaemonShutdown>(Empty {}).await;
            stop_tunnel("cleanup").await;
        });
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn explains_common_ssh_failures() {
        let denied = explain_ssh_failure("u@h", Some(255), "u@h: Permission denied (publickey).");
        assert!(denied.contains("ssh-copy-id u@h"));
        assert!(explain_ssh_failure("u@h", Some(255), "ssh: Could not resolve hostname h").contains("resolve h"));
        assert_eq!(explain_ssh_failure("u@h", Some(1), "sh: line 3: boom"), "u@h: sh: line 3: boom");
        assert_eq!(explain_ssh_failure("u@h", Some(0), ""), "The command on u@h exited with status 0 and no output");
        assert_eq!(explain_ssh_failure("u@h", None, ""), "The command on u@h was killed by a signal");
    }
}
