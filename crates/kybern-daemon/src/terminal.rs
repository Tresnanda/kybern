//! Server-owned pseudo-terminals. Output is retained in a bounded scrollback
//! and fanned out to subscribed connections as `terminal.output` notifications.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_protocol::methods::TerminalInfo;
use kybern_protocol::*;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Bytes of scrollback kept per terminal for late subscribers.
const SCROLLBACK_CAP: usize = 512 * 1024;

pub enum TerminalEvent {
    Output(Vec<u8>),
    Exited(Option<i32>),
}

pub struct Terminal {
    pub info: Mutex<TerminalInfo>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    scrollback: Mutex<VecDeque<u8>>,
    pub events: broadcast::Sender<Arc<TerminalEvent>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

#[derive(Default, Clone)]
pub struct TerminalManager {
    terminals: Arc<Mutex<HashMap<TerminalId, Arc<Terminal>>>>,
}

impl TerminalManager {
    pub fn create(&self, thread_id: Option<ThreadId>, cwd: String, cols: u16, rows: u16, command: Option<Vec<String>>) -> Result<Arc<Terminal>> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).context("openpty")?;

        let (program, args) = match command.as_deref() {
            Some([p, rest @ ..]) => (p.clone(), rest.to_vec()),
            _ => (default_shell(), vec![]),
        };
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("KYBERN", "1");
        let child = pair.slave.spawn_command(cmd).with_context(|| format!("spawn {program}"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("pty writer")?;
        let (events, _) = broadcast::channel(4096);

        let id = Uuid::now_v7();
        let terminal = Arc::new(Terminal {
            info: Mutex::new(TerminalInfo {
                id,
                thread_id,
                cwd: cwd.clone(),
                cols,
                rows,
                title: program.rsplit('/').next().unwrap_or(&program).to_string(),
                alive: true,
                exit_code: None,
                created_at: Utc::now(),
            }),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            scrollback: Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)),
            events,
            child: Mutex::new(child),
        });
        self.terminals.lock().unwrap().insert(id, terminal.clone());

        // Blocking reader thread: the pty read has no async form.
        let t = terminal.clone();
        let manager = self.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();
                            {
                                let mut sb = t.scrollback.lock().unwrap();
                                for b in &chunk {
                                    if sb.len() >= SCROLLBACK_CAP {
                                        sb.pop_front();
                                    }
                                    sb.push_back(*b);
                                }
                            }
                            let _ = t.events.send(Arc::new(TerminalEvent::Output(chunk)));
                        }
                        Err(e) => {
                            tracing::debug!(%e, "pty read ended");
                            break;
                        }
                    }
                }
                let code = t.child.lock().unwrap().wait().ok().map(|s| s.exit_code() as i32);
                {
                    let mut info = t.info.lock().unwrap();
                    info.alive = false;
                    info.exit_code = code;
                }
                let _ = t.events.send(Arc::new(TerminalEvent::Exited(code)));
                // Keep the record around for a while so clients can read the exit; drop after 10 minutes.
                std::thread::sleep(std::time::Duration::from_secs(600));
                manager.terminals.lock().unwrap().remove(&id);
            })
            .context("spawn pty reader thread")?;

        Ok(terminal)
    }

    pub fn get(&self, id: TerminalId) -> Option<Arc<Terminal>> {
        self.terminals.lock().unwrap().get(&id).cloned()
    }

    pub fn list(&self, thread_id: Option<ThreadId>) -> Vec<TerminalInfo> {
        let map = self.terminals.lock().unwrap();
        let mut out: Vec<TerminalInfo> = map
            .values()
            .map(|t| t.info.lock().unwrap().clone())
            .filter(|i| thread_id.is_none_or(|th| i.thread_id == Some(th)))
            .collect();
        out.sort_by_key(|i| i.created_at);
        out
    }

    pub fn close(&self, id: TerminalId) -> Result<()> {
        let t = self.terminals.lock().unwrap().remove(&id).ok_or_else(|| anyhow!("terminal not found"))?;
        let _ = t.child.lock().unwrap().kill();
        Ok(())
    }

    pub async fn shutdown(&self) {
        let all: Vec<_> = self.terminals.lock().unwrap().drain().map(|(_, t)| t).collect();
        for t in all {
            let _ = t.child.lock().unwrap().kill();
        }
    }
}

impl Terminal {
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        let mut info = self.info.lock().unwrap();
        info.cols = cols;
        info.rows = rows;
        Ok(())
    }

    pub fn scrollback(&self) -> Vec<u8> {
        self.scrollback.lock().unwrap().iter().copied().collect()
    }

    pub fn info(&self) -> TerminalInfo {
        self.info.lock().unwrap().clone()
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}
