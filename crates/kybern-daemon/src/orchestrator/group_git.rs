//! Git fan-out for group projects. A group thread's git operations run on each
//! included member instead of on `thread.cwd`: checkpoints snapshot every member,
//! rewinds are all-or-nothing, diffs carry the member of each file, and a
//! worktree chat gets a container holding one worktree per member.
use super::*;
use anyhow::ensure;
use futures::{StreamExt, stream};
use std::collections::BTreeMap;

/// Member git operations at a time: git is I/O bound, and big groups must not fork-storm.
const PARALLEL: usize = 4;
/// Instruction files copied into a container without the group folder's own repository.
const SHARED_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", ".claude"];
const SHARED_FILES_CAP: u64 = 5 * 1024 * 1024;
/// `Project.worktree_copy` entries are the user's choice; this only stops a mistake from filling the disk.
const COPY_CAP: u64 = 512 * 1024 * 1024;

/// One repository a thread's git operations run on.
#[derive(Debug, Clone)]
pub(crate) struct RepoTarget {
    /// Member path ("." for the group folder); `None` for a single-repo thread.
    pub repo: Option<String>,
    pub name: String,
    pub dir: PathBuf,
    /// The other members' paths, set for the "." member so the group folder's
    /// repository never snapshots, diffs, restores or cleans them.
    pub exclude: Vec<String>,
}

impl RepoTarget {
    pub fn git(&self) -> Repo {
        Repo::new(&self.dir)
    }

    pub fn repo_path(&self) -> &str {
        self.repo.as_deref().unwrap_or(".")
    }

    /// Whether the checkout is there and still a repository.
    pub fn present(&self) -> bool {
        self.dir.join(".git").exists()
    }
}

/// A deselected member's state at the start of a turn (`check_outside_changes`).
#[derive(Debug, Clone)]
pub(crate) struct OutsideBaseline {
    repo: String,
    name: String,
    source_path: String,
    head: Option<String>,
    status: Vec<String>,
}

pub(crate) fn is_group(thread: &Thread) -> bool {
    !thread.members.is_empty()
}

/// `base` joined with a '/'-separated member path, portably; "." is `base`.
pub(crate) fn member_dir(base: &Path, path: &str) -> PathBuf {
    if path == "." { base.to_path_buf() } else { path.split('/').filter(|c| !c.is_empty()).fold(base.to_path_buf(), |dir, c| dir.join(c)) }
}

/// The repositories a thread's git operations run on: `[thread.cwd]` for a
/// single-repo thread, one per included, available member for a group thread
/// (in project order, primary first).
pub(crate) fn targets(thread: &Thread) -> Vec<RepoTarget> {
    if !is_group(thread) {
        return vec![RepoTarget { repo: None, name: String::new(), dir: PathBuf::from(&thread.cwd), exclude: Vec::new() }];
    }
    let cwd = Path::new(&thread.cwd);
    thread
        .members
        .iter()
        .filter(|m| m.included && !m.missing)
        .map(|m| RepoTarget {
            repo: Some(m.path.clone()),
            name: m.name.clone(),
            dir: member_dir(cwd, &m.path),
            exclude: if m.path == "." { other_member_paths(&thread.members, ".") } else { Vec::new() },
        })
        .collect()
}

fn other_member_paths(members: &[ThreadMember], path: &str) -> Vec<String> {
    members.iter().filter(|m| m.path != path).map(|m| m.path.clone()).collect()
}

/// The target whose folder contains `path` (relative to the thread cwd), and
/// `path` relative to that repository.
pub(crate) fn route_path<'a>(targets: &'a [RepoTarget], path: &str) -> Option<(&'a RepoTarget, String)> {
    let path = path.trim_start_matches("./");
    targets
        .iter()
        .filter_map(|t| {
            let repo = t.repo_path();
            if repo == "." {
                return Some((t, path.to_string(), 0));
            }
            if path == repo {
                return Some((t, String::new(), repo.len()));
            }
            path.strip_prefix(repo).and_then(|rest| rest.strip_prefix('/')).map(|rest| (t, rest.to_string(), repo.len()))
        })
        .max_by_key(|(_, _, len)| *len)
        .map(|(t, rest, _)| (t, rest))
}

