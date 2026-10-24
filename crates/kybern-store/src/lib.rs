//! SQLite persistence. One database per daemon, WAL mode, event-sourced threads.
//!
//! The store is synchronous; the daemon wraps calls in `spawn_blocking` when
//! they may take more than a few milliseconds (replays, projections).

mod groups;
mod notes;
mod projection;
mod schema;
mod spaces;
mod subagent_messages;
mod tasks;
mod thread_history;
mod transcript_page;
mod visuals;
pub use notes::{
    NOTE_BODY_MAX_BYTES, NOTE_RETENTION_DAYS, NOTE_TITLE_MAX_CHARS, NoteError, NoteTarget, checklist as note_checklist,
    preview as note_preview,
};
pub use groups::{GROUP_FOLDER_MEMBER, folder_name, member_display_names};
pub use spaces::SpaceError;
pub use tasks::{
    GLOBAL_TASK_PREFIX, NewTask, TASK_BODY_MAX_BYTES, TASK_RETENTION_DAYS, TASK_TITLE_MAX_CHARS, TaskError, TaskPatch, TaskRunPatch,
    TaskRunUpdate, TaskStatusChange, derive_task_prefix, task_link_lines, task_link_source_line, task_set_line_checked,
};
pub use thread_history::{ThreadHistoryMessage, ThreadHistoryReadPage, ThreadHistorySearchPage};
pub use transcript_page::{WHOLE_TURN_EXTRA_ENTRIES, transcript_page, transcript_page_ref, transcript_page_ref_with};

pub use projection::{
    LARGE_TOOL_OUTPUT_BYTES, TranscriptFold, json_payload_bytes, project_pending_questions, project_provider_usage, project_runtime_tasks,
    project_thread_activity, project_transcript, should_omit_tool_output,
};

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use kybern_protocol::*;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use uuid::Uuid;

/// Exact result for one tool invocation at a caller's snapshot boundary.
pub struct SavedToolResult {
    pub output: serde_json::Value,
    pub is_error: bool,
    pub stream: Option<String>,
    pub stream_omitted: bool,
}

fn snake(value: impl serde::Serialize) -> Result<String> {
    Ok(serde_json::to_value(value)?.as_str().ok_or_else(|| anyhow::anyhow!("enum did not serialize as a string"))?.to_owned())
}

/// The persistence boundary for secret answers: an `ApprovalResolved` event
/// never stores or broadcasts the value of a secret answer, whoever emits it.
fn redact_resolved_approval(c: &Connection, payload: &mut EventPayload) -> Result<()> {
    let EventPayload::ApprovalResolved { approval_id, decision, .. } = payload else { return Ok(()) };
    if matches!(decision, ApprovalDecision::Submit { .. })
        && let Some(approval) = approval_row(c, *approval_id)?
    {
        *decision = approval.0.redacted_decision(decision);
    }
    Ok(())
}

fn approval_row(c: &Connection, id: ApprovalId) -> Result<Option<(ApprovalRequest, bool)>> {
    Ok(c.query_row("SELECT payload, resolved FROM approvals WHERE id = ?1", [id.to_string()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
    })
    .optional()?
    .map(|(p, resolved)| serde_json::from_str::<ApprovalRequest>(&p).map(|a| (a, resolved)))
    .transpose()?)
}

/// Append within the caller's transaction so related state and its observable
/// events share one commit boundary.
fn append_event_in_transaction(
    tx: &Transaction<'_>,
    thread_id: ThreadId,
    turn_id: Option<TurnId>,
    mut payload: EventPayload,
) -> Result<ThreadEvent> {
    let c = tx;
    redact_resolved_approval(c, &mut payload)?;
    let at = Utc::now();
    let kind = payload.kind();
    let serialized = serde_json::to_string(&payload)?;
    c.execute(
        "INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![thread_id.to_string(), turn_id.map(|t| t.to_string()), at.to_rfc3339(), kind, serialized],
    )?;
    let seq = c.last_insert_rowid();
    if stamp_runtime_task_sequence(&mut payload, seq) {
        c.execute("UPDATE events SET payload = ?2 WHERE seq = ?1", params![seq, serde_json::to_string(&payload)?])?;
    }
    c.execute("UPDATE threads SET last_seq = ?2, updated_at = ?3 WHERE id = ?1", params![thread_id.to_string(), seq, at.to_rfc3339()])?;
    match &payload {
        EventPayload::ThreadNotesUpdated { notes } => {
            c.execute(
                "INSERT INTO thread_notes(thread_id, text, revision) VALUES (?1, ?2, ?3)
                 ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, revision = excluded.revision",
                params![thread_id.to_string(), notes.text, notes.revision],
            )?;
        }
        EventPayload::MessageSteered { message_id, message } => {
            c.execute(
                "INSERT INTO steered_messages(id, thread_id, turn_id, payload) VALUES (?1, ?2, ?3, ?4)",
                params![message_id.to_string(), thread_id.to_string(), turn_id.map(|id| id.to_string()), serde_json::to_string(message)?],
            )?;
        }
        EventPayload::MessageQueueUpdated { message } => {
            c.execute(
                "UPDATE queued_messages SET payload = ?3 WHERE id = ?1 AND thread_id = ?2 AND pending = 1",
                params![message.id.to_string(), thread_id.to_string(), serde_json::to_string(message)?],
            )?;
        }
        EventPayload::MessageQueued { message } => {
            c.execute(
                "INSERT INTO queued_messages(id, thread_id, payload, seq) VALUES (?1, ?2, ?3, ?4)",
                params![message.id.to_string(), thread_id.to_string(), serde_json::to_string(message)?, seq],
            )?;
        }
        EventPayload::MessageRemoved { message_id } | EventPayload::TurnStarted { message_id, .. } => {
            c.execute(
                "UPDATE queued_messages SET pending = 0 WHERE id = ?1 AND thread_id = ?2",
                params![message_id.to_string(), thread_id.to_string()],
            )?;
        }
        EventPayload::ThreadArchived => {
            c.execute("UPDATE queued_messages SET pending = 0 WHERE thread_id = ?1", [thread_id.to_string()])?;
        }
        _ => {}
    }
    Ok(ThreadEvent { seq, thread_id, turn_id, at, payload })
}

