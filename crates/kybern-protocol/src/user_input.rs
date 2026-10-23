//! One question model for every harness.
//!
//! Each harness asks in its own shape (Claude's `AskUserQuestion`, Codex's
//! `request_user_input`, OpenCode forms, Cursor's `cursor/ask_question`, Pi's
//! `select`/`input`/`editor` dialogs, and Kybern's own `kybern_ask_user`, which
//! uses Claude's shape). [`user_input_questions`] reads all of them into
//! [`UserInputQuestion`]s, carried on [`ApprovalRequest::questions`] next to the
//! harness's own `input`, which stays for older clients.
//!
//! The way back is [`encode_answers`]: a client (or a delegating agent) answers
//! with [`UserInputAnswer`]s under [`NORMALIZED_ANSWERS_KEY`], and the daemon
//! turns them into the response the harness expects, attachments included.
//!
//! MCP elicitation stays a form: its fields can be secrets, and Codex sends
//! connector consent through it, which is an approval.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{ApprovalRequest, AssetId, PERMISSION_REQUEST_TOOL, ThreadId};

/// `tool_name` of a question Cursor asks through `cursor/ask_question`.
/// `input` is Cursor's own `{title, questions: [{id, prompt, options: [{id, label}], allowMultiple}]}`;
/// the answer is `{answers: [{questionId, selectedOptionIds}]}`. Cursor takes option ids only.
pub const CURSOR_QUESTION_TOOL: &str = "cursor_ask_question";
/// The key of a normalized answer in `ApprovalDecision::Submit { response }`:
/// `{"kybern_answers": [UserInputAnswer, ...]}`. The daemon replaces it with the harness's own response.
pub const NORMALIZED_ANSWERS_KEY: &str = "kybern_answers";
/// Longest option preview Kybern keeps, in bytes.
pub const MAX_OPTION_PREVIEW_BYTES: usize = 8 * 1024;
/// Most attachments on one answer.
pub const MAX_ANSWER_ATTACHMENTS: usize = 6;

/// One question of a request, whatever harness asked it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputQuestion {
    /// The key the answer goes under: the question text for Claude, the harness's id otherwise.
    pub id: String,
    /// A very short label, e.g. "Layout".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// The question. Markdown.
    pub question: String,
    #[serde(default)]
    pub options: Vec<UserInputOption>,
    #[serde(default)]
    pub multi_select: bool,
    /// The user may write their own answer.
    #[serde(default)]
    pub allow_custom: bool,
    /// The answer is hidden in the transcript (Codex `isSecret`).
    #[serde(default)]
    pub secret: bool,
    /// The harness can take files and images with the answer (as paths in the text).
    #[serde(default)]
    pub attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Text or code to show while the option is focused (Claude's `preview`). Markdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// The harness's own id for the option, when it answers with ids (Cursor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// The answer to one question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputAnswer {
    /// [`UserInputQuestion::id`].
    pub id: String,
    /// Option labels, or the user's own text.
    #[serde(default)]
    pub answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<UserInputAttachment>,
}

/// A file or picture sent with an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputAttachment {
    /// `image`, `file` or `window` (a window capture).
    pub kind: String,
    pub name: String,
    /// An uploaded image or capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    /// An absolute path, for a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Whether a waiting request asks the user to answer or to approve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PendingRequestKind {
    Approval,
    Question,
}

/// Who answered a request when it was not the user: a delegating agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RequestAnswerer {
    pub thread_id: ThreadId,
    pub title: String,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn bounded_preview(value: &Value) -> Option<String> {
    let preview = value.get("preview").and_then(Value::as_str).filter(|preview| !preview.trim().is_empty())?;
    if preview.len() <= MAX_OPTION_PREVIEW_BYTES {
        return Some(preview.to_owned());
    }
    let mut end = MAX_OPTION_PREVIEW_BYTES;
    while !preview.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}…", &preview[..end]))
}

