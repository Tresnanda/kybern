//! The project Coordinator: an ordinary Orchestrator V2 thread with a lead role.
//!
//! A project has at most one Coordinator, marked by `Thread::coordinator_project_id`
//! (unique per project; archiving the thread frees the slot). It plans, routes and
//! reviews: its children are ordinary delegated threads made with the
//! `kybern_agent_*` tools, and it never edits files itself. Where a harness can
//! enforce that, the session starts with a read-only tool set.
//!
//! The project space is project-scoped notes: the user's pinned brief, the
//! Coordinator's setup note and any number of memory notes. The brief and an index
//! of the notes reach the lead and every thread delegated from it at session
//! start (a stable prefix), and every thread in the project when the project's
//! `brief_in_all_threads` switch is on. A brief that changes after the lead's
//! session started is prepended once to its next message instead, and so is a
//! change to the Coordinator settings (autonomy, workspace, push, child limit).
//!
//! A new Coordinator for a project without a brief, and "Redo setup", start with
//! a Kybern-originated kickoff: clients see a "Setup started" row (a
//! [`ContentPart::SystemRow`]), and only the provider's copy carries
//! [`SETUP_SCRIPT`]. The brief is written only through the brief proposal card.

use anyhow::{Result, anyhow, ensure};
use kybern_drivers::NativeToolRestrictions;
use kybern_protocol::methods::{self, Note, ProjectNoteRole};
use kybern_protocol::*;
use uuid::Uuid;

use super::{LiveSession, Orchestrator, default_provider_permission};

/// The lead's role, injected only into the Coordinator. Part of the cached system
/// prefix, so it stays short and byte-stable.
pub(super) const LEAD_ROLE: &str = "You are this project's Coordinator. You plan, route and review; other agents do the work.\n\
1. For each user message pick one: answer here, start a new child with kybern_agent_delegate, or send to an existing child with kybern_thread_send. Say which and why in one line.\n\
2. Never edit files or run mutating commands. All edits go to children.\n\
3. If the project has no setup note, first delegate a research child to learn how to build, run and test the project, then save the result with kybern_note_create using project_role \"setup\".\n\
4. Brief children with pointers (notes, files, commits), not pasted content.\n\
5. Tell every child: if something is missing, say exactly what and stop; do not mock, substitute or guess.\n\
6. After each child result, consider whether a memory note or the setup note should change so the next child starts better.\n\
7. Follow any working policy written in the project brief and the autonomy line below.\n\
8. The brief and your settings change only through kybern_coordinator_propose_brief and kybern_coordinator_propose_settings; the user approves each.\n\
If your conversation context is missing, read this thread with kybern_thread_read.";

/// The one-line git rule every Coordinator session carries. `kybern_git` is the
/// only way the lead touches git; children never commit.
pub(super) const LEAD_GIT_LINE: &str = "Use kybern_git for branches, commits, merging children and PRs; push/PR may ask the user; merging a PR always does. Children never commit.";

/// What the provider receives for a setup kickoff, in place of the "Setup started"
/// row clients show. It lives here, not in the cached system prefix, so a normal
/// session pays nothing for it.
pub(super) const SETUP_SCRIPT: &str = "Kybern has started your setup interview for this project. Run it now.\n\
1. Read AGENTS.md, CLAUDE.md and the README first. Do not ask what they already answer.\n\
2. Delegate one research child (kybern_agent_delegate, role research) to learn how to build, run and test the project, in parallel with the interview. When it returns, save its answer with kybern_note_create using project_role \"setup\".\n\
3. Interview the user in at most 3 rounds. Number the questions; give each a recommended answer and a one-line reason. Use your question tool (AskUserQuestion or question) when you have one, with the recommended option first; otherwise ask in chat and wait. Ask only what is still unknown: the project now; how work flows (autonomy: act, propose large changes, or propose first); what needs the user's approval; the quality bar; conventions; which models to use for each kind of work (research, implementation, review, design, test); how and when to report; known pitfalls.\n\
4. Finish with two proposals, each approved by the user in a card: kybern_coordinator_propose_brief (a concise brief in the user's words: purpose, conventions, working policy, pitfalls) and kybern_coordinator_propose_settings (only where their answers differ from the current settings). The brief is never written any other way.\n\
Then say in one line what is set and what you will do next.";

