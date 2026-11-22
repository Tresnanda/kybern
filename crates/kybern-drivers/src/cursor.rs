//! Cursor's official local SDK, isolated in one supervised Node host per account.
//!
//! New session IDs are namespaced so existing ACP sessions continue to resume
//! with the CLI that created them. We never reinterpret a CLI conversation as
//! an SDK agent or silently replace a missing conversation with an empty one.
mod acp;
mod models;
mod pool;
mod runtime;
pub use models::legacy_model_selection;
mod stream;
pub mod usage;

pub(crate) use pool::Connection;
pub use runtime::{
    SDK_VERSION, auth_status, install, installed, login_command, node_version, npm_available, outdated, previous_version, setup_command,
    setup_error, sign_out,
};

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, NativeToolBridge, ProbeContext, Result, SessionConfig, SpawnedSession};

pub const SDK_SESSION_PREFIX: &str = "cursor-sdk:";

/// A setup error as a sentence for people, without the error-kind prefix.
pub fn reason(error: DriverError) -> String {
    match error {
        DriverError::BinaryNotFound(text) | DriverError::Protocol(text) | DriverError::Unsupported(text) => text,
        error => error.to_string(),
    }
}
pub struct CursorDriver;

pub(crate) fn sdk_id(id: &str) -> Result<&str> {
    id.strip_prefix(SDK_SESSION_PREFIX)
        .filter(|id| !id.is_empty() && !id.starts_with("bc-") && id.len() <= 1024)
        .ok_or_else(|| DriverError::Protocol("Invalid local Cursor SDK agent id. Refresh the session list and try again.".into()))
}

fn validate_mode(mode: PermissionMode) -> Result<()> {
    if matches!(mode, PermissionMode::Auto | PermissionMode::FullAccess) {
        Ok(())
    } else {
        Err(DriverError::Unsupported(
            "Cursor SDK has no interactive approvals. Choose Auto-review (auto) or Full access. Existing CLI chats retain their original approvals.".into(),
        ))
    }
}

/// The authenticated per-thread MCP endpoint, which the host serves to its
/// agent as SDK custom tools (see `kybernTools` in `sdk/host.mjs`).
fn native_tools(bridge: Option<&NativeToolBridge>) -> Result<Value> {
    let Some(bridge) = bridge else { return Ok(Value::Null) };
    bridge.validate()?;
    // Same boundary as T3: use the authenticated per-thread MCP endpoint.
    // Do not pretend tool discovery alone enforces a coordinator's restrictions.
    if bridge.restrictions.require_enforcement {
        return Err(DriverError::Unsupported("Cursor SDK does not enforce Kybern coordinator tool restrictions yet".into()));
    }
    let endpoint =
        bridge.endpoint.as_ref().ok_or_else(|| DriverError::Unsupported("Cursor SDK tools require a daemon MCP endpoint".into()))?;
    let authorization =
        bridge.authorization.as_ref().ok_or_else(|| DriverError::Unsupported("Cursor SDK tools require a scoped MCP capability".into()))?;
    Ok(json!({"url": endpoint, "authorization": format!("Bearer {authorization}")}))
}

