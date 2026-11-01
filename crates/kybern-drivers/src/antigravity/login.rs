//! Antigravity's stored Google login, read-only.
//!
//! `agy` keeps its OAuth token in the OS keychain through go-keyring (macOS:
//! the generic password with service `gemini` and account `antigravity`), or
//! in a token file where no keychain is reachable. Kybern reads it to learn who
//! is signed in and when the access token expires, and to call the quota
//! endpoints with the token `agy` already refreshed. It never refreshes the
//! token, never writes to `agy`'s storage, and never lets the token leave this
//! module's callers: [`StoredLogin`] redacts it from `Debug`.

use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::Value;

const KEYRING_PREFIX: &str = "go-keyring-base64:";

pub struct StoredLogin {
    access_token: String,
    pub email: Option<String>,
    pub expiry: Option<DateTime<Utc>>,
}

impl std::fmt::Debug for StoredLogin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredLogin")
            .field("access_token", &"<redacted>")
            .field("email", &self.email)
            .field("expiry", &self.expiry)
            .finish()
    }
}

impl StoredLogin {
    /// The bearer token, for the quota calls only.
    pub(crate) fn access_token(&self) -> &str {
        &self.access_token
    }

    /// The token is expired, or will be within `margin`.
    pub fn expires_within(&self, margin: chrono::Duration) -> bool {
        self.expiry.is_some_and(|expiry| expiry <= Utc::now() + margin)
    }
}

/// The login from a keychain value or a token file's text: go-keyring's
/// `go-keyring-base64:` wrapper, or plain JSON of either the wrapper shape
/// (`{"token":{…},"id_token_email":…}`) or a bare `oauth2.Token`.
pub fn parse_login(text: &str) -> Option<StoredLogin> {
    let text = text.trim();
    let json: Value = match text.strip_prefix(KEYRING_PREFIX) {
        Some(encoded) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok()?;
            serde_json::from_slice(&bytes).ok()?
        }
        None => serde_json::from_str(text).ok()?,
    };
    let token = json.get("token").filter(|token| token.is_object()).unwrap_or(&json);
    let access_token = token.get("access_token").and_then(Value::as_str).filter(|token| !token.is_empty())?.to_string();
    let expiry = token
        .get("expiry")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&Utc));
    let email = json.get("id_token_email").and_then(Value::as_str).map(str::trim).filter(|email| !email.is_empty()).map(str::to_string);
    Some(StoredLogin { access_token, email, expiry })
}

fn token_files(home: &Path) -> [PathBuf; 2] {
    let dir = home.join(".gemini").join("antigravity-cli");
    [dir.join("antigravity-oauth-token"), dir.join("oauth_creds.json")]
}

/// `agy`'s login on this machine: the keychain item on macOS, then the token files.
pub async fn read_login(home: Option<&Path>) -> Option<StoredLogin> {
    if let Some(login) = keychain_login().await {
        return Some(login);
    }
    let home = home?;
    token_files(home).iter().find_map(|file| std::fs::read_to_string(file).ok().and_then(|text| parse_login(&text)))
}

#[cfg(target_os = "macos")]
async fn keychain_login() -> Option<StoredLogin> {
    use kybern_protocol::process::NoWindow;
    let mut command = tokio::process::Command::new("/usr/bin/security").no_window();
    command.args(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), crate::process_tree::output(&mut command)).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    parse_login(std::str::from_utf8(&output.stdout).ok()?)
}

#[cfg(not(target_os = "macos"))]
async fn keychain_login() -> Option<StoredLogin> {
    None
}
