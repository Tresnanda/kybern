//! Ordinary-thread cleanup, deliberately separate from delegation delivery.
use super::*;
use anyhow::ensure;
use kybern_protocol::methods::*;
use std::path::Path;

fn recovery_ref(id: ThreadId) -> String {
    format!("refs/kybern/worktree-recovery/{id}")
}

impl Orchestrator {
    pub async fn worktree_inspect(&self, id: ThreadId) -> Result<WorktreeInspectResult> {
        let thread = self.inner.store.thread_get(id)?.ok_or_else(|| anyhow!("thread not found"))?;
        ensure!(thread.delegation.is_none() && thread.subagent.is_none(), "Use this agent’s worktree controls instead.");
        let wt = thread.worktree.as_ref().ok_or_else(|| anyhow!("This thread uses the shared checkout. It has no worktree to remove."))?;
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let expected = self.inner.paths.worktrees.join(&project.name).join(thread.id.to_string());
        ensure!(
            Path::new(&wt.path) == expected && thread.cwd == wt.path,
            "This folder is not a Kybern-managed worktree. Remove it with Git after checking its owners."
        );
        let exists = Path::new(&wt.path).exists();
        if exists {
            let actual = std::fs::canonicalize(&wt.path)?;
            let managed = std::fs::canonicalize(&self.inner.paths.worktrees)?;
            ensure!(
                actual.starts_with(managed) && !std::fs::symlink_metadata(&wt.path)?.file_type().is_symlink(),
                "This worktree points outside the managed folders. Inspect it with Git before cleanup."
            );
            let source_common =
                crate::github::run(Path::new(&project.path), "git", &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
            let tree_common =
                crate::github::run(Path::new(&wt.path), "git", &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
            ensure!(
                std::fs::canonicalize(source_common)? == std::fs::canonicalize(tree_common)?,
                "This folder belongs to another repository. Inspect it with Git before cleanup."
            );
        }
        let mut blockers = Vec::new();
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            blockers.push("Stop the running turn before removing its worktree.".into());
        }
        if !self.inner.store.queue_list(Some(id))?.is_empty() {
            blockers.push("Remove queued messages before removing the worktree.".into());
        }
        let owners = self.inner.store.threads_list(Some(thread.project_id), true)?;
        if owners.iter().any(|t| {
            t.id != id
                && t.subagent.is_none()
                && (Path::new(&t.cwd).starts_with(&wt.path) || t.worktree.as_ref().is_some_and(|w| w.branch == wt.branch))
        }) {
            blockers.push("Another conversation owns this folder or branch. Keep the worktree while it is shared.".into());
        }
        for owner in &owners {
            if Path::new(&owner.cwd).starts_with(&wt.path) && matches!(owner.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
            {
                blockers.push("Stop running sessions using this worktree first.".into());
            }
            if Path::new(&owner.cwd).starts_with(&wt.path)
                && kybern_store::project_runtime_tasks(&self.inner.store.events_for_thread(owner.id)?)
                    .iter()
                    .any(|task| task.status.is_active())
            {
                blockers.push("Stop agents and background processes using this worktree first.".into());
                break;
            }
        }
        if let Some(live) = self.inner.sessions.lock().await.get(&id).cloned()
            && (live.turn.lock().await.is_some()
                || live.tasks.lock().await.values().any(|task| task.status.is_active())
                || !live.app_tool_requests.lock().await.is_empty())
        {
            blockers.push("Wait for the agent session and its tools to finish first.".into());
        }
        if self.inner.app_tools.terminals().iter().any(|t| t.alive && Path::new(&t.cwd).starts_with(&wt.path)) {
            blockers.push("Close terminals using this worktree first.".into());
        }
        let (clean, ignored_files) = if exists {
            if Repo::new(&wt.path).current_branch().await.as_deref() != Some(wt.branch.as_str()) {
                blockers.push("The checked-out branch changed outside Kybern. Restore the conversation’s branch before cleanup.".into());
            }
            let repo = Repo::new(&wt.path);
            let clean = repo.is_clean().await?;
            let ignored =
                crate::github::run(Path::new(&wt.path), "git", &["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).await?;
            let count = ignored.bytes().filter(|b| *b == 0).count() as u32;
            if count > 0 {
                blockers.push("Move or delete ignored files (including build output) before removing this worktree.".into());
            }
            if processes_use_path(Path::new(&wt.path)).await? {
                blockers.push("A process is using this worktree. Stop it or change its working directory first.".into());
            }
            (clean, count)
        } else {
            (true, 0)
        };
        let source = Repo::new(&project.path);
        let merged = source.is_ancestor(&wt.branch, "HEAD").await.unwrap_or(false);
        let eligible = exists && clean && merged && ignored_files == 0 && blockers.is_empty();
        Ok(WorktreeInspectResult {
            path: wt.path.clone(),
            branch: wt.branch.clone(),
            exists,
            clean,
            merged,
            ignored_files,
            blockers,
            eligible,
        })
    }

    pub async fn worktree_remove(&self, p: WorktreeRemoveParams) -> Result<WorktreeInspectResult> {
        let _workspace = self.inner.workspace_ops.lock().await;
        let admission = self.session_admission(p.thread_id).await;
        let _session = admission.lock().await;
        self.worktree_remove_locked(p).await
    }

    async fn worktree_remove_locked(&self, p: WorktreeRemoveParams) -> Result<WorktreeInspectResult> {
        let state = self.worktree_inspect(p.thread_id).await?;
        ensure!(state.blockers.is_empty(), "{}", state.blockers.join(" "));
        ensure!(!p.delete_branch || state.merged, "Only a merged branch can be deleted. Keep the branch or merge it first.");
        if !state.exists {
            return Ok(state);
        }
        ensure!(
            p.force || (state.clean && state.merged),
            "This worktree has source changes or unmerged commits. Confirm Remove worktree anyway to keep its source in a recovery ref and remove the folder."
        );
        let thread = self.inner.store.thread_get(p.thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        // An idle native process must relinquish its directory before Git removes it.
        if let Some(live) = self.inner.sessions.lock().await.remove(&thread.id) {
            live.mark_released();
            self.revoke_native_session(&live);
            live.session.close().await?;
        }
        let repo = Repo::new(&state.path);
        let head = repo.rev_parse("HEAD").await?;
        let commit = if state.clean { head.clone() } else { repo.snapshot("Kybern worktree cleanup recovery").await? };
        let source = Repo::new(&project.path);
        source.update_ref(&format!("{}/head", recovery_ref(thread.id)), &head).await?;
        source.update_ref(&format!("{}/source", recovery_ref(thread.id)), &commit).await?;
        // Re-probe after session close/snapshot. Ignored files and active owners never
        // become permission to discard content, even when force is explicitly set.
        let current = self.worktree_inspect(thread.id).await?;
        ensure!(current.blockers.is_empty(), "{}", current.blockers.join(" "));
        source.worktree_remove(Path::new(&state.path), p.force).await?;
        self.emit(thread.id, None, EventPayload::WorktreeCleaned { branch: state.branch.clone(), recovery_commit: commit })?;
        if p.delete_branch {
            source.delete_branch(&state.branch, false).await?;
        }
        Ok(WorktreeInspectResult { exists: false, eligible: false, ..state })
    }

    /// Called under workspace_ops before admitting a send. A missing directory
    /// without our removal receipt is an error, never a switch to the main checkout.
    pub(super) async fn restore_worktree_if_cleaned(&self, thread: &Thread) -> Result<()> {
        if thread.delegation.is_some() || thread.subagent.is_some() {
            return Ok(());
        }
        let Some(wt) = thread.worktree.as_ref() else {
            return Ok(());
        };
        if Path::new(&wt.path).exists() {
            return Ok(());
        }
        let events = self.inner.store.events_for_thread(thread.id)?;
        let receipt = events
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                EventPayload::WorktreeCleaned { recovery_commit, .. } => Some(recovery_commit.clone()),
                _ => None,
            })
            .ok_or_else(|| anyhow!("This worktree folder is missing. Restore it with Git before continuing this conversation."))?;
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let expected = self.inner.paths.worktrees.join(&project.name).join(thread.id.to_string());
        ensure!(
            Path::new(&wt.path) == expected && thread.cwd == wt.path,
            "The saved worktree location changed. Restore its original folder before continuing."
        );
        let source = Repo::new(&project.path);
        // The ref prevents Git GC from discarding recovered uncommitted source.
        let commit = source.rev_parse(&format!("{}/source", recovery_ref(thread.id))).await?;
        let head = source.rev_parse(&format!("{}/head", recovery_ref(thread.id))).await?;
        ensure!(commit == receipt, "The worktree recovery ref changed. Inspect it before continuing.");
        source.worktree_prune().await?;
        std::fs::create_dir_all(expected.parent().unwrap())?;
        if source.rev_parse(&wt.branch).await.is_ok() {
            source.worktree_add_existing(&expected, &wt.branch).await?;
            if source.rev_parse(&wt.branch).await? != commit {
                Repo::new(&wt.path).restore(&commit).await?;
            }
        } else {
            source.worktree_add(&expected, &wt.branch, Some(&head)).await?;
            if head != commit {
                Repo::new(&wt.path).restore(&commit).await?;
            }
        }
        self.emit(thread.id, None, EventPayload::WorktreeRestored { branch: wt.branch.clone() })?;
        Ok(())
    }

    pub async fn cleanup_eligible_worktrees(&self) {
        if !self.inner.settings.get().automatic_worktree_cleanup {
            return;
        }
        let Ok(threads) = self.inner.store.threads_list(None, true) else { return };
        // Archive is the inactivity boundary: an idle open conversation remains
        // available for inspection/editing until its owner explicitly archives it.
        for thread in threads.into_iter().filter(|t| {
            t.status == ThreadStatus::Archived
                && t.worktree.as_ref().is_some_and(|w| Path::new(&w.path).exists())
                && t.delegation.is_none()
                && t.subagent.is_none()
        }) {
            if self.worktree_inspect(thread.id).await.is_ok_and(|s| s.eligible)
                && let Err(error) =
                    self.worktree_remove(WorktreeRemoveParams { thread_id: thread.id, force: false, delete_branch: false }).await
            {
                tracing::debug!(thread_id = %thread.id, %error, "worktree cleanup skipped");
            }
        }
    }

    /// Provider-only context. Keep the human’s original message and the native
    /// conversation identity; clear this durable marker only after delivery.
    pub(super) fn workspace_transition_message(&self, thread: &Thread, message: &UserMessage) -> Result<(UserMessage, Option<u64>)> {
        let events = self.inner.store.events_for_thread(thread.id)?;
        let mut delivered = None;
        for event in events.iter().rev() {
            if let EventPayload::ProviderNotice { data: Some(data), .. } = &event.payload {
                if let Some(sequence) = data.get("workspace_transition_delivered").and_then(serde_json::Value::as_u64) {
                    delivered = Some(sequence);
                }
                if let Some(change) = data.get("workspace_transition") {
                    if delivered.is_some_and(|sequence| sequence >= event.seq) {
                        break;
                    }
                    let mut text = format!(
                        "Kybern workspace update requested by the human: checked out pull request #{} on branch {} at {}. This is the same conversation and working directory. Earlier discussion may describe the previous checkout; inspect the current branch and files before editing.\n\n",
                        change["number"],
                        change["branch"].as_str().unwrap_or("unknown"),
                        change["head"].as_str().unwrap_or("unknown")
                    );
                    truncate_utf8(&mut text, 4096);
                    let mut message = message.clone();
                    message.parts.insert(0, ContentPart::Text { text });
                    return Ok((message, Some(event.seq)));
                }
            }
        }
        Ok((message.clone(), None))
    }

    pub(super) fn workspace_transition_delivered(&self, id: ThreadId, sequence: u64) -> Result<()> {
        self.emit(
            id,
            None,
            EventPayload::ProviderNotice {
                level: NoticeLevel::Info,
                text: "Checkout context delivered to the agent.".into(),
                data: Some(serde_json::json!({"workspace_transition_delivered":sequence})),
            },
        )?;
        Ok(())
    }

    pub async fn pr_checkout(&self, p: &PrActionParams) -> Result<()> {
        let _workspace = self.inner.workspace_ops.lock().await;
        let id = p
            .thread_id
            .ok_or_else(|| anyhow!("Choose a linked conversation with its own worktree before checking out this pull request."))?;
        let admission = self.session_admission(id).await;
        let _session = admission.lock().await;
        let mut thread = self.inner.store.thread_get(id)?.ok_or_else(|| anyhow!("thread not found"))?;
        ensure!(
            thread.project_id == p.project_id && thread.status != ThreadStatus::Archived,
            "Choose an open conversation in this project."
        );
        self.restore_worktree_if_cleaned(&thread).await?;
        let state = self.worktree_inspect(id).await?;
        ensure!(
            state.clean && state.blockers.is_empty(),
            "Finish running work, close terminals and keep the worktree clean before checkout. {}",
            state.blockers.join(" ")
        );
        if let Some(live) = self.inner.sessions.lock().await.remove(&id) {
            live.mark_released();
            self.revoke_native_session(&live);
            live.session.close().await?;
        }
        crate::github_review::action(Path::new(&thread.cwd), p).await?;
        let branch = Repo::new(&thread.cwd).current_branch().await.ok_or_else(|| anyhow!("The pull request checkout has no branch."))?;
        thread.worktree.as_mut().unwrap().branch = branch;
        // The path and account stay compatible with native continuation. The next
        // delivered prompt receives the explicit checkout marker below.
        self.update_thread(thread.clone())?;
        let head = Repo::new(&thread.cwd).rev_parse("HEAD").await?;
        self.emit(thread.id, None, EventPayload::ProviderNotice {
            level: NoticeLevel::Info,
            text: format!("Checked out pull request #{} on {}. The next message continues this conversation with the new checkout.", p.number, thread.worktree.as_ref().unwrap().branch),
            data: Some(serde_json::json!({"workspace_transition":{"number":p.number,"branch":thread.worktree.as_ref().unwrap().branch,"head":head}})),
        })?;
        Ok(())
    }
}

/// Detect processes beyond Kybern’s own terminals/tasks as well. Failure to
/// inspect the OS is an error; it must not imply a worktree is unused.
async fn processes_use_path(path: &Path) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("/usr/sbin/lsof").args(["-d", "cwd", "-Fn"]).output().await?;
        ensure!(output.status.success(), "Unable to check processes using this worktree. Try again after closing its terminals.");
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix("n"))
            .any(|cwd| Path::new(cwd).starts_with(path)))
    }
    #[cfg(target_os = "linux")]
    {
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().parse::<u32>().is_ok()
                && let Ok(cwd) = std::fs::read_link(entry.path().join("cwd"))
                && cwd.starts_with(path)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err(anyhow!("Worktree cleanup is unavailable until this platform supports process ownership checks."))
    }
}