#[async_trait]
impl AgentDriver for CursorDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Cursor
    }
    fn supports_fork(&self) -> bool {
        false
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_with_context(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: self.kind(),
            display_name: "Cursor".into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: vec![PermissionMode::Auto, PermissionMode::FullAccess],
            supports_fork: false,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };
        match runtime::probe(context).await {
            Ok((binary, value)) => {
                status.available = true;
                status.binary_path = Some(binary.display().to_string());
                status.version = Some(format!("SDK {}", value["version"].as_str().unwrap_or(SDK_VERSION)));
                status.models = serde_json::from_value(value["models"].clone()).unwrap_or_default();
                for model in &status.models {
                    // A variant can offer efforts the row's default combination lacks.
                    let variant_efforts = model.variants.iter().flat_map(|variant| &variant.efforts);
                    for effort in model.efforts.iter().chain(variant_efforts) {
                        if !status.supported_efforts.contains(effort) {
                            status.supported_efforts.push(effort.clone());
                        }
                    }
                }
            }
            Err(error) => status.unavailable_reason = Some(reason(error)),
        }
        status
    }

    async fn list_sessions(&self, context: &ProbeContext, cursor: Option<&str>, query: &str) -> Result<methods::SessionsListResult> {
        crate::sessions::list(self.kind(), context, cursor, query).await
    }

    async fn read_session(&self, context: &ProbeContext, id: &str) -> Result<crate::sessions::SessionHistory> {
        crate::sessions::read(self.kind(), context, id).await
    }

    async fn open_session_reader(&self, context: &ProbeContext) -> Result<Box<dyn crate::sessions::SessionReader>> {
        crate::sessions::reader(self.kind(), context).await
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        if config.resume_session_id.as_ref().is_some_and(|id| !id.starts_with(SDK_SESSION_PREFIX)) {
            return acp::CursorAcpDriver.spawn(config).await;
        }
        if config.fork || config.rewind.is_some() {
            return Err(DriverError::Unsupported("Cursor SDK does not expose native conversation forks or rollback".into()));
        }
        validate_mode(config.permission_mode)?;
        let tools = native_tools(config.native_tool_bridge.as_ref())?;
        // The SDK has no system channel, so a new conversation carries the guide
        // on its first ordinary prompt. A project Coordinator's lead instructions
        // and a thread's project brief ride in the same block, since there is no
        // system channel for them either. A resumed conversation that already
        // holds it gets nothing: sending it on every respawn (each idle release)
        // would pile up one more copy per resume, and what changed since then
        // reaches it as provider-only updates. One that never received it (the
        // daemon keeps track by session id) gets it once.
        let guide = match (&config.resume_session_id, config.resume_lacks_instructions) {
            (None, _) | (Some(_), true) => config.native_tool_bridge.as_ref().and_then(|bridge| bridge.provider_instructions()),
            (Some(_), false) => None,
        };
        let delivery = Arc::new(StdMutex::new(DeliveryState::new(guide)));
        let context = ProbeContext { binary: config.binary.clone(), cwd: Some(config.cwd.clone()), env: config.env.into_iter().collect() };
        let (connection, events) = Connection::spawn_with_delivery(&context, delivery.clone())?;
        let agent_id = config.resume_session_id.as_deref().map(sdk_id).transpose()?;
        let opened = connection
            .call(
                "open",
                json!({
                    "cwd": config.cwd, "model": config.model, "effort": config.effort, "mode": config.permission_mode,
                    "agentId": agent_id, "nativeTools": tools,
                }),
            )
            .await?;
        let id = opened["agentId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| DriverError::Protocol("Cursor SDK returned no agent id".into()))?;
        connection
            .emit(DriverEvent::SessionBound {
                session_id: format!("{SDK_SESSION_PREFIX}{id}"),
                model: opened["model"].as_str().map(str::to_string),
            })
            .await;
        connection
            .emit(DriverEvent::CommandsUpdated(vec![ProviderCommand {
                name: "compress".into(),
                description: "Compact the Cursor conversation".into(),
                ..Default::default()
            }]))
            .await;
        Ok(SpawnedSession { session: Box::new(Session { connection, model: Mutex::new(config.model), delivery }), events })
    }
}

#[derive(Default)]
struct DeliveryState {
    /// Kybern's guide, until a turn that carries it checkpoints or completes.
    guide: Option<String>,
    /// Whether this session's guide was confirmed persisted in Cursor's conversation history.
    guide_delivered: bool,
    /// Raw user prompts from consecutive stopped runs that never saved a checkpoint.
    interrupted_prompts: Vec<String>,
    in_flight: Option<InFlightPrompt>,
}

struct InFlightPrompt {
    guide: Option<String>,
    prior_interrupted: Vec<String>,
    /// Raw user text sent on this turn (never wrapped in `interrupted_followup`).
    raw_prompt: String,
}

impl DeliveryState {
    fn new(guide: Option<String>) -> Self {
        Self { guide, guide_delivered: false, interrupted_prompts: Vec::new(), in_flight: None }
    }

    fn prepare(&mut self, text: &str) -> String {
        // Slash commands (skills, /compress) must stay at the start of the prompt;
        // the guide and any interrupted prompts wait for the next ordinary one.
        if text.trim_start().starts_with('/') {
            self.in_flight = None;
            return text.to_owned();
        }
        let guide = self.guide.take();
        let prior_interrupted = std::mem::take(&mut self.interrupted_prompts);
        let prompt = if prior_interrupted.is_empty() { text.to_owned() } else { interrupted_followup(&prior_interrupted, text) };
        let outbound = match &guide {
            Some(guide) => with_guide(guide, &prompt),
            None => prompt,
        };
        self.in_flight = Some(InFlightPrompt { guide, prior_interrupted, raw_prompt: text.to_owned() });
        outbound
    }

