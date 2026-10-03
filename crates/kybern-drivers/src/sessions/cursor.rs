use super::*;
use crate::cursor::{Connection, SDK_SESSION_PREFIX, sdk_id};

#[cfg(test)]
pub(super) use super::cursor_acp::parse;

fn summary(value: &Value) -> Option<SavedSession> {
    let id = value["agentId"].as_str()?;
    if id.starts_with("bc-") {
        return None;
    }
    Some(SavedSession {
        provider: ProviderKind::Cursor,
        id: format!("{SDK_SESSION_PREFIX}{id}"),
        title: title(
            value["summary"].as_str().filter(|s| !s.is_empty()).or_else(|| value["name"].as_str()).unwrap_or("Untitled Cursor agent"),
        ),
        cwd: value["cwd"].as_str().unwrap_or("").to_string(),
        updated_at: timestamp(&value["lastModified"]).unwrap_or_else(Utc::now),
        model: None,
        thread_id: None,
    })
}

pub(super) async fn list(context: &ProbeContext, cursor: Option<&str>, query: &str) -> Result<SessionsListResult> {
    if let Some(cursor) = cursor.and_then(|s| s.strip_prefix("acp:")) {
        let mut result = super::cursor_acp::list(context, (!cursor.is_empty()).then_some(cursor), query).await?;
        result.next_cursor = result.next_cursor.map(|s| format!("acp:{s}"));
        return Ok(result);
    }
    let (connection, _events) = Connection::spawn(context)?;
    let mut cursor = match cursor {
        Some(value) => Some(
            value
                .strip_prefix("sdk:")
                .ok_or_else(|| DriverError::Protocol("Refresh the Cursor session list before continuing.".into()))?
                .to_string(),
        ),
        None => None,
    };
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let value = connection.call("list", json!({"cwd":context.cwd, "cursor":cursor})).await?;
        sessions.extend(
            value["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(summary)
                .filter(|s| matches_query(s, query) && matches_cwd(s, context)),
        );
        cursor = value["nextCursor"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        if sessions.len() >= PAGE_SIZE || cursor.is_none() {
            break;
        }
        if !seen.insert(cursor.clone()) {
            return Err(DriverError::Protocol("Cursor SDK repeated a session page. Refresh and try again.".into()));
        }
    }
    connection.close().await?;
    let legacy_available = crate::binary::resolve(ProviderKind::Cursor, context.binary.as_ref()).is_ok();
    Ok(SessionsListResult { sessions, next_cursor: cursor.map(|s| format!("sdk:{s}")).or_else(|| legacy_available.then(|| "acp:".into())) })
}

pub(super) async fn read(context: &ProbeContext, id: &str) -> Result<SessionHistory> {
    if !id.starts_with(SDK_SESSION_PREFIX) {
        return super::cursor_acp::read(context, id).await;
    }
    let (connection, _events) = Connection::spawn(context)?;
    let value = connection.call("read", json!({"agentId":sdk_id(id)?, "cwd":context.cwd})).await?;
    connection.close().await?;
    let session = summary(&value["info"]).ok_or_else(|| DriverError::Protocol("Cursor SDK returned an invalid saved agent".into()))?;
    if session.id != id || !matches_cwd(&session, context) {
        return Err(DriverError::Protocol("This Cursor agent does not belong to the selected workspace.".into()));
    }
    parse_sdk(session, &value["messages"])
}

fn parse_sdk(session: SavedSession, messages: &Value) -> Result<SessionHistory> {
    let mut history = History::default();
    let at = session.updated_at;
    for item in messages.as_array().into_iter().flatten() {
        let message = &item["message"];
        // Agent.messages.list returns protobuf conversation turns. A single
        // item can contain both the user prompt and all assistant steps.
        let turn = message.get("agentConversationTurn").or_else(|| {
            (message.pointer("/turn/case").and_then(Value::as_str) == Some("agentConversationTurn")).then(|| &message["turn"]["value"])
        });
        if let Some(turn) = turn {
            if let Some(user) = turn.get("userMessage") {
                history.user(at, UserMessage::text(user["text"].as_str().unwrap_or("")));
            }
            for (index, raw) in turn["steps"].as_array().into_iter().flatten().enumerate() {
                let step = raw.get("step").unwrap_or(raw);
                if let Some(text) = step
                    .pointer("/assistantMessage/text")
                    .and_then(Value::as_str)
                    .or_else(|| (step["case"] == "assistantMessage").then(|| step.pointer("/value/text").and_then(Value::as_str)).flatten())
                {
                    history.assistant(at, text.into(), None);
                } else if let Some(text) = step
                    .pointer("/thinkingMessage/text")
                    .and_then(Value::as_str)
                    .or_else(|| (step["case"] == "thinkingMessage").then(|| step.pointer("/value/text").and_then(Value::as_str)).flatten())
                {
                    history.assistant(at, String::new(), Some(text.into()));
                } else if let Some(call) = step.get("toolCall").or_else(|| (step["case"] == "toolCall").then(|| &step["value"])) {
                    let fallback = format!("{}:{index}", item["uuid"].as_str().unwrap_or("saved"));
                    let id = call["toolCallId"].as_str().unwrap_or(&fallback);
                    let wrapped = call.as_object().and_then(|o| o.iter().find(|(key, _)| key.ends_with("ToolCall")));
                    if let Some((name, body)) = wrapped {
                        history.tool(at, id, name.trim_end_matches("ToolCall"), body["args"].clone());
                        let result = &body["result"];
                        if !result.is_null() {
                            history.result(at, id, result.clone(), result.get("success").is_none());
                        }
                    }
                }
            }
            continue;
        }
        let content = message.get("content").unwrap_or(message);
        if !message.is_string() && message.get("text").is_none() && message.get("content").is_none() {
            return Err(DriverError::Protocol(
                "Cursor returned an unsupported saved conversation format. Resume this conversation from its existing Kybern thread."
                    .into(),
            ));
        }
        if item["type"] == "user" {
            if let Some(text) = message["text"].as_str() {
                history.user(at, UserMessage::text(text));
            } else {
                history.user(at, user_content(content));
            }
        } else if item["type"] == "assistant" {
            if let Some(text) = message["text"].as_str().or_else(|| content.as_str()) {
                history.assistant(at, text.to_string(), None);
            } else {
                for block in content.as_array().into_iter().flatten() {
                    match block["type"].as_str().unwrap_or("") {
                        "text" => history.assistant(at, block["text"].as_str().unwrap_or("").to_string(), None),
                        "thinking" => history.assistant(
                            at,
                            String::new(),
                            block["thinking"].as_str().or_else(|| block["text"].as_str()).map(str::to_string),
                        ),
                        "tool_use" => {
                            if let Some(id) = block["id"].as_str() {
                                history.tool(at, id, block["name"].as_str().unwrap_or("tool"), block["input"].clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        // SDK transcript tool results may be carried in a user message. They
        // close the original tool rather than becoming a new user prompt.
        for block in content.as_array().into_iter().flatten() {
            if block["type"] == "tool_result"
                && let Some(id) = block["tool_use_id"].as_str()
            {
                history.result(at, id, block["content"].clone(), block["is_error"].as_bool().unwrap_or(false));
            }
        }
    }
    Ok(history.finish(session))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_sdk_messages_without_running_a_turn() {
        let session = summary(&json!({"agentId":"a1", "summary":"Review", "cwd":"/repo", "lastModified":1790990400000_i64})).unwrap();
        let history = parse_sdk(session, &json!([
            {"type":"user","message":{"content":[{"type":"text","text":"Check the file"}]}},
            {"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Inspect first"},{"type":"text","text":"All **good**."}]}}
        ])).unwrap();
        assert_eq!(history.session.id, "cursor-sdk:a1");
        assert!(
            history
                .events
                .iter()
                .any(|e| matches!(&e.payload, EventPayload::AssistantMessageCompleted { text, .. } if text == "All **good**."))
        );
    }

    #[test]
    fn imports_sdk_checkpoint_turns_with_user_assistant_and_tool_steps() {
        let session = summary(&json!({"agentId":"a1", "cwd":"/repo"})).unwrap();
        let history = parse_sdk(
            session,
            &json!([{"type":"user", "uuid":"a1:0", "message":{
                "agentConversationTurn": {"userMessage":{"text":"Read it"},"steps":[
                    {"thinkingMessage":{"text":"Checking"}},
                    {"toolCall":{"toolCallId":"t1","readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"hello"}}}}},
                    {"assistantMessage":{"text":"It says **hello**."}}
                ]}
            }}]),
        )
        .unwrap();
        assert!(
            history
                .events
                .iter()
                .any(|e| matches!(&e.payload, EventPayload::AssistantMessageCompleted { text, .. } if text == "It says **hello**."))
        );
        assert!(history.events.iter().any(|e| matches!(&e.payload, EventPayload::ToolCallCompleted { is_error: false, .. })));
    }
}
