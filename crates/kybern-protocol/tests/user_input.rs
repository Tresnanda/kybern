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
#[test]
fn secret_requests_need_a_value_or_a_decline() {
    let request = request(
        "kybern_request_secret",
        json!({"label":"Stripe key","reason":"Run tests","env_key":"STRIPE_KEY","file":".env","replaces":false}),
    );
    assert!(request.is_user_input());
    assert!(request.validate_decision(&ApprovalDecision::AllowOnce).is_err());
    assert!(request.validate_decision(&ApprovalDecision::AllowAlways).is_err());
    assert!(request.validate_decision(&ApprovalDecision::Deny { reason: None }).is_ok());
    for bad in
        [json!({}), json!({"secret":""}), json!({"secret":7}), json!({"secret":"a\u{0}b"}), json!({"secret":"x".repeat(16 * 1024 + 1)})]
    {
        assert!(request.validate_decision(&ApprovalDecision::Submit { response: bad }).is_err());
    }
    for good in [json!({"secret":"sk_live_1"}), json!({"secret":"-----BEGIN KEY-----\nabc\n"}), json!({"secret":"x".repeat(16 * 1024)})] {
        assert!(request.validate_decision(&ApprovalDecision::Submit { response: good }).is_ok());
    }
}
#[test]
fn secret_answers_are_redacted_before_they_are_stored() {
    let secret = request("kybern_request_secret", json!({"env_key":"STRIPE_KEY"}));
    let answer = ApprovalDecision::Submit { response: json!({"secret":"hunter2"}) };
    assert_eq!(secret.redacted_decision(&answer), ApprovalDecision::Submit { response: json!({"secret":"[redacted]"}) });
    let deny = ApprovalDecision::Deny { reason: Some("no".into()) };
    assert_eq!(secret.redacted_decision(&deny), deny);

    let codex = request(
        "request_user_input",
        json!({"questions":[{"id":"token","question":"Token?","isSecret":true},{"id":"color","question":"Color?","isSecret":false},{"id":"name","question":"Name?"}]}),
    );
    let answers = ApprovalDecision::Submit {
        response: json!({"answers":{"token":{"answers":["hunter2"]},"color":{"answers":["Blue"]},"name":{"answers":["Ada"]}}}),
    };
    assert_eq!(
        codex.redacted_decision(&answers),
        ApprovalDecision::Submit {
            response: json!({"answers":{"token":{"answers":["[redacted]"]},"color":{"answers":["Blue"]},"name":{"answers":["Ada"]}}})
        }
    );
    // Other requests are untouched.
    let plain = request("AskUserQuestion", json!({"questions":[{"question":"Which?"}]}));
    let reply = ApprovalDecision::Submit { response: json!({"answers":{"Which?":"Blue"}}) };
    assert_eq!(plain.redacted_decision(&reply), reply);
}
#[test]
fn visual_answers_match_the_schema_or_are_a_reply() {
    let request = request(
        "kybern_visual_answer",
        json!({"visual_id":"00000000-0000-0000-0000-000000000004","title":"Pick a layout","schema":{"type":"object","properties":{"layout":{"enum":["A","B","C"]}},"required":["layout"]}}),
    );
    assert!(request.is_user_input());
    assert!(request.validate_decision(&ApprovalDecision::AllowOnce).is_err());
    assert!(request.validate_decision(&ApprovalDecision::Deny { reason: Some("skipped".into()) }).is_ok());
    let submit = |response: Value| request.validate_decision(&ApprovalDecision::Submit { response });
    assert!(submit(json!({"answer":{"layout":"B"},"label":"Layout B"})).is_ok());
    assert!(submit(json!({"reply":"B, with the panel on the left"})).is_ok());
    for bad in [
        json!({}),
        json!({"answer":null}),
        json!({"answer":{"layout":"D"}}),
        json!({"answer":{}}),
        json!({"answer":{"layout":"B"},"label":7}),
        json!({"reply":"  "}),
        json!({"answer":"x".repeat(9000)}),
    ] {
        assert!(submit(bad.clone()).is_err(), "{bad}");
    }
    let free = request_without_schema();
    assert!(free.validate_decision(&ApprovalDecision::Submit { response: json!({"answer":[1,2,3]}) }).is_ok());
}
fn request_without_schema() -> ApprovalRequest {
    request("kybern_visual_answer", json!({"visual_id":"00000000-0000-0000-0000-000000000004","title":"Tune"}))
}
