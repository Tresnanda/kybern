use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::ndjson::{NdjsonChild, SessionLifetime};
use crate::{DriverError, DriverEvent, ProbeContext, Result};

pub const SDK_VERSION: &str = "1.0.35";
const HOST: &str = include_str!("sdk/host.mjs");
const PACKAGE: &str = include_str!("sdk/package.json");
const LOCK: &str = include_str!("sdk/package-lock.json");
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>>;

fn env(context: &ProbeContext, name: &str) -> Option<String> {
    context.env.get(name).cloned().or_else(|| std::env::var(name).ok()).filter(|s| !s.is_empty())
}

fn installed_dir(context: &ProbeContext) -> Result<PathBuf> {
    if let Some(path) = env(context, "KYBERN_CURSOR_SDK_DIR") {
        return Ok(path.into());
    }
    let home = env(context, "HOME")
        .or_else(|| env(context, "USERPROFILE"))
        .ok_or_else(|| DriverError::Protocol("Set KYBERN_CURSOR_SDK_DIR to the installed Cursor SDK directory".into()))?;
    Ok(PathBuf::from(home).join(".kybern/cache/cursor-sdk").join(SDK_VERSION))
}

fn sdk_dir(context: &ProbeContext) -> Result<PathBuf> {
    let installed = installed_dir(context)?;
    if env(context, "KYBERN_CURSOR_SDK_DIR").is_some() || installed.join("node_modules/@cursor/sdk/package.json").is_file() {
        return Ok(installed);
    }
    // Development builds reuse the exact-pinned package beside this host.
    // Release binaries never depend on the build machine's source checkout.
    if cfg!(debug_assertions) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cursor/sdk");
        if source.join("node_modules/@cursor/sdk/package.json").is_file() {
            return Ok(source);
        }
    }
    Ok(installed)
}

fn node(context: &ProbeContext) -> Result<PathBuf> {
    if let Some(path) = env(context, "KYBERN_CURSOR_NODE") {
        return which::which_in(path, env(context, "PATH"), context.cwd.clone().unwrap_or_else(|| PathBuf::from(".")))
            .map_err(|_| DriverError::BinaryNotFound("KYBERN_CURSOR_NODE must point to Node.js 22.13 or newer".into()));
    }
    which::which_in("node", env(context, "PATH"), context.cwd.clone().unwrap_or_else(|| PathBuf::from("."))).map_err(|_| {
        DriverError::BinaryNotFound("Cursor SDK needs Node.js 22.13 or newer. Install Node, then run `kybern cursor install`".into())
    })
}

pub fn setup_command(context: &ProbeContext, action: &str) -> Result<Command> {
    if !matches!(action, "login" | "logout" | "status" | "version") {
        return Err(DriverError::Unsupported("Unknown Cursor SDK setup action".into()));
    }
    command(context, action)
}

fn command(context: &ProbeContext, mode: &str) -> Result<Command> {
    let sdk = sdk_dir(context)?;
    let mut cmd = Command::new(node(context)?);
    // The SDK locates its platform helpers by walking up from argv[1], not
    // from require.resolve(). Give our embedded host its package-side origin;
    // an eval marker alone would resolve helpers from the user's workspace.
    cmd.args(["--input-type=module", "--eval", HOST, "--"]).arg(sdk.join("host.mjs")).args(["--kybern-cursor-sdk", mode]);
    cmd.envs(&context.env).env("KYBERN_CURSOR_SDK_DIR", sdk);
    if let Some(cwd) = &context.cwd {
        cmd.current_dir(cwd);
    }
    Ok(cmd)
}

pub(super) async fn probe(context: &ProbeContext) -> Result<(PathBuf, Value)> {
    let binary = node(context)?;
    let mut cmd = command(context, "probe")?;
    let output = tokio::time::timeout(Duration::from_secs(25), crate::process_tree::output(&mut cmd)).await.map_err(|_| {
        DriverError::Protocol("Cursor SDK model discovery timed out. Check your connection and refresh the provider list.".into())
    })??;
    if !output.status.success() {
        return Err(DriverError::Protocol(diagnostic(&output.stderr)));
    }
    let value = serde_json::from_slice(&output.stdout).map_err(|e| DriverError::Protocol(format!("Cursor SDK probe: {e}")))?;
    Ok((binary, value))
}

