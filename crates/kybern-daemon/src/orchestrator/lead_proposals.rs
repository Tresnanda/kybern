//! The Coordinator's two proposal tools. Each raises a daemon-owned approval card
//! (the pattern of `kybern_request_secret`) and acts only on the user's answer:
//!
//! - `kybern_coordinator_propose_brief { text }`: "Save this as the project
//!   brief?" with the text editable. The user's final wording is saved as the
//!   user's own brief note. This card is the only way agent text reaches the brief.
//! - `kybern_coordinator_propose_settings { changes, reason }`: "Apply these
//!   Coordinator settings?" listing each field old to new. The accepted rows are
//!   written to the project's override; the rest are left alone.
//!
//! - `kybern_coordinator_propose_note_changes { changes, reason }`: "Apply N note
//!   changes?" listing each dated claim to append, and the line it retires. The
//!   accepted rows are appended to the notes; this is how the Coordinator tidies
//!   notes the user asked it to check.
//!
//! All wait for the user like other consent cards: a wait that runs out leaves
//! the card open, and the agent calls again with the same arguments.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use anyhow::{Result, anyhow, bail, ensure};
use kybern_protocol::methods::{NoteCategory, NoteId, NoteScope, NotesCreateParams, NotesUpdateParams, ProjectNoteRole};
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{DaemonAnswer, LiveSession, Orchestrator};

pub(super) const BRIEF_TOOL: &str = "kybern_coordinator_propose_brief";
pub(super) const SETTINGS_TOOL: &str = "kybern_coordinator_propose_settings";
pub(super) const NOTE_CHANGES_TOOL: &str = "kybern_coordinator_propose_note_changes";

pub(crate) fn is_tool(name: &str) -> bool {
    name == BRIEF_TOOL || name == SETTINGS_TOOL || name == NOTE_CHANGES_TOOL
}

