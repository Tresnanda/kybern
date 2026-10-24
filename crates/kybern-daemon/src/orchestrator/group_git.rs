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
                let restored = match put_back.len() {
                    0 => "Nothing else was changed.".to_string(),
                    1 => format!("{} was put back as it was.", put_back[0]),
                    _ => format!("{} were put back as they were.", join_names(&put_back)),
                };
                // Git's first line names the problem; the rest is advice for its own CLI.
                let error = error.to_string();
                let error = error.lines().next().unwrap_or_default().trim_end_matches('.');
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
    /// worktree per included member of `members` on `kybern/<thread-id>`, at the
    /// member's path, added from its `source_path`. `starts` gives a member's
    /// fork point (a branch or commit; its HEAD otherwise). On any failure
    /// everything created so far is removed.
    pub(super) async fn create_group_workspace(
        &self,
        project: &Project,
        thread_id: ThreadId,
        mut members: Vec<ThreadMember>,
        starts: &BTreeMap<String, String>,
    ) -> Result<(WorktreeInfo, Vec<ThreadMember>)> {
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

/// The project's members for a new worktree chat: `include` (paths) or all.
pub(crate) fn select_members(project: &Project, include: Option<&[String]>) -> Result<Vec<ThreadMember>> {
    let mut members = snapshot_members(project);
    if let Some(include) = include {
        for path in include {
            ensure!(members.iter().any(|m| &m.path == path), "{path} isn't a repository of {}.", project.name);
        }
        for member in &mut members {
            member.included &= include.contains(&member.path);
        }
    }
    Ok(members)
}

/// A group parent's members as its worktree child starts them: the parent's
/// included members, without the parent's worktrees.
pub(crate) fn child_members(parent: &Thread) -> Vec<ThreadMember> {
    parent
        .members
        .iter()
        .cloned()
        .map(|mut m| {
            m.included &= !m.missing && Path::new(&m.source_path).join(".git").exists();
            m.worktree = None;
            m.worktree_state = None;
            m.base_branch = None;
            m.base_commit = None;
            m
        })
        .collect()
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

/// A group container's cleanup state, aggregated over its member worktrees.
pub(super) struct ContainerState {
    pub clean: bool,
    pub merged: bool,
    pub ignored_files: u32,
    pub blockers: Vec<String>,
}

/// One member worktree's recovery refs, written before it is removed.
pub(super) struct SavedMember {
    source: PathBuf,
    tree: PathBuf,
    folder: bool,
    commit: String,
}

/// Members with a worktree in the container, in project order (the group folder's first).
fn container_members(thread: &Thread) -> Vec<&ThreadMember> {
    thread.members.iter().filter(|m| m.included && m.worktree.is_some()).collect()
}

/// What Kybern itself put in the container besides worktrees.
fn copied_entries(project: &Project) -> Vec<String> {
    SHARED_FILES.iter().map(|e| e.to_string()).chain(project.worktree_copy.iter().filter(|e| is_copy_entry(e)).cloned()).collect()
}

/// Porcelain lines of a member worktree, without the nested members of the
/// group folder's worktree and without the untracked copies Kybern made there.
async fn member_status(member: &ThreadMember, thread: &Thread, copied: &[String]) -> Result<Vec<String>> {
    let tree = Repo::new(&member.worktree.as_ref().unwrap().path);
    if member.path != "." {
        return tree.status_porcelain(&[]).await;
    }
    let lines = tree.status_porcelain(&other_member_paths(&thread.members, ".")).await?;
    Ok(lines
        .into_iter()
        .filter(|line| !line.strip_prefix("?? ").is_some_and(|path| copied.iter().any(|c| path.trim_end_matches('/') == c)))
        .collect())
}

impl Orchestrator {
    /// Inspect a group container: every member worktree must be clean, on its
    /// branch and merged for automatic cleanup. Blockers name the member.
    pub(super) async fn inspect_container(&self, thread: &Thread, project: &Project) -> Result<ContainerState> {
        let copied = copied_entries(project);
        let container = PathBuf::from(&thread.cwd);
        let mut state = ContainerState { clean: true, merged: true, ignored_files: 0, blockers: Vec::new() };
        for member in container_members(thread) {
            let wt = member.worktree.as_ref().unwrap();
            let source = Repo::new(&member.source_path);
            if !source.is_ancestor(&wt.branch, "HEAD").await.unwrap_or(false) {
                state.merged = false;
            }
            let tree_dir = Path::new(&wt.path);
            if !tree_dir.exists() {
                continue;
            }
            let common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
            let source_common = crate::github::run(Path::new(&member.source_path), "git", &common).await?;
            let tree_common = crate::github::run(tree_dir, "git", &common).await?;
            ensure!(
                std::fs::canonicalize(source_common)? == std::fs::canonicalize(tree_common)?,
                "{} in this worktree belongs to another repository. Inspect it with Git before cleanup.",
                member.name
            );
            let tree = Repo::new(tree_dir);
            if tree.current_branch().await.as_deref() != Some(wt.branch.as_str()) {
                state.blockers.push(format!(
                    "{}: the checked-out branch changed outside Kybern. Restore the conversation’s branch before cleanup.",
                    member.name
                ));
            }
            let dirty = member_status(member, thread, &copied).await?.len();
            if dirty > 0 {
                state.clean = false;
            }
            let mut args = vec!["ls-files".to_string(), "--others".into(), "--ignored".into(), "--exclude-standard".into(), "-z".into()];
            if member.path == "." {
                args.extend(["--".into(), ".".into()]);
                args.extend(kybern_git::exclude_pathspecs(&other_member_paths(&thread.members, ".")));
            }
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let ignored = crate::github::run(tree_dir, "git", &args).await?;
            let count = ignored.bytes().filter(|b| *b == 0).count() as u32;
            if count > 0 {
                state
                    .blockers
                    .push(format!("{}: move or delete ignored files (including build output) before removing this worktree.", member.name));
            }
            state.ignored_files += count;
        }
        // Without the group folder's own worktree the container is a plain folder:
        // anything there besides member worktrees and Kybern's copies would be lost.
        if !thread.members.iter().any(|m| m.path == "." && m.included) && container.is_dir() {
            let tops: HashSet<String> =
                thread.members.iter().filter(|m| m.included).filter_map(|m| m.path.split('/').next().map(str::to_string)).collect();
            let mut stray: Vec<String> = std::fs::read_dir(&container)?
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| !tops.contains(name) && !copied.contains(name))
                .collect();
            stray.sort();
            if !stray.is_empty() {
                state.clean = false;
                state.blockers.push(format!(
                    "Move or delete {} from this chat’s folder first: they are outside every repository, so Kybern can’t keep them.",
                    join_names(&stray)
                ));
            }
        }
        Ok(state)
    }

    /// Write each member's recovery refs (`refs/kybern/worktree-recovery/<id>/{head,source}`
    /// in that member's repository) before its worktree is removed.
    pub(super) async fn save_container_recovery(&self, thread: &Thread, project: &Project) -> Result<Vec<SavedMember>> {
        let copied = copied_entries(project);
        let mut saved = Vec::new();
        for member in container_members(thread) {
            let tree_dir = PathBuf::from(&member.worktree.as_ref().unwrap().path);
            if !tree_dir.exists() {
                continue;
            }
            let tree = Repo::new(&tree_dir);
            let head = tree.rev_parse("HEAD").await?;
            let clean = member_status(member, thread, &copied).await?.is_empty();
            let exclude = if member.path == "." { other_member_paths(&thread.members, ".") } else { Vec::new() };
            let commit = if clean { head.clone() } else { tree.snapshot_excluding("Kybern worktree cleanup recovery", &exclude).await? };
            let source = Repo::new(&member.source_path);
            source.update_ref(&format!("{}/head", super::worktrees::recovery_ref(thread.id)), &head).await?;
            source.update_ref(&format!("{}/source", super::worktrees::recovery_ref(thread.id)), &commit).await?;
            saved.push(SavedMember { source: PathBuf::from(&member.source_path), tree: tree_dir, folder: member.path == ".", commit });
        }
        Ok(saved)
    }

    /// Remove member worktrees (nested ones before the group folder's), then
    /// the container. Returns the primary member's recovery commit.
    pub(super) async fn remove_container(
        &self,
        thread: &mut Thread,
        project: &Project,
        saved: &[SavedMember],
        force: bool,
    ) -> Result<String> {
        let container = PathBuf::from(&thread.cwd);
        let copied = copied_entries(project);
        for member in saved.iter().rev() {
            let source = Repo::new(&member.source);
            if member.folder {
                // Kybern's untracked copies would make git refuse to remove the folder's worktree.
                let tree = Repo::new(&member.tree);
                for entry in &copied {
                    if member.tree.join(entry).exists() && !tree.is_tracked(entry).await.unwrap_or(true) {
                        let path = member.tree.join(entry);
                        let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                    }
                }
            }
            source.worktree_remove(&member.tree, force).await.map_err(|e| {
                let name = thread
                    .members
                    .iter()
                    .find(|m| m.source_path == member.source.to_string_lossy())
                    .map_or("a repository", |m| m.name.as_str());
                anyhow!("Couldn't remove the worktree of {name}: {e}")
            })?;
        }
        if container.exists() {
            std::fs::remove_dir_all(&container)?;
        }
        for member in thread.members.iter_mut().filter(|m| m.included && m.worktree.is_some()) {
            member.worktree_state = Some(WorktreeState::Removed);
        }
        Ok(saved.first().map(|s| s.commit.clone()).unwrap_or_default())
    }

    /// Recreate a cleaned group container from each member's recovery refs.
    pub(super) async fn restore_container(&self, thread: &mut Thread, project: &Project, receipt: &str) -> Result<()> {
        let container = PathBuf::from(&thread.cwd);
        let branch = thread.worktree.as_ref().map(|w| w.branch.clone()).unwrap_or_default();
        let has_folder = thread.members.iter().any(|m| m.path == "." && m.included && m.worktree.is_some());
        let members: Vec<ThreadMember> = container_members(thread).into_iter().cloned().collect();
        let mut primary = None;
        for member in &members {
            let source = Repo::new(&member.source_path);
            let commit = source.rev_parse(&format!("{}/source", super::worktrees::recovery_ref(thread.id))).await?;
            let head = source.rev_parse(&format!("{}/head", super::worktrees::recovery_ref(thread.id))).await?;
            primary.get_or_insert(commit.clone());
            source.worktree_prune().await?;
            let tree = PathBuf::from(&member.worktree.as_ref().unwrap().path);
            if member.path != "." {
                if !has_folder && !container.exists() {
                    std::fs::create_dir_all(&container)?;
                    copy_entries(Path::new(&project.path), &container, &SHARED_FILES, SHARED_FILES_CAP);
                }
                if let Some(parent) = tree.parent() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            let exclude = if member.path == "." { other_member_paths(&thread.members, ".") } else { Vec::new() };
            let start = if source.rev_parse(&branch).await.is_ok() {
                source.worktree_add_existing(&tree, &branch).await?;
                source.rev_parse(&branch).await?
            } else {
                source.worktree_add(&tree, &branch, Some(&head)).await?;
                head
            };
            if start != commit {
                Repo::new(&tree).restore_excluding(&commit, &exclude).await?;
            }
        }
        ensure!(primary.as_deref() == Some(receipt), "The worktree recovery ref changed. Inspect it before continuing.");
        let copy: Vec<&str> = project.worktree_copy.iter().map(String::as_str).filter(|e| is_copy_entry(e)).collect();
        copy_entries(Path::new(&project.path), &container, &copy, COPY_CAP);
        for member in thread.members.iter_mut().filter(|m| m.included && m.worktree.is_some()) {
            member.worktree_state = None;
        }
        Ok(())
    }
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
        let root = std::env::temp_dir().join(format!("kybern-group-copy-{}", Uuid::now_v7()));
        let (from, to) = (root.join("from"), root.join("to"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.as_path().join("AGENTS.md"), "shared").unwrap();
        std::fs::create_dir_all(from.as_path().join(".claude/commands")).unwrap();
        std::fs::write(from.as_path().join(".claude/settings.local.json"), "{}").unwrap();
        std::fs::write(from.as_path().join(".claude/commands/go.md"), "go").unwrap();
        std::fs::write(to.as_path().join("CLAUDE.md"), "kept").unwrap();
        std::fs::write(from.as_path().join("CLAUDE.md"), "@AGENTS.md").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", from.as_path().join(".claude/link")).unwrap();
        copy_entries(from.as_path(), to.as_path(), &SHARED_FILES, SHARED_FILES_CAP);
        assert_eq!(std::fs::read_to_string(to.as_path().join("AGENTS.md")).unwrap(), "shared");
        assert_eq!(std::fs::read_to_string(to.as_path().join("CLAUDE.md")).unwrap(), "kept");
        assert!(to.as_path().join(".claude/settings.local.json").exists());
        assert!(to.as_path().join(".claude/commands/go.md").exists());
        assert!(std::fs::symlink_metadata(to.as_path().join(".claude/link")).is_err());
        let _ = std::fs::remove_dir_all(&root);
        assert!(is_copy_entry("Makefile") && !is_copy_entry("../x") && !is_copy_entry("a/b") && !is_copy_entry(".git"));
    }
}