/// "api", "api and web", "api, web and infra".
pub(crate) fn join_names<S: AsRef<str>>(names: &[S]) -> String {
    match names {
        [] => String::new(),
        [one] => one.as_ref().to_string(),
        [rest @ .., last] => format!("{} and {}", rest.iter().map(AsRef::as_ref).collect::<Vec<_>>().join(", "), last.as_ref()),
    }
}

/// Split `cap` across members wanting `sizes`: each first gets
/// min(its size, cap / members), then what is left goes to members in order,
/// so a big member never hides a small one.
pub(crate) fn fair_shares(sizes: &[usize], cap: usize) -> Vec<usize> {
    if sizes.is_empty() {
        return Vec::new();
    }
    let even = cap / sizes.len();
    let mut shares: Vec<usize> = sizes.iter().map(|size| (*size).min(even)).collect();
    let mut left = cap - shares.iter().sum::<usize>();
    for (share, size) in shares.iter_mut().zip(sizes) {
        let more = (size - *share).min(left);
        *share += more;
        left -= more;
    }
    shares
}

fn truncate_at_char(value: &mut String, max_bytes: usize) -> bool {
    if value.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    true
}

/// Limits a group diff applies to its total.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DiffCaps {
    pub files: usize,
    pub patch_bytes: usize,
}

impl DiffCaps {
    pub const UNLIMITED_FILES: DiffCaps = DiffCaps { files: usize::MAX, patch_bytes: kybern_git::MAX_PATCH_BYTES };
}

/// One `Diff` for a group thread: member diffs in project order, with each
/// file's `repo` set and its path relative to the thread cwd (`api/src/x.rs`).
/// `path` (relative to the cwd) limits it to the member that contains it.
pub(crate) async fn group_diff(
    store: &Store,
    thread: &Thread,
    turn_id: Option<TurnId>,
    include_patch: bool,
    path: Option<&str>,
    caps: DiffCaps,
) -> Result<Diff> {
    let all = targets(thread);
    let selected: Vec<(RepoTarget, Option<String>)> = match path.filter(|p| !p.is_empty()) {
        Some(path) => {
            let (target, rest) = route_path(&all, path).ok_or_else(|| anyhow!("{path} is not inside a repository of this chat"))?;
            vec![(target.clone(), Some(rest).filter(|r| !r.is_empty()))]
        }
        None => all.iter().cloned().map(|t| (t, None)).collect(),
    };
    let checkpoints = match turn_id {
        Some(turn) => {
            let c = store.checkpoint_get(turn)?.ok_or_else(|| anyhow!("no checkpoint for that turn"))?;
            ensure_thread(&c, thread)?;
            vec![c]
        }
        None => store.checkpoints_for_thread(thread.id)?,
    };
    if checkpoints.is_empty() {
        return Err(anyhow!("thread has no checkpoints yet"));
    }
    let in_progress = turn_id.is_some();
    let diffs: Vec<(RepoTarget, Option<Diff>)> = stream::iter(selected)
        .map(|(target, rest)| {
            let checkpoints = &checkpoints;
            async move {
                let repo = target.repo_path().to_string();
                let Some(entry) = checkpoints.iter().find_map(|c| c.repos.iter().find(|r| r.repo == repo)) else {
                    return (target, None);
                };
                let result = async {
                    ensure!(target.present(), "{} is missing", target.name);
                    let git = target.git();
                    let to = match (in_progress, &entry.after) {
                        (true, Some(after)) => after.clone(),
                        (true, None) => git.snapshot_excluding("kybern diff (in progress)", &target.exclude).await?,
                        (false, _) => git.snapshot_excluding("kybern diff (now)", &target.exclude).await?,
                    };
                    let mut diff = git.diff_prefixed(&entry.before, &to, include_patch, rest.as_deref(), Some(&repo)).await?;
                    for file in &mut diff.files {
                        file.repo = Some(repo.clone());
                    }
                    Ok::<_, anyhow::Error>(diff)
                }
                .await;
                match result {
                    Ok(diff) => (target, Some(diff)),
                    Err(error) => {
                        tracing::warn!(thread_id = %thread.id, repo, %error, "member diff skipped");
                        (target, None)
                    }
                }
            }
        })
        .buffered(PARALLEL)
        .collect()
        .await;
    Ok(merge_diffs(diffs, caps))
}

