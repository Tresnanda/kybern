//! Notes: user-owned markdown pages in the global, project and thread scopes.
//!
//! The `notes` table has no foreign keys on purpose. A note outlives its project
//! or thread: removing a project soft-deletes its notes (Recently deleted), and
//! restoring one whose owner is gone turns it into a global note.

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use kybern_protocol::methods::{Note, NoteChecklist, NoteId, NoteScope, NoteSearchHit, NoteSummary};
use kybern_protocol::{ProjectId, ThreadId, is_free_chat_project};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::{Store, other, parse_time, parse_uuid};

/// Largest accepted note body.
pub const NOTE_BODY_MAX_BYTES: usize = 512 * 1024;
/// Longest accepted note title.
pub const NOTE_TITLE_MAX_CHARS: usize = 300;
/// How long a deleted note stays restorable.
pub const NOTE_RETENTION_DAYS: i64 = 30;
const PREVIEW_MAX_CHARS: usize = 240;
const SNIPPET_CHARS: usize = 120;

/// A failure the caller can act on. Everything else is an internal error.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum NoteError {
    #[error("{0}")]
    NotFound(&'static str),
    /// The note changed since the caller last read it.
    #[error("This note changed on another device. Choose which version to keep.")]
    Conflict,
    #[error("Restore this note before editing it.")]
    Deleted,
    #[error("{0}")]
    Invalid(String),
}

/// Which note a write addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteTarget {
    Id(NoteId),
    /// The thread's own note; created by an update when `expected_revision` is 0.
    Thread(ThreadId),
}

