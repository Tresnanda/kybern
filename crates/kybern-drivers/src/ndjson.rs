//! Newline-delimited JSON over a child process's stdio.

use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc};

use crate::{DriverError, Result};

pub struct NdjsonChild {
    pub child: Mutex<Child>,
    tree: std::sync::Mutex<Option<crate::process_tree::ProcessTree>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// Lines from stdout, parsed. `None` when stdout closes.
    pub lines: Mutex<mpsc::Receiver<Value>>,
    /// Raw stderr lines, for diagnostics.
    pub stderr: Mutex<mpsc::Receiver<String>>,
}

impl NdjsonChild {
    pub fn spawn(mut cmd: Command) -> Result<Self> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn()?;
        let tree = crate::process_tree::ProcessTree(child.id().expect("spawned provider"));
        let stdin = child.stdin.take().ok_or_else(|| DriverError::Protocol("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("no stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| DriverError::Protocol("no stderr".into()))?;

        let (line_tx, line_rx) = mpsc::channel::<Value>(1024);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(v) => {
                        if line_tx.send(v).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => tracing::warn!(%e, line = %line.chars().take(200).collect::<String>(), "non-JSON line on provider stdout"),
                }
            }
        });

        let (err_tx, err_rx) = mpsc::channel::<String>(256);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                tracing::debug!(target: "provider.stderr", "{line}");
                let _ = err_tx.try_send(line);
            }
        });

        Ok(Self {
            tree: std::sync::Mutex::new(Some(tree)),
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
            lines: Mutex::new(line_rx),
            stderr: Mutex::new(err_rx),
        })
    }

    pub async fn write(&self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_string(value).map_err(|e| DriverError::Protocol(e.to_string()))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or_else(|| DriverError::ProcessExited("session is closed; send again to resume".into()))?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn close_stdin(&self) -> Result<()> {
        // Dropping the pipe sends EOF. AsyncWrite::shutdown alone does not
        // reliably close a process pipe on every platform.
        self.stdin.lock().await.take();
        Ok(())
    }

    pub async fn close(&self) {
        let graceful = async {
            let _ = self.close_stdin().await;
            self.wait().await;
        };
        if tokio::time::timeout(std::time::Duration::from_secs(5), graceful).await.is_err() {
            self.kill().await;
        }
    }

    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        self.tree.lock().unwrap().take();
        let _ = child.kill().await;
    }

    pub async fn wait(&self) -> Option<i32> {
        // Never hold the child mutex across wait: stdout can close while the
        // process remains alive, and close/kill must still be able to acquire it.
        loop {
            let status = self.child.lock().await.try_wait();
            match status {
                Ok(Some(status)) => {
                    self.tree.lock().unwrap().take();
                    return status.code();
                }
                Err(_) => return None,
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
            }
        }
    }
}

/// Owned by the public session handle, never by its reader tasks. Dropping an
/// unfinished spawn future or releasing the handle closes only its own child.
pub struct SessionLifetime {
    _closed: tokio::sync::oneshot::Sender<()>,
    tasks: Vec<tokio::task::AbortHandle>,
}

impl SessionLifetime {
    pub fn new(child: std::sync::Arc<NdjsonChild>) -> Self {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = rx.await;
            child.kill().await;
        });
        Self { _closed: tx, tasks: Vec::new() }
    }
}

impl SessionLifetime {
    pub fn track(&mut self, task: tokio::task::JoinHandle<()>) {
        self.tasks.push(task.abort_handle());
    }
}

impl Drop for SessionLifetime {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use std::{sync::Arc, time::Duration};

    #[tokio::test]
    async fn closing_stdin_delivers_eof() {
        let child = NdjsonChild::spawn(Command::new("cat")).unwrap();
        child.close_stdin().await.unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), child.wait()).await.unwrap(), Some(0));
    }

    #[tokio::test]
    async fn exit_wait_does_not_block_kill_after_stdout_closes() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exec 1>&-; exec sleep 30"]);
        let child = Arc::new(NdjsonChild::spawn(cmd).unwrap());
        let waiting = child.clone();
        let waiter = tokio::spawn(async move { waiting.wait().await });
        tokio::time::sleep(Duration::from_millis(40)).await;
        tokio::time::timeout(Duration::from_secs(2), child.kill()).await.expect("kill must not wait on the exit waiter");
        tokio::time::timeout(Duration::from_secs(2), waiter).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn dropping_session_owner_stops_launcher_and_children_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = Command::new("sh");
        cmd.current_dir(dir.path()).args(["-c", "(sleep 0.3; touch escaped) & wait"]);
        let child = Arc::new(NdjsonChild::spawn(cmd).unwrap());
        let mut unrelated = Command::new("sleep").arg("30").kill_on_drop(true).spawn().unwrap();
        let lifetime = SessionLifetime::new(child.clone());
        drop(lifetime);
        tokio::time::timeout(Duration::from_secs(2), child.wait()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!dir.path().join("escaped").exists());
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().await.unwrap();
    }
}
