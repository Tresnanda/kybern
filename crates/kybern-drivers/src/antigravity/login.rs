//! Antigravity's stored Google login, read-only.
//!
//! `agy` keeps its OAuth token in the OS keyring through go-keyring, service `gemini` and
//! account `antigravity` (the macOS Keychain, the Linux Secret Service, the Windows Credential
//! Manager under the target `gemini:antigravity`), or in a token file where no keyring is
//! reachable. Kybern reads it to learn who is signed in and when the access token expires, and
//! to call the quota endpoints with the token `agy` already refreshed. It never refreshes the
//! token, never writes to `agy`'s storage, never unlocks a locked keyring, and never lets the
//! token leave this module's callers: [`StoredLogin`] redacts it from `Debug`. When the token
//! has expired, `usage.rs` has `agy models` renew it and reads it again.
//!
//! The keyring belongs to the person, not to a home folder, so it is read only for their own
//! home: a test or a tool that points `agy` at another folder gets that folder's token file.

use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::Value;

const KEYRING_PREFIX: &str = "go-keyring-base64:";
/// go-keyring's older wrapper: the value as hex.
const KEYRING_HEX_PREFIX: &str = "go-keyring-encoded:";

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok()).collect()
}

pub struct StoredLogin {
    access_token: String,
    pub email: Option<String>,
    pub expiry: Option<DateTime<Utc>>,
    pub auth_method: Option<String>,
}

impl std::fmt::Debug for StoredLogin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredLogin")
            .field("access_token", &"<redacted>")
            .field("email", &self.email)
            .field("expiry", &self.expiry)
            .field("auth_method", &self.auth_method)
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

    /// Changes whenever `agy` stores a new token (a renewal or a new sign-in), so a
    /// decision taken for one login can be dropped when the next one arrives.
    pub(crate) fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.access_token.hash(&mut hasher);
        self.expiry.map(|expiry| expiry.timestamp()).hash(&mut hasher);
        hasher.finish()
    }
}

/// What looking for `agy`'s login came to.
#[derive(Debug)]
pub enum LoginRead {
    Found(StoredLogin),
    /// Nothing where Kybern looks.
    Missing,
    /// The keychain has an entry Kybern couldn't read: it refused, asked the person, or didn't
    /// answer. `agy` itself may still be signed in.
    Unreadable,
}

impl LoginRead {
    pub fn into_login(self) -> Option<StoredLogin> {
        match self {
            LoginRead::Found(login) => Some(login),
            LoginRead::Missing | LoginRead::Unreadable => None,
        }
    }
}

/// The login from a keychain value or a token file's text: go-keyring's
/// `go-keyring-base64:` wrapper, or plain JSON of either the wrapper shape
/// (`{"token":{…},"id_token_email":…}`) or a bare `oauth2.Token`.
pub fn parse_login(text: &str) -> Option<StoredLogin> {
    let text = text.trim();
    let json: Value = if let Some(encoded) = text.strip_prefix(KEYRING_PREFIX) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok()?;
        serde_json::from_slice(&bytes).ok()?
    } else if let Some(encoded) = text.strip_prefix(KEYRING_HEX_PREFIX) {
        serde_json::from_slice(&decode_hex(encoded.trim())?).ok()?
    } else {
        serde_json::from_str(text).ok()?
    };
    let token = json.get("token").filter(|token| token.is_object()).unwrap_or(&json);
    let access_token = token.get("access_token").and_then(Value::as_str).filter(|token| !token.is_empty())?.to_string();
    let expiry = token
        .get("expiry")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&Utc));
    let email = json.get("id_token_email").and_then(Value::as_str).map(str::trim).filter(|email| !email.is_empty()).map(str::to_string);
    let auth_method =
        json.get("auth_method").and_then(Value::as_str).map(str::trim).filter(|method| !method.is_empty()).map(str::to_string);
    Some(StoredLogin { access_token, email, expiry, auth_method })
}

fn token_files(home: &Path) -> [PathBuf; 2] {
    let dir = home.join(".gemini").join("antigravity-cli");
    [dir.join("antigravity-oauth-token"), dir.join("oauth_creds.json")]
}

/// `agy`'s login on this machine: the keychain item on macOS, then the token files.
pub async fn read_login(home: Option<&Path>) -> Option<StoredLogin> {
    read_login_state(home).await.into_login()
}

/// Like [`read_login`], but says whether a missing login means "none" or "couldn't read it".
pub async fn read_login_state(home: Option<&Path>) -> LoginRead {
    let keychain = keychain_login(home).await;
    if let LoginRead::Found(login) = keychain {
        return LoginRead::Found(login);
    }
    let from_file = home
        .and_then(|home| token_files(home).iter().find_map(|file| std::fs::read_to_string(file).ok().and_then(|text| parse_login(&text))));
    match from_file {
        Some(login) => LoginRead::Found(login),
        None => keychain,
    }
}

