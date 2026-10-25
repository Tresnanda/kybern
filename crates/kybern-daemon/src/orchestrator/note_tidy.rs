//! "Tidy notes": the Coordinator's offer to check outdated memory notes.
//!
//! The daemon decides when to offer, not the lead: a project with
//! [`NOTES_TIDY_THRESHOLD`] or more stale notes (`note_staleness`) gets a card,
//! snoozed for [`NOTES_TIDY_SNOOZE_DAYS`] days by "Not now". "Tidy notes" sends the
//! Coordinator a Kybern-originated message: clients see a "Tidy notes" row
//! ([`SystemRowKind::CoordinatorTidyNotes`]) and only the provider's copy carries
//! the instructions below. The lead answers with
//! `kybern_coordinator_propose_note_changes`, whose card the user approves.

use anyhow::{Result, anyhow, ensure};
use chrono::{Duration, Utc};
use kybern_protocol::methods::{
    NOTES_TIDY_SNOOZE_DAYS, NOTES_TIDY_THRESHOLD, Note, NoteId, NotesTidyParams, NotesTidyStartResult, StaleInfo, TidyOffer,
};
use kybern_protocol::*;
use uuid::Uuid;

use super::Orchestrator;

/// What clients show for the request.
pub(super) const TIDY_NOTES_ROW: &str = "Tidy notes";
/// Most flagged notes the provider's copy lists; the rest are found with `kybern_notes_search`.
const TIDY_LISTED_NOTES: usize = 20;

pub(super) fn is_tidy_message(message: &UserMessage) -> bool {
    message.parts.iter().any(|part| matches!(part, ContentPart::SystemRow { kind: SystemRowKind::CoordinatorTidyNotes, .. }))
}

/// The request as clients store it: one row, no text of the user's.
pub(super) fn tidy_message() -> UserMessage {
    UserMessage { parts: vec![ContentPart::SystemRow { kind: SystemRowKind::CoordinatorTidyNotes, text: TIDY_NOTES_ROW.into() }] }
}

/// The request as the provider receives it.
pub(super) fn tidy_provider_copy(flagged: &[(Note, StaleInfo)]) -> UserMessage {
    let mut text = format!(
        "Kybern asks you to tidy the project's memory notes. {} {} cite files that changed after the commits they name:\n",
        flagged.len(),
        if flagged.len() == 1 { "note" } else { "notes" }
    );
    for (note, stale) in flagged.iter().take(TIDY_LISTED_NOTES) {
        let title = note.summary.title.trim();
        text.push_str(&format!(
            "- {} ({}): `{}` changed in {}\n",
            if title.is_empty() { "Untitled" } else { title },
            note.summary.id,
            stale.path,
            stale.commit
        ));
    }
    if flagged.len() > TIDY_LISTED_NOTES {
        text.push_str(&format!("- {} more; find them with kybern_notes_search.\n", flagged.len() - TIDY_LISTED_NOTES));
    }
    text.push_str(
        "1. Delegate one read-only child (kybern_agent_delegate, role research, workspace shared; tell it to read only and not edit files). \
Give it the flagged note ids; it reads each note with kybern_note_read, checks every flagged claim against the current code, and reports per claim: still true, or what is true now, with path@sha citations.\n\
2. When it returns, propose the changes with kybern_coordinator_propose_note_changes: for a claim that is still true, append nothing; for one that changed, append a new dated claim as of the current HEAD, and set supersedes to an exact piece of the old line. Never rewrite a note's body.\n\
3. Then say in one line how many notes you checked and how many changes the user is asked to approve.",
    );
    UserMessage { parts: vec![ContentPart::Text { text }] }
}

fn snooze_key(project_id: ProjectId) -> String {
    format!("notes_tidy_snooze:{project_id}")
}

impl Orchestrator {
    /// The provider's copy of a "Tidy notes" request, or `None` for any other message.
    pub(super) fn tidy_provider_message(&self, thread: &Thread, message: &UserMessage) -> Result<Option<UserMessage>> {
        if thread.coordinator_project_id.is_none() || !is_tidy_message(message) {
            return Ok(None);
        }
        Ok(Some(tidy_provider_copy(&self.stale_notes(thread.project_id)?)))
    }

    /// Whether the project's "Tidy notes" card is showing, and the notes behind it.
    pub fn notes_tidy_offer(&self, params: NotesTidyParams) -> Result<TidyOffer> {
        let stale: Vec<NoteId> = self.stale_notes(params.project_id)?.into_iter().map(|(note, _)| note.summary.id).collect();
        let snoozed_until = self
            .inner
            .store
            .meta_get(&snooze_key(params.project_id))?
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|time| time.with_timezone(&Utc))
            .filter(|until| *until > Utc::now());
        let offer = stale.len() >= NOTES_TIDY_THRESHOLD as usize && snoozed_until.is_none();
        Ok(TidyOffer { stale, offer, snoozed_until })
    }

    /// "Not now": the card stays away for [`NOTES_TIDY_SNOOZE_DAYS`] days.
    pub fn notes_tidy_snooze(&self, params: NotesTidyParams) -> Result<TidyOffer> {
        let until = Utc::now() + Duration::days(NOTES_TIDY_SNOOZE_DAYS);
        self.inner.store.meta_set(&snooze_key(params.project_id), &until.to_rfc3339())?;
        self.notes_tidy_offer(params)
    }

    /// "Tidy notes": ask the project's Coordinator to check the flagged claims.
    pub async fn notes_tidy_start(&self, params: NotesTidyParams) -> Result<NotesTidyStartResult> {
        let _lead = self.inner.lead_commands.lock().await;
        let lead = self
            .coordinator_get(params.project_id)?
            .ok_or_else(|| anyhow!("Open the project's Coordinator first; it tidies the notes."))?;
        let flagged = self.stale_notes(params.project_id)?;
        ensure!(!flagged.is_empty(), "None of this project's notes looks outdated right now.");
        ensure!(matches!(lead.status, ThreadStatus::Idle | ThreadStatus::Failed), "Wait for the Coordinator to finish, then try again.");
        self.send_with_id(lead.id, Uuid::now_v7(), tidy_message(), false, false).await.map_err(|error| {
            if error.downcast_ref::<super::ThreadBusy>().is_some() {
                anyhow!("Wait for the Coordinator to finish, then try again.")
            } else {
                error
            }
        })?;
        // The card has done its job; it comes back after a quiet week if notes are still stale.
        self.inner.store.meta_set(&snooze_key(params.project_id), &(Utc::now() + Duration::days(NOTES_TIDY_SNOOZE_DAYS)).to_rfc3339())?;
        Ok(NotesTidyStartResult { thread_id: lead.id, notes: flagged.len() as u32 })
    }
}
