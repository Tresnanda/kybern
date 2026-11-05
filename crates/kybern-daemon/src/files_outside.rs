//! Files a conversation links outside its workspace: an agent's scratchpad, `/tmp`, another repository.
//!
//! `threads.files.read` refuses them by default. The desktop app on the daemon's own machine can allow one file for
//! now ("Open once") or its folder for good ("Always allow this folder"). Folders go in the same list as the Preview
//! panel's grants (`Settings.preview_allowed_folders`) and follow the same rules (`GrantPolicy`): never `/`, the home
//! directory, system folders or the data directory. A file opens read-only through `threads.files.read` only: the
//! write methods keep refusing everything outside the workspace. Every other client (mobile, another machine) opens
//! only files in folders that were allowed, and cannot allow anything itself.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Result, bail};
use kybern_protocol::methods::{FilesReadResult, OutsideAllow, OutsideVerdict, ThreadFileOutsideParams, ThreadFileOutsideResult};
use kybern_protocol::{Thread, ThreadId};

use crate::files::{self, Reference};
use crate::previews::{GrantPolicy, persist_grant, valid_grants_by};

/// Files opened once that the daemon remembers at most; the oldest is forgotten first.
const MAX_ONCE: usize = 256;

/// Files the desktop user opened once, per conversation. Memory only: a restart forgets them.
#[derive(Default)]
pub struct OnceFiles(Mutex<VecDeque<(ThreadId, PathBuf)>>);

impl OnceFiles {
    pub fn allow(&self, thread: ThreadId, file: PathBuf) {
        let Ok(mut files) = self.0.lock() else { return };
        if files.iter().any(|(id, path)| *id == thread && *path == file) {
            return;
        }
        files.push_back((thread, file));
        if files.len() > MAX_ONCE {
            files.pop_front();
        }
    }

    fn of(&self, thread: ThreadId) -> Vec<PathBuf> {
        self.0.lock().map(|files| files.iter().filter(|(id, _)| *id == thread).map(|(_, path)| path.clone()).collect()).unwrap_or_default()
    }
}

/// What a read may open outside the workspace: files allowed once, and files in allowed folders.
#[derive(Debug, Default)]
pub struct OutsideAccess {
    folders: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

impl OutsideAccess {
    /// Nothing outside the workspace opens.
    #[cfg(test)]
    pub fn none() -> Self {
        Self::default()
    }

    pub fn new(allowed_folders: &[String], once: Vec<PathBuf>, policy: &GrantPolicy) -> Self {
        let files = once.into_iter().filter(|file| closed_reason(policy, file).is_none()).collect();
        Self { folders: valid_grants_by(allowed_folders, |folder| policy.file_grantable(folder)), files }
    }

