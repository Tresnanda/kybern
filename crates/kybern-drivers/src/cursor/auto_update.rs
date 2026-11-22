//! Moves a Cursor SDK this machine already has to the version the release pins.
//!
//! The SDK is installed at runtime into one folder per version, and discovery
//! never installs anything. Without this, the release after a user set Cursor
//! up would leave Cursor unavailable until they pressed Update. Kybern installed
//! that SDK before, so the update runs by itself, once, in the background:
//!
//! - Only when an earlier version is installed, the pinned one is not, and npm
//!   is found. A machine with no SDK at all is never touched.
//! - Only when the daemon asked for it with [`enable_auto_update`], so tests and
//!   other embedders of the drivers never install anything.
//! - Through the same [`super::install`] the Update button runs, which stages
//!   the install and keeps the earlier folder for hosts still running on it.
//! - One at a time per SDK folder, whoever asks. A failure is remembered for
//!   [`RETRY_AFTER`]; the next daemon start tries again.
//!
//! `KYBERN_CURSOR_AUTO_UPDATE=0` turns it off.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::ProbeContext;

/// How long a failed update waits before the next probe may start another.
const RETRY_AFTER: Duration = Duration::from_secs(6 * 60 * 60);

/// Shown behind "Show details" when the install task ended without a result.
const STOPPED: &str = "The automatic update stopped before it finished. Update it in Settings → Agent providers.";

type Finished = Arc<dyn Fn() + Send + Sync>;

static ENABLED: OnceLock<Finished> = OnceLock::new();
static UPDATES: Mutex<BTreeMap<PathBuf, Entry>> = Mutex::new(BTreeMap::new());

enum Entry {
    Running,
    Failed { at: Instant, error: String },
}

/// What the automatic update is doing for one SDK folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Update {
    /// Installing the pinned SDK in the background.
    Running,
    /// The last attempt failed; the text is for "Show details".
    Failed(String),
}

/// Let this process update an earlier SDK on its own. `finished` runs after
/// every attempt, successful or not, so the caller can refresh what it shows.
/// The first call wins.
pub fn enable_auto_update(finished: impl Fn() + Send + Sync + 'static) {
    let _ = ENABLED.set(Arc::new(finished));
}

/// Starts the automatic update when it applies and none is running, and says
/// what it is doing. `None`: nothing to update, not allowed, or npm is missing.
/// Never waits for the install.
pub fn auto_update(context: &ProbeContext) -> Option<Update> {
    request(context)
}

/// The last automatic update's state without starting one.
pub fn auto_update_state(context: &ProbeContext) -> Option<Update> {
    let dir = super::runtime::installed_dir(context).ok()?;
    match UPDATES.lock().unwrap_or_else(|poison| poison.into_inner()).get(&dir)? {
        Entry::Running => Some(Update::Running),
        Entry::Failed { error, .. } => Some(Update::Failed(error.clone())),
    }
}

pub(super) fn request(context: &ProbeContext) -> Option<Update> {
    if super::runtime::installed(context) || super::runtime::previous_version(context).is_none() {
        return None;
    }
    let dir = super::runtime::installed_dir(context).ok()?;
    let mut updates = UPDATES.lock().unwrap_or_else(|poison| poison.into_inner());
    match updates.get(&dir) {
        Some(Entry::Running) => return Some(Update::Running),
        Some(Entry::Failed { at, error }) if at.elapsed() < RETRY_AFTER => return Some(Update::Failed(error.clone())),
        _ => {}
    }
    let finished = finished_hook()?;
    if disabled(context) || !super::runtime::npm_available(context) {
        return None;
    }
    updates.insert(dir.clone(), Entry::Running);
    drop(updates);
    let context = context.clone();
    tokio::spawn(async move {
        // Settles the entry and refreshes what the caller shows, even if the
        // install task is dropped or panics.
        struct Settle(PathBuf, Option<String>, Finished);
        impl Drop for Settle {
            fn drop(&mut self) {
                {
                    let mut updates = UPDATES.lock().unwrap_or_else(|poison| poison.into_inner());
                    match self.1.take() {
                        None => updates.remove(&self.0),
                        Some(error) => updates.insert(self.0.clone(), Entry::Failed { at: Instant::now(), error }),
                    };
                }
                (self.2)();
            }
        }
        let mut settle = Settle(dir, Some(STOPPED.into()), finished);
        let result = super::runtime::install(&context).await;
        settle.1 = result.err().map(super::reason);
    });
    Some(Update::Running)
}

fn finished_hook() -> Option<Finished> {
    #[cfg(all(test, unix))]
    if let Some(hook) = tests::HOOK.with(|hook| hook.borrow().clone()) {
        return Some(hook);
    }
    ENABLED.get().cloned()
}

