//! `kybern credentials get|set|delete`: the system credential store through the `keyring` crate the desktop shell
//! (`apps/desktop/src-tauri/src/environments.rs`) uses, so the GPUIX client reads and writes the very same entries on
//! macOS (Keychain), Windows (Credential Manager) and Linux (Secret Service) without its own native code.
//!
//! The secret goes in on standard input (`set`) and comes out on standard output (`get`); it is never an argument, an
//! environment value or a log line. Exit codes tell the caller why a call failed without parsing text:
//!
//! | code | meaning                                                                  |
//! | ---- | ------------------------------------------------------------------------ |
//! | 0    | done                                                                     |
//! | 1    | any other failure (the message on standard error names the next step)    |
//! | 2    | usage error (clap)                                                       |
//! | 3    | no such entry                                                            |
//! | 4    | the store is locked, or the unlock prompt was dismissed                  |
//! | 5    | no credential store is reachable here (no Secret Service or D-Bus)       |

use std::io::{Read, Write};

use clap::Subcommand;

pub const EXIT_FAILED: i32 = 1;
pub const EXIT_NOT_FOUND: i32 = 3;
pub const EXIT_LOCKED: i32 = 4;
pub const EXIT_UNAVAILABLE: i32 = 5;

#[derive(Subcommand)]
pub enum CredentialsCmd {
    /// Print the stored secret to standard output.
    Get {
        #[arg(long)]
        service: String,
        #[arg(long)]
        account: String,
    },
    /// Store the secret read from standard input.
    Set {
        #[arg(long)]
        service: String,
        #[arg(long)]
        account: String,
    },
    /// Remove the entry.
    Delete {
        #[arg(long)]
        service: String,
        #[arg(long)]
        account: String,
    },
}

/// Only Kybern's own services: this command must not become a way to read any other app's keychain item.
pub fn valid_service(service: &str) -> bool {
    let rest = service.strip_prefix("dev.kybern.").or_else(|| service.strip_prefix("kybern-"));
    rest.is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
}

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    NotFound,
    Locked,
    Unavailable(String),
    Other(String),
}

impl Failure {
    fn code(&self) -> i32 {
        match self {
            Failure::NotFound => EXIT_NOT_FOUND,
            Failure::Locked => EXIT_LOCKED,
            Failure::Unavailable(_) => EXIT_UNAVAILABLE,
            Failure::Other(_) => EXIT_FAILED,
        }
    }
    fn message(&self) -> String {
        match self {
            Failure::NotFound => "No saved credential. Pair this environment again.".into(),
            Failure::Locked => "The credential store is locked. Unlock your keyring, then try again.".into(),
            Failure::Unavailable(detail) => format!("No system credential store is running. {detail}"),
            Failure::Other(detail) => format!("The system credential store failed: {detail}"),
        }
    }
}

