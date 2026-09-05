//! Server-owned pseudo-terminals. Output is retained in a bounded scrollback
//! and fanned out to subscribed connections as `terminal.output` notifications.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_protocol::methods::TerminalInfo;
use kybern_protocol::*;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Bytes of scrollback kept per terminal for late subscribers.
const SCROLLBACK_CAP: usize = 512 * 1024;

/// How long an exited terminal stays listed so clients can read its exit.
pub const EXITED_RETENTION: Duration = Duration::from_secs(600);

pub enum TerminalEvent {
    Output(Vec<u8>),
    Exited(Option<i32>),
}

pub struct Terminal {
    command: Option<Vec<String>>,
    pub info: Mutex<TerminalInfo>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    scrollback: Mutex<VecDeque<u8>>,
    pub events: broadcast::Sender<Arc<TerminalEvent>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Last input, output, or subscription. Idle release counts from here.
    last_activity: Mutex<Instant>,
    /// When the process ended; the record is purged after `EXITED_RETENTION`.
    exited_at: Mutex<Option<Instant>>,
}

/// One pseudo-terminal the daemon closed because nothing was using it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalRelease {
    pub id: TerminalId,
    pub thread_id: Option<ThreadId>,
}

#[derive(Default, Clone)]
pub struct TerminalManager {
    terminals: Arc<Mutex<HashMap<TerminalId, Arc<Terminal>>>>,
    issued_ids: Arc<Mutex<HashSet<TerminalId>>>,
    create_lock: Arc<Mutex<()>>,
}

impl TerminalManager {
    pub fn create(
        &self,
        requested_id: Option<TerminalId>,
        thread_id: Option<ThreadId>,
        cwd: String,
        cols: u16,
        rows: u16,
        command: Option<Vec<String>>,
    ) -> Result<Arc<Terminal>> {
        let _create = self.create_lock.lock().unwrap();
        let id = requested_id.unwrap_or_else(Uuid::now_v7);
        if let Some(existing) = self.get(id) {
            let info = existing.info();
            anyhow::ensure!(
                info.thread_id == thread_id && info.cwd == cwd && existing.command == command,
                "Terminal identity belongs to another request"
            );
            return Ok(existing);
        }
        anyhow::ensure!(!self.issued_ids.lock().unwrap().contains(&id), "This terminal has closed; open a new terminal tab");
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

        let terminal = Arc::new(Terminal {
            command,
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
            last_activity: Mutex::new(Instant::now()),
            exited_at: Mutex::new(None),
        });
        self.terminals.lock().unwrap().insert(id, terminal.clone());
        self.issued_ids.lock().unwrap().insert(id);

        // Blocking reader thread: the pty read has no async form.
        let t = terminal.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = buf[..n].to_vec();
                            t.touch();
                            {
                                let mut sb = t.scrollback.lock().unwrap();
                                for b in &chunk {
                                    if sb.len() >= SCROLLBACK_CAP {
                                        sb.pop_front();
                                    }
                                    sb.push_back(*b);
                                }
                                let _ = t.events.send(Arc::new(TerminalEvent::Output(chunk)));
                            }
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
                *t.exited_at.lock().unwrap() = Some(Instant::now());
                let _ = t.events.send(Arc::new(TerminalEvent::Exited(code)));
                // The record stays listed for `EXITED_RETENTION` so clients can
                // read the exit; the maintenance sweep purges it.
            })
            .context("spawn pty reader thread")?;

        Ok(terminal)
    }

    pub fn get(&self, id: TerminalId) -> Option<Arc<Terminal>> {
        self.terminals.lock().unwrap().get(&id).cloned()
    }

    pub fn list(&self, thread_id: Option<ThreadId>) -> Vec<TerminalInfo> {
        let map = self.terminals.lock().unwrap();
        let mut out: Vec<TerminalInfo> =
            map.values().map(|t| t.info.lock().unwrap().clone()).filter(|i| thread_id.is_none_or(|th| i.thread_id == Some(th))).collect();
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

    /// Number of terminals whose process is still running.
    pub fn alive(&self) -> usize {
        self.terminals.lock().unwrap().values().filter(|t| t.info.lock().unwrap().alive).count()
    }

    /// Close shells nobody is using: alive, no subscribed client, no foreground
    /// job, and no input or output for `idle_after`. A shell with a job in the
    /// foreground (a dev server, an editor, a long build) is never touched.
    /// `None` disables the sweep.
    pub fn release_idle(&self, idle_after: Option<Duration>) -> Vec<TerminalRelease> {
        let Some(idle_after) = idle_after else { return Vec::new() };
        let now = Instant::now();
        let candidates: Vec<Arc<Terminal>> = self.terminals.lock().unwrap().values().cloned().collect();
        let mut released = Vec::new();
        for terminal in candidates {
            let info = terminal.info();
            if !info.alive
                || terminal.events.receiver_count() > 0
                || now.saturating_duration_since(terminal.last_activity()) < idle_after
                || terminal.foreground_is_shell() == Some(false)
            {
                continue;
            }
            if self.close(info.id).is_ok() {
                tracing::info!(terminal = %info.id, thread = ?info.thread_id, "closed idle terminal");
                released.push(TerminalRelease { id: info.id, thread_id: info.thread_id });
            }
        }
        released
    }

    /// Drop records of terminals that exited more than `retain` ago.
    pub fn purge_exited(&self, retain: Duration) -> usize {
        let now = Instant::now();
        let mut map = self.terminals.lock().unwrap();
        let before = map.len();
        map.retain(|_, t| !t.exited_at.lock().unwrap().is_some_and(|at| now.saturating_duration_since(at) >= retain));
        before - map.len()
    }
}