/// Most notes the index lists; the rest are found with `kybern_notes_search`.
const INDEX_MAX_NOTES: usize = 40;
/// Longest first line shown for a note in the index.
const INDEX_LINE_CHARS: usize = 100;
/// Longest brief placed in a session prefix.
const BRIEF_MAX_BYTES: usize = 16 * 1024;
/// Delegation hops followed when asking whether a thread descends from the lead.
const LEAD_CHAIN_MAX_HOPS: usize = 8;

/// Bridge tools a Coordinator keeps. Everything that changes the checkout, runs
/// commands or drives the computer is left out.
const LEAD_TOOLS: &[&str] = &[
    // Read.
    "kybern_thread_context",
    "kybern_read_file",
    "kybern_list_files",
    "kybern_list_terminals",
    "kybern_read_terminal",
    "kybern_workspace_diff",
    "kybern_runtime_tasks",
    // Notes and tasks.
    "kybern_notes_search",
    "kybern_note_read",
    "kybern_note_create",
    "kybern_note_append",
    "kybern_note_update",
    "kybern_tasks_list",
    "kybern_task_read",
    "kybern_task_create",
    "kybern_task_update",
    "kybern_task_claim",
    // Delegation and other threads.
    "kybern_agent_capabilities",
    "kybern_agent_delegate",
    "kybern_agent_status",
    "kybern_agent_cancel",
    "kybern_agent_wait",
    "kybern_thread_send",
    "kybern_thread_read",
    "kybern_thread_interrupt",
    "kybern_threads_search",
    // Showing things to the user.
    "kybern_html_preview",
    "kybern_html_publish",
    "kybern_preview_open",
    "kybern_request_secret",
    // Coordinator brief and settings.
    "kybern_coordinator_propose_brief",
    "kybern_coordinator_propose_settings",
];

/// Whether a harness can hold the lead to its read-only tool set. Codex and
/// Cursor cannot, so their Coordinator runs on instructions alone and clients
/// say that edits are not blocked there.
pub fn lead_restrictions_enforced(kind: ProviderKind) -> bool {
    matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Omp)
}

pub(super) fn lead_restrictions(kind: ProviderKind) -> NativeToolRestrictions {
    NativeToolRestrictions {
        allowed_tools: LEAD_TOOLS.iter().map(|name| (*name).to_owned()).collect(),
        denied_tools: Vec::new(),
        require_enforcement: lead_restrictions_enforced(kind),
        allow_read_only_builtins: true,
    }
}

/// What a session receives besides the guide, and the brief revision it embeds.
pub(super) struct SessionInstructions {
    pub text: String,
    /// Revision of the brief note the text carries (0 when the project has none).
    pub brief_revision: i64,
    /// The Coordinator settings the text states (`None` for any other thread).
    pub lead_settings: Option<EffectiveCoordinatorSettings>,
}

impl Orchestrator {
    /// The project's Coordinator thread, if it has one.
    pub fn coordinator_get(&self, project_id: ProjectId) -> Result<Option<Thread>> {
        self.inner.store.project_coordinator_thread(project_id)
    }