fn ensure_thread(c: &Checkpoint, thread: &Thread) -> Result<()> {
    if c.thread_id != thread.id {
        return Err(anyhow!("checkpoint belongs to another thread"));
    }
    Ok(())
}

/// Concatenate member diffs under the total caps, split fairly between members.
pub(crate) fn merge_diffs(diffs: Vec<(RepoTarget, Option<Diff>)>, caps: DiffCaps) -> Diff {
    let file_shares = fair_shares(&diffs.iter().map(|(_, d)| d.as_ref().map_or(0, |d| d.files.len())).collect::<Vec<_>>(), caps.files);
    let patch_shares =
        fair_shares(&diffs.iter().map(|(_, d)| d.as_ref().map_or(0, |d| d.patch.len())).collect::<Vec<_>>(), caps.patch_bytes);
    let mut out =
        Diff { from: String::new(), to: String::new(), files: Vec::new(), patch: String::new(), patch_truncated: false, repos: Vec::new() };
    for (((target, diff), file_share), patch_share) in diffs.into_iter().zip(file_shares).zip(patch_shares) {
        let repo = target.repo_path().to_string();
        let Some(mut diff) = diff else {
            out.repos.push(RepoDiff { repo, from: String::new(), to: String::new(), files: 0, additions: 0, deletions: 0 });
            continue;
        };
        if out.from.is_empty() {
            out.from = diff.from.clone();
            out.to = diff.to.clone();
        }
        out.repos.push(RepoDiff {
            repo,
            from: diff.from.clone(),
            to: diff.to.clone(),
            files: diff.files.len() as u32,
            additions: diff.files.iter().map(|f| f.additions).sum(),
            deletions: diff.files.iter().map(|f| f.deletions).sum(),
        });
        if diff.files.len() > file_share {
            diff.files.truncate(file_share);
            out.patch_truncated = true;
        }
        out.files.append(&mut diff.files);
        out.patch_truncated |= diff.patch_truncated | truncate_at_char(&mut diff.patch, patch_share);
        if !diff.patch.is_empty() {
            if !out.patch.is_empty() {
                out.patch.push('\n');
            }
            out.patch.push_str(&diff.patch);
        }
    }
    out
}