/// After the keyring refused or didn't answer, it isn't asked again for this long. macOS may
/// answer a read with a password prompt, and limit reads run every minute or two.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const KEYRING_QUIET: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[cfg(any(target_os = "macos", target_os = "linux"))]
static KEYRING_QUIET_UNTIL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn keyring_is_quiet() -> bool {
    let now = std::time::Instant::now();
    KEYRING_QUIET_UNTIL.lock().map(|until| until.is_some_and(|until| now < until)).unwrap_or(false)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn quiet_keyring(reason: &str) {
    tracing::info!(reason, "couldn't read Antigravity's keyring entry; not asking the keyring again for an hour");
    if let Ok(mut until) = KEYRING_QUIET_UNTIL.lock() {
        *until = Some(std::time::Instant::now() + KEYRING_QUIET);
    }
}

/// Whether `home` is the person's own home folder, whose `agy` uses their keyring.
#[cfg(any(target_os = "linux", windows))]
fn is_user_home(home: Option<&Path>) -> bool {
    let own = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    match (home, own) {
        (Some(home), Some(own)) => home == own,
        _ => false,
    }
}

/// `security`'s exit status when the keychain has no such item (`errSecItemNotFound`).
#[cfg(target_os = "macos")]
const SECURITY_ITEM_NOT_FOUND: i32 = 44;

/// The macOS Keychain through `/usr/bin/security`, the program go-keyring itself stores the item with.
#[cfg(target_os = "macos")]
async fn keychain_login(_home: Option<&Path>) -> LoginRead {
    use kybern_protocol::process::NoWindow;
    if keyring_is_quiet() {
        return LoginRead::Unreadable;
    }
    let mut command = tokio::process::Command::new("/usr/bin/security").no_window();
    command.args(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
    let read = tokio::time::timeout(std::time::Duration::from_secs(3), crate::process_tree::output(&mut command)).await;
    let refused = match read {
        Ok(Ok(output)) if output.status.success() => match std::str::from_utf8(&output.stdout).ok().and_then(parse_login) {
            Some(login) => return LoginRead::Found(login),
            None => return LoginRead::Unreadable,
        },
        Ok(Ok(output)) if output.status.code() == Some(SECURITY_ITEM_NOT_FOUND) => return LoginRead::Missing,
        Ok(Ok(output)) => format!("security exited with {}", output.status),
        Ok(Err(error)) => error.to_string(),
        Err(_) => "security didn't answer within 3 seconds".to_string(),
    };
    quiet_keyring(&refused);
    LoginRead::Unreadable
}

/// The Secret Service (GNOME Keyring, KWallet). Only an unlocked item is read: unlocking would
/// raise a password prompt from a background read.
#[cfg(target_os = "linux")]
async fn keychain_login(home: Option<&Path>) -> LoginRead {
    if !is_user_home(home) {
        return LoginRead::Missing;
    }
    if keyring_is_quiet() {
        return LoginRead::Unreadable;
    }
    // The D-Bus calls block, and a call that hangs can't be cancelled: it is left behind and the keyring left alone.
    let read = tokio::time::timeout(std::time::Duration::from_secs(3), tokio::task::spawn_blocking(secret_service_login)).await;
    match read {
        Ok(Ok(found)) => found,
        Ok(Err(_)) => LoginRead::Unreadable,
        Err(_) => {
            quiet_keyring("the Secret Service didn't answer within 3 seconds");
            LoginRead::Unreadable
        }
    }
}

#[cfg(target_os = "linux")]
fn secret_service_login() -> LoginRead {
    use dbus_secret_service::{EncryptionType, SecretService};
    // No session bus or no Secret Service: `agy` keeps a token file instead.
    let Ok(service) = SecretService::connect(EncryptionType::Dh) else { return LoginRead::Missing };
    // go-keyring's item attributes.
    let attributes = std::collections::HashMap::from([("service", "gemini"), ("username", "antigravity")]);
    let Ok(found) = service.search_items(attributes) else { return LoginRead::Missing };
    for item in &found.unlocked {
        let login = item.get_secret().ok().and_then(|secret| std::str::from_utf8(&secret).ok().and_then(parse_login));
        if let Some(login) = login {
            return LoginRead::Found(login);
        }
    }
    if found.unlocked.is_empty() && found.locked.is_empty() { LoginRead::Missing } else { LoginRead::Unreadable }
}

/// The Windows Credential Manager, which never prompts. go-keyring names the credential `service:user`
/// and stores the value as UTF-8 bytes.
#[cfg(windows)]
async fn keychain_login(home: Option<&Path>) -> LoginRead {
    if !is_user_home(home) {
        return LoginRead::Missing;
    }
    let read = tokio::task::spawn_blocking(|| {
        let Ok(entry) = keyring::Entry::new_with_target("gemini:antigravity", "gemini", "antigravity") else {
            return LoginRead::Unreadable;
        };
        match entry.get_secret() {
            Ok(secret) => match std::str::from_utf8(&secret).ok().and_then(parse_login) {
                Some(login) => LoginRead::Found(login),
                None => LoginRead::Unreadable,
            },
            Err(keyring::Error::NoEntry) => LoginRead::Missing,
            Err(_) => LoginRead::Unreadable,
        }
    })
    .await;
    read.unwrap_or(LoginRead::Unreadable)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn keychain_login(_home: Option<&Path>) -> LoginRead {
    LoginRead::Missing
}
