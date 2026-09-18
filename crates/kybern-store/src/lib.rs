//! SQLite persistence. One database per daemon, WAL mode, event-sourced threads.
//!
//! The store is synchronous; the daemon wraps calls in `spawn_blocking` when
//! they may take more than a few milliseconds (replays, projections).

mod projection;
mod schema;
mod thread_history;
mod transcript_page;
pub use thread_history::{ThreadHistoryMessage, ThreadHistoryReadPage, ThreadHistorySearchPage};
pub use transcript_page::{transcript_page, transcript_page_ref};

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

fn snake(value: impl serde::Serialize) -> Result<String> {
    Ok(serde_json::to_value(value)?.as_str().ok_or_else(|| anyhow::anyhow!("enum did not serialize as a string"))?.to_owned())
}

fn collaboration_tx_receipt(
    tx: &Transaction<'_>,
    operation_id: OperationId,
    actor: &str,
    operation_kind: &str,
    request: &str,
) -> Result<Option<String>> {
    let row = tx
        .query_row(
            "SELECT actor,operation_kind,request,state,response FROM collaboration_operations WHERE operation_id=?1",
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
    let Some((stored_actor, stored_kind, stored_request, state, response)) = row else {
        return Ok(None);
    };
    if stored_actor != actor || stored_kind != operation_kind || stored_request != request {
        anyhow::bail!("operation id already belongs to a different actor or request");
    }
    if state != "completed" {
        anyhow::bail!("operation outcome is uncertain; inspect collaboration state before retrying");
    }
    Ok(Some(response.ok_or_else(|| anyhow::anyhow!("completed operation has no response"))?))
}

fn collaboration_tx_complete(
    tx: &Transaction<'_>,
    operation_id: OperationId,
    actor: &str,
    operation_kind: &str,
    request: &str,
    response: &impl serde::Serialize,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO collaboration_operations(operation_id,actor,operation_kind,request,state,response,created_at,updated_at) VALUES (?1,?2,?3,?4,'completed',?5,?6,?6)",
        params![operation_id.to_string(), actor, operation_kind, request, serde_json::to_string(response)?, now],
    )?;
    Ok(())
}

fn collaboration_queued_message(message: &CollaborationMessage) -> methods::QueuedMessage {
    let response_guidance = if matches!(message.purpose, CollaborationMessagePurpose::Question | CollaborationMessagePurpose::ChangeRequest)
    {
        "\n\nRespond with kybern_collaboration_send and set reply_to to this message id."
    } else {
        "\n\nDo not send an acknowledgement wakeup. Continue only if this message gives you actual work; otherwise record progress without waking the sender."
    };
    methods::QueuedMessage {
        id: message.id,
        thread_id: message.to_thread_id,
        message: UserMessage::text(format!(
            "Kybern collaboration {:?} from {} (message {}, reply_to {:?}):\n{}{}",
            message.purpose,
            message.from_thread_id.map_or_else(|| "the user".into(), |id| format!("thread {id}")),
            message.id,
            message.reply_to,
            message.body,
            response_guidance
        )),
    }
}