fn diagnostic(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.contains("ENOENT") || text.contains("Cannot find module") {
        return "Cursor SDK is not installed. Run `kybern cursor install`, then `kybern cursor login`.".into();
    }
    let text: String = text.chars().take(4000).collect();
    if text.trim().is_empty() {
        "Cursor SDK host exited unexpectedly. Check Node.js and run `kybern cursor install`.".into()
    } else {
        text.trim().into()
    }
}

/// Explicit setup only; provider discovery never downloads or installs code.
/// Install into a staging directory and rename after npm succeeds, so existing
/// sessions never see a partly-installed SDK. Package versions/integrities are
/// committed in the lockfile and lifecycle scripts are disabled.
pub async fn install(context: &ProbeContext) -> Result<PathBuf> {
    let _ = node(context)?;
    let destination = installed_dir(context)?;
    let manifest = destination.join("node_modules/@cursor/sdk/package.json");
    if manifest.is_file() {
        let value: Value = serde_json::from_slice(&std::fs::read(manifest)?).map_err(|e| DriverError::Protocol(e.to_string()))?;
        if value["version"] == SDK_VERSION {
            return Ok(destination);
        }
        return Err(DriverError::Protocol(
            "This Cursor SDK directory contains a different version. Choose an empty KYBERN_CURSOR_SDK_DIR.".into(),
        ));
    }
    if destination.exists() {
        return Err(DriverError::Protocol(
            "Cursor SDK directory is incomplete. Choose an empty KYBERN_CURSOR_SDK_DIR and install again.".into(),
        ));
    }
    let parent = destination.parent().ok_or_else(|| DriverError::Protocol("Cursor SDK directory has no parent".into()))?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".cursor-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging)?;
    struct Staging(PathBuf);
    impl Drop for Staging {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Staging(staging.clone());
    std::fs::write(staging.join("package.json"), PACKAGE)?;
    std::fs::write(staging.join("package-lock.json"), LOCK)?;
    let npm = which::which(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .map_err(|_| DriverError::BinaryNotFound("Install npm with Node.js, then run `kybern cursor install`".into()))?;
    let mut cmd = Command::new(npm);
    cmd.args(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]).current_dir(&staging).envs(&context.env);
    let output = tokio::time::timeout(Duration::from_secs(300), crate::process_tree::output(&mut cmd))
        .await
        .map_err(|_| DriverError::Protocol("Cursor SDK installation timed out. Check your network and try again.".into()))??;
    if !output.status.success() {
        return Err(DriverError::Protocol(diagnostic(&output.stderr)));
    }
    std::fs::rename(&staging, &destination)?;
    Ok(destination)
}

pub(crate) struct Connection {
    child: Arc<NdjsonChild>,
    pending: Pending,
    events: mpsc::Sender<DriverEvent>,
    ended: Arc<AtomicBool>,
    _lifetime: SessionLifetime,
}

impl Connection {
    pub(crate) fn spawn(context: &ProbeContext) -> Result<(Self, mpsc::Receiver<DriverEvent>)> {
        let child = Arc::new(NdjsonChild::spawn(command(context, "stdio")?)?);
        let mut lifetime = SessionLifetime::new(child.clone());
        let pending: Pending = Arc::default();
        let (events, receiver) = mpsc::channel(1024);
        let reader_child = child.clone();
        let reader_pending = pending.clone();
        let reader_events = events.clone();
        let ended = Arc::new(AtomicBool::new(false));
        let reader_ended = ended.clone();
        lifetime.track(tokio::spawn(async move {
            let mut stream = super::stream::Stream::default();
            while let Some(value) = reader_child.lines.lock().await.recv().await {
                if let Some(id) = value["id"].as_str() {
                    if let Some(tx) = reader_pending.lock().await.remove(id) {
                        let result = match value["error"].as_str() {
                            Some(error) => Err(error.to_string()),
                            None => Ok(value["result"].clone()),
                        };
                        let _ = tx.send(result);
                    }
                } else {
                    for event in stream.handle(&value) {
                        if reader_events.send(event).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let mut stderr = Vec::new();
            while let Ok(line) = reader_child.stderr.lock().await.try_recv() {
                stderr.push(line);
            }
            let error = diagnostic(stderr.join("\n").as_bytes());
            let mut pending = reader_pending.lock().await;
            reader_ended.store(true, Ordering::Release);
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err(error.clone()));
            }
            drop(pending);
            for event in stream.exited() {
                let _ = reader_events.send(event).await;
            }
            let code = match tokio::time::timeout(Duration::from_secs(5), reader_child.wait()).await {
                Ok(code) => code,
                Err(_) => {
                    reader_child.kill().await;
                    None
                }
            };
            let _ = reader_events.send(DriverEvent::Exited { code, error: (code != Some(0)).then_some(error) }).await;
        }));
        Ok((Self { child, pending, events, ended, _lifetime: lifetime }, receiver))
    }

    pub(crate) async fn call(&self, operation: &str, mut params: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        if self.ended.load(Ordering::Acquire) {
            return Err(DriverError::ProcessExited("Cursor SDK host closed; send again to resume".into()));
        }
        pending.insert(id.clone(), tx);
        drop(pending);
        params["id"] = json!(id);
        params["type"] = json!(operation);
        if let Err(error) = self.child.write(&params).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(if operation == "close" { 5 } else { 60 }), rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(DriverError::Protocol(error)),
            Ok(Err(_)) => Err(DriverError::ProcessExited("Cursor SDK host closed".into())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                // Admission may have succeeded. Retire this host rather than
                // leave an invisible run or retry the prompt twice.
                self.child.kill().await;
                Err(DriverError::Protocol(format!("Cursor SDK {operation} timed out. Send again to resume the saved conversation.")))
            }
        }
    }
    pub(crate) async fn emit(&self, event: DriverEvent) {
        let _ = self.events.send(event).await;
    }
    pub(crate) async fn close(&self) -> Result<()> {
        let result = self.call("close", json!({})).await;
        self.child.close().await;
        result.map(|_| ())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture(root: &std::path::Path, body: &str) -> ProbeContext {
        let path = root.join("node-fixture");
        std::fs::write(&path, format!("#!/usr/bin/env python3\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        ProbeContext {
            cwd: Some(root.into()),
            env: std::collections::BTreeMap::from([("KYBERN_CURSOR_NODE".into(), path.display().to_string())]),
            ..Default::default()
        }
    }

    /// Linux refuses to run a file that another test's freshly forked child
    /// still holds open for writing (ETXTBSY) until that child execs. Retry.
    fn spawn(context: &ProbeContext) -> (Connection, mpsc::Receiver<DriverEvent>) {
        for _ in 0..50 {
            match Connection::spawn(context) {
                Err(DriverError::Io(error)) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                result => return result.unwrap(),
            }
        }
        Connection::spawn(context).unwrap()
    }

    #[tokio::test]
    async fn correlates_protocol_calls_and_delivers_stream_before_exit() {
        let root = tempfile::tempdir().unwrap();
        let context = fixture(
            root.path(),
            r#"
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    op = request['type']
    if op == 'send':
        print(json.dumps({'type':'run_started','runId':'r1'}), flush=True)
        print(json.dumps({'type':'update','runId':'r1','update':{'type':'text-delta','text':'Hello'}}), flush=True)
        print(json.dumps({'type':'run_completed','result':{'status':'finished','result':'Hello **world**'}}), flush=True)
    print(json.dumps({'id':request['id'],'result':{'agentId':'a1'}}), flush=True)
    if op == 'close': break
"#,
        );
        let (connection, mut events) = spawn(&context);
        assert_eq!(connection.call("open", json!({})).await.unwrap()["agentId"], "a1");
        connection.call("send", json!({})).await.unwrap();
        let mut completed = false;
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = events.recv().await {
                if matches!(event, DriverEvent::MessageCompleted { ref text, .. } if text == "Hello **world**") {
                    completed = true;
                }
                if matches!(event, DriverEvent::TurnCompleted { .. }) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(completed);
        connection.close().await.unwrap();
    }

    #[tokio::test]
    async fn process_exit_rejects_pending_and_later_requests_without_timeout() {
        let root = tempfile::tempdir().unwrap();
        let context = fixture(root.path(), "import sys\nsys.stdin.readline()\nsys.exit(1)\n");
        let (connection, _events) = spawn(&context);
        tokio::time::timeout(Duration::from_secs(5), async {
            assert!(connection.call("open", json!({})).await.is_err());
            assert!(connection.call("send", json!({})).await.is_err());
        })
        .await
        .unwrap();
    }
}