impl Store {
    /// Every note that has not been purged, deleted ones included, pinned first then newest.
    pub fn notes_list(&self) -> Result<Vec<NoteSummary>> {
        self.with(|c| {
            let mut notes = query_notes(c, "", [])?.into_iter().map(|note| note.summary).collect::<Vec<_>>();
            notes.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at)));
            Ok(notes)
        })
    }

    pub fn note_get(&self, id: NoteId) -> Result<Option<Note>> {
        self.with(|c| fetch_note(c, "WHERE n.id = ?1", [id.to_string()]))
    }

    /// The thread's note, deleted or not.
    pub fn note_for_thread(&self, thread_id: ThreadId) -> Result<Option<Note>> {
        self.with(|c| fetch_note(c, "WHERE n.thread_id = ?1", [thread_id.to_string()]))
    }

    /// Create a global or project note. Thread notes come from [`Store::note_update`].
    pub fn note_create(&self, scope: NoteScope, project_id: Option<ProjectId>, title: &str, body: &str) -> Result<Note> {
        self.note_create_by(scope, project_id, title, body, None)
    }

    /// Create a global or project note, recording the thread whose agent wrote it
    /// (`None` for the user's own notes).
    pub fn note_create_by(
        &self,
        scope: NoteScope,
        project_id: Option<ProjectId>,
        title: &str,
        body: &str,
        created_by_thread: Option<ThreadId>,
    ) -> Result<Note> {
        check_content(Some(title), Some(body))?;
        self.with(|c| {
            let project_id = match (scope, project_id) {
                (NoteScope::Global, None) => None,
                (NoteScope::Global, Some(_)) => return invalid("Global notes do not belong to a project. Leave the project empty."),
                (NoteScope::Project, Some(id)) => {
                    check_project(c, id)?;
                    Some(id)
                }
                (NoteScope::Project, None) => return invalid("Choose a project for this note."),
                (NoteScope::Thread, _) => {
                    return invalid("Thread notes are created with notes.update and a thread_id.");
                }
            };
            let id = Uuid::now_v7();
            let now = Utc::now().to_rfc3339();
            c.execute(
                "INSERT INTO notes(id, scope, project_id, title, body, pinned, revision, created_at, updated_at, created_by_thread_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?6, ?7)",
                params![
                    id.to_string(),
                    scope.as_str(),
                    project_id.map(|id| id.to_string()),
                    title,
                    body,
                    now,
                    created_by_thread.map(|id| id.to_string())
                ],
            )?;
            expect_note(c, id)
        })
    }

    /// Save a new title and/or body. Unchanged content returns the current note
    /// without a revision bump, so a retry after a lost reply is harmless.
    pub fn note_update(&self, target: NoteTarget, expected_revision: i64, title: Option<&str>, body: Option<&str>) -> Result<Note> {
        check_content(title, body)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let current = match target {
                NoteTarget::Id(id) => fetch_note(&tx, "WHERE n.id = ?1", [id.to_string()])?,
                NoteTarget::Thread(id) => fetch_note(&tx, "WHERE n.thread_id = ?1", [id.to_string()])?,
            };
            let saved = match (current, target) {
                (None, NoteTarget::Id(_)) => {
                    return Err(NoteError::NotFound("Note not found. It may have been deleted permanently.").into());
                }
                (None, NoteTarget::Thread(thread_id)) => {
                    if expected_revision != 0 {
                        return Err(NoteError::Conflict.into());
                    }
                    let thread: Option<(String, String)> = tx
                        .query_row("SELECT project_id, title FROM threads WHERE id = ?1", [thread_id.to_string()], |r| {
                            Ok((r.get(0)?, r.get(1)?))
                        })
                        .optional()?;
                    let Some((project_id, thread_title)) = thread else {
                        return Err(NoteError::NotFound("Thread not found. Open another conversation.").into());
                    };
                    let id = Uuid::now_v7();
                    let now = Utc::now().to_rfc3339();
                    tx.execute(
                        "INSERT INTO notes(id, scope, project_id, thread_id, title, body, pinned, revision, created_at, updated_at)
                         VALUES (?1, 'thread', ?2, ?3, ?4, ?5, 0, 1, ?6, ?6)",
                        params![id.to_string(), project_id, thread_id.to_string(), thread_title, body.unwrap_or_default(), now],
                    )?;
                    expect_note(&tx, id)?
                }
                (Some(note), _) => {
                    if note.summary.deleted_at.is_some() {
                        return Err(NoteError::Deleted.into());
                    }
                    let is_thread = note.summary.scope == NoteScope::Thread;
                    // A thread note is titled after its thread; the title is never edited.
                    let title = title.filter(|_| !is_thread);
                    if title.is_none_or(|title| title == note.summary.title) && body.is_none_or(|body| body == note.body) {
                        return Ok(note);
                    }
                    if note.summary.revision != expected_revision {
                        return Err(NoteError::Conflict.into());
                    }
                    let snapshot = if is_thread { note.summary.title.clone() } else { title.unwrap_or(&note.summary.title).to_owned() };
                    tx.execute(
                        "UPDATE notes SET title = ?2, body = ?3, revision = revision + 1, updated_at = ?4 WHERE id = ?1",
                        params![note.summary.id.to_string(), snapshot, body.unwrap_or(&note.body), Utc::now().to_rfc3339()],
                    )?;
                    expect_note(&tx, note.summary.id)?
                }
            };
            tx.commit()?;
            Ok(saved)
        })
    }

    /// Pin or unpin without touching the content revision or the edit time.
    pub fn note_pin(&self, id: NoteId, pinned: bool) -> Result<NoteSummary> {
        self.with(|c| {
            expect_note(c, id)?;
            c.execute("UPDATE notes SET pinned = ?2 WHERE id = ?1", params![id.to_string(), pinned])?;
            Ok(expect_note(c, id)?.summary)
        })
    }

    /// Move a global or project note to another scope.
    pub fn note_move(&self, id: NoteId, scope: NoteScope, project_id: Option<ProjectId>) -> Result<NoteSummary> {
        self.with(|c| {
            let note = expect_note(c, id)?;
            if note.summary.scope == NoteScope::Thread {
                return invalid("A thread's note stays with its thread.");
            }
            if note.summary.deleted_at.is_some() {
                return invalid("Restore this note before moving it.");
            }
            let project_id = match (scope, project_id) {
                (NoteScope::Global, None) => None,
                (NoteScope::Global, Some(_)) => return invalid("Global notes do not belong to a project. Leave the project empty."),
                (NoteScope::Project, Some(id)) => {
                    check_project(c, id)?;
                    Some(id)
                }
                (NoteScope::Project, None) => return invalid("Choose a project to move this note to."),
                (NoteScope::Thread, _) => return invalid("Choose Global or a project to move this note to."),
            };
            c.execute(
                "UPDATE notes SET scope = ?2, project_id = ?3 WHERE id = ?1",
                params![id.to_string(), scope.as_str(), project_id.map(|id| id.to_string())],
            )?;
            Ok(expect_note(c, id)?.summary)
        })
    }

    /// Soft delete. Deleting a deleted note changes nothing.
    pub fn note_delete(&self, id: NoteId) -> Result<NoteSummary> {
        self.with(|c| {
            let note = expect_note(c, id)?;
            if note.summary.deleted_at.is_some() {
                return Ok(note.summary);
            }
            // The title snapshot keeps a thread note recognizable once its thread is gone.
            c.execute(
                "UPDATE notes SET deleted_at = ?2, title = ?3 WHERE id = ?1",
                params![id.to_string(), Utc::now().to_rfc3339(), note.summary.title],
            )?;
            Ok(expect_note(c, id)?.summary)
        })
    }

    /// Bring a deleted note back. When its project or thread no longer exists it
    /// becomes a global note, keeping its title and origin label.
    pub fn note_restore(&self, id: NoteId) -> Result<NoteSummary> {
        self.with(|c| {
            let note = expect_note(c, id)?;
            if note.summary.deleted_at.is_none() {
                return Ok(note.summary);
            }
            let exists = |table: &str, id: Option<Uuid>| -> Result<bool> {
                let Some(id) = id else { return Ok(false) };
                Ok(c.query_row(&format!("SELECT 1 FROM {table} WHERE id = ?1"), [id.to_string()], |_| Ok(())).optional()?.is_some())
            };
            let owner_exists = match note.summary.scope {
                NoteScope::Global => true,
                NoteScope::Project => exists("projects", note.summary.project_id)?,
                NoteScope::Thread => exists("threads", note.summary.thread_id)?,
            };
            if owner_exists {
                c.execute("UPDATE notes SET deleted_at = NULL, origin = NULL WHERE id = ?1", [id.to_string()])?;
            } else {
                c.execute(
                    "UPDATE notes SET deleted_at = NULL, scope = 'global', project_id = NULL, thread_id = NULL WHERE id = ?1",
                    [id.to_string()],
                )?;
            }
            Ok(expect_note(c, id)?.summary)
        })
    }

    /// Permanently remove a deleted note.
    pub fn note_purge(&self, id: NoteId) -> Result<()> {
        self.with(|c| {
            if expect_note(c, id)?.summary.deleted_at.is_none() {
                return invalid("Delete this note before removing it permanently.");
            }
            c.execute("DELETE FROM notes WHERE id = ?1", [id.to_string()])?;
            Ok(())
        })
    }

    /// Permanently remove notes deleted before `cutoff` and return their ids.
    pub fn notes_purge_deleted_before(&self, cutoff: DateTime<Utc>) -> Result<Vec<NoteId>> {
        self.with(|c| {
            let expired = query_notes(c, "WHERE n.deleted_at IS NOT NULL", [])?
                .into_iter()
                .filter(|note| note.summary.deleted_at.is_some_and(|at| at < cutoff))
                .map(|note| note.summary.id)
                .collect::<Vec<_>>();
            for id in &expired {
                c.execute("DELETE FROM notes WHERE id = ?1", [id.to_string()])?;
            }
            Ok(expired)
        })
    }

    /// Purge notes deleted more than [`NOTE_RETENTION_DAYS`] ago.
    pub fn notes_purge_expired(&self) -> Result<Vec<NoteId>> {
        self.notes_purge_deleted_before(Utc::now() - Duration::days(NOTE_RETENTION_DAYS))
    }

    /// Soft delete every note of a project, thread notes included, and label each
    /// with where it came from. Returns the notes that changed.
    pub fn notes_soft_delete_for_project(&self, project_id: ProjectId) -> Result<Vec<NoteSummary>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let changed = soft_delete_project_notes(&tx, project_id)?;
            tx.commit()?;
            Ok(changed)
        })
    }

    /// Remove a project, moving its notes and tasks to Recently deleted in the same
    /// transaction so a failed removal never leaves them half deleted.
    pub fn project_remove(&self, project_id: ProjectId) -> Result<crate::ProjectRemoval> {
        if is_free_chat_project(project_id) {
            anyhow::bail!("the free-chat workspace cannot be removed");
        }
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let notes = soft_delete_project_notes(&tx, project_id)?;
            let tasks = crate::tasks::soft_delete_project_tasks(&tx, project_id)?;
            tx.execute("DELETE FROM projects WHERE id = ?1", [project_id.to_string()])?;
            tx.commit()?;
            Ok(crate::ProjectRemoval { notes, tasks })
        })
    }

    /// Case-insensitive substring search over the title and body of live notes.
    /// Title matches rank first, then newer notes.
    pub fn notes_search(&self, query: &str, limit: usize) -> Result<Vec<NoteSearchHit>> {
        let needle = fold(query.trim());
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut notes = self.with(|c| query_notes(c, "WHERE n.deleted_at IS NULL", []))?;
        notes.sort_by_key(|note| std::cmp::Reverse(note.summary.updated_at));
        let mut title_hits = Vec::new();
        let mut body_hits = Vec::new();
        for note in &notes {
            let in_title = find_folded(&note.summary.title, &needle).is_some();
            // The snippet comes from the body when it matches, else from the start of the note.
            let (hit, found) = if find_folded(&note.body, &needle).is_some() {
                // Snippets are plain text: the match is shown without the markdown around it.
                let plain = plain_text(&note.body, None);
                let text = if find_folded(&plain, &needle).is_some() { snippet(&plain, &needle) } else { snippet(&plain, &[]) };
                (NoteSearchHit { id: note.summary.id, snippet: text }, true)
            } else {
                let excerpt = if note.summary.preview.is_empty() { &note.summary.title } else { &note.summary.preview };
                (NoteSearchHit { id: note.summary.id, snippet: excerpt.chars().take(SNIPPET_CHARS).collect() }, in_title)
            };
            match (in_title, found) {
                (true, _) => title_hits.push(hit),
                (false, true) => body_hits.push(hit),
                (false, false) => {}
            }
        }
        title_hits.extend(body_hits);
        title_hits.truncate(limit);
        Ok(title_hits)
    }

    /// The thread's note as the legacy per-thread notepad: empty and revision 0
    /// when there is none or it is deleted.
    pub fn thread_notes(&self, thread_id: ThreadId) -> Result<kybern_protocol::methods::ThreadNotes> {
        Ok(match self.note_for_thread(thread_id)? {
            Some(note) if note.summary.deleted_at.is_none() => {
                kybern_protocol::methods::ThreadNotes { text: note.body, revision: note.summary.revision }
            }
            _ => Default::default(),
        })
    }
}

