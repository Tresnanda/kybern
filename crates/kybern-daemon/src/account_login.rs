//! Browser sign-in for harness accounts, run by the daemon so a desktop or CLI
//! client never needs a terminal. It generalizes `cursor_setup`'s sign-in.
//!
//! One `Login` per attempt. A new account signs in to a staging directory
//! (`<data>/accounts/<kind>/<id>`) that is unregistered until `finish`; signing
//! in again to an existing account uses its own folder. Every harness runs with
//! a URL shim ahead of `PATH` that records the page it would open instead of
//! opening it, because the daemon may be remote and the browser belongs to the
//! client. Phases are pushed to clients as `providers.accounts.login.changed`.
//!
//! Nothing here logs a URL, a code or any output: OAuth `state` and
//! `code_challenge` values travel only to clients with `access:write`, the
//! scope that may start a login; others see progress (`for_observer`).

use kybern_protocol::process::NoWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, ensure};
use chrono::Utc;
use kybern_drivers::ProbeContext;
use kybern_drivers::account_auth as auth;
use kybern_protocol::methods::*;
use kybern_protocol::{ProviderAccount, ProviderInstance, ProviderKind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::state::AppState;
use crate::terminal::{Terminal, TerminalEvent};

/// A sign-in page stays valid for a while; stop waiting after this.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long `start` waits for the harness to issue its page or code.
const READY_WAIT: Duration = Duration::from_secs(20);
/// Finished logins stay readable this long.
const RETAIN: Duration = Duration::from_secs(10 * 60);
/// A stdout URL is preferred only after the shim had this long to report the real one.
const STDOUT_URL_GRACE: Duration = Duration::from_millis(1500);
const BUFFER_CAP: usize = 64 * 1024;
const WRONG_CODE: &str = "That code didn't work. Open the sign-in page again and paste the new code.";
/// Written into a staging folder when a new sign-in creates it and removed once the account is registered.
/// Only a folder carrying it is ever swept at start: a folder without it is somebody's account, even when
/// settings no longer list it (an overwrite, an older settings file), and is never deleted.
pub const STAGING_MARKER: &str = ".kybern-staging";

pub struct AccountLogins {
    inner: Arc<Inner>,
}

impl Default for AccountLogins {
    fn default() -> Self {
        Self { inner: Arc::new(Inner { logins: Mutex::new(HashMap::new()), changed: broadcast::channel(64).0 }) }
    }
}

struct Inner {
    logins: Mutex<HashMap<String, Login>>,
    changed: broadcast::Sender<AccountLogin>,
}

struct Login {
    public: AccountLogin,
    /// Folder this login created and must delete unless it is finished.
    staging: Option<PathBuf>,
    /// Where the account's sign-in lives.
    directory: PathBuf,
    /// The attempt is still running.
    active: bool,
    cancel: Option<oneshot::Sender<()>>,
    /// Set before a cancel so the end result is `failed` with this sentence.
    failure: Option<String>,
    writer: Option<Writer>,
    code_sent: bool,
    hidden_terminal: bool,
    finished: Option<ProviderInstance>,
    /// The sign-in was verified, so cleanup must also sign the folder out.
    signed_in: bool,
    /// Signing an account in again landed on another email (or one already added): nothing about the
    /// account changes until `finish` keeps it, and a cancel signs the folder out again (#13).
    choice_pending: bool,
    ended_at: Option<Instant>,
}

#[derive(Clone)]
enum Writer {
    Pipe(Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>),
    Pty(Arc<Terminal>),
}

enum Event {
    Out(String),
    Exit(Option<i32>),
}

/// Everything needed to (re)start the harness process for one login.
#[derive(Clone)]
struct Spec {
    kind: ProviderKind,
    mode: AccountLoginMode,
    binary: Option<PathBuf>,
    args: Vec<String>,
    /// The account's own environment, without the shim variables.
    env: std::collections::BTreeMap<String, String>,
    shim: PathBuf,
    url_file: PathBuf,
    cwd: PathBuf,
    hidden_pty: bool,
}

struct Attempt {
    rx: mpsc::Receiver<Event>,
    task: Option<tokio::task::JoinHandle<()>>,
    terminal: Option<Arc<Terminal>>,
    writer_pipe: Option<Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>>,
}

impl Drop for Attempt {
    fn drop(&mut self) {
        // Aborting drops the process-tree guard, which also ends launcher children.
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl AccountLogins {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Login>> {
        self.inner.logins.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AccountLogin> {
        self.inner.changed.subscribe()
    }

    /// Mutate a login and tell clients if its public shape changed.
    fn update<R>(&self, id: &str, change: impl FnOnce(&mut Login) -> R) -> Option<R> {
        let (result, public) = {
            let mut logins = self.lock();
            let login = logins.get_mut(id)?;
            let before = serde_json::to_value(&login.public).ok();
            let result = change(login);
            let after = serde_json::to_value(&login.public).ok();
            (result, (before != after).then(|| login.public.clone()))
        };
        if let Some(public) = public {
            let _ = self.inner.changed.send(public);
        }
        Some(result)
    }

    fn purge(&self) {
        // A login still holding a staging folder stays until `abandon` deletes it.
        self.lock().retain(|_, login| {
            login.ended_at.is_none_or(|at| at.elapsed() < RETAIN) || (login.staging.is_some() && login.finished.is_none())
        });
    }

    fn handle(&self) -> AccountLogins {
        AccountLogins { inner: self.inner.clone() }
    }

    pub fn get(&self, id: &str) -> Result<AccountLogin> {
        self.purge();
        self.lock().get(id).map(|login| login.public.clone()).ok_or_else(|| anyhow!("This sign-in has ended. Start again."))
    }

    pub async fn start(&self, state: &AppState, params: AccountLoginStartParams) -> Result<AccountLogin> {
        self.purge();
        let kind = params.kind;
        let settings = state.settings.get();
        let provider = settings.providers.get(&kind).cloned().unwrap_or_default();
        let id = uuid::Uuid::now_v7().to_string();
        let data_dir = state.settings.dir().to_path_buf();
        ensure!(
            params.mode != AccountLoginMode::Terminal || kind != ProviderKind::Cursor,
            "Cursor signs in through its browser page. Choose Continue."
        );
        // Grok Build signs in with `grok login` (or XAI_API_KEY) on the machine itself. Kybern has no
        // status probe for that login yet, so it cannot tell a finished sign-in from a failed one.
        ensure!(kind != ProviderKind::GrokBuild, "{}", crate::provider_accounts::GROK_BUILD_ONE_ACCOUNT);
        // Antigravity is the one harness where Kybern signs in the machine's own CLI login, in a
        // visible terminal: `default`, or a new sign-in in Terminal mode that isn't `named` (what
        // clients before named Antigravity accounts send). A named account has its own profile and
        // signs in with `agy acp --gemini-dir … --login`, which prints Google's page and reads the code.
        let antigravity = kind == ProviderKind::Antigravity;
        // Only when named as `default`: a new sign-in is never taken for the machine's own login. A Terminal sign-in
        // without `named` once was (for clients older than named accounts), and a 0.27.1 Add account that thought the
        // Keychain login signed out replaced the person's own login that way.
        let machine_login = antigravity && params.instance.as_deref() == Some("default");
        if machine_login {
            ensure!(
                params.mode == AccountLoginMode::Terminal,
                "Antigravity signs in from a terminal. Choose Terminal, then finish Google's sign-in there."
            );
            // Like the other terminal logins: only while it is signed out, so no client can replace the person's
            // own `agy` login. A Keychain that didn't answer is "unknown", never "signed out".
            let (status, _) = state.account_identities.probe(state, &ProviderInstance::default_for(kind), true).await;
            match status {
                AccountStatus::SignedOut | AccountStatus::NeedsSignIn => {}
                AccountStatus::SignedIn => anyhow::bail!(
                    "Antigravity on {} is already signed in, and Kybern never switches it to another account. Add an account instead.",
                    host_name()
                ),
                AccountStatus::Unknown => anyhow::bail!(
                    "Kybern can't tell whether Antigravity is signed in on {}. Sign in from your terminal with agy, or add an account instead.",
                    host_name()
                ),
            }
        } else if antigravity {
            ensure!(
                matches!(params.mode, AccountLoginMode::Paste | AccountLoginMode::Terminal),
                "Antigravity accounts sign in with the code from Google's page. Choose Paste code."
            );
        }

        // Claude Code, Codex and Cursor: Kybern signs the terminal login (`default`) in only while it is
        // signed out. It never switches it to another account and never signs it out on its own.
        let terminal_login = !antigravity && params.instance.as_deref() == Some("default");
        if terminal_login {
            ensure!(
                matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Codex | ProviderKind::Cursor),
                "Kybern can't sign in the terminal login of {}. Sign in from your terminal.",
                kind.display_name()
            );
            // The probe reads a Claude login that is due for a refresh without running Claude Code (#107).
            let (status, _) = state.account_identities.probe(state, &ProviderInstance::default_for(kind), true).await;
            match status {
                AccountStatus::SignedOut | AccountStatus::NeedsSignIn => {}
                AccountStatus::SignedIn => anyhow::bail!(
                    "The terminal login on {} is already signed in, and Kybern never switches it to another account. Add an account instead.",
                    host_name()
                ),
                AccountStatus::Unknown => anyhow::bail!(
                    "Kybern can't tell whether the terminal login of {} is signed in on {}. Check that it is installed, or sign in from your terminal.",
                    kind.display_name(),
                    host_name()
                ),
            }
        }

        // Where the sign-in lands.
        let (directory, created, env_instance, reauth) = match (&params.instance, &params.directory) {
            // The harness's own place; the path only tells this sign-in apart from others and is never created.
            _ if terminal_login => (data_dir.join("run").join("terminal-login").join(kind.as_str()), false, "default".to_string(), true),
            _ if machine_login => {
                // `agy` runs in its own empty folder, so it asks nothing about a project.
                let scratch = data_dir.join("run").join("antigravity-login");
                std::fs::create_dir_all(&scratch)?;
                (scratch, false, "default".to_string(), true)
            }
            (Some(instance), _) => {
                ensure!(
                    instance != "default",
                    "Kybern can't sign in the CLI account, because that would change your terminal login. Sign in from your terminal."
                );
                let account = provider
                    .accounts
                    .get(instance)
                    .ok_or_else(|| anyhow!("That account no longer exists. Refresh Settings › Accounts."))?;
                (PathBuf::from(&account.directory), false, instance.clone(), true)
            }
            (None, Some(directory)) => {
                let path = PathBuf::from(directory);
                ensure!(path.is_absolute() && path.is_dir(), "Choose an existing folder.");
                let path = path.canonicalize()?;
                if let Some(existing) = provider.accounts.values().find(|account| Path::new(&account.directory) == path) {
                    anyhow::bail!("This folder is already added as {}.", existing.name);
                }
                (path, false, id.clone(), false)
            }
            (None, None) => (data_dir.join("accounts").join(kind.as_str()).join(&id), true, id.clone(), false),
        };

        // A second start for the same target joins the one running.
        let existing = {
            let logins = self.lock();
            logins
                .values()
                .find(|login| login.active && login.directory == directory && login.public.kind == kind && !created)
                .map(|login| (login.public.id.clone(), login.public.mode))
        };
        if let Some((existing_id, existing_mode)) = existing {
            if existing_mode == params.mode {
                return self.get(&existing_id);
            }
            self.cancel(state, &existing_id).await?;
        }
        // Codex's browser callback port is fixed, so only one browser login can run.
        if kind == ProviderKind::Codex && params.mode == AccountLoginMode::Browser {
            let busy = self
                .lock()
                .values()
                .any(|login| login.active && login.public.kind == ProviderKind::Codex && login.public.mode == AccountLoginMode::Browser);
            ensure!(!busy, "Another Codex sign-in is waiting in your browser. Finish or cancel it first.");
        }

        // The account's environment, built as if the folder were already registered.
        let mut staged = provider.clone();
        if !reauth {
            staged.accounts.insert(
                id.clone(),
                ProviderAccount { name: "New account".into(), directory: directory.to_string_lossy().into_owned(), ..Default::default() },
            );
        }
        let env = crate::provider_accounts::environment(&staged, kind, &env_instance)?;

        let host = host_name();
        let (binary, args) = if kind == ProviderKind::Cursor {
            let context = ProbeContext { binary: None, cwd: None, env: env.clone() };
            ensure!(
                kybern_drivers::cursor::installed(&context),
                "Cursor's SDK isn't installed on {host}. Install it in Settings › Agent providers."
            );
            (None, Vec::new())
        } else {
            let binary = kybern_drivers::binary::resolve(kind, provider.binary.clone().map(PathBuf::from).as_ref())
                .map_err(|_| anyhow!("{} isn't installed on {host}. Install it in Settings › Agent providers.", kind.display_name()))?;
            let args = if antigravity && !machine_login {
                // `agy acp --gemini-dir <profile> --login`, pasted here or typed in a terminal.
                let profile = kybern_drivers::antigravity::account::acp_args(&env);
                std::iter::once("acp".to_string())
                    .chain(profile.into_iter().map(|arg| arg.to_string_lossy().into_owned()))
                    .chain(std::iter::once("--login".to_string()))
                    .collect()
            } else {
                auth::login_args(kind, params.mode, params.upstream.as_deref()).map_err(|error| anyhow!(error.to_string()))?
            };
            (Some(binary), args)
        };

        if antigravity {
            std::fs::create_dir_all(data_dir.join("run").join("antigravity-login"))?;
        }
        let shim = install_shim(&data_dir)?;
        let url_dir = data_dir.join("run/logins");
        std::fs::create_dir_all(&url_dir)?;
        let url_file = url_dir.join(format!("{id}.url"));
        write_private(&url_file, b"")?;

        let staging = if created {
            std::fs::create_dir_all(&directory)?;
            set_private_dir(&directory);
            write_private(&directory.join(STAGING_MARKER), b"")?;
            Some(directory.clone())
        } else {
            None
        };
        let spec = Spec {
            kind,
            mode: params.mode,
            binary,
            args,
            env,
            shim,
            url_file: url_file.clone(),
            // `agy` runs in an empty folder of its own, so it asks nothing about a project and
            // leaves no `.gemini/skills` in an account folder.
            cwd: if antigravity { data_dir.join("run").join("antigravity-login") } else { data_dir.clone() },
            // Claude's paste prompt is a terminal prompt; a hidden pseudo-terminal
            // is the interface it is known to accept a code through.
            hidden_pty: kind == ProviderKind::ClaudeCode && params.mode == AccountLoginMode::Paste,
        };
        let attempt = match spawn_attempt(state, &spec, params.mode == AccountLoginMode::Terminal) {
            Ok(attempt) => attempt,
            Err(error) => {
                let _ = std::fs::remove_file(&url_file);
                if let Some(staging) = &staging {
                    let _ = std::fs::remove_dir_all(staging);
                }
                return Err(error);
            }
        };
        let terminal = attempt.terminal.clone();
        let public = AccountLogin {
            id: id.clone(),
            kind,
            // Signing in again is how the one default account is told apart from adding a new one.
            instance: if machine_login { Some("default".into()) } else { params.instance.clone() },
            mode: params.mode,
            phase: if params.mode == AccountLoginMode::Terminal { AccountLoginPhase::Waiting } else { AccountLoginPhase::Starting },
            url: None,
            user_code: None,
            terminal: (params.mode == AccountLoginMode::Terminal).then(|| terminal.as_ref().map(|t| t.info())).flatten(),
            identity: None,
            suggested_name: None,
            suggested_color: None,
            duplicate_of: None,
            previous_email: None,
            error: None,
            expires_at: Utc::now() + chrono::Duration::from_std(LOGIN_TIMEOUT).unwrap_or_default(),
            handoff: None,
        };
        let (cancel, canceled) = oneshot::channel();
        let writer = writer_for(&attempt);
        self.lock().insert(
            id.clone(),
            Login {
                public: public.clone(),
                staging,
                directory,
                active: true,
                cancel: Some(cancel),
                failure: None,
                writer,
                code_sent: false,
                hidden_terminal: spec.hidden_pty,
                finished: None,
                signed_in: false,
                choice_pending: false,
                ended_at: None,
            },
        );
        let _ = self.inner.changed.send(public);
        if params.mode == AccountLoginMode::Terminal && kind == ProviderKind::Pi {
            // Pi's interactive /login picks the upstream provider.
            if let Some(terminal) = &terminal {
                let _ = terminal.write(b"/login\r");
            }
        }
        let logins = self.handle();
        let drive_state = state.clone();
        let drive_id = id.clone();
        tokio::spawn(async move { logins.drive(drive_state, drive_id, spec, attempt, canceled).await });

        // Return once the page, code or terminal is ready, or give up.
        let ready = async {
            loop {
                let (phase, has_target) = {
                    let logins = self.lock();
                    match logins.get(&id) {
                        Some(login) => (login.public.phase, login.public.url.is_some() || login.public.user_code.is_some()),
                        None => return,
                    }
                };
                if phase != AccountLoginPhase::Starting || has_target {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        };
        if tokio::time::timeout(READY_WAIT, ready).await.is_err() {
            let message = format!("{} didn't open a sign-in page. Show the terminal to finish there.", kind.display_name());
            self.update(&id, |login| login.failure = Some(message));
            self.cancel_inner(state, &id).await;
        }
        self.get(&id)
    }

    pub async fn input(&self, id: &str, code: String) -> Result<AccountLogin> {
        let code = code.trim().to_string();
        ensure!(!code.is_empty() && code.len() <= 4096, "Paste the code from the sign-in page.");
        let (writer, mode) = {
            let logins = self.lock();
            let login = logins.get(id).ok_or_else(|| anyhow!("This sign-in has ended. Start again."))?;
            ensure!(login.active, "This sign-in has ended. Start again.");
            (login.writer.clone(), login.public.mode)
        };
        ensure!(mode == AccountLoginMode::Paste, "This sign-in doesn't take a code.");
        let writer = writer.ok_or_else(|| anyhow!("This sign-in isn't ready for a code yet."))?;
        // Mark the code as sent before the harness can see it: a wrong code can
        // make it exit before the write returns, and the driver must then
        // restart it rather than fail, and must not be overwritten afterwards.
        let previous = self
            .update(id, |login| {
                let previous = (login.public.phase, login.public.error.take());
                login.code_sent = true;
                login.public.phase = AccountLoginPhase::Verifying;
                previous
            })
            .ok_or_else(|| anyhow!("This sign-in has ended. Start again."))?;
        let written = match writer {
            Writer::Pipe(stdin) => async {
                let mut stdin = stdin.lock().await;
                stdin.write_all(code.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await
            .map_err(anyhow::Error::from),
            Writer::Pty(terminal) => terminal.write(format!("{code}\r").as_bytes()),
        };
        if let Err(error) = written {
            self.update(id, |login| {
                if login.code_sent && login.public.phase == AccountLoginPhase::Verifying {
                    login.code_sent = false;
                    (login.public.phase, login.public.error) = previous;
                }
            });
            return Err(error);
        }
        self.get(id)
    }

    pub async fn cancel(&self, state: &AppState, id: &str) -> Result<AccountLogin> {
        self.get(id)?;
        self.cancel_inner(state, id).await;
        self.get(id)
    }

    async fn cancel_inner(&self, state: &AppState, id: &str) {
        let cancel = self.update(id, |login| login.cancel.take()).flatten();
        if let Some(cancel) = cancel {
            let _ = cancel.send(());
            // The driver kills the process and deletes the staging folder, then clears `active`.
            let waited = Instant::now();
            while waited.elapsed() < Duration::from_secs(5) && self.lock().get(id).is_some_and(|login| login.active) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            // A cancel that lands while the sign-in is being verified reaches a
            // driver that has stopped listening; it ends signed in, so fall
            // through and discard that sign-in too.
            if self.lock().get(id).is_some_and(|login| login.active) {
                return;
            }
        }
        // Not running: a verified sign-in that was never finished still holds a folder.
        self.cleanup(state, id).await;
        self.discard_pending_choice(state, id).await;
        self.update(id, |login| {
            let reauthorized =
                login.public.instance.is_some() && login.public.phase == AccountLoginPhase::SignedIn && !login.choice_pending;
            if login.finished.is_none()
                && !reauthorized
                && !matches!(login.public.phase, AccountLoginPhase::Failed | AccountLoginPhase::Canceled)
            {
                login.public.phase = AccountLoginPhase::Canceled;
            }
        });
    }

    /// The client never finished or canceled a verified sign-in (its window
    /// closed): discard it once the login is no longer readable.
    async fn abandon_later(self, state: AppState, id: String) {
        tokio::time::sleep(RETAIN).await;
        if self.lock().get(&id).is_some_and(|login| login.staging.is_some() && login.finished.is_none()) {
            self.cancel_inner(&state, &id).await;
        }
    }

    /// Delete the staging folder this login created, after signing the folder
    /// out if a sign-in was verified (the harness may keep credentials elsewhere).
    async fn cleanup(&self, state: &AppState, id: &str) {
        let taken = self.update(id, |login| {
            let staging = if login.finished.is_none() { login.staging.take() } else { None };
            (staging, login.signed_in, login.public.kind, login.hidden_terminal)
        });
        let Some((staging, signed_in, kind, _)) = taken else { return };
        let Some(staging) = staging else { return };
        if signed_in {
            sign_out_folder(state, kind, &staging).await;
        }
        let _ = std::fs::remove_dir_all(&staging);
        self.update(id, |login| login.signed_in = false);
    }

    /// A re-sign-in that went to another account and was canceled: the account keeps its email and
    /// signed-out flag, and its folder, which now holds someone else's login, is signed out again.
    async fn discard_pending_choice(&self, state: &AppState, id: &str) {
        let pending = self.update(id, |login| {
            let pending = login.choice_pending && login.finished.is_none();
            login.choice_pending = false;
            pending.then(|| (login.public.kind, login.public.instance.clone(), login.directory.clone()))
        });
        let Some(Some((kind, Some(instance), directory))) = pending else { return };
        sign_out_folder(state, kind, &directory).await;
        let provider_instance = ProviderInstance { kind, instance };
        let _ = state.orchestrator.mark_account_signed_out(&provider_instance, true);
        state.account_identities.invalidate(&provider_instance);
        self.update(id, |login| login.public.phase = AccountLoginPhase::Canceled);
    }

    /// Whether signing `instance` in again waits for the person to keep or discard another account's
    /// sign-in. Until then nothing may learn that account's new identity (#13).
    pub fn choice_pending(&self, instance: &ProviderInstance) -> bool {
        self.lock().values().any(|login| {
            login.choice_pending
                && login.finished.is_none()
                && login.public.kind == instance.kind
                && login.public.instance.as_deref() == Some(instance.instance.as_str())
        })
    }

    pub async fn finish(&self, state: &AppState, params: AccountLoginFinishParams) -> Result<ProviderInstance> {
        let (public, directory, existing, pending) = {
            let logins = self.lock();
            let login = logins.get(&params.id).ok_or_else(|| anyhow!("This sign-in has ended. Start again."))?;
            (login.public.clone(), login.directory.clone(), login.finished.clone(), login.choice_pending)
        };
        if let Some(instance) = existing {
            return Ok(instance);
        }
        ensure!(public.phase == AccountLoginPhase::SignedIn, "Finish signing in before adding the account.");
        if let Some(instance) = public.instance.clone() {
            // Signing in again: "Keep" saves a sign-in that went to another account.
            if let Some(other) = &public.duplicate_of {
                let name = state
                    .settings
                    .get()
                    .providers
                    .get(&public.kind)
                    .and_then(|provider| provider.accounts.get(other))
                    .map(|account| account.name.clone())
                    .unwrap_or_else(|| "the terminal login".into());
                anyhow::bail!("This sign-in is already added as {name}. Try again with the account you meant.");
            }
            let provider_instance = ProviderInstance { kind: public.kind, instance };
            if pending {
                let identity = public.identity.clone().unwrap_or_default();
                self.apply_sign_in_again(state, &provider_instance, &identity, None).await;
            }
            self.update(&params.id, |login| {
                login.finished = Some(provider_instance.clone());
                login.choice_pending = false;
            });
            return Ok(provider_instance);
        }
        ensure!(public.duplicate_of.is_none(), "This account is already added.");
        let name = params.name.trim().to_string();
        ensure!(!name.is_empty() && name.len() <= 120, "Enter a name up to 120 characters.");
        if let Some(color) = &params.color {
            crate::provider_accounts::validate_color(color)?;
        }
        let identity = public.identity.clone().unwrap_or_default();
        // Only this account and (when asked) this machine's default change; anything saved meanwhile stays.
        state.settings.update_with(|current, choice| {
            let mut settings = current.clone();
            let provider = settings.providers.entry(public.kind).or_default();
            let color = params.color.clone().unwrap_or_else(|| crate::provider_accounts::next_color(provider));
            provider.accounts.insert(
                public.id.clone(),
                ProviderAccount {
                    name: name.clone(),
                    directory: directory.to_string_lossy().into_owned(),
                    color: Some(color),
                    email: identity.email.clone(),
                    plan: identity.plan.clone(),
                },
            );
            if params.make_default {
                provider.default_account = Some(public.id.clone());
                // A machine's first account is its default here. With a default shared across the network, the
                // others keep it, and this machine follows it if it has that account (#2).
                if current.accounts_shared.defaults.contains_key(&public.kind) {
                    *choice = crate::settings::AccountChoice::LocalOnly;
                }
            }
            crate::provider_assets::prepare(provider, public.kind)?;
            Ok(Some((settings, ())))
        })?;
        let instance = ProviderInstance { kind: public.kind, instance: public.id.clone() };
        self.update(&params.id, |login| {
            login.finished = Some(instance.clone());
            login.staging = None;
        });
        // Registered first, so a stop between the two leaves a registered folder, which is never swept.
        let _ = std::fs::remove_file(directory.join(STAGING_MARKER));
        state.account_identities.invalidate(&instance);
        state.provider_catalogs.invalidate().await;
        state.orchestrator.usage().forget_account(instance.kind, &instance.instance);
        Ok(instance)
    }

    /// Save what signing an account in again found: its email and plan (only those fields), the cleared
    /// signed-out flag, and for the terminal login the email it now has.
    async fn apply_sign_in_again(&self, state: &AppState, instance: &ProviderInstance, identity: &AccountIdentity, digest: Option<String>) {
        let (kind, id) = (instance.kind, instance.instance.clone());
        let saved = state.settings.update(|current| {
            let account = current.providers.get(&kind)?.accounts.get(&id)?;
            let email = identity.email.clone().or_else(|| account.email.clone());
            let plan = identity.plan.clone().or_else(|| account.plan.clone());
            if account.email == email && account.plan == plan {
                return None;
            }
            let mut next = current.clone();
            let account = next.providers.get_mut(&kind)?.accounts.get_mut(&id)?;
            account.email = email;
            account.plan = plan;
            Some((next, ()))
        });
        if let Err(error) = saved {
            tracing::debug!(%error, "could not save the identity of an account signed in again");
        }
        let _ = state.orchestrator.mark_account_signed_out(instance, false);
        if id == "default" && crate::accounts_shared::remember_terminal_email(&state.store, kind, identity.email.as_deref()) {
            // The terminal login may now be this machine's login for a shared account.
            let _ = state.settings.update(|current| Some((current.clone(), ())));
        }
        match digest {
            Some(digest) => state.account_identities.remember(instance, digest, (AccountStatus::SignedIn, Some(identity.clone()))),
            None => state.account_identities.invalidate(instance),
        }
        state.orchestrator.usage().forget_account(kind, &id);
        state.provider_catalogs.invalidate().await;
    }

    // ---- handing the redirect over from another machine ----

    /// `peer.accounts.login.peek`: the page and redirect of a sign-in that waits for its loopback redirect.
    pub fn peek(&self, id: &str) -> Result<PeerLoginPeek> {
        let login = self.get(id)?;
        ensure!(login.phase == AccountLoginPhase::Waiting, "This sign-in isn't waiting for the browser. Start again.");
        let url = login.url.ok_or_else(|| anyhow!("This sign-in has no page to open yet."))?;
        let (handoff, state) = crate::login_handoff::loopback_redirect(&url)
            .ok_or_else(|| anyhow!("This sign-in doesn't come back to its machine. Use a code instead."))?;
        Ok(PeerLoginPeek { url, handoff, state, expires_at: login.expires_at })
    }

    /// `peer.accounts.login.callback`: replay the browser's redirect to the harness waiting on this machine.
    /// Only a redirect to the harness's own path with the page's own `state` is replayed.
    pub async fn callback(&self, id: &str, path_and_query: &str) -> Result<PeerLoginCallbackResult> {
        let peek = self.peek(id)?;
        crate::login_handoff::check_redirect(&peek.handoff, &peek.state, path_and_query)?;
        crate::login_handoff::replay(peek.handoff.port, path_and_query).await
    }

    // ---- the driver ----

    async fn drive(&self, state: AppState, id: String, spec: Spec, first: Attempt, mut canceled: oneshot::Receiver<()>) {
        let mut attempt = first;
        let deadline = tokio::time::sleep(LOGIN_TIMEOUT);
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let mut buffer = String::new();
        let mut stdout_url_since: Option<Instant> = None;
        let end = 'attempts: loop {
            let outcome = loop {
                tokio::select! {
                    event = attempt.rx.recv() => match event {
                        Some(Event::Out(text)) => {
                            // ConPTY and interactive prompt libraries wait for a cursor report.
                            // A hidden terminal has no renderer to answer it. Unix PTYs never
                            // block on one, so their behaviour stays as it was.
                            if cfg!(windows) && spec.hidden_pty && let Some(terminal) = &attempt.terminal {
                                for _ in text.matches("\x1b[6n") {
                                    let _ = terminal.write(b"\x1b[1;1R");
                                }
                            }
                            buffer.push_str(&auth::strip_ansi(&text).replace('\r', "\n"));
                            if buffer.len() > BUFFER_CAP {
                                let mut cut = buffer.len() - BUFFER_CAP;
                                while !buffer.is_char_boundary(cut) { cut += 1; }
                                buffer.drain(..cut);
                            }
                            self.observe(&id, &spec, &buffer, &mut stdout_url_since);
                        }
                        Some(Event::Exit(code)) => break Outcome::Exited(code),
                        None => break Outcome::Exited(None),
                    },
                    _ = tick.tick() => {
                        self.observe(&id, &spec, &buffer, &mut stdout_url_since);
                        if spec.mode == AccountLoginMode::Terminal
                            && let Some(terminal) = &attempt.terminal
                            && state.terminals.get(terminal.info().id).is_none()
                        {
                            // The person closed the terminal tab.
                            break Outcome::Exited(None);
                        }
                    }
                    _ = &mut canceled => break Outcome::Canceled,
                    _ = &mut deadline => break Outcome::TimedOut,
                }
            };
            match outcome {
                Outcome::Canceled => break 'attempts End::Canceled,
                Outcome::TimedOut => break 'attempts End::Failed("Sign-in timed out. Try again when you're ready.".into()),
                Outcome::Exited(code) => {
                    let code_sent = self.lock().get(&id).is_some_and(|login| login.code_sent);
                    let signed_in_marker = spec.kind == ProviderKind::Cursor && cursor_logged_in(&buffer);
                    let exited_ok = if spec.kind == ProviderKind::Cursor { signed_in_marker && code == Some(0) } else { code == Some(0) };
                    if exited_ok || spec.mode == AccountLoginMode::Terminal {
                        break 'attempts End::Verify;
                    }
                    if spec.mode == AccountLoginMode::Paste && code_sent {
                        // A code is single-use: restart the harness in the same folder and ask again.
                        if let Some(terminal) = attempt.terminal.take() {
                            let _ = state.terminals.close(terminal.info().id);
                        }
                        match spawn_attempt(&state, &spec, false) {
                            Ok(next) => {
                                attempt = next;
                                buffer.clear();
                                stdout_url_since = None;
                                let writer = writer_for(&attempt);
                                self.update(&id, |login| {
                                    login.writer = writer;
                                    login.code_sent = false;
                                    login.public.url = None;
                                    login.public.phase = AccountLoginPhase::Starting;
                                    login.public.error = Some(WRONG_CODE.into());
                                });
                                continue 'attempts;
                            }
                            Err(error) => break 'attempts End::Failed(error.to_string()),
                        }
                    }
                    break 'attempts End::Failed(failure_sentence(&spec, code, &buffer));
                }
            }
        };
        let hidden = attempt.terminal.clone().filter(|_| spec.hidden_pty);
        let visible = attempt.terminal.clone().filter(|_| !spec.hidden_pty);
        drop(attempt);
        if let Some(terminal) = hidden {
            let _ = state.terminals.close(terminal.info().id);
        }
        match end {
            End::Verify => self.verify(&state, &id, &spec).await,
            End::Canceled => {
                if let Some(visible) = visible {
                    let _ = state.terminals.close(visible.info().id);
                }
                let failure = self.update(&id, |login| login.failure.take()).flatten();
                self.cleanup(&state, &id).await;
                self.update(&id, |login| match failure {
                    Some(error) => {
                        login.public.phase = AccountLoginPhase::Failed;
                        login.public.error = Some(error);
                    }
                    None => login.public.phase = AccountLoginPhase::Canceled,
                });
            }
            End::Failed(error) => {
                self.cleanup(&state, &id).await;
                self.update(&id, |login| {
                    login.public.phase = AccountLoginPhase::Failed;
                    login.public.error = Some(error);
                });
            }
        }
        let _ = std::fs::remove_file(&spec.url_file);
        self.update(&id, |login| {
            login.active = false;
            login.cancel = None;
            login.writer = None;
            login.ended_at = Some(Instant::now());
        });
        if self.lock().get(&id).is_some_and(|login| login.staging.is_some() && login.finished.is_none()) {
            tokio::spawn(self.handle().abandon_later(state, id));
        }
    }

    /// Fold the shim file and harness output into the login's page or code.
    fn observe(&self, id: &str, spec: &Spec, buffer: &str, stdout_url_since: &mut Option<Instant>) {
        let shim_url = std::fs::read_to_string(&spec.url_file)
            .ok()
            .and_then(|text| text.lines().map(str::trim).find(|line| line.starts_with("https://")).map(str::to_string));
        let url;
        let mut user_code = None;
        match spec.mode {
            AccountLoginMode::Terminal => return,
            _ if spec.kind == ProviderKind::Cursor => url = cursor_login_url(buffer),
            AccountLoginMode::DeviceCode => {
                let (page, code) = auth::parse_device_code(buffer);
                url = page;
                user_code = code;
            }
            AccountLoginMode::Paste => {
                let urls = auth::extract_https_urls(buffer);
                url = urls.iter().find(|url| auth::is_manual_redirect_url(url)).or_else(|| urls.first()).cloned();
            }
            AccountLoginMode::Browser => {
                let stdout_url = auth::extract_https_urls(buffer).into_iter().next();
                if stdout_url.is_some() && stdout_url_since.is_none() {
                    *stdout_url_since = Some(Instant::now());
                }
                url = shim_url.or_else(|| stdout_url.filter(|_| stdout_url_since.is_some_and(|at| at.elapsed() >= STDOUT_URL_GRACE)));
            }
        }
        if url.is_none() && user_code.is_none() {
            return;
        }
        let device_ready = spec.mode != AccountLoginMode::DeviceCode || (url.is_some() && user_code.is_some());
        // Claude Code and Codex wait for a loopback redirect: another machine's browser can hand it over.
        let handoff = (spec.mode == AccountLoginMode::Browser && matches!(spec.kind, ProviderKind::ClaudeCode | ProviderKind::Codex))
            .then(|| url.as_deref().and_then(crate::login_handoff::loopback_redirect))
            .flatten()
            .map(|(handoff, _)| handoff);
        self.update(id, |login| {
            if matches!(login.public.phase, AccountLoginPhase::Starting | AccountLoginPhase::Waiting) && device_ready {
                login.public.handoff = handoff;
                login.public.url = url;
                login.public.user_code = user_code;
                login.public.phase = AccountLoginPhase::Waiting;
            }
        });
    }

    /// A working Antigravity sign-in adds Kybern's `kybern` MCP entry right away when
    /// Kybern's tools are on (the default); someone who turned them off keeps them off.
    /// Sessions add the entry too, so a failure here only waits for the next one.
    /// Never fails the sign-in.
    async fn offer_kybern_tools(&self, state: &AppState) {
        let settings = state.settings.get();
        if !settings.antigravity.kybern_tools {
            return;
        }
        if let Err(error) = crate::antigravity_mcp::turn_on(&settings).await {
            tracing::warn!(%error, "could not add Kybern's Antigravity MCP entry after sign-in");
        }
    }

    /// The account of this agent here (the terminal login first) whose login has `email`, other than `except`.
    async fn duplicate_of(
        &self,
        state: &AppState,
        kind: ProviderKind,
        provider: &kybern_protocol::ProviderSettings,
        email: &str,
        except: Option<&str>,
    ) -> Option<String> {
        let email = email.to_ascii_lowercase();
        let instances = std::iter::once("default".to_string()).chain(provider.accounts.keys().cloned());
        for instance in instances.filter(|instance| Some(instance.as_str()) != except) {
            let probed = state.account_identities.probe(state, &ProviderInstance { kind, instance: instance.clone() }, false).await;
            if probed.1.and_then(|identity| identity.email).is_some_and(|other| other.to_ascii_lowercase() == email) {
                return Some(instance);
            }
        }
        None
    }

    /// The harness finished: read the folder's identity, detect duplicates and
    /// suggest a name and color.
    async fn verify(&self, state: &AppState, id: &str, spec: &Spec) {
        self.update(id, |login| login.public.phase = AccountLoginPhase::Verifying);
        let public = {
            let logins = self.lock();
            let Some(login) = logins.get(id) else { return };
            login.public.clone()
        };
        let settings = state.settings.get();
        let provider = settings.providers.get(&public.kind).cloned().unwrap_or_default();
        let context = ProbeContext { binary: provider.binary.clone().map(Into::into), cwd: Some(spec.cwd.clone()), env: spec.env.clone() };
        let (mut status, identity) = crate::account_identity::probe_context(public.kind, &context).await;
        if public.kind == ProviderKind::Antigravity && status == AccountStatus::SignedIn {
            // `agy models` only works signed in, so it confirms what the stored login says.
            let working = match kybern_drivers::binary::resolve(public.kind, context.binary.as_ref()) {
                Ok(binary) => kybern_drivers::antigravity::signed_in_by_models(&binary, &context).await,
                Err(_) => false,
            };
            if !working {
                status = AccountStatus::NeedsSignIn;
            } else {
                kybern_drivers::antigravity::forget_sign_in_waits();
                self.offer_kybern_tools(state).await;
            }
        }
        if status != AccountStatus::SignedIn {
            let sentence = if spec.mode == AccountLoginMode::Terminal {
                format!("{} didn't save a sign-in. Try again, or check the agent's output above.", public.kind.display_name())
            } else {
                format!("{} finished without saving a sign-in. Try again.", public.kind.display_name())
            };
            self.cleanup(state, id).await;
            self.update(id, |login| {
                login.public.phase = AccountLoginPhase::Failed;
                login.public.error = Some(sentence);
            });
            return;
        }
        self.update(id, |login| login.signed_in = true);
        let identity = identity.unwrap_or_default();
        let reauth = public.instance.clone();

        if let Some(instance) = reauth {
            let provider_instance = ProviderInstance { kind: public.kind, instance: instance.clone() };
            let previous_email = provider.accounts.get(&instance).and_then(|account| account.email.clone());
            let changed = match (&previous_email, &identity.email) {
                (Some(old), Some(new)) if !old.eq_ignore_ascii_case(new) => previous_email.clone(),
                _ => None,
            };
            // The same duplicate check as a new account: another account here already has this email.
            let duplicate_of = match (&identity.email, instance == "default") {
                (Some(email), false) => self.duplicate_of(state, public.kind, &provider, email, Some(&instance)).await,
                _ => None,
            };
            // A named account that went to someone else waits for Keep; nothing about it changes before.
            let pending = instance != "default" && (changed.is_some() || duplicate_of.is_some());
            if !pending {
                self.apply_sign_in_again(state, &provider_instance, &identity, Some(crate::account_identity::digest(&spec.env))).await;
            }
            self.update(id, |login| {
                login.signed_in = false;
                login.choice_pending = pending;
                login.public.identity = Some(identity);
                login.public.previous_email = changed;
                login.public.duplicate_of = duplicate_of;
                login.public.phase = AccountLoginPhase::SignedIn;
            });
            return;
        }

        // A new account: is this email already added for this agent?
        let duplicate_of = match identity.email.as_deref() {
            Some(email) => self.duplicate_of(state, public.kind, &provider, email, None).await,
            None => None,
        };
        if duplicate_of.is_some() {
            // The sign-in is unusable as a new account: sign the folder out and delete it.
            self.cleanup(state, id).await;
        }
        let existing_names = provider.accounts.values().map(|account| account.name.clone()).collect::<Vec<_>>();
        let name = suggest_name(public.kind, Some(&identity), &existing_names);
        let color = crate::provider_accounts::next_color(&provider);
        self.update(id, |login| {
            login.public.identity = Some(identity);
            login.public.suggested_name = Some(name);
            login.public.suggested_color = Some(color);
            login.public.duplicate_of = duplicate_of;
            login.public.phase = AccountLoginPhase::SignedIn;
        });
        state.provider_catalogs.invalidate().await;
    }
}

enum Outcome {
    Exited(Option<i32>),
    Canceled,
    TimedOut,
}

enum End {
    Verify,
    Canceled,
    Failed(String),
}

fn writer_for(attempt: &Attempt) -> Option<Writer> {
    attempt.terminal.clone().map(Writer::Pty).or_else(|| attempt.writer_pipe.clone().map(Writer::Pipe))
}

fn failure_sentence(spec: &Spec, code: Option<i32>, buffer: &str) -> String {
    let _ = code;
    let line = buffer
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('{'))
        .map(auth::redact)
        .map(|line| line.chars().take(200).collect::<String>());
    match line {
        Some(line) => format!("{line} Try again, or show the terminal."),
        None => format!("{} stopped before signing in. Try again, or show the terminal.", spec.kind.display_name()),
    }
}

fn cursor_lines(buffer: &str) -> impl Iterator<Item = serde_json::Value> + '_ {
    buffer.lines().filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
}

fn cursor_login_url(buffer: &str) -> Option<String> {
    cursor_lines(buffer)
        .find(|value| value["status"] == "login-url")
        .and_then(|value| value["url"].as_str().filter(|url| url.starts_with("https://")).map(str::to_string))
}

fn cursor_logged_in(buffer: &str) -> bool {
    cursor_lines(buffer).any(|value| value["status"] == "logged-in")
}

// ---- spawning ----

fn spawn_attempt(state: &AppState, spec: &Spec, visible_terminal: bool) -> Result<Attempt> {
    let mut env = spec.env.clone();
    if spec.mode != AccountLoginMode::Terminal {
        let inherited = env.get("PATH").cloned().or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
        let paths = std::iter::once(spec.shim.clone()).chain(std::env::split_paths(&inherited));
        env.insert("PATH".into(), std::env::join_paths(paths)?.to_string_lossy().into_owned());
        env.insert("BROWSER".into(), spec.shim.join(if cfg!(windows) { "open.cmd" } else { "open" }).to_string_lossy().into_owned());
        env.insert("KYBERN_LOGIN_URL_FILE".into(), spec.url_file.to_string_lossy().into_owned());
    }
    if spec.hidden_pty || visible_terminal {
        let binary = spec.binary.clone().ok_or_else(|| anyhow!("This sign-in has no terminal form."))?;
        let command: Vec<String> = std::iter::once(binary.to_string_lossy().into_owned()).chain(spec.args.iter().cloned()).collect();
        let (cols, rows) = if visible_terminal { (100, 30) } else { (400, 30) };
        let terminal =
            state.terminals.create_with_env(None, None, spec.cwd.to_string_lossy().into_owned(), cols, rows, Some(command), &env)?;
        let (events, rx) = mpsc::channel(256);
        let (mut output, replay) = terminal.subscribe_output(true);
        let reader = terminal.clone();
        let task = tokio::spawn(async move {
            if !replay.is_empty() {
                let _ = events.send(Event::Out(String::from_utf8_lossy(&replay).into_owned())).await;
            }
            loop {
                match output.recv().await {
                    Ok(event) => match &*event {
                        TerminalEvent::Output(bytes) => {
                            if events.send(Event::Out(String::from_utf8_lossy(bytes).into_owned())).await.is_err() {
                                break;
                            }
                        }
                        TerminalEvent::Exited(code) => {
                            let _ = events.send(Event::Exit(*code)).await;
                            break;
                        }
                    },
                    Err(_) => {
                        if !reader.info().alive {
                            let _ = events.send(Event::Exit(reader.info().exit_code)).await;
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });
        return Ok(Attempt { rx, task: Some(task), terminal: Some(terminal), writer_pipe: None });
    }

    let mut command = if spec.kind == ProviderKind::Cursor {
        let context = ProbeContext { binary: None, cwd: None, env: spec.env.clone() };
        kybern_drivers::cursor::login_command(&context).map_err(|error| anyhow!(kybern_drivers::cursor::reason(error)))?
    } else {
        let mut command =
            tokio::process::Command::new(spec.binary.clone().ok_or_else(|| anyhow!("The harness isn't installed."))?).no_window();
        command.args(&spec.args).envs(&env).env_remove("NODE_OPTIONS").current_dir(&spec.cwd);
        command
    };
    if spec.kind == ProviderKind::Cursor {
        command.envs(&env);
    }
    // Stdin stays open for every mode: omp cancels when stdin closes.
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let tree = kybern_drivers::process_tree::ProcessTree::interactive(child.id().expect("spawned login"));
    let stdin = child.stdin.take().map(|stdin| Arc::new(tokio::sync::Mutex::new(stdin)));
    let (tx, rx) = mpsc::channel(256);
    let read = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, tx: mpsc::Sender<Event>| {
        tokio::spawn(async move {
            let Some(mut stream) = stream else { return };
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if tx.send(Event::Out(String::from_utf8_lossy(&chunk[..count]).into_owned())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        })
    };
    let out = read(child.stdout.take().map(|stream| Box::new(stream) as _), tx.clone());
    let err = read(child.stderr.take().map(|stream| Box::new(stream) as _), tx.clone());
    let task = tokio::spawn(async move {
        let _tree = tree;
        let status = child.wait().await;
        // Give the readers a moment to drain; a grandchild may hold the pipes open.
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            let _ = out.await;
            let _ = err.await;
        })
        .await;
        let _ = tx.send(Event::Exit(status.ok().and_then(|status| status.code()))).await;
    });
    Ok(Attempt { rx, task: Some(task), terminal: None, writer_pipe: stdin })
}

// ---- helpers ----

/// What a client without `access:write` (a paired phone) may see of a login:
/// its progress, never the sign-in page, the one-time code or the terminal.
pub fn for_observer(mut login: AccountLogin) -> AccountLogin {
    login.url = None;
    login.handoff = None;
    login.user_code = None;
    login.terminal = None;
    login
}

/// Staging folders a previous daemon left behind (it stopped mid sign-in): a
/// folder under `<data>/accounts/<kind>/` that carries [`STAGING_MARKER`] and
/// that no account uses. A folder without the marker is never returned, even
/// when no account lists it: settings can lose an entry (an overwrite, an older
/// file), and deleting it would sign a real account out. Call before serving,
/// so no sign-in of this daemon has started yet.
pub fn orphaned_staging(state: &AppState) -> Vec<(ProviderKind, PathBuf)> {
    let settings = state.settings.get();
    let registered: Vec<PathBuf> = settings
        .providers
        .values()
        .flat_map(|provider| provider.accounts.values())
        .map(|account| {
            let path = PathBuf::from(&account.directory);
            path.canonicalize().unwrap_or(path)
        })
        .collect();
    let root = state.settings.dir().join("accounts");
    let mut orphans = Vec::new();
    for kind in ProviderKind::ALL {
        let Ok(entries) = std::fs::read_dir(root.join(kind.as_str())) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            if !entry.file_type().is_ok_and(|file| file.is_dir()) || !path.join(STAGING_MARKER).is_file() {
                continue;
            }
            if registered.contains(&canonical) {
                // Registered just before a stop removed the marker: the account is real.
                let _ = std::fs::remove_file(path.join(STAGING_MARKER));
            } else {
                orphans.push((kind, path));
            }
        }
    }
    orphans
}

/// Sign out and delete the folders `orphaned_staging` found.
pub async fn remove_orphans(state: AppState, orphans: Vec<(ProviderKind, PathBuf)>) {
    for (kind, path) in orphans {
        sign_out_folder(&state, kind, &path).await;
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// Write the `open` and `xdg-open` shims once per daemon start. They only
/// record the URL they were given, so a remote daemon never opens a browser
/// on its own screen.
pub fn install_shim(data_dir: &Path) -> Result<PathBuf> {
    let dir = data_dir.join("run/login-shim");
    std::fs::create_dir_all(&dir)?;
    for name in ["open", "xdg-open"] {
        let path = dir.join(if cfg!(windows) { format!("{name}.cmd") } else { name.into() });
        #[cfg(unix)]
        let script = "#!/bin/sh\n[ -n \"$KYBERN_LOGIN_URL_FILE\" ] && printf '%s\\n' \"$@\" >> \"$KYBERN_LOGIN_URL_FILE\"\nexit 0\n";
        #[cfg(windows)]
        let script = "@echo off\r\nsetlocal DisableDelayedExpansion\r\n:next\r\nif \"%~1\"==\"\" exit /b 0\r\nset \"url=%~1\"\r\nsetlocal EnableDelayedExpansion\r\nif defined KYBERN_LOGIN_URL_FILE >>\"!KYBERN_LOGIN_URL_FILE!\" echo(!url!\r\nendlocal\r\nshift\r\ngoto next\r\n";
        if std::fs::read_to_string(&path).ok().as_deref() != Some(script) {
            std::fs::write(&path, script)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(dir)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn set_private_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// The machine's name for messages ("Claude Code isn't installed on studio-mac").
fn host_name() -> String {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        std::process::Command::new("hostname")
            .no_window()
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|name| name.trim().trim_end_matches(".local").to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "this machine".into())
    })
    .clone()
}

/// Sign a throwaway folder out through the harness, best effort.
async fn sign_out_folder(state: &AppState, kind: ProviderKind, folder: &Path) {
    let settings = state.settings.get();
    let mut provider = settings.providers.get(&kind).cloned().unwrap_or_default();
    let id = "kybern-cleanup".to_string();
    provider.accounts.insert(
        id.clone(),
        ProviderAccount { name: "Cleanup".into(), directory: folder.to_string_lossy().into_owned(), ..Default::default() },
    );
    let Ok(env) = crate::provider_accounts::environment(&provider, kind, &id) else { return };
    let context =
        ProbeContext { binary: provider.binary.clone().map(Into::into), cwd: Some(state.settings.dir().to_path_buf()), env: env.clone() };
    if kind == ProviderKind::Cursor {
        let _ = kybern_drivers::cursor::sign_out(&ProbeContext { binary: None, ..context }).await;
        return;
    }
    if kind == ProviderKind::Antigravity {
        if let Ok(binary) = kybern_drivers::binary::resolve(kind, context.binary.as_ref()) {
            let _ = kybern_drivers::antigravity::account::sign_out(&binary, &env).await;
        }
        return;
    }
    let Some(args) = auth::sign_out_args(kind, None) else { return };
    let Ok(binary) = kybern_drivers::binary::resolve(kind, context.binary.as_ref()) else { return };
    let mut command = tokio::process::Command::new(binary).no_window();
    command.args(args).envs(&env).stdin(std::process::Stdio::null()).kill_on_drop(true).current_dir(state.settings.dir());
    let _ = tokio::time::timeout(Duration::from_secs(10), command.output()).await;
}

const CONSUMER_DOMAINS: [&str; 10] = [
    "gmail.com",
    "googlemail.com",
    "icloud.com",
    "me.com",
    "outlook.com",
    "hotmail.com",
    "yahoo.com",
    "proton.me",
    "protonmail.com",
    "fastmail.com",
];

fn title_case_words(text: &str) -> String {
    text.split([' ', '.', '_', '+', '-'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map(|first| first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The name the sheet prefills. Rules, in order: a consumer-domain email uses
/// its local part; an organization uses its name; any other email uses its
/// domain label; no email uses the agent name and the next free number. A
/// collision with an existing name appends " 2", " 3" and so on.
pub fn suggest_name(kind: ProviderKind, identity: Option<&AccountIdentity>, existing: &[String]) -> String {
    let email = identity.and_then(|identity| identity.email.as_deref()).filter(|email| email.contains('@'));
    let base = match email {
        Some(email) => {
            let (local, domain) = email.rsplit_once('@').unwrap_or((email, ""));
            let domain = domain.to_ascii_lowercase();
            if CONSUMER_DOMAINS.contains(&domain.as_str()) {
                title_case_words(local)
            } else if let Some(org) =
                identity.and_then(|identity| identity.organization.as_deref()).map(str::trim).filter(|org| !org.is_empty())
            {
                org.to_string()
            } else {
                let mut labels: Vec<&str> = domain.split('.').collect();
                if labels.len() > 1 {
                    labels.pop();
                }
                if labels.len() > 1 && matches!(labels.last().copied(), Some("co" | "com" | "org" | "net" | "ac" | "gov" | "edu")) {
                    labels.pop();
                }
                title_case_words(labels.last().copied().unwrap_or_default())
            }
        }
        None => {
            let name = kind.display_name();
            let mut number = 2;
            while existing.iter().any(|existing| existing.eq_ignore_ascii_case(&format!("{name} {number}"))) {
                number += 1;
            }
            return format!("{name} {number}");
        }
    };
    let base: String = if base.trim().is_empty() { kind.display_name().to_string() } else { base };
    let base: String = base.trim().chars().take(40).collect();
    let mut name = base.clone();
    let mut number = 2;
    while existing.iter().any(|existing| existing.eq_ignore_ascii_case(&name)) {
        name = format!("{base} {number}");
        number += 1;
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(email: Option<&str>, organization: Option<&str>) -> AccountIdentity {
        AccountIdentity { email: email.map(str::to_string), plan: None, organization: organization.map(str::to_string) }
    }

    #[test]
    fn name_prefill_follows_the_rules() {
        let claude = ProviderKind::ClaudeCode;
        let none: Vec<String> = Vec::new();
        assert_eq!(suggest_name(claude, Some(&identity(Some("tresh.pro@gmail.com"), None)), &none), "Tresh Pro");
        assert_eq!(suggest_name(claude, Some(&identity(Some("a_b+c@icloud.com"), Some("Org"))), &none), "A B C");
        assert_eq!(suggest_name(claude, Some(&identity(Some("dev@arunika.co"), Some("Arunika Studio"))), &none), "Arunika Studio");
        assert_eq!(suggest_name(claude, Some(&identity(Some("dev@arunika.co"), None)), &none), "Arunika");
        assert_eq!(suggest_name(claude, Some(&identity(Some("x@mail.example.co.uk"), None)), &none), "Example");
        assert_eq!(suggest_name(ProviderKind::Opencode, Some(&identity(None, None)), &none), "OpenCode 2");
        assert_eq!(suggest_name(ProviderKind::Opencode, None, &["OpenCode 2".to_string()]), "OpenCode 3");
        let taken = vec!["Arunika".to_string(), "Arunika 2".to_string()];
        assert_eq!(suggest_name(claude, Some(&identity(Some("dev@arunika.co"), None)), &taken), "Arunika 3");
        let long = identity(Some("dev@x.co"), Some(&"O".repeat(80)));
        assert_eq!(suggest_name(claude, Some(&long), &none).chars().count(), 40);
    }

    #[test]
    fn shim_records_urls_and_never_opens_a_browser() {
        let root = std::env::temp_dir().join(format!("kybern-shim-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let shim = install_shim(&root).unwrap();
        for name in ["open", "xdg-open"] {
            let path = shim.join(if cfg!(windows) { format!("{name}.cmd") } else { name.into() });
            let script = std::fs::read_to_string(&path).unwrap();
            assert!(script.starts_with(if cfg!(windows) { "@echo off" } else { "#!/bin/sh" }));
            assert!(!script.contains("http"), "the shim must not hard-code a browser or host");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
            }
        }
        let record = root.join("urls");
        // A parallel test can fork while the fixture is being written and briefly
        // inherit its writable descriptor. Read the Unix script through its shell
        // to avoid Linux ETXTBSY; its executable mode is checked above.
        #[cfg(unix)]
        let mut command = {
            let mut command = std::process::Command::new("/bin/sh").no_window();
            command.arg(shim.join("open"));
            command
        };
        #[cfg(not(unix))]
        let mut command = std::process::Command::new(shim.join("open.cmd")).no_window();
        let status = command.arg("https://example.test/a?b=c&state=test!value").env("KYBERN_LOGIN_URL_FILE", &record).status().unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read_to_string(&record).unwrap().replace("\r\n", "\n"), "https://example.test/a?b=c&state=test!value\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cursor_events_are_parsed_from_ndjson() {
        let buffer =
            "Starting login process...\n{\"status\":\"login-url\",\"url\":\"https://cursor.com/login?x=1\"}\n{\"status\":\"logged-in\"}\n";
        assert_eq!(cursor_login_url(buffer).as_deref(), Some("https://cursor.com/login?x=1"));
        assert!(cursor_logged_in(buffer));
        assert!(!cursor_logged_in("{\"status\":\"login-url\",\"url\":\"http://x\"}"));
        assert!(cursor_login_url("{\"status\":\"login-url\",\"url\":\"http://x\"}").is_none());
    }

    #[test]
    fn failure_sentences_are_redacted() {
        let spec = Spec {
            kind: ProviderKind::ClaudeCode,
            mode: AccountLoginMode::Browser,
            binary: None,
            args: vec![],
            env: Default::default(),
            shim: PathBuf::new(),
            url_file: PathBuf::new(),
            cwd: PathBuf::new(),
            hidden_pty: false,
        };
        let sentence = failure_sentence(&spec, Some(1), "ok\nlogin failed at https://x.test/cb?code=SECRETCODE&state=SECRETSTATE");
        assert!(!sentence.contains("SECRET"), "{sentence}");
        assert!(sentence.ends_with("Try again, or show the terminal."));
        assert!(failure_sentence(&spec, None, "").contains("stopped before signing in"));
    }
}

#[cfg(test)]
mod flow_tests {
    use super::*;
    const FAKE_CLAUDE: &str = r#"#!/bin/sh
case "$1 $2" in
"auth login")
  dir="$CLAUDE_CONFIG_DIR"
  if [ -e "$dir/fail" ]; then echo "login failed: https://x.test/cb?code=SECRETCODE&state=SECRETSTATE"; exit 1; fi
  if [ -e "$dir/paste" ]; then
    echo "Opening browser to sign in..."
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good" ]; then cp "$dir/email" "$dir/.signed-in"; exit 0; fi
    echo "bad code"
    exit 1
  fi
  open "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=S"
  while [ ! -e "$dir/approve" ]; do sleep 0.05; done
  cp "$dir/email" "$dir/.signed-in"
  exit 0 ;;
"auth status")
  if [ -e "$CLAUDE_CONFIG_DIR/slow-status" ]; then sleep 1; fi
  if [ -e "$CLAUDE_CONFIG_DIR/.signed-in" ]; then
    printf '{"loggedIn":true,"authMethod":"claude.ai","email":"%s","subscriptionType":"pro"}\n' "$(cat "$CLAUDE_CONFIG_DIR/.signed-in")"
    exit 0
  fi
  echo '{"loggedIn":false}'
  exit 1 ;;
"auth logout")
  rm -f "$CLAUDE_CONFIG_DIR/.signed-in"
  exit 0 ;;
esac
exit 2
"#;

    const FAKE_CODEX: &str = r#"#!/bin/sh
case "$1" in
login) open "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcb"; sleep 30 ;;
esac
exit 0
"#;

    /// `agy acp --gemini-dir <profile> --login`: prints Google's page, takes the code on stdin and
    /// keeps the login as a file in the profile, only when told to stay out of the keyring.
    const FAKE_AGY: &str = r#"#!/bin/sh
case "$1" in
acp)
  [ "$2" = "--gemini-dir" ] && [ "$4" = "--login" ] || exit 3
  [ -n "$SSH_CONNECTION" ] && [ "$AGY_ACP_FORCE_FILE_STORAGE" = "1" ] || exit 4
  echo "Open this link in a browser to log in with Google:"
  echo "  https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=S"
  read code
  [ "$code" = "good" ] || { echo "login cancelled"; exit 1; }
  mkdir -p "$3/antigravity-cli"
  printf '{"token":{"access_token":"t","expiry":"2099-01-01T00:00:00Z"},"auth_method":"oauth-personal","id_token_email":"second@arunika.co"}' > "$3/antigravity-cli/antigravity-oauth-token"
  echo "Logged in as second@arunika.co."
  exit 0 ;;
models)
  [ -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] || { echo "Error: Please sign in to view available models."; exit 1; }
  echo "Fetching available models..."
  printf 'gemini-x\tGemini X\n'
  exit 0 ;;
esac
exit 2
"#;

    struct Fixture {
        state: AppState,
        root: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("kybern-login-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let claude = crate::test_support::powershell_script(
            &bin,
            "claude",
            FAKE_CLAUDE,
            r#"
$dir = $env:CLAUDE_CONFIG_DIR
switch ("$($args[0]) $($args[1])") {
    'auth login' {
        if (Test-Path "$dir/fail") { 'login failed: https://x.test/cb?code=SECRETCODE&state=SECRETSTATE'; exit 1 }
        if (Test-Path "$dir/paste") {
            'Opening browser to sign in...'
            "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S"
            $code = Read-Host 'Paste code here if prompted > '
            if ($code -eq 'good') { Copy-Item "$dir/email" "$dir/.signed-in"; exit 0 }
            'bad code'
            exit 1
        }
        & $env:BROWSER 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=S'
        while (!(Test-Path "$dir/approve")) { Start-Sleep -Milliseconds 50 }
        Copy-Item "$dir/email" "$dir/.signed-in"
        exit 0
    }
    'auth status' {
        if (Test-Path "$dir/slow-status") { Start-Sleep -Seconds 1 }
        if (Test-Path "$dir/.signed-in") {
            @{ loggedIn = $true; authMethod = 'claude.ai'; email = ([IO.File]::ReadAllText([IO.Path]::Combine($dir, '.signed-in'))); subscriptionType = 'pro' } | ConvertTo-Json -Compress
            exit 0
        }
        '{"loggedIn":false}'
        exit 1
    }
    'auth logout' { Remove-Item -Force -ErrorAction SilentlyContinue "$dir/.signed-in"; exit 0 }
}
exit 2
"#,
        );
        let codex = crate::test_support::powershell_script(
            &bin,
            "codex",
            FAKE_CODEX,
            r#"
if ($args[0] -eq 'login') {
    & $env:BROWSER 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcb'
    Start-Sleep -Seconds 30
}
exit 0
"#,
        );
        let agy = crate::test_support::powershell_script(
            &bin,
            "agy",
            FAKE_AGY,
            r#"
switch ($args[0]) {
    'acp' {
        if ($args[1] -ne '--gemini-dir' -or $args[3] -ne '--login') { exit 3 }
        if (!$env:SSH_CONNECTION -or $env:AGY_ACP_FORCE_FILE_STORAGE -ne '1') { exit 4 }
        'Open this link in a browser to log in with Google:'
        '  https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=S'
        $code = [Console]::In.ReadLine()
        if ($code -ne 'good') { 'login cancelled'; exit 1 }
        $dir = Join-Path $args[2] 'antigravity-cli'
        New-Item -ItemType Directory -Force $dir | Out-Null
        [IO.File]::WriteAllText((Join-Path $dir 'antigravity-oauth-token'), '{"token":{"access_token":"t","expiry":"2099-01-01T00:00:00Z"},"auth_method":"oauth-personal","id_token_email":"second@arunika.co"}')
        'Logged in as second@arunika.co.'
        exit 0
    }
    'models' {
        if (!(Test-Path (Join-Path $env:USERPROFILE '.gemini/antigravity-cli/antigravity-oauth-token'))) { 'Error: Please sign in to view available models.'; exit 1 }
        'Fetching available models...'
        "gemini-x`tGemini X"
        exit 0
    }
}
exit 2
"#,
        );
        let paths = crate::config::Paths::resolve(Some(root.join("data"))).unwrap();
        let state = AppState::initialize(&paths).unwrap();
        let mut settings = state.settings.get();
        settings.providers.entry(ProviderKind::ClaudeCode).or_default().binary = Some(claude.to_string_lossy().into_owned());
        settings.providers.entry(ProviderKind::Codex).or_default().binary = Some(codex.to_string_lossy().into_owned());
        settings.providers.entry(ProviderKind::Antigravity).or_default().binary = Some(agy.to_string_lossy().into_owned());
        // The tools entry is `agy mcp`'s, in the person's own profile; these tests leave it alone.
        settings.antigravity.kybern_tools = false;
        state.settings.set(settings).unwrap();
        Fixture { state, root }
    }

    impl Fixture {
        fn staging(&self, kind: &str) -> Vec<PathBuf> {
            std::fs::read_dir(self.state.settings.dir().join("accounts").join(kind))
                .map(|entries| entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect())
                .unwrap_or_default()
        }

        fn login_dir(&self, login: &AccountLogin) -> PathBuf {
            self.state.settings.dir().join("accounts").join(login.kind.as_str()).join(&login.id)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Antigravity's own login reads `$HOME`: an empty home of the test's, never the person's.
    fn isolate_antigravity_home(fixture: &Fixture) -> PathBuf {
        let home = fixture.root.join("agy-home");
        std::fs::create_dir_all(&home).unwrap();
        let mut settings = fixture.state.settings.get();
        let agy = settings.providers.entry(ProviderKind::Antigravity).or_default();
        agy.env.insert("HOME".into(), home.to_string_lossy().into_owned());
        agy.env.insert("USERPROFILE".into(), home.to_string_lossy().into_owned());
        fixture.state.settings.set(settings).unwrap();
        home
    }

    /// A named Claude account `id` in its own folder, last seen as `email`.
    fn named_claude(fixture: &Fixture, id: &str, email: &str) -> PathBuf {
        let folder = fixture.root.join(id);
        std::fs::create_dir_all(&folder).unwrap();
        let mut settings = fixture.state.settings.get();
        settings.providers.entry(ProviderKind::ClaudeCode).or_default().accounts.insert(
            id.into(),
            ProviderAccount {
                name: id.into(),
                directory: folder.to_string_lossy().into_owned(),
                email: Some(email.into()),
                ..Default::default()
            },
        );
        fixture.state.settings.set(settings).unwrap();
        folder
    }

    fn params(kind: ProviderKind, mode: AccountLoginMode) -> AccountLoginStartParams {
        AccountLoginStartParams { kind, instance: None, mode, directory: None, upstream: None, named: false }
    }

    async fn wait_for(state: &AppState, id: &str, ready: impl Fn(&AccountLogin) -> bool) -> AccountLogin {
        for _ in 0..200 {
            let login = state.account_logins.get(id).unwrap();
            if ready(&login) {
                return login;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("login never reached the expected state: {:?}", state.account_logins.get(id).map(|login| (login.phase, login.error)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn browser_login_signs_in_suggests_a_name_and_finish_is_idempotent() {
        let fixture = fixture();
        let state = &fixture.state;
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        assert_eq!(login.phase, AccountLoginPhase::Waiting, "{:?}", login.error);
        assert!(login.url.as_deref().unwrap().starts_with("https://claude.com/"), "the shim captured the page");
        let dir = fixture.login_dir(&login);
        assert!(dir.is_dir());
        assert!(dir.join(STAGING_MARKER).is_file(), "a new sign-in's folder is marked as staging");
        std::fs::write(dir.join("email"), "dev@arunika.co").unwrap();
        std::fs::write(dir.join("approve"), "").unwrap();
        let signed_in = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(signed_in.identity.as_ref().unwrap().email.as_deref(), Some("dev@arunika.co"));
        assert_eq!(signed_in.identity.as_ref().unwrap().plan.as_deref(), Some("Pro"));
        assert_eq!(signed_in.suggested_name.as_deref(), Some("Arunika"));
        assert_eq!(signed_in.suggested_color.as_deref(), Some("blue"));
        assert!(signed_in.duplicate_of.is_none());

        let finish = AccountLoginFinishParams { id: login.id.clone(), name: "Arunika".into(), color: None, make_default: true };
        let instance = state.account_logins.finish(state, finish.clone()).await.unwrap();
        assert_eq!(instance.instance, login.id);
        assert_eq!(state.account_logins.finish(state, finish).await.unwrap(), instance, "finish is idempotent");
        let settings = state.settings.get();
        let provider = &settings.providers[&ProviderKind::ClaudeCode];
        assert_eq!(provider.default_account.as_deref(), Some(login.id.as_str()));
        let account = &provider.accounts[&login.id];
        assert_eq!(account.email.as_deref(), Some("dev@arunika.co"));
        assert_eq!(account.color.as_deref(), Some("blue"));
        assert!(dir.is_dir(), "a finished account keeps its folder");
        assert!(!dir.join(STAGING_MARKER).exists(), "a registered account is no longer staging");
        // Closing the sheet after finish cancels nothing.
        state.account_logins.cancel(state, &login.id).await.unwrap();
        assert!(dir.is_dir());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_terminal_login_is_signed_in_only_while_it_is_signed_out() {
        let fixture = fixture();
        let state = &fixture.state;
        // The fake Claude keeps the terminal login in this folder.
        let terminal = fixture.root.join("terminal");
        std::fs::create_dir_all(&terminal).unwrap();
        let mut settings = state.settings.get();
        settings
            .providers
            .get_mut(&ProviderKind::ClaudeCode)
            .unwrap()
            .env
            .insert("CLAUDE_CONFIG_DIR".into(), terminal.to_string_lossy().into_owned());
        state.settings.set(settings).unwrap();
        std::fs::write(terminal.join(".signed-in"), "shell@arunika.co").unwrap();
        let mut start = params(ProviderKind::ClaudeCode, AccountLoginMode::Browser);
        start.instance = Some("default".into());
        let error = state.account_logins.start(state, start.clone()).await.unwrap_err().to_string();
        assert!(error.contains("already signed in"), "{error}");
        assert!(state.account_logins.start(state, AccountLoginStartParams { kind: ProviderKind::Pi, ..start.clone() }).await.is_err());

        std::fs::remove_file(terminal.join(".signed-in")).unwrap();
        let login = state.account_logins.start(state, start).await.unwrap();
        assert_eq!(login.phase, AccountLoginPhase::Waiting, "{:?}", login.error);
        assert_eq!(login.instance.as_deref(), Some("default"));
        std::fs::write(terminal.join("email"), "shell@arunika.co").unwrap();
        std::fs::write(terminal.join("approve"), "").unwrap();
        let signed_in = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(signed_in.identity.as_ref().unwrap().email.as_deref(), Some("shell@arunika.co"));
        assert_eq!(crate::accounts_shared::terminal_email(&state.store, ProviderKind::ClaudeCode).as_deref(), Some("shell@arunika.co"));
        assert!(state.settings.get().providers[&ProviderKind::ClaudeCode].accounts.is_empty(), "no account was added");
        // Kybern signs it out only when asked to, with the confirmation.
        let refused = crate::provider_accounts::sign_out(state, ProviderInstance::default_for(ProviderKind::ClaudeCode).into()).await;
        assert!(refused.unwrap_err().to_string().contains("Confirm"));
        assert!(terminal.join(".signed-in").exists());
        let params = AccountsSignOutParams { kind: ProviderKind::ClaudeCode, instance: "default".into(), confirm_terminal: true };
        let summary = crate::provider_accounts::sign_out(state, params).await.unwrap();
        assert_eq!(summary.status, AccountStatus::SignedOut);
        assert!(summary.terminal);
        assert!(!terminal.join(".signed-in").exists());
        // Signed out, it still names the account it was, so it stays on that account's row.
        assert_eq!(summary.key.as_deref(), Some("claude-code:shell@arunika.co"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_browser_login_offers_its_loopback_redirect_to_another_machine() {
        let fixture = fixture();
        let state = &fixture.state;
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        // The fake Claude's page comes back to http://localhost:1/cb with state S.
        assert_eq!(login.handoff, Some(LoginHandoff { port: 1, path: "/cb".into() }));
        assert!(for_observer(login.clone()).handoff.is_none());
        let peek = state.account_logins.peek(&login.id).unwrap();
        assert_eq!((peek.state.as_str(), peek.handoff.port), ("S", 1));
        let wrong = state.account_logins.callback(&login.id, "/cb?code=c&state=other").await.unwrap_err();
        assert!(wrong.to_string().contains("another sign-in"), "{wrong}");
        assert!(state.account_logins.callback(&login.id, "/elsewhere?state=S").await.is_err());
        state.account_logins.cancel(state, &login.id).await.unwrap();
        assert!(state.account_logins.peek(&login.id).is_err(), "an ended login has nothing to hand over");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_leaves_no_staging_folder_and_no_account() {
        let fixture = fixture();
        let state = &fixture.state;
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        assert_eq!(fixture.staging(ProviderKind::ClaudeCode.as_str()).len(), 1);
        let canceled = state.account_logins.cancel(state, &login.id).await.unwrap();
        assert_eq!(canceled.phase, AccountLoginPhase::Canceled);
        assert!(fixture.staging(ProviderKind::ClaudeCode.as_str()).is_empty(), "staging deleted");
        assert!(state.settings.get().providers[&ProviderKind::ClaudeCode].accounts.is_empty());
        assert!(!state.settings.dir().join("run/logins").join(format!("{}.url", login.id)).exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_signed_in_login_that_is_canceled_is_signed_out_and_deleted() {
        let fixture = fixture();
        let state = &fixture.state;
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        let dir = fixture.login_dir(&login);
        std::fs::write(dir.join("email"), "dev@arunika.co").unwrap();
        std::fs::write(dir.join("approve"), "").unwrap();
        wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        // Closing without finishing on a non-success step cancels and cleans up.
        let canceled = state.account_logins.cancel(state, &login.id).await.unwrap();
        assert_eq!(canceled.phase, AccountLoginPhase::Canceled);
        assert!(!dir.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_same_email_as_an_existing_account_is_a_duplicate_and_creates_nothing() {
        let fixture = fixture();
        let state = &fixture.state;
        let work = fixture.root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join(".signed-in"), "Dev@Arunika.co").unwrap();
        let mut settings = state.settings.get();
        settings.providers.entry(ProviderKind::ClaudeCode).or_default().accounts.insert(
            "work".into(),
            ProviderAccount { name: "Work".into(), directory: work.to_string_lossy().into_owned(), ..Default::default() },
        );
        state.settings.set(settings).unwrap();
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        let dir = fixture.login_dir(&login);
        std::fs::write(dir.join("email"), "dev@arunika.co").unwrap();
        std::fs::write(dir.join("approve"), "").unwrap();
        let done = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(done.duplicate_of.as_deref(), Some("work"));
        assert!(!dir.exists(), "the unusable sign-in is signed out and deleted");
        let error = state
            .account_logins
            .finish(state, AccountLoginFinishParams { id: login.id.clone(), name: "Again".into(), color: None, make_default: false })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("already added"));
        assert_eq!(state.settings.get().providers[&ProviderKind::ClaudeCode].accounts.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_wrong_pasted_code_restarts_the_login_and_a_good_one_signs_in() {
        let fixture = fixture();
        let state = &fixture.state;
        // The fake harness takes the paste branch when the folder says so; seed it from a registered existing folder.
        let folder = fixture.root.join("existing");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("paste"), "").unwrap();
        std::fs::write(folder.join("email"), "paste@arunika.co").unwrap();
        let mut start = params(ProviderKind::ClaudeCode, AccountLoginMode::Paste);
        start.directory = Some(folder.to_string_lossy().into_owned());
        let login = state.account_logins.start(state, start).await.unwrap();
        assert_eq!(login.phase, AccountLoginPhase::Waiting, "{:?}", login.error);
        assert!(login.url.as_deref().unwrap().contains("platform.claude.com"), "paste uses the manual page");
        state.account_logins.input(&login.id, "wrong".into()).await.unwrap();
        let retry = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::Waiting && login.error.is_some()).await;
        assert_eq!(retry.error.as_deref(), Some(WRONG_CODE));
        assert!(retry.url.is_some());
        state.account_logins.input(&login.id, "good".into()).await.unwrap();
        let done = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(done.identity.unwrap().email.as_deref(), Some("paste@arunika.co"));
        assert!(folder.is_dir(), "an existing folder is never deleted");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn existing_folders_survive_cancel_and_registered_ones_are_refused() {
        let fixture = fixture();
        let state = &fixture.state;
        let folder = fixture.root.join("existing");
        std::fs::create_dir_all(&folder).unwrap();
        let mut start = params(ProviderKind::ClaudeCode, AccountLoginMode::Browser);
        start.directory = Some(folder.to_string_lossy().into_owned());
        let login = state.account_logins.start(state, start.clone()).await.unwrap();
        state.account_logins.cancel(state, &login.id).await.unwrap();
        assert!(folder.is_dir());
        let mut settings = state.settings.get();
        settings.providers.entry(ProviderKind::ClaudeCode).or_default().accounts.insert(
            "work".into(),
            ProviderAccount {
                name: "Work".into(),
                directory: folder.canonicalize().unwrap().to_string_lossy().into_owned(),
                ..Default::default()
            },
        );
        state.settings.set(settings).unwrap();
        let error = state.account_logins.start(state, start).await.unwrap_err();
        assert_eq!(error.to_string(), "This folder is already added as Work.");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failing_harness_reports_a_redacted_sentence_and_cleans_up() {
        let fixture = fixture();
        let state = &fixture.state;
        let folder = fixture.root.join("existing");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("fail"), "").unwrap();
        let mut start = params(ProviderKind::ClaudeCode, AccountLoginMode::Browser);
        start.directory = Some(folder.to_string_lossy().into_owned());
        let login = state.account_logins.start(state, start).await.unwrap();
        let failed = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::Failed).await;
        let error = failed.error.unwrap();
        assert!(!error.contains("SECRET"), "{error}");
        assert!(error.ends_with("Try again, or show the terminal."), "{error}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_codex_browser_login_is_refused_until_the_first_ends() {
        let fixture = fixture();
        let state = &fixture.state;
        let first = state.account_logins.start(state, params(ProviderKind::Codex, AccountLoginMode::Browser)).await.unwrap();
        assert!(first.url.is_some());
        let error = state.account_logins.start(state, params(ProviderKind::Codex, AccountLoginMode::Browser)).await.unwrap_err();
        assert_eq!(error.to_string(), "Another Codex sign-in is waiting in your browser. Finish or cancel it first.");
        state.account_logins.cancel(state, &first.id).await.unwrap();
        let second = state.account_logins.start(state, params(ProviderKind::Codex, AccountLoginMode::Browser)).await.unwrap();
        state.account_logins.cancel(state, &second.id).await.unwrap();
        assert!(fixture.staging(ProviderKind::Codex.as_str()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancel_while_verifying_still_discards_the_sign_in() {
        let fixture = fixture();
        let state = &fixture.state;
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        let dir = fixture.login_dir(&login);
        std::fs::write(dir.join("email"), "dev@arunika.co").unwrap();
        std::fs::write(dir.join("slow-status"), "").unwrap();
        std::fs::write(dir.join("approve"), "").unwrap();
        wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::Verifying).await;
        let canceled = state.account_logins.cancel(state, &login.id).await.unwrap();
        assert_eq!(canceled.phase, AccountLoginPhase::Canceled);
        assert!(!dir.exists(), "the verified sign-in is signed out and deleted");
        assert!(fixture.staging(ProviderKind::ClaudeCode.as_str()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn staging_left_by_a_stopped_daemon_is_found_and_removed() {
        let fixture = fixture();
        let state = &fixture.state;
        let accounts = state.settings.dir().join("accounts").join(ProviderKind::ClaudeCode.as_str());
        let orphan = accounts.join("orphan");
        let kept = accounts.join("kept");
        // An account whose settings entry was lost (an overwrite, an older settings file): no marker.
        let unlisted = accounts.join("unlisted");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::create_dir_all(&unlisted).unwrap();
        std::fs::write(orphan.join(STAGING_MARKER), "").unwrap();
        // Registered, then stopped before the marker went.
        std::fs::write(kept.join(STAGING_MARKER), "").unwrap();
        let mut settings = state.settings.get();
        settings.providers.entry(ProviderKind::ClaudeCode).or_default().accounts.insert(
            "kept".into(),
            ProviderAccount { name: "Kept".into(), directory: kept.to_string_lossy().into_owned(), ..Default::default() },
        );
        state.settings.set(settings).unwrap();
        let orphans = orphaned_staging(state);
        assert_eq!(orphans, vec![(ProviderKind::ClaudeCode, orphan.clone())]);
        remove_orphans(state.clone(), orphans).await;
        assert!(!orphan.exists());
        assert!(kept.is_dir(), "a registered account's folder is never swept");
        assert!(!kept.join(STAGING_MARKER).exists(), "a registered folder loses a leftover marker");
        assert!(unlisted.is_dir(), "a folder Kybern never marked as staging is never swept");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn observers_never_see_the_page_or_code() {
        let fixture = fixture();
        let state = &fixture.state;
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        assert!(login.url.is_some());
        let observed = for_observer(login.clone());
        assert!(observed.url.is_none() && observed.user_code.is_none() && observed.terminal.is_none());
        assert_eq!(observed.phase, login.phase);
        state.account_logins.cancel(state, &login.id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_antigravity_account_signs_in_to_its_own_profile_with_a_pasted_code() {
        let fixture = fixture();
        let state = &fixture.state;
        // A named account takes the code from Google's page; a terminal is the machine's own login.
        let error = state.account_logins.start(state, params(ProviderKind::Antigravity, AccountLoginMode::Browser)).await.unwrap_err();
        assert!(error.to_string().contains("Paste code"), "{error}");

        let login = state.account_logins.start(state, params(ProviderKind::Antigravity, AccountLoginMode::Paste)).await.unwrap();
        assert_eq!(login.phase, AccountLoginPhase::Waiting, "{:?}", login.error);
        assert_eq!(login.instance, None, "a new account, not the machine's login");
        assert!(login.url.as_deref().unwrap().contains("antigravity.google"));
        let folder = fixture.login_dir(&login);

        // A code is single-use: a wrong one starts agy again for a new page.
        state.account_logins.input(&login.id, "wrong".into()).await.unwrap();
        let retry = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::Waiting && login.error.is_some()).await;
        assert_eq!(retry.error.as_deref(), Some(WRONG_CODE));
        state.account_logins.input(&login.id, "good".into()).await.unwrap();
        let done = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(done.identity.unwrap().email.as_deref(), Some("second@arunika.co"));
        assert!(folder.join(".gemini/antigravity-cli/antigravity-oauth-token").is_file(), "the login is a file in the account's profile");

        let instance = state
            .account_logins
            .finish(state, AccountLoginFinishParams { id: login.id.clone(), name: "Second".into(), color: None, make_default: false })
            .await
            .unwrap();
        let provider = state.settings.get().providers[&ProviderKind::Antigravity].clone();
        assert_eq!(std::path::Path::new(&provider.accounts[&instance.instance].directory), folder);
        let env = crate::provider_accounts::environment(&provider, ProviderKind::Antigravity, &instance.instance).unwrap();
        assert_eq!(kybern_drivers::antigravity::account::account_home(&env).as_deref(), Some(folder.as_path()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_named_antigravity_account_can_sign_in_from_a_terminal_and_the_computers_login_still_does() {
        let fixture = fixture();
        let state = &fixture.state;
        let mut start = params(ProviderKind::Antigravity, AccountLoginMode::Terminal);
        start.named = true;
        let login = state.account_logins.start(state, start).await.unwrap();
        assert_eq!(login.instance, None, "a new account, not this computer's login");
        assert!(login.terminal.is_some());
        assert!(fixture.login_dir(&login).is_dir(), "its own folder");
        state.account_logins.cancel(state, &login.id).await.unwrap();
        // Without `named` a new sign-in is still a new account: it is never taken for this computer's own login.
        let unnamed = state.account_logins.start(state, params(ProviderKind::Antigravity, AccountLoginMode::Terminal)).await.unwrap();
        assert_eq!(unnamed.instance, None, "a new account");
        assert!(fixture.login_dir(&unnamed).is_dir(), "its own folder");
        state.account_logins.cancel(state, &unnamed.id).await.unwrap();
        // This computer's own login only when named as `default`, and only while it is signed out (a home of its own here).
        isolate_antigravity_home(&fixture);
        let mut own = params(ProviderKind::Antigravity, AccountLoginMode::Terminal);
        own.instance = Some("default".into());
        let machine = state.account_logins.start(state, own).await.unwrap();
        assert_eq!(machine.instance.as_deref(), Some("default"));
        assert!(fixture.staging("antigravity").is_empty(), "no account folder for this computer's login");
        let _ = state.account_logins.cancel(state, &machine.id).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_computers_own_antigravity_login_is_never_replaced_while_it_is_signed_in() {
        let fixture = fixture();
        let state = &fixture.state;
        let home = isolate_antigravity_home(&fixture);
        let token = home.join(".gemini/antigravity-cli");
        std::fs::create_dir_all(&token).unwrap();
        std::fs::write(
            token.join("antigravity-oauth-token"),
            r#"{"token":{"access_token":"t","expiry":"2099-01-01T00:00:00Z"},"auth_method":"oauth-personal","id_token_email":"me@arunika.co"}"#,
        )
        .unwrap();
        let mut own = params(ProviderKind::Antigravity, AccountLoginMode::Terminal);
        own.instance = Some("default".into());
        let error = state.account_logins.start(state, own).await.unwrap_err();
        assert!(error.to_string().contains("already signed in"), "{error}");
        assert!(token.join("antigravity-oauth-token").is_file(), "the person's own login stays");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_first_sign_in_never_replaces_the_default_shared_across_machines() {
        let fixture = fixture();
        let state = &fixture.state;
        let mut settings = state.settings.get();
        settings.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:else@where.com".into());
        state.settings.set(settings).unwrap();
        let login = state.account_logins.start(state, params(ProviderKind::ClaudeCode, AccountLoginMode::Browser)).await.unwrap();
        let dir = fixture.login_dir(&login);
        std::fs::write(dir.join("email"), "dev@arunika.co").unwrap();
        std::fs::write(dir.join("approve"), "").unwrap();
        wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        // The desktop sends `make_default` for a machine's first account.
        let finish = AccountLoginFinishParams { id: login.id.clone(), name: "Arunika".into(), color: None, make_default: true };
        state.account_logins.finish(state, finish).await.unwrap();
        let settings = state.settings.get();
        assert_eq!(settings.accounts_shared.defaults[&ProviderKind::ClaudeCode], "claude-code:else@where.com", "every machine keeps it");
        assert_eq!(
            settings.providers[&ProviderKind::ClaudeCode].default_account.as_deref(),
            Some(login.id.as_str()),
            "this one runs its own"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn signing_in_again_as_someone_else_changes_nothing_until_it_is_kept() {
        let fixture = fixture();
        let state = &fixture.state;
        let folder = named_claude(&fixture, "work", "work@arunika.co");
        let work = ProviderInstance { kind: ProviderKind::ClaudeCode, instance: "work".into() };
        state.orchestrator.mark_account_signed_out(&work, true).unwrap();
        let again = |state: &AppState| {
            let mut start = params(ProviderKind::ClaudeCode, AccountLoginMode::Browser);
            start.instance = Some("work".into());
            let state = state.clone();
            async move { state.account_logins.start(&state, start).await.unwrap() }
        };
        let email_of = |state: &AppState| state.settings.get().providers[&ProviderKind::ClaudeCode].accounts["work"].email.clone();

        // The browser was signed in to someone else.
        let login = again(state).await;
        std::fs::write(folder.join("email"), "other@arunika.co").unwrap();
        std::fs::write(folder.join("approve"), "").unwrap();
        let done = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(done.previous_email.as_deref(), Some("work@arunika.co"));
        assert_eq!(email_of(state).as_deref(), Some("work@arunika.co"), "nothing changes before Keep");
        assert!(state.orchestrator.admit_signed_out_for_test(&work));
        // A probe meanwhile doesn't learn the new identity either.
        crate::provider_accounts::list(state, AccountsListParams { kind: Some(ProviderKind::ClaudeCode), refresh: true }).await.unwrap();
        assert_eq!(email_of(state).as_deref(), Some("work@arunika.co"));
        assert!(state.orchestrator.admit_signed_out_for_test(&work));
        // Cancel: the account is as it was, and its folder no longer holds the other person's login.
        let canceled = state.account_logins.cancel(state, &login.id).await.unwrap();
        assert_eq!(canceled.phase, AccountLoginPhase::Canceled);
        assert_eq!(email_of(state).as_deref(), Some("work@arunika.co"));
        assert!(state.orchestrator.admit_signed_out_for_test(&work));
        assert!(!folder.join(".signed-in").exists(), "signed out again");
        assert!(folder.is_dir());

        // Again, and Keep: now it is saved.
        std::fs::remove_file(folder.join("approve")).unwrap();
        let login = again(state).await;
        std::fs::write(folder.join("approve"), "").unwrap();
        wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        let finish = AccountLoginFinishParams { id: login.id.clone(), name: String::new(), color: None, make_default: false };
        assert_eq!(state.account_logins.finish(state, finish).await.unwrap(), work);
        assert_eq!(email_of(state).as_deref(), Some("other@arunika.co"));
        assert!(!state.orchestrator.admit_signed_out_for_test(&work));

        // The duplicate check applies to a re-sign-in too.
        named_claude(&fixture, "home", "home@arunika.co");
        std::fs::write(fixture.root.join("home").join(".signed-in"), "home@arunika.co").unwrap();
        std::fs::remove_file(folder.join("approve")).unwrap();
        let login = again(state).await;
        std::fs::write(folder.join("email"), "home@arunika.co").unwrap();
        std::fs::write(folder.join("approve"), "").unwrap();
        let done = wait_for(state, &login.id, |login| login.phase == AccountLoginPhase::SignedIn).await;
        assert_eq!(done.duplicate_of.as_deref(), Some("home"));
        let finish = AccountLoginFinishParams { id: login.id.clone(), name: String::new(), color: None, make_default: false };
        let error = state.account_logins.finish(state, finish).await.unwrap_err();
        assert!(error.to_string().contains("already added as home"), "{error}");
        assert_eq!(email_of(state).as_deref(), Some("other@arunika.co"));
        state.account_logins.cancel(state, &login.id).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cli_account_of_a_harness_without_terminal_sign_in_cannot_be_signed_in_from_kybern() {
        let fixture = fixture();
        let state = &fixture.state;
        for kind in [ProviderKind::Opencode, ProviderKind::Pi, ProviderKind::Omp] {
            let mut start = params(kind, AccountLoginMode::Browser);
            start.instance = Some("default".into());
            let error = state.account_logins.start(state, start).await.unwrap_err();
            assert!(error.to_string().contains("terminal login"), "{kind}: {error}");
        }
    }
}