    /// Whether `file` (canonical) opens read-only. Credentials and env files stay closed in an allowed folder too.
    pub fn allows(&self, file: &Path) -> bool {
        let allowed = self.files.iter().any(|once| once == file) || self.folders.iter().any(|folder| file.starts_with(folder));
        allowed && refusal_of(file).is_none()
    }
}

/// What a client may read outside the workspace of `thread`: allowed folders for everyone, files opened once only
/// for the desktop app that opened them.
pub fn access(state: &crate::state::AppState, thread: ThreadId, local: bool) -> OutsideAccess {
    let policy = GrantPolicy::new(&state.paths.root);
    let once = if local { state.file_once.of(thread) } else { Vec::new() };
    OutsideAccess::new(&state.settings.get().preview_allowed_folders, once, &policy)
}

fn refusal_of(file: &Path) -> Option<String> {
    let parts: Vec<String> = file
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    files::refusal(&parts.iter().map(String::as_str).collect::<Vec<_>>())
}

const CLOSED: &str = "Kybern doesn't open files from this folder. Open it in your own editor if you need it.";

/// Why this file never opens, whoever allows it: credentials and env files, the data directory and system folders.
fn closed_reason(policy: &GrantPolicy, file: &Path) -> Option<String> {
    if let Some(reason) = refusal_of(file) {
        return Some(reason);
    }
    let system = policy.system.iter().any(|folder| file.starts_with(folder)) && !policy.in_temp(file);
    let library = policy.home.as_ref().is_some_and(|home| file.starts_with(home.join("Library")));
    (system || library || file.starts_with(&policy.data_dir)).then(|| CLOSED.to_string())
}

/// How a file outside the workspace stands for the client asking.
#[derive(Debug, PartialEq, Eq)]
pub struct Assessment {
    pub verdict: OutsideVerdict,
    /// The folder "Always allow" would add.
    pub folder: Option<PathBuf>,
    pub scratch: bool,
    pub reason: Option<String>,
}

const REMOTE: &str = "This file is outside the conversation's workspace. Open it in Kybern on the computer it is on.";

/// `file` is canonical. `can_allow`: the client is the desktop app on this machine, which alone may allow a file.
pub fn assess(file: &Path, policy: &GrantPolicy, access: &OutsideAccess, can_allow: bool) -> Assessment {
    let scratch = policy.in_temp(file);
    if let Some(reason) = closed_reason(policy, file) {
        return Assessment { verdict: OutsideVerdict::Refused, folder: None, scratch, reason: Some(reason) };
    }
    let folder = file.parent().filter(|folder| policy.file_grantable(folder)).map(Path::to_path_buf);
    let (verdict, reason) = if access.allows(file) {
        (OutsideVerdict::Open, None)
    } else if can_allow {
        (OutsideVerdict::Ask, None)
    } else {
        (OutsideVerdict::Refused, Some(REMOTE.to_string()))
    };
    Assessment { verdict, folder, scratch, reason }
}

/// `threads.files.outside`: whether a link opens, and, for the desktop app, allowing it first.
pub async fn outside(
    state: &crate::state::AppState,
    local: bool,
    thread: &Thread,
    params: &ThreadFileOutsideParams,
) -> Result<ThreadFileOutsideResult> {
    let cwd = Path::new(&thread.cwd);
    let root = tokio::fs::canonicalize(cwd).await?;
    let file = match files::resolve_reference(&state.file_indexes, cwd, &root, &mut None, &params.path).await? {
        Reference::Outside(file) => file,
        Reference::Found(relative) => {
            return Ok(ThreadFileOutsideResult {
                verdict: OutsideVerdict::Open,
                path: relative,
                folder: None,
                scratch: false,
                reason: None,
            });
        }
        other => return Err(files::reference_error(other)),
    };
    let policy = GrantPolicy::new(&state.paths.root);
    let mut now = assess(&file, &policy, &access(state, thread.id, local), local);
    if params.allow != OutsideAllow::Check {
        if !local {
            bail!("Only Kybern on this computer can allow a file outside the workspace.");
        }
        if now.verdict == OutsideVerdict::Refused {
            bail!(now.reason.unwrap_or_else(|| CLOSED.to_string()));
        }
        match params.allow {
            OutsideAllow::Once => state.file_once.allow(thread.id, file.clone()),
            OutsideAllow::Folder => match &now.folder {
                Some(folder) => persist_grant(&state.settings, folder)?,
                None => bail!("Kybern can't allow this folder for good. Open the file once instead."),
            },
            OutsideAllow::Check => {}
        }
        now = assess(&file, &policy, &access(state, thread.id, local), local);
    }
    // A refused file is not described further: where a link leads is not for a client that cannot open it.
    let refused = now.verdict == OutsideVerdict::Refused;
    Ok(ThreadFileOutsideResult {
        verdict: now.verdict,
        path: if refused { String::new() } else { display_path(&file) },
        folder: now.folder.filter(|_| !refused).map(|folder| display_path(&folder)),
        scratch: now.scratch && !refused,
        reason: now.reason,
    })
}

/// A canonical path as the user reads it: Windows' verbatim `\\?\C:\…` form without its prefix (`\\?\UNC\…` stays as it is).
pub(crate) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => text.into_owned(),
    }
}

