//! What goes over the wire: a user message as ACP blocks (with Kybern's guide once), Kybern's MCP
//! server, and the generic names for tools and commands.

use agent_client_protocol::schema::v1::{
    AvailableCommandsUpdate, ContentBlock, HttpHeader, ImageContent, McpServer, McpServerHttp, PermissionOption, TextContent, ToolKind,
};
use kybern_protocol::{ContentPart, ProviderCommand, UserMessage, thread_reference_text};
use serde_json::{Value, json};

use crate::{DriverError, DriverEvent, NativeToolBridge, Result};

/// A user message as ACP blocks, one per part: text parts as text (a skill as its `/name` command, a
/// mention as `@name`), an image as an image block.
pub(crate) fn prompt_blocks(message: &UserMessage) -> Vec<ContentBlock> {
    let text = |text: String| ContentBlock::Text(TextContent::new(text));
    let mut out = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text: t } => out.push(text(t.clone())),
            ContentPart::FileMention { path } => out.push(text(format!("@{path}"))),
            ContentPart::ThreadReference { thread_id, title, .. } => out.push(text(thread_reference_text(*thread_id, title))),
            ContentPart::Skill { name, .. } => out.push(text(format!("/{name}"))),
            ContentPart::Mention { name, .. } => out.push(text(format!("@{name}"))),
            ContentPart::Image { media_type, data } => out.push(ContentBlock::Image(ImageContent::new(data.clone(), media_type.clone()))),
            ContentPart::Attachment { name, .. } => out.push(text(format!("[attached file: {name}]"))),
            ContentPart::Media { .. } => out.push(text("[image]".to_string())),
            ContentPart::ThreadMessage { .. } | ContentPart::AgentResults { .. } | ContentPart::SystemRow { .. } => {
                if let Some(flat) = part.orchestration_text() {
                    out.push(text(flat));
                }
            }
        }
    }
    out
}

/// `blocks` with each run of text blocks joined into one, and empty text dropped; images stay their own blocks.
pub(crate) fn merge_text_blocks(blocks: Vec<ContentBlock>) -> Vec<ContentBlock> {
    let mut out = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<ContentBlock>| {
        if !text.is_empty() {
            out.push(ContentBlock::Text(TextContent::new(std::mem::take(text))));
        }
    };
    for block in blocks {
        match block {
            ContentBlock::Text(t) => text.push_str(&t.text),
            other => {
                flush(&mut text, &mut out);
                out.push(other);
            }
        }
    }
    flush(&mut text, &mut out);
    out
}

/// The prompt as the agent receives it: the guide once, in front of the first ordinary request.
/// A slash command stays at the start of its prompt; the guide waits for the next ordinary one.
/// Returns the text to send and the guide it carries, if any.
pub(crate) fn prompt_with_guide(guide: &mut Option<String>, text: String) -> (String, Option<String>) {
    if text.trim_start().starts_with('/') {
        return (text, None);
    }
    match guide.take() {
        Some(guide) => (crate::cursor::with_guide(&guide, &text), Some(guide)),
        None => (text, None),
    }
}

/// Put the guide in front of the prompt's first text (or before an image-only prompt). Returns the guide it carries.
pub(crate) fn blocks_with_guide(guide: &mut Option<String>, mut blocks: Vec<ContentBlock>) -> (Vec<ContentBlock>, Option<String>) {
    match blocks.first_mut() {
        Some(ContentBlock::Text(first)) => {
            let (text, carried) = prompt_with_guide(guide, std::mem::take(&mut first.text));
            first.text = text;
            (blocks, carried)
        }
        _ => match guide.take() {
            Some(text) => {
                blocks.insert(0, ContentBlock::Text(TextContent::new(crate::cursor::with_guide(&text, ""))));
                (blocks, Some(text))
            }
            None => (blocks, None),
        },
    }
}

