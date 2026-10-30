//! Server-owned pseudo-terminals. Output is retained in a bounded scrollback
//! and fanned out to subscribed connections as `terminal.output` notifications.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::bounded_broadcast as broadcast;
use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_protocol::methods::TerminalInfo;
use kybern_protocol::*;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use uuid::Uuid;

/// Bytes of scrollback kept per terminal for late subscribers.
const SCROLLBACK_CAP: usize = 512 * 1024;

/// How long an exited terminal stays listed so clients can read its exit.
pub const EXITED_RETENTION: Duration = Duration::from_secs(600);

pub enum TerminalEvent {
    Output(Vec<u8>),
    Exited(Option<i32>),
}

impl broadcast::RetainedSize for Arc<TerminalEvent> {
    fn retained_size(&self) -> usize {
        std::mem::size_of::<TerminalEvent>()
            + match self.as_ref() {
                TerminalEvent::Output(bytes) => bytes.capacity(),
                TerminalEvent::Exited(_) => 0,
            }
    }
}

pub struct Terminal {
    command: Option<Vec<String>>,
    pub info: Mutex<TerminalInfo>,
    /// Taken (closed) once the process has exited and its output is drained.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    scrollback: Mutex<VecDeque<u8>>,
    pub events: broadcast::Sender<Arc<TerminalEvent>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Last input, output, or subscription. Idle release counts from here.
    last_activity: Mutex<Instant>,
    /// When the process ended; the record is purged after `EXITED_RETENTION`.
    exited_at: Mutex<Option<Instant>>,
    /// Set by the first `finish`, so the reader and the exit watcher record one exit.
    finished: AtomicBool,
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
        self.create_with_env(requested_id, thread_id, cwd, cols, rows, command, &Default::default())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_with_env(
        &self,
        requested_id: Option<TerminalId>,
        thread_id: Option<ThreadId>,
        cwd: String,
        cols: u16,
        rows: u16,
        command: Option<Vec<String>>,
        env: &std::collections::BTreeMap<String, String>,
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
        allow_ctrl_c();
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).context("openpty")?;

        let (program, args) = match command.as_deref() {
            Some([p, rest @ ..]) => (p.clone(), rest.to_vec()),
            _ => (default_shell(), vec![]),
        };
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        cmd.cwd(shell_cwd(&cwd));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("KYBERN", "1");
        for (key, value) in env {
            cmd.env(key, value);
        }
        let child = pair.slave.spawn_command(cmd).with_context(|| format!("spawn {program}"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("pty writer")?;
        let (events, _) = broadcast::channel(4096, 2 * 1024 * 1024);

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
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            scrollback: Mutex::new(VecDeque::with_capacity(SCROLLBACK_CAP)),
            events,
            child: Mutex::new(child),
            last_activity: Mutex::new(Instant::now()),
            exited_at: Mutex::new(None),
            finished: AtomicBool::new(false),
        });
        self.terminals.lock().unwrap().insert(id, terminal.clone());
        self.issued_ids.lock().unwrap().insert(id);