fn options(value: Option<&Value>) -> Vec<UserInputOption> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| match option {
            Value::String(label) => Some(UserInputOption { label: label.clone(), description: None, preview: None, value: None }),
            Value::Object(_) => Some(UserInputOption {
                label: text(option, "label")?,
                description: text(option, "description"),
                preview: bounded_preview(option),
                value: text(option, "id"),
            }),
            _ => None,
        })
        .collect()
}

/// The questions of a request, or none when it is not a question (an approval, a form, a sign-in, ...).
pub fn user_input_questions(tool_name: &str, input: &Value) -> Vec<UserInputQuestion> {
    let list = || input.get("questions").and_then(Value::as_array).into_iter().flatten();
    match tool_name {
        // Claude, and Kybern's own `kybern_ask_user`.
        "AskUserQuestion" => list()
            .filter_map(|q| {
                let question = text(q, "question")?;
                Some(UserInputQuestion {
                    id: question.clone(),
                    header: text(q, "header"),
                    question,
                    options: options(q.get("options")),
                    multi_select: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                    allow_custom: true,
                    secret: false,
                    attachments: true,
                })
            })
            .collect(),
        "request_user_input" => list()
            .enumerate()
            .filter_map(|(index, q)| {
                let options = options(q.get("options"));
                Some(UserInputQuestion {
                    id: text(q, "id").unwrap_or_else(|| index.to_string()),
                    header: text(q, "header"),
                    question: text(q, "question")?,
                    allow_custom: options.is_empty() || q.get("isOther").and_then(Value::as_bool) != Some(false),
                    options,
                    multi_select: false,
                    secret: q.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                    attachments: true,
                })
            })
            .collect(),
        "opencode_question" => list()
            .enumerate()
            .filter_map(|(index, q)| {
                let options = options(q.get("options"));
                Some(UserInputQuestion {
                    id: index.to_string(),
                    header: text(q, "header"),
                    question: text(q, "question")?,
                    allow_custom: options.is_empty() || q.get("custom").and_then(Value::as_bool) != Some(false),
                    options,
                    multi_select: q.get("multiple").and_then(Value::as_bool).unwrap_or(false),
                    secret: false,
                    attachments: true,
                })
            })
            .collect(),
        CURSOR_QUESTION_TOOL => {
            let title = text(input, "title");
            list()
                .enumerate()
                .filter_map(|(index, q)| {
                    let options = options(q.get("options"));
                    if options.is_empty() {
                        return None;
                    }
                    Some(UserInputQuestion {
                        id: text(q, "id").unwrap_or_else(|| index.to_string()),
                        header: title.clone().filter(|title| title != "Question"),
                        question: text(q, "prompt")?,
                        options,
                        multi_select: q.get("allowMultiple").and_then(Value::as_bool).unwrap_or(false),
                        allow_custom: false,
                        secret: false,
                        attachments: false,
                    })
                })
                .collect()
        }
        "ui_select" | "ui_input" | "ui_editor" => {
            let options = if tool_name == "ui_select" { options(input.get("options")) } else { Vec::new() };
            if tool_name == "ui_select" && options.is_empty() {
                return Vec::new();
            }
            vec![UserInputQuestion {
                id: "value".into(),
                header: None,
                question: text(input, "title").or_else(|| text(input, "message")).unwrap_or_else(|| "Answer the agent".into()),
                allow_custom: options.is_empty(),
                options,
                multi_select: false,
                secret: false,
                attachments: tool_name != "ui_select",
            }]
        }
        _ => Vec::new(),
    }
}

impl ApprovalRequest {
    /// Fill [`ApprovalRequest::questions`] from the harness's `input`.
    pub fn with_questions(mut self) -> Self {
        self.questions = user_input_questions(&self.tool_name, &self.input);
        self
    }

    /// The questions, read from `input` when an older record has none.
    pub fn user_input_questions(&self) -> Vec<UserInputQuestion> {
        if self.questions.is_empty() { user_input_questions(&self.tool_name, &self.input) } else { self.questions.clone() }
    }

