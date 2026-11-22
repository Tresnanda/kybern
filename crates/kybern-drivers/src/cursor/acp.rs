//! Cursor driver: drives `agent acp` over the Agent Client Protocol, as a flavor of the shared ACP
//! client (`crate::acp`).
//!
//! Cursor runs its own tools in-process (it never calls the client's fs or
//! terminal methods), does not report token usage, and has no session fork,
//! so rewinds are workspace-only. Sessions persist under ~/.cursor and reload
//! with `session/load`, which replays history as notifications we ignore.

use kybern_protocol::process::NoWindow;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate, ToolCall as AcpToolCall,
    ToolCallContent, ToolCallUpdateFields,
};
use async_trait::async_trait;
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::process::Command;

use crate::acp::{self, AcpFlavor, Ask, Extension, ExtensionAsk, PermissionCard, Startup};
use crate::binary::{resolve, version_of};
use crate::{AgentDriver, DriverError, DriverEvent, ProbeContext, Result, SessionConfig, SpawnedSession};

#[derive(Default)]
pub(super) struct CursorAcpDriver;

const MODEL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn parse_cursor_models(output: &[u8]) -> Vec<ProviderModel> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let (id, label) = line.trim().split_once(" - ")?;
            if id.is_empty() || label.is_empty() {
                return None;
            }
            let is_default = label.ends_with(" (default)");
            let display_name = label.strip_suffix(" (default)").unwrap_or(label).to_string();
            Some(ProviderModel {
                id: id.to_string(),
                display_name,
                resolved_id: None,
                description: None,
                provider: None,
                efforts: Vec::new(),
                default_effort: None,
                is_default,
                parameters: Vec::new(),
                variants: Vec::new(),
            })
        })
        .collect()
}

async fn cursor_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    let mut command = crate::binary::command(bin).no_window();
    command.args(["models"]).stdin(Stdio::null()).kill_on_drop(true).env("NO_COLOR", "1");
    if let Some(cwd) = &context.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &context.env {
        command.env(key, value);
    }
    match tokio::time::timeout(MODEL_DISCOVERY_TIMEOUT, crate::process_tree::output(&mut command)).await {
        Ok(Ok(output)) if output.status.success() => parse_cursor_models(&output.stdout),
        _ => Vec::new(),
    }
}

impl CursorAcpDriver {
    async fn probe_inner(&self, context: &ProbeContext) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: ProviderKind::Cursor,
            display_name: ProviderKind::Cursor.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            // Cursor's ACP mode decides approvals itself; we map modes onto agent/plan/ask.
            supported_permission_modes: vec![PermissionMode::Supervised, PermissionMode::Auto, PermissionMode::FullAccess],
            supports_fork: false,
            supports_model_switch: true,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::Cursor, context.binary.as_ref()) {
            Ok(bin) => bin,
            Err(error) => {
                status.unavailable_reason = Some(format!("{error}. Install with: curl https://cursor.com/install -fsS | bash"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(version) => {
                status.available = true;
                status.version = Some(version);
                status.models = cursor_models(&bin, context).await;
            }
            None => status.unavailable_reason = Some("could not run `agent --version`".into()),
        }
        status
    }
}

#[cfg(test)]
mod model_catalog_tests {
    use super::parse_cursor_models;

    #[test]
    fn parses_cursor_account_models_and_default() {
        let models = parse_cursor_models(
            b"Available models\n\nauto - Auto (default)\ngpt-5.4-high - GPT-5.4 1M High\n\nTip: use --model <id> to switch.\n",
        );

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "auto");
        assert_eq!(models[0].display_name, "Auto");
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "gpt-5.4-high");
        assert!(!models[1].is_default);
    }
}

/// Cursor extension `cursor/ask_question`: the agent asks the user a question.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorAskQuestionRequest {
    tool_call_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    questions: Vec<Value>,
}

/// Cursor's answer to `cursor/ask_question`: the chosen option ids, or skipped when the user declined.
fn question_outcome(answer: Option<Value>) -> Value {
    match answer.and_then(|response| response.get("answers").cloned()) {
        Some(answers) => json!({ "outcome": "answered", "answers": answers }),
        None => json!({ "outcome": "skipped", "reason": "The user chose not to answer. Continue without asking again." }),
    }
}

// A question card, never auto-answered: Kybern's own permission mode does not apply to questions.
impl ExtensionAsk for CursorAskQuestionRequest {
    fn kind(&self) -> Ask {
        Ask::Question
    }