    /// Open the project's Coordinator, creating it when there is none. A project
    /// has one at a time, so a retry or a second client gets the same thread back.
    ///
    /// A Coordinator created for a project without a brief starts its setup
    /// interview: the user's opening words, when there are any, become their first
    /// answer. They are never saved as the brief.
    pub async fn coordinator_open(&self, params: methods::CoordinatorOpenParams) -> Result<methods::CoordinatorOpenResult> {
        let _lead = self.inner.lead_commands.lock().await;
        ensure!(!is_free_chat_project(params.project_id), "Chats without a project have no Coordinator. Choose a project.");
        let project =
            self.inner.store.project_get(params.project_id)?.ok_or_else(|| anyhow!("Project not found. Choose another project."))?;
        if let Some(thread) = self.coordinator_get(project.id)? {
            return Ok(methods::CoordinatorOpenResult { thread, created: false });
        }
        let created = self
            .create_thread_with_id(
                methods::ThreadsCreateParams {
                    pin_account: false,
                    project_id: Some(project.id),
                    provider: params.provider.clone(),
                    model: params.model.clone(),
                    effort: params.effort.clone(),
                    permission_mode: params.permission_mode,
                    use_worktree: Some(false),
                    base_branch: None,
                    title: Some(format!("{} coordinator", project.name)),
                    message: None,
                },
                Uuid::now_v7(),
            )
            .await?;
        // The marker is set right away and published as an update, so clients see
        // the Coordinator before anyone can send it a message.
        let mut thread = self.set_thread_relationships(created.id, None, Some(project.id))?;
        let opening = params.opening_message.as_deref().or(params.initial_brief.as_deref()).map(str::trim).filter(|text| !text.is_empty());
        let message = if self.project_has_brief(project.id)? { opening.map(UserMessage::text) } else { Some(setup_message(opening)) };
        if let Some(message) = message {
            self.send_lead_message(thread.id, message).await;
            thread = self.inner.store.thread_get(thread.id)?.unwrap_or(thread);
        }
        Ok(methods::CoordinatorOpenResult { thread, created: true })
    }

    /// "Redo setup": start the setup interview again on the existing Coordinator.
    /// Refused while it is running a turn.
    pub async fn coordinator_setup(&self, params: methods::CoordinatorSetupParams) -> Result<Thread> {
        let _lead = self.inner.lead_commands.lock().await;
        let current =
            self.coordinator_get(params.project_id)?.ok_or_else(|| anyhow!("Open the project's Coordinator before redoing its setup."))?;
        ensure!(matches!(current.status, ThreadStatus::Idle | ThreadStatus::Failed), "Wait for the Coordinator to finish, then try again.");
        self.send_with_id(current.id, Uuid::now_v7(), setup_message(None), false, false).await.map_err(|error| {
            if error.downcast_ref::<super::ThreadBusy>().is_some() {
                anyhow!("Wait for the Coordinator to finish, then try again.")
            } else {
                error
            }
        })?;
        Ok(self.inner.store.thread_get(current.id)?.unwrap_or(current))
    }

    /// Send the Coordinator a message of Kybern's own (a kickoff, or the user's
    /// opening words). A failure is logged: the thread exists either way, and
    /// "Redo setup" starts the interview again.
    async fn send_lead_message(&self, thread_id: ThreadId, message: UserMessage) {
        if let Err(error) = self.send_with_id(thread_id, Uuid::now_v7(), message, false, false).await {
            tracing::warn!(%thread_id, %error, "could not start the Coordinator's first turn");
        }
    }

    /// Whether the project has a brief with something in it.
    fn project_has_brief(&self, project_id: ProjectId) -> Result<bool> {
        Ok(self.inner.store.note_for_project_role(project_id, ProjectNoteRole::Brief)?.is_some_and(|note| !note.body.trim().is_empty()))
    }