/// What removing a project moved to Recently deleted.
#[derive(Debug, Clone, Default)]
pub struct ProjectRemoval {
    pub notes: Vec<methods::NoteSummary>,
    pub tasks: Vec<methods::TaskItemId>,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

/// A row in the auth token table. The raw token is never stored, only its SHA-256.
#[derive(Debug, Clone)]
pub struct TokenRecord {
    pub id: Uuid,
    pub label: String,
    pub scopes: Vec<Scope>,
    pub created_at: DateTime<Utc>,
    pub revoked: bool,
}

#[derive(Debug, Clone)]
pub struct TurnUsageRow {
    pub turn_id: TurnId,
    pub thread_id: ThreadId,
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub usage: Usage,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub at: DateTime<Utc>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        schema::migrate(&conn)?;
        tasks::ensure_project_prefixes(&conn)?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("store mutex poisoned"))?;
        f(&conn)
    }

    // ---- tool operation receipts ----

    /// The saved result of an agent tool call that carried an `operation_id`, so a
    /// retry returns it instead of writing twice.
    pub fn operation_receipt<T: serde::de::DeserializeOwned>(
        &self,
        operation_id: OperationId,
        actor: &str,
        operation_kind: &str,
        request: &impl serde::Serialize,
    ) -> Result<Option<T>> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let row = c
                .query_row(
                    "SELECT actor, operation_kind, request, state, response FROM tool_operations WHERE operation_id = ?1",
                    [operation_id.to_string()],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((stored_actor, stored_kind, stored_request, state, response)) = row else { return Ok(None) };
            if stored_actor != actor || stored_kind != operation_kind || stored_request != request {
                anyhow::bail!("operation id already belongs to a different actor or request");
            }
            if state != "completed" {
                anyhow::bail!(
                    "operation outcome is uncertain after an interrupted daemon write; inspect the current notes and tasks before using a new operation id"
                );
            }
            Ok(Some(serde_json::from_str(&response.ok_or_else(|| anyhow::anyhow!("completed operation has no response"))?)?))
        })
    }

    pub fn operation_begin(
        &self,
        operation_id: OperationId,
        actor: &str,
        operation_kind: &str,
        request: &impl serde::Serialize,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        self.with(|c| {
            c.execute(
                "INSERT INTO tool_operations(operation_id, actor, operation_kind, request, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)",
                params![operation_id.to_string(), actor, operation_kind, serde_json::to_string(request)?, now],
            )?;
            Ok(())
        })
    }

    pub fn operation_complete<T: serde::Serialize>(&self, operation_id: OperationId, response: &T) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE tool_operations SET state = 'completed', response = ?2, updated_at = ?3 WHERE operation_id = ?1 AND state = 'pending'",
                params![operation_id.to_string(), serde_json::to_string(response)?, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }

    /// Forget a pending operation whose write failed before changing anything, so a
    /// retry with the same id runs again instead of reporting an uncertain outcome.
    pub fn operation_abandon(&self, operation_id: OperationId) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM tool_operations WHERE operation_id = ?1 AND state = 'pending'", [operation_id.to_string()])?;
            Ok(())
        })
    }

    // ---- meta ----

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| Ok(c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?))
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    /// Blank every meta value under `prefix` that equals `value`; returns the count.
    pub fn meta_clear_matching(&self, prefix: &str, value: &str) -> Result<usize> {
        self.with(|c| {
            Ok(c.execute("UPDATE meta SET value = '' WHERE substr(key, 1, length(?1)) = ?1 AND value = ?2", params![prefix, value])?)
        })
    }

    /// Persist related session identities in one SQLite transaction.
    pub fn meta_set_many(&self, values: &[(&str, &str)]) -> Result<()> {
        self.with(|connection| {
            let transaction = connection.unchecked_transaction()?;
            for (key, value) in values {
                transaction.execute(
                    "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    // ---- tokens ----

    pub fn token_insert(&self, id: Uuid, hash: &str, label: &str, scopes: &[Scope]) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO tokens(id, hash, label, scopes, created_at, revoked) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![id.to_string(), hash, label, serde_json::to_string(scopes)?, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn token_lookup(&self, hash: &str) -> Result<Option<TokenRecord>> {
        self.with(|c| {
            let row = c
                .query_row("SELECT id, label, scopes, created_at, revoked FROM tokens WHERE hash = ?1", [hash], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, bool>(4)?,
                    ))
                })
                .optional()?;
            match row {
                None => Ok(None),
                Some((id, label, scopes, created_at, revoked)) => Ok(Some(TokenRecord {
                    id: id.parse()?,
                    label,
                    scopes: serde_json::from_str(&scopes)?,
                    created_at: created_at.parse()?,
                    revoked,
                })),
            }
        })
    }

    pub fn token_is_active(&self, id: Uuid) -> Result<bool> {
        self.with(|c| Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM tokens WHERE id = ?1 AND revoked = 0)", [id.to_string()], |r| r.get(0))?))
    }

    pub fn token_touch(&self, id: Uuid) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE tokens SET last_used_at = ?1 WHERE id = ?2", params![Utc::now().to_rfc3339(), id.to_string()])?;
            Ok(())
        })
    }

    pub fn tokens_list(&self) -> Result<Vec<methods::TokenInfo>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id, label, scopes, created_at, last_used_at, revoked FROM tokens ORDER BY created_at")?;
            let rows = st.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, bool>(5)?,
                ))
            })?;
            let mut out = Vec::new();
            for r in rows {
                let (id, label, scopes, created, last, revoked) = r?;
                out.push(methods::TokenInfo {
                    id: id.parse()?,
                    label,
                    scopes: serde_json::from_str(&scopes)?,
                    created_at: created.parse()?,
                    last_used_at: last.map(|l| l.parse()).transpose()?,
                    revoked,
                });
            }
            Ok(out)
        })
    }

    pub fn token_revoke(&self, id: Uuid) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE tokens SET revoked = 1 WHERE id = ?1", [id.to_string()])?;
            Ok(())
        })
    }

    pub fn asset_insert(&self, a: &methods::AssetInfo) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO assets(id, name, media_type, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![a.id.to_string(), a.name, a.media_type, a.size as i64, a.created_at.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn asset_get(&self, id: AssetId) -> Result<Option<methods::AssetInfo>> {
        self.with(|c| {
            c.query_row("SELECT id, name, media_type, size, created_at FROM assets WHERE id = ?1", [id.to_string()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?))
            })
            .optional()?
            .map(|(id, name, media_type, size, created)| -> Result<methods::AssetInfo> {
                Ok(methods::AssetInfo { id: id.parse()?, name, media_type, size: size as u64, created_at: created.parse()? })
            })
            .transpose()
        })
    }

    pub fn token_count(&self) -> Result<u64> {
        self.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM tokens WHERE revoked = 0", [], |r| r.get::<_, i64>(0))? as u64))
    }

    // ---- projects ----

    pub fn project_insert(&self, p: &Project) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO projects(id, name, path, is_git, worktrees_default, created_at, updated_at, brief_in_all_threads, coordinator, space_id,
                    kind, instructions_offer_dismissed, worktree_copy)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                         CASE WHEN ?1 = ?11 THEN NULL
                              ELSE COALESCE(?10, (SELECT id FROM spaces ORDER BY position, created_at LIMIT 1)) END,
                         ?12, ?13, ?14)",
                params![
                    p.id.to_string(),
                    p.name,
                    p.path,
                    p.is_git,
                    p.worktrees_default,
                    p.created_at.to_rfc3339(),
                    p.updated_at.to_rfc3339(),
                    p.brief_in_all_threads,
                    coordinator_json(p)?,
                    p.space_id.map(|id| id.to_string()),
                    FREE_CHAT_PROJECT_ID.to_string(),
                    p.kind.as_str(),
                    p.instructions_offer_dismissed,
                    worktree_copy_json(p)?
                ],
            )?;
            if p.kind == ProjectKind::Group {
                let paths: Vec<String> = p.members.iter().map(|m| m.path.clone()).collect();
                groups::write_members(&tx, p.id, &paths)?;
            }
            // Every project gets a task prefix; an explicit one is kept when it is valid and free.
            tasks::assign_project_prefix(&tx, p.id, &p.name, p.task_prefix.as_deref())?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn project_update(&self, p: &Project) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE projects SET name = ?2, path = ?3, is_git = ?4, worktrees_default = ?5, updated_at = ?6, brief_in_all_threads = ?7,
                 coordinator = ?8, instructions_offer_dismissed = ?9, worktree_copy = ?10
                 WHERE id = ?1",
                params![
                    p.id.to_string(),
                    p.name,
                    p.path,
                    p.is_git,
                    p.worktrees_default,
                    p.updated_at.to_rfc3339(),
                    p.brief_in_all_threads,
                    coordinator_json(p)?,
                    p.instructions_offer_dismissed,
                    worktree_copy_json(p)?
                ],
            )?;
            Ok(())
        })
    }

    /// Persist a live Git probe without overwriting concurrent project edits.
    /// Returns whether an existing record changed; identical probes stay quiet.
    pub fn project_set_git_status(&self, id: ProjectId, is_git: bool) -> Result<bool> {
        self.with(|c| {
            Ok(c.execute(
                "UPDATE projects SET is_git = ?2, updated_at = ?3 WHERE id = ?1 AND is_git != ?2",
                params![id.to_string(), is_git, Utc::now().to_rfc3339()],
            )? > 0)
        })
    }

    pub fn project_delete(&self, id: ProjectId) -> Result<()> {
        if is_free_chat_project(id) {
            return Err(anyhow::anyhow!("the free-chat workspace cannot be removed"));
        }
        self.with(|c| {
            c.execute("DELETE FROM projects WHERE id = ?1", [id.to_string()])?;
            Ok(())
        })
    }

    pub fn project_get(&self, id: ProjectId) -> Result<Option<Project>> {
        self.with(|c| {
            let project = c.query_row(&format!("{PROJECT_SELECT} WHERE id = ?1"), [id.to_string()], row_to_project).optional()?;
            with_members(c, project)
        })
    }

    pub fn project_by_path(&self, path: &str) -> Result<Option<Project>> {
        self.with(|c| {
            let project = c.query_row(&format!("{PROJECT_SELECT} WHERE path = ?1"), [path], row_to_project).optional()?;
            with_members(c, project)
        })
    }

    pub fn projects_list(&self) -> Result<Vec<Project>> {
        self.with(|c| {
            let mut st = c.prepare(&format!("{PROJECT_SELECT} WHERE id != ?1 ORDER BY name"))?;
            let rows = st.query_map([FREE_CHAT_PROJECT_ID.to_string()], row_to_project)?;
            let mut projects = rows.collect::<Result<Vec<_>, _>>()?;
            groups::attach_members(c, &mut projects)?;
            Ok(projects)
        })
    }

    // ---- threads ----

    pub fn thread_upsert(&self, t: &Thread) -> Result<()> {
        self.with(|c| write_thread(c, t))
    }

    /// The project's Coordinator thread. Archiving it clears the marker, so a
    /// project's slot is free again once its Coordinator is archived.
    pub fn project_coordinator_thread(&self, project_id: ProjectId) -> Result<Option<Thread>> {
        self.with(|c| {
            Ok(c.query_row(&format!("{THREAD_SELECT} WHERE coordinator_project_id = ?1"), [project_id.to_string()], row_to_thread)
                .optional()?)
        })
    }

    pub fn thread_set_relationships(
        &self,
        thread_id: ThreadId,
        parent_thread_id: Option<ThreadId>,
        coordinator_project_id: Option<ProjectId>,
    ) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE threads SET parent_thread_id=COALESCE(parent_thread_id,?2), coordinator_project_id=?3 WHERE id=?1",
                params![thread_id.to_string(), parent_thread_id.map(|id| id.to_string()), coordinator_project_id.map(|id| id.to_string()),],
            )?;
            Ok(())
        })
    }

    /// Adopt a native conversation and its history in one transaction. Concurrent
    /// imports return the existing thread, including archived threads.
    pub fn thread_import(&self, mut thread: Thread, history: Vec<ThreadEvent>) -> Result<(Thread, Vec<ThreadEvent>)> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(existing) = tx
                .query_row(
                    &format!("{THREAD_SELECT} WHERE provider_kind = ?1 AND provider_session_id = ?2 AND provider_instance = ?3 LIMIT 1"),
                    params![thread.provider.kind.as_str(), thread.provider_session_id, thread.provider.instance],
                    row_to_thread,
                )
                .optional()?
            {
                return Ok((existing, Vec::new()));
            }
            write_thread(&tx, &thread)?;
            let mut events = Vec::with_capacity(history.len() + 2);
            events.push(ThreadEvent {
                seq: 0,
                thread_id: thread.id,
                turn_id: None,
                at: thread.created_at,
                payload: EventPayload::ThreadCreated { thread: thread.clone() },
            });
            events.extend(history);
            events.push(ThreadEvent {
                seq: 0,
                thread_id: thread.id,
                turn_id: events.last().and_then(|event| event.turn_id),
                at: thread.updated_at,
                payload: EventPayload::SessionImported {
                    provider: thread.provider.kind,
                    session_id: thread.provider_session_id.clone().unwrap_or_default(),
                },
            });
            for event in &mut events {
                event.thread_id = thread.id;
                let payload = serde_json::to_value(&event.payload)?;
                let kind = payload["kind"].as_str().unwrap_or("unknown");
                tx.execute(
                    "INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        thread.id.to_string(),
                        event.turn_id.map(|id| id.to_string()),
                        event.at.to_rfc3339(),
                        kind,
                        serde_json::to_string(&payload)?
                    ],
                )?;
                event.seq = tx.last_insert_rowid();
            }
            thread.last_seq = events.last().map_or(0, |event| event.seq);
            write_thread(&tx, &thread)?;
            tx.commit()?;
            Ok((thread, events))
        })
    }

    pub fn thread_get(&self, id: ThreadId) -> Result<Option<Thread>> {
        self.with(|c| Ok(c.query_row(&format!("{THREAD_SELECT} WHERE id = ?1"), [id.to_string()], row_to_thread).optional()?))
    }

    pub fn threads_list(&self, project_id: Option<ProjectId>, include_archived: bool) -> Result<Vec<Thread>> {
        self.with(|c| {
            let mut sql = String::from(THREAD_SELECT);
            let mut clauses = Vec::new();
            if project_id.is_some() {
                clauses.push("project_id = ?1");
            }
            if !include_archived {
                clauses.push("status != 'archived'");
            }
            if !clauses.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&clauses.join(" AND "));
            }
            sql.push_str(" ORDER BY pinned DESC, updated_at DESC");
            let mut st = c.prepare(&sql)?;
            let rows = match project_id {
                Some(p) => st.query_map([p.to_string()], row_to_thread)?.collect::<Result<Vec<_>, _>>()?,
                None => st.query_map([], row_to_thread)?.collect::<Result<Vec<_>, _>>()?,
            };
            Ok(rows)
        })
    }

    /// The child thread mirroring `task_id` of the session owned by `root_thread_id`.
    pub fn subagent_thread_find(&self, root_thread_id: ThreadId, task_id: &str) -> Result<Option<Thread>> {
        self.with(|c| {
            Ok(c.query_row(
                &format!(
                    "{THREAD_SELECT} WHERE subagent IS NOT NULL AND json_extract(subagent, '$.root_thread_id') = ?1
                     AND json_extract(subagent, '$.task_id') = ?2"
                ),
                params![root_thread_id.to_string(), task_id],
                row_to_thread,
            )
            .optional()?)
        })
    }

    /// Direct subagent children of a thread, oldest first.
    pub fn subagent_children(&self, parent_thread_id: ThreadId) -> Result<Vec<Thread>> {
        self.with(|c| {
            let mut st =
                c.prepare(&format!("{THREAD_SELECT} WHERE subagent IS NOT NULL AND parent_thread_id = ?1 ORDER BY created_at, id"))?;
            Ok(st.query_map([parent_thread_id.to_string()], row_to_thread)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// The delegated child created for the delegate call `operation_id`.
    pub fn delegation_find_by_operation(&self, operation_id: Uuid) -> Result<Option<Thread>> {
        self.with(|c| {
            Ok(c.query_row(
                &format!("{THREAD_SELECT} WHERE delegation IS NOT NULL AND json_extract(delegation, '$.operation_id') = ?1"),
                [operation_id.to_string()],
                row_to_thread,
            )
            .optional()?)
        })
    }

    /// The delegated child that `kybern_agent_*` tools know as `task_id`.
    pub fn delegation_find_by_task(&self, task_id: Uuid) -> Result<Option<Thread>> {
        self.with(|c| {
            Ok(c.query_row(
                &format!("{THREAD_SELECT} WHERE delegation IS NOT NULL AND json_extract(delegation, '$.task_id') = ?1"),
                [task_id.to_string()],
                row_to_thread,
            )
            .optional()?)
        })
    }

    /// Delegated children of a thread, oldest first.
    pub fn delegation_children(&self, parent_thread_id: ThreadId) -> Result<Vec<Thread>> {
        self.with(|c| {
            let mut st =
                c.prepare(&format!("{THREAD_SELECT} WHERE delegation IS NOT NULL AND parent_thread_id = ?1 ORDER BY created_at, id"))?;
            Ok(st.query_map([parent_thread_id.to_string()], row_to_thread)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// How many delegated children of a thread are still `running`.
    pub fn delegation_active_count(&self, parent_thread_id: ThreadId) -> Result<u32> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM threads WHERE delegation IS NOT NULL AND parent_thread_id = ?1
                 AND json_extract(delegation, '$.status') = 'running'",
                [parent_thread_id.to_string()],
                |r| r.get(0),
            )?)
        })
    }

    // ---- thread messages ----

    /// Insert a message. Fails when `operation_id` or `id` already exists; use
    /// [`Store::thread_message_find_by_operation`] first to make a send idempotent.
    pub fn thread_message_insert(&self, m: &ThreadMessageRecord) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO thread_messages(id, operation_id, from_thread_id, to_thread_id, purpose, reply_to, body, delivery,
                                             state, held_reason, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    m.id.to_string(),
                    m.operation_id.to_string(),
                    m.from_thread_id.map(|id| id.to_string()),
                    m.to_thread_id.to_string(),
                    snake(m.purpose)?,
                    m.reply_to.map(|id| id.to_string()),
                    m.body,
                    snake(m.delivery)?,
                    snake(m.state)?,
                    m.held_reason,
                    m.created_at.to_rfc3339(),
                    m.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn thread_message_get(&self, id: MessageId) -> Result<Option<ThreadMessageRecord>> {
        self.with(|c| {
            Ok(c.query_row(&format!("{THREAD_MESSAGE_SELECT} WHERE id = ?1"), [id.to_string()], row_to_thread_message).optional()?)
        })
    }

    pub fn thread_message_find_by_operation(&self, operation_id: Uuid) -> Result<Option<ThreadMessageRecord>> {
        self.with(|c| {
            Ok(c.query_row(&format!("{THREAD_MESSAGE_SELECT} WHERE operation_id = ?1"), [operation_id.to_string()], row_to_thread_message)
                .optional()?)
        })
    }

    /// Move a message to `state` and bump `updated_at`. Returns the updated row,
    /// or `None` when no message has that id.
    pub fn thread_message_update_state(&self, id: MessageId, state: ThreadMessageState) -> Result<Option<ThreadMessageRecord>> {
        self.with(|c| {
            let changed = c.execute(
                "UPDATE thread_messages SET state = ?2, updated_at = ?3 WHERE id = ?1",
                params![id.to_string(), snake(state)?, Utc::now().to_rfc3339()],
            )?;
            if changed == 0 {
                return Ok(None);
            }
            Ok(c.query_row(&format!("{THREAD_MESSAGE_SELECT} WHERE id = ?1"), [id.to_string()], row_to_thread_message).optional()?)
        })
    }

    /// Every thread message in one of `states`, oldest first (startup recovery).
    pub fn thread_messages_in_states(&self, states: &[ThreadMessageState], limit: usize) -> Result<Vec<ThreadMessageRecord>> {
        if states.is_empty() {
            return Ok(Vec::new());
        }
        let states = states.iter().map(|state| snake(*state)).collect::<Result<Vec<_>>>()?;
        let limit = limit.clamp(1, 10_000) as i64;
        self.with(|c| {
            let marks = (0..states.len()).map(|i| format!("?{}", i + 2)).collect::<Vec<_>>().join(",");
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(limit)];
            values.extend(states.into_iter().map(|state| Box::new(state) as Box<dyn rusqlite::ToSql>));
            let mut st = c.prepare(&format!("{THREAD_MESSAGE_SELECT} WHERE state IN ({marks}) ORDER BY created_at, rowid LIMIT ?1"))?;
            Ok(st
                .query_map(rusqlite::params_from_iter(values.iter().map(|v| v.as_ref())), row_to_thread_message)?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    /// Move a message to `to` only while it is still in one of the `from` states
    /// (one atomic UPDATE, so a newer state is never overwritten). Returns the
    /// updated row when it changed, `None` when it did not or does not exist.
    pub fn thread_message_transition(
        &self,
        id: MessageId,
        from: &[ThreadMessageState],
        to: ThreadMessageState,
    ) -> Result<Option<ThreadMessageRecord>> {
        if from.is_empty() {
            return Ok(None);
        }
        let from = from.iter().map(|state| snake(*state)).collect::<Result<Vec<_>>>()?;
        self.with(|c| {
            let placeholders = (0..from.len()).map(|index| format!("?{}", index + 4)).collect::<Vec<_>>().join(",");
            let mut values: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(id.to_string()), Box::new(snake(to)?), Box::new(Utc::now().to_rfc3339())];
            values.extend(from.into_iter().map(|state| Box::new(state) as Box<dyn rusqlite::ToSql>));
            let refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|value| value.as_ref()).collect();
            let changed = c.execute(
                &format!("UPDATE thread_messages SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ({placeholders})"),
                refs.as_slice(),
            )?;
            if changed == 0 {
                return Ok(None);
            }
            Ok(c.query_row(&format!("{THREAD_MESSAGE_SELECT} WHERE id = ?1"), [id.to_string()], row_to_thread_message).optional()?)
        })
    }

    /// Messages sent to or from `thread_id`, oldest first. Only the newest
    /// `limit` rows (at most 200) are returned. `states` filters by state.
    pub fn thread_message_list_for_thread(
        &self,
        thread_id: ThreadId,
        states: Option<&[ThreadMessageState]>,
        limit: usize,
    ) -> Result<Vec<ThreadMessageRecord>> {
        let limit = limit.clamp(1, 200) as i64;
        let states = states.map(|states| states.iter().map(|s| snake(*s)).collect::<Result<Vec<_>>>()).transpose()?;
        self.with(|c| {
            let mut rows = match &states {
                Some(states) if states.is_empty() => return Ok(Vec::new()),
                Some(states) => {
                    let marks = (0..states.len()).map(|i| format!("?{}", i + 3)).collect::<Vec<_>>().join(",");
                    let sql = format!(
                        "{THREAD_MESSAGE_SELECT} WHERE (to_thread_id = ?1 OR from_thread_id = ?1) AND state IN ({marks})
                         ORDER BY created_at DESC, rowid DESC LIMIT ?2"
                    );
                    let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(thread_id.to_string()), Box::new(limit)];
                    values.extend(states.iter().map(|s| Box::new(s.clone()) as Box<dyn rusqlite::ToSql>));
                    let mut st = c.prepare(&sql)?;
                    st.query_map(rusqlite::params_from_iter(values.iter().map(|v| v.as_ref())), row_to_thread_message)?
                        .collect::<Result<Vec<_>, _>>()?
                }
                None => {
                    let mut st = c.prepare(&format!(
                        "{THREAD_MESSAGE_SELECT} WHERE to_thread_id = ?1 OR from_thread_id = ?1
                         ORDER BY created_at DESC, rowid DESC LIMIT ?2"
                    ))?;
                    st.query_map(params![thread_id.to_string(), limit], row_to_thread_message)?.collect::<Result<Vec<_>, _>>()?
                }
            };
            rows.reverse();
            Ok(rows)
        })
    }

    /// The first reply recorded for the question `reply_to`.
    pub fn thread_message_find_reply(&self, reply_to: MessageId) -> Result<Option<ThreadMessageRecord>> {
        self.with(|c| {
            Ok(c.query_row(
                &format!("{THREAD_MESSAGE_SELECT} WHERE reply_to = ?1 AND purpose = 'reply' ORDER BY created_at, rowid LIMIT 1"),
                [reply_to.to_string()],
                row_to_thread_message,
            )
            .optional()?)
        })
    }

    pub fn threads_running(&self) -> Result<Vec<Thread>> {
        self.with(|c| {
            let mut st = c.prepare(&format!("{THREAD_SELECT} WHERE status IN ('running','awaiting-approval')"))?;
            Ok(st.query_map([], row_to_thread)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    // ---- events ----

    /// Append an event, assigning its `seq`. Also bumps the thread's `last_seq`.
    pub fn event_append(&self, thread_id: ThreadId, turn_id: Option<TurnId>, payload: EventPayload) -> Result<ThreadEvent> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let event = append_event_in_transaction(&tx, thread_id, turn_id, payload)?;
            tx.commit()?;
            Ok(event)
        })
    }

    /// Read the turn count and, only for a single-turn thread, its first prompt
    /// for title eligibility. Keep this independent of the full event log:
    /// completed tool results can be megabytes each, and custom old threads do
    /// not need their first prompt (which may contain an image) at all.
    pub fn first_turn_message_and_count(&self, thread_id: ThreadId) -> Result<(Option<UserMessage>, i64)> {
        self.with(|c| {
            let thread_id = thread_id.to_string();
            let count: i64 =
                c.query_row("SELECT COUNT(*) FROM events WHERE thread_id = ?1 AND kind = 'turn_started'", [&thread_id], |row| row.get(0))?;
            if count != 1 {
                return Ok((None, count));
            }
            let payload: String = c.query_row(
                "SELECT payload FROM events
                 WHERE thread_id = ?1 AND kind = 'turn_started'
                 ORDER BY seq LIMIT 1",
                [&thread_id],
                |row| row.get(0),
            )?;
            let first = match serde_json::from_str::<EventPayload>(&payload)? {
                EventPayload::TurnStarted { message, .. } => Some(message),
                _ => None,
            };
            Ok((first, count))
        })
    }

    /// Find the durable acceptance record for a client-supplied message id.
    pub fn turn_started_receipt(&self, message_id: MessageId) -> Result<Option<(ThreadId, TurnId, UserMessage)>> {
        self.with(|c| {
            let event = c
                .query_row(
                    "SELECT seq, thread_id, turn_id, at, payload FROM events
                     WHERE kind='turn_started' AND json_extract(payload, '$.message_id')=?1 LIMIT 1",
                    [message_id.to_string()],
                    row_to_event,
                )
                .optional()?;
            event
                .map(|event| match event.payload {
                    EventPayload::TurnStarted { message_id: stored_id, message } if stored_id == message_id => {
                        Ok((event.thread_id, event.turn_id.ok_or_else(|| anyhow::anyhow!("turn_started event has no turn id"))?, message))
                    }
                    _ => Err(anyhow::anyhow!("turn_started receipt payload is inconsistent")),
                })
                .transpose()
        })
    }

    pub fn queue_list(&self, thread_id: Option<ThreadId>) -> Result<Vec<methods::QueuedMessage>> {
        self.with(|c| {
            let mut st =
                c.prepare("SELECT payload FROM queued_messages WHERE pending = 1 AND (?1 IS NULL OR thread_id = ?1) ORDER BY seq")?;
            let rows = st.query_map([thread_id.map(|id| id.to_string())], |r| r.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        })
    }

    pub fn steering_receipt(&self, id: MessageId) -> Result<Option<(ThreadId, TurnId, UserMessage)>> {
        self.with(|c| {
            let row = c
                .query_row("SELECT thread_id, turn_id, payload FROM steered_messages WHERE id = ?1", [id.to_string()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
                })
                .optional()?;
            row.map(|(thread, turn, message)| Ok((thread.parse()?, turn.parse()?, serde_json::from_str(&message)?))).transpose()
        })
    }

    pub fn queue_receipt(&self, id: MessageId) -> Result<Option<methods::QueuedMessage>> {
        self.with(|c| {
            let payload: Option<String> =
                c.query_row("SELECT payload FROM queued_messages WHERE id = ?1", [id.to_string()], |r| r.get(0)).optional()?;
            payload.map(|payload| Ok(serde_json::from_str(&payload)?)).transpose()
        })
    }

    pub fn queue_is_pending(&self, id: MessageId) -> Result<bool> {
        self.with(|c| {
            Ok(c.query_row("SELECT pending FROM queued_messages WHERE id=?1", [id.to_string()], |r| r.get::<_, bool>(0))
                .optional()?
                .unwrap_or(false))
        })
    }

    /// Read only native Artifact calls and their receipts, never the full transcript.
    pub fn artifact_calls(&self, thread_id: ThreadId, before: Option<EventSeq>, limit: u32) -> Result<Vec<methods::ArtifactTool>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT s.seq, s.at, s.payload, (
                   SELECT c.payload FROM events c
                   WHERE c.thread_id = s.thread_id AND c.turn_id IS s.turn_id AND c.seq > s.seq
                     AND c.kind = 'tool_call_completed'
                     AND json_extract(c.payload, '$.tool_call_id') = json_extract(s.payload, '$.call.id')
                   ORDER BY c.seq DESC LIMIT 1
                 ) FROM (
                   SELECT seq, at, payload, thread_id, turn_id FROM events
                   WHERE thread_id = ?1 AND kind = 'tool_call_started'
                     AND json_extract(payload, '$.call.name') = 'Artifact'
                     AND COALESCE(json_extract(payload, '$.call.input.action'), 'publish') = 'publish'
                     AND seq < ?2 ORDER BY seq DESC LIMIT ?3
                 ) s ORDER BY s.seq DESC",
            )?;
            let rows = statement
                .query_map(params![thread_id.to_string(), before.unwrap_or(i64::MAX), limit.min(101)], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut result = Vec::new();
            for (seq, at, start, completion) in rows {
                let EventPayload::ToolCallStarted { call, .. } = serde_json::from_str(&start)? else { continue };
                let (output, is_error) = match completion.map(|text| serde_json::from_str::<EventPayload>(&text)).transpose()? {
                    Some(EventPayload::ToolCallCompleted { output, is_error, .. }) => (Some(output), is_error),
                    _ => (None, false),
                };
                result.push(methods::ArtifactTool { seq, at: at.parse()?, call, output, is_error });
            }
            Ok(result)
        })
    }

    pub fn events_head_seq(&self) -> Result<EventSeq> {
        self.with(|c| Ok(c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?))
    }

    /// When the most recent event was appended, if any. Every turn writes
    /// events, so this is the last time an agent did work for a client.
    pub fn events_latest_at(&self) -> Result<Option<DateTime<Utc>>> {
        self.with(|c| {
            let at: Option<String> = c.query_row("SELECT at FROM events ORDER BY seq DESC LIMIT 1", [], |r| r.get(0)).optional()?;
            Ok(at.map(parse_time).transpose()?)
        })
    }

    /// Events with `seq > after`, optionally filtered by thread, ascending, at most `limit`.
    pub fn events_after(&self, thread_id: Option<ThreadId>, after: EventSeq, limit: u32) -> Result<Vec<ThreadEvent>> {
        self.events_after_bounded(thread_id, after, limit, usize::MAX)
    }

    /// Replay batches have a byte budget as well as a count. Always return the
    /// first event even if oversized, so the cursor can make progress.
    pub fn events_after_bounded(
        &self,
        thread_id: Option<ThreadId>,
        after: EventSeq,
        limit: u32,
        max_bytes: usize,
    ) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let sql = match thread_id {
                Some(_) => {
                    "SELECT seq, thread_id, turn_id, at, payload FROM events WHERE seq > ?1 AND thread_id = ?2 ORDER BY seq LIMIT ?3"
                }
                None => "SELECT seq, thread_id, turn_id, at, payload FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?3",
            };
            let mut st = c.prepare(sql)?;
            let mut rows = st.query(params![after, thread_id.map(|id| id.to_string()).unwrap_or_default(), limit])?;
            let mut events = Vec::new();
            let mut bytes = 0usize;
            while let Some(row) = rows.next()? {
                let size = row.get_ref(4)?.as_str()?.len();
                if !events.is_empty() && bytes.saturating_add(size) > max_bytes {
                    break;
                }
                bytes = bytes.saturating_add(size);
                events.push(row_to_event(row)?);
            }
            Ok(events)
        })
    }

    /// Replay batches for compact event subscriptions. Large settled tool
    /// results remain borrowed as raw JSON while the row is decoded, so a
    /// replay does not allocate a `serde_json::Value` for output that will be
    /// replaced by the transport omission marker anyway.
    pub fn events_after_bounded_compact(
        &self,
        thread_id: Option<ThreadId>,
        after: EventSeq,
        limit: u32,
        max_bytes: usize,
    ) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let sql = match thread_id {
                Some(_) => {
                    "SELECT seq,thread_id,turn_id,at,kind,payload FROM events WHERE seq > ?1 AND thread_id = ?2 ORDER BY seq LIMIT ?3"
                }
                None => "SELECT seq,thread_id,turn_id,at,kind,payload FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?3",
            };
            let mut st = c.prepare(sql)?;
            let mut rows = st.query(params![after, thread_id.map(|id| id.to_string()).unwrap_or_default(), limit])?;
            let mut events = Vec::new();
            let mut bytes = 0usize;
            while let Some(row) = rows.next()? {
                let size = row.get_ref(5)?.as_str()?.len();
                if !events.is_empty() && bytes.saturating_add(size) > max_bytes {
                    break;
                }
                bytes = bytes.saturating_add(size);
                events.push(row_to_compact_event(row)?);
            }
            Ok(events)
        })
    }

    pub fn events_for_thread(&self, thread_id: ThreadId) -> Result<Vec<ThreadEvent>> {
        self.events_for_thread_through(thread_id, i64::MAX)
    }

    /// Only evidence consumed by quota recovery, starting at the latest turn.
    /// Keep the range and kinds in SQL so target hydration never decodes message
    /// text or tool results from the rest of the conversation.
    pub fn latest_turn_quota_events(&self, thread_id: ThreadId) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT seq,thread_id,turn_id,at,payload FROM events
                 WHERE thread_id=?1 AND seq >= (
                     SELECT seq FROM events WHERE thread_id=?1 AND kind='turn_started' ORDER BY seq DESC LIMIT 1
                 ) AND kind IN ('turn_started','provider_usage_updated','turn_failed','turn_completed','turn_resumed','session_transitioned')
                 ORDER BY seq",
            )?;
            Ok(statement.query_map([thread_id.to_string()], row_to_event)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn events_for_thread_recent(&self, thread_id: ThreadId, limit: u32) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT seq,thread_id,turn_id,at,payload FROM (SELECT seq,thread_id,turn_id,at,payload FROM events WHERE thread_id=?1 ORDER BY seq DESC LIMIT ?2) ORDER BY seq")?;
            Ok(st.query_map(params![thread_id.to_string(), limit.clamp(1, 1000)], row_to_event)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Bounded recovery evidence for one turn. Never read large tool results or
    /// streaming deltas just to restore explicit native message boundaries.
    pub fn omp_recovery_events(&self, thread_id: ThreadId, turn_id: TurnId) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT seq,thread_id,turn_id,at,payload FROM events
                 WHERE thread_id=?1 AND turn_id=?2 AND kind IN
                 ('turn_started','assistant_message_completed','tool_call_started','turn_completed',
                  'provider_session_bound','assistant_message_blocks_recovered') ORDER BY seq LIMIT 10001",
            )?;
            let mut rows = statement.query(params![thread_id.to_string(), turn_id.to_string()])?;
            let mut events = Vec::new();
            let mut bytes = 0usize;
            while let Some(row) = rows.next()? {
                bytes = bytes.saturating_add(row.get_ref(4)?.as_str()?.len());
                anyhow::ensure!(
                    bytes <= 8 * 1024 * 1024 && events.len() < 10_000,
                    "OMP recovery exceeds the 8 MB/10,000-event limit. Recover a shorter retained turn."
                );
                events.push(row_to_event(row)?);
            }
            Ok(events)
        })
    }

    pub fn provider_session_before(&self, thread_id: ThreadId, through: EventSeq) -> Result<Option<ThreadEvent>> {
        self.with(|c| {
            c.query_row(
                "SELECT seq,thread_id,turn_id,at,payload FROM events
                WHERE thread_id=?1 AND seq<=?2 AND kind='provider_session_bound' ORDER BY seq DESC LIMIT 1",
                params![thread_id.to_string(), through],
                row_to_event,
            )
            .optional()
            .map_err(Into::into)
        })
    }

    /// Read only settled user/assistant messages, newest page first in SQL and
    /// returned in conversation order. This never hydrates a provider session.
    pub fn thread_message_events(
        &self,
        thread_id: ThreadId,
        through_seq: EventSeq,
        before_seq: Option<EventSeq>,
        limit: u32,
    ) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let before = before_seq.unwrap_or(i64::MAX).min(through_seq.saturating_add(1));
            let assistant_text = thread_history::corrected_assistant_text_sql("e", "?2");
            let mut st = c.prepare(&format!(
                "SELECT seq,thread_id,turn_id,at,
                   CASE WHEN kind='assistant_message_completed' THEN json_set(payload,'$.text',{assistant_text}) ELSE payload END
                 FROM (SELECT seq,thread_id,turn_id,at,kind,payload FROM events
                   WHERE thread_id=?1 AND seq<=?2 AND seq<?3
                     AND kind IN ('turn_started','assistant_message_completed')
                   ORDER BY seq DESC LIMIT ?4) e ORDER BY seq"
            ))?;
            Ok(st
                .query_map(params![thread_id.to_string(), through_seq, before, limit.clamp(1, 200) + 1], row_to_event)?
                .collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Latest user-authored turn. A new human turn resets bounded automatic peer
    /// wakeups for that chat task.
    pub fn thread_latest_human_turn_at(&self, thread_id: ThreadId) -> Result<Option<DateTime<Utc>>> {
        self.with(|c| {
            c.query_row(
                "SELECT e.at FROM events e
                 WHERE e.thread_id=?1 AND e.kind='turn_started'
                 ORDER BY e.seq DESC LIMIT 1",
                [thread_id.to_string()],
                |row| parse_time(row.get(0)?),
            )
            .optional()
            .map_err(Into::into)
        })
    }

    /// Latest turn a person started in `thread_id`: not a thread message,
    /// delegation brief or batch of agent results. Thread
    /// messaging resets its per-pair wake cap on it.
    pub fn thread_latest_person_turn_at(&self, thread_id: ThreadId) -> Result<Option<DateTime<Utc>>> {
        self.with(|c| {
            c.query_row(
                "SELECT e.at FROM events e
                 LEFT JOIN thread_messages tm ON tm.id=json_extract(e.payload,'$.message_id')
                 WHERE e.thread_id=?1 AND e.kind='turn_started' AND tm.id IS NULL
                   AND COALESCE(json_extract(e.payload,'$.message.parts[0].type'),'') NOT IN ('thread_message','agent_results')
                 ORDER BY e.seq DESC LIMIT 1",
                [thread_id.to_string()],
                |row| parse_time(row.get(0)?),
            )
            .optional()
            .map_err(Into::into)
        })
    }

    /// The text of the thread's own messages (prompts, steered messages and completed replies, never reasoning or tool
    /// output) whose stored payload contains `needle` (as JSON-encoded there), newest first among `after < seq <
    /// before`. `instr` is only a prefilter: callers judge the returned text. One batch per call, bounded by rows and by
    /// the payload bytes scanned, so the connection is released between batches; the second value is the next `before`,
    /// or `None` when the range is exhausted.
    pub fn thread_message_texts_containing(
        &self,
        thread_id: ThreadId,
        needle: &str,
        after: EventSeq,
        before: EventSeq,
    ) -> Result<(Vec<String>, Option<EventSeq>)> {
        const BATCH: i64 = 128;
        const BATCH_BYTES: i64 = 1024 * 1024;
        if needle.is_empty() {
            return Ok((Vec::new(), None));
        }
        let encoded = serde_json::to_string(needle)?;
        let needle = &encoded[1..encoded.len() - 1];
        let (payloads, next) = self.with(|c| {
            let mut st = c.prepare_cached(
                "SELECT seq, octet_length(payload), CASE WHEN instr(payload, ?4) > 0 THEN payload END FROM events
                 WHERE thread_id = ?1 AND seq > ?2 AND seq < ?3 AND kind IN ('assistant_message_completed', 'turn_started', 'message_steered')
                 ORDER BY seq DESC LIMIT ?5",
            )?;
            let mut rows = st.query(params![thread_id.to_string(), after, before, needle, BATCH])?;
            let (mut payloads, mut count, mut bytes, mut last) = (Vec::new(), 0, 0i64, None);
            while let Some(row) = rows.next()? {
                last = Some(row.get::<_, EventSeq>(0)?);
                bytes = bytes.saturating_add(row.get::<_, Option<i64>>(1)?.unwrap_or(0));
                if let Some(payload) = row.get::<_, Option<String>>(2)? {
                    payloads.push(payload);
                }
                count += 1;
                if bytes >= BATCH_BYTES {
                    break;
                }
            }
            let more = count == BATCH || bytes >= BATCH_BYTES;
            Ok((payloads, last.filter(|_| more)))
        })?;
        let texts = payloads
            .iter()
            .filter_map(|payload| match serde_json::from_str::<EventPayload>(payload).ok()? {
                EventPayload::AssistantMessageCompleted { text, .. } => Some(text),
                EventPayload::TurnStarted { message, .. } | EventPayload::MessageSteered { message, .. } => Some(message.plain_text()),
                _ => None,
            })
            .collect();
        Ok((texts, next))
    }

    /// The newest message event of the thread (see `thread_message_texts_containing`), 0 when there is none.
    pub fn thread_last_message_seq(&self, thread_id: ThreadId) -> Result<EventSeq> {
        self.with(|c| {
            c.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM events
                 WHERE thread_id = ?1 AND kind IN ('assistant_message_completed', 'turn_started', 'message_steered')",
                [thread_id.to_string()],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
    }

    /// Keep a hydrated transcript aligned with the thread's acknowledged head.
    ///
    /// Read in bounded batches, releasing the connection between them: a long thread (tens of thousands of events,
    /// hundreds of MB) took the lock for a second or more, and every other read and write waited, a user's send among
    /// them (0.8 s measured for a 230 MB thread; ~20 ms now). Events only append with increasing `seq`, so the batches
    /// join into the same ordered list.
    pub fn events_for_thread_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<ThreadEvent>> {
        const BATCH: i64 = 256;
        const BATCH_BYTES: usize = 256 * 1024;
        let thread = thread_id.to_string();
        let mut events = Vec::new();
        let mut after = 0;
        loop {
            let (more, last) = self.with(|c| {
                let mut st = c.prepare_cached(
                    "SELECT seq, thread_id, turn_id, at, payload FROM events WHERE thread_id = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq LIMIT ?4",
                )?;
                let mut rows = st.query(params![thread, after, through_seq, BATCH])?;
                let (mut count, mut bytes, mut last) = (0, 0usize, None);
                while let Some(row) = rows.next()? {
                    bytes = bytes.saturating_add(row.get_ref(4)?.as_bytes().map_or(0, <[u8]>::len));
                    let event = row_to_event(row)?;
                    last = Some(event.seq);
                    events.push(event);
                    count += 1;
                    if bytes >= BATCH_BYTES {
                        return Ok((true, last));
                    }
                }
                Ok((count == BATCH, last))
            })?;
            match last {
                Some(seq) if more => after = seq,
                _ => return Ok(events),
            }
            // The std mutex is not fair: re-locking at once would win against a waiting thread nearly every time.
            std::thread::yield_now();
        }
    }

    /// Fold bounded batches outside the connection lock. A saved long thread
    /// must not block the sidebar's sparse activity reads for its entire replay.
    pub fn project_transcript_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<TranscriptEntry>> {
        Ok(self.project_transcript_fold_through(thread_id, through_seq)?.finish())
    }

    /// The same fold, kept whole to mark tool streams on a page.
    pub fn project_transcript_fold_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<TranscriptFold> {
        let mut fold = TranscriptFold::omitting_tool_outputs();
        self.extend_transcript_fold(thread_id, &mut fold, 0, through_seq)?;
        Ok(fold)
    }

    /// Continue a fold that already holds every event through `after` with the
    /// events in `(after, through_seq]`. Events only append with increasing
    /// `seq`, so the result equals a fold from the beginning; a live thread's
    /// moving snapshot then costs its new events, not its whole history.
    pub fn extend_transcript_fold(
        &self,
        thread_id: ThreadId,
        fold: &mut TranscriptFold,
        after: EventSeq,
        through_seq: EventSeq,
    ) -> Result<()> {
        const BATCH: usize = 128;
        const BATCH_BYTES: usize = 256 * 1024;
        let mut after = after;
        loop {
            let (events, bytes) = self.with(|c| {
                // Exclude only known no-op events. Unknown/new kinds still
                // enter the fold. Keep this aligned with its no-op arm. Output
                // deltas stay in: the fold records which invocations streamed.
                let mut statement = c.prepare_cached(
                    "SELECT seq, thread_id, turn_id, at, kind, payload FROM events
                     WHERE thread_id = ?1 AND seq > ?2 AND seq <= ?3 AND kind NOT IN (
                       'async_questions_requested', 'provider_commands_updated', 'provider_usage_updated',
                       'thread_created', 'thread_updated', 'message_queued', 'message_queue_updated',
                       'thread_notes_updated', 'message_removed', 'thread_archived', 'checkpoint_updated',
                       'thread_message_held', 'thread_message_resolved', 'thread_message_updated'
                     ) ORDER BY seq LIMIT ?4",
                )?;
                let mut rows = statement.query(params![thread_id.to_string(), after, through_seq, BATCH as u32])?;
                let mut events = Vec::new();
                let mut bytes = 0;
                while let Some(row) = rows.next()? {
                    bytes += row.get_ref(5)?.as_bytes()?.len();
                    events.push(row_to_projection_event(row)?);
                    // A single event can exceed the budget, but a batch never
                    // retains several oversized messages before folding them.
                    if bytes >= BATCH_BYTES {
                        break;
                    }
                }
                Ok((events, bytes))
            })?;
            let done = events.len() < BATCH && bytes < BATCH_BYTES;
            for event in events {
                after = event.seq;
                fold.apply(&event);
            }
            if done {
                return Ok(());
            }
        }
    }

    /// Fetch the completion belonging to this exact start, at the requested
    /// snapshot. A reused provider call ID must never hydrate an older row with
    /// a newer invocation's result.
    pub fn tool_call_output_through(
        &self,
        thread_id: ThreadId,
        tool_call_id: &str,
        start_seq: Option<EventSeq>,
        through_seq: EventSeq,
    ) -> Result<Option<(serde_json::Value, bool)>> {
        Ok(self
            .tool_call_result_through(thread_id, tool_call_id, start_seq, through_seq, false)?
            .map(|result| (result.output, result.is_error)))
    }

    /// Fetch a settled tool result and, when requested, its exact persisted
    /// output-delta stream. The stream is bounded by the requested snapshot,
    /// and the same intervening-start guard protects reused provider IDs.
    pub fn tool_call_result_through(
        &self,
        thread_id: ThreadId,
        tool_call_id: &str,
        start_seq: Option<EventSeq>,
        through_seq: EventSeq,
        include_stream: bool,
    ) -> Result<Option<SavedToolResult>> {
        self.with(|c| {
            let start: Option<EventSeq> = c
                .query_row(
                    "SELECT seq FROM events WHERE thread_id = ?1 AND kind = 'tool_call_started'
                 AND seq <= ?3 AND (?4 IS NULL OR seq = ?4)
                 AND json_extract(payload, '$.call.id') = ?2 ORDER BY seq DESC LIMIT 1",
                    params![thread_id.to_string(), tool_call_id, through_seq, start_seq],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(start) = start else { return Ok(None) };
            let mut statement = c.prepare_cached(TOOL_OUTPUT_AT_START_SQL)?;
            let Some((_completion_seq, output, is_error)) =
                read_tool_completion_at_start(&mut statement, thread_id, tool_call_id, start, through_seq)?
            else {
                return Ok(None);
            };
            // Deltas can arrive just after the completion row on providers
            // that flush their stream asynchronously. Keep the caller's
            // snapshot barrier so hydration matches the live projection.
            let stream = read_tool_stream_at_start(c, thread_id, tool_call_id, start, through_seq, include_stream)?;
            let stream_omitted = !include_stream && stream.is_some();
            let stream = include_stream.then_some(stream).flatten();
            Ok(Some(SavedToolResult { output, is_error, stream, stream_omitted }))
        })
    }

    /// Hydrate only the page, preserving its sequence barrier and row identities.
    /// Decode all requested values before publishing any, so corrupt data cannot
    /// leave a partially hydrated response. Move the last use of each value.
    pub fn hydrate_tool_outputs_through(&self, thread_id: ThreadId, entries: &mut [TranscriptEntry], through_seq: EventSeq) -> Result<()> {
        let mut remaining = std::collections::HashMap::new();
        for entry in entries.iter() {
            if let TranscriptEntry::ToolCall { seq, call, complete: true, output_omitted: true, .. } = entry {
                *remaining.entry((*seq, call.id.clone())).or_insert(0usize) += 1;
            }
        }
        if remaining.is_empty() {
            return Ok(());
        }
        let mut outputs = self.with(|c| {
            let mut statement = c.prepare_cached(TOOL_OUTPUT_AT_START_SQL)?;
            let mut outputs = std::collections::HashMap::new();
            for entry in entries.iter() {
                if let TranscriptEntry::ToolCall { seq, call, complete: true, output_omitted: true, .. } = entry
                    && let std::collections::hash_map::Entry::Vacant(slot) = outputs.entry((*seq, call.id.clone()))
                {
                    slot.insert(read_tool_output_at_start(&mut statement, thread_id, &call.id, *seq, through_seq)?);
                }
            }
            Ok(outputs)
        })?;
        for entry in entries {
            if let TranscriptEntry::ToolCall { seq, call, output, output_omitted, is_error, complete: true, .. } = entry {
                if !*output_omitted {
                    continue;
                }
                let key = (*seq, call.id.clone());
                let uses = remaining.get_mut(&key).expect("requested omitted row");
                *uses -= 1;
                let result = if *uses == 0 { outputs.remove(&key).flatten() } else { outputs.get(&key).cloned().flatten() };
                if let Some((value, error)) = result {
                    *output = Some(value);
                    *is_error = error;
                    *output_omitted = false;
                }
            }
        }
        Ok(())
    }

    pub fn runtime_tasks_for_thread_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<RuntimeTask>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE thread_id = ?1 AND seq <= ?2 AND kind IN ('runtime_task_started', 'runtime_task_updated', 'runtime_task_completed', 'provider_session_bound')
                 ORDER BY seq",
            )?;
            let events = st.query_map(params![thread_id.to_string(), through_seq], row_to_event)?.collect::<Result<Vec<_>, _>>()?;
            Ok(project_runtime_tasks(&events))
        })
    }

    pub fn provider_usage_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<ProviderUsage> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE thread_id = ?1 AND seq <= ?2 AND kind = 'provider_usage_updated'
                 ORDER BY seq",
            )?;
            let events = st.query_map(params![thread_id.to_string(), through_seq], row_to_event)?.collect::<Result<Vec<_>, _>>()?;
            Ok(project_provider_usage(&events))
        })
    }

    pub fn pending_questions_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<AsyncQuestionRequest>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE thread_id = ?1 AND seq <= ?2 AND kind IN ('async_questions_requested', 'async_questions_answered')
                 ORDER BY seq",
            )?;
            let events = st.query_map(params![thread_id.to_string(), through_seq], row_to_event)?.collect::<Result<Vec<_>, _>>()?;
            Ok(project_pending_questions(&events))
        })
    }

    pub fn provider_commands_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<ProviderCommand>> {
        self.with(|c| {
            let payload: Option<String> = c
                .query_row(
                    "SELECT payload FROM events
                     WHERE thread_id = ?1 AND seq <= ?2 AND kind = 'provider_commands_updated'
                     ORDER BY seq DESC LIMIT 1",
                    params![thread_id.to_string(), through_seq],
                    |row| row.get(0),
                )
                .optional()?;
            match payload {
                None => Ok(Vec::new()),
                Some(text) => match serde_json::from_str::<EventPayload>(&text)? {
                    EventPayload::ProviderCommandsUpdated { commands } => Ok(commands),
                    _ => Ok(Vec::new()),
                },
            }
        })
    }

    pub fn runtime_tasks_for_thread(&self, thread_id: ThreadId) -> Result<Vec<RuntimeTask>> {
        self.runtime_tasks_for_thread_through(thread_id, i64::MAX)
    }

    // ---- approvals ----

    pub fn approval_insert(&self, a: &ApprovalRequest) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO approvals(id, thread_id, turn_id, payload, resolved, decision, created_at) VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5)",
                params![a.id.to_string(), a.thread_id.to_string(), a.turn_id.to_string(), serde_json::to_string(a)?, a.created_at.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    /// Record the answer. A secret answer is stored redacted (see
    /// [`ApprovalRequest::redacted_decision`]); the caller delivers the original.
    pub fn approval_resolve(&self, id: ApprovalId, decision: &ApprovalDecision) -> Result<()> {
        self.with(|c| {
            let stored = match approval_row(c, id)? {
                Some((approval, _)) => approval.redacted_decision(decision),
                None => decision.clone(),
            };
            c.execute(
                "UPDATE approvals SET resolved = 1, decision = ?2 WHERE id = ?1",
                params![id.to_string(), serde_json::to_string(&stored)?],
            )?;
            Ok(())
        })
    }

    pub fn approval_get(&self, id: ApprovalId) -> Result<Option<(ApprovalRequest, bool)>> {
        self.with(|c| approval_row(c, id))
    }

    /// The recorded decision of a resolved request (a secret answer redacted), `None` while it waits.
    pub fn approval_decision(&self, id: ApprovalId) -> Result<Option<ApprovalDecision>> {
        self.with(|c| {
            let text: Option<Option<String>> =
                c.query_row("SELECT decision FROM approvals WHERE id = ?1 AND resolved = 1", [id.to_string()], |r| r.get(0)).optional()?;
            Ok(text.flatten().and_then(|text| serde_json::from_str(&text).ok()))
        })
    }

    pub fn approvals_pending(&self, thread_id: Option<ThreadId>) -> Result<Vec<ApprovalRequest>> {
        self.with(|c| {
            let (sql, arg) = match thread_id {
                Some(t) => ("SELECT payload FROM approvals WHERE resolved = 0 AND thread_id = ?1 ORDER BY created_at", t.to_string()),
                None => ("SELECT payload FROM approvals WHERE resolved = 0 AND ?1 = ?1 ORDER BY created_at", String::new()),
            };
            let mut st = c.prepare(sql)?;
            let rows = st.query_map([arg], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(serde_json::from_str(&r?)?);
            }
            Ok(out)
        })
    }

    // ---- checkpoints ----

    pub fn checkpoint_upsert(&self, c: &Checkpoint) -> Result<()> {
        self.with(|conn| {
            let tx = conn.unchecked_transaction()?;
            // Group checkpoints: a later write (the turn's end) fills `after` per member
            // and keeps the `before` each member was snapshotted with.
            let repos = if c.repos.is_empty() {
                None
            } else {
                let existing: Option<String> = tx
                    .query_row("SELECT repos FROM checkpoints WHERE turn_id = ?1", [c.turn_id.to_string()], |r| r.get(0))
                    .optional()?
                    .flatten();
                let mut merged: Vec<RepoCheckpoint> = existing.map(|json| serde_json::from_str(&json)).transpose()?.unwrap_or_default();
                for repo in &c.repos {
                    match merged.iter_mut().find(|known| known.repo == repo.repo) {
                        Some(known) => known.after = repo.after.clone().or(known.after.take()),
                        None => merged.push(repo.clone()),
                    }
                }
                Some(serde_json::to_string(&merged)?)
            };
            tx.execute(
                "INSERT INTO checkpoints(turn_id, thread_id, before_commit, after_commit, created_at, provider_turn_id, provider_turn_end, repos, incomplete)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(turn_id) DO UPDATE SET after_commit = excluded.after_commit,
                    provider_turn_id = COALESCE(excluded.provider_turn_id, checkpoints.provider_turn_id),
                    provider_turn_end = COALESCE(excluded.provider_turn_end, checkpoints.provider_turn_end),
                    repos = COALESCE(excluded.repos, checkpoints.repos),
                    incomplete = MAX(excluded.incomplete, checkpoints.incomplete)",
                params![
                    c.turn_id.to_string(),
                    c.thread_id.to_string(),
                    c.before,
                    c.after,
                    c.created_at.to_rfc3339(),
                    c.provider_turn_id,
                    c.provider_turn_end,
                    repos,
                    c.incomplete
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn checkpoint_get(&self, turn_id: TurnId) -> Result<Option<Checkpoint>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT turn_id, thread_id, before_commit, after_commit, created_at, provider_turn_id, provider_turn_end, repos, incomplete FROM checkpoints WHERE turn_id = ?1",
                    [turn_id.to_string()],
                    row_to_checkpoint,
                )
                .optional()?)
        })
    }

    pub fn checkpoints_for_thread(&self, thread_id: ThreadId) -> Result<Vec<Checkpoint>> {
        self.with(|conn| {
            let mut st = conn.prepare(
                "SELECT turn_id, thread_id, before_commit, after_commit, created_at, provider_turn_id, provider_turn_end, repos, incomplete FROM checkpoints WHERE thread_id = ?1 ORDER BY created_at",
            )?;
            Ok(st.query_map([thread_id.to_string()], row_to_checkpoint)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    // ---- usage ----

    pub fn usage_insert(&self, u: &TurnUsageRow) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO turn_usage(turn_id, thread_id, provider_kind, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    u.turn_id.to_string(),
                    u.thread_id.to_string(),
                    u.provider.as_str(),
                    u.model,
                    u.usage.input_tokens as i64,
                    u.usage.output_tokens as i64,
                    u.usage.cache_read_tokens as i64,
                    u.usage.cache_write_tokens as i64,
                    u.cost_usd,
                    u.duration_ms as i64,
                    u.at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })
    }

    pub fn usage_summary(&self, since: Option<DateTime<Utc>>, group: methods::UsageGroup) -> Result<Vec<methods::UsageRow>> {
        self.with(|c| {
            let key_expr = match group {
                methods::UsageGroup::Provider => "provider_kind",
                methods::UsageGroup::Model => "COALESCE(model, '(default)')",
                methods::UsageGroup::Day => "substr(at, 1, 10)",
                methods::UsageGroup::Thread => "thread_id",
            };
            let sql = format!(
                "SELECT {key_expr} AS k, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), COALESCE(SUM(cost_usd), 0)
                 FROM turn_usage WHERE at >= ?1 GROUP BY k ORDER BY k"
            );
            let since = since.map(|s| s.to_rfc3339()).unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map([since], |r| {
                Ok(methods::UsageRow {
                    key: r.get::<_, String>(0)?,
                    turns: r.get::<_, i64>(1)? as u64,
                    usage: Usage {
                        input_tokens: r.get::<_, i64>(2)? as u64,
                        output_tokens: r.get::<_, i64>(3)? as u64,
                        cache_read_tokens: r.get::<_, i64>(4)? as u64,
                        cache_write_tokens: r.get::<_, i64>(5)? as u64,
                    },
                    cost_usd: r.get::<_, f64>(6)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Latest reported plan limits per provider, folded from stored
    /// `provider_usage_updated` events. Last report wins: the most recent event
    /// (highest seq) for each window is authoritative, even if its percentage is
    /// lower than an earlier report (a window can reset, or usage can be re-read).
    pub fn latest_provider_limits(&self) -> Result<Vec<methods::ProviderLimits>> {
        use std::collections::BTreeMap;
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT t.provider_kind, e.payload, e.at FROM events e
                 JOIN threads t ON t.id = e.thread_id
                 WHERE e.kind = 'provider_usage_updated' ORDER BY e.seq ASC",
            )?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            let mut by_provider: BTreeMap<String, BTreeMap<String, UsageLimit>> = BTreeMap::new();
            let mut reported_at: BTreeMap<String, String> = BTreeMap::new();
            for row in rows {
                let (provider, payload, at) = row?;
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
                let Some(limits) = value.get("usage").and_then(|u| u.get("limits")).and_then(|l| l.as_array()) else {
                    continue;
                };
                reported_at.insert(provider.clone(), at);
                let windows = by_provider.entry(provider).or_default();
                // Rows arrive in seq order, so a later event overwrites an earlier one.
                for entry in limits {
                    let Ok(limit) = serde_json::from_value::<UsageLimit>(entry.clone()) else { continue };
                    let key = limit.window_minutes.map(|w| w.to_string()).unwrap_or_else(|| limit.name.clone());
                    windows.insert(key, limit);
                }
            }
            let providers = by_provider
                .into_iter()
                .filter_map(|(kind, windows)| {
                    let provider = kind.parse::<ProviderKind>().ok()?;
                    if windows.is_empty() {
                        return None;
                    }
                    let mut limits: Vec<UsageLimit> = windows.into_values().collect();
                    limits.sort_by_key(|l| l.window_minutes.unwrap_or(u64::MAX));
                    let updated_at =
                        reported_at.get(&kind).and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at| at.to_utc());
                    Some(methods::ProviderLimits {
                        provider,
                        limits,
                        updated_at,
                        source: Some(methods::LimitsSource::Stored),
                        plan: None,
                        stale: None,
                        retry_at: None,
                        instance: None,
                    })
                })
                .collect();
            Ok(providers)
        })
    }

    // ---- push tokens (mobile, later) ----

    pub fn push_token_upsert(&self, token: &str, platform: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO device_push_tokens(token, platform, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(token) DO UPDATE SET platform = excluded.platform",
                params![token, platform, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }
}

/// Runtime tasks are created before SQLite assigns the enclosing event's
/// sequence. Stamp the durable launch/update anchors into the payload inside
/// the same store lock, then persist and broadcast that canonical snapshot.
fn stamp_runtime_task_sequence(payload: &mut EventPayload, seq: EventSeq) -> bool {
    let task = match payload {
        EventPayload::RuntimeTaskStarted { task }
        | EventPayload::RuntimeTaskUpdated { task }
        | EventPayload::RuntimeTaskCompleted { task } => task,
        _ => return false,
    };
    if task.started_seq == 0 {
        task.started_seq = seq;
    }
    task.updated_seq = seq;
    true
}

const THREAD_SELECT: &str = "SELECT id, project_id, title, provider_kind, provider_instance, model, effort, permission_mode, status,
    worktree_path, worktree_branch, cwd, provider_session_id, pinned, created_at, updated_at, last_seq,
    parent_thread_id, coordinator_project_id, subagent, delegation, members FROM threads";

const THREAD_MESSAGE_SELECT: &str = "SELECT id, operation_id, from_thread_id, to_thread_id, purpose, reply_to, body, delivery, state,
    held_reason, created_at, updated_at FROM thread_messages";

fn enum_from_column<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(value)).map_err(other)
}

fn row_to_thread_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadMessageRecord> {
    Ok(ThreadMessageRecord {
        id: parse_uuid(r.get::<_, String>(0)?)?,
        operation_id: parse_uuid(r.get::<_, String>(1)?)?,
        from_thread_id: r.get::<_, Option<String>>(2)?.map(parse_uuid).transpose()?,
        to_thread_id: parse_uuid(r.get::<_, String>(3)?)?,
        purpose: enum_from_column(r.get::<_, String>(4)?)?,
        reply_to: r.get::<_, Option<String>>(5)?.map(parse_uuid).transpose()?,
        body: r.get(6)?,
        delivery: enum_from_column(r.get::<_, String>(7)?)?,
        state: enum_from_column(r.get::<_, String>(8)?)?,
        held_reason: r.get(9)?,
        created_at: parse_time(r.get::<_, String>(10)?)?,
        updated_at: parse_time(r.get::<_, String>(11)?)?,
    })
}

/// The stored form of a project's Coordinator overrides; none when it has no override.
fn coordinator_json(project: &Project) -> rusqlite::Result<Option<String>> {
    project
        .coordinator
        .as_ref()
        .filter(|overrides| !overrides.is_empty())
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn row_to_project(r: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: parse_uuid(r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        path: r.get(2)?,
        is_git: r.get(3)?,
        worktrees_default: r.get(4)?,
        task_prefix: r.get(7)?,
        brief_in_all_threads: r.get(8)?,
        coordinator: r
            .get::<_, Option<String>>(9)?
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error)))?,
        space_id: r.get::<_, Option<String>>(10)?.map(parse_uuid).transpose()?,
        created_at: parse_time(r.get::<_, String>(5)?)?,
        updated_at: parse_time(r.get::<_, String>(6)?)?,
        kind: groups::parse_kind(&r.get::<_, String>(11)?),
        members: Vec::new(),
        instructions_offer_dismissed: r.get(12)?,
        worktree_copy: r
            .get::<_, Option<String>>(13)?
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| rusqlite::Error::FromSqlConversionFailure(13, rusqlite::types::Type::Text, Box::new(error)))?
            .unwrap_or_default(),
    })
}

const PROJECT_SELECT: &str = "SELECT id, name, path, is_git, worktrees_default, created_at, updated_at, task_prefix, brief_in_all_threads,
    coordinator, space_id, kind, instructions_offer_dismissed, worktree_copy FROM projects";

fn with_members(c: &Connection, project: Option<Project>) -> Result<Option<Project>> {
    let Some(project) = project else { return Ok(None) };
    let mut one = [project];
    groups::attach_members(c, &mut one)?;
    let [project] = one;
    Ok(Some(project))
}

fn worktree_copy_json(project: &Project) -> rusqlite::Result<Option<String>> {
    if project.worktree_copy.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(&project.worktree_copy).map(Some).map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn row_to_thread(r: &rusqlite::Row<'_>) -> rusqlite::Result<Thread> {
    let kind: String = r.get(3)?;
    let mode: String = r.get(7)?;
    let status: String = r.get(8)?;
    let wt_path: Option<String> = r.get(9)?;
    let wt_branch: Option<String> = r.get(10)?;
    Ok(Thread {
        id: parse_uuid(r.get::<_, String>(0)?)?,
        project_id: parse_uuid(r.get::<_, String>(1)?)?,
        title: r.get(2)?,
        provider: ProviderInstance { kind: kind.parse().map_err(|e: String| other(std::io::Error::other(e)))?, instance: r.get(4)? },
        model: r.get(5)?,
        effort: r.get(6)?,
        permission_mode: serde_json::from_value(serde_json::Value::String(mode)).map_err(other)?,
        status: serde_json::from_value(serde_json::Value::String(status)).map_err(other)?,
        worktree: match (wt_path, wt_branch) {
            (Some(path), Some(branch)) => Some(WorktreeInfo { path, branch }),
            _ => None,
        },
        cwd: r.get(11)?,
        provider_session_id: r.get(12)?,
        pinned: r.get(13)?,
        created_at: parse_time(r.get::<_, String>(14)?)?,
        updated_at: parse_time(r.get::<_, String>(15)?)?,
        last_seq: r.get(16)?,
        parent_thread_id: r.get::<_, Option<String>>(17)?.map(parse_uuid).transpose()?,
        coordinator_project_id: r.get::<_, Option<String>>(18)?.map(parse_uuid).transpose()?,
        subagent: r.get::<_, Option<String>>(19)?.map(|json| serde_json::from_str(&json).map_err(other)).transpose()?,
        delegation: r.get::<_, Option<String>>(20)?.map(|json| serde_json::from_str(&json).map_err(other)).transpose()?,
        members: r.get::<_, Option<String>>(21)?.map(|json| serde_json::from_str(&json).map_err(other)).transpose()?.unwrap_or_default(),
    })
}

fn row_to_checkpoint(r: &rusqlite::Row<'_>) -> rusqlite::Result<Checkpoint> {
    Ok(Checkpoint {
        turn_id: parse_uuid(r.get::<_, String>(0)?)?,
        thread_id: parse_uuid(r.get::<_, String>(1)?)?,
        before: r.get(2)?,
        after: r.get(3)?,
        created_at: parse_time(r.get::<_, String>(4)?)?,
        provider_turn_id: r.get(5)?,
        provider_turn_end: r.get(6)?,
        repos: r.get::<_, Option<String>>(7)?.map(|json| serde_json::from_str(&json).map_err(other)).transpose()?.unwrap_or_default(),
        incomplete: r.get(8)?,
    })
}

const TOOL_OUTPUT_AT_START_SQL: &str = "
    SELECT c.seq, c.payload FROM events c
    WHERE c.thread_id = ?1 AND c.kind = 'tool_call_completed'
      AND json_extract(c.payload, '$.tool_call_id') = ?2
      AND c.seq > ?3 AND c.seq <= ?4
      AND EXISTS (SELECT 1 FROM events s WHERE s.seq = ?3 AND s.thread_id = ?1
                  AND s.kind = 'tool_call_started' AND json_extract(s.payload, '$.call.id') = ?2)
      AND NOT EXISTS (SELECT 1 FROM events n WHERE n.thread_id = ?1
                      AND n.seq > ?3 AND n.seq <= c.seq AND n.kind = 'tool_call_started'
                      AND json_extract(n.payload, '$.call.id') = ?2)
    ORDER BY c.seq DESC LIMIT 1";

fn read_tool_completion_at_start(
    statement: &mut rusqlite::Statement<'_>,
    thread_id: ThreadId,
    tool_call_id: &str,
    start_seq: EventSeq,
    through_seq: EventSeq,
) -> Result<Option<(EventSeq, serde_json::Value, bool)>> {
    let mut rows = statement.query(params![thread_id.to_string(), tool_call_id, start_seq, through_seq])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let seq = row.get(0)?;
    let payload: EventPayload = serde_json::from_str(row.get_ref(1)?.as_str()?)?;
    match payload {
        EventPayload::ToolCallCompleted { output, is_error, .. } => Ok(Some((seq, output, is_error))),
        _ => anyhow::bail!("invalid stored tool completion"),
    }
}

fn read_tool_output_at_start(
    statement: &mut rusqlite::Statement<'_>,
    thread_id: ThreadId,
    tool_call_id: &str,
    start_seq: EventSeq,
    through_seq: EventSeq,
) -> Result<Option<(serde_json::Value, bool)>> {
    Ok(read_tool_completion_at_start(statement, thread_id, tool_call_id, start_seq, through_seq)?
        .map(|(_, output, is_error)| (output, is_error)))
}

fn read_tool_stream_at_start(
    c: &Connection,
    thread_id: ThreadId,
    tool_call_id: &str,
    start_seq: EventSeq,
    through_seq: EventSeq,
    include_stream: bool,
) -> Result<Option<String>> {
    let sql = if include_stream {
        "SELECT json_extract(d.payload, '$.delta') FROM events d
         WHERE d.thread_id = ?1 AND d.kind = 'tool_call_output_delta'
           AND d.seq > ?2 AND d.seq <= ?3
           AND json_extract(d.payload, '$.tool_call_id') = ?4
           AND NOT EXISTS (
             SELECT 1 FROM events s
             WHERE s.thread_id = ?1 AND s.kind = 'tool_call_started'
               AND s.seq > ?2 AND s.seq <= d.seq
               AND json_extract(s.payload, '$.call.id') = ?4
           )
         ORDER BY d.seq"
    } else {
        "SELECT 1 FROM events d
         WHERE d.thread_id = ?1 AND d.kind = 'tool_call_output_delta'
           AND d.seq > ?2 AND d.seq <= ?3
           AND json_extract(d.payload, '$.tool_call_id') = ?4
           AND NOT EXISTS (
             SELECT 1 FROM events s
             WHERE s.thread_id = ?1 AND s.kind = 'tool_call_started'
               AND s.seq > ?2 AND s.seq <= d.seq
               AND json_extract(s.payload, '$.call.id') = ?4
           )
         LIMIT 1"
    };
    if !include_stream {
        return Ok(c
            .query_row(sql, params![thread_id.to_string(), start_seq, through_seq, tool_call_id], |row| row.get::<_, i64>(0))
            .optional()?
            .map(|_| String::new()));
    }
    let mut statement = c.prepare_cached(sql)?;
    let mut rows = statement.query(params![thread_id.to_string(), start_seq, through_seq, tool_call_id])?;
    let mut stream = None;
    while let Some(row) = rows.next()? {
        let delta: String = row.get(0)?;
        stream.get_or_insert_with(String::new).push_str(&delta);
    }
    Ok(stream)
}

fn row_to_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadEvent> {
    let payload: String = r.get(4)?;
    let turn: Option<String> = r.get(2)?;
    Ok(ThreadEvent {
        seq: r.get(0)?,
        thread_id: parse_uuid(r.get::<_, String>(1)?)?,
        turn_id: turn.map(parse_uuid).transpose()?,
        at: parse_time(r.get::<_, String>(3)?)?,
        payload: serde_json::from_str(&payload).map_err(other)?,
    })
}

#[derive(serde::Deserialize)]
struct BorrowedToolCompletion<'a> {
    tool_call_id: String,
    #[serde(borrow)]
    output: &'a serde_json::value::RawValue,
    #[serde(default)]
    output_omitted: bool,
    is_error: bool,
}

fn compact_or_decode_tool_completion(payload: &str, preserve_omission: bool) -> std::result::Result<EventPayload, serde_json::Error> {
    let raw: BorrowedToolCompletion<'_> = serde_json::from_str(payload)?;
    let output = if (preserve_omission && raw.output_omitted) || raw.output.get().len() <= LARGE_TOOL_OUTPUT_BYTES {
        serde_json::from_str(raw.output.get())?
    } else {
        serde_json::Value::Null
    };
    Ok(EventPayload::ToolCallCompleted {
        tool_call_id: raw.tool_call_id,
        output,
        output_omitted: (preserve_omission && raw.output_omitted) || raw.output.get().len() > LARGE_TOOL_OUTPUT_BYTES,
        stream_recoverable: false,
        is_error: raw.is_error,
    })
}

fn row_to_projection_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadEvent> {
    // The legacy stored projection decides omission from the persisted value,
    // rather than trusting a transport-only omission marker in imported logs.
    row_to_compact_event_inner(r, false)
}

fn row_to_compact_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadEvent> {
    row_to_compact_event_inner(r, true)
}

fn row_to_compact_event_inner(r: &rusqlite::Row<'_>, preserve_omission: bool) -> rusqlite::Result<ThreadEvent> {
    let kind: String = r.get(4)?;
    let payload = r.get_ref(5)?.as_str()?;
    let turn: Option<String> = r.get(2)?;
    let payload = if kind == "tool_call_completed" {
        compact_or_decode_tool_completion(payload, preserve_omission).map_err(other)?
    } else if kind == "tool_call_output_delta" && !preserve_omission {
        // The projection keeps which invocation streamed, not what it printed.
        #[derive(serde::Deserialize)]
        struct Identity {
            tool_call_id: String,
        }
        let Identity { tool_call_id } = serde_json::from_str(payload).map_err(other)?;
        EventPayload::ToolCallOutputDelta { tool_call_id, delta: String::new() }
    } else {
        serde_json::from_str(payload).map_err(other)?
    };
    Ok(ThreadEvent {
        seq: r.get(0)?,
        thread_id: parse_uuid(r.get::<_, String>(1)?)?,
        turn_id: turn.map(parse_uuid).transpose()?,
        at: parse_time(r.get::<_, String>(3)?)?,
        payload,
    })
}

fn parse_uuid(s: String) -> rusqlite::Result<Uuid> {
    s.parse().map_err(other)
}

fn parse_time(s: String) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&s).map(|t| t.with_timezone(&Utc)).map_err(other)
}