impl Terminal {
    /// Snapshot and live subscription share the producer's scrollback lock so
    /// bytes appear exactly once across the replay/live boundary.
    pub fn subscribe_output(&self, replay: bool) -> (broadcast::Receiver<Arc<TerminalEvent>>, Vec<u8>) {
        self.touch();
        let scrollback = self.scrollback.lock().unwrap();
        let receiver = self.events.subscribe();
        let bytes = if replay { scrollback.iter().copied().collect() } else { vec![] };
        (receiver, bytes)
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        self.touch();
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

    pub fn info(&self) -> TerminalInfo {
        self.info.lock().unwrap().clone()
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    pub fn last_activity(&self) -> Instant {
        *self.last_activity.lock().unwrap()
    }

    /// Whether the shell itself owns the terminal's foreground, meaning it is
    /// sitting at a prompt. `None` when the platform cannot tell.
    pub fn foreground_is_shell(&self) -> Option<bool> {
        let shell = self.child.lock().unwrap().process_id()?;
        let leader = self.master.lock().unwrap().process_group_leader()?;
        Some(u32::try_from(leader).ok() == Some(shell))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(check: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn idle_shells_are_released_only_when_detached_and_at_a_prompt() {
        let manager = TerminalManager::default();
        let terminal =
            manager.create(None, None, std::env::temp_dir().display().to_string(), 80, 24, Some(vec!["/bin/sh".into()])).unwrap();
        assert!(wait_until(|| terminal.foreground_is_shell() == Some(true)), "shell never reached its prompt");

        // A foreground job keeps the terminal, however idle it looks.
        terminal.write(b"sleep 30\n").unwrap();
        assert!(wait_until(|| terminal.foreground_is_shell() == Some(false)), "foreground job was not detected");
        *terminal.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(3600);
        assert!(manager.release_idle(Some(Duration::from_secs(60))).is_empty());

        // Back at the prompt, a subscribed client still keeps it.
        terminal.write(&[0x03]).unwrap();
        assert!(wait_until(|| terminal.foreground_is_shell() == Some(true)), "shell did not return to its prompt");
        *terminal.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(3600);
        let (subscriber, _) = terminal.subscribe_output(false);
        *terminal.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(3600);
        assert!(manager.release_idle(Some(Duration::from_secs(60))).is_empty());
        drop(subscriber);

        // Detached, idle, and at the prompt: released. Disabled sweeps never release.
        assert!(manager.release_idle(None).is_empty());
        let released = manager.release_idle(Some(Duration::from_secs(60)));
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].id, terminal.info().id);
        assert!(manager.get(terminal.info().id).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn exited_terminals_are_listed_until_retention_passes() {
        let manager = TerminalManager::default();
        let terminal = manager
            .create(
                None,
                None,
                std::env::temp_dir().display().to_string(),
                80,
                24,
                Some(vec!["/bin/sh".into(), "-c".into(), "exit 3".into()]),
            )
            .unwrap();
        assert!(wait_until(|| !terminal.info().alive), "command did not exit");
        assert_eq!(terminal.info().exit_code, Some(3));
        assert_eq!(manager.alive(), 0);
        assert_eq!(manager.purge_exited(EXITED_RETENTION), 0);
        assert!(manager.get(terminal.info().id).is_some());
        assert_eq!(manager.purge_exited(Duration::ZERO), 1);
        assert!(manager.get(terminal.info().id).is_none());
    }
}