    fn card(&self, request_id: String) -> DriverEvent {
        let summary = self
            .questions
            .first()
            .and_then(|question| question.get("prompt"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| "Answer the agent's questions".into());
        DriverEvent::PermissionRequest {
            request_id,
            tool_call_id: Some(self.tool_call_id.clone()),
            tool_name: kybern_protocol::CURSOR_QUESTION_TOOL.into(),
            input: json!({ "title": self.title, "questions": self.questions }),
            summary,
            suggestions: vec![],
        }
    }

    fn response(&self, decision: Option<ApprovalDecision>) -> Value {
        let answer = match decision {
            Some(ApprovalDecision::Submit { response }) => Some(response),
            _ => None,
        };
        json!({ "outcome": question_outcome(answer) })
    }
}

#[async_trait]
impl AgentDriver for CursorAcpDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Cursor
    }

    fn supports_fork(&self) -> bool {
        false
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_inner(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_inner(context).await
    }

    async fn list_sessions(
        &self,
        context: &ProbeContext,
        cursor: Option<&str>,
        query: &str,
    ) -> Result<kybern_protocol::methods::SessionsListResult> {
        crate::sessions::list(self.kind(), context, cursor, query).await
    }

    async fn read_session(&self, context: &ProbeContext, id: &str) -> Result<crate::sessions::SessionHistory> {
        crate::sessions::read(self.kind(), context, id).await
    }

    async fn open_session_reader(&self, context: &ProbeContext) -> Result<Box<dyn crate::sessions::SessionReader>> {
        crate::sessions::reader(self.kind(), context).await
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        acp::spawn(Cursor, config).await
    }
}

/// Legacy Cursor chats as an ACP flavor.
struct Cursor;

impl AcpFlavor for Cursor {
    type Completion = std::convert::Infallible;
    const KIND: ProviderKind = ProviderKind::Cursor;
    const NAME: &'static str = "Cursor";
    const CLOSED: &'static str = "cursor session closed";
    const INTERRUPT_REPORTS_CLOSED: bool = true;
    const CLOSE_WAIT: Option<Duration> = Some(Duration::from_secs(5));
    const AGENT_IMAGES: bool = true;
    // Legacy Cursor ACP sessions have no live steering channel; the daemon delivers a follow-up.
    const STEER_FALLBACK: bool = true;
    const COMPACT: Option<&'static str> = Some("/compact");
    const NO_EFFORT_SWITCH: &'static str = "Cursor ACP did not advertise an effort control";
    // Cursor keeps the model it was asked for even when it can't switch.
    const KEEPS_UNSET_MODEL: bool = true;
    const ERROR_PREFIX: &'static str = "cursor acp: ";

    // Spawned with the project as cwd: Cursor reads .cursor/mcp.json from it.
    fn command(&self, bin: &Path, config: &SessionConfig) -> Command {
        let mut cmd = crate::binary::command(bin).no_window();
        cmd.arg("acp");
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        cmd
    }

    fn startup_error(&self, _step: Startup, _detail: &str, _stderr: &str) -> DriverError {
        DriverError::ProcessExited("cursor agent exited during startup".into())
    }

    fn exited_during_startup(&self, _stderr: &std::sync::Mutex<String>) -> DriverError {
        DriverError::ProcessExited("cursor agent exited during startup".into())
    }

    fn auth_method(&self) -> Option<&str> {
        Some("cursor_login")
    }