/// Whether a `PlatformFailure` text means the Secret Service bus could not be reached at all (no session bus, no keyring
/// daemon), as opposed to a failure of one operation.
fn bus_unreachable(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "serviceunknown",
        "namehasnoowner",
        "failed to connect",
        "no such file",
        "connection refused",
        "dbus_session_bus_address",
        "unable to autolaunch",
        "autolaunch",
        "not provided by any .service",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Whether a `PlatformFailure` text means the user declined, or the session could not show the unlock prompt (a locked
/// Keychain in a dark wake, a canceled Credential Manager or Keychain dialog).
fn prompt_declined(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "no ui possible",
        "user canceled",
        "user cancelled",
        "interaction not allowed",
        "authorization was denied",
        "user interaction is not allowed",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn classify(error: &keyring::Error, linux: bool) -> Failure {
    match error {
        keyring::Error::NoEntry => Failure::NotFound,
        keyring::Error::NoStorageAccess(_) => Failure::Locked,
        keyring::Error::PlatformFailure(inner) if prompt_declined(&inner.to_string()) => Failure::Locked,
        keyring::Error::PlatformFailure(inner) if linux && bus_unreachable(&inner.to_string()) => {
            Failure::Unavailable("Start a keyring such as GNOME Keyring or KWallet, or sign in to a desktop session.".into())
        }
        // Never include the entry's contents: the keyring errors carry only the platform's own text.
        other => Failure::Other(other.to_string()),
    }
}

/// With no session bus there is nothing for the Secret Service client to reach, and libdbus would try to auto-launch one.
#[cfg(target_os = "linux")]
fn session_bus_missing() -> bool {
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|value| !value.is_empty()) {
        return false;
    }
    !std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|dir| std::path::Path::new(&dir).join("bus").exists())
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry, Failure> {
    if !valid_service(service) {
        return Err(Failure::Other(
            "This command only handles Kybern's own credentials (a service named dev.kybern.… or kybern-…).".into(),
        ));
    }
    if account.is_empty() || account.len() > 256 {
        return Err(Failure::Other("Pass an account of 1–256 characters.".into()));
    }
    #[cfg(target_os = "linux")]
    if session_bus_missing() {
        return Err(Failure::Unavailable("Sign in to a desktop session with a keyring, or start one.".into()));
    }
    keyring::Entry::new(service, account).map_err(|error| classify(&error, cfg!(target_os = "linux")))
}

fn read_stdin() -> Result<String, Failure> {
    let mut secret = String::new();
    std::io::stdin().read_to_string(&mut secret).map_err(|_| Failure::Other("The secret on standard input isn't valid text.".into()))?;
    if secret.is_empty() {
        return Err(Failure::Other("Pass the secret on standard input.".into()));
    }
    Ok(secret)
}

fn execute(cmd: &CredentialsCmd) -> Result<(), Failure> {
    let linux = cfg!(target_os = "linux");
    match cmd {
        CredentialsCmd::Get { service, account } => {
            let secret = entry(service, account)?.get_password().map_err(|error| classify(&error, linux))?;
            let mut out = std::io::stdout().lock();
            out.write_all(secret.as_bytes())
                .and_then(|()| out.flush())
                .map_err(|_| Failure::Other("Unable to write the secret to standard output.".into()))
        }
        CredentialsCmd::Set { service, account } => {
            let entry = entry(service, account)?;
            entry.set_password(&read_stdin()?).map_err(|error| classify(&error, linux))
        }
        CredentialsCmd::Delete { service, account } => {
            entry(service, account)?.delete_credential().map_err(|error| classify(&error, linux))
        }
    }
}

/// Run one command; the process exit code.
pub fn run(cmd: &CredentialsCmd) -> i32 {
    match execute(cmd) {
        Ok(()) => 0,
        Err(failure) => {
            eprintln!("{}", failure.message());
            failure.code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_kybern_services_are_accepted() {
        assert!(valid_service("dev.kybern.desktop.environments"));
        assert!(valid_service("kybern-wp2-fix-test"));
        for bad in ["", "dev.kybern.", "kybern-", "login", "com.apple.network", "dev.kybern.x y", "dev.kybern.x/../y", "kybern-x;rm"] {
            assert!(!valid_service(bad), "{bad:?}");
        }
    }

    #[test]
    fn errors_map_to_distinct_exit_codes() {
        assert_eq!(classify(&keyring::Error::NoEntry, false).code(), EXIT_NOT_FOUND);
        let locked = keyring::Error::NoStorageAccess("locked".into());
        assert_eq!(classify(&locked, true), Failure::Locked);
        assert_eq!(classify(&locked, true).code(), EXIT_LOCKED);
        let no_bus = keyring::Error::PlatformFailure("org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable".into());
        assert_eq!(classify(&no_bus, true).code(), EXIT_UNAVAILABLE);
        // The same text off Linux is an ordinary failure, and an unrelated Linux failure stays one too.
        assert_eq!(classify(&no_bus, false).code(), EXIT_FAILED);
        assert_eq!(classify(&keyring::Error::PlatformFailure("item rejected".into()), true).code(), EXIT_FAILED);
        let dark_wake = keyring::Error::PlatformFailure("Platform secure storage failure: In dark wake, no UI possible".into());
        assert_eq!(classify(&dark_wake, false), Failure::Locked);
    }

    #[test]
    fn messages_never_carry_the_secret_and_name_the_next_step() {
        assert!(Failure::Locked.message().contains("Unlock your keyring"));
        assert!(Failure::NotFound.message().contains("Pair"));
    }

    #[test]
    fn invalid_arguments_fail_before_the_store_is_touched() {
        let failure = entry("login", "x").expect_err("a foreign service is refused");
        assert_eq!(failure.code(), EXIT_FAILED);
        assert!(entry("kybern-x", "").is_err());
    }
}
