use anyhow::Result;
use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    // v1
    "
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        is_git INTEGER NOT NULL,
        worktrees_default INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        provider_instance TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        worktree_path TEXT,
        worktree_branch TEXT,
        cwd TEXT NOT NULL,
        provider_session_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX threads_project ON threads(project_id, updated_at);

    CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
    );
    CREATE INDEX events_thread ON events(thread_id, seq);

    CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        decision TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX approvals_pending ON approvals(resolved, thread_id);

    CREATE TABLE turn_usage (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd REAL,
        duration_ms INTEGER NOT NULL,
        at TEXT NOT NULL
    );

    CREATE TABLE device_push_tokens (
        token TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    ",
    // v2: git checkpoints per turn
    "
    CREATE TABLE checkpoints (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        before_commit TEXT NOT NULL,
        after_commit TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX checkpoints_thread ON checkpoints(thread_id, created_at);
    ",
    // v3: provider anchors for conversation rewind
    "
    ALTER TABLE checkpoints ADD COLUMN provider_turn_id TEXT;
    ALTER TABLE checkpoints ADD COLUMN provider_turn_end TEXT;
    ",
    // v4: uploaded assets
    "
    CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    ",
    // v5: per-thread reasoning effort
    "
    ALTER TABLE threads ADD COLUMN effort TEXT;
    ",
    // v6: durable follow-ups, including consumed/canceled receipts for retry deduplication.
    "
    CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        pending INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX queue_pending ON queued_messages(pending, seq);
    ",
    // v7: synchronized user notes and durable steering receipts.
    "
    CREATE TABLE thread_notes (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        revision INTEGER NOT NULL
    );
    CREATE TABLE steered_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        payload TEXT NOT NULL
    );
    ",
    // v8: page native Artifact calls without hydrating the conversation.
    "
    CREATE INDEX artifact_calls ON events(thread_id, seq DESC)
      WHERE kind = 'tool_call_started' AND json_extract(payload, '$.call.name') = 'Artifact';
    CREATE INDEX tool_completion_lookup ON events(thread_id, json_extract(payload, '$.tool_call_id'))
      WHERE kind = 'tool_call_completed';
    ",
    // v9: daemon-owned collaboration through the lasting-context phase.
    "
    CREATE TABLE collaboration_groups (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        coordinator_thread_id TEXT NOT NULL REFERENCES threads(id),
        status TEXT NOT NULL,
        payload TEXT NOT NULL
    );
    CREATE INDEX collaboration_groups_project ON collaboration_groups(project_id, status);

    CREATE TABLE collaboration_members (
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        active INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(group_id, thread_id)
    );
    CREATE UNIQUE INDEX collaboration_one_active_group_per_thread ON collaboration_members(thread_id) WHERE active = 1;

    CREATE TABLE collaboration_assignments (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        owner_thread_id TEXT REFERENCES threads(id),
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
    );
    CREATE INDEX collaboration_assignments_group ON collaboration_assignments(group_id, status);
    CREATE UNIQUE INDEX collaboration_one_mutating_assignment_per_worker
      ON collaboration_assignments(owner_thread_id)
      WHERE owner_thread_id IS NOT NULL AND kind IN ('edit', 'integration') AND status IN ('pending', 'working', 'waiting', 'blocked');

    CREATE TABLE collaboration_messages (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        assignment_id TEXT REFERENCES collaboration_assignments(id),
        from_thread_id TEXT REFERENCES threads(id),
        to_thread_id TEXT NOT NULL REFERENCES threads(id),
        state TEXT NOT NULL,
        delivery_message_id TEXT UNIQUE,
        payload TEXT NOT NULL
    );
    CREATE INDEX collaboration_messages_recipient ON collaboration_messages(to_thread_id, state);
    CREATE INDEX collaboration_messages_group ON collaboration_messages(group_id, id);

    CREATE TABLE collaboration_context_revisions (
        entry_id TEXT NOT NULL,
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(entry_id, revision),
        UNIQUE(group_id, key, revision)
    );
    CREATE INDEX collaboration_context_latest ON collaboration_context_revisions(group_id, key, revision DESC);

    CREATE TABLE collaboration_operations (
        operation_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        request TEXT NOT NULL,
        state TEXT NOT NULL,
        response TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    ",
    // v10: chat-first thread relationships and one persistent coordinator per project.
    "
    ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id);
    ALTER TABLE threads ADD COLUMN coordinator_project_id TEXT REFERENCES projects(id);
    ALTER TABLE threads ADD COLUMN collaboration_group_id TEXT;
    CREATE UNIQUE INDEX threads_one_project_coordinator ON threads(coordinator_project_id)
      WHERE coordinator_project_id IS NOT NULL;
    CREATE TABLE project_coordinators (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL UNIQUE REFERENCES collaboration_groups(id) ON DELETE CASCADE
    );
    ",
    // v11: reserve deterministic coordinator identities before filesystem or thread side effects.
    "
    CREATE TABLE project_coordinator_reservations (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
    );
    ",
    // v12: retry-safe client sends resolve a message id without scanning long-lived history.
    "
    CREATE UNIQUE INDEX events_turn_started_message_id
      ON events(json_extract(payload, '$.message_id'))
      WHERE kind = 'turn_started';
    ",
];

pub fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        tracing::info!(version = i + 1, "applied store migration");
    }
    Ok(())
}