    fn apply_admission_failed(&mut self) {
        let Some(flight) = self.in_flight.take() else { return };
        if self.guide.is_none() {
            self.guide = flight.guide;
        }
        if self.interrupted_prompts.is_empty() {
            self.interrupted_prompts = flight.prior_interrupted;
        }
    }

    fn apply_prewarm_cancelled(&mut self) {
        let Some(flight) = self.in_flight.take() else { return };
        if self.guide.is_none() {
            self.guide = flight.guide;
        }
        if self.interrupted_prompts.is_empty() {
            let mut carried = flight.prior_interrupted;
            carried.push(flight.raw_prompt);
            self.interrupted_prompts = carried;
        }
    }

    fn apply_outcome(&mut self, outcome: stream::TurnOutcome) {
        let Some(flight) = self.in_flight.take() else { return };
        match outcome {
            stream::TurnOutcome::Completed
            | stream::TurnOutcome::Cancelled { checkpointed: true }
            | stream::TurnOutcome::Failed { checkpointed: true } => {
                if flight.guide.is_some() {
                    self.guide_delivered = true;
                }
            }
            stream::TurnOutcome::Cancelled { checkpointed: false } => {
                // Cursor keeps a run in conversation history only after its first
                // checkpoint, so carry both the guide and the raw interrupted prompts forward.
                if self.guide.is_none() {
                    self.guide = flight.guide;
                }
                if self.interrupted_prompts.is_empty() {
                    let mut carried = flight.prior_interrupted;
                    carried.push(flight.raw_prompt);
                    self.interrupted_prompts = carried;
                }
            }
            stream::TurnOutcome::Failed { checkpointed: false } => {
                if self.guide.is_none() {
                    self.guide = flight.guide;
                }
                if self.interrupted_prompts.is_empty() {
                    self.interrupted_prompts = flight.prior_interrupted;
                }
            }
        }
    }
}

fn interrupted_followup(previous: &[String], next: &str) -> String {
    match previous {
        [single] => format!(
            "Your previous turn was interrupted and is missing from your history. Some of its work may already be done. Its request was:\n\n{single}\n\nThe new message, which may continue or change that request:\n\n{next}"
        ),
        many => {
            let list = many.iter().enumerate().map(|(i, text)| format!("{}. {text}", i + 1)).collect::<Vec<_>>().join("\n\n");
            format!(
                "Your previous turns were interrupted and are missing from your history. Some of their work may already be done. Their requests were:\n\n{list}\n\nThe new message, which may continue or change those requests:\n\n{next}"
            )
        }
    }
}

struct Session {
    connection: Connection,
    model: Mutex<Option<String>>,
    delivery: Arc<StdMutex<DeliveryState>>,
}

const GUIDE_OPEN: &str = "<kybern_instructions>";
const GUIDE_CLOSE: &str = "</kybern_instructions>";

/// The provider's copy of the first prompt: the guide in a tagged block, then the user's request.
pub(crate) fn with_guide(guide: &str, text: &str) -> String {
    format!("{GUIDE_OPEN}\n{guide}\n{GUIDE_CLOSE}\n\n{text}")
}

/// The user's own text of a saved prompt that began with the guide block.
pub(crate) fn without_guide(text: &str) -> &str {
    text.strip_prefix(GUIDE_OPEN)
        .and_then(|rest| rest.split_once(GUIDE_CLOSE))
        .map(|(_, request)| request.strip_prefix("\n\n").unwrap_or(request))
        .unwrap_or(text)
}