        // Blocking reader thread: the pty read has no async form.
        let t = terminal.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                #[cfg(windows)]
                let mut cursor = InitialCursorReport::default();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            #[cfg(windows)]
                            let chunk = {
                                let (chunk, answer) = cursor.push(&buf[..n]);
                                if answer {
                                    let _ = t.write(b"\x1b[1;1R");
                                }
                                chunk
                            };
                            #[cfg(not(windows))]
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
                // The record stays listed for `EXITED_RETENTION` so clients can
                // read the exit; the maintenance sweep purges it.
                t.finish(code);
            })
            .context("spawn pty reader thread")?;

        // Windows (ConPTY): the output pipe stays open after the shell exits until the
        // pseudoconsole is closed, so the reader never sees EOF. Watch the process itself.
        if cfg!(windows) {
            let t = terminal.clone();
            std::thread::Builder::new().name(format!("pty-wait-{id}")).spawn(move || t.watch_exit()).context("spawn pty exit watcher")?;
        }

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
        if let Some(master) = self.master.lock().unwrap().as_ref() {
            master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        }
        let mut info = self.info.lock().unwrap();
        info.cols = cols;
        info.rows = rows;
        Ok(())
    }

    /// Record the process exit once: mark the terminal dead, stamp the retention
    /// clock and tell subscribers. Later calls do nothing.
    fn finish(&self, code: Option<i32>) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        {
            let mut info = self.info.lock().unwrap();
            info.alive = false;
            info.exit_code = code;
        }
        *self.exited_at.lock().unwrap() = Some(Instant::now());
        let _ = self.events.send(Arc::new(TerminalEvent::Exited(code)));
    }

    /// Wait for the process to end, let the reader drain what it wrote, then close the
    /// master so a reader blocked on an open pipe returns, and record the exit.
    fn watch_exit(&self) {
        let code = loop {
            if self.finished.load(Ordering::SeqCst) {
                return;
            }
            match self.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break Some(status.exit_code() as i32),
                Ok(None) => {}
                Err(_) => break None,
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        // Output the shell wrote before exiting is still in the pipe: wait for it to go quiet.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let seen = self.last_activity();
            std::thread::sleep(Duration::from_millis(150));
            if self.last_activity() == seen || Instant::now() >= deadline {
                break;
            }
        }
        self.finish(code);
        drop(self.master.lock().unwrap().take());
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
        #[cfg(unix)]
        {
            let shell = self.child.lock().unwrap().process_id()?;
            let leader = self.master.lock().unwrap().as_ref()?.process_group_leader()?;
            Some(u32::try_from(leader).ok() == Some(shell))
        }
        // portable-pty has no process-group query on Windows.
        #[cfg(not(unix))]
        {
            None
        }
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

/// Windows: the desktop starts the daemon detached, as a new process group, and such a process
/// ignores Ctrl+C, a setting every process it starts inherits. A terminal's shell, and whatever runs
/// in it, then never stopped on Ctrl+C (the PTY delivered it; `ping -t` ran on). Turn Ctrl+C
/// processing back on for the daemon before its first shell starts, so shells inherit it on. The
/// daemon itself has no console, so no Ctrl+C reaches it.
fn allow_ctrl_c() {
    #[cfg(windows)]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
            }
            // SAFETY: a null handler with `add` false only clears this process's ignore-Ctrl+C flag.
            if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
                tracing::warn!("could not turn Ctrl+C processing on for terminal shells");
            }
        });
    }
}

/// The directory a shell starts in. Windows project paths can be stored verbatim (`\\?\D:\x`, what
/// `canonicalize` returns there), and cmd.exe cannot start in one: it says "UNC paths are not supported"
/// and opens in `C:\Windows`. The plain form names the same directory.
fn shell_cwd(cwd: &str) -> String {
    if !cfg!(windows) {
        return cwd.to_string();
    }
    plain_windows_path(cwd)
}

fn plain_windows_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match path.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => path.to_string(),
    }
}

// portable-pty enables ConPTY's INHERIT_CURSOR flag. Every terminal here starts
// with a fresh, empty screen, so the host can answer its initial position request
// before any client attaches. Consume that request so a renderer cannot reply twice.
// Only ConPTY's startup preamble is searched: a later request from the shell or a
// TUI passes through to the attached renderer untouched.
#[cfg(any(windows, test))]
#[derive(Default)]
struct InitialCursorReport {
    pending: Vec<u8>,
    seen: usize,
    answered: bool,
}

#[cfg(any(windows, test))]
impl InitialCursorReport {
    const PREAMBLE: usize = 256;