/// Read an allowed file outside the workspace. The result says it is read-only.
pub async fn read_outside(file: &Path, max_bytes: u64, if_version: Option<&str>) -> Result<FilesReadResult> {
    let (Some(folder), Some(name)) = (file.parent(), file.file_name().and_then(|name| name.to_str())) else {
        bail!("File not found. Check the path or ask the agent to recreate it.");
    };
    let mut read = files::read_file(folder, name, max_bytes, if_version).await?;
    read.read_only = true;
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch {
        base: PathBuf,
    }
    impl Scratch {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("kybern-outside-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&base).unwrap();
            Self { base: base.canonicalize().unwrap() }
        }
        fn file(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.base.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path.canonicalize().unwrap()
        }
        /// Home, data directory and "system" folder inside the scratch folder; the scratch folder itself is the temp root.
        fn policy(&self) -> GrantPolicy {
            GrantPolicy {
                home: Some(self.base.join("home")),
                data_dir: self.base.join("home/.kybern"),
                system: vec![self.base.join("sys")],
                temp: vec![self.base.join("tmp")],
            }
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn access(policy: &GrantPolicy, folders: &[&Path], once: &[&Path]) -> OutsideAccess {
        let folders: Vec<String> = folders.iter().map(|folder| folder.to_string_lossy().into_owned()).collect();
        OutsideAccess::new(&folders, once.iter().map(|file| file.to_path_buf()).collect(), policy)
    }

    #[test]
    fn a_file_outside_asks_the_desktop_and_refuses_everyone_else() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let file = dir.file("elsewhere/notes.md", "# notes");
        let ask = assess(&file, &policy, &access(&policy, &[], &[]), true);
        assert_eq!(ask.verdict, OutsideVerdict::Ask);
        assert_eq!(ask.folder.as_deref(), file.parent());
        assert!(!ask.scratch);
        let remote = assess(&file, &policy, &access(&policy, &[], &[]), false);
        assert_eq!(remote.verdict, OutsideVerdict::Refused);
        assert!(remote.reason.unwrap().contains("outside the conversation's workspace"));
    }

    #[test]
    fn a_file_opened_once_opens_for_that_file_only() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let file = dir.file("elsewhere/a.txt", "a");
        let sibling = dir.file("elsewhere/b.txt", "b");
        let once = access(&policy, &[], &[&file]);
        assert!(once.allows(&file));
        assert!(!once.allows(&sibling));
        assert_eq!(assess(&file, &policy, &once, true).verdict, OutsideVerdict::Open);
        assert_eq!(assess(&sibling, &policy, &once, true).verdict, OutsideVerdict::Ask);
    }

    #[test]
    fn an_allowed_folder_opens_its_files_for_every_client_and_is_reused() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let file = dir.file("elsewhere/deep/a.txt", "a");
        let other = dir.file("different/b.txt", "b");
        let granted = access(&policy, &[file.parent().unwrap().parent().unwrap()], &[]);
        for local in [true, false] {
            assert_eq!(assess(&file, &policy, &granted, local).verdict, OutsideVerdict::Open, "local={local}");
            assert_eq!(assess(&other, &policy, &granted, local).verdict, if local { OutsideVerdict::Ask } else { OutsideVerdict::Refused });
        }
    }

    #[test]
    fn folders_that_cover_everything_are_never_allowed_for_good() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let home_file = dir.file("home/notes.md", "n");
        // The folder is the home directory itself: the file may open once, but its folder is not offered.
        let in_home = assess(&home_file, &policy, &access(&policy, &[], &[]), true);
        assert_eq!(in_home.verdict, OutsideVerdict::Ask);
        assert_eq!(in_home.folder, None);
        // A stored grant on the home directory, the data directory or a parent of both is ignored on read.
        let data_file = dir.file("home/.kybern/daemon.token", "secret");
        let stored = access(&policy, &[&dir.base, dir.base.join("home").as_path(), dir.base.join("home/.kybern").as_path()], &[&data_file]);
        assert!(!stored.allows(&home_file));
        assert!(!stored.allows(&data_file));
        assert_eq!(assess(&data_file, &policy, &stored, true).verdict, OutsideVerdict::Refused);
    }

    #[test]
    fn system_folders_and_credentials_never_open() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let system = dir.file("sys/etc/hosts", "h");
        let key = dir.file("elsewhere/.ssh/id_ed25519", "k");
        let env = dir.file("elsewhere/.env", "TOKEN=1");
        for file in [&system, &key, &env] {
            let verdict = assess(file, &policy, &access(&policy, &[], &[]), true);
            assert_eq!(verdict.verdict, OutsideVerdict::Refused, "{file:?}");
            assert!(verdict.reason.is_some());
            assert!(!access(&policy, &[file.parent().unwrap()], &[file]).allows(file), "{file:?}");
        }
    }

    #[test]
    fn a_scratch_folder_can_be_allowed_but_the_temp_root_cannot() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let scratch = dir.file("tmp/claude-1/session/scratchpad/plan.md", "p");
        let loose = dir.file("tmp/loose.txt", "l");
        let hidden = dir.file("tmp/.cache/x.txt", "x");
        let asked = assess(&scratch, &policy, &access(&policy, &[], &[]), true);
        assert!(asked.scratch);
        assert_eq!(asked.folder.as_deref(), scratch.parent());
        let root_file = assess(&loose, &policy, &access(&policy, &[], &[]), true);
        assert!(root_file.scratch);
        assert_eq!(root_file.folder, None, "the temporary folder itself is not offered");
        assert_eq!(assess(&hidden, &policy, &access(&policy, &[], &[]), true).folder, None);
    }

    #[test]
    fn temporary_folders_under_a_system_path_still_open() {
        let dir = Scratch::new();
        // macOS: the temporary folder sits under `/private/var`, which is a system folder.
        let policy = GrantPolicy { system: vec![dir.base.join("tmp")], ..dir.policy() };
        let scratch = dir.file("tmp/claude-1/session/scratchpad/plan.md", "p");
        let asked = assess(&scratch, &policy, &access(&policy, &[], &[]), true);
        assert_eq!(asked.verdict, OutsideVerdict::Ask);
        assert!(asked.folder.is_some());
        let outside_temp = dir.file("tmp2/x.txt", "x");
        assert_eq!(assess(&outside_temp, &policy, &access(&policy, &[], &[]), true).verdict, OutsideVerdict::Ask);
    }

    #[test]
    fn windows_verbatim_prefixes_are_not_shown_to_the_user() {
        assert_eq!(display_path(Path::new(r"\\?\D:\work\plan.md")), r"D:\work\plan.md");
        assert_eq!(display_path(Path::new(r"\\?\UNC\host\share\plan.md")), r"\\?\UNC\host\share\plan.md");
        assert_eq!(display_path(Path::new("/tmp/plan.md")), "/tmp/plan.md");
    }

    #[test]
    fn once_files_are_remembered_per_conversation_and_bounded() {
        let once = OnceFiles::default();
        let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        once.allow(a, PathBuf::from("/x/one"));
        once.allow(a, PathBuf::from("/x/one"));
        once.allow(b, PathBuf::from("/x/two"));
        assert_eq!(once.of(a), vec![PathBuf::from("/x/one")]);
        for n in 0..MAX_ONCE {
            once.allow(b, PathBuf::from(format!("/y/{n}")));
        }
        assert_eq!(once.of(a), Vec::<PathBuf>::new(), "the oldest entry was forgotten");
        assert_eq!(once.of(b).len(), MAX_ONCE);
    }

    #[tokio::test]
    async fn an_allowed_file_reads_read_only_and_the_old_refusal_stands_without_a_grant() {
        let dir = Scratch::new();
        let policy = dir.policy();
        let workspace = dir.base.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let file = dir.file("elsewhere/plan.md", "# plan");
        let indexes = files::FileIndexCache::default();
        let source = file.to_string_lossy().into_owned();
        let denied = files::read_thread_file(&indexes, &workspace, &source, 1024, None, &OutsideAccess::none()).await.unwrap_err();
        assert!(denied.to_string().contains("outside the conversation's workspace"), "{denied}");
        let allowed = access(&policy, &[], &[&file]);
        let read = files::read_thread_file(&indexes, &workspace, &format!("{source}#L1"), 1024, None, &allowed).await.unwrap();
        assert_eq!(read.content, "# plan");
        assert!(read.read_only);
        // A relative path out of the workspace reaches the same file, and the same grant.
        let relative = files::read_thread_file(&indexes, &workspace, "../elsewhere/plan.md", 1024, None, &allowed).await.unwrap();
        assert!(relative.read_only);
        // Nothing writes through the thread's file methods: they only know the workspace.
        let write = files::write_thread_file(&workspace, &source, "changed".into(), None).await.unwrap_err();
        assert!(write.to_string().contains("outside the conversation's workspace"), "{write}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# plan");
        // A workspace file is not read-only.
        std::fs::write(workspace.join("a.txt"), "a").unwrap();
        let inside = files::read_thread_file(&indexes, &workspace, "a.txt", 1024, None, &allowed).await.unwrap();
        assert!(!inside.read_only);
    }
}
