//! Cursor's official local SDK, isolated in a Node helper owned by the session.
//!
//! New session IDs are namespaced so existing ACP sessions continue to resume
//! with the CLI that created them. We never reinterpret a CLI conversation as
//! an SDK agent or silently replace a missing conversation with an empty one.
mod acp;
mod runtime;
mod stream;
pub mod usage;

pub(crate) use runtime::Connection;
pub use runtime::{
    SDK_VERSION, auth_status, install, installed, login_command, node_version, npm_available, setup_command, setup_error, sign_out,
};

use std::path::PathBuf;

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

fn mcp_servers(bridge: Option<&NativeToolBridge>) -> Result<Value> {
    let Some(bridge) = bridge else { return Ok(json!({})) };
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
    Ok(
        json!({bridge.server_name.clone(): {"type": "http", "url": endpoint, "headers": {"Authorization": format!("Bearer {authorization}")}}}),
    )
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
                    for effort in &model.efforts {
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

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        if config.resume_session_id.as_ref().is_some_and(|id| !id.starts_with(SDK_SESSION_PREFIX)) {
            return acp::CursorAcpDriver.spawn(config).await;
        }
        if config.fork || config.rewind.is_some() {
            return Err(DriverError::Unsupported("Cursor SDK does not expose native conversation forks or rollback".into()));
        }
        validate_mode(config.permission_mode)?;
        let servers = mcp_servers(config.native_tool_bridge.as_ref())?;
        let context = ProbeContext { binary: config.binary.clone(), cwd: Some(config.cwd.clone()), env: config.env.into_iter().collect() };
        let (connection, events) = Connection::spawn(&context)?;
        let agent_id = config.resume_session_id.as_deref().map(sdk_id).transpose()?;
        let opened = connection
            .call(
                "open",
                json!({
                    "cwd": config.cwd, "model": config.model, "effort": config.effort, "mode": config.permission_mode,
                    "agentId": agent_id, "mcpServers": servers,
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
            }]))
            .await;
        // The SDK has no system channel. Refresh the current guide on this
        // runner's first ordinary prompt, including resumed conversations whose
        // saved history may contain an older guide or none at all.
        let guide = config.native_tool_bridge.as_ref().and_then(|bridge| bridge.guide());
        Ok(SpawnedSession {
            session: Box::new(Session { connection, model: Mutex::new(config.model), guide: Mutex::new(guide.map(str::to_owned)) }),
            events,
        })
    }
}

struct Session {
    connection: Connection,
    model: Mutex<Option<String>>,
    /// Kybern's guide, until the first prompt that can carry it is sent.
    guide: Mutex<Option<String>>,
}

const GUIDE_OPEN: &str = "<kybern_instructions>";
const GUIDE_CLOSE: &str = "</kybern_instructions>";

/// The provider's copy of the first prompt: the guide in a tagged block, then the user's request.
fn with_guide(guide: &str, text: &str) -> String {
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
        // Slash commands (skills, /compress) must stay at the start of the prompt;
        // the guide waits for the next ordinary one.
        let guide = if text.trim_start().starts_with('/') { None } else { self.guide.lock().await.take() };
        if let Some(guide) = &guide {
            payload["text"] = Value::String(with_guide(guide, &text));
        }
        match self.connection.call("send", json!({"messageId": message_id, "message": payload})).await {
            Ok(_) => Ok(()),
            Err(error) => {
                // The agent never saw it; offer it again with the retry.
                if guide.is_some() {
                    *self.guide.lock().await = guide;
                }
                Err(error)
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
}

fn sdk_message(message: &UserMessage) -> Value {
    let mut text = String::new();
    let mut images = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text: part } => text.push_str(part),
            ContentPart::FileMention { path } => text.push_str(&format!("@{path}")),
            ContentPart::ThreadReference { thread_id, title, .. } => text.push_str(&thread_reference_text(*thread_id, title)),
            ContentPart::Skill { name, .. } => text.push_str(&format!("/{name}")),
            ContentPart::Mention { name, .. } => text.push_str(&format!("@{name}")),
            ContentPart::Image { media_type, data } => images.push(json!({"data": data, "mimeType": media_type})),
            ContentPart::Attachment { name, .. } => text.push_str(&format!("[attached file: {name}]")),
            ContentPart::ThreadMessage { .. } | ContentPart::AgentResults { .. } => {
                if let Some(flat) = part.orchestration_text() {
                    text.push_str(&flat);
                }
            }
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
    async fn fresh_and_resumed_runners_send_the_current_guide_once_and_retry_it_after_rejection() {
        use std::os::unix::fs::PermissionsExt;

        for (resume, enabled) in [(None, true), (Some("cursor-sdk:restored"), true), (Some("cursor-sdk:restored"), false)] {
            let root = tempfile::tempdir().unwrap();
            let host = root.path().join("node-fixture");
            let log = root.path().join("requests.jsonl");
            std::fs::write(
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
            std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o755)).unwrap();
            let config = SessionConfig {
                cwd: root.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::FullAccess,
                native_tool_bridge: Some(NativeToolBridge {
                    server_name: "kybern".into(),
                    endpoint: Some("http://127.0.0.1/native-tools/mcp".into()),
                    authorization: Some("fixture-session-capability".into()),
                    coordinator_instructions: None,
                    guide: enabled.then(|| "CURRENT GUIDE: use kybern_html_preview when helpful".into()),
                    tools: vec![],
                    restrictions: Default::default(),
                }),
                resume_session_id: resume.map(str::to_owned),
                fork: false,
                rewind: None,
                binary: None,
                env: std::collections::HashMap::from([
                    ("KYBERN_CURSOR_NODE".into(), host.display().to_string()),
                    ("KYBERN_CURSOR_SDK_DIR".into(), root.path().display().to_string()),
                ]),
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
            let expected = if enabled {
                with_guide("CURRENT GUIDE: use kybern_html_preview when helpful", "Explain the results")
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
