//! The mechanics of `kybern_request_login`: find a developer CLI on this Mac,
//! ask it whether anyone is signed in, and run its sign-in in a hidden
//! pseudo-terminal while a card follows along. The card's state machine lives
//! in `orchestrator/login_request.rs`; the table of CLIs in
//! `kybern_drivers::login_recipes`.
//!
//! The sign-in is global: it changes the user's own `gh`, `vercel`, ... login.
//! Like `account_login`, the page a CLI would open is recorded by a shim ahead
//! of `PATH` and shown by the client, because the browser belongs to the
//! client. Nothing here logs a URL, a code or any output.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use kybern_drivers::account_auth as auth;
use kybern_drivers::login_recipes::LoginRecipe;
use tokio::sync::mpsc;

use crate::terminal::{Terminal, TerminalEvent, TerminalManager};

/// A verify command that has not answered by now counts as "not signed in".
const VERIFY_TIMEOUT: Duration = Duration::from_secs(8);
const BUFFER_CAP: usize = 64 * 1024;

/// Find an executable the way the user's shell would, then in the places a
/// daemon launched from the app (with a minimal `PATH`) does not look.
pub async fn locate(names: &[&str]) -> Option<PathBuf> {
    for name in names {
        if let Some(found) = locate_one(name).await {
            return Some(found);
        }
    }
    None
}

async fn locate_one(name: &str) -> Option<PathBuf> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return None;
    }
    if let Some(found) = search(&std::env::var("PATH").unwrap_or_default().split(':').map(PathBuf::from).collect::<Vec<_>>(), name) {
        return Some(found);
    }
    // The user's login shell knows Homebrew and other profile additions.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = tokio::process::Command::new(shell);
    command.args(["-lc", &format!("command -v {name}")]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(4), command.output()).await
        && let Some(path) = String::from_utf8_lossy(&output.stdout).lines().rev().map(str::trim).find(|line| line.starts_with('/'))
        && is_executable(Path::new(path))
    {
        return Some(PathBuf::from(path));
    }
    search(&common_dirs(), name)
}

fn search(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|dir| dir.join(name)).find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

fn common_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].into_iter().map(PathBuf::from).collect();
    dirs.extend([".local/bin", ".volta/bin", ".bun/bin", ".fly/bin", "google-cloud-sdk/bin", ".cargo/bin"].map(|dir| home.join(dir)));
    // nvm keeps one bin folder per Node version; the newest name sorts last.
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path().join("bin")).collect();
        versions.sort();
        dirs.extend(versions.into_iter().rev());
    }
    dirs
}

/// `PATH` for a CLI run: its own folder first (Node CLIs need their `node`
/// beside them), then the daemon's.
pub fn run_env(binary: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<String> = Vec::new();
    if let Some(dir) = binary.parent() {
        dirs.push(dir.display().to_string());
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(String::from));
    dirs.push(inherited);
    env.insert("PATH".into(), dirs.join(":"));
    env.insert("NO_COLOR".into(), "1".into());
    env
}

/// Ask the CLI whether someone is signed in. `Some(account)` when signed in.
pub async fn verify(recipe: &LoginRecipe, binary: &Path, cwd: &Path) -> Option<Option<String>> {
    let mut command = tokio::process::Command::new(binary);
    command
        .args(recipe.verify_args)
        .envs(run_env(binary))
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(VERIFY_TIMEOUT, command.output()).await.ok()?.ok()?;
    recipe.read_verify(output.status.success(), &String::from_utf8_lossy(&output.stdout))
}

/// Run a command once, best effort, and say whether it succeeded.
pub async fn run_quiet(binary: &Path, args: &[&str], cwd: &Path) -> bool {
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .envs(run_env(binary))
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    matches!(tokio::time::timeout(Duration::from_secs(20), command.status()).await, Ok(Ok(status)) if status.success())
}

pub enum PtyEvent {
    Out(String),
    Exit,
}

/// A sign-in running in a pseudo-terminal, hidden or shown as a thread's tab.
pub struct PtyRun {
    pub terminal: Arc<Terminal>,
    pub events: mpsc::Receiver<PtyEvent>,
    reader: tokio::task::JoinHandle<()>,
    /// A hidden terminal is closed with the run; a thread's tab stays for the user.
    hidden_in: Option<TerminalManager>,
}

impl Drop for PtyRun {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(terminals) = &self.hidden_in {
            let _ = terminals.close(self.terminal.info().id);
        }
    }
}