fn soft_delete_project_notes(c: &Connection, project_id: ProjectId) -> Result<Vec<NoteSummary>> {
    let project_name: String = c
        .query_row("SELECT name FROM projects WHERE id = ?1", [project_id.to_string()], |r| r.get(0))
        .optional()?
        .unwrap_or_else(|| "Removed project".into());
    let now = Utc::now().to_rfc3339();
    let mut changed = Vec::new();
    for note in query_notes(c, "WHERE n.project_id = ?1", [project_id.to_string()])? {
        if note.summary.deleted_at.is_some() && note.summary.origin.is_some() {
            continue;
        }
        let origin = match note.summary.scope {
            NoteScope::Thread => format!("{project_name} › {}", note.summary.title),
            _ => project_name.clone(),
        };
        c.execute(
            "UPDATE notes SET deleted_at = COALESCE(deleted_at, ?2), title = ?3, origin = COALESCE(origin, ?4) WHERE id = ?1",
            params![note.summary.id.to_string(), now, note.summary.title, origin],
        )?;
        changed.push(expect_note(c, note.summary.id)?.summary);
    }
    Ok(changed)
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(NoteError::Invalid(message.into()).into())
}

fn check_content(title: Option<&str>, body: Option<&str>) -> Result<()> {
    if title.is_some_and(|title| title.chars().count() > NOTE_TITLE_MAX_CHARS) {
        return invalid("This title is too long. Keep it under 300 characters and try again.");
    }
    if body.is_some_and(|body| body.len() > NOTE_BODY_MAX_BYTES) {
        return invalid("This note is too long. Keep it under 512 KB and try again.");
    }
    Ok(())
}