fn other<E: std::error::Error + Send + Sync + 'static>(e: E) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}

fn write_thread(c: &Connection, t: &Thread) -> Result<()> {
    c.execute(
        "INSERT INTO threads(id, project_id, title, provider_kind, provider_instance, model, effort, permission_mode,
                    status, worktree_path, worktree_branch, cwd, provider_session_id, pinned, created_at, updated_at, last_seq,
                    parent_thread_id, coordinator_project_id, subagent, delegation, members)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                 ON CONFLICT(id) DO UPDATE SET
                    provider_kind = excluded.provider_kind, provider_instance = excluded.provider_instance,
                    title = excluded.title, model = excluded.model, effort = excluded.effort, permission_mode = excluded.permission_mode,
                    status = excluded.status, worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch,
                    cwd = excluded.cwd, provider_session_id = excluded.provider_session_id, pinned = excluded.pinned,
                    updated_at = excluded.updated_at, last_seq = excluded.last_seq,
                    parent_thread_id = COALESCE(threads.parent_thread_id, excluded.parent_thread_id),
                    coordinator_project_id = excluded.coordinator_project_id,
                    subagent = COALESCE(excluded.subagent, threads.subagent),
                    delegation = COALESCE(excluded.delegation, threads.delegation),
                    members = COALESCE(excluded.members, threads.members)",
        params![
            t.id.to_string(),
            t.project_id.to_string(),
            t.title,
            t.provider.kind.as_str(),
            t.provider.instance,
            t.model,
            t.effort,
            serde_json::to_value(t.permission_mode)?.as_str().unwrap().to_string(),
            serde_json::to_value(t.status)?.as_str().unwrap().to_string(),
            t.worktree.as_ref().map(|w| w.path.clone()),
            t.worktree.as_ref().map(|w| w.branch.clone()),
            t.cwd,
            t.provider_session_id,
            t.pinned,
            t.created_at.to_rfc3339(),
            t.updated_at.to_rfc3339(),
            t.last_seq,
            t.parent_thread_id.map(|id| id.to_string()),
            t.coordinator_project_id.map(|id| id.to_string()),
            t.subagent.as_ref().map(serde_json::to_string).transpose()?,
            t.delegation.as_ref().map(serde_json::to_string).transpose()?,
            (!t.members.is_empty()).then(|| serde_json::to_string(&t.members)).transpose()?,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_for_thread_reads_every_event_in_order_across_bounded_batches() {
        let (store, thread) = thread_fixture();
        // More events than one batch holds, and payloads that end batches by size first.
        let big = "x".repeat(40 * 1024);
        for i in 0..700 {
            let text = if i % 50 == 0 { big.clone() } else { format!("event {i}") };
            store.event_append(thread.id, None, EventPayload::ProviderNotice { level: NoticeLevel::Info, text, data: None }).unwrap();
        }
        let events = store.events_for_thread(thread.id).unwrap();
        assert_eq!(events.len(), 700);
        assert!(events.windows(2).all(|pair| pair[0].seq < pair[1].seq));
        let through = events[400].seq;
        assert_eq!(store.events_for_thread_through(thread.id, through).unwrap().len(), 401);
    }

    #[test]
    fn message_texts_containing_returns_only_the_threads_own_message_text() {
        let (store, thread) = thread_fixture();
        let shot = "/Users/someone/Desktop/booking \"form\" 7 h spät.png";
        store
            .event_append(
                thread.id,
                None,
                EventPayload::AssistantMessageCompleted {
                    message_id: Uuid::now_v7(),
                    origin: EventOrigin::Root,
                    text: format!("![Booking form]({shot})"),
                    thinking: None,
                },
            )
            .unwrap();
        // Many later messages: the search walks back across bounded batches.
        for i in 0..300 {
            store
                .event_append(
                    thread.id,
                    None,
                    EventPayload::AssistantMessageCompleted {
                        message_id: Uuid::now_v7(),
                        origin: EventOrigin::Root,
                        text: format!("reply {i}"),
                        thinking: None,
                    },
                )
                .unwrap();
        }
        store
            .event_append(
                thread.id,
                None,
                EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "/tmp/notice.png".into(), data: None },
            )
            .unwrap();
        store
            .event_append(
                thread.id,
                None,
                EventPayload::AssistantMessageCompleted {
                    message_id: Uuid::now_v7(),
                    origin: EventOrigin::Root,
                    text: "done".into(),
                    thinking: Some("/tmp/thought.png".into()),
                },
            )
            .unwrap();
        // Walk back batch by batch, as the image route does.
        let texts = |needle: &str, id: ThreadId| {
            let (mut all, mut before, mut batches) = (Vec::new(), i64::MAX, 0);
            loop {
                let (texts, next) = store.thread_message_texts_containing(id, needle, 0, before).unwrap();
                all.extend(texts);
                batches += 1;
                match next {
                    Some(seq) => before = seq,
                    None => return (all, batches),
                }
            }
        };
        let (found, batches) = texts(shot, thread.id);
        assert_eq!(found, [format!("![Booking form]({shot})")]);
        assert!(batches > 2, "the search walks back across bounded batches");
        assert!(texts("/Users/someone/Desktop/other.png", thread.id).0.is_empty());
        assert!(texts("/tmp/notice.png", thread.id).0.is_empty(), "only messages count, not notices");
        assert_eq!(texts("/tmp/thought.png", thread.id).0, ["done"], "the payload matched, but only the reply text is returned");
        assert!(texts(shot, Uuid::now_v7()).0.is_empty());
        let last = store.thread_last_message_seq(thread.id).unwrap();
        assert!(last > 0);
        assert_eq!(store.thread_message_texts_containing(thread.id, "reply", last, i64::MAX).unwrap(), (Vec::new(), None));
    }

    fn thread_fixture() -> (Store, Thread) {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "demo".into(),
            path: "/tmp/demo".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "hello".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        store.thread_upsert(&thread).unwrap();
        (store, thread)
    }

    #[test]
    fn thread_updates_persist_the_admitted_harness_and_account() {
        let (store, mut thread) = thread_fixture();
        let original = thread.provider.clone();
        thread.provider = ProviderInstance { kind: ProviderKind::ClaudeCode, instance: "work".into() };
        thread.provider_session_id = Some("work-native".into());
        store.thread_upsert(&thread).unwrap();
        let saved = store.thread_get(thread.id).unwrap().unwrap();
        assert_eq!(saved.provider, thread.provider);
        assert_eq!(saved.provider_session_id, thread.provider_session_id);
        thread.provider = original;
        thread.provider_session_id = Some("original-native".into());
        store.thread_upsert(&thread).unwrap();
        assert_eq!(store.thread_get(thread.id).unwrap().unwrap().provider, thread.provider);
    }

    #[test]
    fn native_import_is_atomic_and_deduplicates_archived_threads() {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "Import".into(),
            path: "/tmp/import".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "Native history".into(),
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: Some("native-session".into()),
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        let history = vec![ThreadEvent {
            seq: 999,
            thread_id: Uuid::now_v7(),
            turn_id: Some(Uuid::now_v7()),
            at: now,
            payload: EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("Original prompt") },
        }];
        store.with(|c| { c.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON events WHEN NEW.kind = 'session_imported' BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?; Ok(()) }).unwrap();
        assert!(store.thread_import(thread.clone(), history.clone()).is_err());
        assert!(store.thread_get(thread.id).unwrap().is_none());
        assert!(store.events_for_thread(thread.id).unwrap().is_empty());
        store
            .with(|c| {
                c.execute_batch("DROP TRIGGER reject_import")?;
                Ok(())
            })
            .unwrap();
        let (mut imported, events) = store.thread_import(thread.clone(), history.clone()).unwrap();
        assert_eq!(events.len(), 3);
        assert!(events.iter().all(|event| event.thread_id == thread.id));
        assert_eq!(imported.last_seq, events.last().unwrap().seq);
        assert_eq!(store.events_for_thread(thread.id).unwrap().len(), 3);
        imported.status = ThreadStatus::Archived;
        store.thread_upsert(&imported).unwrap();
        let mut retry = thread;
        retry.id = Uuid::now_v7();
        let (duplicate, events) = store.thread_import(retry.clone(), history).unwrap();
        assert_eq!(duplicate.id, imported.id);
        assert_eq!(duplicate.status, ThreadStatus::Archived);
        assert!(events.is_empty());
        assert!(store.thread_get(retry.id).unwrap().is_none());
        assert_eq!(store.events_for_thread(imported.id).unwrap().len(), 3);
    }

    #[test]
    fn live_project_git_updates_preserve_edits_and_skip_unchanged_or_removed_records() {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "demo".into(),
            path: "/tmp/demo".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let mut edited = store.project_get(project.id).unwrap().unwrap();
        edited.name = "Renamed".into();
        edited.worktrees_default = Some(true);
        store.project_update(&edited).unwrap();

        assert!(store.project_set_git_status(project.id, true).unwrap());
        let updated = store.project_get(project.id).unwrap().unwrap();
        assert!(updated.is_git);
        assert_eq!(updated.name, edited.name);
        assert_eq!(updated.worktrees_default, edited.worktrees_default);
        assert_eq!(updated.task_prefix, edited.task_prefix);
        assert!(!store.project_set_git_status(project.id, true).unwrap());
        assert_eq!(store.project_get(project.id).unwrap().unwrap().updated_at, updated.updated_at);
        assert!(store.project_set_git_status(project.id, false).unwrap());
        store.project_delete(project.id).unwrap();
        assert!(!store.project_set_git_status(project.id, true).unwrap());
        assert!(store.project_get(project.id).unwrap().is_none());
    }

    #[test]
    fn roundtrip_project_thread_events() {
        let s = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let p = Project {
            id: Uuid::now_v7(),
            name: "demo".into(),
            path: "/tmp/demo".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        s.project_insert(&p).unwrap();
        let t = Thread {
            id: Uuid::now_v7(),
            project_id: p.id,
            title: "hello".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: Some("high".into()),
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: p.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        s.thread_upsert(&t).unwrap();
        let e = s.event_append(t.id, None, EventPayload::ThreadCreated { thread: t.clone() }).unwrap();
        assert_eq!(e.seq, 1);
        let turn = Uuid::now_v7();
        s.event_append(t.id, Some(turn), EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("hi") })
            .unwrap();
        let evs = s.events_after(Some(t.id), 0, 10).unwrap();
        assert_eq!(evs.len(), 2);
        let stored = s.thread_get(t.id).unwrap().unwrap();
        assert_eq!(stored.last_seq, 2);
        assert_eq!(stored.effort.as_deref(), Some("high"));
        assert_eq!(s.threads_list(None, false).unwrap().len(), 1);
        let task = RuntimeTask {
            id: "phantom".into(),
            thread_id: t.id,
            origin_turn_id: turn,
            started_seq: 0,
            updated_seq: 0,
            kind: RuntimeTaskKind::Agent,
            status: RuntimeTaskStatus::Waiting,
            title: "Subagent".into(),
            detail: None,
            provider_type: None,
            parent_id: None,
            tool_call_id: None,
            provider_thread_id: Some("root-session".into()),
            model: None,
            effort: None,
            backgrounded: false,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities::default(),
            started_at: now,
            updated_at: now,
            completed_at: None,
        };
        s.event_append(t.id, Some(turn), EventPayload::RuntimeTaskStarted { task }).unwrap();
        assert_eq!(s.runtime_tasks_for_thread(t.id).unwrap().len(), 1);
        s.event_append(t.id, Some(turn), EventPayload::ProviderSessionBound { session_id: "root-session".into(), model: None }).unwrap();
        assert!(s.runtime_tasks_for_thread(t.id).unwrap().is_empty(), "the targeted SQL query must include root bindings");
        assert_eq!(s.events_for_thread(t.id).unwrap().len(), 4, "projection repair must not delete history");
        s.with(|connection| {
            let plan: String = connection.query_row(
                "EXPLAIN QUERY PLAN SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE thread_id = ?1 AND seq <= ?2
                   AND kind IN ('runtime_task_started', 'runtime_task_updated', 'runtime_task_completed', 'provider_session_bound')
                 ORDER BY seq",
                params![t.id.to_string(), i64::MAX],
                |row| row.get(3),
            )?;
            assert!(plan.contains("events_runtime_tasks"), "activity must not scan a thread's message/tool history: {plan}");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn large_tool_outputs_stay_in_sqlite_until_a_page_asks_for_them() {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "tools".into(),
            path: format!("/tmp/{}", Uuid::now_v7()),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "tools".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        store.thread_upsert(&thread).unwrap();
        let turn = Uuid::now_v7();
        store
            .event_append(
                thread.id,
                Some(turn),
                EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("run") },
            )
            .unwrap();
        store
            .event_append(
                thread.id,
                Some(turn),
                EventPayload::ToolCallStarted {
                    call: ToolCall { id: "big".into(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None },
                    origin: EventOrigin::Root,
                },
            )
            .unwrap();
        store
            .event_append(
                thread.id,
                Some(turn),
                EventPayload::ToolCallOutputDelta { tool_call_id: "big".into(), delta: "streamed output\n".repeat(4) },
            )
            .unwrap();
        let output = serde_json::json!("x".repeat(LARGE_TOOL_OUTPUT_BYTES + 8));
        store
            .event_append(
                thread.id,
                Some(turn),
                EventPayload::ToolCallCompleted {
                    tool_call_id: "big".into(),
                    output: output.clone(),
                    output_omitted: false,
                    stream_recoverable: false,
                    is_error: false,
                },
            )
            .unwrap();
        for index in 0..49 {
            let id = format!("big-{index}");
            store
                .event_append(
                    thread.id,
                    Some(turn),
                    EventPayload::ToolCallStarted {
                        call: ToolCall { id: id.clone(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None },
                        origin: EventOrigin::Root,
                    },
                )
                .unwrap();
            store
                .event_append(
                    thread.id,
                    Some(turn),
                    EventPayload::ToolCallCompleted {
                        tool_call_id: id,
                        output: output.clone(),
                        output_omitted: false,
                        stream_recoverable: false,
                        is_error: false,
                    },
                )
                .unwrap();
        }
        let events = store.events_for_thread_through(thread.id, i64::MAX).unwrap();
        let event_bytes = serde_json::to_vec(&events).unwrap().len();
        let transcript = store.project_transcript_through(thread.id, i64::MAX).unwrap();
        let transcript_bytes = serde_json::to_vec(&transcript).unwrap().len();
        assert!(transcript_bytes * 10 < event_bytes, "cached projection {transcript_bytes} should drop the {event_bytes}-byte event log");
        eprintln!("tool-output-omit event_bytes={event_bytes} transcript_bytes={transcript_bytes}");
        let compact_events = store.events_after_bounded_compact(Some(thread.id), 0, 500, 2 * 1024 * 1024).unwrap();
        assert!(compact_events.iter().any(|event| matches!(
            event.payload,
            EventPayload::ToolCallCompleted { output: serde_json::Value::Null, output_omitted: true, .. }
        )));
        let full_events = store.events_after_bounded(Some(thread.id), 0, 500, 2 * 1024 * 1024).unwrap();
        assert!(full_events.iter().any(|event| matches!(
            &event.payload,
            EventPayload::ToolCallCompleted { output: candidate, output_omitted: false, .. } if candidate == &output
        )));
        assert!(matches!(
            transcript.iter().find(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })),
            Some(TranscriptEntry::ToolCall { output: None, output_omitted: true, .. })
        ));
        let mut stream_marked = transcript.clone();
        store.project_transcript_fold_through(thread.id, i64::MAX).unwrap().mark_tool_streams_omitted(&mut stream_marked);
        assert!(matches!(
            stream_marked.iter().find(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })),
            Some(TranscriptEntry::ToolCall { stream_omitted: true, .. })
        ));
        let mut page = transcript.clone();
        store.hydrate_tool_outputs_through(thread.id, &mut page, i64::MAX).unwrap();
        assert_eq!(store.tool_call_output_through(thread.id, "big", None, i64::MAX).unwrap(), Some((output.clone(), false)));
        assert!(matches!(
            page.iter().find(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })),
            Some(TranscriptEntry::ToolCall { output: Some(value), output_omitted: false, .. }) if *value == output
        ));
    }
}