impl Orchestrator {
    /// Snapshot every member for a turn (see `checkpoint_locked`). A member that
    /// fails is left out and marks the checkpoint incomplete, so rewinding to
    /// this turn is refused rather than half-done.
    pub(super) async fn group_checkpoint_locked(&self, thread: &Thread, turn_id: TurnId, which: &str) {
        match which {
            "before" => self.record_outside_baseline(thread, turn_id).await,
            _ => self.check_outside_changes(thread, turn_id).await,
        }
        let message = format!("kybern checkpoint {which} for turn {turn_id}");
        let name = checkpoint_ref(&thread.id.to_string(), &turn_id.to_string(), which);
        let results: Vec<(RepoTarget, Result<String>)> = stream::iter(targets(thread))
            .map(|target| {
                let (message, name) = (&message, &name);
                async move {
                    let result = async {
                        ensure!(target.present(), "{} is missing or is no longer a git repository", target.name);
                        let git = target.git();
                        let commit = git.snapshot_excluding(message, &target.exclude).await?;
                        // Pinned in the member's own repository, where the commit lives.
                        git.update_ref(name, &commit).await?;
                        Ok(commit)
                    }
                    .await;
                    (target, result)
                }
            })
            .buffered(PARALLEL)
            .collect()
            .await;
        let mut failed = Vec::new();
        let mut done = Vec::new();
        for (target, result) in results {
            match result {
                Ok(commit) => done.push((target.repo_path().to_string(), commit)),
                Err(error) => {
                    tracing::warn!(thread_id = %thread.id, repo = target.repo_path(), %error, "member checkpoint failed");
                    failed.push(target.name);
                }
            }
        }
        let checkpoint = if which == "before" {
            let Some((_, primary)) = done.first() else { return };
            Checkpoint {
                thread_id: thread.id,
                turn_id,
                before: primary.clone(),
                after: None,
                provider_turn_id: None,
                provider_turn_end: None,
                created_at: Utc::now(),
                repos: done.into_iter().map(|(repo, before)| RepoCheckpoint { repo, before, after: None }).collect(),
                incomplete: !failed.is_empty(),
            }
        } else {
            let Ok(Some(mut c)) = self.inner.store.checkpoint_get(turn_id) else { return };
            // A failed "after" only costs the diff its end point; rewinding needs "before".
            for (repo, after) in done {
                if let Some(entry) = c.repos.iter_mut().find(|r| r.repo == repo) {
                    if entry.before == c.before {
                        c.after = Some(after.clone());
                    }
                    entry.after = Some(after);
                }
            }
            c
        };
        if let Err(e) = self.inner.store.checkpoint_upsert(&checkpoint) {
            tracing::warn!(%e, "store checkpoint");
            return;
        }
        let _ = self.emit(thread.id, Some(turn_id), EventPayload::CheckpointUpdated { checkpoint });
    }

    /// Rewind every member to `checkpoint.before`, or none of them. Called under
    /// the thread's admission gate and checkpoint lock (and `workspace_ops`).
    pub(super) async fn group_restore(&self, thread: &Thread, checkpoint: &Checkpoint) -> Result<()> {
        let targets = targets(thread);
        let mut plan = Vec::new();
        for target in &targets {
            let Some(entry) = checkpoint.repos.iter().find(|r| r.repo == target.repo_path()) else {
                let name = &target.name;
                return Err(anyhow!(
                    "Kybern couldn't snapshot {name} before this turn, so it can't rewind it. Rewind an earlier turn, or restore {name} with Git."
                ));
            };
            plan.push((target, entry.before.clone()));
        }
        // Preflight: nothing changes unless every member can be rewound.
        for (target, before) in &plan {
            ensure!(
                target.present(),
                "Can't rewind: {} is missing or is no longer a git repository. Put it back, or restore the others with Git.",
                target.name
            );
            target
                .git()
                .rev_parse(before)
                .await
                .map_err(|e| anyhow!("Can't rewind: {} no longer has this turn's snapshot ({e}).", target.name))?;
        }
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
        let safety_ref = format!("refs/kybern/{}/revert-{stamp}/safety", thread.id);
        let mut safety = Vec::new();
        for (target, _) in &plan {
            let git = target.git();
            let commit = git
                .snapshot_excluding("kybern rewind safety snapshot", &target.exclude)
                .await
                .map_err(|e| anyhow!("Can't rewind: Kybern couldn't save {} as it is now ({e}). Nothing was changed.", target.name))?;
            git.update_ref(&safety_ref, &commit).await?;
            safety.push(commit);
        }
        for (index, (target, before)) in plan.iter().enumerate() {
            if let Err(error) = target.git().restore_excluding(before, &target.exclude).await {
                let mut put_back = Vec::new();
                for ((done, _), commit) in plan.iter().zip(&safety).take(index + 1) {
                    match done.git().restore_excluding(commit, &done.exclude).await {
                        Ok(()) if done.repo_path() != target.repo_path() => put_back.push(done.name.clone()),
                        Ok(()) => {}
                        Err(e) => tracing::warn!(thread_id = %thread.id, repo = done.repo_path(), %e, "rewind rollback failed"),
                    }
                }
                let restored = if put_back.is_empty() {
                    "Nothing else was changed.".to_string()
                } else {
                    format!(
                        "{} {} put back as {} were.",
                        join_names(&put_back),
                        if put_back.len() == 1 { "was" } else { "were" },
                        if put_back.len() == 1 { "it" } else { "they" }
                    )
                };
                return Err(anyhow!(
                    "Rewind stopped: {error} in {}. {restored} Its state before the rewind is saved at {safety_ref}.",
                    target.name
                ));
            }
        }
        Ok(())
    }