    fn push(&mut self, bytes: &[u8]) -> (Vec<u8>, bool) {
        const QUERY: &[u8] = b"\x1b[6n";
        if self.answered {
            return (bytes.to_vec(), false);
        }
        self.seen += bytes.len();
        self.pending.extend_from_slice(bytes);
        if let Some(index) = self.pending.windows(QUERY.len()).position(|part| part == QUERY)
            && self.seen - self.pending.len() + index < Self::PREAMBLE
        {
            self.pending.drain(index..index + QUERY.len());
            self.answered = true;
            return (std::mem::take(&mut self.pending), true);
        }
        if self.seen >= Self::PREAMBLE {
            self.answered = true;
            return (std::mem::take(&mut self.pending), false);
        }
        let keep = (1..QUERY.len()).rev().find(|&len| self.pending.ends_with(&QUERY[..len])).unwrap_or(0);
        let tail = self.pending.split_off(self.pending.len() - keep);
        (std::mem::replace(&mut self.pending, tail), false)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_initial_cursor_request_is_answered_once_even_across_reads() {
        for split in 0..=4 {
            let mut cursor = InitialCursorReport::default();
            assert_eq!(cursor.push(b"ready"), (b"ready".to_vec(), false));
            let query = b"\x1b[6n";
            let first = cursor.push(&query[..split]);
            let second = cursor.push(&query[split..]);
            assert!(first.0.is_empty() && second.0.is_empty());
            assert_eq!(usize::from(first.1) + usize::from(second.1), 1);
            assert_eq!(cursor.push(b"prompt\x1b[6n"), (b"prompt\x1b[6n".to_vec(), false));
        }
        let mut cursor = InitialCursorReport::default();
        assert_eq!(cursor.push(b"before\x1b[6nAfter"), (b"beforeAfter".to_vec(), true));
        // A request after the startup preamble belongs to the renderer.
        let mut cursor = InitialCursorReport::default();
        let output = vec![b'x'; InitialCursorReport::PREAMBLE];
        assert_eq!(cursor.push(&output), (output.clone(), false));
        assert_eq!(cursor.push(b"\x1b[6n"), (b"\x1b[6n".to_vec(), false));
    }

    #[test]
    fn verbatim_windows_paths_become_plain_for_the_shell() {
        use super::plain_windows_path;
        assert_eq!(plain_windows_path(r"\\?\D:\kybern\work"), r"D:\kybern\work");
        assert_eq!(plain_windows_path(r"\\?\UNC\server\share\dir"), r"\\server\share\dir");
        assert_eq!(plain_windows_path(r"D:\kybern"), r"D:\kybern");
        // A verbatim path with no plain form (a volume GUID) stays as it is.
        assert_eq!(plain_windows_path(r"\\?\Volume{0}\x"), r"\\?\Volume{0}\x");
    }

    use super::*;

    #[cfg(unix)]
    #[test]
    fn byte_lag_resubscription_recovers_bounded_scrollback() {
        let manager = TerminalManager::default();
        let terminal = manager
            .create(
                None,
                None,
                std::env::temp_dir().display().to_string(),
                80,
                24,
                Some(vec!["/bin/sh".into(), "-c".into(), "head -c 4194304 /dev/zero; printf terminal-end".into()]),
            )
            .unwrap();
        let (mut slow, _) = terminal.subscribe_output(false);
        assert!(wait_until(|| !terminal.info().alive));
        assert!(matches!(slow.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))));
        let (_, bytes) = terminal.subscribe_output(true);
        assert!(bytes.len() <= 512 * 1024);
        assert!(bytes.ends_with(b"terminal-end"));
        manager.close(terminal.info().id).unwrap();
    }

    #[cfg(unix)]
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
    fn exit_is_recorded_once_and_late_finishes_are_ignored() {
        let manager = TerminalManager::default();
        let terminal = manager
            .create(
                None,
                None,
                std::env::temp_dir().display().to_string(),
                80,
                24,
                Some(vec!["/bin/sh".into(), "-c".into(), "exit 4".into()]),
            )
            .unwrap();
        let (mut events, _) = terminal.subscribe_output(false);
        assert!(wait_until(|| !terminal.info().alive), "command did not exit");
        // The exit watcher Windows runs lands on the same path after the reader.
        terminal.finish(Some(9));
        terminal.watch_exit();
        assert_eq!(terminal.info().exit_code, Some(4));
        let mut exits = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event.as_ref(), TerminalEvent::Exited(_)) {
                exits += 1;
            }
        }
        assert!(exits <= 1, "Exited sent {exits} times");
        assert!(terminal.resize(100, 30).is_ok());
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