    /// Move the Coordinator to another harness, model or account. The session
    /// restarts with the same lead instructions; the thread and its history stay.
    pub async fn coordinator_switch_harness(&self, params: methods::CoordinatorSwitchHarnessParams) -> Result<Thread> {
        let _lead = self.inner.lead_commands.lock().await;
        let current = self
            .coordinator_get(params.project_id)?
            .ok_or_else(|| anyhow!("Open the project's Coordinator before switching its harness."))?;
        let busy = || anyhow!("The Coordinator must be idle before switching its harness. Wait for its turn to end, then try again.");
        if !matches!(current.status, ThreadStatus::Idle | ThreadStatus::Failed) {
            return Err(busy());
        }
        if self.inner.store.runtime_tasks_for_thread(current.id)?.iter().any(|task| task.status.is_active()) {
            return Err(anyhow!("The Coordinator has background work running. Wait for it to finish, then switch its harness."));
        }
        let parked_live = self.inner.sessions.lock().await.get(&current.id).cloned();
        if let Some(live) = parked_live.as_deref()
            && !self.session_parked(current.id, live).await?
        {
            return Err(busy());
        }

        let settings = self.inner.settings.get();
        let model =
            params.model.clone().or_else(|| settings.providers.get(&params.provider.kind).and_then(|provider| provider.model.clone()));
        self.validate_provider_selection(params.project_id, &params.provider, model.as_deref(), params.effort.as_deref()).await?;
        let permission_mode =
            params.permission_mode.unwrap_or_else(|| default_provider_permission(params.provider.kind, settings.default_permission_mode));
        let (thread, released) = {
            // `commands` excludes a send between the final idle check, live
            // credential revocation, and the durable provider change.
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let mut thread = self.inner.store.thread_get(current.id)?.ok_or_else(|| anyhow!("The Coordinator thread was not found."))?;
            if !matches!(thread.status, ThreadStatus::Idle | ThreadStatus::Failed)
                || thread.coordinator_project_id != Some(params.project_id)
            {
                return Err(busy());
            }
            let retry = || anyhow!("The Coordinator session is changing. Try the harness switch again in a moment.");
            let mut sessions = self.inner.sessions.try_lock().map_err(|_| retry())?;
            if let Some(expected) = parked_live.as_ref()
                && !sessions.get(&thread.id).is_some_and(|live| std::sync::Arc::ptr_eq(live, expected))
            {
                return Err(retry());
            }
            let mut releasing = if parked_live.is_some() { Some(self.inner.releasing.try_lock().map_err(|_| retry())?) } else { None };
            let released = sessions.remove(&thread.id);
            thread.provider = params.provider.clone();
            thread.model = model;
            thread.effort = params.effort.clone();
            thread.permission_mode = permission_mode;
            thread.provider_session_id = None;
            thread.status = ThreadStatus::Idle;
            let thread = match self.update_thread(thread) {
                Ok(thread) => thread,
                Err(error) => {
                    if let Some(live) = released {
                        sessions.insert(current.id, live);
                    }
                    return Err(error);
                }
            };
            if let Some(live) = released.as_deref() {
                live.mark_released();
                self.revoke_native_session(live);
            }
            let released = released.map(|live| {
                let (done, waiting) = tokio::sync::watch::channel(());
                releasing.as_mut().expect("a live session reserves a release barrier").insert(thread.id, waiting);
                (live, done)
            });
            (thread, released)
        };
        self.inner.pending_rewinds.lock().await.remove(&thread.id);
        if let Some((live, done)) = released {
            let close = live.session.close().await;
            self.inner.releasing.lock().await.remove(&thread.id);
            drop(done);
            close?;
            self.emit(thread.id, None, EventPayload::ProviderSessionReleased { reason: SessionReleaseReason::Manual })?;
        }
        Ok(thread)
    }

    /// Bridge-tool and built-in restrictions for a session of `thread`: a
    /// Coordinator is held to its read-only set; every other thread is unrestricted.
    pub(super) fn native_tool_restrictions(&self, thread: &Thread) -> Result<NativeToolRestrictions> {
        if thread.coordinator_project_id.is_none() {
            return Ok(NativeToolRestrictions::default());
        }
        Ok(lead_restrictions(thread.provider.kind))
    }