#[async_trait]
impl AgentSession for Session {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()> {
        let mut payload = sdk_message(message);
        let text = payload["text"].as_str().unwrap_or("").to_owned();
        let outbound = self.delivery.lock().unwrap_or_else(|poison| poison.into_inner()).prepare(&text);
        payload["text"] = Value::String(outbound);
        match self.connection.call("send", json!({"messageId": message_id, "message": payload})).await {
            Ok(result) => {
                if result["cancelled"].as_bool() == Some(true) {
                    self.delivery.lock().unwrap_or_else(|poison| poison.into_inner()).apply_prewarm_cancelled();
                }
                Ok(())
            }
            Err(error) => {
                // The agent never saw it; offer the guide and prior interrupted prompt again.
                self.delivery.lock().unwrap_or_else(|poison| poison.into_inner()).apply_admission_failed();
                Err(error)
            }
        }
    }
    async fn steer(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let payload = sdk_message(message);
        if payload["images"].as_array().is_some_and(|images| !images.is_empty()) {
            return Err(DriverError::Unsupported(
                "Cursor cannot attach images to a mid-turn steer message. Queue the message for the next turn instead.".into(),
            ));
        }
        let text = payload["text"].as_str().unwrap_or("");
        if text.trim().is_empty() {
            return Err(DriverError::Protocol("Write a message before steering Cursor.".into()));
        }
        let result = self.connection.call("steer", json!({"text": text})).await?;
        match result["outcome"].as_str() {
            Some("complete_delivered") => Ok(()),
            Some("revert_to_followup") => Err(DriverError::SteerFallback),
            other => {
                tracing::warn!(outcome = ?other, "Cursor SDK returned an unrecognized steer outcome; falling back to follow-up");
                Err(DriverError::SteerFallback)
            }
        }
    }
    async fn compact(&self) -> Result<()> {
        self.send_message(&uuid::Uuid::new_v4().to_string(), &UserMessage::text("/compress")).await
    }
    async fn interrupt(&self) -> Result<()> {
        self.connection.call("cancel", json!({})).await?;
        Ok(())
    }
    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        validate_mode(mode)?;
        let model = self.model.lock().await;
        self.connection.call("set_mode", json!({"mode": mode, "model": *model})).await?;
        Ok(())
    }
    async fn set_model(&self, model: &str) -> Result<()> {
        let mut selected = self.model.lock().await;
        self.connection.call("set_model", json!({"model": model})).await?;
        *selected = Some(model.to_string());
        Ok(())
    }
    async fn set_effort(&self, effort: &str) -> Result<()> {
        self.connection.call("set_effort", json!({"effort": effort})).await?;
        Ok(())
    }
    async fn respond_permission(&self, _: &str, _: &ApprovalDecision) -> Result<()> {
        Err(DriverError::Unsupported("Cursor SDK uses sandboxing and Auto-review; it has no interactive approval requests".into()))
    }
    async fn close(&self) -> Result<()> {
        self.connection.close().await
    }
    fn instructions_delivered(&self) -> Option<bool> {
        Some(self.delivery.lock().unwrap_or_else(|poison| poison.into_inner()).guide_delivered)
    }
}

const MAX_INLINE_SKILL_BYTES: u64 = 1_000_000;

fn inline_user_only_skill(path: &str) -> Option<String> {
    let file = Path::new(path);
    if file.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        return None;
    }
    if std::fs::metadata(file).ok()?.len() > MAX_INLINE_SKILL_BYTES {
        return None;
    }
    let contents = std::fs::read_to_string(file).ok()?;
    let (frontmatter, body) = split_yaml_frontmatter(&contents)?;
    if !frontmatter_disables_model_invocation(frontmatter) {
        return None;
    }
    Some(body.trim().to_string())
}

fn split_yaml_frontmatter(contents: &str) -> Option<(&str, &str)> {
    let rest = contents.strip_prefix("---\r\n").or_else(|| contents.strip_prefix("---\n"))?;
    let mut offset = 0;
    for segment in rest.split_inclusive('\n') {
        let line = segment.trim_end_matches(['\r', '\n']);
        if line == "---" {
            let frontmatter = rest[..offset].trim_end_matches(['\r', '\n']);
            let body = &rest[offset + segment.len()..];
            return Some((frontmatter, body));
        }
        offset += segment.len();
    }
    None
}

fn frontmatter_disables_model_invocation(frontmatter: &str) -> bool {
    for raw_line in frontmatter.lines() {
        let line = raw_line.trim_end_matches('\r');
        // Top-level YAML keys have no leading indentation.
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.trim() != "disable-model-invocation" {
            continue;
        }
        let trimmed = value.trim();
        let unquoted = if let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            inner
        } else if let Some(inner) = trimmed.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
            inner
        } else {
            trimmed.split('#').next().unwrap_or(trimmed).trim()
        };
        return matches!(unquoted.to_ascii_lowercase().as_str(), "true" | "yes" | "on" | "1");
    }
    false
}