    /// Record each deselected member's HEAD and status when a turn starts.
    async fn record_outside_baseline(&self, thread: &Thread, turn_id: TurnId) {
        let outside: Vec<_> = thread.members.iter().filter(|m| !m.included && !m.missing).cloned().collect();
        if outside.is_empty() {
            return;
        }
        let mut baselines = Vec::new();
        for member in outside {
            let git = Repo::new(&member.source_path);
            let (head, status) = tokio::join!(git.head(), git.status_porcelain(&[]));
            baselines.push(OutsideBaseline {
                repo: member.path,
                name: member.name,
                source_path: member.source_path,
                head,
                status: status.unwrap_or_default(),
            });
        }
        self.inner.outside_baselines.lock().unwrap_or_else(|p| p.into_inner()).insert(turn_id, baselines);
    }

    /// After a turn of a group worktree thread: tell the user which deselected
    /// members' checkouts changed while it ran. Never reverts them.
    async fn check_outside_changes(&self, thread: &Thread, turn_id: TurnId) {
        let Some(baselines) = self.inner.outside_baselines.lock().unwrap_or_else(|p| p.into_inner()).remove(&turn_id) else { return };
        let mut changed = Vec::new();
        for base in baselines {
            let git = Repo::new(&base.source_path);
            let (head, status) = tokio::join!(git.head(), git.status_porcelain(&[]));
            let status = status.unwrap_or_default();
            let head_moved = head != base.head;
            if head_moved || status != base.status {
                changed.push(OutsideRepoChange {
                    repo: base.repo,
                    name: base.name,
                    source_path: base.source_path,
                    dirty_files: status.len() as u32,
                    head_moved,
                });
            }
        }
        if !changed.is_empty() {
            let _ = self.emit(thread.id, Some(turn_id), EventPayload::OutsideRepoChanged { repos: changed });
        }
    }

    pub(super) fn send_workspace_progress(&self, thread_id: ThreadId, done: u32, total: u32, current: Option<String>) {
        // No receivers just means no client is connected.
        let _ = self.inner.workspace_progress.send(methods::ThreadsWorkspaceProgress { thread_id, done, total, current });
    }

    /// Members of a new group thread in local mode: the agent works in the group
    /// folder itself. `base_branches` switches named members' checkouts first,
    /// all or none (a member that can't switch puts the others back).
    pub(super) async fn group_local_members(
        &self,
        project: &Project,
        base_branches: &BTreeMap<String, String>,
    ) -> Result<Vec<ThreadMember>> {
        let mut members = snapshot_members(project);
        for name in base_branches.keys() {
            ensure!(members.iter().any(|m| &m.path == name), "{name} isn't a repository of {}.", project.name);
        }
        let mut switched: Vec<(PathBuf, String)> = Vec::new();
        for member in members.iter().filter(|m| !m.missing) {
            let Some(branch) = base_branches.get(&member.path) else { continue };
            let git = Repo::new(&member.source_path);
            let current = git.current_branch().await;
            if current.as_deref() == Some(branch.as_str()) {
                continue;
            }
            if let Err(error) = git.switch(branch).await {
                for (dir, previous) in switched.iter().rev() {
                    if let Err(e) = Repo::new(dir).switch(previous).await {
                        tracing::warn!(dir = %dir.display(), %e, "could not switch a member back");
                    }
                }
                let reason = if git.is_clean().await.unwrap_or(true) {
                    format!("Kybern couldn't switch {} to {branch}: {error}", member.name)
                } else {
                    format!(
                        "{} has uncommitted changes, so Kybern can't switch it to {branch}. Commit or stash them, or keep its current branch.",
                        member.name
                    )
                };
                return Err(anyhow!(reason));
            }
            if let Some(previous) = current {
                switched.push((PathBuf::from(&member.source_path), previous));
            }
        }
        for member in members.iter_mut().filter(|m| !m.missing) {
            let git = Repo::new(&member.source_path);
            member.base_branch = git.current_branch().await;
            member.base_commit = git.head().await;
        }
        Ok(members)
    }