    fn session_mode(&self, mode: PermissionMode) -> Option<&'static str> {
        Some(mode_id(mode))
    }

    fn tool_call(&self, call: &AcpToolCall) -> (String, Value) {
        (format!("{:?}", call.kind).to_lowercase(), json!({ "title": call.title, "raw": call.raw_input }))
    }

    fn tool_output(&self, status: Option<&str>, fields: ToolCallUpdateFields) -> (Value, bool) {
        let mut diffs = Vec::new();
        for c in fields.content.iter().flatten() {
            if let ToolCallContent::Diff(d) = c {
                diffs.push(json!({ "path": d.path, "old": d.old_text, "new": d.new_text }));
            }
        }
        let output = json!({ "raw": fields.raw_output, "diffs": diffs, "content": fields.content, "title": fields.title });
        (output, status == Some("failed"))
    }

    fn other_update(&self, update: SessionUpdate) -> Option<DriverEvent> {
        let SessionUpdate::Plan(p) = update else { return None };
        let text = format!("plan updated ({} entries)", p.entries.len());
        Some(DriverEvent::Notice { level: NoticeLevel::Info, text, data: serde_json::to_value(&p).ok() })
    }

    // Cursor's ACP mode decides approvals itself; in Auto and Full access Kybern allows whatever it asks.
    fn auto_permission(&self, mode: PermissionMode, request: &RequestPermissionRequest, _cwd: &Path) -> Option<RequestPermissionResponse> {
        if !matches!(mode, PermissionMode::Auto | PermissionMode::FullAccess) {
            return None;
        }
        let options = &request.options;
        let choice = of_kind(options, PermissionOptionKind::AllowAlways)
            .or_else(|| of_kind(options, PermissionOptionKind::AllowOnce))
            .or_else(|| options.first());
        Some(choice.map_or_else(acp::cancelled, acp::selected))
    }

    fn permission_card(&self, request: &RequestPermissionRequest) -> PermissionCard {
        let fields = &request.tool_call.fields;
        let title = fields.title.clone().unwrap_or_default();
        let options: Vec<Value> = request
            .options
            .iter()
            .map(|o| json!({ "id": o.option_id.to_string(), "name": o.name, "kind": format!("{:?}", o.kind) }))
            .collect();
        PermissionCard {
            tool_name: fields.kind.map(|k| format!("{k:?}").to_lowercase()).unwrap_or_else(|| "tool".into()),
            input: json!({ "title": title, "raw": fields.raw_input, "options": options }),
            summary: title,
        }
    }

    // Allow for this thread takes Cursor's allow-always option; anything else, or no answer, rejects.
    fn permission_answer(
        &self,
        options: &[PermissionOption],
        decision: Option<&ApprovalDecision>,
    ) -> (RequestPermissionResponse, Option<String>) {
        let pick = |first, second| of_kind(options, first).or_else(|| of_kind(options, second));
        let choice = match decision {
            Some(ApprovalDecision::AllowOnce) => pick(PermissionOptionKind::AllowOnce, PermissionOptionKind::AllowAlways),
            Some(ApprovalDecision::AllowAlways) => pick(PermissionOptionKind::AllowAlways, PermissionOptionKind::AllowOnce),
            Some(ApprovalDecision::Deny { .. } | ApprovalDecision::Submit { .. }) | None => {
                pick(PermissionOptionKind::RejectOnce, PermissionOptionKind::RejectAlways)
            }
        };
        (choice.map_or_else(acp::cancelled, acp::selected), None)
    }

    fn extension_request(&self, method: &str, params: &Value) -> Option<Extension> {
        match method {
            "cursor/ask_question" => {
                let question: CursorAskQuestionRequest = serde_json::from_value(params.clone()).ok()?;
                Some(Extension::Ask(Box::new(question)))
            }
            // The agent proposes a plan: accepted as it stands.
            "cursor/create_plan" => Some(Extension::Answer(json!({ "outcome": { "outcome": "accepted" } }))),
            _ => None,
        }
    }
}

fn of_kind(options: &[PermissionOption], kind: PermissionOptionKind) -> Option<&PermissionOption> {
    options.iter().find(|option| option.kind == kind)
}

fn mode_id(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Supervised | PermissionMode::AcceptEdits => "agent",
        PermissionMode::Auto | PermissionMode::FullAccess => "agent",
    }
}

/// The blocks a Cursor prompt is sent as: one per part.
#[cfg(test)]
fn blocks(message: &UserMessage) -> Vec<agent_client_protocol::schema::v1::ContentBlock> {
    acp::prompt_blocks(message)
}

#[cfg(test)]
mod tests {
    use super::blocks;
    use agent_client_protocol::schema::v1::ContentBlock;
    use kybern_protocol::{ContentPart, UserMessage};

    #[test]
    fn cursor_uses_its_native_skill_command_syntax() {
        let message = UserMessage { parts: vec![ContentPart::Skill { name: "review".into(), path: "/skills/review/SKILL.md".into() }] };

        let blocks = blocks(&message);
        let ContentBlock::Text(text) = &blocks[0] else { panic!("expected text block") };
        assert_eq!(text.text, "/review");
    }

    #[test]
    fn cursor_questions_answer_with_option_ids_or_skip() {
        let answers = serde_json::json!([{ "questionId": "scope", "selectedOptionIds": ["session"] }]);
        assert_eq!(
            super::question_outcome(Some(serde_json::json!({ "answers": answers }))),
            serde_json::json!({ "outcome": "answered", "answers": answers })
        );
        assert_eq!(super::question_outcome(None)["outcome"], "skipped");
    }

    #[tokio::test]
    async fn legacy_acp_steer_falls_back_to_followup() {
        let handle = crate::acp::Handle::detached(super::Cursor);
        assert!(matches!(
            crate::AgentSession::steer(&handle, "s1", &UserMessage::text("nudge")).await,
            Err(crate::DriverError::SteerFallback)
        ));
    }
}

#[cfg(test)]
mod orchestration_part_tests {
    use super::*;
    use crate::test_support::*;
    use agent_client_protocol::schema::v1::ContentBlock;

    #[test]
    fn thread_messages_and_agent_results_flatten_into_text_blocks() {
        let text: String = blocks(&orchestration_message())
            .into_iter()
            .filter_map(|block| match block {
                ContentBlock::Text(text) => Some(text.text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_flattened(&text);
    }
}
