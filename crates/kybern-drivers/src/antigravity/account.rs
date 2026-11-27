//! A named Antigravity account: an `agy` profile of its own, apart from the machine's login.
//!
//! `agy` keeps a Google sign-in in one OS keyring entry for every profile, so a second account
//! needs three things (found in agy 1.5.17; T3 Code does the same):
//! - `agy acp --gemini-dir <dir>` keeps the whole profile (conversations, `config/`, the MCP
//!   entry) in `<dir>` instead of `~/.gemini`. `agy` ignores `GEMINI_HOME`.
//! - [`FILE_STORAGE_ENV`] and an `SSH_CONNECTION` make it keep the login in
//!   `<dir>/antigravity-cli/antigravity-oauth-token`, never in the keyring. The daemon sets both
//!   in the account's environment.
//! - `agy -p` and `agy models` have no `--gemini-dir`. They run with `HOME` set to the account's
//!   home, whose `.gemini` is the profile. Only these short runs (titles, `/usage`, the model
//!   list) get that `HOME`. Sessions run on ACP with the person's own `HOME`, so their tools see
//!   the person's git and shell setup.
//!
//! The account's home is the folder Kybern made for it. [`HOME_ENV`] names it in the
//! environment, and every path Kybern reads under `.gemini` starts from [`agy_home`].

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;

/// The named account's home: its profile is `<home>/.gemini`. Absent for the machine's own login.
pub const HOME_ENV: &str = "KYBERN_ANTIGRAVITY_HOME";
/// Asks `agy` to keep the login in a file in the profile instead of the keyring.
pub const FILE_STORAGE_ENV: &str = "AGY_ACP_FORCE_FILE_STORAGE";
/// What `SSH_CONNECTION` holds when the daemon wasn't started over SSH: `agy` only reads a
/// login file instead of the keyring when it believes it runs over SSH.
pub const SSH_MARKER: &str = "127.0.0.1 0 127.0.0.1 0";

/// The named account's home, or `None` for the machine's own login.
pub fn account_home(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env.get(HOME_ENV).filter(|home| !home.trim().is_empty()).map(PathBuf::from)
}

/// The folder whose `.gemini` holds this account's `agy` profile.
pub(crate) fn agy_home(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    account_home(env).or_else(|| super::env_home(env))
}

/// `agy acp`'s `--gemini-dir` for a named account; nothing for the machine's own login.
pub fn acp_args(env: &BTreeMap<String, String>) -> Vec<OsString> {
    match account_home(env) {
        Some(home) => vec!["--gemini-dir".into(), home.join(".gemini").into()],
        None => Vec::new(),
    }
}

/// The `HOME` (and `USERPROFILE`) an `agy -p` or `agy models` run gets for a named account.
/// Call it after the account's environment is applied.
pub(crate) fn print_home(command: &mut tokio::process::Command, env: &BTreeMap<String, String>) {
    if let Some(home) = account_home(env) {
        command.env("HOME", &home).env("USERPROFILE", &home);
    }
}

/// The ACP command keeps the person's own `HOME`, even if the account's environment carries another.
pub(crate) fn session_home(command: &mut tokio::process::Command, env: &BTreeMap<String, String>) {
    if account_home(env).is_some() {
        for key in ["HOME", "USERPROFILE"] {
            match std::env::var_os(key) {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
    }
}

/// Signs a named account out, as `agy`'s own `/logout` does: `agy acp` on its profile answers ACP's
/// `logout` by removing the login file. The sentence says what to do when it didn't.
pub async fn sign_out(binary: &std::path::Path, env: &BTreeMap<String, String>) -> Result<(), &'static str> {
    if account_home(env).is_none() {
        return Err("Kybern can't sign out this computer's own Antigravity login. Sign out in your terminal instead.");
    }
    super::acp::logout(binary, env).await.map_err(|failure| match failure {
        super::acp::LogoutFailure::Unsupported => "This Antigravity version can't sign out. Update it with `agy update`, then try again.",
        super::acp::LogoutFailure::Failed => "Antigravity didn't sign out. Try again.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn a_named_account_runs_on_its_own_profile_and_the_machine_login_on_the_default_one() {
        let named = env(&[(HOME_ENV, "/data/accounts/antigravity/a"), ("HOME", "/home/me")]);
        assert_eq!(agy_home(&named), Some(PathBuf::from("/data/accounts/antigravity/a")));
        assert_eq!(acp_args(&named), [OsString::from("--gemini-dir"), PathBuf::from("/data/accounts/antigravity/a/.gemini").into()]);

        let machine = env(&[("HOME", "/home/me")]);
        assert_eq!(agy_home(&machine), Some(PathBuf::from("/home/me")));
        assert!(acp_args(&machine).is_empty());
        // An empty value is no account.
        assert_eq!(account_home(&env(&[(HOME_ENV, " ")])), None);
    }

    #[test]
    fn short_runs_get_the_account_home_and_sessions_keep_the_persons_own() {
        let named = env(&[(HOME_ENV, "/data/a"), ("HOME", "/elsewhere")]);
        let mut print = tokio::process::Command::new("agy");
        print.envs(&named);
        print_home(&mut print, &named);
        let set: BTreeMap<_, _> = print.as_std().get_envs().map(|(key, value)| (key.to_os_string(), value.map(OsString::from))).collect();
        assert_eq!(set[&OsString::from("HOME")], Some(OsString::from("/data/a")));
        assert_eq!(set[&OsString::from("USERPROFILE")], Some(OsString::from("/data/a")));

        let mut session = tokio::process::Command::new("agy");
        session.envs(&named);
        session_home(&mut session, &named);
        let home = session.as_std().get_envs().find(|(key, _)| *key == "HOME").and_then(|(_, value)| value.map(OsString::from));
        assert_eq!(home, std::env::var_os("HOME"));
    }
}