    /// Codex tags per-app Computer Use consent as an elicitation with no form fields; it is an approval.
    pub fn is_connector_consent(&self) -> bool {
        self.tool_name == "mcp_elicitation"
            && self.input.pointer("/_meta/codex_approval_kind").and_then(Value::as_str) == Some("mcp_tool_call")
    }

    /// Whether this request waits for an answer (a question, a form, a sign-in, a secret) or for an approval.
    pub fn pending_kind(&self) -> PendingRequestKind {
        if self.is_user_input() && !self.is_connector_consent() && self.tool_name != PERMISSION_REQUEST_TOOL {
            PendingRequestKind::Question
        } else {
            PendingRequestKind::Approval
        }
    }

    /// Whether a delegating agent may answer this request for the user: a plain question with no
    /// hidden answer. Never an approval, a password, a secret, a sign-in, a permission, a pick or a form.
    pub fn agent_answerable(&self) -> bool {
        matches!(
            self.tool_name.as_str(),
            "AskUserQuestion" | "request_user_input" | "opencode_question" | CURSOR_QUESTION_TOOL | "ui_select" | "ui_input" | "ui_editor"
        ) && {
            let questions = self.user_input_questions();
            !questions.is_empty() && questions.iter().all(|question| !question.secret)
        }
    }
}

/// The text line an attachment becomes for a harness that takes text answers.
pub fn attachment_line(kind: &str, path: &str) -> String {
    let noun = match kind {
        "image" => "image",
        "window" => "window capture",
        _ => "file",
    };
    format!("Attached {noun}: {path}")
}

