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
    // v13: notes across global, project and thread scopes. No foreign keys: a note
    // outlives its project or thread (it moves to Recently deleted instead). Thread
    // notes from the old per-thread notepad are copied over; `thread_notes` stays
    // behind untouched.
    "
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT,
        thread_id TEXT UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        origin TEXT
    );
    CREATE INDEX notes_deleted ON notes(deleted_at);
    CREATE INDEX notes_project ON notes(project_id);
    INSERT INTO notes(id, scope, project_id, thread_id, title, body, pinned, revision, created_at, updated_at)
    SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
            || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
        'thread', t.project_id, n.thread_id, t.title, n.text, 0, n.revision,
        COALESCE((SELECT MIN(at) FROM events WHERE thread_id = n.thread_id AND kind = 'thread_notes_updated'), t.created_at),
        COALESCE((SELECT MAX(at) FROM events WHERE thread_id = n.thread_id AND kind = 'thread_notes_updated'), t.updated_at)
    FROM thread_notes n JOIN threads t ON t.id = n.thread_id
    WHERE trim(n.text) != '';
    ",
    // v14: user tasks. No foreign key to projects or notes: a task outlives its
    // project (it is soft deleted with it) and a note link is only a reference.
    // `task_counters` hands out each key number once, so a key is never reused even
    // after its task is purged. Projects get a `task_prefix`; existing projects are
    // backfilled by the store when it opens (the derivation lives in Rust).
    "
    ALTER TABLE projects ADD COLUMN task_prefix TEXT;
    CREATE UNIQUE INDEX projects_task_prefix ON projects(task_prefix) WHERE task_prefix IS NOT NULL;
    CREATE TABLE task_counters (
        prefix TEXT PRIMARY KEY,
        next INTEGER NOT NULL
    );
    CREATE TABLE task_items (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        project_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        rank REAL NOT NULL,
        source_note_id TEXT,
        pending_followup TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status_changed_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE INDEX task_items_status ON task_items(status, rank);
    CREATE INDEX task_items_project ON task_items(project_id);
    CREATE INDEX task_items_deleted ON task_items(deleted_at);
    CREATE TABLE task_runs (
        task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        provider_kind TEXT NOT NULL,
        provider_instance TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        state TEXT NOT NULL,
        activity TEXT,
        diff_added INTEGER,
        diff_removed INTEGER,
        diff_files INTEGER,
        notes TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (task_id, number)
    );
    CREATE TABLE task_item_notes (
        task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
        note_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (task_id, note_id)
    );
    ",
    // v15: notes and tasks an agent created through its native tools remember the
    // thread that made them. Items the user creates leave it empty. No foreign key:
    // the item outlives the thread.
    "
    ALTER TABLE notes ADD COLUMN created_by_thread_id TEXT;
    ALTER TABLE task_items ADD COLUMN created_by_thread_id TEXT;
    ",
    // v16: a combined run is one thread that several tasks each record a run for,
    // so a thread id no longer identifies one run. SQLite cannot drop a UNIQUE
    // constraint, so the table is rebuilt (in one transaction) with a plain index.
    "
    BEGIN;
    CREATE TABLE task_runs_v16 (
        task_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        provider_instance TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        state TEXT NOT NULL,
        activity TEXT,
        diff_added INTEGER,
        diff_removed INTEGER,
        diff_files INTEGER,
        notes TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (task_id, number)
    );
    INSERT INTO task_runs_v16(task_id, number, thread_id, provider_kind, provider_instance, model, started_at, ended_at, state,
                              activity, diff_added, diff_removed, diff_files, notes)
    SELECT task_id, number, thread_id, provider_kind, provider_instance, model, started_at, ended_at, state,
           activity, diff_added, diff_removed, diff_files, notes
    FROM task_runs ORDER BY rowid;
    DROP TABLE task_runs;
    ALTER TABLE task_runs_v16 RENAME TO task_runs;
    CREATE INDEX task_runs_thread ON task_runs(thread_id);
    COMMIT;
    ",
    // v17: read-only child threads that mirror provider-native subagents. The
    // JSON `subagent` column marks them and carries their lifecycle; one
    // runtime task of one session maps to exactly one child thread.
    "
    ALTER TABLE threads ADD COLUMN subagent TEXT;
    CREATE UNIQUE INDEX threads_subagent_task
      ON threads(json_extract(subagent, '$.root_thread_id'), json_extract(subagent, '$.task_id'))
      WHERE subagent IS NOT NULL;
    CREATE INDEX threads_parent ON threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL;
    ",
    // v18: Orchestrator V2. Threads another thread delegated work to carry a JSON
    // `delegation` (one delegation per operation and per task id), and messages
    // between threads get their own table so held ones survive restarts.
    "
    ALTER TABLE threads ADD COLUMN delegation TEXT;
    CREATE UNIQUE INDEX threads_delegation_operation
      ON threads(json_extract(delegation, '$.operation_id'))
      WHERE delegation IS NOT NULL;
    CREATE UNIQUE INDEX threads_delegation_task
      ON threads(json_extract(delegation, '$.task_id'))
      WHERE delegation IS NOT NULL;
    CREATE TABLE thread_messages(
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        from_thread_id TEXT,
        to_thread_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        reply_to TEXT,
        body TEXT NOT NULL,
        delivery TEXT NOT NULL,
        state TEXT NOT NULL,
        held_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX thread_messages_to ON thread_messages(to_thread_id, state);
    CREATE INDEX thread_messages_from ON thread_messages(from_thread_id);
    CREATE INDEX thread_messages_reply ON thread_messages(reply_to);
    ",
    // v19: durable inline visual source, independent of a thread's workspace.
    "CREATE TABLE html_visuals (
       id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
       title TEXT NOT NULL,
       height INTEGER NOT NULL,
       html TEXT NOT NULL
     ); CREATE INDEX html_visuals_thread ON html_visuals(thread_id);",
    // v20: bounded, indexed identity lookup for preview-result persistence.
    "CREATE INDEX tool_start_identity ON events(thread_id, json_extract(payload, '$.call.id'), seq)
      WHERE kind = 'tool_call_started';",
    // v21: durable native child inbox, bound to the admitted process.
    "CREATE TABLE subagent_messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_instance_id TEXT NOT NULL,
      task_id TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX subagent_messages_child ON subagent_messages(thread_id);
      CREATE INDEX subagent_messages_pending ON subagent_messages(session_instance_id, task_id, status);",
    // v22: historical answer overlays must not scan large unrelated event logs.
    "CREATE INDEX assistant_recovery_identity ON events(thread_id, json_extract(payload, '$.message_id'), seq)
      WHERE kind = 'assistant_message_blocks_recovered';",
    // v23: lifecycle settlement queries only pending messages, independently of UI history.
    "CREATE INDEX subagent_messages_pending_child ON subagent_messages(thread_id) WHERE status = 'pending';
      CREATE INDEX subagent_messages_pending_owner ON subagent_messages(session_instance_id) WHERE status = 'pending';
      CREATE INDEX subagent_messages_pending_status ON subagent_messages(status) WHERE status = 'pending';",
];

pub fn migrate(conn: &Connection) -> Result<()> {
    migrate_to(conn, MIGRATIONS.len())
}

/// Apply migrations up to `target` (a schema version). Tests use it to build an older database.
pub(crate) fn migrate_to(conn: &Connection, target: usize) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().take(target).skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        tracing::info!(version = i + 1, "applied store migration");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn migration_count() -> usize {
    MIGRATIONS.len()
}
