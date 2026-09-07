use super::*;

async fn connect(context: &ProbeContext) -> Result<ReadRpc> {
    let mut cmd = command(ProviderKind::Cursor, context)?;
    cmd.arg("acp");
    let mut rpc = ReadRpc::spawn(cmd)?;
    let (init, _) = rpc
        .call(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"kybern","version":env!("CARGO_PKG_VERSION")}}),
        )
        .await?;
    if init.pointer("/agentCapabilities/sessionCapabilities/list").is_none() {
        return Err(DriverError::Unsupported("This Cursor CLI cannot list saved sessions. Update Cursor CLI and try again.".into()));
    }
    Ok(rpc)
}

fn summary(value: &Value) -> Option<SavedSession> {
    Some(SavedSession {
        provider: ProviderKind::Cursor,
        id: value["sessionId"].as_str()?.into(),
        title: title(value["title"].as_str().unwrap_or("Untitled session")),
        cwd: value["cwd"].as_str()?.into(),
        updated_at: timestamp(&value["updatedAt"]).unwrap_or_else(Utc::now),
        model: None,
        thread_id: None,
    })
}

async fn page(rpc: &mut ReadRpc, context: &ProbeContext, cursor: Option<&str>) -> Result<SessionsListResult> {
    let mut params = json!({"cursor":cursor});
    if let Some(cwd) = &context.cwd {
        params["cwd"] = json!(cwd);
    }
    let (value, _) = rpc.call("session/list", params).await?;
    Ok(SessionsListResult {
        sessions: value["sessions"].as_array().into_iter().flatten().filter_map(summary).collect(),
        next_cursor: value["nextCursor"].as_str().map(str::to_string),
    })
}

pub(super) async fn list(context: &ProbeContext, cursor: Option<&str>, query: &str) -> Result<SessionsListResult> {
    let mut rpc = connect(context).await?;
    let mut cursor = cursor.map(str::to_string);
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let result = page(&mut rpc, context, cursor.as_deref()).await?;
        sessions.extend(result.sessions.into_iter().filter(|s| matches_query(s, query)));
        cursor = result.next_cursor;
        if sessions.len() >= PAGE_SIZE || cursor.is_none() {
            break;
        }
        if !seen.insert(cursor.clone()) {
            return Err(DriverError::Protocol("Cursor repeated a session page. Refresh and try again.".into()));
        }
    }
    Ok(SessionsListResult { sessions, next_cursor: cursor })
}

pub(super) async fn read(context: &ProbeContext, id: &str) -> Result<SessionHistory> {
    let mut rpc = connect(context).await?;
    let mut cursor = None;
    let mut seen = HashSet::new();
    let session = loop {
        let result = page(&mut rpc, context, cursor.as_deref()).await?;
        if let Some(session) = result.sessions.into_iter().find(|s| s.id == id) {
            break session;
        }
        cursor = result.next_cursor;
        if cursor.as_ref().is_none_or(|cursor| !seen.insert(cursor.clone())) {
            return Err(DriverError::Protocol("Cursor chat was not found. Refresh the session list and try again.".into()));
        }
    };
    rpc.call("authenticate", json!({"methodId":"cursor_login"})).await?;
    let (_, updates) = rpc.call("session/load", json!({"sessionId":id,"cwd":session.cwd,"mcpServers":[]})).await?;
    Ok(parse(session, updates))
}

pub(super) fn parse(session: SavedSession, updates: Vec<Value>) -> SessionHistory {
    let mut history = History::default();
    let mut role = "";
    let mut text = String::new();
    let at = session.updated_at;
    let flush = |history: &mut History, role: &str, text: &mut String| {
        if text.is_empty() {
            return;
        }
        let text = std::mem::take(text);
        match role {
            "user_message_chunk" => history.user(at, UserMessage::text(text)),
            "agent_thought_chunk" => history.assistant(at, String::new(), Some(text)),
            _ => history.assistant(at, text, None),
        }
    };
    for notification in &updates {
        let update = &notification["params"]["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        if matches!(kind, "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk") {
            if role != kind {
                flush(&mut history, role, &mut text);
            }
            role = kind;
            if let Some(chunk) = update["content"]["text"].as_str() {
                text.push_str(chunk);
            }
            if update["content"]["type"] == "image" {
                text.push_str("\n[Image from the original Cursor session]\n");
            }
        } else if kind == "tool_call" || kind == "tool_call_update" {
            flush(&mut history, role, &mut text);
            role = "";
            if let Some(id) = update["toolCallId"].as_str() {
                if kind == "tool_call" {
                    history.tool(at, id, update["title"].as_str().unwrap_or("tool"), update["rawInput"].clone());
                }
                if update["status"] == "completed" || update["status"] == "failed" {
                    history.result(
                        at,
                        id,
                        update.get("rawOutput").or_else(|| update.get("content")).cloned().unwrap_or(Value::Null),
                        update["status"] == "failed",
                    );
                }
            }
        }
    }
    flush(&mut history, role, &mut text);
    history.finish(session)
}
