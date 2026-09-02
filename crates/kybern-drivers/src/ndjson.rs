//! Newline-delimited JSON over a child process's stdio.

use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc};

use crate::{DriverError, Result};

pub struct NdjsonChild {
    pub child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    /// Lines from stdout, parsed. `None` when stdout closes.
    pub lines: Mutex<mpsc::Receiver<Value>>,
    /// Raw stderr lines, for diagnostics.
    pub stderr: Mutex<mpsc::Receiver<String>>,
}

impl NdjsonChild {
    pub fn spawn(mut cmd: Command) -> Result<Self> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn()?;
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

        Ok(Self { child: Mutex::new(child), stdin: Mutex::new(stdin), lines: Mutex::new(line_rx), stderr: Mutex::new(err_rx) })
    }

    pub async fn write(&self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_string(value).map_err(|e| DriverError::Protocol(e.to_string()))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn close_stdin(&self) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin.shutdown().await?;
        Ok(())
    }

    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }

    pub async fn wait(&self) -> Option<i32> {
        let mut child = self.child.lock().await;
        child.wait().await.ok().and_then(|s| s.code())
    }
}