    /// Whether `thread` descends from its project's Coordinator through delegation.
    pub(super) fn rooted_at_lead(&self, thread: &Thread) -> Result<bool> {
        let mut cursor = thread.clone();
        for _ in 0..LEAD_CHAIN_MAX_HOPS {
            if cursor.coordinator_project_id.is_some() {
                return Ok(true);
            }
            let (Some(_), Some(parent_id)) = (cursor.delegation.as_ref(), cursor.parent_thread_id) else { return Ok(false) };
            let Some(parent) = self.inner.store.thread_get(parent_id)? else { return Ok(false) };
            cursor = parent;
        }
        Ok(false)
    }

    /// The text a new session of `thread` receives next to the guide: the lead role
    /// for a Coordinator, and the project brief with a notes index for the lead,
    /// everything delegated from it, and every thread of a project that shares its
    /// brief. `None` for any other thread.
    pub(super) fn session_instructions(&self, thread: &Thread) -> Result<Option<SessionInstructions>> {
        if is_free_chat_project(thread.project_id) {
            return Ok(None);
        }
        let lead = thread.coordinator_project_id.is_some();
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found"))?;
        if !(lead || project.brief_in_all_threads || self.rooted_at_lead(thread)?) {
            return Ok(None);
        }
        let notes = self.inner.store.project_notes(project.id)?;
        let brief = notes.iter().find(|note| note.summary.project_role == Some(ProjectNoteRole::Brief));
        let mut text = String::new();
        let mut lead_settings = None;
        if lead {
            let effective = self.inner.settings.get().orchestration.effective_for(project.coordinator.as_ref());
            text.push_str(LEAD_ROLE);
            text.push_str("\n\n");
            text.push_str(&lead_settings_lines(&effective));
            text.push_str("\n\n");
            lead_settings = Some(effective);
        }
        text.push_str(&project_context(brief, &notes, lead));
        Ok(Some(SessionInstructions { text, brief_revision: brief.map_or(0, |note| note.summary.revision), lead_settings }))
    }

    /// For the Coordinator: a "Project brief updated" block when the brief changed
    /// after its session started, with the revision to remember once it is sent.
    pub(super) async fn lead_brief_update(&self, thread: &Thread, live: &LiveSession) -> Result<Option<(i64, String)>> {
        let Some(project_id) = thread.coordinator_project_id else { return Ok(None) };
        let Some(seen) = *live.brief_revision.lock().await else { return Ok(None) };
        let brief = self.inner.store.note_for_project_role(project_id, ProjectNoteRole::Brief)?;
        let revision = brief.as_ref().map_or(0, |note| note.summary.revision);
        if revision == seen {
            return Ok(None);
        }
        let mut body = brief.map(|note| note.body.trim().to_owned()).unwrap_or_default();
        if body.is_empty() {
            body = "(The brief is now empty.)".into();
        }
        super::truncate_utf8(&mut body, BRIEF_MAX_BYTES);
        Ok(Some((revision, format!("Project brief updated:\n{body}"))))
    }

    /// For the Coordinator: a "Coordinator settings changed" line when its effective
    /// settings differ from the ones its session was told, with the settings to
    /// remember once it is sent.
    pub(super) async fn lead_settings_update(
        &self,
        thread: &Thread,
        live: &LiveSession,
    ) -> Result<Option<(EffectiveCoordinatorSettings, String)>> {
        let Some(project_id) = thread.coordinator_project_id else { return Ok(None) };
        let Some(seen) = live.lead_settings.lock().await.clone() else { return Ok(None) };
        let project = self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("Project not found"))?;
        let now = self.inner.settings.get().orchestration.effective_for(project.coordinator.as_ref());
        Ok(settings_change_text(&seen, &now).map(|text| (now, text)))
    }

    /// Record that the Coordinator's session has now been told these settings.
    pub(super) async fn lead_settings_seen(&self, live: &LiveSession, settings: EffectiveCoordinatorSettings) {
        *live.lead_settings.lock().await = Some(settings);
    }

    /// The provider's copy of a setup kickoff, or `None` for any other message.
    pub(super) fn setup_provider_message(&self, thread: &Thread, message: &UserMessage) -> Result<Option<UserMessage>> {
        if thread.coordinator_project_id.is_none() || !is_setup_message(message) {
            return Ok(None);
        }
        let has_brief = self.project_has_brief(thread.project_id)?;
        Ok(Some(setup_provider_copy(message, has_brief)))
    }

    /// Record that the Coordinator's session has now seen this brief revision.
    pub(super) async fn lead_brief_seen(&self, live: &LiveSession, revision: i64) {
        *live.brief_revision.lock().await = Some(revision);
    }
}

