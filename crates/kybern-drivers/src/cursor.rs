//! Cursor's official local SDK, isolated in a Node helper owned by the session.
//!
//! New session IDs are namespaced so existing ACP sessions continue to resume
//! with the CLI that created them. We never reinterpret a CLI conversation as
//! an SDK agent or silently replace a missing conversation with an empty one.
mod acp;
mod runtime;
mod stream;

pub(crate) use runtime::Connection;
pub use runtime::{SDK_VERSION, install, setup_command};

use std::path::PathBuf;

use async_trait::async_trait;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, NativeToolBridge, ProbeContext, Result, SessionConfig, SpawnedSession};

pub const SDK_SESSION_PREFIX: &str = "cursor-sdk:";
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
            supports_effort_switch: false,
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
            }
            Err(error) => status.unavailable_reason = Some(error.to_string()),
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
        if config.effort.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err(DriverError::Unsupported("Choose a Cursor model variant; the SDK has no independent effort control".into()));
        }
        let servers = mcp_servers(config.native_tool_bridge.as_ref())?;
        let context = ProbeContext { binary: config.binary.clone(), cwd: Some(config.cwd.clone()), env: config.env.into_iter().collect() };
        let (connection, events) = Connection::spawn(&context)?;
        let agent_id = config.resume_session_id.as_deref().map(sdk_id).transpose()?;
        let opened = connection
            .call(
                "open",
                json!({
                    "cwd": config.cwd, "model": config.model, "mode": config.permission_mode,
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
        Ok(SpawnedSession { session: Box::new(Session { connection, model: Mutex::new(config.model) }), events })
    }
}

struct Session {
    connection: Connection,
    model: Mutex<Option<String>>,
}

#[async_trait]
impl AgentSession for Session {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()> {
        self.connection.call("send", json!({"messageId": message_id, "message": sdk_message(message)})).await?;
        Ok(())
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
    async fn set_effort(&self, _: &str) -> Result<()> {
        Err(DriverError::Unsupported("Choose a Cursor model variant; the SDK has no independent effort control".into()))
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