    /// Worktree mode: a container `<worktrees>/<project>/<thread-id>` with one
    /// worktree per included member on `kybern/<thread-id>`, at the member's
    /// path. `include` omitted means every member; `starts` gives a member's
    /// fork point (a branch or commit; its HEAD otherwise). On any failure
    /// everything created so far is removed.
    pub(super) async fn create_group_workspace(
        &self,
        project: &Project,
        thread_id: ThreadId,
        include: Option<&[String]>,
        starts: &BTreeMap<String, String>,
    ) -> Result<(WorktreeInfo, Vec<ThreadMember>)> {
        let mut members = snapshot_members(project);
        if let Some(include) = include {
            for path in include {
                ensure!(members.iter().any(|m| &m.path == path), "{path} isn't a repository of {}.", project.name);
            }
            for member in &mut members {
                member.included &= include.contains(&member.path);
            }
        }
        ensure!(members.iter().any(|m| m.included), "Choose at least one available repository for this chat.");
        let id = thread_id.to_string();
        let branch = format!("kybern/{id}");
        let container = self.worktree_dir(project, &id);
        ensure!(!container.exists(), "{} already exists. Remove it, or start the chat again.", container.display());
        std::fs::create_dir_all(container.parent().unwrap())?;
        let source = PathBuf::from(&project.path);
        let total = members.iter().filter(|m| m.included).count() as u32;
        let mut created: Vec<(PathBuf, PathBuf)> = Vec::new();
        let result = async {
            let mut done = 0;
            // The group folder's own worktree must come first: `git worktree add` needs a missing or empty folder.
            let ordered: Vec<usize> = (0..members.len())
                .filter(|i| members[*i].included && members[*i].path == ".")
                .chain((0..members.len()).filter(|i| members[*i].included && members[*i].path != "."))
                .collect();
            if !ordered.iter().any(|i| members[*i].path == ".") {
                std::fs::create_dir_all(&container)?;
                copy_entries(&source, &container, &SHARED_FILES, SHARED_FILES_CAP);
            }
            for index in ordered {
                let member = &mut members[index];
                self.send_workspace_progress(thread_id, done, total, Some(member.path.clone()));
                let repo_dir = PathBuf::from(&member.source_path);
                let target = member_dir(&container, &member.path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let git = Repo::new(&repo_dir);
                let start = starts.get(&member.path).cloned();
                git.worktree_add(&target, &branch, start.as_deref())
                    .await
                    .map_err(|e| anyhow!("Couldn't create a worktree for {}: {e}", member.name))?;
                created.push((repo_dir, target.clone()));
                let tree = Repo::new(&target);
                member.base_commit = tree.head().await;
                member.base_branch = match start {
                    Some(start) if git.rev_parse(&format!("refs/heads/{start}")).await.is_ok() => Some(start),
                    _ => git.current_branch().await,
                };
                member.worktree = Some(WorktreeInfo { path: target.to_string_lossy().into_owned(), branch: branch.clone() });
                done += 1;
            }
            let copy: Vec<&str> = project
                .worktree_copy
                .iter()
                .map(String::as_str)
                .filter(|entry| {
                    is_copy_entry(entry) && !members.iter().any(|m| m.path == *entry || m.path.starts_with(&format!("{entry}/")))
                })
                .collect();
            copy_entries(&source, &container, &copy, COPY_CAP);
            self.send_workspace_progress(thread_id, done, total, None);
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            // Member worktrees live inside the group folder's worktree, so remove them first.
            for (repo, tree) in created.iter().rev() {
                let git = Repo::new(repo);
                if let Err(e) = git.worktree_remove(tree, true).await {
                    tracing::warn!(tree = %tree.display(), %e, "rollback: could not remove a member worktree");
                }
                let _ = git.delete_branch(&branch, true).await;
            }
            let _ = std::fs::remove_dir_all(&container);
            self.send_workspace_progress(thread_id, 0, total, None);
            return Err(error);
        }
        Ok((WorktreeInfo { path: container.to_string_lossy().into_owned(), branch }, members))
    }
}

/// The project's members as a new thread records them: every available member
/// included, a missing one recorded as unavailable.
pub(crate) fn snapshot_members(project: &Project) -> Vec<ThreadMember> {
    let folder = Path::new(&project.path);
    project
        .members
        .iter()
        .map(|m| {
            let source = member_dir(folder, &m.path);
            // Probe live: the cached status may be older than the folder.
            let available = source.join(".git").exists();
            ThreadMember {
                path: m.path.clone(),
                name: m.name.clone(),
                included: available,
                source_path: source.to_string_lossy().into_owned(),
                worktree: None,
                base_branch: None,
                base_commit: None,
                worktree_state: None,
                missing: !available,
            }
        })
        .collect()
}

/// A top-level entry name of the group folder (no separators, `..` or `.git`).
fn is_copy_entry(entry: &str) -> bool {
    !entry.is_empty() && entry != "." && entry != ".." && entry != ".git" && !entry.contains(['/', '\\'])
}

/// Copy top-level `entries` of `from` into `to`: regular files and folders
/// recursively, symlinks skipped (never followed or recreated), existing files
/// kept, at most `cap` bytes. Missing entries are skipped. `std::fs::copy`
/// only, so it works the same on every platform.
pub(crate) fn copy_entries(from: &Path, to: &Path, entries: &[&str], cap: u64) {
    let mut budget = cap;
    for entry in entries {
        let source = from.join(entry);
        let Ok(meta) = std::fs::symlink_metadata(&source) else { continue };
        if let Err(error) = copy_tree(&source, &to.join(entry), &meta, &mut budget) {
            tracing::warn!(entry, %error, "could not copy into the worktree folder");
        }
    }
}

fn copy_tree(source: &Path, target: &Path, meta: &std::fs::Metadata, budget: &mut u64) -> std::io::Result<()> {
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(target)?;
        for child in std::fs::read_dir(source)? {
            let child = child?;
            let meta = std::fs::symlink_metadata(child.path())?;
            copy_tree(&child.path(), &target.join(child.file_name()), &meta, budget)?;
        }
        return Ok(());
    }
    if !meta.is_file() || target.exists() {
        return Ok(());
    }
    if meta.len() > *budget {
        tracing::warn!(path = %source.display(), "skipped copying into the worktree folder: over the size limit");
        return Ok(());
    }
    *budget -= meta.len();
    std::fs::copy(source, target).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(repo: &str) -> RepoTarget {
        RepoTarget { repo: Some(repo.into()), name: repo.into(), dir: PathBuf::from("/x").join(repo), exclude: Vec::new() }
    }