/// Kybern's MCP tools as an HTTP server the agent connects to (`name` in the refusals). Refused when the
/// coordinator's tool restrictions must be enforced, which an ACP agent can't be made to do.
pub(crate) fn mcp_servers(name: &str, bridge: Option<&NativeToolBridge>) -> Result<Vec<McpServer>> {
    let Some(bridge) = bridge else { return Ok(Vec::new()) };
    bridge.validate()?;
    if bridge.restrictions.require_enforcement {
        return Err(DriverError::Unsupported(format!(
            "{name} ACP can attach Kybern MCP tools but cannot enforce coordinator tool restrictions at the native boundary"
        )));
    }
    let endpoint =
        bridge.endpoint.as_deref().ok_or_else(|| DriverError::Unsupported(format!("{name} Kybern tools require a daemon MCP endpoint")))?;
    let authorization = bridge
        .authorization
        .as_deref()
        .ok_or_else(|| DriverError::Unsupported(format!("{name} Kybern tools require a scoped MCP authorization capability")))?;
    Ok(vec![McpServer::Http(
        McpServerHttp::new(bridge.server_name.clone(), endpoint.to_string())
            .headers(vec![HttpHeader::new("Authorization", format!("Bearer {authorization}"))]),
    )])
}

/// A tool's name from ACP alone: its kind (when it says something), else the call's title.
pub(crate) fn tool_name(kind: &ToolKind, title: &str) -> String {
    let kind = serde_json::to_value(kind).ok().and_then(|kind| kind.as_str().map(str::to_string));
    if let Some(kind) = kind.filter(|kind| kind != "other") {
        return kind;
    }
    let title = title.trim();
    if title.is_empty() { "other".into() } else { title.to_string() }
}

/// A permission request's options as a card shows them, with ACP's own kind names (`allow_once`).
pub(crate) fn option_list(options: &[PermissionOption]) -> Vec<Value> {
    options
        .iter()
        .map(|o| json!({ "id": o.option_id.to_string(), "name": o.name, "kind": serde_json::to_value(o.kind).unwrap_or(Value::Null) }))
        .collect()
}

pub(crate) fn command_update(update: AvailableCommandsUpdate) -> DriverEvent {
    DriverEvent::CommandsUpdated(
        update
            .available_commands
            .into_iter()
            .map(|c| ProviderCommand { name: c.name, description: c.description, ..Default::default() })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NativeToolRestrictions;

    #[test]
    fn merged_blocks_are_one_text_per_run_and_images_between() {
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "a".into() },
                ContentPart::Text { text: String::new() },
                ContentPart::Skill { name: "s".into(), path: "/s".into() },
                ContentPart::Image { media_type: "image/png".into(), data: "x".into() },
                ContentPart::Text { text: String::new() },
            ],
        };
        let per_part = prompt_blocks(&message);
        assert_eq!(per_part.len(), 5);
        let merged = merge_text_blocks(per_part);
        let [ContentBlock::Text(text), ContentBlock::Image(_)] = merged.as_slice() else { panic!("{merged:?}") };
        assert_eq!(text.text, "a/s");
    }

    // Moved from the Cursor ACP driver: every flavor builds its MCP server here.
    #[test]
    fn builds_scoped_http_mcp_server_for_acp() {
        let bridge = NativeToolBridge {
            server_name: "kybern".into(),
            endpoint: Some("http://127.0.0.1:4199/native-tools/mcp".into()),
            authorization: Some("session-capability".into()),
            coordinator_instructions: None,
            guide: None,
            tools: vec![],
            restrictions: Default::default(),
        };
        let servers = mcp_servers("Cursor", Some(&bridge)).unwrap();
        let [McpServer::Http(server)] = servers.as_slice() else { panic!("expected one HTTP MCP server") };
        assert_eq!(server.name, "kybern");
        assert_eq!(server.url, "http://127.0.0.1:4199/native-tools/mcp");
        assert_eq!(server.headers[0].name, "Authorization");
        assert_eq!(server.headers[0].value, "Bearer session-capability");
    }

    #[test]
    fn rejects_required_coordinator_restrictions() {
        let bridge = NativeToolBridge {
            server_name: "kybern".into(),
            endpoint: Some("http://127.0.0.1:4199/native-tools/mcp".into()),
            authorization: Some("session-capability".into()),
            coordinator_instructions: None,
            guide: None,
            tools: vec![],
            restrictions: NativeToolRestrictions { require_enforcement: true, ..Default::default() },
        };
        assert!(
            matches!(mcp_servers("Cursor", Some(&bridge)), Err(DriverError::Unsupported(message)) if message.contains("cannot enforce"))
        );
    }

    #[test]
    fn acp_command_update_reaches_the_composer() {
        let update = serde_json::from_value(json!({"availableCommands":[{"name":"review","description":"Review changes"}]})).unwrap();
        let DriverEvent::CommandsUpdated(commands) = command_update(update) else { panic!("wrong event") };
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].description, "Review changes");
    }
}