fn check_project(c: &Connection, id: ProjectId) -> Result<()> {
    if is_free_chat_project(id) {
        return invalid("Chats without a project have no project notes. Choose a project or save it as a global note.");
    }
    if c.query_row("SELECT 1 FROM projects WHERE id = ?1", [id.to_string()], |_| Ok(())).optional()?.is_none() {
        return Err(NoteError::NotFound("Project not found. Choose another project.").into());
    }
    Ok(())
}

const NOTE_SELECT: &str = "SELECT n.id, n.scope, n.project_id, n.thread_id,
        CASE WHEN n.scope = 'thread' THEN COALESCE(t.title, n.title) ELSE n.title END,
        n.body, n.pinned, n.revision, n.created_at, n.updated_at, n.deleted_at, n.origin, n.created_by_thread_id
    FROM notes n LEFT JOIN threads t ON t.id = n.thread_id";

fn query_notes<P: rusqlite::Params>(c: &Connection, clause: &str, params: P) -> Result<Vec<Note>> {
    let mut st = c.prepare(&format!("{NOTE_SELECT} {clause}"))?;
    let rows = st.query_map(params, row_to_note)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn fetch_note<P: rusqlite::Params>(c: &Connection, clause: &str, params: P) -> Result<Option<Note>> {
    Ok(c.query_row(&format!("{NOTE_SELECT} {clause}"), params, row_to_note).optional()?)
}

fn expect_note(c: &Connection, id: NoteId) -> Result<Note> {
    fetch_note(c, "WHERE n.id = ?1", [id.to_string()])?
        .ok_or_else(|| NoteError::NotFound("Note not found. It may have been deleted permanently.").into())
}

fn row_to_note(r: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let scope: String = r.get(1)?;
    let scope = serde_json::from_value(serde_json::Value::String(scope)).map_err(other)?;
    let body: String = r.get(5)?;
    let optional_time = |index: usize| r.get::<_, Option<String>>(index)?.map(parse_time).transpose();
    Ok(Note {
        summary: NoteSummary {
            id: parse_uuid(r.get::<_, String>(0)?)?,
            scope,
            project_id: r.get::<_, Option<String>>(2)?.map(parse_uuid).transpose()?,
            thread_id: r.get::<_, Option<String>>(3)?.map(parse_uuid).transpose()?,
            title: r.get(4)?,
            preview: preview(&body),
            checklist: checklist(&body),
            pinned: r.get(6)?,
            revision: r.get(7)?,
            created_at: parse_time(r.get::<_, String>(8)?)?,
            updated_at: parse_time(r.get::<_, String>(9)?)?,
            deleted_at: optional_time(10)?,
            origin: r.get(11)?,
            created_by_thread: r.get::<_, Option<String>>(12)?.map(parse_uuid).transpose()?,
        },
        body,
    })
}

/// Plain-text excerpt of a markdown body: block and inline syntax removed,
/// whitespace collapsed, at most 240 characters.
pub fn preview(body: &str) -> String {
    plain_text(body, Some(PREVIEW_MAX_CHARS))
}

/// The body as plain text: markdown syntax removed, lines joined by single spaces.
/// Stops reading once `limit` characters are collected, when given.
fn plain_text(body: &str, limit: Option<usize>) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        let text = if in_fence { trimmed.to_owned() } else { strip_block(trimmed).map(|text| strip_inline(&text)).unwrap_or_default() };
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&text);
        if limit.is_some_and(|limit| out.chars().count() >= limit) {
            break;
        }
    }
    match limit {
        Some(limit) => out.chars().take(limit).collect::<String>().trim_end().to_owned(),
        None => out,
    }
}

/// Remove heading, quote, list and task markers. `None` for a divider line.
fn strip_block(line: &str) -> Option<String> {
    let mut rest = line;
    if is_divider(rest) {
        return None;
    }
    while let Some(quoted) = rest.strip_prefix('>') {
        rest = quoted.trim_start();
    }
    let hashes = rest.chars().take_while(|&c| c == '#').count();
    if hashes > 0 && rest[hashes..].starts_with(char::is_whitespace) {
        rest = rest[hashes..].trim_start();
    }
    if let Some(item) = list_item(rest) {
        rest = item;
        for marker in ["[ ]", "[x]", "[X]"] {
            if let Some(task) = rest.strip_prefix(marker) {
                rest = task.trim_start();
                break;
            }
        }
    }
    Some(rest.to_owned())
}

fn is_divider(line: &str) -> bool {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3 && ["-", "*", "_"].iter().any(|mark| compact.chars().all(|c| mark.starts_with(c)))
}