    #[test]
    fn fair_shares_never_let_a_big_member_hide_a_small_one() {
        assert_eq!(fair_shares(&[1000, 10, 0], 300), [290, 10, 0]);
        assert_eq!(fair_shares(&[1000, 1000], 300), [150, 150]);
        assert_eq!(fair_shares(&[10, 20], 300), [10, 20]);
        assert_eq!(fair_shares(&[500, 500, 500], 10), [4, 3, 3]);
        assert!(fair_shares(&[], 10).is_empty());
    }

    #[test]
    fn paths_route_to_the_deepest_member_and_the_folder_takes_the_rest() {
        let targets = vec![target("."), target("api"), target("services/api")];
        let (t, rest) = route_path(&targets, "services/api/src/x.rs").unwrap();
        assert_eq!((t.repo_path(), rest.as_str()), ("services/api", "src/x.rs"));
        let (t, rest) = route_path(&targets, "api").unwrap();
        assert_eq!((t.repo_path(), rest.as_str()), ("api", ""));
        let (t, rest) = route_path(&targets, "apixyz/a").unwrap();
        assert_eq!((t.repo_path(), rest.as_str()), (".", "apixyz/a"));
        assert!(route_path(&targets[1..], "web/a").is_none());
    }

    #[test]
    fn merged_diffs_cap_the_total_fairly_and_list_unchanged_members() {
        let file = |path: &str| FileChange {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            additions: 1,
            deletions: 0,
            binary: false,
            repo: None,
        };
        let big = Diff {
            from: "a1".into(),
            to: "a2".into(),
            files: (0..10).map(|i| file(&format!("api/{i}"))).collect(),
            patch: "x".repeat(100),
            patch_truncated: false,
            repos: Vec::new(),
        };
        let small = Diff {
            from: "w1".into(),
            to: "w2".into(),
            files: vec![file("web/a")],
            patch: "y".repeat(5),
            patch_truncated: false,
            repos: Vec::new(),
        };
        let merged = merge_diffs(
            vec![(target("api"), Some(big)), (target("web"), Some(small)), (target("infra"), None)],
            DiffCaps { files: 4, patch_bytes: 20 },
        );
        assert_eq!(merged.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["api/0", "api/1", "api/2", "web/a"]);
        assert!(merged.patch.ends_with(&format!("\n{}", "y".repeat(5))));
        assert_eq!(merged.patch.len(), 15 + 1 + 5);
        assert!(merged.patch_truncated);
        assert_eq!((merged.from.as_str(), merged.to.as_str()), ("a1", "a2"));
        let rows: Vec<_> = merged.repos.iter().map(|r| (r.repo.as_str(), r.files)).collect();
        assert_eq!(rows, [("api", 10), ("web", 1), ("infra", 0)]);
    }

