//! The wire schema is a contract with the desktop and mobile clients. Any
//! change here must be deliberate: run `cargo insta review` (or
//! `INSTA_UPDATE=always cargo test -p kybern-protocol`) after changing types.

use kybern_protocol::methods::*;
use kybern_protocol::*;
use schemars::schema_for;

#[test]
fn method_registry_is_stable() {
    let names: Vec<&str> = METHODS.iter().map(|m| m.name).collect();
    insta::assert_yaml_snapshot!(names);
}

#[test]
fn method_scopes_are_stable() {
    let scopes: Vec<(String, Option<String>)> = METHODS.iter().map(|m| (m.name.to_string(), m.scope.map(|s| s.to_string()))).collect();
    insta::assert_yaml_snapshot!(scopes);
}

#[test]
fn event_schema_is_stable() {
    insta::assert_json_snapshot!(schema_for!(ThreadEvent));
}

#[test]
fn thread_schema_is_stable() {
    insta::assert_json_snapshot!(schema_for!(Thread));
}

#[test]
fn transcript_schema_is_stable() {
    insta::assert_json_snapshot!(schema_for!(TranscriptEntry));
}

#[test]
fn settings_schema_is_stable() {
    insta::assert_json_snapshot!(schema_for!(Settings));
}

#[test]
fn wire_examples_roundtrip() {
    let ev = ThreadEvent {
        seq: 7,
        thread_id: uuid::Uuid::nil(),
        turn_id: Some(uuid::Uuid::nil()),
        at: chrono::DateTime::parse_from_rfc3339("2026-09-02T00:00:00Z").unwrap().into(),
        payload: EventPayload::ApprovalResolved {
            approval_id: uuid::Uuid::nil(),
            decision: ApprovalDecision::Deny { reason: Some("no".into()) },
        },
    };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["kind"], "approval_resolved");
    assert_eq!(json["decision"]["decision"], "deny");
    let back: ThreadEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back.seq, 7);

    let part: ContentPart = serde_json::from_str(r#"{"type":"file_mention","path":"src/main.rs"}"#).unwrap();
    assert_eq!(part, ContentPart::FileMention { path: "src/main.rs".into() });
    let skill: ContentPart = serde_json::from_str(r#"{"type":"skill","name":"better-ui","path":"/skills/better-ui/SKILL.md"}"#).unwrap();
    assert_eq!(skill, ContentPart::Skill { name: "better-ui".into(), path: "/skills/better-ui/SKILL.md".into() });
    assert_eq!(serde_json::to_value(ProviderKind::ClaudeCode).unwrap(), "claude-code");
    assert_eq!(serde_json::to_value(PermissionMode::AcceptEdits).unwrap(), "accept-edits");

    let legacy_diff_params: ThreadsDiffParams = serde_json::from_value(serde_json::json!({ "thread_id": uuid::Uuid::nil() })).unwrap();
    assert!(legacy_diff_params.include_patch);
}

#[test]
fn replay_ready_schema_is_stable() {
    insta::assert_json_snapshot!("events_subscribe_result", schema_for!(EventsSubscribeResult));
    insta::assert_json_snapshot!("events_ready_notification", schema_for!(EventsReadyNotification));
    let legacy: EventsSubscribeResult =
        serde_json::from_value(serde_json::json!({"subscription_id": uuid::Uuid::nil(), "head_seq": 7})).unwrap();
    assert!(!legacy.replay_ready);
}

#[test]
fn thread_file_read_schema_is_stable() {
    insta::assert_json_snapshot!(schema_for!(ThreadFileReadParams));
}

#[test]
fn notes_wire_shape_is_stable() {
    insta::assert_json_snapshot!("note_schema", schema_for!(Note));
    insta::assert_json_snapshot!("notes_changed_notification", schema_for!(NotesChangedNotification));
    let note = Note {
        summary: NoteSummary {
            id: uuid::Uuid::nil(),
            scope: NoteScope::Thread,
            project_id: Some(uuid::Uuid::nil()),
            thread_id: None,
            title: "Plan".into(),
            preview: "Ship it".into(),
            checklist: NoteChecklist { done: 1, total: 3 },
            pinned: false,
            revision: 2,
            created_at: chrono::DateTime::parse_from_rfc3339("2026-10-05T00:00:00Z").unwrap().into(),
            updated_at: chrono::DateTime::parse_from_rfc3339("2026-10-05T00:00:00Z").unwrap().into(),
            deleted_at: None,
            origin: None,
            created_by_thread: None,
        },
        body: "- [x] Ship it".into(),
    };
    let json = serde_json::to_value(&note).unwrap();
    assert_eq!(json["scope"], "thread");
    assert_eq!(json["body"], "- [x] Ship it", "body sits beside the summary fields");
    assert_eq!(json["checklist"], serde_json::json!({"done": 1, "total": 3}));
    assert!(
        json.get("thread_id").is_none() && json.get("deleted_at").is_none() && json.get("created_by_thread").is_none(),
        "absent options are omitted"
    );
    assert_eq!(serde_json::from_value::<Note>(json).unwrap(), note);
    let update: NotesUpdateParams =
        serde_json::from_value(serde_json::json!({"thread_id": uuid::Uuid::nil(), "expected_revision": 0})).unwrap();
    assert!(update.id.is_none() && update.body.is_none());
}

#[test]
fn task_items_wire_shape_is_stable() {
    insta::assert_json_snapshot!("task_item_schema", schema_for!(TaskItem));
    insta::assert_json_snapshot!("task_items_changed_notification", schema_for!(TaskItemsChangedNotification));
    let at: chrono::DateTime<chrono::Utc> = chrono::DateTime::parse_from_rfc3339("2026-10-05T00:00:00Z").unwrap().into();
    let task = TaskItem {
        id: uuid::Uuid::nil(),
        key: "ADE-14".into(),
        scope: TaskScope::Project,
        project_id: Some(uuid::Uuid::nil()),
        title: "Fix login".into(),
        body: "Redirect after sign in".into(),
        status: TaskStatus::NeedsReview,
        priority: 2,
        rank: 1024.0,
        note_ids: vec![uuid::Uuid::nil()],
        source_note_id: None,
        pending_followup: None,
        runs: vec![TaskRun {
            thread_id: uuid::Uuid::nil(),
            number: 1,
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            started_at: at,
            ended_at: Some(at),
            state: TaskRunState::Completed,
            activity: None,
            diff: Some(TaskRunDiff { added: 12, removed: 3, files: 2 }),
            notes: vec![TaskRunNote { note_id: uuid::Uuid::nil(), revision: 4 }],
        }],
        revision: 1,
        created_at: at,
        updated_at: at,
        status_changed_at: at,
        created_by_thread: None,
    };
    let json = serde_json::to_value(&task).unwrap();
    assert_eq!(json["status"], "needs_review");
    assert_eq!(json["scope"], "project");
    assert_eq!(json["priority"], 2);
    assert_eq!(json["runs"][0]["state"], "completed");
    assert_eq!(json["runs"][0]["diff"], serde_json::json!({"added": 12, "removed": 3, "files": 2}));
    assert_eq!(json["runs"][0]["notes"][0]["revision"], 4);
    assert!(
        json.get("source_note_id").is_none() && json.get("pending_followup").is_none() && json.get("created_by_thread").is_none(),
        "absent options are omitted"
    );
    assert!(json["runs"][0].get("model").is_none() && json["runs"][0].get("activity").is_none());
    assert_eq!(serde_json::from_value::<TaskItem>(json).unwrap(), task);
    let update: TaskItemsUpdateParams = serde_json::from_value(serde_json::json!({"id": uuid::Uuid::nil()})).unwrap();
    assert!(update.status.is_none() && update.before_id.is_none());
    assert_eq!(serde_json::to_value(TaskStatus::Todo).unwrap(), "todo");
    assert_eq!(TaskItemsList::NAME, "tasks.items.list");
    assert_eq!(TASK_ITEMS_CHANGED_NOTIFICATION, "tasks.items.changed");
    let agent_task = TaskItem { created_by_thread: Some(uuid::Uuid::nil()), ..task };
    let json = serde_json::to_value(&agent_task).unwrap();
    assert_eq!(json["created_by_thread"], serde_json::json!(uuid::Uuid::nil()));
    assert_eq!(serde_json::from_value::<TaskItem>(json).unwrap(), agent_task);
    // The prompt-only send that mobile and the CLI use still parses; a full message is additive.
    let send: TaskItemsSendParams = serde_json::from_value(serde_json::json!({
        "id": uuid::Uuid::nil(), "provider": {"kind": "codex", "instance": "default"}, "prompt": "Fix it"
    }))
    .unwrap();
    assert_eq!((send.prompt.as_deref(), send.message.is_none()), (Some("Fix it"), true));
    let send: TaskItemsSendParams = serde_json::from_value(serde_json::json!({
        "id": uuid::Uuid::nil(), "provider": {"kind": "codex", "instance": "default"},
        "message": {"parts": [{"type": "text", "text": "Fix it"}]}
    }))
    .unwrap();
    assert!(send.prompt.is_none() && send.message.is_some_and(|message| message.parts.len() == 1));
}
