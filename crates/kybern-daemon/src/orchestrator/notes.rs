//! Notes: user-owned markdown pages in the global, project and thread scopes.
//!
//! Writes take the same command lock as the other user commands, so a note save
//! never interleaves with a project removal. Every change is published on the
//! notes channel; each connection that can read orchestration state forwards it
//! as a `notes.changed` notification.

use anyhow::{Result, anyhow};
use kybern_protocol::methods::{
    Note, NoteId, NoteScope, NoteSearchHit, NoteSummary, NotesChangedNotification, NotesCreateParams, NotesGetParams, NotesMoveParams,
    NotesUpdateParams, ProjectNoteRole, ThreadNotes, ThreadNotesSetParams,
};
use kybern_protocol::{ProjectId, is_free_chat_project};
use kybern_store::{NoteError, NoteTarget};
use tokio::sync::broadcast;

use super::Orchestrator;

const DEFAULT_SEARCH_LIMIT: u32 = 50;
const MAX_SEARCH_LIMIT: u32 = 200;

fn invalid<T>(message: &str) -> Result<T> {
    Err(NoteError::Invalid(message.into()).into())
}

impl Orchestrator {
    /// Changes to notes, for forwarding to connected clients.
    pub fn subscribe_notes(&self) -> broadcast::Receiver<NotesChangedNotification> {
        self.inner.notes_changed.subscribe()
    }

    pub(super) fn publish_note(&self, mut note: NoteSummary) {
        // Only a send to a connected client needs the stale flag. Callers hold the
        // command lock, so git runs later, off the lock (`publish_with_stale_flag`).
        if self.inner.notes_changed.receiver_count() > 0 {
            self.publish_with_stale_flag(&mut note);
        }
        self.send_note_changed(note);
    }

    pub(super) fn send_note_changed(&self, note: NoteSummary) {
        // No receivers just means no client is connected.
        let _ = self.inner.notes_changed.send(NotesChangedNotification { note: Some(note), purged_id: None });
    }

    fn publish_purged(&self, id: NoteId) {
        let _ = self.inner.notes_changed.send(NotesChangedNotification { note: None, purged_id: Some(id) });
    }

    /// Every note, stale flags read from git: call it from a blocking thread.
    pub fn notes_list(&self) -> Result<Vec<NoteSummary>> {
        let mut notes = self.inner.store.notes_list()?;
        self.flag_stale_all(&mut notes);
        Ok(notes)
    }

    /// When categories were introduced; see `NotesListResult::history_since`.
    pub fn notes_history_since(&self) -> Result<Option<chrono::DateTime<chrono::Utc>>> {
        self.inner.store.notes_history_since()
    }

    /// The note by `id` or by `thread_id`; a thread without a note yields `None`.
    /// Its stale flag reads git: call it from a blocking thread.
    pub fn note_get(&self, params: NotesGetParams) -> Result<Option<Note>> {
        let note = match (params.id, params.thread_id) {
            (Some(id), None) => self
                .inner
                .store
                .note_get(id)?
                .map(Some)
                .ok_or(NoteError::NotFound("Note not found. It may have been deleted permanently."))?,
            (None, Some(thread_id)) => self.inner.store.note_for_thread(thread_id)?,
            _ => return invalid("Pass either id or thread_id."),
        };
        Ok(note.map(|mut note| {
            self.flag_stale(&mut note);
            note
        }))
    }

