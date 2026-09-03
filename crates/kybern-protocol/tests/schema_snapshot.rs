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
    assert_eq!(serde_json::to_value(ProviderKind::ClaudeCode).unwrap(), "claude-code");
    assert_eq!(serde_json::to_value(PermissionMode::AcceptEdits).unwrap(), "accept-edits");

    let legacy_diff_params: ThreadsDiffParams = serde_json::from_value(serde_json::json!({ "thread_id": uuid::Uuid::nil() })).unwrap();
    assert!(legacy_diff_params.include_patch);
}