/// The Kybern-originated kickoff of the setup interview: a "Setup started" row,
/// then the user's opening words (their first answer) as their own message.
pub(super) fn setup_message(opening: Option<&str>) -> UserMessage {
    let mut parts = vec![ContentPart::SystemRow { kind: SystemRowKind::CoordinatorSetup, text: SETUP_STARTED.into() }];
    if let Some(opening) = opening.map(str::trim).filter(|text| !text.is_empty()) {
        parts.push(ContentPart::Text { text: opening.to_owned() });
    }
    UserMessage { parts }
}

/// What clients show for a setup kickoff.
pub(super) const SETUP_STARTED: &str = "Setup started";

fn is_setup_message(message: &UserMessage) -> bool {
    message.parts.iter().any(|part| matches!(part, ContentPart::SystemRow { kind: SystemRowKind::CoordinatorSetup, .. }))
}

/// The setup kickoff as the provider receives it: the script, then the user's
/// opening words (everything but the row) or a note that they said nothing yet.
pub(super) fn setup_provider_copy(message: &UserMessage, has_brief: bool) -> UserMessage {
    let mut script = String::from(SETUP_SCRIPT);
    if has_brief {
        script.push_str("\nThe project already has a brief (above): ask only what it leaves open, and propose an updated brief.");
    }
    let user: Vec<ContentPart> = message.parts.iter().filter(|part| !matches!(part, ContentPart::SystemRow { .. })).cloned().collect();
    let mut parts;
    if user.is_empty() {
        script.push_str("\n\nThe user has not said anything yet. Begin with your first round.");
        parts = vec![ContentPart::Text { text: script }];
    } else {
        script.push_str("\n\nThe user's opening message follows. It is their first answer; do not ask again what it covers.\n\n");
        parts = vec![ContentPart::Text { text: script }];
        parts.extend(user);
    }
    UserMessage { parts }
}

/// The autonomy, workspace and tool lines of a Coordinator's instructions.
pub(super) fn lead_settings_lines(settings: &EffectiveCoordinatorSettings) -> String {
    let autonomy = match settings.lead_autonomy {
        LeadAutonomy::Act => "Autonomy: act. Decide and delegate on your own judgment, then report what you did.",
        LeadAutonomy::ProposeLarge => {
            "Autonomy: propose large changes. Do small, contained work yourself through children; for anything large, risky or hard to undo, propose the plan in chat and wait for the user's go-ahead."
        }
        LeadAutonomy::ProposeFirst => {
            "Autonomy: propose first. Before delegating any work, state the plan in chat and wait for the user's go-ahead."
        }
    };
    let workspace = match settings.lead_workspace {
        DelegationWorkspace::Shared => "Children work in the shared checkout unless you pass workspace.",
        DelegationWorkspace::Worktree => "Children get their own worktree unless you pass workspace.",
    };
    format!("{autonomy}\n{workspace}\n{LEAD_GIT_LINE}")
}