/// The proposal tools, offered to a project's Coordinator only.
pub(crate) fn tool_definitions() -> Vec<kybern_drivers::NativeToolDefinition> {
    use kybern_drivers::NativeToolDefinition;
    let role = |label: &str| {
        json!({
            "type": ["object", "null"], "additionalProperties": false,
            "description": format!("Default harness, model and effort for {label} children."),
            "properties": {
                "provider": {"enum": ["claude-code", "codex", "opencode", "pi", "omp", "cursor", null]},
                "model": {"type": ["string", "null"], "description": "Exact model id of that harness (see kybern_agent_capabilities)."},
                "effort": {"type": ["string", "null"]}
            }
        })
    };
    vec![
        NativeToolDefinition {
            name: BRIEF_TOOL.into(),
            description: concat!(
                "Propose the project brief to the user. They see your text in a card, can edit it, and save or decline it. ",
                "This is the only way to change the brief; never write it with a note tool. ",
                "Write it in the user's voice, as the standing instructions every agent in this project gets: what the project is, ",
                "the working policy (how much you do on your own, what needs their approval), the quality bar, conventions and known pitfalls. ",
                "At most 16 KiB. The call waits for the user. Result: {status, text}: \"saved\" (text is their final wording), ",
                "\"declined\" (do not propose again unless they ask). If the call returns an error saying it is still waiting, ",
                "call again with exactly the same text to keep waiting."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {"text": {"type": "string", "minLength": 1, "maxLength": MAX_BRIEF_BYTES, "description": "The proposed brief, markdown."}},
                "required": ["text"]
            }),
        },
        NativeToolDefinition {
            name: SETTINGS_TOOL.into(),
            description: concat!(
                "Propose changes to this project's Coordinator settings (the user's answers in setup, or something you learned). ",
                "They see each change as old to new in a card and can untick rows. Set only fields that should differ from the current effective values. ",
                "changes may hold lead_autonomy (act, propose_large, propose_first), lead_workspace (shared or worktree: where your children work by default), ",
                "lead_push_without_asking (whether you may push and open pull requests without a card), lead_max_children (1 to 16), and role_defaults: ",
                "the harness and model for research, implementation, review, design or test children (general has none). reason says why, in a sentence. ",
                "The call waits for the user. Result: {status, applied, skipped}: \"applied\" lists the accepted fields, \"declined\" means none. ",
                "If the call returns an error saying it is still waiting, call again with the same arguments."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "changes": {
                        "type": "object", "additionalProperties": false,
                        "properties": {
                            "lead_autonomy": {"enum": ["act", "propose_large", "propose_first", null]},
                            "lead_workspace": {"enum": ["shared", "worktree", null]},
                            "lead_push_without_asking": {"type": ["boolean", "null"]},
                            "lead_max_children": {"type": ["integer", "null"], "minimum": 1, "maximum": 16},
                            "role_defaults": {
                                "type": ["object", "null"], "additionalProperties": false,
                                "properties": {
                                    "research": role("research"), "implementation": role("implementation"), "review": role("review"),
                                    "design": role("design"), "test": role("test")
                                }
                            }
                        }
                    },
                    "reason": {"type": "string", "minLength": 1, "maxLength": 500}
                },
                "required": ["changes", "reason"]
            }),
        },
        NativeToolDefinition {
            name: NOTE_CHANGES_TOOL.into(),
            description: concat!(
                "Propose changes to the project's memory notes, usually after a read-only child checked flagged claims against the code. ",
                "Each change appends one dated claim to a note (note_id, text). To retire an old claim, set supersedes to an exact piece of the one line it replaces: ",
                "that line is struck through and marked superseded. Write text as `- YYYY-MM-DD · As of `abc1234`: what is true (`path`).` with the current HEAD. ",
                "category sets the note's category when it has none. The user sees every change in a card and can untick rows; the brief cannot be changed this way. ",
                "At most 30 changes. The call waits for the user. Result: {status, applied, failed, skipped}: \"applied\" lists the accepted changes by number, \"declined\" means none. ",
                "If the call returns an error saying it is still waiting, call again with the same arguments."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "changes": {
                        "type": "array", "minItems": 1, "maxItems": MAX_NOTE_CHANGES,
                        "items": {
                            "type": "object", "additionalProperties": false,
                            "properties": {
                                "note_id": {"type": "string", "format": "uuid"},
                                "text": {"type": "string", "minLength": 1, "description": "Markdown appended to the note."},
                                "supersedes": {"type": ["string", "null"], "description": "Exact piece of the one line this replaces."},
                                "category": {"enum": ["preference", "decision", "convention", "gotcha", null]}
                            },
                            "required": ["note_id", "text"]
                        }
                    },
                    "reason": {"type": "string", "minLength": 1, "maxLength": 500}
                },
                "required": ["changes", "reason"]
            }),
        },
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BriefArgs {
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsArgs {
    changes: ChangesArgs,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteChangesArgs {
    changes: Vec<NoteChangeArgs>,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteChangeArgs {
    note_id: NoteId,
    text: String,
    #[serde(default)]
    supersedes: Option<String>,
    #[serde(default)]
    category: Option<NoteCategory>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
struct ChangesArgs {
    lead_autonomy: Option<LeadAutonomy>,
    lead_workspace: Option<DelegationWorkspace>,
    lead_push_without_asking: Option<bool>,
    lead_max_children: Option<u32>,
    role_defaults: Option<BTreeMap<DelegationRole, Option<RoleDefaultArgs>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleDefaultArgs {
    #[serde(default)]
    provider: Option<ProviderKind>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
}

/// How a proposal card was answered.
enum Proposal {
    Submitted(Value),
    Declined,
}

impl Orchestrator {
    pub(super) async fn execute_lead_tool(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        ensure!(thread.coordinator_project_id.is_some(), "This tool is only for a project's Coordinator.");
        match name {
            BRIEF_TOOL => self.propose_brief(thread, turn_id, live, crate::app_tools::parse(arguments)?).await,
            SETTINGS_TOOL => self.propose_settings(thread, turn_id, live, crate::app_tools::parse(arguments)?).await,
            NOTE_CHANGES_TOOL => self.propose_note_changes(thread, turn_id, live, crate::app_tools::parse(arguments)?).await,
            _ => bail!("unknown Coordinator tool: {name}"),
        }
    }

    // ---- kybern_coordinator_propose_brief ----

    async fn propose_brief(&self, thread: &Thread, turn_id: TurnId, live: &Arc<LiveSession>, args: BriefArgs) -> Result<Value> {
        let proposed = args.text.trim().to_owned();
        ensure!(!proposed.is_empty(), "The brief is empty. Write the brief you propose, then call again.");
        ensure!(proposed.len() <= MAX_BRIEF_BYTES, "The brief is over {} KiB. Shorten it, then call again.", MAX_BRIEF_BYTES / 1024);
        let replaces = self.project_has_brief_note(thread.project_id)?;
        let input = serde_json::to_value(BriefProposalInput { text: proposed.clone(), replaces })?;
        let key = format!("lead_brief:{}", digest(&json!([proposed])));
        let answer =
            self.ask_proposal(thread, turn_id, live, key, COORDINATOR_BRIEF_TOOL, input, "Save this as the project brief?").await?;
        let Proposal::Submitted(response) = answer else {
            return Ok(json!({
                "status": "declined",
                "note": "The user declined to save this brief. Do not propose it again unless they ask; continue with what you know."
            }));
        };
        let text = response.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned();
        ensure!(!text.is_empty() && text.len() <= MAX_BRIEF_BYTES, "The answer held no usable brief. Nothing was saved; propose it again.");
        let revision = self.save_brief(thread.project_id, &text).map_err(|error| {
            anyhow!("The brief could not be saved: {error:#}. Nothing was saved; read the current brief with kybern_note_read and propose it again.")
        })?;
        // The lead wrote this itself, so the next message need not announce it.
        self.lead_brief_seen(live, revision).await;
        Ok(json!({ "status": "saved", "text": text, "edited": text != proposed }))
    }

    fn project_has_brief_note(&self, project_id: ProjectId) -> Result<bool> {
        Ok(self.inner.store.note_for_project_role(project_id, ProjectNoteRole::Brief)?.is_some())
    }

    /// Write `text` as the user's brief note: a new pinned note, or the existing
    /// one's body. Returns the note's new revision.
    fn save_brief(&self, project_id: ProjectId, text: &str) -> Result<i64> {
        let note = match self.inner.store.note_for_project_role(project_id, ProjectNoteRole::Brief)? {
            Some(existing) => self.note_update(NotesUpdateParams {
                id: Some(existing.summary.id),
                thread_id: None,
                expected_revision: existing.summary.revision,
                title: None,
                body: Some(text.to_owned()),
                category: None,
                clear_category: false,
            })?,
            None => self.note_create(NotesCreateParams {
                scope: NoteScope::Project,
                project_id: Some(project_id),
                title: Some("Project brief".into()),
                body: Some(text.to_owned()),
                project_role: Some(ProjectNoteRole::Brief),
                category: None,
            })?,
        };
        Ok(note.summary.revision)
    }

    // ---- kybern_coordinator_propose_settings ----

    async fn propose_settings(&self, thread: &Thread, turn_id: TurnId, live: &Arc<LiveSession>, args: SettingsArgs) -> Result<Value> {
        let reason = args.reason.trim().to_owned();
        ensure!(!reason.is_empty() && reason.chars().count() <= 500, "Say why in a sentence of up to 500 characters, then call again.");
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
        let current = self.inner.settings.get().orchestration.effective_for(project.coordinator.as_ref());
        let changes = self.settings_changes(&project, &current, args.changes).await?;
        if changes.is_empty() {
            return Ok(
                json!({ "status": "unchanged", "note": "These are already the effective settings, so there is nothing to ask. Continue." }),
            );
        }
        let paths: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
        let key = format!("lead_settings:{}", digest(&json!([&changes, &reason])));
        let input = serde_json::to_value(SettingsProposalInput { reason, changes: changes.clone() })?;
        let answer =
            self.ask_proposal(thread, turn_id, live, key, COORDINATOR_SETTINGS_TOOL, input, "Apply these Coordinator settings?").await?;
        let Proposal::Submitted(response) = answer else {
            return Ok(json!({
                "status": "declined", "applied": [], "skipped": paths,
                "note": "The user declined these settings. Do not propose them again unless they ask."
            }));
        };
        let accepted: HashSet<String> = response
            .get("accepted")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|path| path.as_str().map(str::to_owned))
            .collect();
        let chosen: Vec<&SettingChange> = changes.iter().filter(|change| accepted.contains(&change.path)).collect();
        ensure!(!chosen.is_empty(), "The answer accepted no change. Nothing was applied.");
        self.apply_settings(thread.project_id, &chosen)?;
        let after = self.inner.store.project_get(thread.project_id)?.and_then(|project| project.coordinator);
        let effective = self.inner.settings.get().orchestration.effective_for(after.as_ref());
        // The lead proposed these itself, so the next message need not announce them.
        self.lead_settings_seen(live, effective.clone()).await;
        let applied: Vec<&str> = chosen.iter().map(|change| change.path.as_str()).collect();
        let skipped: Vec<&str> = paths.iter().map(String::as_str).filter(|path| !applied.contains(path)).collect();
        Ok(json!({ "status": "applied", "applied": applied, "skipped": skipped, "effective": effective }))
    }

    /// The fields of `args` that differ from `current`, each as a card row.
    async fn settings_changes(
        &self,
        project: &Project,
        current: &EffectiveCoordinatorSettings,
        args: ChangesArgs,
    ) -> Result<Vec<SettingChange>> {
        let mut changes = Vec::new();
        let mut row = |path: &str, label: &str, old: Value, new: Value| {
            if old != new {
                changes.push(SettingChange { path: path.into(), label: label.into(), old, new });
            }
        };
        if let Some(autonomy) = args.lead_autonomy {
            row("lead_autonomy", "Autonomy", json!(current.lead_autonomy), json!(autonomy));
        }
        if let Some(workspace) = args.lead_workspace {
            row("lead_workspace", "Agents' workspace", json!(current.lead_workspace), json!(workspace));
        }
        if let Some(push) = args.lead_push_without_asking {
            row(
                "lead_push_without_asking",
                "Push and open pull requests without asking",
                json!(current.lead_push_without_asking),
                json!(push),
            );
        }
        if let Some(children) = args.lead_max_children {
            ensure!((1..=16).contains(&children), "lead_max_children must be between 1 and 16.");
            row("lead_max_children", "Active agents", json!(current.lead_max_children), json!(children));
        }
        let mut role_rows = Vec::new();
        for (role, default) in args.role_defaults.into_iter().flatten() {
            ensure!(role != DelegationRole::General, "The general role has no default model. Leave it out.");
            let Some(default) = default else { continue };
            let new = self.checked_role_default(project, role, default).await?;
            let old = current.role_defaults.get(&role).map_or(Value::Null, |old| json!(old));
            role_rows.push((format!("role_defaults.{role}"), format!("{} model", capitalized(role.as_str())), old, json!(new)));
        }
        for (path, label, old, new) in role_rows {
            row(&path, &label, old, new);
        }
        Ok(changes)
    }

    /// A role default the daemon can actually launch.
    async fn checked_role_default(&self, project: &Project, role: DelegationRole, default: RoleDefaultArgs) -> Result<RoleDefault> {
        let clean = |value: Option<String>| value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        let (model, effort) = (clean(default.model), clean(default.effort));
        let Some(kind) = default.provider else {
            ensure!(
                model.is_none() && effort.is_none(),
                "The {role} default names a model or effort without a provider. Pass provider too (see kybern_agent_capabilities)."
            );
            bail!("The {role} default is empty. Pass provider, and optionally model and effort.");
        };
        ensure!(
            self.inner.drivers.get(kind).is_some(),
            "{kind} is not available in this build. Call kybern_agent_capabilities to see the installed harnesses."
        );
        let provider = ProviderInstance::default_for(kind);
        self.validate_provider_selection(project.id, &provider, model.as_deref(), effort.as_deref())
            .await
            .map_err(|error| anyhow!("The {role} default is not valid: {error:#}"))?;
        Ok(RoleDefault { provider: Some(provider), model, effort })
    }

    /// Write the accepted rows into the project's override.
    fn apply_settings(&self, project_id: ProjectId, accepted: &[&SettingChange]) -> Result<()> {
        {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let mut project = self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
            let mut overrides = project.coordinator.take().unwrap_or_default();
            for change in accepted {
                let new = change.new.clone();
                match change.path.as_str() {
                    "lead_autonomy" => overrides.lead_autonomy = Some(serde_json::from_value(new)?),
                    "lead_workspace" => overrides.lead_workspace = Some(serde_json::from_value(new)?),
                    "lead_push_without_asking" => overrides.lead_push_without_asking = Some(serde_json::from_value(new)?),
                    "lead_max_children" => overrides.lead_max_children = Some(serde_json::from_value(new)?),
                    path => {
                        let role = path
                            .strip_prefix("role_defaults.")
                            .and_then(|role| serde_json::from_value::<DelegationRole>(json!(role)).ok())
                            .ok_or_else(|| anyhow!("Unknown setting {path}."))?;
                        overrides.role_defaults.insert(role, serde_json::from_value(new)?);
                    }
                }
            }
            overrides.validate().map_err(|error| anyhow!(error))?;
            project.coordinator = (!overrides.is_empty()).then_some(overrides);
            project.updated_at = chrono::Utc::now();
            self.inner.store.project_update(&project)?;
        }
        self.publish_projects();
        Ok(())
    }

    // ---- kybern_coordinator_propose_note_changes ----

    async fn propose_note_changes(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        args: NoteChangesArgs,
    ) -> Result<Value> {
        let reason = args.reason.trim().to_owned();
        ensure!(!reason.is_empty() && reason.chars().count() <= 500, "Say why in a sentence of up to 500 characters, then call again.");
        ensure!(!args.changes.is_empty(), "Pass at least one change, or do not call this tool.");
        ensure!(
            args.changes.len() <= MAX_NOTE_CHANGES,
            "Propose at most {MAX_NOTE_CHANGES} changes at a time; send the rest in another call."
        );
        let date = super::agent_items::today();
        let mut changes = Vec::new();
        for (index, change) in args.changes.into_iter().enumerate() {
            let number = index + 1;
            let note = self.live_note(change.note_id).map_err(|error| anyhow!("Change {number}: {error:#}"))?;
            ensure!(
                note.summary.project_id == Some(thread.project_id) && note.summary.scope == NoteScope::Project,
                "Change {number}: '{}' is not one of this project's notes.",
                note.summary.title
            );
            ensure!(
                note.summary.project_role != Some(ProjectNoteRole::Brief),
                "Change {number}: the project brief is the user's. Use kybern_coordinator_propose_brief."
            );
            let text = change.text.trim().to_owned();
            ensure!(!text.is_empty(), "Change {number}: text is empty.");
            if let Some(category) = change.category
                && let Some(existing) = note.summary.category
            {
                ensure!(
                    existing == category,
                    "Change {number}: '{}' is a {} note. Leave category out, or propose a new note for the {} claim.",
                    note.summary.title,
                    existing.as_str(),
                    category.as_str()
                );
            }
            let supersedes = change.supersedes.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
            if let Some(needle) = &supersedes {
                super::note_claims::supersede(&note.body, needle, &date).map_err(|error| anyhow!("Change {number}: {error:#}"))?;
            }
            changes.push(NoteChange {
                path: number.to_string(),
                note_id: note.summary.id,
                note_title: note.summary.title.clone(),
                op: if supersedes.is_some() { NoteChangeOp::Supersede } else { NoteChangeOp::Append },
                text,
                supersedes,
                category: change.category,
            });
        }
        let paths: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
        let key = format!("lead_notes:{}", digest(&json!([&changes, &reason])));
        let input = serde_json::to_value(NoteChangesProposalInput { reason, changes: changes.clone() })?;
        let summary = format!("Apply {} note {}?", changes.len(), if changes.len() == 1 { "change" } else { "changes" });
        let answer = self.ask_proposal(thread, turn_id, live, key, COORDINATOR_NOTES_TOOL, input, &summary).await?;
        let Proposal::Submitted(response) = answer else {
            return Ok(json!({
                "status": "declined", "applied": [], "failed": [], "skipped": paths,
                "note": "The user declined these note changes. Do not propose them again unless they ask."
            }));
        };
        let accepted: HashSet<String> = response
            .get("accepted")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|path| path.as_str().map(str::to_owned))
            .collect();
        let chosen: Vec<&NoteChange> = changes.iter().filter(|change| accepted.contains(&change.path)).collect();
        ensure!(!chosen.is_empty(), "The answer accepted no change. Nothing was applied.");
        let mut applied = Vec::new();
        let mut failed = Vec::new();
        for change in chosen {
            match self.append_note_text(thread.id, Some(change.note_id), &change.text, change.supersedes.as_deref(), change.category) {
                Ok(_) => applied.push(change.path.clone()),
                Err(error) => failed.push(json!({ "path": change.path, "note": change.note_title, "error": format!("{error:#}") })),
            }
        }
        let skipped: Vec<&str> = paths
            .iter()
            .map(String::as_str)
            .filter(|path| !applied.iter().any(|done| done == path) && !failed.iter().any(|f| f["path"] == *path))
            .collect();
        Ok(json!({ "status": "applied", "applied": applied, "failed": failed, "skipped": skipped }))
    }

    // ---- the card ----

    /// Open (or, for a retry with the same arguments in the same turn, reuse) the
    /// proposal's card and wait for the user. A once-given answer is spent by the
    /// call that takes it, so a later identical proposal opens its own card.
    #[allow(clippy::too_many_arguments)]
    async fn ask_proposal(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        key: String,
        tool_name: &str,
        input: Value,
        summary: &str,
    ) -> Result<Proposal> {
        let operation = Uuid::now_v7();
        loop {
            let (card, answer) = self
                .ask_daemon_approval(thread.id, turn_id, live, key.clone(), tool_name, input.clone(), summary.to_owned(), Some(operation))
                .await?;
            match answer {
                DaemonAnswer::Decided(ApprovalDecision::Submit { response }) => {
                    if !self.consume_daemon_approval(live, card, operation).await? {
                        // A parallel identical call took that answer first: ask again.
                        continue;
                    }
                    return Ok(Proposal::Submitted(response));
                }
                DaemonAnswer::Decided(ApprovalDecision::Deny { .. }) => return Ok(Proposal::Declined),
                DaemonAnswer::Decided(_) => bail!("The answer did not hold a decision. Call this tool again."),
                DaemonAnswer::TurnEnded => bail!("The turn ended before the user answered. Nothing was saved."),
                DaemonAnswer::Pending => bail!(
                    "Still waiting for the user to answer: {summary} The card is open; call this tool again with exactly the same arguments after they answer."
                ),
            }
        }
    }
}

fn digest(value: &Value) -> String {
    let bytes = Sha256::digest(serde_json::to_vec(value).unwrap_or_default());
    bytes.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}
