//! Cursor SDK setup for clients: the install and browser sign-in behind
//! `kybern cursor install` / `login`, run by the daemon so nobody needs a
//! terminal. Both run in the background; clients poll `cursor.status`.
//!
//! Sign-in is a device-style flow: the SDK polls Cursor until the browser
//! finishes, so the page can be opened on whichever machine the client is on.

use std::sync::Mutex;
use std::time::Duration;

use kybern_drivers::ProbeContext;
use kybern_drivers::cursor;
use kybern_protocol::ProviderKind;
use kybern_protocol::methods::{CursorAccount, CursorSetupAction, CursorSetupStatus};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;

use crate::state::AppState;

/// Cursor's sign-in page stays valid for a while; stop waiting after this.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long `sign_in` waits for Cursor to issue the page before returning.
const PAGE_WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct CursorSetup {
    progress: Mutex<Progress>,
}

#[derive(Default)]
struct Progress {
    installing: bool,
    sign_in: Option<SignIn>,
    error: Option<String>,
    generation: u64,
}

struct SignIn {
    generation: u64,
    url: Option<String>,
    cancel: Option<oneshot::Sender<()>>,
}

impl CursorSetup {
    fn lock(&self) -> std::sync::MutexGuard<'_, Progress> {
        self.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn context(state: &AppState) -> ProbeContext {
    let settings = state.settings.get();
    let provider = crate::settings::provider_settings(&settings, ProviderKind::Cursor, None);
    // The provider binary setting is reserved for old ACP sessions.
    ProbeContext { binary: None, cwd: None, env: provider.env }
}

pub async fn status(state: &AppState) -> CursorSetupStatus {
    let context = context(state);
    let installed = cursor::installed(&context);
    let (node_version, mut problem) = match cursor::node_version(&context).await {
        Ok(version) => (Some(version), None),
        Err(error) => (None, Some(cursor::reason(error))),
    };
    if problem.is_none() && !installed && !cursor::npm_available() {
        problem = Some("Cursor’s SDK installs with npm, which comes with Node.js. Install Node.js, then try again.".into());
    }
    let (account, email) = if installed && node_version.is_some() {
        match cursor::auth_status(&context).await {
            Ok(value) => account(&value),
            Err(_) => (CursorAccount::Unknown, None),
        }
    } else {
        (CursorAccount::Unknown, None)
    };
    let progress = state.cursor_setup.lock();
    CursorSetupStatus {
        sdk_version: cursor::SDK_VERSION.into(),
        installed,
        node_version,
        problem,
        account,
        email,
        installing: progress.installing,
        signing_in: progress.sign_in.is_some(),
        login_url: progress.sign_in.as_ref().and_then(|sign_in| sign_in.url.clone()),
        error: progress.error.clone(),
    }
}

fn account(value: &Value) -> (CursorAccount, Option<String>) {
    let email = value["email"].as_str().filter(|email| !email.is_empty()).map(str::to_string);
    match value["status"].as_str() {
        Some("logged-in") => (CursorAccount::SignedIn, email),
        Some("logged-out") => (CursorAccount::SignedOut, None),
        Some("api-key") => (CursorAccount::ApiKey, None),
        _ => (CursorAccount::Unknown, None),
    }
}

pub async fn setup(state: &AppState, action: CursorSetupAction) -> anyhow::Result<CursorSetupStatus> {
    match action {
        CursorSetupAction::Install => install(state),
        CursorSetupAction::SignIn => sign_in(state).await?,
        CursorSetupAction::CancelSignIn => {
            let cancel = state.cursor_setup.lock().sign_in.as_mut().and_then(|sign_in| sign_in.cancel.take());
            if let Some(cancel) = cancel {
                let _ = cancel.send(());
            }
        }
        CursorSetupAction::SignOut => {
            cursor::sign_out(&context(state)).await.map_err(|error| anyhow::anyhow!(cursor::reason(error)))?;
            state.cursor_setup.lock().error = None;
            state.provider_catalogs.invalidate().await;
        }
    }
    Ok(status(state).await)
}

fn install(state: &AppState) {
    {
        let mut progress = state.cursor_setup.lock();
        if progress.installing {
            return;
        }
        progress.installing = true;
        progress.error = None;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let result = cursor::install(&context(&state)).await;
        {
            let mut progress = state.cursor_setup.lock();
            progress.installing = false;
            progress.error = result.err().map(cursor::reason);
        }
        state.provider_catalogs.invalidate().await;
    });
}

