//! SQLite persistence. One database per daemon, WAL mode, event-sourced threads.
//!
//! The store is synchronous; the daemon wraps calls in `spawn_blocking` when
//! they may take more than a few milliseconds (replays, projections).

mod projection;
mod schema;

pub use projection::{project_runtime_tasks, project_thread_activity, project_transcript};

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use kybern_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

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
        self.with(|c| {
            c.execute(
                "INSERT INTO threads(id, project_id, title, provider_kind, provider_instance, model, effort, permission_mode,
                    status, worktree_path, worktree_branch, cwd, provider_session_id, pinned, created_at, updated_at, last_seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title, model = excluded.model, effort = excluded.effort, permission_mode = excluded.permission_mode,
                    status = excluded.status, worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch,
                    cwd = excluded.cwd, provider_session_id = excluded.provider_session_id, pinned = excluded.pinned,
                    updated_at = excluded.updated_at, last_seq = excluded.last_seq",
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
                ],
            )?;
            Ok(())
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
    pub fn event_append(&self, thread_id: ThreadId, turn_id: Option<TurnId>, mut payload: EventPayload) -> Result<ThreadEvent> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let c = &tx;
            let at = Utc::now();
            let kind = serde_json::to_value(&payload)?.get("kind").and_then(|k| k.as_str()).unwrap_or("unknown").to_string();
            let serialized = serde_json::to_string(&payload)?;
            c.execute(
                "INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![thread_id.to_string(), turn_id.map(|t| t.to_string()), at.to_rfc3339(), kind, serialized],
            )?;
            let seq = c.last_insert_rowid();
            if stamp_runtime_task_sequence(&mut payload, seq) {
                c.execute("UPDATE events SET payload = ?2 WHERE seq = ?1", params![seq, serde_json::to_string(&payload)?])?;
            }
            c.execute(
                "UPDATE threads SET last_seq = ?2, updated_at = ?3 WHERE id = ?1",
                params![thread_id.to_string(), seq, at.to_rfc3339()],
            )?;
            match &payload {
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
            tx.commit()?;
            Ok(ThreadEvent { seq, thread_id, turn_id, at, payload })
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

    pub fn queue_receipt(&self, id: MessageId) -> Result<Option<methods::QueuedMessage>> {
        self.with(|c| {
            let payload: Option<String> =
                c.query_row("SELECT payload FROM queued_messages WHERE id = ?1", [id.to_string()], |r| r.get(0)).optional()?;
            payload.map(|payload| Ok(serde_json::from_str(&payload)?)).transpose()
        })
    }

    pub fn events_head_seq(&self) -> Result<EventSeq> {
        self.with(|c| Ok(c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?))
    }

    /// Events with `seq > after`, optionally filtered by thread, ascending, at most `limit`.
    pub fn events_after(&self, thread_id: Option<ThreadId>, after: EventSeq, limit: u32) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let sql = match thread_id {
                Some(_) => {
                    "SELECT seq, thread_id, turn_id, at, payload FROM events WHERE seq > ?1 AND thread_id = ?2 ORDER BY seq LIMIT ?3"
                }
                None => "SELECT seq, thread_id, turn_id, at, payload FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?3",
            };
            let mut st = c.prepare(sql)?;
            let rows = match thread_id {
                Some(t) => st.query_map(params![after, t.to_string(), limit], row_to_event)?.collect::<Result<Vec<_>, _>>()?,
                None => st.query_map(params![after, "", limit], row_to_event)?.collect::<Result<Vec<_>, _>>()?,
            };
            Ok(rows)
        })
    }

    pub fn events_for_thread(&self, thread_id: ThreadId) -> Result<Vec<ThreadEvent>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT seq, thread_id, turn_id, at, payload FROM events WHERE thread_id = ?1 ORDER BY seq")?;
            Ok(st.query_map([thread_id.to_string()], row_to_event)?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn runtime_tasks_for_thread(&self, thread_id: ThreadId) -> Result<Vec<RuntimeTask>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT seq, thread_id, turn_id, at, payload FROM events
                 WHERE thread_id = ?1 AND kind IN ('runtime_task_started', 'runtime_task_updated', 'runtime_task_completed')
                 ORDER BY seq",
            )?;
            let events = st.query_map([thread_id.to_string()], row_to_event)?.collect::<Result<Vec<_>, _>>()?;
            Ok(project_runtime_tasks(&events))
        })
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
    worktree_path, worktree_branch, cwd, provider_session_id, pinned, created_at, updated_at, last_seq FROM threads";

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

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