/// Append within the caller's transaction so collaboration state, receipts,
/// queued delivery, and their observable events share one commit boundary.
fn append_event_in_transaction(
    tx: &Transaction<'_>,
    thread_id: ThreadId,
    turn_id: Option<TurnId>,
    mut payload: EventPayload,
) -> Result<ThreadEvent> {
    let c = tx;
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

fn append_collaboration_events_in_transaction(tx: &Transaction<'_>, group_id: GroupId, payload: EventPayload) -> Result<Vec<ThreadEvent>> {
    let members = {
        let mut statement =
            tx.prepare("SELECT thread_id FROM collaboration_members WHERE group_id = ?1 AND active = 1 ORDER BY thread_id")?;
        statement.query_map([group_id.to_string()], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?
    };
    members.into_iter().map(|id| append_event_in_transaction(tx, id.parse()?, None, payload.clone())).collect()
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
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.conn.lock().map_err(|_| anyhow::anyhow!("store mutex poisoned"))?;
        f(&conn)
    }

    // ---- collaboration ----

    pub fn collaboration_operation_receipt<T: serde::de::DeserializeOwned>(
        &self,
        operation_id: OperationId,
        actor: &str,
        operation_kind: &str,
        request: &impl serde::Serialize,
    ) -> Result<Option<T>> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let row = c.query_row(
                "SELECT actor, operation_kind, request, state, response FROM collaboration_operations WHERE operation_id = ?1",
                [operation_id.to_string()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?)),
            ).optional()?;
            let Some((stored_actor, stored_kind, stored_request, state, response)) = row else { return Ok(None) };
            if stored_actor != actor || stored_kind != operation_kind || stored_request != request {
                anyhow::bail!("operation id already belongs to a different actor or request");
            }
            if state != "completed" {
                anyhow::bail!("operation outcome is uncertain after an interrupted daemon write; inspect current collaboration state before using a new operation id");
            }
            Ok(Some(serde_json::from_str(&response.ok_or_else(|| anyhow::anyhow!("completed operation has no response"))?)?))
        })
    }

    pub fn collaboration_operation_begin(
        &self,
        operation_id: OperationId,
        actor: &str,
        operation_kind: &str,
        request: &impl serde::Serialize,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        self.with(|c| {
            c.execute(
                "INSERT INTO collaboration_operations(operation_id, actor, operation_kind, request, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)",
                params![operation_id.to_string(), actor, operation_kind, serde_json::to_string(request)?, now],
            )?;
            Ok(())
        })
    }

    pub fn collaboration_operation_complete<T: serde::Serialize>(&self, operation_id: OperationId, response: &T) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE collaboration_operations SET state = 'completed', response = ?2, updated_at = ?3 WHERE operation_id = ?1 AND state = 'pending'",
                params![operation_id.to_string(), serde_json::to_string(response)?, Utc::now().to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn collaboration_group_put(&self, group: &CollaborationGroup) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO collaboration_groups(id, project_id, coordinator_thread_id, status, payload) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET coordinator_thread_id=excluded.coordinator_thread_id, status=excluded.status, payload=excluded.payload",
                params![group.id.to_string(), group.project_id.to_string(), group.coordinator_thread_id.to_string(), snake(group.status)?, serde_json::to_string(group)?],
            )?;
            Ok(())
        })
    }

    /// Atomically accepts a group creation operation and its initial coordinator.
    /// Replays return the original response even after the group is later edited.
    pub fn collaboration_group_create_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        group: &CollaborationGroup,
        member: &GroupMember,
    ) -> Result<(CollaborationGroup, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(response) = collaboration_tx_receipt(&tx, operation_id, actor, "groups.create", &request)? {
                return Ok((serde_json::from_str(&response)?, Vec::new()));
            }
            tx.execute(
                "INSERT INTO collaboration_groups(id,project_id,coordinator_thread_id,status,payload) VALUES (?1,?2,?3,?4,?5)",
                params![
                    group.id.to_string(),
                    group.project_id.to_string(),
                    group.coordinator_thread_id.to_string(),
                    snake(group.status)?,
                    serde_json::to_string(group)?
                ],
            )?;
            tx.execute(
                "INSERT INTO collaboration_members(group_id,thread_id,active,payload) VALUES (?1,?2,1,?3)",
                params![member.group_id.to_string(), member.thread_id.to_string(), serde_json::to_string(member)?],
            )?;
            collaboration_tx_complete(&tx, operation_id, actor, "groups.create", &request, group)?;
            let mut events = append_collaboration_events_in_transaction(
                &tx,
                group.id,
                EventPayload::CollaborationGroupUpdated { group: group.clone() },
            )?;
            events.extend(append_collaboration_events_in_transaction(
                &tx,
                group.id,
                EventPayload::CollaborationMemberUpdated { member: member.clone() },
            )?);
            tx.commit()?;
            Ok((group.clone(), events))
        })
    }

    pub fn collaboration_group_control_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        group: &CollaborationGroup,
        assignments: &[CollaborationAssignment],
        messages: &[CollaborationMessage],
    ) -> Result<(CollaborationGroup, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(response) = collaboration_tx_receipt(&tx, operation_id, actor, "groups.control", &request)? {
                return Ok((serde_json::from_str(&response)?, Vec::new()));
            }
            tx.execute(
                "UPDATE collaboration_groups SET coordinator_thread_id=?2,status=?3,payload=?4 WHERE id=?1",
                params![group.id.to_string(), group.coordinator_thread_id.to_string(), snake(group.status)?, serde_json::to_string(group)?],
            )?;
            let mut events = append_collaboration_events_in_transaction(
                &tx,
                group.id,
                EventPayload::CollaborationGroupUpdated { group: group.clone() },
            )?;
            for assignment in assignments {
                tx.execute(
                    "UPDATE collaboration_assignments SET owner_thread_id=?2,status=?3,kind=?4,payload=?5 WHERE id=?1",
                    params![
                        assignment.id.to_string(),
                        assignment.owner_thread_id.map(|id| id.to_string()),
                        snake(assignment.status)?,
                        snake(assignment.kind)?,
                        serde_json::to_string(assignment)?
                    ],
                )?;
                events.extend(append_collaboration_events_in_transaction(
                    &tx,
                    group.id,
                    EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() },
                )?);
            }
            for message in messages {
                tx.execute(
                    "UPDATE collaboration_messages SET state=?2,delivery_message_id=?3,payload=?4 WHERE id=?1",
                    params![message.id.to_string(), snake(message.state)?, message.id.to_string(), serde_json::to_string(message)?],
                )?;
                events.push(append_event_in_transaction(
                    &tx,
                    message.to_thread_id,
                    None,
                    EventPayload::MessageRemoved { message_id: message.id },
                )?);
                events.extend(append_collaboration_events_in_transaction(
                    &tx,
                    group.id,
                    EventPayload::CollaborationMessageUpdated { message: message.clone() },
                )?);
            }
            collaboration_tx_complete(&tx, operation_id, actor, "groups.control", &request, group)?;
            tx.commit()?;
            Ok((group.clone(), events))
        })
    }

    pub fn collaboration_group_update_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        group: &CollaborationGroup,
        members: &[GroupMember],
    ) -> Result<(CollaborationGroup, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(response) = collaboration_tx_receipt(&tx, operation_id, actor, "groups.update", &request)? {
                return Ok((serde_json::from_str(&response)?, Vec::new()));
            }
            tx.execute(
                "UPDATE collaboration_groups SET coordinator_thread_id=?2,status=?3,payload=?4 WHERE id=?1",
                params![group.id.to_string(), group.coordinator_thread_id.to_string(), snake(group.status)?, serde_json::to_string(group)?],
            )?;
            for member in members {
                tx.execute(
                    "INSERT INTO collaboration_members(group_id,thread_id,active,payload) VALUES (?1,?2,?3,?4) ON CONFLICT(group_id,thread_id) DO UPDATE SET active=excluded.active,payload=excluded.payload",
                    params![member.group_id.to_string(), member.thread_id.to_string(), member.active, serde_json::to_string(member)?],
                )?;
            }
            let mut events = append_collaboration_events_in_transaction(
                &tx,
                group.id,
                EventPayload::CollaborationGroupUpdated { group: group.clone() },
            )?;
            for member in members {
                events.extend(append_collaboration_events_in_transaction(
                    &tx,
                    group.id,
                    EventPayload::CollaborationMemberUpdated { member: member.clone() },
                )?);
            }
            collaboration_tx_complete(&tx, operation_id, actor, "groups.update", &request, group)?;
            tx.commit()?;
            Ok((group.clone(), events))
        })
    }

    pub fn collaboration_member_operation<T: serde::Serialize + serde::de::DeserializeOwned + Clone>(
        &self,
        operation_id: OperationId,
        actor: &str,
        kind: &str,
        request: &impl serde::Serialize,
        member: &GroupMember,
        response: &T,
    ) -> Result<(T, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(stored) = collaboration_tx_receipt(&tx, operation_id, actor, kind, &request)? {
                return Ok((serde_json::from_str(&stored)?, Vec::new()));
            }
            tx.execute(
                "INSERT INTO collaboration_members(group_id,thread_id,active,payload) VALUES (?1,?2,?3,?4) ON CONFLICT(group_id,thread_id) DO UPDATE SET active=excluded.active,payload=excluded.payload",
                params![member.group_id.to_string(), member.thread_id.to_string(), member.active, serde_json::to_string(member)?],
            )?;
            let events = append_collaboration_events_in_transaction(
                &tx,
                member.group_id,
                EventPayload::CollaborationMemberUpdated { member: member.clone() },
            )?;
            collaboration_tx_complete(&tx, operation_id, actor, kind, &request, response)?;
            tx.commit()?;
            Ok((response.clone(), events))
        })
    }

    pub fn collaboration_group_get(&self, id: GroupId) -> Result<Option<CollaborationGroup>> {
        self.json_optional("SELECT payload FROM collaboration_groups WHERE id = ?1", id)
    }

    pub fn collaboration_groups_list(&self, project_id: Option<ProjectId>, include_stopped: bool) -> Result<Vec<CollaborationGroup>> {
        self.with(|c| {
            let (sql, value) = match (project_id, include_stopped) {
                (Some(id), true) => ("SELECT payload FROM collaboration_groups WHERE project_id = ?1 ORDER BY id", Some(id.to_string())),
                (Some(id), false) => (
                    "SELECT payload FROM collaboration_groups WHERE project_id = ?1 AND status NOT IN ('stopped','completed') ORDER BY id",
                    Some(id.to_string()),
                ),
                (None, true) => ("SELECT payload FROM collaboration_groups ORDER BY id", None),
                (None, false) => ("SELECT payload FROM collaboration_groups WHERE status NOT IN ('stopped','completed') ORDER BY id", None),
            };
            let mut st = c.prepare(sql)?;
            let rows = if let Some(value) = value {
                st.query_map([value], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                st.query_map([], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?
            };
            rows.into_iter().map(|json| Ok(serde_json::from_str(&json)?)).collect()
        })
    }

    pub fn collaboration_member_put(&self, member: &GroupMember) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO collaboration_members(group_id, thread_id, active, payload) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(group_id,thread_id) DO UPDATE SET active=excluded.active,payload=excluded.payload",
                params![member.group_id.to_string(), member.thread_id.to_string(), member.active, serde_json::to_string(member)?],
            )?;
            Ok(())
        })
    }

    pub fn collaboration_members(&self, group_id: GroupId) -> Result<Vec<GroupMember>> {
        self.json_list("SELECT payload FROM collaboration_members WHERE group_id = ?1 ORDER BY rowid", group_id)
    }

    pub fn collaboration_group_for_thread(&self, thread_id: ThreadId) -> Result<Option<GroupId>> {
        self.with(|c| {
            Ok(c.query_row("SELECT m.group_id FROM collaboration_members m JOIN collaboration_groups g ON g.id=m.group_id WHERE m.thread_id=?1 AND m.active=1 AND g.status!='completed'", [thread_id.to_string()], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .map(|id| id.parse())
            .transpose()?)
        })
    }

    pub fn collaboration_assignment_put(&self, assignment: &CollaborationAssignment) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO collaboration_assignments(id,group_id,owner_thread_id,status,kind,payload) VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(id) DO UPDATE SET owner_thread_id=excluded.owner_thread_id,status=excluded.status,kind=excluded.kind,payload=excluded.payload",
                params![assignment.id.to_string(), assignment.group_id.to_string(), assignment.owner_thread_id.map(|id| id.to_string()), snake(assignment.status)?, snake(assignment.kind)?, serde_json::to_string(assignment)?],
            )?;
            Ok(())
        })
    }

    pub fn collaboration_assignment_create_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        assignment: &CollaborationAssignment,
    ) -> Result<(CollaborationAssignment, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(response) = collaboration_tx_receipt(&tx, operation_id, actor, "assignments.create", &request)? {
                return Ok((serde_json::from_str(&response)?, Vec::new()));
            }
            tx.execute(
                "INSERT INTO collaboration_assignments(id,group_id,owner_thread_id,status,kind,payload) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    assignment.id.to_string(),
                    assignment.group_id.to_string(),
                    assignment.owner_thread_id.map(|id| id.to_string()),
                    snake(assignment.status)?,
                    snake(assignment.kind)?,
                    serde_json::to_string(assignment)?
                ],
            )?;
            collaboration_tx_complete(&tx, operation_id, actor, "assignments.create", &request, assignment)?;
            let events = append_collaboration_events_in_transaction(
                &tx,
                assignment.group_id,
                EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() },
            )?;
            tx.commit()?;
            Ok((assignment.clone(), events))
        })
    }

    /// Commits a terminal assignment outcome and its return notification as one
    /// unit. A queued notification's generic queue projection is included in
    /// the same transaction, closing the crash window before coordinator wakeup.
    pub fn collaboration_assignment_complete_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        assignment: &CollaborationAssignment,
        notification: Option<(&str, &str, &CollaborationMessage, Option<MessageId>)>,
    ) -> Result<(CollaborationAssignment, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(response) = collaboration_tx_receipt(&tx, operation_id, actor, "assignments.complete", &request)? {
                return Ok((serde_json::from_str(&response)?, Vec::new()));
            }
            tx.execute(
                "UPDATE collaboration_assignments SET owner_thread_id=?2,status=?3,kind=?4,payload=?5 WHERE id=?1",
                params![assignment.id.to_string(), assignment.owner_thread_id.map(|id| id.to_string()), snake(assignment.status)?, snake(assignment.kind)?, serde_json::to_string(assignment)?],
            )?;
            let mut events = append_collaboration_events_in_transaction(
                &tx,
                assignment.group_id,
                EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() },
            )?;
            // The structured terminal result is authoritative for the finished
            // assignment. Older worker-to-recipient updates can remain queued
            // behind a long coordinator turn and otherwise wake it one at a
            // time after integration has already finished. Preserve every row
            // for audit, but atomically consume only queued updates on this
            // exact return route before enqueuing the terminal notification.
            if let Some((_, _, terminal, _)) = notification {
                let superseded = {
                    let mut statement = tx.prepare(
                        "SELECT payload FROM collaboration_messages
                         WHERE assignment_id=?1 AND from_thread_id IS ?2 AND to_thread_id=?3
                           AND state='queued' AND id<>?4
                           AND json_extract(payload,'$.purpose')='result'
                           AND EXISTS (SELECT 1 FROM queued_messages
                             WHERE queued_messages.id=collaboration_messages.delivery_message_id
                               AND queued_messages.pending=1)
                         ORDER BY id",
                    )?;
                    statement
                        .query_map(
                            params![
                                assignment.id.to_string(),
                                terminal.from_thread_id.map(|id| id.to_string()),
                                terminal.to_thread_id.to_string(),
                                terminal.id.to_string()
                            ],
                            |row| row.get::<_, String>(0),
                        )?
                        .collect::<std::result::Result<Vec<_>, _>>()?
                };
                for payload in superseded {
                    let mut message: CollaborationMessage = serde_json::from_str(&payload)?;
                    message.state = CollaborationDeliveryState::Cancelled;
                    message.updated_at = Utc::now();
                    tx.execute(
                        "UPDATE collaboration_messages SET state=?2,payload=?3 WHERE id=?1 AND state='queued'",
                        params![message.id.to_string(), snake(message.state)?, serde_json::to_string(&message)?],
                    )?;
                    events.push(append_event_in_transaction(
                        &tx,
                        message.to_thread_id,
                        None,
                        EventPayload::MessageRemoved { message_id: message.id },
                    )?);
                    events.extend(append_collaboration_events_in_transaction(
                        &tx,
                        message.group_id,
                        EventPayload::CollaborationMessageUpdated { message },
                    )?);
                }
            }
            if let Some((notification_actor, notification_request, message, delivery_message_id)) = notification
                && collaboration_tx_receipt(
                    &tx,
                    message.operation_id,
                    notification_actor,
                    "messages.send",
                    notification_request,
                )?
                .is_none()
            {
                    tx.execute(
                        "INSERT INTO collaboration_messages(id,operation_id,group_id,assignment_id,from_thread_id,to_thread_id,state,delivery_message_id,payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                        params![message.id.to_string(), message.operation_id.to_string(), message.group_id.to_string(), message.assignment_id.map(|id| id.to_string()), message.from_thread_id.map(|id| id.to_string()), message.to_thread_id.to_string(), snake(message.state)?, delivery_message_id.map(|id| id.to_string()), serde_json::to_string(message)?],
                    )?;
                    collaboration_tx_complete(
                        &tx,
                        message.operation_id,
                        notification_actor,
                        "messages.send",
                        notification_request,
                        message,
                    )?;
                    if delivery_message_id.is_some() {
                        events.push(append_event_in_transaction(
                            &tx,
                            message.to_thread_id,
                            None,
                            EventPayload::MessageQueued {
                                message: collaboration_queued_message(message),
                            },
                        )?);
                    }
                    events.extend(append_collaboration_events_in_transaction(
                        &tx,
                        message.group_id,
                        EventPayload::CollaborationMessageUpdated { message: message.clone() },
                    )?);
            }
            collaboration_tx_complete(&tx, operation_id, actor, "assignments.complete", &request, assignment)?;
            tx.commit()?;
            Ok((assignment.clone(), events))
        })
    }

    pub fn collaboration_assignment_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        kind: &str,
        request: &impl serde::Serialize,
        assignments: &[CollaborationAssignment],
        response: &CollaborationAssignment,
    ) -> Result<(CollaborationAssignment, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(stored) = collaboration_tx_receipt(&tx, operation_id, actor, kind, &request)? {
                return Ok((serde_json::from_str(&stored)?, Vec::new()));
            }
            let mut events = Vec::new();
            for assignment in assignments {
                tx.execute(
                    "UPDATE collaboration_assignments SET owner_thread_id=?2,status=?3,kind=?4,payload=?5 WHERE id=?1",
                    params![
                        assignment.id.to_string(),
                        assignment.owner_thread_id.map(|id| id.to_string()),
                        snake(assignment.status)?,
                        snake(assignment.kind)?,
                        serde_json::to_string(assignment)?
                    ],
                )?;
                events.extend(append_collaboration_events_in_transaction(
                    &tx,
                    assignment.group_id,
                    EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() },
                )?);
            }
            collaboration_tx_complete(&tx, operation_id, actor, kind, &request, response)?;
            tx.commit()?;
            Ok((response.clone(), events))
        })
    }

    pub fn collaboration_assignment_get(&self, id: AssignmentId) -> Result<Option<CollaborationAssignment>> {
        self.json_optional("SELECT payload FROM collaboration_assignments WHERE id = ?1", id)
    }

    pub fn collaboration_assignments(&self, group_id: GroupId, include_finished: bool) -> Result<Vec<CollaborationAssignment>> {
        let sql = if include_finished {
            "SELECT payload FROM collaboration_assignments WHERE group_id=?1 ORDER BY id"
        } else {
            "SELECT payload FROM collaboration_assignments WHERE group_id=?1 AND status IN ('pending','working','waiting','blocked','attention_needed') ORDER BY id"
        };
        self.json_list(sql, group_id)
    }

    pub fn collaboration_active_assignment_for_thread(&self, thread_id: ThreadId) -> Result<Option<CollaborationAssignment>> {
        self.with(|c| Ok(c.query_row("SELECT payload FROM collaboration_assignments WHERE owner_thread_id=?1 AND status IN ('pending','working','waiting','blocked','attention_needed') ORDER BY id DESC LIMIT 1", [thread_id.to_string()], |r| r.get::<_, String>(0)).optional()?.map(|json| serde_json::from_str(&json)).transpose()?))
    }

    pub fn collaboration_assignment_for_dispatch(&self, message_id: MessageId) -> Result<Option<CollaborationAssignment>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT payload FROM collaboration_assignments WHERE json_extract(payload, '$.dispatch_message_id')=?1 LIMIT 1",
                [message_id.to_string()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|json| serde_json::from_str(&json))
            .transpose()?)
        })
    }

    pub fn collaboration_message_put(&self, message: &CollaborationMessage, delivery_message_id: Option<MessageId>) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO collaboration_messages(id,operation_id,group_id,assignment_id,from_thread_id,to_thread_id,state,delivery_message_id,payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET state=excluded.state,delivery_message_id=excluded.delivery_message_id,payload=excluded.payload",
                params![message.id.to_string(), message.operation_id.to_string(), message.group_id.to_string(), message.assignment_id.map(|id| id.to_string()), message.from_thread_id.map(|id| id.to_string()), message.to_thread_id.to_string(), snake(message.state)?, delivery_message_id.map(|id| id.to_string()), serde_json::to_string(message)?],
            )?;
            Ok(())
        })
    }

    pub fn collaboration_message_create_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        message: &CollaborationMessage,
        delivery_message_id: Option<MessageId>,
        answered: Option<&CollaborationMessage>,
    ) -> Result<(CollaborationMessage, Vec<ThreadEvent>)> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some(response) = collaboration_tx_receipt(&tx, operation_id, actor, "messages.send", &request)? {
                return Ok((serde_json::from_str(&response)?, Vec::new()));
            }
            tx.execute(
                "INSERT INTO collaboration_messages(id,operation_id,group_id,assignment_id,from_thread_id,to_thread_id,state,delivery_message_id,payload) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![message.id.to_string(), message.operation_id.to_string(), message.group_id.to_string(), message.assignment_id.map(|id| id.to_string()), message.from_thread_id.map(|id| id.to_string()), message.to_thread_id.to_string(), snake(message.state)?, delivery_message_id.map(|id| id.to_string()), serde_json::to_string(message)?],
            )?;
            let mut events = Vec::new();
            if let Some(answered) = answered {
                tx.execute(
                    "UPDATE collaboration_messages SET state=?2,payload=?3 WHERE id=?1",
                    params![answered.id.to_string(), snake(answered.state)?, serde_json::to_string(answered)?],
                )?;
                events.extend(append_collaboration_events_in_transaction(
                    &tx,
                    message.group_id,
                    EventPayload::CollaborationMessageUpdated { message: answered.clone() },
                )?);
            }
            collaboration_tx_complete(&tx, operation_id, actor, "messages.send", &request, message)?;
            if delivery_message_id.is_some() {
                events.push(append_event_in_transaction(
                    &tx,
                    message.to_thread_id,
                    None,
                    EventPayload::MessageQueued {
                        message: collaboration_queued_message(message),
                    },
                )?);
            }
            events.extend(append_collaboration_events_in_transaction(
                &tx,
                message.group_id,
                EventPayload::CollaborationMessageUpdated { message: message.clone() },
            )?);
            tx.commit()?;
            Ok((message.clone(), events))
        })
    }

    pub fn collaboration_message_queue(&self, message: &CollaborationMessage) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                "UPDATE collaboration_messages SET state=?2,delivery_message_id=?3,payload=?4 WHERE id=?1",
                params![message.id.to_string(), snake(message.state)?, message.id.to_string(), serde_json::to_string(message)?],
            )?;
            let mut events = vec![append_event_in_transaction(
                &tx,
                message.to_thread_id,
                None,
                EventPayload::MessageQueued { message: collaboration_queued_message(message) },
            )?];
            events.extend(append_collaboration_events_in_transaction(
                &tx,
                message.group_id,
                EventPayload::CollaborationMessageUpdated { message: message.clone() },
            )?);
            tx.commit()?;
            Ok(events)
        })
    }

    pub fn collaboration_message_observed(&self, message: &CollaborationMessage, turn_id: TurnId) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let changed = tx.execute(
                "UPDATE collaboration_messages SET state=?2,delivery_message_id=?3,payload=?4 WHERE id=?1 AND state IN ('persisted','queued')",
                params![message.id.to_string(), snake(message.state)?, message.id.to_string(), serde_json::to_string(message)?],
            )?;
            // A cancellation, answer or another delivery may have won since the
            // snapshot was read. Never resurrect it or emit a second receipt.
            if changed == 0 {
                tx.commit()?;
                return Ok(Vec::new());
            }
            let mut events = vec![append_event_in_transaction(
                &tx,
                message.to_thread_id,
                Some(turn_id),
                EventPayload::MessageRemoved { message_id: message.id },
            )?];
            events.extend(append_collaboration_events_in_transaction(
                &tx,
                message.group_id,
                EventPayload::CollaborationMessageUpdated { message: message.clone() },
            )?);
            tx.commit()?;
            Ok(events)
        })
    }

    pub fn collaboration_message_get(&self, id: CollaborationMessageId) -> Result<Option<CollaborationMessage>> {
        self.json_optional("SELECT payload FROM collaboration_messages WHERE id=?1", id)
    }

    pub fn collaboration_message_for_delivery(&self, message_id: MessageId) -> Result<Option<CollaborationMessage>> {
        self.with(|c| {
            Ok(c.query_row("SELECT payload FROM collaboration_messages WHERE delivery_message_id=?1", [message_id.to_string()], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .map(|json| serde_json::from_str(&json))
            .transpose()?)
        })
    }

    pub fn collaboration_messages(&self, group_id: GroupId) -> Result<Vec<CollaborationMessage>> {
        self.json_list("SELECT payload FROM collaboration_messages WHERE group_id=?1 ORDER BY id", group_id)
    }

    pub fn collaboration_pending_messages(&self) -> Result<Vec<CollaborationMessage>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT payload FROM collaboration_messages WHERE state IN ('persisted','queued') ORDER BY id")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        })
    }

    /// Bounded agent inbox. Recipient scoping belongs inside the query so a
    /// busy group's older messages to peers cannot consume this caller's page.
    pub fn collaboration_pending_messages_for_thread(
        &self,
        group_id: GroupId,
        to_thread_id: ThreadId,
        limit: u32,
    ) -> Result<Vec<CollaborationMessage>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT payload FROM collaboration_messages
                 WHERE group_id=?1 AND to_thread_id=?2
                   AND state IN ('persisted','queued','uncertain')
                 ORDER BY json_extract(payload,'$.created_at'),id LIMIT ?3",
            )?;
            let rows = statement
                .query_map(params![group_id.to_string(), to_thread_id.to_string(), limit.clamp(1, 100)], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        })
    }

    pub fn collaboration_queued_results(&self, group_id: GroupId, to_thread_id: ThreadId) -> Result<Vec<CollaborationMessage>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT payload FROM collaboration_messages
                 WHERE group_id=?1 AND to_thread_id=?2 AND state='queued'
                   AND json_extract(payload,'$.purpose')='result'
                 ORDER BY id",
            )?;
            let rows = statement.query_map(params![group_id.to_string(), to_thread_id.to_string()], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        })
    }

    pub fn collaboration_context_put_cas(&self, entry: &ContextEntry, expected_revision: Option<i64>) -> Result<()> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let current = tx.query_row(
                "SELECT entry_id,revision FROM collaboration_context_revisions WHERE group_id=?1 AND key=?2 ORDER BY revision DESC LIMIT 1",
                params![entry.group_id.to_string(), entry.key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            ).optional()?;
            match (current, expected_revision) {
                (None, None) if entry.revision == 1 => {}
                (Some((id, revision)), Some(expected))
                    if id == entry.id.to_string() && revision == expected && entry.revision == expected + 1 => {}
                _ => anyhow::bail!("context changed; reload its history and retry with the current revision"),
            }
            tx.execute(
                "INSERT INTO collaboration_context_revisions(entry_id,group_id,key,revision,payload) VALUES (?1,?2,?3,?4,?5)",
                params![entry.id.to_string(), entry.group_id.to_string(), entry.key, entry.revision, serde_json::to_string(entry)?],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn collaboration_context_operation(
        &self,
        operation_id: OperationId,
        actor: &str,
        request: &impl serde::Serialize,
        entry: &ContextEntry,
        expected_revision: Option<i64>,
    ) -> Result<ContextEntry> {
        let request = serde_json::to_string(request)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            if let Some((stored_actor, stored_request, state, response)) = tx.query_row(
                "SELECT actor,request,state,response FROM collaboration_operations WHERE operation_id=?1",
                [operation_id.to_string()],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?)),
            ).optional()? {
                if stored_actor != actor || stored_request != request { anyhow::bail!("operation id already belongs to a different actor or request"); }
                if state != "completed" { anyhow::bail!("operation outcome is uncertain; inspect context history before retrying"); }
                return Ok(serde_json::from_str(&response.ok_or_else(|| anyhow::anyhow!("completed operation has no response"))?)?);
            }
            let current = tx.query_row(
                "SELECT entry_id,revision FROM collaboration_context_revisions WHERE group_id=?1 AND key=?2 ORDER BY revision DESC LIMIT 1",
                params![entry.group_id.to_string(), entry.key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            ).optional()?;
            match (current, expected_revision) {
                (None, None) if entry.revision == 1 => {}
                (Some((id, revision)), Some(expected)) if id == entry.id.to_string() && revision == expected && entry.revision == expected + 1 => {}
                _ => anyhow::bail!("context changed; reload its history and retry with the current revision"),
            }
            let now = Utc::now().to_rfc3339();
            tx.execute("INSERT INTO collaboration_context_revisions(entry_id,group_id,key,revision,payload) VALUES (?1,?2,?3,?4,?5)", params![entry.id.to_string(), entry.group_id.to_string(), entry.key, entry.revision, serde_json::to_string(entry)?])?;
            tx.execute("INSERT INTO collaboration_operations(operation_id,actor,operation_kind,request,state,response,created_at,updated_at) VALUES (?1,?2,'context.put',?3,'completed',?4,?5,?5)", params![operation_id.to_string(), actor, request, serde_json::to_string(entry)?, now])?;
            tx.commit()?;
            Ok(entry.clone())
        })
    }

    pub fn collaboration_context_latest(&self, group_id: GroupId) -> Result<Vec<ContextEntry>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT r.payload FROM collaboration_context_revisions r WHERE r.group_id=?1 AND r.revision=(SELECT MAX(x.revision) FROM collaboration_context_revisions x WHERE x.entry_id=r.entry_id) ORDER BY r.key")?;
            let rows = st.query_map([group_id.to_string()], |r| r.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
        })
    }

    pub fn collaboration_context_by_key(&self, group_id: GroupId, key: &str) -> Result<Option<ContextEntry>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT payload FROM collaboration_context_revisions WHERE group_id=?1 AND key=?2 ORDER BY revision DESC LIMIT 1",
                params![group_id.to_string(), key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|json| serde_json::from_str(&json))
            .transpose()?)
        })
    }

    pub fn collaboration_context_history(&self, entry_id: ContextEntryId) -> Result<Vec<ContextEntry>> {
        self.json_list("SELECT payload FROM collaboration_context_revisions WHERE entry_id=?1 ORDER BY revision", entry_id)
    }

    fn json_optional<T: serde::de::DeserializeOwned>(&self, sql: &str, id: Uuid) -> Result<Option<T>> {
        self.with(|c| {
            Ok(c.query_row(sql, [id.to_string()], |r| r.get::<_, String>(0))
                .optional()?
                .map(|value| serde_json::from_str(&value))
                .transpose()?)
        })
    }

    fn json_list<T: serde::de::DeserializeOwned>(&self, sql: &str, id: Uuid) -> Result<Vec<T>> {
        self.with(|c| {
            let mut st = c.prepare(sql)?;
            let rows = st.query_map([id.to_string()], |r| r.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
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
            c.execute(
                "INSERT INTO projects(id, name, path, is_git, worktrees_default, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    p.id.to_string(),
                    p.name,
                    p.path,
                    p.is_git,
                    p.worktrees_default,
                    p.created_at.to_rfc3339(),
                    p.updated_at.to_rfc3339()
                ],
            )?;
            Ok(())
        })
    }

    pub fn project_update(&self, p: &Project) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE projects SET name = ?2, path = ?3, is_git = ?4, worktrees_default = ?5, updated_at = ?6 WHERE id = ?1",
                params![p.id.to_string(), p.name, p.path, p.is_git, p.worktrees_default, p.updated_at.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn project_delete(&self, id: ProjectId) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM projects WHERE id = ?1", [id.to_string()])?;
            Ok(())
        })
    }

    pub fn project_get(&self, id: ProjectId) -> Result<Option<Project>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT id, name, path, is_git, worktrees_default, created_at, updated_at FROM projects WHERE id = ?1",
                [id.to_string()],
                row_to_project,
            )
            .optional()?)
        })
    }

    pub fn project_by_path(&self, path: &str) -> Result<Option<Project>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT id, name, path, is_git, worktrees_default, created_at, updated_at FROM projects WHERE path = ?1",
                [path],
                row_to_project,
            )
            .optional()?)
        })
    }

    pub fn projects_list(&self) -> Result<Vec<Project>> {
        self.with(|c| {
            let mut st =
                c.prepare("SELECT id, name, path, is_git, worktrees_default, created_at, updated_at FROM projects ORDER BY name")?;
            let rows = st.query_map([], row_to_project)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    // ---- threads ----

    pub fn thread_upsert(&self, t: &Thread) -> Result<()> {
        self.with(|c| write_thread(c, t))
    }

    pub fn thread_set_relationships(
        &self,
        thread_id: ThreadId,
        parent_thread_id: Option<ThreadId>,
        coordinator_project_id: Option<ProjectId>,
        collaboration_group_id: Option<GroupId>,
    ) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE threads SET parent_thread_id=COALESCE(parent_thread_id,?2), coordinator_project_id=?3, collaboration_group_id=?4 WHERE id=?1",
                params![
                    thread_id.to_string(),
                    parent_thread_id.map(|id| id.to_string()),
                    coordinator_project_id.map(|id| id.to_string()),
                    collaboration_group_id.map(|id| id.to_string()),
                ],
            )?;
            Ok(())
        })
    }

    pub fn project_coordinator(&self, project_id: ProjectId) -> Result<Option<(ThreadId, GroupId)>> {
        self.with(|c| {
            Ok(c.query_row("SELECT thread_id,group_id FROM project_coordinators WHERE project_id=?1", [project_id.to_string()], |r| {
                Ok((parse_uuid(r.get(0)?)?, parse_uuid(r.get(1)?)?))
            })
            .optional()?)
        })
    }

    pub fn project_coordinator_for_group(&self, group_id: GroupId) -> Result<Option<ProjectId>> {
        self.with(|c| {
            Ok(c.query_row("SELECT project_id FROM project_coordinators WHERE group_id=?1", [group_id.to_string()], |r| {
                parse_uuid(r.get(0)?)
            })
            .optional()?)
        })
    }

    pub fn project_coordinator_reserve(
        &self,
        project_id: ProjectId,
        operation_id: OperationId,
        request: &impl serde::Serialize,
    ) -> Result<(ThreadId, GroupId)> {
        self.with(|c| {
            let request = serde_json::to_string(request)?;
            let existing = c
                .query_row(
                    "SELECT operation_id,request,thread_id,group_id FROM project_coordinator_reservations WHERE project_id=?1",
                    [project_id.to_string()],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
                )
                .optional()?;
            if let Some((stored_operation, stored_request, thread_id, group_id)) = existing {
                if stored_operation != operation_id.to_string() || stored_request != request {
                    anyhow::bail!("project coordinator creation is already reserved by a different request; inspect the project coordinator and retry with the original operation id");
                }
                return Ok((thread_id.parse()?, group_id.parse()?));
            }
            let thread_id = Uuid::now_v7();
            let group_id = Uuid::now_v7();
            c.execute(
                "INSERT INTO project_coordinator_reservations(project_id,operation_id,request,thread_id,group_id,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    project_id.to_string(), operation_id.to_string(), request, thread_id.to_string(), group_id.to_string(), Utc::now().to_rfc3339()
                ],
            )?;
            Ok((thread_id, group_id))
        })
    }

    pub fn project_coordinator_put(&self, project_id: ProjectId, thread_id: ThreadId, group_id: GroupId) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO project_coordinators(project_id,thread_id,group_id) VALUES (?1,?2,?3)
                 ON CONFLICT(project_id) DO NOTHING",
                params![project_id.to_string(), thread_id.to_string(), group_id.to_string()],
            )?;
            Ok(())
        })
    }

    pub fn project_coordinator_create_operation(
        &self,
        operation_id: OperationId,
        request: &impl serde::Serialize,
        result: &ProjectCoordinator,
    ) -> Result<ProjectCoordinator> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let request = serde_json::to_string(request)?;
            if let Some(stored) = collaboration_tx_receipt(&tx, operation_id, "human", "coordinator.get_or_create", &request)? {
                return Ok(serde_json::from_str(&stored)?);
            }
            tx.execute(
                "INSERT INTO project_coordinators(project_id,thread_id,group_id) VALUES (?1,?2,?3)
                 ON CONFLICT(project_id) DO NOTHING",
                params![result.group.project_id.to_string(), result.thread.id.to_string(), result.group.id.to_string()],
            )?;
            tx.execute(
                "UPDATE threads SET coordinator_project_id=?2, collaboration_group_id=?3 WHERE id=?1",
                params![result.thread.id.to_string(), result.group.project_id.to_string(), result.group.id.to_string()],
            )?;
            collaboration_tx_complete(&tx, operation_id, "human", "coordinator.get_or_create", &request, result)?;
            tx.commit()?;
            Ok((*result).clone())
        })
    }

    /// Atomically changes the harness configuration of the persistent
    /// coordinator while retaining its Kybern thread and collaboration group.
    pub fn project_coordinator_switch_operation(
        &self,
        operation_id: OperationId,
        request: &impl serde::Serialize,
        result: &ProjectCoordinator,
        group_changed: bool,
    ) -> Result<(ProjectCoordinator, Vec<ThreadEvent>)> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let request = serde_json::to_string(request)?;
            if let Some(stored) = collaboration_tx_receipt(&tx, operation_id, "human", "coordinator.switch_harness", &request)? {
                return Ok((serde_json::from_str(&stored)?, Vec::new()));
            }
            let mut stored = result.clone();
            let mut events = Vec::new();
            if group_changed {
                tx.execute(
                    "UPDATE collaboration_groups SET coordinator_thread_id=?2,status=?3,payload=?4 WHERE id=?1",
                    params![
                        stored.group.id.to_string(),
                        stored.group.coordinator_thread_id.to_string(),
                        snake(stored.group.status)?,
                        serde_json::to_string(&stored.group)?
                    ],
                )?;
                events.extend(append_collaboration_events_in_transaction(
                    &tx,
                    stored.group.id,
                    EventPayload::CollaborationGroupUpdated { group: stored.group.clone() },
                )?);
            }
            write_thread(&tx, &stored.thread)?;
            let updated = tx.execute(
                "UPDATE threads SET provider_kind=?2, provider_instance=?3 WHERE id=?1",
                params![stored.thread.id.to_string(), stored.thread.provider.kind.as_str(), stored.thread.provider.instance,],
            )?;
            if updated != 1 {
                return Err(anyhow::anyhow!("project coordinator thread disappeared during harness switch"));
            }
            let event =
                append_event_in_transaction(&tx, stored.thread.id, None, EventPayload::ThreadUpdated { thread: stored.thread.clone() })?;
            events.push(event.clone());
            stored.thread.last_seq = event.seq;
            write_thread(&tx, &stored.thread)?;
            collaboration_tx_complete(&tx, operation_id, "human", "coordinator.switch_harness", &request, &stored)?;
            tx.commit()?;
            Ok((stored, events))
        })
    }

    /// Retire a coordinator atomically. Historical events, knowledge, workers,
    /// and worktrees remain available; a new coordinator starts with fresh IDs.
    pub fn project_coordinator_delete_operation(
        &self,
        params: &methods::CollaborationCoordinatorDeleteParams,
        thread: &Thread,
        group: &CollaborationGroup,
    ) -> Result<(Thread, Vec<ThreadEvent>)> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let request = serde_json::to_string(params)?;
            if let Some(stored) = collaboration_tx_receipt(&tx, params.operation_id, "human", "coordinator.delete", &request)? {
                return Ok((serde_json::from_str(&stored)?, Vec::new()));
            }
            let removed = tx.execute(
                "DELETE FROM project_coordinators WHERE project_id=?1 AND thread_id=?2",
                params![params.project_id.to_string(), params.thread_id.to_string()],
            )?;
            if removed != 1 {
                anyhow::bail!("coordinator changed; reopen the project before deleting it");
            }
            tx.execute("DELETE FROM project_coordinator_reservations WHERE project_id=?1", [params.project_id.to_string()])?;
            tx.execute(
                "UPDATE collaboration_groups SET status=?2,payload=?3 WHERE id=?1",
                params![group.id.to_string(), snake(group.status)?, serde_json::to_string(group)?],
            )?;
            let mut events = append_collaboration_events_in_transaction(
                &tx,
                group.id,
                EventPayload::CollaborationGroupUpdated { group: group.clone() },
            )?;
            // Keep members for historical navigation, but revoke agent authority.
            let members = {
                let mut statement = tx.prepare("SELECT payload FROM collaboration_members WHERE group_id=?1")?;
                statement.query_map([group.id.to_string()], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for payload in members {
                let mut member: GroupMember = serde_json::from_str(&payload)?;
                member.active = false;
                tx.execute(
                    "UPDATE collaboration_members SET active=0,payload=?3 WHERE group_id=?1 AND thread_id=?2",
                    params![group.id.to_string(), member.thread_id.to_string(), serde_json::to_string(&member)?],
                )?;
            }
            let mut stored = thread.clone();
            write_thread(&tx, &stored)?;
            for payload in [
                EventPayload::ThreadUpdated { thread: stored.clone() },
                EventPayload::ThreadArchived,
                EventPayload::ProjectCoordinatorDeleted { project_id: params.project_id, coordinator_thread_id: stored.id },
            ] {
                let event = append_event_in_transaction(&tx, stored.id, None, payload)?;
                stored.last_seq = event.seq;
                events.push(event);
            }
            write_thread(&tx, &stored)?;
            collaboration_tx_complete(&tx, params.operation_id, "human", "coordinator.delete", &request, &stored)?;
            tx.commit()?;
            Ok((stored, events))
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

    pub fn thread_notes(&self, thread_id: ThreadId) -> Result<methods::ThreadNotes> {
        self.with(|c| {
            Ok(c.query_row("SELECT text, revision FROM thread_notes WHERE thread_id = ?1", [thread_id.to_string()], |r| {
                Ok(methods::ThreadNotes { text: r.get(0)?, revision: r.get(1)? })
            })
            .optional()?
            .unwrap_or_default())
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

    /// Sequence-bounded collaboration changes, independent of wall-clock
    /// ordering and of which thread is currently the group's coordinator.
    pub fn collaboration_events_after(&self, group_id: GroupId, after: EventSeq, limit: u32, max_bytes: usize) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut statement = c.prepare(
                "SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE seq > ?1 AND kind IN (
                   'collaboration_group_updated', 'collaboration_member_updated',
                   'collaboration_assignment_updated', 'collaboration_message_updated',
                   'collaboration_context_updated'
                 ) AND (COALESCE(
                   json_extract(payload, '$.group.id'), json_extract(payload, '$.member.group_id'),
                   json_extract(payload, '$.assignment.group_id'), json_extract(payload, '$.message.group_id'),
                   json_extract(payload, '$.entry.group_id')
                 ) = ?2 OR (
                   kind = 'collaboration_context_updated'
                   AND json_extract(payload, '$.entry.group_id') = (
                     SELECT pc.group_id FROM collaboration_groups requested
                     JOIN project_coordinators pc ON pc.project_id = requested.project_id
                     WHERE requested.id = ?2
                   )
                 )) ORDER BY seq LIMIT ?3",
            )?;
            let mut rows = statement.query(params![after, group_id.to_string(), limit.clamp(1, 200)])?;
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

    pub fn events_for_thread(&self, thread_id: ThreadId) -> Result<Vec<ThreadEvent>> {
        self.events_for_thread_through(thread_id, i64::MAX)
    }

    pub fn events_for_thread_recent(&self, thread_id: ThreadId, limit: u32) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT seq,thread_id,turn_id,at,payload FROM (SELECT seq,thread_id,turn_id,at,payload FROM events WHERE thread_id=?1 ORDER BY seq DESC LIMIT ?2) ORDER BY seq")?;
            Ok(st.query_map(params![thread_id.to_string(), limit.clamp(1, 1000)], row_to_event)?.collect::<Result<Vec<_>, _>>()?)
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
            let mut st = c.prepare(
                "SELECT seq,thread_id,turn_id,at,payload FROM (
                   SELECT seq,thread_id,turn_id,at,payload FROM events
                   WHERE thread_id=?1 AND seq<=?2 AND seq<?3
                     AND kind IN ('turn_started','assistant_message_completed')
                   ORDER BY seq DESC LIMIT ?4
                 ) ORDER BY seq",
            )?;
            Ok(st
                .query_map(params![thread_id.to_string(), through_seq, before, limit.clamp(1, 200) + 1], row_to_event)?
                .collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Latest user-authored turn, excluding collaboration deliveries. A new
    /// human turn resets bounded automatic peer wakeups for that chat task.
    pub fn thread_latest_human_turn_at(&self, thread_id: ThreadId) -> Result<Option<DateTime<Utc>>> {
        self.with(|c| {
            c.query_row(
                "SELECT e.at FROM events e
                 LEFT JOIN collaboration_messages cm ON cm.delivery_message_id=json_extract(e.payload,'$.message_id')
                 WHERE e.thread_id=?1 AND e.kind='turn_started' AND cm.id IS NULL
                 ORDER BY e.seq DESC LIMIT 1",
                [thread_id.to_string()],
                |row| parse_time(row.get(0)?),
            )
            .optional()
            .map_err(Into::into)
        })
    }

    /// Keep a hydrated transcript aligned with the thread's acknowledged head.
    pub fn events_for_thread_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut st =
                c.prepare("SELECT seq, thread_id, turn_id, at, payload FROM events WHERE thread_id = ?1 AND seq <= ?2 ORDER BY seq")?;
            Ok(st.query_map(params![thread_id.to_string(), through_seq], row_to_event)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Fold the transcript without retaining every event payload at once.
    pub fn project_transcript_through(&self, thread_id: ThreadId, through_seq: EventSeq) -> Result<Vec<TranscriptEntry>> {
        self.with(|c| {
            // Exclude only the known no-op arm of apply_transcript_event. In
            // particular, terminal/tool output deltas can be large but never
            // contribute a transcript row. Other projections and replay still
            // read the unchanged event log. Unknown/new kinds are NOT excluded.
            // Keep this list aligned with that no-op arm when event behavior changes.
            let mut statement = c.prepare(
                "SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE thread_id = ?1 AND seq <= ?2 AND kind NOT IN (
                   'async_questions_requested', 'provider_commands_updated', 'provider_usage_updated',
                   'thread_created', 'thread_updated', 'message_queued', 'message_queue_updated',
                   'project_coordinator_deleted', 'collaboration_group_updated', 'collaboration_member_updated',
                   'collaboration_assignment_updated', 'collaboration_message_updated', 'collaboration_context_updated',
                   'thread_notes_updated', 'message_removed', 'thread_archived', 'tool_call_output_delta', 'checkpoint_updated'
                 ) ORDER BY seq",
            )?;
            let mut rows = statement.query(params![thread_id.to_string(), through_seq])?;
            let mut fold = TranscriptFold::omitting_tool_outputs();
            while let Some(row) = rows.next()? {
                fold.apply(&row_to_event(row)?);
            }
            Ok(fold.finish())
        })
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
            read_tool_output_at_start(&mut statement, thread_id, tool_call_id, start, through_seq)
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

    pub fn approval_resolve(&self, id: ApprovalId, decision: &ApprovalDecision) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE approvals SET resolved = 1, decision = ?2 WHERE id = ?1",
                params![id.to_string(), serde_json::to_string(decision)?],
            )?;
            Ok(())
        })
    }

    pub fn approval_get(&self, id: ApprovalId) -> Result<Option<(ApprovalRequest, bool)>> {
        self.with(|c| {
            Ok(c.query_row("SELECT payload, resolved FROM approvals WHERE id = ?1", [id.to_string()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
            })
            .optional()?
            .map(|(p, resolved)| serde_json::from_str::<ApprovalRequest>(&p).map(|a| (a, resolved)))
            .transpose()?)
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
            conn.execute(
                "INSERT INTO checkpoints(turn_id, thread_id, before_commit, after_commit, created_at, provider_turn_id, provider_turn_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(turn_id) DO UPDATE SET after_commit = excluded.after_commit,
                    provider_turn_id = COALESCE(excluded.provider_turn_id, checkpoints.provider_turn_id),
                    provider_turn_end = COALESCE(excluded.provider_turn_end, checkpoints.provider_turn_end)",
                params![
                    c.turn_id.to_string(),
                    c.thread_id.to_string(),
                    c.before,
                    c.after,
                    c.created_at.to_rfc3339(),
                    c.provider_turn_id,
                    c.provider_turn_end
                ],
            )?;
            Ok(())
        })
    }

    pub fn checkpoint_get(&self, turn_id: TurnId) -> Result<Option<Checkpoint>> {
        self.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT turn_id, thread_id, before_commit, after_commit, created_at, provider_turn_id, provider_turn_end FROM checkpoints WHERE turn_id = ?1",
                    [turn_id.to_string()],
                    row_to_checkpoint,
                )
                .optional()?)
        })
    }

    pub fn checkpoints_for_thread(&self, thread_id: ThreadId) -> Result<Vec<Checkpoint>> {
        self.with(|conn| {
            let mut st = conn.prepare(
                "SELECT turn_id, thread_id, before_commit, after_commit, created_at, provider_turn_id, provider_turn_end FROM checkpoints WHERE thread_id = ?1 ORDER BY created_at",
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
                "SELECT t.provider_kind, e.payload FROM events e
                 JOIN threads t ON t.id = e.thread_id
                 WHERE e.kind = 'provider_usage_updated' ORDER BY e.seq ASC",
            )?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut by_provider: BTreeMap<String, BTreeMap<String, UsageLimit>> = BTreeMap::new();
            for row in rows {
                let (provider, payload) = row?;
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
                let Some(limits) = value.get("usage").and_then(|u| u.get("limits")).and_then(|l| l.as_array()) else {
                    continue;
                };
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
                    Some(methods::ProviderLimits { provider, limits })
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
    parent_thread_id, coordinator_project_id, collaboration_group_id FROM threads";

fn row_to_project(r: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: parse_uuid(r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        path: r.get(2)?,
        is_git: r.get(3)?,
        worktrees_default: r.get(4)?,
        created_at: parse_time(r.get::<_, String>(5)?)?,
        updated_at: parse_time(r.get::<_, String>(6)?)?,
    })
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
        collaboration_group_id: r.get::<_, Option<String>>(19)?.map(parse_uuid).transpose()?,
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
    })
}

// Completion lookup uses the existing tool_completion_lookup index. The
// intervening-start check ranges over the thread's sequence index, and prevents
// crossing a reused call ID without adding a migration or a second read model.
const TOOL_OUTPUT_AT_START_SQL: &str = "
    SELECT c.payload FROM events c
    WHERE c.thread_id = ?1 AND c.kind = 'tool_call_completed'
      AND json_extract(c.payload, '$.tool_call_id') = ?2
      AND c.seq > ?3 AND c.seq <= ?4
      AND EXISTS (SELECT 1 FROM events s WHERE s.seq = ?3 AND s.thread_id = ?1
                  AND s.kind = 'tool_call_started' AND json_extract(s.payload, '$.call.id') = ?2)
      AND NOT EXISTS (SELECT 1 FROM events n WHERE n.thread_id = ?1
                      AND n.seq > ?3 AND n.seq <= c.seq AND n.kind = 'tool_call_started'
                      AND json_extract(n.payload, '$.call.id') = ?2)
    ORDER BY c.seq DESC LIMIT 1";

fn read_tool_output_at_start(
    statement: &mut rusqlite::Statement<'_>,
    thread_id: ThreadId,
    tool_call_id: &str,
    start_seq: EventSeq,
    through_seq: EventSeq,
) -> Result<Option<(serde_json::Value, bool)>> {
    let mut rows = statement.query(params![thread_id.to_string(), tool_call_id, start_seq, through_seq])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let payload: EventPayload = serde_json::from_str(row.get_ref(0)?.as_str()?)?;
    match payload {
        EventPayload::ToolCallCompleted { output, is_error, .. } => Ok(Some((output, is_error))),
        _ => anyhow::bail!("invalid stored tool completion"),
    }
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
                    parent_thread_id, coordinator_project_id, collaboration_group_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title, model = excluded.model, effort = excluded.effort, permission_mode = excluded.permission_mode,
                    status = excluded.status, worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch,
                    cwd = excluded.cwd, provider_session_id = excluded.provider_session_id, pinned = excluded.pinned,
                    updated_at = excluded.updated_at, last_seq = excluded.last_seq,
                    parent_thread_id = COALESCE(threads.parent_thread_id, excluded.parent_thread_id),
                    coordinator_project_id = excluded.coordinator_project_id,
                    collaboration_group_id = excluded.collaboration_group_id",
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
            t.collaboration_group_id.map(|id| id.to_string()),
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collaboration_fixture() -> (Store, CollaborationGroup) {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "collab".into(),
            path: format!("/tmp/{}", Uuid::now_v7()),
            is_git: false,
            worktrees_default: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "coordinator".into(),
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
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
        };
        store.thread_upsert(&thread).unwrap();
        let group = CollaborationGroup {
            id: Uuid::now_v7(),
            project_id: project.id,
            coordinator_thread_id: thread.id,
            objective: "test".into(),
            success_criteria: vec![],
            status: GroupStatus::Active,
            coordinator_mode: CoordinatorMode::Ordinary,
            policy: CollaborationPolicy::default(),
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        store.collaboration_group_put(&group).unwrap();
        (store, group)
    }

    #[test]
    fn context_compare_and_swap_and_receipt_are_one_transaction() {
        let (store, group) = collaboration_fixture();
        let now = Utc::now();
        let first_op = Uuid::now_v7();
        let first = ContextEntry {
            id: first_op,
            group_id: group.id,
            key: "decision".into(),
            kind: ContextEntryKind::Decision,
            body: "first".into(),
            author_thread_id: None,
            user_authored: true,
            revision: 1,
            source_refs: vec![],
            created_at: now,
            updated_at: now,
        };
        let request = serde_json::json!({"operation_id": first_op, "body": "first"});
        assert_eq!(store.collaboration_context_operation(first_op, "human", &request, &first, None).unwrap(), first);
        assert_eq!(store.collaboration_context_operation(first_op, "human", &request, &first, None).unwrap(), first);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let attempts = ["second-a", "second-b"].map(|body| {
            let store = store.clone();
            let barrier = barrier.clone();
            let mut entry = first.clone();
            entry.body = body.into();
            entry.revision = 2;
            entry.updated_at = Utc::now();
            std::thread::spawn(move || {
                let op = Uuid::now_v7();
                let request = serde_json::json!({"operation_id": op, "body": body});
                barrier.wait();
                store.collaboration_context_operation(op, "human", &request, &entry, Some(1))
            })
        });
        barrier.wait();
        let results = attempts.map(|attempt| attempt.join().unwrap());
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(store.collaboration_context_history(first.id).unwrap().len(), 2);
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
            created_at: now,
            updated_at: now,
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
            collaboration_group_id: None,
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
    fn roundtrip_project_thread_events() {
        let s = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let p = Project {
            id: Uuid::now_v7(),
            name: "demo".into(),
            path: "/tmp/demo".into(),
            is_git: false,
            worktrees_default: None,
            created_at: now,
            updated_at: now,
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
            collaboration_group_id: None,
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
    }

    #[test]
    fn observed_collaboration_message_acknowledges_only_intended_delivery() {
        let (store, group) = collaboration_fixture();
        let recipient = group.coordinator_thread_id;
        let mut other_thread = store.thread_get(recipient).unwrap().unwrap();
        other_thread.id = Uuid::now_v7();
        other_thread.title = "other recipient".into();
        store.thread_upsert(&other_thread).unwrap();
        let now = Utc::now();
        let make = |to_thread_id, state| CollaborationMessage {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            group_id: group.id,
            assignment_id: None,
            from_thread_id: None,
            to_thread_id,
            external_recipient: false,
            purpose: CollaborationMessagePurpose::Result,
            reply_to: None,
            body: "done".into(),
            state,
            delivery_turn_id: None,
            wakeup_count: 1,
            created_at: now,
            updated_at: now,
        };
        let intended = make(recipient, CollaborationDeliveryState::Queued);
        let other = make(other_thread.id, CollaborationDeliveryState::Queued);
        let cancelled = make(recipient, CollaborationDeliveryState::Cancelled);
        for message in [&intended, &other, &cancelled] {
            store.collaboration_message_put(message, Some(message.id)).unwrap();
            if message.state == CollaborationDeliveryState::Queued {
                store
                    .event_append(
                        message.to_thread_id,
                        None,
                        EventPayload::MessageQueued { message: collaboration_queued_message(message) },
                    )
                    .unwrap();
            }
        }
        let turn_id = Uuid::now_v7();
        let mut observed = intended.clone();
        observed.state = CollaborationDeliveryState::Submitted;
        observed.delivery_turn_id = Some(turn_id);
        observed.updated_at = Utc::now();
        store.collaboration_message_observed(&observed, turn_id).unwrap();

        let stored = store.collaboration_message_get(intended.id).unwrap().unwrap();
        assert_eq!(stored.state, CollaborationDeliveryState::Submitted);
        assert_eq!(stored.delivery_turn_id, Some(turn_id));
        assert!(store.collaboration_message_observed(&observed, turn_id).unwrap().is_empty(), "delivery is idempotent");
        let mut stale = cancelled.clone();
        stale.state = CollaborationDeliveryState::Submitted;
        stale.delivery_turn_id = Some(turn_id);
        assert!(store.collaboration_message_observed(&stale, turn_id).unwrap().is_empty(), "cancellation wins over an old read");
        assert!(!store.queue_is_pending(intended.id).unwrap());
        assert!(store.queue_is_pending(other.id).unwrap());
        assert_eq!(store.collaboration_message_get(cancelled.id).unwrap().unwrap().state, CollaborationDeliveryState::Cancelled);
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
            created_at: now,
            updated_at: now,
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
            collaboration_group_id: None,
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
        let output = serde_json::json!("x".repeat(LARGE_TOOL_OUTPUT_BYTES + 8));
        store
            .event_append(
                thread.id,
                Some(turn),
                EventPayload::ToolCallCompleted {
                    tool_call_id: "big".into(),
                    output: output.clone(),
                    output_omitted: false,
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
                    EventPayload::ToolCallCompleted { tool_call_id: id, output: output.clone(), output_omitted: false, is_error: false },
                )
                .unwrap();
        }
        let events = store.events_for_thread_through(thread.id, i64::MAX).unwrap();
        let event_bytes = serde_json::to_vec(&events).unwrap().len();
        let transcript = store.project_transcript_through(thread.id, i64::MAX).unwrap();
        let transcript_bytes = serde_json::to_vec(&transcript).unwrap().len();
        assert!(transcript_bytes * 10 < event_bytes, "cached projection {transcript_bytes} should drop the {event_bytes}-byte event log");
        eprintln!("tool-output-omit event_bytes={event_bytes} transcript_bytes={transcript_bytes}");
        assert!(matches!(
            transcript.iter().find(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })),
            Some(TranscriptEntry::ToolCall { output: None, output_omitted: true, .. })
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
mod tool_output_allocation_tests {
    use super::*;

    // The real hydration SQL with a small isolated event table. No daemon,
    // migration, provider process, or production data is involved in this fixture.
    fn fixture() -> Store {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE events (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);",
        )
        .unwrap();
        Store { conn: Arc::new(Mutex::new(conn)) }
    }

    fn complete(store: &Store, thread: ThreadId, id: &str, output: serde_json::Value, is_error: bool) {
        let payload = EventPayload::ToolCallCompleted { tool_call_id: id.into(), output, output_omitted: false, is_error };
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
            assert_eq!(serde_json::to_value(actual).unwrap(), serde_json::to_value(expected).unwrap(), "snapshot={end}");
        }
        assert!(store.project_transcript_through(ThreadId::new_v4(), i64::MAX).unwrap().is_empty());
        assert_eq!(store.events_for_thread_through(thread, i64::MAX).unwrap().len(), events.len(), "full replay remains untouched");
    }
}