/// Start the browser sign-in, or join the one already waiting, and return
/// once Cursor has issued the page (or the attempt failed).
async fn sign_in(state: &AppState) -> anyhow::Result<()> {
    let generation = {
        let mut progress = state.cursor_setup.lock();
        if progress.sign_in.is_none() {
            progress.generation += 1;
            progress.error = None;
            let generation = progress.generation;
            let mut command = cursor::login_command(&context(state))?;
            command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            command.kill_on_drop(true);
            let child = command.spawn()?;
            let (cancel, canceled) = oneshot::channel();
            progress.sign_in = Some(SignIn { generation, url: None, cancel: Some(cancel) });
            tokio::spawn(run_sign_in(state.clone(), generation, child, canceled));
        }
        progress.generation
    };
    let waiting = async {
        loop {
            {
                let progress = state.cursor_setup.lock();
                match &progress.sign_in {
                    Some(sign_in) if sign_in.generation == generation && sign_in.url.is_none() => {}
                    _ => return,
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    let _ = tokio::time::timeout(PAGE_WAIT, waiting).await;
    Ok(())
}

async fn run_sign_in(state: AppState, generation: u64, mut child: tokio::process::Child, canceled: oneshot::Receiver<()>) {
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read_stderr = async move {
        let mut text = Vec::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.take(64 * 1024).read_to_end(&mut text).await;
        }
        text
    };
    let read_stdout = {
        let state = state.clone();
        async move {
            let mut signed_in = false;
            let Some(stdout) = stdout else { return false };
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                match value["status"].as_str() {
                    Some("login-url") => {
                        let url = value["url"].as_str().filter(|url| url.starts_with("https://")).map(str::to_string);
                        let mut progress = state.cursor_setup.lock();
                        if let Some(sign_in) = progress.sign_in.as_mut().filter(|sign_in| sign_in.generation == generation) {
                            sign_in.url = url;
                        }
                    }
                    Some("logged-in") => signed_in = true,
                    _ => {}
                }
            }
            signed_in
        }
    };
    let finished = async { tokio::join!(read_stdout, read_stderr, child.wait()) };
    let error = tokio::select! {
        (signed_in, stderr, exit) = finished => {
            if signed_in && exit.as_ref().is_ok_and(|exit| exit.success()) {
                None
            } else {
                Some(cursor::setup_error(&stderr))
            }
        }
        _ = canceled => None,
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => Some("Cursor sign-in timed out. Sign in again when you’re ready.".into()),
    };
    // Dropping the child (kill_on_drop) ends a canceled or timed-out sign-in.
    drop(child);
    {
        let mut progress = state.cursor_setup.lock();
        if progress.sign_in.as_ref().is_some_and(|sign_in| sign_in.generation == generation) {
            progress.sign_in = None;
            progress.error = error;
        }
    }
    state.provider_catalogs.invalidate().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_sdk_account_without_credentials() {
        assert_eq!(account(&json!({"status": "logged-in", "email": "a@b.c"})), (CursorAccount::SignedIn, Some("a@b.c".into())));
        assert_eq!(account(&json!({"status": "logged-in", "email": ""})), (CursorAccount::SignedIn, None));
        assert_eq!(account(&json!({"status": "logged-out"})), (CursorAccount::SignedOut, None));
        assert_eq!(account(&json!({"status": "api-key", "source": "CURSOR_API_KEY"})), (CursorAccount::ApiKey, None));
        assert_eq!(account(&json!({})), (CursorAccount::Unknown, None));
    }
}