/// One short line telling the lead what changed between two settings, or `None`
/// when nothing it acts on did.
pub(super) fn settings_change_text(seen: &EffectiveCoordinatorSettings, now: &EffectiveCoordinatorSettings) -> Option<String> {
    let mut changes = Vec::new();
    if seen.lead_autonomy != now.lead_autonomy {
        changes.push(format!("autonomy is now {}", now.lead_autonomy.label()));
    }
    if seen.lead_workspace != now.lead_workspace {
        changes.push(match now.lead_workspace {
            DelegationWorkspace::Shared => "children now work in the shared checkout by default".to_owned(),
            DelegationWorkspace::Worktree => "children now get their own worktree by default".to_owned(),
        });
    }
    if seen.lead_push_without_asking != now.lead_push_without_asking {
        changes.push(if now.lead_push_without_asking {
            "pushing and opening pull requests no longer asks the user".to_owned()
        } else {
            "pushing and opening pull requests asks the user again".to_owned()
        });
    }
    if seen.lead_max_children != now.lead_max_children {
        changes.push(format!("you may run {} agents at once", now.lead_max_children));
    }
    if seen.role_defaults != now.role_defaults {
        changes.push("the default models per kind of work changed (see kybern_agent_capabilities)".to_owned());
    }
    (!changes.is_empty()).then(|| format!("Coordinator settings changed: {}.", changes.join("; ")))
}

/// `message` with a "Project brief updated" block in front, for the provider's copy only.
pub(super) fn with_brief_update(message: &UserMessage, update: &str) -> UserMessage {
    let mut parts = vec![ContentPart::Text { text: format!("{update}\n\n") }];
    parts.extend(message.parts.iter().cloned());
    UserMessage { parts }
}

/// The brief and the index of the project's notes, followed by the standing rule
/// for anything that is missing.
fn project_context(brief: Option<&Note>, notes: &[Note], lead: bool) -> String {
    let change = if lead { "propose the edit with kybern_coordinator_propose_brief" } else { "suggest the edit in chat" };
    let mut out = format!("Project brief (the user's; to change it, {change}):\n");
    match brief.map(|note| note.body.trim()).filter(|body| !body.is_empty()) {
        Some(body) => {
            let mut body = body.to_owned();
            super::truncate_utf8(&mut body, BRIEF_MAX_BYTES);
            out.push_str(&body);
        }
        None => out.push_str("(No brief yet.)"),
    }
    out.push_str("\n\nProject notes (read one with kybern_note_read):\n");
    let mut listed = 0;
    let mut hidden = 0;
    // The setup note first, then the most recently edited notes.
    let ordered = notes
        .iter()
        .filter(|note| note.summary.project_role == Some(ProjectNoteRole::Setup))
        .chain(notes.iter().filter(|note| note.summary.project_role.is_none()));
    for note in ordered {
        if listed == INDEX_MAX_NOTES {
            hidden += 1;
            continue;
        }
        listed += 1;
        let title = note.summary.title.trim();
        let title = if title.is_empty() { "Untitled" } else { title };
        let label = if note.summary.project_role == Some(ProjectNoteRole::Setup) { "Setup note: " } else { "" };
        let first_line = first_line(&note.body);
        let id = note.summary.id;
        if first_line.is_empty() {
            out.push_str(&format!("- {label}{title} ({id})\n"));
        } else {
            out.push_str(&format!("- {label}{title}: {first_line} ({id})\n"));
        }
    }
    if listed == 0 {
        out.push_str("(No notes yet.)\n");
    }
    if lead && !notes.iter().any(|note| note.summary.project_role == Some(ProjectNoteRole::Setup)) {
        out.push_str("There is no setup note yet.\n");
    }
    if hidden > 0 {
        out.push_str(&format!("({hidden} more; find them with kybern_notes_search.)\n"));
    }
    out.push_str("\nIf something you need is missing, say exactly what and stop; do not mock, substitute or guess.");
    out
}

/// The first non-empty line of a note body, shortened for the index.
fn first_line(body: &str) -> String {
    let line = body
        .lines()
        .map(|line| line.trim_start_matches(['#', '>', '-', '*', ' ', '\t']).trim())
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.chars().count() <= INDEX_LINE_CHARS {
        return line.to_owned();
    }
    let mut short: String = line.chars().take(INDEX_LINE_CHARS).collect();
    short.push('…');
    short
}