/// The text after a bullet (`-`, `*`, `+`) or numbered (`1.`, `1)`) list marker.
pub(crate) fn list_item(line: &str) -> Option<&str> {
    if let Some(rest) = line.strip_prefix(['-', '*', '+']) {
        return rest.strip_prefix(' ').map(str::trim_start);
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    line[digits..].strip_prefix(['.', ')'])?.strip_prefix(' ').map(str::trim_start)
}

/// Links and images become their text; emphasis, strike and code marks are dropped.
fn strip_inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // `\[` and friends are escaped literals: keep the character, drop the backslash.
        if c == '\\'
            && let Some(&next) = chars.get(i + 1)
            && next.is_ascii_punctuation()
        {
            out.push(next);
            i += 2;
            continue;
        }
        if (c == '[' || (c == '!' && chars.get(i + 1) == Some(&'[')))
            && let Some((label, end)) = link_at(&chars, i)
        {
            out.push_str(&strip_inline(&label));
            i = end;
            continue;
        }
        match c {
            '`' | '*' | '~' => {}
            '_' if chars.get(i + 1) == Some(&'_') => i += 1,
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// Parse `[label](target)` or `![label](target)` at `start`; returns the label and the index after it.
fn link_at(chars: &[char], start: usize) -> Option<(String, usize)> {
    let open = if chars[start] == '!' { start + 1 } else { start };
    let close = open + 1 + chars[open + 1..].iter().position(|&c| c == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = close + 2 + chars[close + 2..].iter().position(|&c| c == ')')?;
    Some((chars[open + 1..close].iter().collect(), end + 1))
}

/// Count task items (`- [ ]`, `* [x]`, `1. [X]`) outside code fences.
pub fn checklist(body: &str) -> NoteChecklist {
    let mut count = NoteChecklist::default();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(item) = list_item(trimmed) else { continue };
        let checked = match item.get(..3) {
            Some("[ ]") => false,
            Some("[x]" | "[X]") => true,
            _ => continue,
        };
        if item.len() > 3 && !item[3..].starts_with(char::is_whitespace) {
            continue;
        }
        count.total += 1;
        count.done += u32::from(checked);
    }
    count
}

/// Lowercase one character at a time so indexes into the folded text line up with the original.
fn fold(text: &str) -> Vec<char> {
    text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

fn find_folded(haystack: &str, needle: &[char]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let hay = fold(haystack);
    hay.windows(needle.len()).position(|window| window == needle)
}

/// About 120 characters of `body` around the first match, whitespace collapsed.
fn snippet(body: &str, needle: &[char]) -> String {
    let chars: Vec<char> = body.chars().collect();
    let at = find_folded(body, needle).unwrap_or(0);
    let start = at.saturating_sub((SNIPPET_CHARS.saturating_sub(needle.len())) / 3);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let text = chars[start..end].iter().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{text}{}", if start > 0 { "…" } else { "" }, if end < chars.len() { "…" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kybern_protocol::{PermissionMode, Project, ProviderInstance, ProviderKind, Thread, ThreadStatus};

    fn project(store: &Store, name: &str) -> Project {
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: name.into(),
            path: format!("/tmp/{}", Uuid::now_v7()),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        project
    }

    fn thread(store: &Store, project: &Project, title: &str) -> Thread {
        let now = Utc::now();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: title.into(),
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
        thread
    }

    fn note_error(result: Result<impl std::fmt::Debug>) -> NoteError {
        match result.unwrap_err().downcast::<NoteError>() {
            Ok(error) => error,
            Err(other) => panic!("expected a note error, got {other:#}"),
        }
    }

    #[test]
    fn migration_copies_non_empty_thread_notes_and_keeps_the_old_table() {
        // Build the v12 schema, add old-style notes, then let the real migrator finish.
        let conn = Connection::open_in_memory().unwrap();
        // v12 is the schema before notes (v13) arrived; later migrations must not matter here.
        crate::schema::migrate_to(&conn, 12).unwrap();
        conn.execute_batch(
            "INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES ('p1', 'kybern', '/k', 0, '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00');
             INSERT INTO threads(id, project_id, title, provider_kind, provider_instance, permission_mode, status, cwd, created_at, updated_at, last_seq, pinned)
               VALUES ('t1', 'p1', 'Fix login', 'codex', 'codex', 'supervised', 'idle', '/k', '2026-09-01T00:00:00+00:00', '2026-09-02T00:00:00+00:00', 0, 0),
                      ('t2', 'p1', 'Empty one', 'codex', 'codex', 'supervised', 'idle', '/k', '2026-09-01T00:00:00+00:00', '2026-09-02T00:00:00+00:00', 0, 0);
             INSERT INTO thread_notes(thread_id, text, revision) VALUES ('t1', 'Remember the redirect', 4), ('t2', '  ', 2);",
        )
        .unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows: Vec<(String, String, String, String, i64, String)> = conn
            .prepare("SELECT id, scope, project_id, title || '|' || body, revision, thread_id FROM notes")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 1, "blank notepads are not copied");
        let (id, scope, project_id, text, revision, thread_id) = &rows[0];
        assert!(id.parse::<Uuid>().is_ok(), "generated id is a uuid: {id}");
        assert_eq!(
            (scope.as_str(), project_id.as_str(), text.as_str(), *revision, thread_id.as_str()),
            ("thread", "p1", "Fix login|Remember the redirect", 4, "t1")
        );
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM thread_notes", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn thread_notes_are_created_by_update_and_titled_after_the_thread() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store, "kybern");
        let thread = thread(&store, &project, "Fix login");
        assert!(store.note_for_thread(thread.id).unwrap().is_none());
        assert_eq!(store.thread_notes(thread.id).unwrap().revision, 0);

        let created = store.note_update(NoteTarget::Thread(thread.id), 0, Some("ignored"), Some("- [ ] redirect")).unwrap();
        assert_eq!((created.summary.title.as_str(), created.summary.revision, created.summary.scope), ("Fix login", 1, NoteScope::Thread));
        assert_eq!(created.summary.project_id, Some(project.id));
        assert_eq!(store.thread_notes(thread.id).unwrap().text, "- [ ] redirect");
        assert_eq!(note_error(store.note_update(NoteTarget::Thread(thread.id), 0, None, Some("other"))), NoteError::Conflict);

        let mut renamed = thread.clone();
        renamed.title = "Fix SSO login".into();
        store.thread_upsert(&renamed).unwrap();
        assert_eq!(store.note_get(created.summary.id).unwrap().unwrap().summary.title, "Fix SSO login");
        assert!(matches!(note_error(store.note_update(NoteTarget::Thread(Uuid::now_v7()), 0, None, Some("x"))), NoteError::NotFound(_)));
    }

    #[test]
    fn updates_check_the_revision_and_unchanged_saves_do_not_bump_it() {
        let store = Store::open_in_memory().unwrap();
        let note = store.note_create(NoteScope::Global, None, "Ideas", "one").unwrap();
        assert_eq!(note.summary.revision, 1);
        let id = NoteTarget::Id(note.summary.id);

        let same = store.note_update(id, 1, Some("Ideas"), Some("one")).unwrap();
        assert_eq!(same, note, "unchanged content is a no-op");
        assert_eq!(store.note_update(id, 99, None, Some("one")).unwrap(), note, "an idempotent retry ignores a stale revision");

        let edited = store.note_update(id, 1, None, Some("two")).unwrap();
        assert_eq!((edited.summary.revision, edited.body.as_str(), edited.summary.title.as_str()), (2, "two", "Ideas"));
        assert!(edited.summary.updated_at >= note.summary.updated_at);
        assert_eq!(note_error(store.note_update(id, 1, None, Some("stale"))), NoteError::Conflict);
        assert_eq!(store.note_get(note.summary.id).unwrap().unwrap().body, "two");
        let retitled = store.note_update(id, 2, Some("Better ideas"), None).unwrap();
        assert_eq!((retitled.summary.revision, retitled.body.as_str()), (3, "two"));

        assert_eq!(NoteError::Conflict.to_string(), "This note changed on another device. Choose which version to keep.");
        assert!(matches!(note_error(store.note_update(id, 3, None, Some(&"x".repeat(NOTE_BODY_MAX_BYTES + 1)))), NoteError::Invalid(_)));
        assert!(matches!(note_error(store.note_create(NoteScope::Global, None, &"t".repeat(301), "")), NoteError::Invalid(_)));
    }

    #[test]
    fn create_validates_scope_and_project() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store, "kybern");
        let note = store.note_create(NoteScope::Project, Some(project.id), "Plan", "").unwrap();
        assert_eq!(note.summary.project_id, Some(project.id));
        assert!(matches!(note_error(store.note_create(NoteScope::Project, Some(Uuid::now_v7()), "", "")), NoteError::NotFound(_)));
        assert!(matches!(note_error(store.note_create(NoteScope::Project, None, "", "")), NoteError::Invalid(_)));
        assert!(matches!(note_error(store.note_create(NoteScope::Global, Some(project.id), "", "")), NoteError::Invalid(_)));
        assert!(matches!(note_error(store.note_create(NoteScope::Thread, None, "", "")), NoteError::Invalid(_)));
        assert!(matches!(
            note_error(store.note_create(NoteScope::Project, Some(kybern_protocol::FREE_CHAT_PROJECT_ID), "", "")),
            NoteError::Invalid(_)
        ));
    }

    #[test]
    fn pin_and_move_leave_content_alone() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store, "kybern");
        let note = store.note_create(NoteScope::Global, None, "Ideas", "one").unwrap();
        let pinned = store.note_pin(note.summary.id, true).unwrap();
        assert!(pinned.pinned);
        assert_eq!((pinned.revision, pinned.updated_at), (1, note.summary.updated_at));
        let moved = store.note_move(note.summary.id, NoteScope::Project, Some(project.id)).unwrap();
        assert_eq!((moved.scope, moved.project_id, moved.revision), (NoteScope::Project, Some(project.id), 1));
        let back = store.note_move(note.summary.id, NoteScope::Global, None).unwrap();
        assert_eq!((back.scope, back.project_id), (NoteScope::Global, None));

        let thread = thread(&store, &project, "Chat");
        let thread_note = store.note_update(NoteTarget::Thread(thread.id), 0, None, Some("x")).unwrap();
        assert!(matches!(note_error(store.note_move(thread_note.summary.id, NoteScope::Global, None)), NoteError::Invalid(_)));
        store.note_delete(note.summary.id).unwrap();
        assert!(matches!(note_error(store.note_move(note.summary.id, NoteScope::Global, None)), NoteError::Invalid(_)));
    }

    #[test]
    fn soft_delete_restore_and_purge() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store, "kybern");
        let keep = store.note_create(NoteScope::Global, None, "Keep", "keep").unwrap();
        let gone = store.note_create(NoteScope::Project, Some(project.id), "Gone", "gone").unwrap();

        assert!(matches!(note_error(store.note_purge(gone.summary.id)), NoteError::Invalid(_)), "only deleted notes can be purged");
        let deleted = store.note_delete(gone.summary.id).unwrap();
        assert!(deleted.deleted_at.is_some());
        assert_eq!(store.note_delete(gone.summary.id).unwrap().deleted_at, deleted.deleted_at, "deleting twice keeps the first time");
        assert_eq!(note_error(store.note_update(NoteTarget::Id(gone.summary.id), 1, None, Some("edit"))), NoteError::Deleted);
        assert_eq!(store.notes_list().unwrap().len(), 2, "deleted notes stay listed");

        let restored = store.note_restore(gone.summary.id).unwrap();
        assert_eq!((restored.deleted_at, restored.scope, restored.project_id), (None, NoteScope::Project, Some(project.id)));

        store.note_delete(gone.summary.id).unwrap();
        store.note_purge(gone.summary.id).unwrap();
        assert!(store.note_get(gone.summary.id).unwrap().is_none());
        assert!(matches!(note_error(store.note_restore(gone.summary.id)), NoteError::NotFound(_)));
        assert!(store.note_get(keep.summary.id).unwrap().is_some(), "only the deleted note was removed");
    }

    #[test]
    fn project_removal_soft_deletes_and_restore_falls_back_to_global() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store, "kybern");
        let other = project_named(&store, "elsewhere");
        let thread = thread(&store, &project, "Fix login");
        let page = store.note_create(NoteScope::Project, Some(project.id), "Plan", "ship it").unwrap();
        let thread_note = store.note_update(NoteTarget::Thread(thread.id), 0, None, Some("remember")).unwrap();
        let unrelated = store.note_create(NoteScope::Project, Some(other.id), "Other", "").unwrap();

        assert_eq!(store.notes_soft_delete_for_project(other.id).unwrap().len(), 1, "scoped to the project asked for");
        store.note_restore(unrelated.summary.id).unwrap();
        let changed = store.project_remove(project.id).unwrap().notes;
        assert_eq!(changed.len(), 2);
        assert!(store.project_get(project.id).unwrap().is_none());
        assert!(store.project_remove(kybern_protocol::FREE_CHAT_PROJECT_ID).is_err());

        let page_after = store.note_get(page.summary.id).unwrap().unwrap();
        assert!(page_after.summary.deleted_at.is_some());
        assert_eq!(page_after.summary.origin.as_deref(), Some("kybern"));
        let thread_after = store.note_get(thread_note.summary.id).unwrap().unwrap();
        assert!(thread_after.summary.deleted_at.is_some());
        assert_eq!(thread_after.summary.origin.as_deref(), Some("kybern › Fix login"));
        assert_eq!(thread_after.summary.title, "Fix login", "the thread title is kept once the thread is gone");
        assert!(store.note_get(unrelated.summary.id).unwrap().unwrap().summary.deleted_at.is_none());

        let restored_page = store.note_restore(page.summary.id).unwrap();
        assert_eq!((restored_page.scope, restored_page.project_id, restored_page.deleted_at), (NoteScope::Global, None, None));
        assert_eq!(restored_page.origin.as_deref(), Some("kybern"));
        let restored_thread = store.note_restore(thread_note.summary.id).unwrap();
        assert_eq!(
            (restored_thread.scope, restored_thread.thread_id, restored_thread.title.as_str()),
            (NoteScope::Global, None, "Fix login")
        );
        assert_eq!(store.note_get(thread_note.summary.id).unwrap().unwrap().body, "remember");
    }

    fn project_named(store: &Store, name: &str) -> Project {
        project(store, name)
    }

    #[test]
    fn restoring_a_thread_note_whose_thread_still_exists_keeps_it_attached() {
        let store = Store::open_in_memory().unwrap();
        let project = project(&store, "kybern");
        let thread = thread(&store, &project, "Chat");
        let note = store.note_update(NoteTarget::Thread(thread.id), 0, None, Some("hi")).unwrap();
        store.note_delete(note.summary.id).unwrap();
        assert!(store.thread_notes(thread.id).unwrap().text.is_empty(), "a deleted note is hidden from the legacy notepad");
        let restored = store.note_restore(note.summary.id).unwrap();
        assert_eq!((restored.scope, restored.thread_id, restored.origin), (NoteScope::Thread, Some(thread.id), None));
        assert_eq!(store.thread_notes(thread.id).unwrap().text, "hi");
    }

    #[test]
    fn purge_removes_only_notes_deleted_before_the_cutoff() {
        let store = Store::open_in_memory().unwrap();
        let live = store.note_create(NoteScope::Global, None, "Live", "").unwrap();
        let old = store.note_create(NoteScope::Global, None, "Old", "").unwrap();
        let recent = store.note_create(NoteScope::Global, None, "Recent", "").unwrap();
        store.note_delete(old.summary.id).unwrap();
        store.note_delete(recent.summary.id).unwrap();
        store
            .with(|c| {
                let long_ago = (Utc::now() - Duration::days(31)).to_rfc3339();
                c.execute("UPDATE notes SET deleted_at = ?2 WHERE id = ?1", params![old.summary.id.to_string(), long_ago])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(store.notes_purge_expired().unwrap(), vec![old.summary.id]);
        assert!(store.note_get(old.summary.id).unwrap().is_none());
        assert!(store.note_get(recent.summary.id).unwrap().is_some());
        assert!(store.note_get(live.summary.id).unwrap().is_some());
        assert!(store.notes_purge_expired().unwrap().is_empty());
    }

    #[test]
    fn list_orders_pinned_first_then_newest() {
        let store = Store::open_in_memory().unwrap();
        let first = store.note_create(NoteScope::Global, None, "First", "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = store.note_create(NoteScope::Global, None, "Second", "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let third = store.note_create(NoteScope::Global, None, "Third", "").unwrap();
        store.note_pin(first.summary.id, true).unwrap();
        let titles: Vec<_> = store.notes_list().unwrap().into_iter().map(|n| n.title).collect();
        assert_eq!(titles, ["First", "Third", "Second"]);
        let _ = (second, third);
    }

    #[test]
    fn search_is_case_insensitive_over_title_and_body_and_skips_deleted_notes() {
        let store = Store::open_in_memory().unwrap();
        let filler = "lorem ipsum ".repeat(40);
        let in_body = store.note_create(NoteScope::Global, None, "Groceries", &format!("{filler}Buy OAT milk {filler}")).unwrap();
        let in_title = store.note_create(NoteScope::Global, None, "Oat recipes", "pancakes").unwrap();
        let deleted = store.note_create(NoteScope::Global, None, "Oat gone", "").unwrap();
        store.note_delete(deleted.summary.id).unwrap();
        store.note_create(NoteScope::Global, None, "Unrelated", "nothing here").unwrap();

        let hits = store.notes_search("oat", 50).unwrap();
        assert_eq!(
            hits.iter().map(|h| h.id).collect::<Vec<_>>(),
            vec![in_title.summary.id, in_body.summary.id],
            "title matches rank first"
        );
        let snippet = &hits[1].snippet;
        assert!(snippet.to_lowercase().contains("buy oat milk"), "{snippet}");
        assert!(snippet.chars().count() <= SNIPPET_CHARS + 2, "{}", snippet.chars().count());
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert_eq!(store.notes_search("OAT", 1).unwrap().len(), 1);
        assert!(store.notes_search("   ", 50).unwrap().is_empty());
        assert!(store.notes_search("absent", 50).unwrap().is_empty());
    }

    #[test]
    fn search_snippets_are_plain_text() {
        let store = Store::open_in_memory().unwrap();
        let body = "# Docs\n\n- [ ] Read the **Tiptap** [guide](https://tiptap.dev) and `code`\n> quoted *text*";
        store.note_create(NoteScope::Global, None, "Reading", body).unwrap();
        let hits = store.notes_search("tiptap", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "Docs Read the Tiptap guide and code quoted text");
        // A match that exists only in the markup still shows readable text.
        let hits = store.notes_search("https", 50).unwrap();
        assert_eq!(hits[0].snippet, "Docs Read the Tiptap guide and code quoted text");
    }

    #[test]
    fn preview_strips_markdown_and_caps_length() {
        let body = "# Title here\n\n> quoted **bold** and _em_ and `code`\n- [ ] first task\n- [x] done [link text](https://x.dev) ![alt](a.png)\n1. numbered\n---\n```rust\nlet x = 1;\n```\n~~gone~~ snake_case_name";
        assert_eq!(
            preview(body),
            "Title here quoted bold and _em_ and code first task done link text alt numbered let x = 1; gone snake_case_name"
        );
        assert_eq!(preview(""), "");
        assert_eq!(preview("   \n\n---\n"), "");
        let long = preview(&"word ".repeat(200));
        assert_eq!(long.chars().count(), PREVIEW_MAX_CHARS - 1, "trailing space trimmed");
        assert_eq!(preview(&"é".repeat(500)).chars().count(), PREVIEW_MAX_CHARS);
        assert_eq!(preview(r"Thread scratch: \[ \] follow up \*not bold\* C:\path"), r"Thread scratch: [ ] follow up *not bold* C:\path");
    }

    #[test]
    fn checklist_counts_task_items_outside_code() {
        let body = "- [ ] a\n- [x] b\n* [X] c\n  1. [ ] nested numbered\n2) [x] paren\n- [] not a task\n- [ ]no space\n[ ] bare\n- [ ]\n```\n- [ ] in code\n```\n+ [x] plus";
        assert_eq!(checklist(body), NoteChecklist { done: 4, total: 7 });
        assert_eq!(checklist("plain text"), NoteChecklist::default());
    }

    #[test]
    fn summaries_serialize_the_derived_fields() {
        let store = Store::open_in_memory().unwrap();
        let note = store.note_create(NoteScope::Global, None, "List", "# Todo\n- [x] one\n- [ ] two").unwrap();
        let listed = &store.notes_list().unwrap()[0];
        assert_eq!(listed.preview, "Todo one two");
        assert_eq!(listed.checklist, NoteChecklist { done: 1, total: 2 });
        assert_eq!(listed, &note.summary);
    }
}