    pub fn note_create(&self, params: NotesCreateParams) -> Result<Note> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let body = params.body.as_deref().unwrap_or_default();
        let note = match params.project_role {
            Some(role) => {
                let (NoteScope::Project, Some(project_id)) = (params.scope, params.project_id) else {
                    return invalid("The project brief and setup note belong to a project. Choose scope project and a project.");
                };
                let default_title = match role {
                    ProjectNoteRole::Brief => "Project brief",
                    ProjectNoteRole::Setup => "Project setup",
                };
                let title = params.title.as_deref().filter(|title| !title.trim().is_empty()).unwrap_or(default_title);
                self.inner.store.note_create_project_role(project_id, role, title, body, None)?
            }
            None => self.inner.store.note_create_categorized(
                params.scope,
                params.project_id,
                params.title.as_deref().unwrap_or_default(),
                body,
                None,
                params.category,
            )?,
        };
        self.publish_note(note.summary.clone());
        Ok(note)
    }

    pub fn note_update(&self, params: NotesUpdateParams) -> Result<Note> {
        let target = match (params.id, params.thread_id) {
            (Some(id), None) => NoteTarget::Id(id),
            (None, Some(thread_id)) => NoteTarget::Thread(thread_id),
            _ => return invalid("Pass either id or thread_id."),
        };
        if params.clear_category && params.category.is_some() {
            return invalid("Pass category or clear_category, not both.");
        }
        let category = if params.clear_category { Some(None) } else { params.category.map(Some) };
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let previous_body = match target {
            NoteTarget::Id(id) => self.inner.store.note_get(id)?,
            NoteTarget::Thread(thread_id) => self.inner.store.note_for_thread(thread_id)?,
        }
        .map(|note| note.body);
        let note = self.inner.store.note_update_with(
            target,
            params.expected_revision,
            params.title.as_deref(),
            params.body.as_deref(),
            category,
        )?;
        // An unchanged save returns the note as it is; only a real write moved the revision.
        if note.summary.revision != params.expected_revision {
            self.publish_note(note.summary.clone());
            // Ticking or unticking a line that links a task moves that task.
            if let Some(previous_body) = previous_body.filter(|previous| *previous != note.body) {
                self.sync_tasks_from_note(&previous_body, &note);
            }
        }
        Ok(note)
    }

    pub fn note_pin(&self, id: NoteId, pinned: bool) -> Result<NoteSummary> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let note = self.inner.store.note_pin(id, pinned)?;
        self.publish_note(note.clone());
        Ok(note)
    }

    pub fn note_move(&self, params: NotesMoveParams) -> Result<NoteSummary> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let note = self.inner.store.note_move(params.id, params.scope, params.project_id)?;
        self.publish_note(note.clone());
        Ok(note)
    }

    pub fn note_delete(&self, id: NoteId) -> Result<NoteSummary> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let note = self.inner.store.note_delete(id)?;
        self.publish_note(note.clone());
        Ok(note)
    }

    pub fn note_restore(&self, id: NoteId) -> Result<NoteSummary> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let note = self.inner.store.note_restore(id)?;
        self.publish_note(note.clone());
        Ok(note)
    }

    pub fn note_purge(&self, id: NoteId) -> Result<()> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        self.inner.store.note_purge(id)?;
        self.publish_purged(id);
        Ok(())
    }

    pub fn notes_search(&self, query: &str, limit: Option<u32>) -> Result<Vec<NoteSearchHit>> {
        let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, MAX_SEARCH_LIMIT);
        self.inner.store.notes_search(query, limit as usize)
    }

    /// Permanently remove notes that have been in Recently deleted past the retention period.
    pub fn purge_expired_notes(&self) -> Result<usize> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let purged = self.inner.store.notes_purge_expired()?;
        for id in &purged {
            self.publish_purged(*id);
        }
        Ok(purged.len())
    }

    /// Remove a project. Its notes, including its threads' notes, and its tasks move
    /// to Recently deleted first instead of being destroyed with it.
    pub fn remove_project(&self, project_id: ProjectId) -> Result<()> {
        if is_free_chat_project(project_id) {
            return Err(anyhow!("the free-chat workspace cannot be removed"));
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let _tasks = self.inner.task_writes.lock().map_err(|_| anyhow!("task lock poisoned"))?;
        let removal = self.inner.store.project_remove(project_id)?;
        for note in removal.notes {
            self.publish_note(note);
        }
        for task_id in removal.tasks {
            self.publish_task_deleted(task_id);
        }
        self.publish_projects();
        Ok(())
    }

    /// The thread's note as the legacy notepad (`threads.notes.set`): same text and
    /// revision semantics, stored as the thread's note. Clearing a thread that has no
    /// note saves nothing.
    pub fn set_notes(&self, params: ThreadNotesSetParams) -> Result<ThreadNotes> {
        self.inner.store.thread_get(params.thread_id)?.ok_or(NoteError::NotFound("Thread not found. Open another conversation."))?;
        if params.text.is_empty() && self.inner.store.note_for_thread(params.thread_id)?.is_none() {
            return Ok(ThreadNotes::default());
        }
        let note = self.note_update(NotesUpdateParams {
            id: None,
            thread_id: Some(params.thread_id),
            expected_revision: params.expected_revision,
            title: None,
            body: Some(params.text),
            category: None,
            clear_category: false,
        })?;
        Ok(ThreadNotes { text: note.body, revision: note.summary.revision })
    }
}
