//! Harness commands Kybern starts in the background (limit reads, sign-in checks) must never
//! open a web page. A signed-out `agy -p /usage` opens Google's sign-in page in the default
//! browser before it says anything Kybern can stop it on, so each background read used to leave
//! a new tab behind.
//!
//! Such commands run with a folder of do-nothing browser openers (`open`, `xdg-open`, …) at the
//! front of their `PATH`; Go's and Node's browser helpers find the opener through `PATH`. The
//! folder lives in the daemon's cache (`<cache>/no-browser/`), written on first use. Windows opens
//! pages through `rundll32`/`cmd start`, which a `PATH` entry can't replace, so there the
//! callers' own limits (never repeating a read that asked to sign in) are what keep it quiet.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where the folder goes, set once by the daemon's driver registry.
static ROOT: OnceLock<PathBuf> = OnceLock::new();
/// The written folder, or `None` when it could not be written.
static READY: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The programs browser helpers use to open a URL on macOS and Linux.
#[cfg(unix)]
const OPENERS: [&str; 6] = ["open", "xdg-open", "x-www-browser", "www-browser", "sensible-browser", "gnome-open"];

/// Use `cache_dir/no-browser` for the folder. The first call wins.
pub fn set_root(cache_dir: &Path) {
    let _ = ROOT.set(cache_dir.join("no-browser"));
}

#[cfg(unix)]
fn write_folder(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for name in OPENERS {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).is_ok_and(|text| text == OPENER) {
            continue;
        }
        kybern_protocol::process::write_executable(&path, OPENER)?;
    }
    Ok(())
}

/// Exits at once without opening anything. The harness then prints the sign-in URL, which is
/// what its caller stops on.
#[cfg(unix)]
const OPENER: &str = "#!/bin/sh\n# Written by Kybern: background commands don't open web pages.\nexit 0\n";

#[cfg(unix)]
fn folder() -> Option<&'static PathBuf> {
    // Nothing is decided before the registry named the folder.
    let root = ROOT.get()?;
    READY
        .get_or_init(|| {
            let dir = root.clone();
            match write_folder(&dir) {
                Ok(()) => Some(dir),
                Err(error) => {
                    tracing::warn!(%error, dir = %dir.display(), "could not write the no-browser folder");
                    None
                }
            }
        })
        .as_ref()
}

/// The `PATH` for a background command: the do-nothing openers first, then the `PATH` the
/// command would have had (`env`'s, else this process's). `None` leaves `PATH` alone.
pub(crate) fn path_for(env: &BTreeMap<String, String>) -> Option<std::ffi::OsString> {
    #[cfg(unix)]
    {
        let dir = folder()?;
        let rest = env.get("PATH").map(std::ffi::OsString::from).or_else(|| std::env::var_os("PATH")).unwrap_or_default();
        let mut parts = vec![dir.clone()];
        parts.extend(std::env::split_paths(&rest).filter(|part| part != dir));
        std::env::join_paths(parts).ok()
    }
    #[cfg(not(unix))]
    {
        let _ = env;
        None
    }
}

/// Point `command`'s `PATH` at the do-nothing openers. Call after `envs(env)`.
pub(crate) fn quiet(command: &mut tokio::process::Command, env: &BTreeMap<String, String>) {
    if let Some(path) = path_for(env) {
        command.env("PATH", path);
    }
}

/// Names the folder for tests: one cache folder for the whole test process, kept until it exits.
#[cfg(all(test, unix))]
pub(crate) fn set_test_root() -> &'static Path {
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    let cache = CACHE.get_or_init(|| tempfile::tempdir().expect("a cache folder").keep());
    set_root(cache);
    ROOT.get().expect("named")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn background_commands_find_the_do_nothing_openers_first() {
        let dir = set_test_root().to_path_buf();
        let env = BTreeMap::from([("PATH".to_string(), format!("/usr/bin:{}:/bin", dir.display()))]);
        let path = path_for(&env).expect("a PATH");
        let parts: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(parts, [dir.clone(), PathBuf::from("/usr/bin"), PathBuf::from("/bin")], "first, and only once");
        for name in OPENERS {
            let opener = dir.join(name);
            let output = std::process::Command::new(&opener).arg("https://accounts.google.com/").output().unwrap();
            assert!(output.status.success(), "{name} exits cleanly");
            assert!(output.stdout.is_empty());
        }
    }
}