    #[test]
    fn names_join_like_a_sentence() {
        assert_eq!(join_names(&["api"]), "api");
        assert_eq!(join_names(&["api", "web"]), "api and web");
        assert_eq!(join_names(&["api", "web", "infra"]), "api, web and infra");
    }

    #[test]
    fn copying_skips_symlinks_missing_entries_and_existing_files() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        std::fs::write(from.path().join("AGENTS.md"), "shared").unwrap();
        std::fs::create_dir_all(from.path().join(".claude/commands")).unwrap();
        std::fs::write(from.path().join(".claude/settings.local.json"), "{}").unwrap();
        std::fs::write(from.path().join(".claude/commands/go.md"), "go").unwrap();
        std::fs::write(to.path().join("CLAUDE.md"), "kept").unwrap();
        std::fs::write(from.path().join("CLAUDE.md"), "@AGENTS.md").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", from.path().join(".claude/link")).unwrap();
        copy_entries(from.path(), to.path(), &SHARED_FILES, SHARED_FILES_CAP);
        assert_eq!(std::fs::read_to_string(to.path().join("AGENTS.md")).unwrap(), "shared");
        assert_eq!(std::fs::read_to_string(to.path().join("CLAUDE.md")).unwrap(), "kept");
        assert!(to.path().join(".claude/settings.local.json").exists());
        assert!(to.path().join(".claude/commands/go.md").exists());
        assert!(std::fs::symlink_metadata(to.path().join(".claude/link")).is_err());
        assert!(is_copy_entry("Makefile") && !is_copy_entry("../x") && !is_copy_entry("a/b") && !is_copy_entry(".git"));
    }
}