#[cfg(test)]
mod older_page_stream_tests {
    use super::*;

    fn store_with(events: &[(i64, EventPayload)]) -> (Store, ThreadId) {
        let store = Store::open_in_memory().unwrap();
        let thread = ThreadId::new_v4();
        store
            .with(|c| {
                c.execute_batch("PRAGMA foreign_keys = OFF")?;
                for (seq, payload) in events {
                    c.execute(
                        "INSERT INTO events(seq,thread_id,turn_id,at,kind,payload) VALUES (?1,?2,?3,'2026-10-22T00:00:00Z',?4,?5)",
                        params![seq, thread.to_string(), TurnId::nil().to_string(), payload.kind(), serde_json::to_string(payload)?],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        (store, thread)
    }
    fn start(id: &str) -> EventPayload {
        EventPayload::ToolCallStarted {
            call: ToolCall { id: id.into(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None },
            origin: EventOrigin::Root,
        }
    }
    fn delta(id: &str) -> EventPayload {
        EventPayload::ToolCallOutputDelta { tool_call_id: id.into(), delta: "out\n".into() }
    }
    fn done(id: &str) -> EventPayload {
        EventPayload::ToolCallCompleted {
            tool_call_id: id.into(),
            output: serde_json::json!("ok"),
            output_omitted: false,
            stream_recoverable: false,
            is_error: false,
        }
    }
    fn marks(store: &Store, thread: ThreadId, through: EventSeq) -> Vec<(EventSeq, String, bool)> {
        let fold = store.project_transcript_fold_through(thread, through).unwrap();
        let mut rows = fold.rows().to_vec();
        fold.mark_tool_streams_omitted(&mut rows);
        rows.into_iter()
            .filter_map(|row| match row {
                TranscriptEntry::ToolCall { seq, call, stream_omitted, .. } => Some((seq, call.id, stream_omitted)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn page_stream_marks_follow_the_exact_invocation_and_snapshot() {
        let (store, thread) = store_with(&[
            (1, EventPayload::TurnStarted { message_id: MessageId::nil(), message: UserMessage::text("run") }),
            (2, start("a")),
            (3, delta("a")),
            (4, done("a")),
            // A provider reuses the call ID; this invocation streamed nothing.
            (5, start("a")),
            (6, done("a")),
            // A stream flushed just after its completion still belongs to it.
            (7, start("b")),
            (8, done("b")),
            (9, delta("b")),
            (10, start("c")),
            (11, delta("c")),
            (12, done("c")),
        ]);
        assert_eq!(
            marks(&store, thread, 12),
            [(2, "a".into(), true), (5, "a".into(), false), (7, "b".into(), true), (10, "c".into(), true)]
        );
        // The snapshot barrier hides the late flush and the newer invocation.
        assert_eq!(marks(&store, thread, 8), [(2, "a".into(), true), (5, "a".into(), false), (7, "b".into(), false)]);
    }

    #[test]
    fn page_stream_marks_do_not_depend_on_the_page_window() {
        // Tools whose output spans pages, turns and a running snapshot: the
        // marks come from the fold, so where a page starts or ends changes nothing.
        let (store, thread) = store_with(&[
            (1, EventPayload::TurnStarted { message_id: MessageId::nil(), message: UserMessage::text("one") }),
            (2, start("bg")),
            (3, start("quiet")),
            (4, done("quiet")),
            (
                5,
                EventPayload::TurnCompleted {
                    stop_reason: StopReason::Completed,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 1,
                    terminal_message_id: None,
                },
            ),
            (6, EventPayload::TurnStarted { message_id: MessageId::new_v4(), message: UserMessage::text("two") }),
            // A background tool started in turn one streams and completes in turn two.
            (7, delta("bg")),
            (8, start("run")),
            (9, delta("run")),
            (10, done("bg")),
            // `run` streams but is still running at this head.
        ]);
        let all = [(2, "bg".to_string(), true), (3, "quiet".into(), false), (8, "run".into(), false)];
        assert_eq!(marks(&store, thread, 10), all);
        // Before its completion, `bg` is not yet recoverable; after, it is, wherever the page starts.
        assert_eq!(marks(&store, thread, 9)[0], (2, "bg".into(), false));
        let fold = store.project_transcript_fold_through(thread, 10).unwrap();
        for lo in 0..fold.rows().len() {
            for hi in lo..fold.rows().len() {
                let mut page = fold.rows()[lo..=hi].to_vec();
                fold.mark_tool_streams_omitted(&mut page);
                for row in page {
                    if let TranscriptEntry::ToolCall { seq, stream_omitted, .. } = row {
                        let expected = all.iter().find(|(s, ..)| *s == seq).unwrap().2;
                        assert_eq!(stream_omitted, expected, "row {seq} on page {lo}..={hi}");
                    }
                }
            }
        }
    }

    #[test]
    fn page_stream_marks_extend_with_the_fold() {
        // A cached fold extended with newer events equals a fold from scratch.
        let (store, thread) = store_with(&[
            (1, EventPayload::TurnStarted { message_id: MessageId::nil(), message: UserMessage::text("run") }),
            (2, start("a")),
            (3, delta("a")),
            (4, start("b")),
            (5, done("a")),
            (6, delta("b")),
            (7, done("b")),
        ]);
        for split in 1..7 {
            let mut fold = TranscriptFold::omitting_tool_outputs();
            store.extend_transcript_fold(thread, &mut fold, 0, split).unwrap();
            store.extend_transcript_fold(thread, &mut fold, split, 7).unwrap();
            let mut rows = fold.rows().to_vec();
            fold.mark_tool_streams_omitted(&mut rows);
            let marked: Vec<_> = rows
                .iter()
                .filter_map(|row| match row {
                    TranscriptEntry::ToolCall { call, stream_omitted, .. } => Some((call.id.as_str(), *stream_omitted)),
                    _ => None,
                })
                .collect();
            assert_eq!(marked, [("a", true), ("b", true)], "split at {split}");
        }
    }
}

#[cfg(test)]
mod tool_output_allocation_tests {
    use super::*;

    // The real hydration SQL with a small isolated event table. No daemon,
    // migration, provider process, or production data is involved in this fixture.
    fn fixture() -> Store {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE events (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
             CREATE INDEX tool_completion_lookup ON events(thread_id, json_extract(payload, '$.tool_call_id'))
               WHERE kind = 'tool_call_completed';",
        )
        .unwrap();
        Store { conn: Arc::new(Mutex::new(conn)) }
    }

    fn complete(store: &Store, thread: ThreadId, id: &str, output: serde_json::Value, is_error: bool) {
        let payload =
            EventPayload::ToolCallCompleted { tool_call_id: id.into(), output, output_omitted: false, stream_recoverable: false, is_error };
        store.with(|c| {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE thread_id=?1 AND kind='tool_call_started' AND json_extract(payload, '$.call.id')=?2)", params![thread.to_string(), id], |row| row.get(0))?;
            if !exists {
                let start = serde_json::json!({"kind":"tool_call_started","call":{"id":id,"name":"bash","input":{}}});
                c.execute("INSERT INTO events(thread_id,kind,payload) VALUES (?1,'tool_call_started',?2)", params![thread.to_string(), start.to_string()])?;
            }
            c.execute("INSERT INTO events(thread_id,kind,payload) VALUES (?1,?2,?3)", params![thread.to_string(), payload.kind(), serde_json::to_string(&payload)?])?;
            Ok(())
        }).unwrap();
    }

    fn entry(id: &str, complete: bool, omitted: bool) -> TranscriptEntry {
        serde_json::from_value(serde_json::json!({
            "role": "tool_call", "turn_id": TurnId::nil(), "seq": if id == "unique" { 6 } else { 1 },
            "origin": { "kind": "root" }, "call": { "id": id, "name": "bash", "input": {} },
            "complete": complete, "output_omitted": omitted, "is_error": false,
            "at": "2026-09-17T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn interrupted_tool_stream_is_not_marked_recoverable_without_completion() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE events (
                seq INTEGER PRIMARY KEY,
                thread_id TEXT NOT NULL,
                turn_id TEXT,
                at TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL
            );",
        )
        .unwrap();
        let store = Store { conn: Arc::new(Mutex::new(conn)) };
        let thread = ThreadId::nil();
        let turn = TurnId::nil();
        let at = "2026-09-17T00:00:00Z";
        let append = |seq, payload: EventPayload| {
            store
                .with(|c| {
                    c.execute(
                        "INSERT INTO events(seq,thread_id,turn_id,at,kind,payload) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![seq, thread.to_string(), turn.to_string(), at, payload.kind(), serde_json::to_string(&payload)?],
                    )?;
                    Ok(())
                })
                .unwrap();
        };
        append(1, EventPayload::TurnStarted { message_id: MessageId::nil(), message: UserMessage::text("run") });
        append(
            2,
            EventPayload::ToolCallStarted {
                call: ToolCall { id: "interrupted".into(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None },
                origin: EventOrigin::Root,
            },
        );
        append(3, EventPayload::ToolCallOutputDelta { tool_call_id: "interrupted".into(), delta: "partial output".into() });
        append(4, EventPayload::TurnFailed { error: "interrupted".into() });

        let events = store.events_for_thread_through(thread, 4).unwrap();
        let stream: String = events
            .iter()
            .filter_map(|event| match &event.payload {
                EventPayload::ToolCallOutputDelta { tool_call_id, delta } if tool_call_id == "interrupted" => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(stream, "partial output");

        // Projection marks an unfinished row complete with a synthetic null
        // output when its turn fails. Without a durable completion event there
        // is no threads.tool_output result that can hydrate the stream, so the
        // snapshot must leave the persisted stream unmarked.
        let fold = store.project_transcript_fold_through(thread, 4).unwrap();
        let mut snapshot = fold.rows().to_vec();
        fold.mark_tool_streams_omitted(&mut snapshot);
        assert!(matches!(
            snapshot.iter().find(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })),
            Some(TranscriptEntry::ToolCall { complete: true, output: Some(serde_json::Value::Null), stream_omitted: false, .. })
        ));
    }

    #[test]
    fn first_turn_message_and_count_reads_only_title_metadata() {
        let store = fixture();
        let thread = ThreadId::nil();
        let custom_thread = ThreadId::new_v4();
        let first = EventPayload::TurnStarted { message_id: MessageId::nil(), message: UserMessage::text("first prompt") };
        store
            .with(|c| {
                c.execute(
                    "INSERT INTO events(seq,thread_id,kind,payload) VALUES (?1,?2,?3,?4)",
                    params![1, thread.to_string(), first.kind(), serde_json::to_string(&first)?],
                )?;
                Ok(())
            })
            .unwrap();
        let (message, count) = store.first_turn_message_and_count(thread).unwrap();
        assert_eq!(count, 1);
        assert_eq!(message.unwrap().plain_text(), "first prompt");

        let second = EventPayload::TurnStarted { message_id: MessageId::new_v4(), message: UserMessage::text("second prompt") };
        store
            .with(|c| {
                for (seq, payload) in [
                    (2, EventPayload::TurnStarted { message_id: MessageId::new_v4(), message: UserMessage::text("custom first") }),
                    (3, second),
                ] {
                    c.execute(
                        "INSERT INTO events(seq,thread_id,kind,payload) VALUES (?1,?2,?3,?4)",
                        params![seq, custom_thread.to_string(), payload.kind(), serde_json::to_string(&payload)?],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let (message, count) = store.first_turn_message_and_count(custom_thread).unwrap();
        assert_eq!(count, 2);
        assert!(message.is_none(), "custom multi-turn threads must not fetch their first prompt");
    }

    #[test]
    fn hydrated_unique_and_duplicate_ids_keep_outputs_errors_and_flags() {
        let store = fixture();
        let thread = ThreadId::nil();
        let other_thread = ThreadId::new_v4();
        complete(&store, thread, "same:id", serde_json::json!("old"), false);
        let large = serde_json::json!({ "bytes": "é😀\n".repeat(10000), "nested": [1, null, true] });
        complete(&store, thread, "same:id", large.clone(), true);
        complete(&store, other_thread, "same:id", serde_json::json!("wrong thread"), false);
        complete(&store, thread, "unique", serde_json::Value::Null, false);
        let mut rows = vec![
            entry("same:id", true, true),
            entry("unique", true, true),
            entry("same:id", true, true),
            entry("missing", true, true),
            entry("same:id", false, true),
            entry("same:id", true, false),
        ];
        let before = rows.clone();
        store.hydrate_tool_outputs_through(thread, &mut rows, i64::MAX).unwrap();
        for index in [0, 2] {
            let TranscriptEntry::ToolCall { output, output_omitted, is_error, .. } = &rows[index] else { panic!("expected tool") };
            assert_eq!(output.as_ref(), Some(&large));
            assert!(!output_omitted);
            assert!(*is_error);
        }
        let TranscriptEntry::ToolCall { output, output_omitted, .. } = &rows[1] else { panic!("expected tool") };
        assert_eq!(output, &Some(serde_json::Value::Null));
        assert!(!output_omitted);
        for index in [3, 4, 5] {
            assert_eq!(serde_json::to_value(&rows[index]).unwrap(), serde_json::to_value(&before[index]).unwrap());
        }
        let first = serde_json::to_value(&rows).unwrap();
        store.hydrate_tool_outputs_through(thread, &mut rows, i64::MAX).unwrap();
        assert_eq!(first, serde_json::to_value(&rows).unwrap());
    }

    #[test]
    fn invalid_json_still_fails_without_publishing_partial_hydration() {
        let store = fixture();
        // A JSON value of the wrong EventPayload shape still matches this query.
        // json_extract sees the valid id; deserialization must report the corruption.
        store
            .with(|c| {
                c.execute(
                    "INSERT INTO events(thread_id,kind,payload) VALUES (?1,'tool_call_started',?2)",
                    params![ThreadId::nil().to_string(), r#"{"kind":"tool_call_started","call":{"id":"broken","name":"bash","input":{}}}"#],
                )?;
                c.execute(
                    "INSERT INTO events(thread_id,kind,payload) VALUES (?1,'tool_call_completed',?2)",
                    params![
                        ThreadId::nil().to_string(),
                        r#"{"kind":"tool_call_completed","tool_call_id":"broken","output":null,"is_error":"not a boolean"}"#
                    ],
                )?;
                Ok(())
            })
            .unwrap();
        let mut rows = vec![entry("broken", true, true)];
        let before = serde_json::to_value(&rows).unwrap();
        assert!(store.hydrate_tool_outputs_through(ThreadId::nil(), &mut rows, i64::MAX).is_err());
        assert_eq!(before, serde_json::to_value(&rows).unwrap());
    }

    #[test]
    fn empty_hydration_does_not_query_events() {
        let store = Store { conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())) };
        assert!(store.hydrate_tool_outputs_through(ThreadId::nil(), &mut [], i64::MAX).is_ok());
    }
}

#[cfg(test)]
mod transcript_scan_allocation_tests {
    use super::*;

    #[test]
    fn quota_evidence_reads_only_relevant_events_since_the_latest_start() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE events (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX events_thread ON events(thread_id, seq);").unwrap();
        let thread = ThreadId::new_v4();
        let turn = TurnId::new_v4();
        let at = Utc::now().to_rfc3339();
        let start =
            serde_json::to_string(&EventPayload::TurnStarted { message_id: MessageId::new_v4(), message: UserMessage::text("latest") })
                .unwrap();
        let failed = serde_json::to_string(&EventPayload::TurnFailed { error: "weekly quota".into() }).unwrap();
        let switched = serde_json::to_string(&EventPayload::SessionTransitioned {
            from: ProviderInstance::default_for(ProviderKind::Codex),
            to: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            native_resume: false,
            text: "switched".into(),
        })
        .unwrap();
        for (seq, kind, payload, owner) in [
            (1, "turn_started", "malformed old payload", thread),
            (2, "turn_failed", "malformed old payload", thread),
            (3, "turn_started", start.as_str(), thread),
            (4, "tool_call_completed", "malformed irrelevant payload", thread),
            (5, "turn_failed", failed.as_str(), thread),
            (6, "session_transitioned", switched.as_str(), thread),
            (7, "turn_started", "malformed foreign payload", ThreadId::new_v4()),
        ] {
            conn.execute(
                "INSERT INTO events VALUES (?1,?2,?3,?4,?5,?6)",
                params![seq, owner.to_string(), turn.to_string(), at, kind, payload],
            )
            .unwrap();
        }
        let store = Store { conn: Arc::new(Mutex::new(conn)) };
        assert_eq!(store.latest_turn_quota_events(thread).unwrap().iter().map(|event| event.seq).collect::<Vec<_>>(), vec![3, 5, 6]);
        assert!(store.latest_turn_quota_events(ThreadId::new_v4()).unwrap().is_empty());
    }

    #[test]
    fn compact_batches_preserve_cross_batch_updates_snapshot_and_page_boundaries() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE events (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX events_thread ON events(thread_id, seq);").unwrap();
        let store = Store { conn: Arc::new(Mutex::new(conn)) };
        let thread = ThreadId::new_v4();
        let at = Utc::now();
        let mut events = Vec::new();
        let mut push = |turn, payload| {
            events.push(ThreadEvent { seq: (events.len() * 2 + 1) as i64, thread_id: thread, turn_id: Some(turn), at, payload });
        };
        let early = TurnId::new_v4();
        push(
            early,
            EventPayload::ToolCallStarted {
                call: ToolCall { id: "late".into(), name: "Read".into(), input: serde_json::Value::Null, parent_id: None },
                origin: EventOrigin::Root,
            },
        );
        push(
            early,
            EventPayload::ProviderNotice {
                level: NoticeLevel::Info,
                text: "A single retained event may exceed the batch byte budget. ".repeat(6000),
                data: None,
            },
        );
        for i in 0..260 {
            let turn = TurnId::new_v4();
            push(turn, EventPayload::TurnStarted { message_id: MessageId::new_v4(), message: UserMessage::text(format!("turn {i}")) });
            push(
                turn,
                EventPayload::ToolCallStarted {
                    call: ToolCall { id: "reused".into(), name: "Read".into(), input: serde_json::Value::Null, parent_id: None },
                    origin: EventOrigin::Root,
                },
            );
            push(
                turn,
                EventPayload::ToolCallCompleted {
                    tool_call_id: "reused".into(),
                    output: serde_json::json!({"text": if i % 7 == 0 { "🌿\n".repeat(2048) } else { format!("result {i}") }}),
                    output_omitted: i % 5 == 0,
                    stream_recoverable: false,
                    is_error: i % 3 == 0,
                },
            );
            let message = MessageId::new_v4();
            push(turn, EventPayload::AssistantTextDelta { message_id: message, origin: EventOrigin::Root, delta: "prefix ".into() });
            push(
                turn,
                EventPayload::AssistantMessageCompleted {
                    message_id: message,
                    origin: EventOrigin::Root,
                    text: format!("prefix result {i}"),
                    thinking: None,
                },
            );
            push(
                turn,
                EventPayload::TurnCompleted {
                    stop_reason: StopReason::Completed,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 1000,
                    terminal_message_id: Some(message),
                },
            );
            push(turn, EventPayload::ToolCallOutputDelta { tool_call_id: "reused".into(), delta: "not a transcript row".into() });
        }
        push(
            early,
            EventPayload::ToolCallCompleted {
                tool_call_id: "late".into(),
                output: serde_json::json!("last"),
                output_omitted: false,
                stream_recoverable: false,
                is_error: false,
            },
        );
        store
            .with(|c| {
                for event in &events {
                    c.execute(
                        "INSERT INTO events VALUES (?1,?2,?3,?4,?5,?6)",
                        params![
                            event.seq,
                            thread.to_string(),
                            event.turn_id.unwrap().to_string(),
                            at.to_rfc3339(),
                            event.payload.kind(),
                            serde_json::to_string(&event.payload)?
                        ],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        for count in [0, 127, 128, 129, 255, 256, events.len() - 1, events.len()] {
            let through = events.get(count.wrapping_sub(1)).map_or(0, |event| event.seq);
            let mut fold = TranscriptFold::omitting_tool_outputs();
            for event in &events[..count] {
                let mut canonical = event.clone();
                if let EventPayload::ToolCallCompleted { output_omitted, .. } = &mut canonical.payload {
                    *output_omitted = false;
                }
                fold.apply(&canonical);
            }
            let expected = fold.finish();
            let actual = store.project_transcript_through(thread, through).unwrap();
            assert_eq!(serde_json::to_value(&actual).unwrap(), serde_json::to_value(&expected).unwrap(), "snapshot {through}");
            for before in [None, Some(through / 2)] {
                let page = transcript_page_ref(&actual, Some(120), before);
                let expected_page = transcript_page_ref(&expected, Some(120), before);
                assert_eq!(serde_json::to_value(page).unwrap(), serde_json::to_value(expected_page).unwrap());
            }
        }
    }

    #[test]
    fn filtered_sql_projection_matches_event_fold_at_every_snapshot() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE events (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);").unwrap();
        let store = Store { conn: Arc::new(Mutex::new(conn)) };
        let thread = ThreadId::nil();
        let turn = TurnId::nil();
        let payloads = vec![
            EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "start".into(), data: None },
            EventPayload::ToolCallOutputDelta { tool_call_id: "large".into(), delta: "x".repeat(256 * 1024) },
            EventPayload::ProviderUsageUpdated { usage: Default::default() },
            EventPayload::MessageRemoved { message_id: MessageId::nil() },
            EventPayload::ProviderCommandsUpdated { commands: Vec::new() },
            EventPayload::ThreadArchived,
            EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "end".into(), data: None },
        ];
        let events: Vec<ThreadEvent> = payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| ThreadEvent {
                seq: index as i64 + 1,
                thread_id: thread,
                turn_id: Some(turn),
                at: "2026-09-17T00:00:00Z".parse().unwrap(),
                payload,
            })
            .collect();
        store
            .with(|c| {
                for event in &events {
                    c.execute(
                        "INSERT INTO events(seq,thread_id,turn_id,at,kind,payload) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![
                            event.seq,
                            thread.to_string(),
                            turn.to_string(),
                            event.at.to_rfc3339(),
                            event.payload.kind(),
                            serde_json::to_string(&event.payload)?
                        ],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        for end in 0..=events.len() {
            let expected = project_transcript(&events[..end]);
            let actual = store.project_transcript_through(thread, end as i64).unwrap();
            assert_eq!(serde_json::to_value(actual).unwrap(), serde_json::to_value(&expected).unwrap(), "snapshot={end}");
            // A cached fold extended to a newer head equals a fold from the start.
            for split in 0..=end {
                let mut fold = TranscriptFold::omitting_tool_outputs();
                store.extend_transcript_fold(thread, &mut fold, 0, split as i64).unwrap();
                store.extend_transcript_fold(thread, &mut fold, split as i64, end as i64).unwrap();
                assert_eq!(serde_json::to_value(fold.rows()).unwrap(), serde_json::to_value(&expected).unwrap(), "split={split} end={end}");
            }
        }
        assert!(store.project_transcript_through(ThreadId::new_v4(), i64::MAX).unwrap().is_empty());
        assert_eq!(store.events_for_thread_through(thread, i64::MAX).unwrap().len(), events.len(), "full replay remains untouched");
    }
}

#[cfg(test)]
mod orchestration_tests {
    use super::*;

    fn project(store: &Store) -> Project {
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "orchestration".into(),
            path: format!("/tmp/{}", Uuid::now_v7()),
            is_git: true,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        project
    }

    fn thread(project: &Project, parent: Option<ThreadId>, delegation: Option<DelegationInfo>) -> Thread {
        let now = Utc::now();
        Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "t".into(),
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: parent,
            coordinator_project_id: None,
            subagent: None,
            delegation,
            members: Vec::new(),
        }
    }

    fn delegation(parent: ThreadId, status: DelegationStatus) -> DelegationInfo {
        DelegationInfo {
            task_id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            parent_thread_id: parent,
            depth: 1,
            role: DelegationRole::Research,
            workspace: DelegationWorkspace::Worktree,
            default_override: None,
            owns: vec!["src/**".into()],
            status,
            result: None,
            error: None,
            files_touched: vec!["src/a.rs".into()],
            conflicts: vec![DelegationConflict { path: "src/b.rs".into(), owner_thread_id: Uuid::now_v7(), at: Utc::now() }],
            base_commit: Some("abc".into()),
            branch: Some("kybern/x".into()),
            head_commit: None,
            diffstat: Some(DiffStat { files: 1, additions: 2, deletions: 3 }),
            worktree_state: Some(WorktreeState::Active),
            started_at: Utc::now(),
            completed_at: None,
            parent_notified: true,
        }
    }

    fn message(to: ThreadId, from: Option<ThreadId>, purpose: ThreadMessagePurpose, state: ThreadMessageState) -> ThreadMessageRecord {
        let now = Utc::now();
        ThreadMessageRecord {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            from_thread_id: from,
            to_thread_id: to,
            purpose,
            reply_to: None,
            body: "hello".into(),
            delivery: ThreadMessageDelivery::Queue,
            state,
            held_reason: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn migration_18_upgrades_an_existing_database_in_place() {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate_to(&conn, 17).unwrap();
        conn.execute("INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES ('p', 'n', '/x', 1, 'a', 'a')", [])
            .unwrap();
        let before: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap();
        schema::migrate(&conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), schema::migration_count() as i64);
        assert!(schema::migration_count() >= 18);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get::<_, i64>(0)).unwrap(), before);
        conn.query_row("SELECT COUNT(delegation) FROM threads", [], |r| r.get::<_, i64>(0)).unwrap();
        conn.query_row("SELECT COUNT(*) FROM thread_messages", [], |r| r.get::<_, i64>(0)).unwrap();
    }

    #[test]
    fn delegation_roundtrips_and_is_found_by_operation_task_and_parent() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store);
        let parent = thread(&project, None, None);
        store.thread_upsert(&parent).unwrap();
        let info = delegation(parent.id, DelegationStatus::Running);
        let child = thread(&project, Some(parent.id), Some(info.clone()));
        store.thread_upsert(&child).unwrap();
        let other = thread(&project, Some(parent.id), Some(delegation(parent.id, DelegationStatus::Completed)));
        store.thread_upsert(&other).unwrap();

        assert_eq!(store.thread_get(child.id).unwrap().unwrap().delegation, Some(info.clone()));
        assert_eq!(store.thread_get(parent.id).unwrap().unwrap().delegation, None);
        assert_eq!(store.delegation_find_by_operation(info.operation_id).unwrap().unwrap().id, child.id);
        assert_eq!(store.delegation_find_by_task(info.task_id).unwrap().unwrap().id, child.id);
        assert!(store.delegation_find_by_task(Uuid::now_v7()).unwrap().is_none());
        let children = store.delegation_children(parent.id).unwrap();
        assert_eq!(children.iter().map(|t| t.id).collect::<Vec<_>>(), [child.id, other.id]);
        assert_eq!(store.delegation_active_count(parent.id).unwrap(), 1);

        // A status change is persisted; a later write without delegation keeps it.
        let mut done = child.clone();
        done.delegation.as_mut().unwrap().status = DelegationStatus::Completed;
        store.thread_upsert(&done).unwrap();
        assert_eq!(store.delegation_active_count(parent.id).unwrap(), 0);
        let mut bare = child.clone();
        bare.delegation = None;
        store.thread_upsert(&bare).unwrap();
        assert_eq!(store.thread_get(child.id).unwrap().unwrap().delegation.unwrap().status, DelegationStatus::Completed);
    }

    #[test]
    fn delegation_operation_and_task_ids_are_unique() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store);
        let parent = thread(&project, None, None);
        store.thread_upsert(&parent).unwrap();
        let info = delegation(parent.id, DelegationStatus::Running);
        store.thread_upsert(&thread(&project, Some(parent.id), Some(info.clone()))).unwrap();
        let mut same_operation = delegation(parent.id, DelegationStatus::Running);
        same_operation.operation_id = info.operation_id;
        assert!(store.thread_upsert(&thread(&project, Some(parent.id), Some(same_operation))).is_err());
        let mut same_task = delegation(parent.id, DelegationStatus::Running);
        same_task.task_id = info.task_id;
        assert!(store.thread_upsert(&thread(&project, Some(parent.id), Some(same_task))).is_err());
    }

    #[test]
    fn thread_messages_insert_get_update_list_and_find_reply() {
        let store = Store::open_in_memory().unwrap();
        let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
        let question = message(b, Some(a), ThreadMessagePurpose::Question, ThreadMessageState::Queued);
        store.thread_message_insert(&question).unwrap();
        assert_eq!(store.thread_message_get(question.id).unwrap().unwrap(), question);
        assert_eq!(store.thread_message_find_by_operation(question.operation_id).unwrap().unwrap().id, question.id);
        assert!(store.thread_message_get(Uuid::now_v7()).unwrap().is_none());

        let mut duplicate = message(b, Some(a), ThreadMessagePurpose::Message, ThreadMessageState::Queued);
        duplicate.operation_id = question.operation_id;
        assert!(store.thread_message_insert(&duplicate).is_err());

        let mut reply = message(a, Some(b), ThreadMessagePurpose::Reply, ThreadMessageState::Delivered);
        reply.reply_to = Some(question.id);
        store.thread_message_insert(&reply).unwrap();
        assert_eq!(store.thread_message_find_reply(question.id).unwrap().unwrap().id, reply.id);
        assert!(store.thread_message_find_reply(reply.id).unwrap().is_none());

        let mut held = message(b, None, ThreadMessagePurpose::Warning, ThreadMessageState::Held);
        held.held_reason = Some("permission".into());
        store.thread_message_insert(&held).unwrap();

        let all = store.thread_message_list_for_thread(b, None, 200).unwrap();
        assert_eq!(all.iter().map(|m| m.id).collect::<Vec<_>>(), [question.id, reply.id, held.id], "oldest first, to or from");
        let only_held = store.thread_message_list_for_thread(b, Some(&[ThreadMessageState::Held]), 200).unwrap();
        assert_eq!(only_held.len(), 1);
        assert_eq!(only_held[0].held_reason.as_deref(), Some("permission"));
        assert!(store.thread_message_list_for_thread(b, Some(&[]), 200).unwrap().is_empty());
        let newest = store.thread_message_list_for_thread(b, None, 1).unwrap();
        assert_eq!(newest.iter().map(|m| m.id).collect::<Vec<_>>(), [held.id], "the cap keeps the newest");
        assert!(store.thread_message_list_for_thread(Uuid::now_v7(), None, 200).unwrap().is_empty());

        let answered = store.thread_message_update_state(question.id, ThreadMessageState::Answered).unwrap().unwrap();
        assert_eq!(answered.state, ThreadMessageState::Answered);
        assert!(answered.updated_at >= question.updated_at);
        assert!(store.thread_message_update_state(Uuid::now_v7(), ThreadMessageState::Failed).unwrap().is_none());
    }

    #[test]
    fn thread_message_transition_never_overwrites_a_newer_state() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store);
        let to = thread(&project, None, None);
        store.thread_upsert(&to).unwrap();
        let record = message(to.id, None, ThreadMessagePurpose::Message, ThreadMessageState::Held);
        store.thread_message_insert(&record).unwrap();
        let held_or_queued = [ThreadMessageState::Held, ThreadMessageState::Queued];
        let queued = store.thread_message_transition(record.id, &held_or_queued, ThreadMessageState::Queued).unwrap().unwrap();
        assert_eq!(queued.state, ThreadMessageState::Queued);
        store.thread_message_update_state(record.id, ThreadMessageState::Delivered).unwrap();
        assert!(store.thread_message_transition(record.id, &held_or_queued, ThreadMessageState::Queued).unwrap().is_none());
        assert_eq!(store.thread_message_get(record.id).unwrap().unwrap().state, ThreadMessageState::Delivered);
        assert!(store.thread_message_transition(Uuid::now_v7(), &held_or_queued, ThreadMessageState::Failed).unwrap().is_none());
    }

    #[test]
    fn user_messages_with_orchestration_parts_project_as_user_blocks() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store);
        let thread = thread(&project, None, None);
        store.thread_upsert(&thread).unwrap();
        let turn = Uuid::now_v7();
        let message_id = Uuid::now_v7();
        let message = UserMessage {
            parts: vec![
                ContentPart::ThreadMessage {
                    message_id,
                    from_thread_id: Some(Uuid::now_v7()),
                    from_title: "Parent".into(),
                    purpose: ThreadMessagePurpose::Task,
                    reply_to: None,
                    body: "do it".into(),
                },
                ContentPart::AgentResults { items: Vec::new() },
            ],
        };
        store.event_append(thread.id, Some(turn), EventPayload::TurnStarted { message_id, message: message.clone() }).unwrap();
        let record = message_record_for(thread.id);
        store.event_append(thread.id, None, EventPayload::ThreadMessageHeld { message: record.clone() }).unwrap();
        store
            .event_append(
                thread.id,
                None,
                EventPayload::ThreadMessageResolved { message_id: record.id, resolution: HeldResolution::Delivered },
            )
            .unwrap();
        let rows = store.project_transcript_through(thread.id, i64::MAX).unwrap();
        assert_eq!(rows.len(), 1, "held and resolved events add no transcript row");
        assert!(matches!(&rows[0], TranscriptEntry::User { id, message: m, .. } if *id == message_id && *m == message));
    }

    #[test]
    fn only_a_person_started_turn_counts_as_the_latest_person_turn() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store);
        let thread = thread(&project, None, None);
        store.thread_upsert(&thread).unwrap();
        assert!(store.thread_latest_person_turn_at(thread.id).unwrap().is_none());
        let start = |message_id: MessageId, parts: Vec<ContentPart>| {
            store
                .event_append(thread.id, Some(Uuid::now_v7()), EventPayload::TurnStarted { message_id, message: UserMessage { parts } })
                .unwrap()
        };
        let human = start(Uuid::now_v7(), vec![ContentPart::Text { text: "hi".into() }]);
        std::thread::sleep(std::time::Duration::from_millis(5));
        // A turn a thread message started (by row id, or by its part) is not a person's.
        let record = message(thread.id, Some(Uuid::now_v7()), ThreadMessagePurpose::Message, ThreadMessageState::Queued);
        store.thread_message_insert(&record).unwrap();
        start(record.id, vec![ContentPart::Text { text: "from the queue".into() }]);
        start(
            Uuid::now_v7(),
            vec![ContentPart::ThreadMessage {
                message_id: Uuid::now_v7(),
                from_thread_id: None,
                from_title: "Kybern".into(),
                purpose: ThreadMessagePurpose::Warning,
                reply_to: None,
                body: "w".into(),
            }],
        );
        start(Uuid::now_v7(), vec![ContentPart::AgentResults { items: Vec::new() }]);
        assert_eq!(store.thread_latest_person_turn_at(thread.id).unwrap(), Some(human.at));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let later = start(Uuid::now_v7(), vec![ContentPart::Text { text: "again".into() }]);
        assert_eq!(store.thread_latest_person_turn_at(thread.id).unwrap(), Some(later.at));
    }

    fn message_record_for(to: ThreadId) -> ThreadMessageRecord {
        message(to, None, ThreadMessagePurpose::Message, ThreadMessageState::Held)
    }
}

#[cfg(test)]
mod coordinator_upgrade_tests {
    use super::*;
    use kybern_protocol::methods::{NoteScope, ProjectNoteRole};

    const LAST_COLLABORATION_VERSION: usize = 23;

    fn insert_thread(conn: &Connection, id: Uuid, project: Uuid, title: &str, coordinator: bool, group: Option<Uuid>) {
        conn.execute(
            "INSERT INTO threads(id, project_id, title, provider_kind, provider_instance, permission_mode, status, cwd, pinned, created_at,
                                 updated_at, last_seq, coordinator_project_id, collaboration_group_id)
             VALUES (?1, ?2, ?3, 'claude-code', 'default', 'supervised', 'idle', '/tmp/demo', 0, '2026-10-01T00:00:00Z',
                     '2026-10-01T00:00:00Z', 0, ?4, ?5)",
            params![id.to_string(), project.to_string(), title, coordinator.then(|| project.to_string()), group.map(|g| g.to_string())],
        )
        .unwrap();
    }

    fn insert_event(conn: &Connection, thread: Uuid, kind: &str, payload: &str) {
        conn.execute(
            "INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, NULL, '2026-10-01T00:00:00Z', ?2, ?3)",
            params![thread.to_string(), kind, payload],
        )
        .unwrap();
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", [name], |_| Ok(())).optional().unwrap().is_some()
    }

    #[test]
    fn upgrade_turns_the_latest_brief_into_a_note_archives_old_coordinators_and_drops_collaboration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        schema::migrate_to(&conn, LAST_COLLABORATION_VERSION).unwrap();
        assert!(schema::migration_count() > LAST_COLLABORATION_VERSION);

        let project = Uuid::now_v7();
        let other_project = Uuid::now_v7();
        let (coordinator, worker, ordinary, quiet_coordinator) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let (group, quiet_group) = (Uuid::now_v7(), Uuid::now_v7());
        for (id, path) in [(project, "/tmp/demo"), (other_project, "/tmp/quiet")] {
            conn.execute(
                "INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES (?1, 'demo', ?2, 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')",
                params![id.to_string(), path],
            )
            .unwrap();
        }
        insert_thread(&conn, coordinator, project, "Coordinator", true, Some(group));
        insert_thread(&conn, worker, project, "Worker", false, Some(group));
        insert_thread(&conn, ordinary, project, "Ordinary chat", false, None);
        insert_thread(&conn, quiet_coordinator, other_project, "Quiet coordinator", true, Some(quiet_group));
        for (id, project_id, thread) in [(group, project, coordinator), (quiet_group, other_project, quiet_coordinator)] {
            conn.execute(
                "INSERT INTO collaboration_groups(id, project_id, coordinator_thread_id, status, payload) VALUES (?1, ?2, ?3, 'active', '{}')",
                params![id.to_string(), project_id.to_string(), thread.to_string()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_coordinators(project_id, thread_id, group_id) VALUES (?1, ?2, ?3)",
                params![project_id.to_string(), thread.to_string(), id.to_string()],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO collaboration_members(group_id, thread_id, active, payload) VALUES (?1, ?2, 1, '{}')",
            params![group.to_string(), worker.to_string()],
        )
        .unwrap();
        let revision = |group: Uuid, key: &str, revision: i64, body: &str| {
            conn.execute(
                "INSERT INTO collaboration_context_revisions(entry_id, group_id, key, revision, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    Uuid::now_v7().to_string(),
                    group.to_string(),
                    key,
                    revision,
                    serde_json::json!({"body": body, "updated_at": format!("2026-10-0{revision}T00:00:00Z")}).to_string()
                ],
            )
            .unwrap();
        };
        revision(group, "project.brief", 1, "Old brief");
        revision(group, "project.brief", 2, "Ship the importer");
        revision(group, "project.setup", 1, "pnpm install");
        revision(group, "project-overview", 1, "Old overview");
        revision(group, "project-overview", 2, "A Rust daemon and a desktop app");
        revision(group, "coordinator-setup", 1, "Started the coordinator");
        revision(group, "research.notes", 1, "Not carried over");
        revision(quiet_group, "project.brief", 1, "   ");

        let turn = EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("hello") };
        insert_event(&conn, coordinator, "collaboration_group_updated", r#"{"kind":"collaboration_group_updated","group":{}}"#);
        insert_event(&conn, coordinator, "turn_started", &serde_json::to_string(&turn).unwrap());
        insert_event(&conn, coordinator, "collaboration_message_updated", r#"{"kind":"collaboration_message_updated","message":{}}"#);
        insert_event(&conn, worker, "collaboration_assignment_updated", r#"{"kind":"collaboration_assignment_updated"}"#);
        insert_event(&conn, coordinator, "project_coordinator_deleted", r#"{"kind":"project_coordinator_deleted"}"#);

        for (id, kind) in [(Uuid::now_v7(), "groups.create"), (Uuid::now_v7(), "kybern_note_create")] {
            conn.execute(
                "INSERT INTO collaboration_operations(operation_id, actor, operation_kind, request, state, response, created_at, updated_at)
                 VALUES (?1, 'human', ?2, '{}', 'completed', '{}', 'a', 'a')",
                params![id.to_string(), kind],
            )
            .unwrap();
        }

        schema::migrate(&conn).unwrap();
        let store = Store::init(conn).unwrap();

        let brief = store.note_for_project_role(project, ProjectNoteRole::Brief).unwrap().expect("the brief becomes a note");
        assert_eq!(brief.body, "Ship the importer");
        assert_eq!(brief.summary.title, "Project brief");
        assert_eq!(brief.summary.scope, NoteScope::Project);
        assert!(brief.summary.pinned && brief.summary.created_by_thread.is_none() && brief.summary.deleted_at.is_none());
        let setup = store.note_for_project_role(project, ProjectNoteRole::Setup).unwrap().expect("the setup entry becomes the setup note");
        assert_eq!(setup.body, "pnpm install");
        assert!(setup.summary.pinned && setup.summary.created_by_thread == Some(coordinator));
        assert!(store.note_for_project_role(other_project, ProjectNoteRole::Brief).unwrap().is_none(), "a blank brief makes no note");
        let notes = store.notes_list().unwrap();
        assert_eq!(notes.len(), 4, "brief, setup, overview and setup log; other entries are dropped");
        let memory = |title: &str| notes.iter().find(|note| note.title == title).unwrap_or_else(|| panic!("{title} is carried over"));
        for (title, body_start) in [("Project overview", "A Rust daemon"), ("Coordinator setup log", "Started")] {
            let note = memory(title);
            assert!(note.project_role.is_none() && !note.pinned && note.created_by_thread == Some(coordinator), "{title}");
            assert!(store.note_get(note.id).unwrap().unwrap().body.starts_with(body_start), "{title} keeps its latest revision");
        }

        for id in [coordinator, worker, quiet_coordinator] {
            let thread = store.thread_get(id).unwrap().unwrap();
            assert_eq!(thread.status, ThreadStatus::Archived, "{}", thread.title);
            assert_eq!(thread.coordinator_project_id, None);
        }
        assert_eq!(store.thread_get(ordinary).unwrap().unwrap().status, ThreadStatus::Idle);
        assert!(store.project_coordinator_thread(project).unwrap().is_none(), "archiving freed the slot");
        assert!(!store.project_get(project).unwrap().unwrap().brief_in_all_threads);

        store
            .with(|c| {
                for table in [
                    "collaboration_groups",
                    "collaboration_members",
                    "collaboration_assignments",
                    "collaboration_messages",
                    "collaboration_context_revisions",
                    "project_coordinators",
                    "project_coordinator_reservations",
                ] {
                    assert!(!table_exists(c, table), "{table} is dropped");
                }
                let columns = c
                    .prepare("SELECT name FROM pragma_table_info('threads')")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                assert!(!columns.iter().any(|name| name == "collaboration_group_id"));
                let receipts = c
                    .prepare("SELECT operation_kind FROM tool_operations")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                assert_eq!(receipts, ["kybern_note_create"], "agent tool receipts survive, collaboration ones do not");
                Ok(())
            })
            .unwrap();

        // The archived coordinator's transcript still loads, minus the collaboration rows.
        let events = store.events_for_thread(coordinator).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].payload, EventPayload::TurnStarted { .. }));
        assert!(store.events_for_thread(worker).unwrap().is_empty());
        store.project_transcript_through(coordinator, i64::MAX).unwrap();
    }

    #[test]
    fn project_roles_are_unique_pinned_and_protected() {
        let (store, thread) = thread_for_roles();
        let project = thread.project_id;
        let brief = store.note_create_project_role(project, ProjectNoteRole::Brief, "Project brief", "Be careful", None).unwrap();
        assert!(brief.summary.pinned);
        assert_eq!(brief.summary.project_role, Some(ProjectNoteRole::Brief));
        let again = store.note_create_project_role(project, ProjectNoteRole::Brief, "Project brief", "Again", None).unwrap_err();
        assert!(again.to_string().contains("already has that note"), "{again}");
        let setup = store.note_create_project_role(project, ProjectNoteRole::Setup, "Setup", "pnpm test", Some(thread.id)).unwrap();
        assert_eq!(setup.summary.created_by_thread, Some(thread.id));
        for refused in
            [store.note_delete(brief.summary.id).map(|_| ()), store.note_move(brief.summary.id, NoteScope::Global, None).map(|_| ())]
        {
            assert!(refused.unwrap_err().to_string().contains("project brief and setup note"));
        }
        assert_eq!(store.note_for_project_role(project, ProjectNoteRole::Setup).unwrap().unwrap().body, "pnpm test");
    }

    fn thread_for_roles() -> (Store, Thread) {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "demo".into(),
            path: "/tmp/roles".into(),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "Coordinator".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: Some(project.id),
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        store.thread_upsert(&thread).unwrap();
        (store, thread)
    }
}
