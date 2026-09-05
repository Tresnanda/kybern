use kybern_protocol::{ApprovalDecision, ApprovalRequest};
use serde_json::{Value, json};
fn request(tool: &str, input: Value) -> ApprovalRequest {
    serde_json::from_value(json!({"id":"00000000-0000-0000-0000-000000000001","thread_id":"00000000-0000-0000-0000-000000000002","turn_id":"00000000-0000-0000-0000-000000000003","tool_name":tool,"input":input,"summary":"Question","created_at":"2026-09-05T00:00:00Z"})).unwrap()
}
#[test]
fn questions_cannot_be_approved_or_submitted_without_answers() {
    for (tool, answers) in [
        ("AskUserQuestion", json!({"Which?":"Blue"})),
        ("request_user_input", json!({"color":{"answers":["Blue"]}})),
        ("opencode_question", json!([["Blue"]])),
    ] {
        let request = request(tool, json!({"questions":[{"id":"color","question":"Which?"}]}));
        assert!(request.validate_decision(&ApprovalDecision::AllowAlways).is_err());
        assert!(request.validate_decision(&ApprovalDecision::Submit { response: json!({"answers":{}}) }).is_err());
        assert!(request.validate_decision(&ApprovalDecision::Submit { response: json!({"answers":answers}) }).is_ok());
        assert!(request.validate_decision(&ApprovalDecision::Deny { reason: None }).is_ok());
    }
}
#[test]
fn permissions_cannot_be_replaced_with_form_answers() {
    assert!(request("Bash", json!({})).validate_decision(&ApprovalDecision::Submit { response: json!({"command":"anything"}) }).is_err());
}
#[test]
fn forms_preserve_false_numbers_enums_and_required_fields() {
    let request = request(
        "mcp_elicitation",
        json!({"requestedSchema":{"type":"object","required":["confirm","count"],"properties":{"confirm":{"type":"boolean"},"count":{"type":"integer","minimum":1},"color":{"type":"string","enum":["Blue"]}}}}),
    );
    for content in [json!({"confirm":false,"count":2}), json!({"confirm":true,"count":1,"color":"Blue"})] {
        assert!(request.validate_decision(&ApprovalDecision::Submit { response: json!({"action":"accept","content":content}) }).is_ok());
    }
    for content in [
        json!({"count":2}),
        json!({"confirm":"false","count":2}),
        json!({"confirm":false,"count":0}),
        json!({"confirm":false,"count":2,"color":"Green"}),
    ] {
        assert!(request.validate_decision(&ApprovalDecision::Submit { response: json!({"action":"accept","content":content}) }).is_err());
    }
}