/// Turn normalized answers into the response `approval`'s harness expects. `resolve` gives an
/// attachment's absolute path, or `None` when it is gone. Errors say what to do next.
pub fn encode_answers(
    approval: &ApprovalRequest,
    answers: &[UserInputAnswer],
    resolve: impl Fn(&UserInputAttachment) -> Option<String>,
) -> Result<Value, String> {
    let questions = approval.user_input_questions();
    if questions.is_empty() {
        return Err("This request has no questions to answer. Use its own buttons instead.".into());
    }
    // (question, chosen texts, attachment (kind, path)s) in question order.
    type Chosen<'a> = (&'a UserInputQuestion, Vec<String>, Vec<(String, String)>);
    let mut chosen: Vec<Chosen> = Vec::new();
    for question in &questions {
        let answer = answers.iter().find(|answer| answer.id == question.id).ok_or_else(|| {
            format!("Answer every question before sending. \"{}\" has no answer.", question.question.chars().take(80).collect::<String>())
        })?;
        if answer.attachments.len() > MAX_ANSWER_ATTACHMENTS {
            return Err(format!("Attach at most {MAX_ANSWER_ATTACHMENTS} items to one answer."));
        }
        if !answer.attachments.is_empty() && !question.attachments {
            return Err("This agent can't receive attachments. Remove them, or describe them in your answer.".into());
        }
        let mut texts: Vec<String> = answer.answers.iter().map(|text| text.trim().to_owned()).filter(|text| !text.is_empty()).collect();
        let mut paths = Vec::new();
        for attachment in &answer.attachments {
            let path = resolve(attachment).ok_or_else(|| {
                format!("\"{}\" is no longer available. Attach it again.", attachment.name.chars().take(80).collect::<String>())
            })?;
            paths.push((attachment.kind.clone(), path));
        }
        if texts.is_empty() && !paths.is_empty() {
            texts.push(if question.allow_custom || question.options.is_empty() {
                "See the attachment.".to_owned()
            } else {
                return Err("Choose an option as well as attaching something.".into());
            });
        }
        if texts.is_empty() {
            return Err("Answer every question before sending.".into());
        }
        if !question.multi_select && texts.len() > 1 {
            return Err("Choose one answer for this question.".into());
        }
        if !question.allow_custom
            && !question.options.is_empty()
            && let Some(unknown) = texts.iter().find(|text| !question.options.iter().any(|option| option.label == **text))
        {
            return Err(format!("\"{unknown}\" is not one of the options. Choose one of them."));
        }
        chosen.push((question, texts, paths));
    }
    let with_lines = |texts: &[String], paths: &[(String, String)]| -> Vec<String> {
        texts.iter().cloned().chain(paths.iter().map(|(kind, path)| attachment_line(kind, path))).collect()
    };
    Ok(match approval.tool_name.as_str() {
        "AskUserQuestion" => {
            let mut answers = Map::new();
            let mut annotations = Map::new();
            let mut attachments = Map::new();
            for (question, texts, paths) in &chosen {
                answers.insert(question.id.clone(), if question.multi_select { json!(texts) } else { json!(texts[0]) });
                let mut notes = Vec::new();
                // Claude shows a multi-select answer joined with ", ": spell out labels that hold a comma.
                if question.multi_select && texts.iter().any(|text| text.contains(',')) {
                    notes.push(format!(
                        "Selected options, exactly: {}",
                        texts.iter().map(|text| format!("\"{}\"", text.replace('"', "\\\""))).collect::<Vec<_>>().join("; ")
                    ));
                }
                notes.extend(paths.iter().map(|(kind, path)| attachment_line(kind, path)));
                let mut note = Map::new();
                if !question.multi_select
                    && let Some(preview) = question.options.iter().find(|option| option.label == texts[0]).and_then(|o| o.preview.clone())
                {
                    note.insert("preview".into(), json!(preview));
                }
                if !notes.is_empty() {
                    note.insert("notes".into(), json!(notes.join("\n")));
                }
                if !note.is_empty() {
                    annotations.insert(question.id.clone(), Value::Object(note));
                }
                if !paths.is_empty() {
                    attachments.insert(
                        question.id.clone(),
                        json!(paths.iter().map(|(kind, path)| json!({"kind": kind, "path": path})).collect::<Vec<_>>()),
                    );
                }
            }
            let mut response = json!({ "answers": answers });
            if !annotations.is_empty() {
                response["annotations"] = Value::Object(annotations);
            }
            if !attachments.is_empty() {
                response["attachments"] = Value::Object(attachments);
            }
            response
        }
        "request_user_input" => json!({
            "answers": chosen.iter().map(|(question, texts, paths)| (question.id.clone(), json!({ "answers": with_lines(texts, paths) }))).collect::<Map<_, _>>()
        }),
        "opencode_question" => json!({ "answers": chosen.iter().map(|(_, texts, paths)| with_lines(texts, paths)).collect::<Vec<_>>() }),
        CURSOR_QUESTION_TOOL => json!({
            "answers": chosen.iter().map(|(question, texts, _)| json!({
                "questionId": question.id,
                "selectedOptionIds": texts.iter().filter_map(|text| question.options.iter().find(|option| option.label == *text)).map(|option| option.value.clone().unwrap_or_else(|| option.label.clone())).collect::<Vec<_>>(),
            })).collect::<Vec<_>>()
        }),
        "ui_select" | "ui_input" | "ui_editor" => {
            let (_, texts, paths) = &chosen[0];
            json!({ "value": with_lines(texts, paths).join("\n") })
        }
        _ => return Err("This request has no questions to answer. Use its own buttons instead.".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ApprovalDecision, SECRET_REQUEST_TOOL};

    fn request(tool: &str, input: Value) -> ApprovalRequest {
        serde_json::from_value::<ApprovalRequest>(json!({"id":"00000000-0000-0000-0000-000000000001","thread_id":"00000000-0000-0000-0000-000000000002","turn_id":"00000000-0000-0000-0000-000000000003","tool_name":tool,"input":input,"summary":"Question","created_at":"2026-09-05T00:00:00Z"})).unwrap().with_questions()
    }
    fn answer(id: &str, answers: &[&str]) -> UserInputAnswer {
        UserInputAnswer { id: id.into(), answers: answers.iter().map(|a| (*a).to_owned()).collect(), attachments: Vec::new() }
    }
    fn no_files(_: &UserInputAttachment) -> Option<String> {
        None
    }

    #[test]
    fn every_harness_shape_reads_into_one_model() {
        let claude = request(
            "AskUserQuestion",
            json!({"questions":[{"question":"Which layout?","header":"Layout","multiSelect":false,"options":[{"label":"A","description":"Grid","preview":"```css\ngrid\n```"},{"label":"B"}]}]}),
        );
        assert_eq!(claude.questions[0].id, "Which layout?");
        assert_eq!(claude.questions[0].options[0].preview.as_deref(), Some("```css\ngrid\n```"));
        assert!(claude.questions[0].allow_custom && claude.questions[0].attachments);

        let codex = request(
            "request_user_input",
            json!({"questions":[{"id":"color","header":"Color","question":"Which?","isOther":false,"isSecret":false,"options":[{"label":"Blue","description":"Calm"}]},{"id":"token","question":"Token?","isSecret":true,"options":null}]}),
        );
        assert!(!codex.questions[0].allow_custom);
        assert!(codex.questions[1].allow_custom && codex.questions[1].secret);
        assert!(!codex.agent_answerable(), "a secret question stays with the user");

        let opencode = request(
            "opencode_question",
            json!({"questions":[{"question":"Pick","multiple":true,"custom":false,"options":[{"label":"x"},{"label":"y"}]}]}),
        );
        assert_eq!(
            (opencode.questions[0].id.as_str(), opencode.questions[0].multi_select, opencode.questions[0].allow_custom),
            ("0", true, false)
        );

        let cursor = request(
            CURSOR_QUESTION_TOOL,
            json!({"title":"Question","questions":[{"id":"scope","prompt":"Which scope?","options":[{"id":"workspace","label":"Workspace"},{"id":"session","label":"Session"}]}]}),
        );
        assert_eq!(cursor.questions[0].options[1].value.as_deref(), Some("session"));
        assert!(cursor.questions[0].header.is_none() && !cursor.questions[0].attachments);

        let pi = request("ui_select", json!({"title":"Deploy where?","options":["staging","prod"]}));
        assert_eq!(pi.questions[0].options.len(), 2);
        assert!(request("ui_confirm", json!({"title":"Sure?"})).questions.is_empty());
        assert!(request("mcp_elicitation", json!({"message":"Name"})).questions.is_empty());
    }

    #[test]
    fn kinds_split_questions_from_approvals() {
        assert_eq!(request("AskUserQuestion", json!({"questions":[]})).pending_kind(), PendingRequestKind::Question);
        assert_eq!(request(SECRET_REQUEST_TOOL, json!({})).pending_kind(), PendingRequestKind::Question);
        assert_eq!(request("Bash", json!({"command":"ls"})).pending_kind(), PendingRequestKind::Approval);
        assert_eq!(request(PERMISSION_REQUEST_TOOL, json!({})).pending_kind(), PendingRequestKind::Approval);
        let consent = request("mcp_elicitation", json!({"_meta":{"codex_approval_kind":"mcp_tool_call"}}));
        assert_eq!(consent.pending_kind(), PendingRequestKind::Approval);
        for tool in
            [SECRET_REQUEST_TOOL, "kybern_askpass", "kybern_request_login", "kybern_request_pick", "Bash", "mcp_elicitation", "ui_confirm"]
        {
            assert!(!request(tool, json!({"questions":[{"question":"Q","options":["a"]}]})).agent_answerable(), "{tool}");
        }
    }

    #[test]
    fn claude_multi_select_keeps_labels_with_commas() {
        let approval = request(
            "AskUserQuestion",
            json!({"questions":[{"question":"Which?","multiSelect":true,"options":[{"label":"Red, bold"},{"label":"Blue"}]}]}),
        );
        let response = encode_answers(&approval, &[answer("Which?", &["Red, bold", "Blue"])], no_files).unwrap();
        assert_eq!(response["answers"]["Which?"], json!(["Red, bold", "Blue"]));
        assert_eq!(response["annotations"]["Which?"]["notes"], "Selected options, exactly: \"Red, bold\"; \"Blue\"");
        assert!(approval.validate_decision(&ApprovalDecision::Submit { response }).is_ok());
    }

    #[test]
    fn claude_single_answer_carries_the_chosen_preview_and_attachments() {
        let approval = request(
            "AskUserQuestion",
            json!({"questions":[{"question":"Which?","options":[{"label":"A","preview":"<a/>"},{"label":"B"}]}]}),
        );
        let attached = UserInputAnswer {
            id: "Which?".into(),
            answers: vec!["A".into()],
            attachments: vec![UserInputAttachment { kind: "image".into(), name: "shot.png".into(), asset_id: None, path: None }],
        };
        let response = encode_answers(&approval, &[attached], |_| Some("/assets/shot".into())).unwrap();
        assert_eq!(response["answers"]["Which?"], "A");
        assert_eq!(response["annotations"]["Which?"], json!({"preview":"<a/>","notes":"Attached image: /assets/shot"}));
        assert_eq!(response["attachments"]["Which?"][0]["path"], "/assets/shot");
    }

    #[test]
    fn other_harnesses_get_their_own_shapes() {
        let codex = request("request_user_input", json!({"questions":[{"id":"c","question":"Which?","options":[{"label":"Blue"}]}]}));
        let attached = UserInputAnswer {
            id: "c".into(),
            answers: vec!["Teal".into()],
            attachments: vec![UserInputAttachment {
                kind: "file".into(),
                name: "a.txt".into(),
                asset_id: None,
                path: Some("/w/a.txt".into()),
            }],
        };
        assert_eq!(
            encode_answers(&codex, &[attached], |a| a.path.clone()).unwrap(),
            json!({"answers":{"c":{"answers":["Teal","Attached file: /w/a.txt"]}}})
        );
        let opencode = request("opencode_question", json!({"questions":[{"question":"A?","options":[{"label":"x"}]},{"question":"B?"}]}));
        assert_eq!(
            encode_answers(&opencode, &[answer("0", &["x"]), answer("1", &["free"])], no_files).unwrap(),
            json!({"answers":[["x"],["free"]]})
        );
        let cursor = request(
            CURSOR_QUESTION_TOOL,
            json!({"questions":[{"id":"scope","prompt":"Which?","allowMultiple":true,"options":[{"id":"w","label":"Workspace"},{"id":"s","label":"Session"}]}]}),
        );
        let response = encode_answers(&cursor, &[answer("scope", &["Session", "Workspace"])], no_files).unwrap();
        assert_eq!(response, json!({"answers":[{"questionId":"scope","selectedOptionIds":["s","w"]}]}));
        assert!(cursor.validate_decision(&ApprovalDecision::Submit { response }).is_ok());
        assert!(encode_answers(&cursor, &[answer("scope", &["Elsewhere"])], no_files).unwrap_err().contains("not one of the options"));
        let pi = request("ui_select", json!({"title":"Where?","options":["staging","prod"]}));
        let response = encode_answers(&pi, &[answer("value", &["prod"])], no_files).unwrap();
        assert_eq!(response, json!({"value":"prod"}));
        assert!(pi.validate_decision(&ApprovalDecision::Submit { response }).is_ok());
    }

    #[test]
    fn missing_answers_and_lost_attachments_explain_what_to_do() {
        let approval = request("AskUserQuestion", json!({"questions":[{"question":"A?","options":[{"label":"x"}]},{"question":"B?"}]}));
        assert!(encode_answers(&approval, &[answer("A?", &["x"])], no_files).unwrap_err().contains("Answer every question"));
        let lost = UserInputAnswer {
            id: "A?".into(),
            answers: vec!["x".into()],
            attachments: vec![UserInputAttachment { kind: "image".into(), name: "gone.png".into(), asset_id: None, path: None }],
        };
        assert!(encode_answers(&approval, &[lost, answer("B?", &["y"])], no_files).unwrap_err().contains("Attach it again"));
    }
}