fn sdk_message(message: &UserMessage) -> Value {
    let mut text = String::new();
    let mut images = Vec::new();
    let mut inlined_names = HashSet::new();
    let mut inlined_skills = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text: part } => text.push_str(part),
            ContentPart::FileMention { path } => text.push_str(&format!("@{path}")),
            ContentPart::ThreadReference { thread_id, title, .. } => text.push_str(&thread_reference_text(*thread_id, title)),
            ContentPart::Skill { name, path } => {
                text.push_str(&format!("/{name}"));
                if inlined_names.insert(name.clone())
                    && let Some(body) = inline_user_only_skill(path)
                {
                    inlined_skills.push((name.clone(), body));
                }
            }
            ContentPart::Mention { name, .. } => text.push_str(&format!("@{name}")),
            ContentPart::Image { media_type, data } => images.push(json!({"data": data, "mimeType": media_type})),
            ContentPart::Attachment { name, .. } => text.push_str(&format!("[attached file: {name}]")),
            ContentPart::Media { .. } => text.push_str("[image]"),
            ContentPart::ThreadMessage { .. } | ContentPart::AgentResults { .. } | ContentPart::SystemRow { .. } => {
                if let Some(flat) = part.orchestration_text() {
                    text.push_str(&flat);
                }
            }
        }
    }
    if !inlined_skills.is_empty() {
        text.push_str("\n\nThe user invoked these skills. Follow their instructions:\n\n");
        for (index, (name, body)) in inlined_skills.iter().enumerate() {
            if index > 0 {
                text.push_str("\n\n");
            }
            text.push_str(&format!("<skill name=\"{name}\">\n{body}\n</skill>"));
        }
    }
    json!({"text": text, "images": images})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sdk_modes_do_not_advertise_or_silently_simulate_human_approval() {
        assert!(validate_mode(PermissionMode::Auto).is_ok());
        assert!(validate_mode(PermissionMode::FullAccess).is_ok());
        assert!(validate_mode(PermissionMode::Supervised).is_err());
        assert!(validate_mode(PermissionMode::AcceptEdits).is_err());
    }
    #[test]
    fn guide_wraps_the_first_prompt_and_is_removed_from_saved_history() {
        let prompt = with_guide("GUIDE", "Fix the bug");
        assert_eq!(prompt, "<kybern_instructions>\nGUIDE\n</kybern_instructions>\n\nFix the bug");
        assert_eq!(without_guide(&prompt), "Fix the bug");
        assert_eq!(without_guide("plain request"), "plain request");
        assert_eq!(without_guide("<kybern_instructions>unclosed"), "<kybern_instructions>unclosed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_runners_whose_conversation_lacks_the_guide_send_it_once_and_retry_it_after_rejection() {
        for (resume, enabled, lacks) in [
            (None, true, false),
            (Some("cursor-sdk:restored"), true, false),
            (Some("cursor-sdk:restored"), false, false),
            // Resumed, but the conversation never received the block (the guide was off then).
            (Some("cursor-sdk:restored"), true, true),
        ] {
            let root = tempfile::tempdir().unwrap();
            let host = root.path().join("node-fixture");
            let log = root.path().join("requests.jsonl");
            kybern_protocol::process::write_executable(
                &host,
                r#"#!/usr/bin/env python3
import json, sys
rejected = False
for line in sys.stdin:
    request = json.loads(line)
    with open('requests.jsonl', 'a') as log:
        log.write(json.dumps(request) + '\n')
    response = {'id': request['id'], 'result': {'agentId': 'restored'}}
    if request['type'] == 'send' and request['messageId'] == 'rejected' and not rejected:
        response = {'id': request['id'], 'error': 'fixture rejected admission'}
        rejected = True
    print(json.dumps(response), flush=True)
    if request['type'] == 'close': break
"#,
            )
            .unwrap();
            let config = SessionConfig {
                cwd: root.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::FullAccess,
                native_tool_bridge: Some(NativeToolBridge {
                    server_name: "kybern".into(),
                    endpoint: Some("http://127.0.0.1/native-tools/mcp".into()),
                    authorization: Some("fixture-session-capability".into()),
                    coordinator_instructions: enabled.then(|| "LEAD ROLE: plan and delegate".into()),
                    guide: enabled.then(|| "CURRENT GUIDE: use kybern_html_preview when helpful".into()),
                    tools: vec![],
                    restrictions: Default::default(),
                }),
                resume_session_id: resume.map(str::to_owned),
                resume_lacks_instructions: lacks,
                fork: false,
                rewind: None,
                binary: None,
                env: std::collections::HashMap::from([
                    ("KYBERN_CURSOR_NODE".into(), host.display().to_string()),
                    ("KYBERN_CURSOR_SDK_DIR".into(), root.path().display().to_string()),
                ]),
                compaction: Default::default(),
            };
            // Other concurrently forked tests can briefly inherit an open script
            // descriptor on Linux, producing ETXTBSY until their child execs.
            let mut attempts = 0;
            let spawned = loop {
                match CursorDriver.spawn(config.clone()).await {
                    Err(DriverError::Io(error)) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 50 => {
                        attempts += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    result => break result.unwrap(),
                }
            };
            spawned.session.send_message("slash", &UserMessage::text("/compress")).await.unwrap();
            assert!(spawned.session.send_message("rejected", &UserMessage::text("Explain the results")).await.is_err());
            spawned.session.send_message("retry", &UserMessage::text("Explain the results")).await.unwrap();
            spawned.session.send_message("next", &UserMessage::text("Follow up")).await.unwrap();
            spawned.session.close().await.unwrap();
            let requests: Vec<Value> =
                std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
            assert_eq!(requests[0]["agentId"], resume.map(|_| json!("restored")).unwrap_or(Value::Null));
            let sends: Vec<_> = requests.iter().filter(|request| request["type"] == "send").collect();
            assert_eq!(sends.len(), 4);
            assert_eq!(sends[0]["message"]["text"], "/compress");
            // A resumed conversation that already holds the block never gets it again.
            let expected = if enabled && (resume.is_none() || lacks) {
                with_guide("CURRENT GUIDE: use kybern_html_preview when helpful\nLEAD ROLE: plan and delegate", "Explain the results")
            } else {
                "Explain the results".into()
            };
            assert_eq!(sends[1]["message"]["text"], expected);
            assert_eq!(sends[2]["message"]["text"], expected);
            assert_eq!(without_guide(sends[2]["message"]["text"].as_str().unwrap()), "Explain the results");
            assert_eq!(sends[3]["message"]["text"], "Follow up");
        }
    }

    #[test]
    fn separates_native_ids_and_preserves_images_and_skill_syntax() {
        assert_eq!(sdk_id("cursor-sdk:local-123").unwrap(), "local-123");
        assert!(sdk_id("old-cli-id").is_err());
        assert!(sdk_id("cursor-sdk:bc-cloud-id").is_err());
        assert!(sdk_id("cursor-sdk:").is_err());
        let message = UserMessage {
            parts: vec![
                ContentPart::Skill { name: "review".into(), path: "unused".into() },
                ContentPart::Image { media_type: "image/png".into(), data: "base64".into() },
            ],
        };
        assert_eq!(sdk_message(&message), json!({"text":"/review", "images":[{"data":"base64", "mimeType":"image/png"}]}));
    }

    #[test]
    fn user_only_skills_inline_their_body_while_normal_skills_stay_bare() {
        let root = tempfile::tempdir().unwrap();
        let user_only_dir = root.path().join("grill-me");
        let normal_dir = root.path().join("review");
        std::fs::create_dir_all(&user_only_dir).unwrap();
        std::fs::create_dir_all(&normal_dir).unwrap();
        let user_only = user_only_dir.join("SKILL.md");
        let normal = normal_dir.join("SKILL.md");
        std::fs::write(
            &user_only,
            "---\nname: grill-me\ndescription: Grill the plan.\ndisable-model-invocation: true\n---\n\nAsk one question at a time.\n",
        )
        .unwrap();
        std::fs::write(&normal, "---\nname: review\ndescription: Review code.\n---\nCheck edge cases.\n").unwrap();

        let message = UserMessage {
            parts: vec![
                ContentPart::Skill { name: "grill-me".into(), path: user_only.display().to_string() },
                ContentPart::Text { text: " and ".into() },
                ContentPart::Skill { name: "review".into(), path: normal.display().to_string() },
                ContentPart::Text { text: " and again ".into() },
                ContentPart::Skill { name: "grill-me".into(), path: user_only.display().to_string() },
            ],
        };
        let text = sdk_message(&message)["text"].as_str().unwrap().to_owned();
        assert!(
            text.starts_with("/grill-me and /review and again /grill-me\n\nThe user invoked these skills. Follow their instructions:\n\n")
        );
        assert_eq!(text.matches("<skill name=\"grill-me\">").count(), 1);
        assert!(text.contains("<skill name=\"grill-me\">\nAsk one question at a time.\n</skill>"));
        assert!(!text.contains("disable-model-invocation"));
        assert!(!text.contains("Check edge cases."));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_turn_before_checkpoint_preserves_guide_and_prompt_while_checkpointed_turn_does_not() {
        let root = tempfile::tempdir().unwrap();
        let host = root.path().join("node-fixture");
        let log = root.path().join("requests.jsonl");
        kybern_protocol::process::write_executable(
            &host,
            r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    with open('requests.jsonl', 'a') as log:
        log.write(json.dumps(request) + '\n')
    op = request['type']
    session = request['session']
    if op == 'open':
        print(json.dumps({'id': request['id'], 'result': {'agentId': 'agent-1'}}), flush=True)
    elif op == 'send':
        msg_id = request['messageId']
        print(json.dumps({'id': request['id'], 'result': {'runId': msg_id}}), flush=True)
        print(json.dumps({'session': session, 'type': 'run_started', 'runId': msg_id}), flush=True)
        if msg_id == 'm1-uncheckpointed' or msg_id == 'm2-uncheckpointed':
            print(json.dumps({'session': session, 'type': 'run_completed', 'runId': msg_id, 'result': {'status': 'cancelled', 'checkpointed': False}}), flush=True)
        elif msg_id == 'm3-checkpointed':
            print(json.dumps({'session': session, 'type': 'run_completed', 'runId': msg_id, 'result': {'status': 'cancelled', 'checkpointed': True}}), flush=True)
        else:
            print(json.dumps({'session': session, 'type': 'run_completed', 'runId': msg_id, 'result': {'status': 'finished', 'checkpointed': True}}), flush=True)
    elif op == 'close':
        print(json.dumps({'id': request['id'], 'result': {}}), flush=True)
        break
"#,
        )
        .unwrap();
        let config = SessionConfig {
            cwd: root.path().into(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::FullAccess,
            native_tool_bridge: Some(NativeToolBridge {
                server_name: "kybern".into(),
                endpoint: Some("http://127.0.0.1/native-tools/mcp".into()),
                authorization: Some("fixture-cap".into()),
                coordinator_instructions: None,
                guide: Some("GUIDE TEXT".into()),
                tools: vec![],
                restrictions: Default::default(),
            }),
            resume_session_id: None,
            resume_lacks_instructions: false,
            fork: false,
            rewind: None,
            binary: None,
            env: std::collections::HashMap::from([
                ("KYBERN_CURSOR_NODE".into(), host.display().to_string()),
                ("KYBERN_CURSOR_SDK_DIR".into(), root.path().display().to_string()),
            ]),
            compaction: Default::default(),
        };
        let mut spawned = CursorDriver.spawn(config).await.unwrap();
        async fn wait_turn(events: &mut tokio::sync::mpsc::Receiver<DriverEvent>) {
            while let Some(event) = events.recv().await {
                if matches!(event, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. }) {
                    return;
                }
            }
            panic!("event stream closed before turn finished");
        }

        // Turn 1: cancelled before checkpoint -> neither guide nor prompt reached history.
        assert_eq!(spawned.session.instructions_delivered(), Some(false));
        spawned.session.send_message("m1-uncheckpointed", &UserMessage::text("First task")).await.unwrap();
        wait_turn(&mut spawned.events).await;
        assert_eq!(spawned.session.instructions_delivered(), Some(false));
        // Turn 2: also cancelled before checkpoint -> carries guide + First task, then keeps both flat (never nested).
        spawned.session.send_message("m2-uncheckpointed", &UserMessage::text("Second task")).await.unwrap();
        wait_turn(&mut spawned.events).await;
        assert_eq!(spawned.session.instructions_delivered(), Some(false));
        // Turn 3: carries guide + flat list of First & Second tasks, then cancels AFTER checkpoint.
        spawned.session.send_message("m3-checkpointed", &UserMessage::text("Refined task")).await.unwrap();
        wait_turn(&mut spawned.events).await;
        assert_eq!(spawned.session.instructions_delivered(), Some(true));
        // Turn 4: since turn 3 checkpointed, neither the guide nor prior prompts should be repeated.
        spawned.session.send_message("m4-normal", &UserMessage::text("Fourth task")).await.unwrap();
        wait_turn(&mut spawned.events).await;
        assert_eq!(spawned.session.instructions_delivered(), Some(true));
        spawned.session.close().await.unwrap();

        let requests: Vec<Value> = std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let sends: Vec<&str> =
            requests.iter().filter(|req| req["type"] == "send").map(|req| req["message"]["text"].as_str().unwrap()).collect();
        assert_eq!(sends.len(), 4);
        assert_eq!(sends[0], with_guide("GUIDE TEXT", "First task"));
        assert_eq!(sends[1], with_guide("GUIDE TEXT", &interrupted_followup(&["First task".into()], "Second task")));
        let third_expected = with_guide("GUIDE TEXT", &interrupted_followup(&["First task".into(), "Second task".into()], "Refined task"));
        assert_eq!(sends[2], third_expected);
        assert_eq!(sends[2].matches("missing from your history").count(), 1, "interrupted wrappers must never nest: {}", sends[2]);
        assert_eq!(sends[3], "Fourth task");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn steer_forwards_text_and_handles_ack_outcomes_and_rejects_images() {
        let root = tempfile::tempdir().unwrap();
        let host = root.path().join("node-fixture");
        let log = root.path().join("requests.jsonl");
        kybern_protocol::process::write_executable(
            &host,
            r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    with open('requests.jsonl', 'a') as log:
        log.write(json.dumps(request) + '\n')
    op = request['type']
    if op == 'open':
        print(json.dumps({'id': request['id'], 'result': {'agentId': 'agent-steer'}}), flush=True)
    elif op == 'steer':
        text = request.get('text', '')
        if 'decline' in text:
            print(json.dumps({'id': request['id'], 'result': {'outcome': 'revert_to_followup'}}), flush=True)
        elif 'interrupted' in text:
            print(json.dumps({'id': request['id'], 'result': {'outcome': 'revert_to_followup', 'interrupted': True}}), flush=True)
        elif 'unknown' in text:
            print(json.dumps({'id': request['id'], 'result': {'outcome': 'future_state'}}), flush=True)
        else:
            print(json.dumps({'id': request['id'], 'result': {'outcome': 'complete_delivered'}}), flush=True)
    elif op == 'close':
        print(json.dumps({'id': request['id'], 'result': {}}), flush=True)
        break
"#,
        )
        .unwrap();
        let config = SessionConfig {
            cwd: root.path().into(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::FullAccess,
            native_tool_bridge: None,
            resume_session_id: None,
            resume_lacks_instructions: false,
            fork: false,
            rewind: None,
            binary: None,
            env: std::collections::HashMap::from([
                ("KYBERN_CURSOR_NODE".into(), host.display().to_string()),
                ("KYBERN_CURSOR_SDK_DIR".into(), root.path().display().to_string()),
            ]),
            compaction: Default::default(),
        };
        let spawned = CursorDriver.spawn(config).await.unwrap();
        spawned.session.steer("s1", &UserMessage::text("Focus on tests")).await.unwrap();
        assert!(matches!(spawned.session.steer("s2", &UserMessage::text("please decline")).await, Err(DriverError::SteerFallback)));
        assert!(matches!(spawned.session.steer("s3", &UserMessage::text("was interrupted")).await, Err(DriverError::SteerFallback)));
        assert!(matches!(spawned.session.steer("s3b", &UserMessage::text("unknown outcome")).await, Err(DriverError::SteerFallback)));
        let with_image = UserMessage {
            parts: vec![
                ContentPart::Text { text: "look".into() },
                ContentPart::Image { media_type: "image/png".into(), data: "abc".into() },
            ],
        };
        assert!(matches!(spawned.session.steer("s4", &with_image).await, Err(DriverError::Unsupported(_))));
        spawned.session.close().await.unwrap();

        let requests: Vec<Value> = std::fs::read_to_string(log).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let steers: Vec<&str> = requests.iter().filter(|req| req["type"] == "steer").map(|req| req["text"].as_str().unwrap()).collect();
        assert_eq!(steers, vec!["Focus on tests", "please decline", "was interrupted", "unknown outcome"]);
    }
}

#[cfg(test)]
mod orchestration_part_tests {
    use super::*;
    use crate::test_support::*;

    #[test]
    fn thread_messages_and_agent_results_flatten_into_the_sdk_text() {
        assert_flattened(sdk_message(&orchestration_message())["text"].as_str().unwrap());
    }
}