/// Start `command` in a pseudo-terminal. `visible` ties it to the thread so
/// the client shows it as a tab; otherwise it is only the daemon's.
pub fn spawn_pty(
    terminals: &TerminalManager,
    thread_id: Option<kybern_protocol::ThreadId>,
    cwd: &Path,
    command: Vec<String>,
    env: &BTreeMap<String, String>,
) -> Result<PtyRun> {
    let (cols, rows) = if thread_id.is_some() { (100, 30) } else { (400, 30) };
    let terminal = terminals.create_with_env(None, thread_id, cwd.to_string_lossy().into_owned(), cols, rows, Some(command), env)?;
    let (events, receiver) = mpsc::channel(256);
    let (mut output, replay) = terminal.subscribe_output(true);
    let watched = terminal.clone();
    let reader = tokio::spawn(async move {
        if !replay.is_empty() {
            let _ = events.send(PtyEvent::Out(String::from_utf8_lossy(&replay).into_owned())).await;
        }
        loop {
            match output.recv().await {
                Ok(event) => match &*event {
                    TerminalEvent::Output(bytes) => {
                        if events.send(PtyEvent::Out(String::from_utf8_lossy(bytes).into_owned())).await.is_err() {
                            break;
                        }
                    }
                    TerminalEvent::Exited(_) => {
                        let _ = events.send(PtyEvent::Exit).await;
                        break;
                    }
                },
                Err(_) => {
                    if !watched.info().alive {
                        let _ = events.send(PtyEvent::Exit).await;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
    Ok(PtyRun { terminal, events: receiver, reader, hidden_in: thread_id.is_none().then(|| terminals.clone()) })
}

/// What a running sign-in has shown so far, folded from its output.
#[derive(Default)]
pub struct Screen {
    text: String,
    enters_sent: usize,
    pub pasted: bool,
}

impl Screen {
    /// Add output. Returns how many times the CLI asked where the cursor is
    /// (`ESC [ 6 n`): a prompt library like gh's waits for the terminal to
    /// answer, and a hidden terminal has nobody to, so the caller does.
    pub fn push(&mut self, chunk: &str) -> usize {
        let queries = chunk.matches("\u{1b}[6n").count();
        self.text.push_str(&auth::strip_ansi(chunk).replace('\r', "\n"));
        if self.text.len() > BUFFER_CAP {
            let mut cut = self.text.len() - BUFFER_CAP;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
        }
        queries
    }

    /// The page and one-time code the CLI printed.
    pub fn device(&self) -> (Option<String>, Option<String>) {
        auth::parse_device_code(&self.text)
    }

    /// How many times the CLI is waiting for Enter that this call has not answered yet.
    pub fn enters_owed(&mut self) -> usize {
        let lower = self.text.to_ascii_lowercase().replace(['[', ']'], "");
        let asked = lower.matches("press enter").count() + lower.matches("(y/n)").count();
        let owed = asked.saturating_sub(self.enters_sent);
        self.enters_sent = asked;
        owed
    }

    /// The CLI asks for the code the sign-in page shows.
    pub fn wants_code(&self, markers: &[&str]) -> bool {
        let lower = self.text.to_ascii_lowercase();
        markers.iter().any(|marker| lower.contains(marker))
    }

    /// The last line worth showing when the sign-in ends badly, without secrets.
    pub fn last_line(&self) -> Option<String> {
        self.text
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('{'))
            .map(auth::redact)
            .map(|line| line.chars().take(160).collect())
    }
}

/// The page the shim recorded, if the CLI tried to open one.
pub fn shim_url(file: &Path) -> Option<String> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| text.lines().map(str::trim).find(|line| line.starts_with("https://")).map(str::to_string))
}

/// A user-visible name of this Mac for sentences.
pub fn shell() -> String {
    std::env::var("SHELL").ok().filter(|shell| Path::new(shell).is_absolute()).unwrap_or_else(|| "/bin/zsh".into())
}

/// A single-quoted shell word.
pub fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

pub fn ensure_url_file(data_dir: &Path, id: &str) -> Result<PathBuf> {
    let dir = data_dir.join("run/logins");
    std::fs::create_dir_all(&dir).map_err(|error| anyhow!("Kybern could not prepare the sign-in: {error}"))?;
    let file = dir.join(format!("{id}.url"));
    std::fs::write(&file, b"")?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_screen_answers_cursor_queries_and_counts_enters() {
        let mut screen = Screen::default();
        let queries = screen.push("\u{1b}[0G\u{1b}[2K? Authenticate Git with your GitHub credentials? (Y/n) \u{1b}[6n");
        assert_eq!(queries, 1);
        assert_eq!(screen.enters_owed(), 1);
        assert_eq!(screen.enters_owed(), 0, "an answered prompt is not answered twice");
        screen
            .push("! First copy your one-time code: 77D8-15A5\r\nPress Enter to open https://github.com/login/device in your browser... ");
        assert_eq!(screen.enters_owed(), 1);
        let (page, code) = screen.device();
        assert_eq!((page.as_deref(), code.as_deref()), (Some("https://github.com/login/device"), Some("77D8-15A5")));
    }

    #[test]
    fn a_pasted_code_prompt_is_noticed() {
        let mut screen = Screen::default();
        screen.push("Enter your verification code: ");
        assert!(screen.wants_code(&["verification code"]));
        assert!(!screen.wants_code(&["authorization code"]));
    }
}
