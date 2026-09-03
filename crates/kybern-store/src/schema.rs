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