fn disabled(context: &ProbeContext) -> bool {
    super::runtime::env(context, "KYBERN_CURSOR_AUTO_UPDATE").is_some_and(|value| matches!(value.trim(), "0" | "false" | "off"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::DriverError;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    thread_local! {
        /// Stands in for `enable_auto_update` on a test's own thread, so one
        /// test never lets another's real home folder be installed into.
        pub(super) static HOOK: RefCell<Option<Finished>> = const { RefCell::new(None) };
    }

    /// A machine with an earlier SDK, and a fake npm that records each run in
    /// `npm-runs` and installs the pinned SDK unless `fail` exists or
    /// `gate` is missing (it waits for the file, so a test holds an install open).
    struct Machine {
        home: tempfile::TempDir,
        context: ProbeContext,
    }

    impl Drop for Machine {
        /// A test that fails before opening the gate must not leave npm polling.
        fn drop(&mut self) {
            let _ = std::fs::write(self.home.path().join("gate"), "");
        }
    }

    impl Machine {
        fn new(previous: Option<&str>) -> Self {
            let home = tempfile::tempdir().unwrap();
            let bin = home.path().join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            if let Some(previous) = previous {
                let old = home.path().join(format!(".kybern/cache/cursor-sdk/{previous}/node_modules/@cursor/sdk"));
                std::fs::create_dir_all(&old).unwrap();
                std::fs::write(old.join("package.json"), format!(r#"{{"version":"{previous}"}}"#)).unwrap();
            }
            kybern_protocol::process::write_executable(&bin.join("node"), "#!/usr/bin/env sh\necho v24.0.0\n").unwrap();
            let state = home.path().display();
            kybern_protocol::process::write_executable(
                &bin.join("npm"),
                format!(
                    r#"#!/usr/bin/env python3
import json, os, pathlib, sys, time
state = pathlib.Path({state:?})
with open(state / 'npm-runs', 'a') as runs:
    runs.write('run\n')
deadline = time.time() + 60
while not (state / 'gate').exists():
    if time.time() > deadline:
        sys.exit(1)
    time.sleep(0.01)
if (state / 'fail').exists():
    sys.stderr.write('npm ERR! network request failed\n')
    sys.exit(1)
version = json.loads(pathlib.Path('package.json').read_text())['dependencies']['@cursor/sdk']
out = pathlib.Path('node_modules/@cursor/sdk')
out.mkdir(parents=True, exist_ok=True)
(out / 'package.json').write_text(json.dumps({{'version': version}}))
"#
                ),
            )
            .unwrap();
            let context = ProbeContext {
                env: BTreeMap::from([
                    ("HOME".into(), home.path().display().to_string()),
                    ("PATH".into(), format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default())),
                ]),
                ..Default::default()
            };
            Self { home, context }
        }

        fn open_gate(&self) {
            std::fs::write(self.home.path().join("gate"), "").unwrap();
        }

        fn fail_installs(&self) {
            std::fs::write(self.home.path().join("fail"), "").unwrap();
        }

        fn npm_runs(&self) -> usize {
            std::fs::read_to_string(self.home.path().join("npm-runs")).map(|text| text.lines().count()).unwrap_or(0)
        }

        fn old_sdk(&self, version: &str) -> PathBuf {
            self.home.path().join(format!(".kybern/cache/cursor-sdk/{version}/node_modules/@cursor/sdk/package.json"))
        }
    }

    /// Counts finished updates and wakes the test, which waits on that
    /// instead of sleeping.
    fn hook() -> (Arc<AtomicUsize>, Arc<tokio::sync::Notify>) {
        let count = Arc::new(AtomicUsize::new(0));
        let notify = Arc::new(tokio::sync::Notify::new());
        let (done, wake) = (count.clone(), notify.clone());
        HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Arc::new(move || {
                done.fetch_add(1, Ordering::SeqCst);
                wake.notify_one();
            }))
        });
        (count, notify)
    }

    fn message(error: DriverError) -> String {
        super::super::reason(error)
    }

    #[tokio::test]
    async fn starts_only_with_an_earlier_sdk_and_npm() {
        let (count, _) = hook();
        // No SDK at all: a fresh machine is never installed into.
        let fresh = Machine::new(None);
        fresh.open_gate();
        assert_eq!(request(&fresh.context), None);
        // An earlier SDK but no npm.
        let no_npm = Machine::new(Some("1.2.0"));
        std::fs::remove_file(no_npm.home.path().join("bin/npm")).unwrap();
        let mut context = no_npm.context.clone();
        context.env.insert("PATH".into(), no_npm.home.path().join("bin").display().to_string());
        assert_eq!(request(&context), None);
        // Opted out.
        let opted_out = Machine::new(Some("1.2.0"));
        let mut context = opted_out.context.clone();
        context.env.insert("KYBERN_CURSOR_AUTO_UPDATE".into(), "0".into());
        assert_eq!(request(&context), None);
        // The daemon never asked for it: no hook, no install.
        HOOK.with(|slot| *slot.borrow_mut() = None);
        let not_enabled = Machine::new(Some("1.2.0"));
        assert_eq!(request(&not_enabled.context), None);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        for machine in [&fresh, &no_npm, &opted_out, &not_enabled] {
            assert_eq!(machine.npm_runs(), 0);
        }
        // An explicit SDK folder names one directory: there is no earlier version to move.
        let explicit = Machine::new(Some("1.2.0"));
        let mut context = explicit.context.clone();
        context.env.insert("KYBERN_CURSOR_SDK_DIR".into(), explicit.home.path().join("elsewhere").display().to_string());
        let _ = hook();
        assert_eq!(request(&context), None);
        assert_eq!(explicit.npm_runs(), 0);
    }

    #[tokio::test]
    async fn concurrent_probes_start_one_install_and_success_makes_cursor_available() {
        let (count, finished) = hook();
        let machine = Machine::new(Some("1.2.0"));
        let ready = || super::super::runtime::installed(&machine.context);
        // Probes made while the install is held open all see "updating" and share it.
        let probes: Vec<_> = (0..8)
            .map(|_| {
                let context = machine.context.clone();
                tokio::spawn(async move { super::super::runtime::probe(&context).await.map(|_| ()).map_err(message) })
            })
            .collect();
        for probe in probes {
            let text = probe.await.unwrap().unwrap_err();
            assert!(text.contains("Updating Cursor’s SDK from 1.2.0") && !text.contains("isn’t installed"), "{text}");
        }
        assert_eq!(request(&machine.context), Some(Update::Running));
        assert_eq!(auto_update_state(&machine.context), Some(Update::Running));
        assert!(!ready());
        machine.open_gate();
        finished.notified().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(machine.npm_runs(), 1, "one install, however many probes asked");
        // The update is done: no entry is left, and the next session loads the pinned SDK.
        assert!(ready());
        assert_eq!(auto_update_state(&machine.context), None);
        assert_eq!(request(&machine.context), None);
        let command = super::super::runtime::command(&machine.context, "stdio").unwrap();
        let sdk = machine.home.path().join(".kybern/cache/cursor-sdk").join(super::super::SDK_VERSION);
        let loaded = command.as_std().get_envs().find(|(key, _)| *key == "KYBERN_CURSOR_SDK_DIR").and_then(|(_, value)| value).unwrap();
        assert_eq!(std::path::Path::new(loaded), sdk);
        assert!(command.as_std().get_args().any(|arg| arg == sdk.join("host.mjs").as_os_str()));
        // A host still running on the earlier SDK keeps its folder.
        assert!(machine.old_sdk("1.2.0").is_file());
        assert_eq!(machine.npm_runs(), 1);
    }

    #[tokio::test]
    async fn a_failed_update_falls_back_to_the_update_message_and_does_not_retry_in_a_loop() {
        let (count, finished) = hook();
        let machine = Machine::new(Some("1.2.0"));
        machine.fail_installs();
        machine.open_gate();
        let first = message(super::super::runtime::probe(&machine.context).await.unwrap_err());
        assert!(first.contains("Updating"), "{first}");
        finished.notified().await;
        let after = message(super::super::runtime::probe(&machine.context).await.unwrap_err());
        assert_eq!(after, super::super::outdated("1.2.0"));
        assert!(after.contains("Update it in Settings → Agent providers"));
        let Some(Update::Failed(details)) = auto_update_state(&machine.context) else { panic!("failure not kept") };
        assert!(details.contains("network request failed"), "{details}");
        // More probes (and the setup status) neither start nor wait on another install.
        for _ in 0..5 {
            assert_eq!(request(&machine.context), Some(Update::Failed(details.clone())));
            super::super::runtime::probe(&machine.context).await.unwrap_err();
        }
        assert_eq!(machine.npm_runs(), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(machine.old_sdk("1.2.0").is_file());
        // The button still works, and clears the failure's effect.
        std::fs::remove_file(machine.home.path().join("fail")).unwrap();
        super::super::runtime::install(&machine.context).await.unwrap();
        assert!(super::super::runtime::installed(&machine.context));
        assert_eq!(request(&machine.context), None);
    }

    #[tokio::test]
    async fn the_update_button_and_the_automatic_update_share_one_install() {
        let (count, finished) = hook();
        let machine = Machine::new(Some("1.2.0"));
        assert_eq!(request(&machine.context), Some(Update::Running));
        let button = tokio::spawn({
            let context = machine.context.clone();
            async move { super::super::runtime::install(&context).await.map_err(message) }
        });
        machine.open_gate();
        finished.notified().await;
        button.await.unwrap().unwrap();
        assert_eq!(machine.npm_runs(), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_update_is_tried_again_after_the_backoff() {
        let (_, finished) = hook();
        let machine = Machine::new(Some("1.2.0"));
        machine.fail_installs();
        machine.open_gate();
        assert_eq!(request(&machine.context), Some(Update::Running));
        finished.notified().await;
        let dir = super::super::runtime::installed_dir(&machine.context).unwrap();
        UPDATES.lock().unwrap().insert(dir, Entry::Failed { at: Instant::now() - RETRY_AFTER, error: "old".into() });
        std::fs::remove_file(machine.home.path().join("fail")).unwrap();
        assert_eq!(request(&machine.context), Some(Update::Running));
        finished.notified().await;
        assert_eq!(machine.npm_runs(), 2);
        assert!(super::super::runtime::installed(&machine.context));
    }
}
