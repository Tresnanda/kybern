use super::*;

async fn connect(context: &ProbeContext) -> Result<ReadRpc> {
    let mut cmd = command(ProviderKind::Codex, context)?;
    cmd.arg("app-server");
    let mut rpc = ReadRpc::spawn(cmd)?;
    rpc.call(
        "initialize",
        json!({"clientInfo":{"name":"kybern","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),
    )
    .await?;
    rpc.child.write(&json!({"method":"initialized"})).await?;
    Ok(rpc)
}

fn summary(thread: &Value) -> Option<SavedSession> {
    if thread["parentThreadId"].is_string() || thread["ephemeral"] == true {
        return None;
    }
    Some(SavedSession {
        provider: ProviderKind::Codex,
        id: thread["id"].as_str()?.into(),
        title: title(
            thread["name"].as_str().filter(|s| !s.is_empty()).or_else(|| thread["preview"].as_str()).unwrap_or("Untitled session"),
        ),
        cwd: thread["cwd"].as_str()?.into(),
        updated_at: timestamp(&thread["updatedAt"]).unwrap_or_else(Utc::now),
        model: thread["model"].as_str().map(str::to_string),
        thread_id: None,
    })
}

pub(super) async fn list(context: &ProbeContext, cursor: Option<&str>, query: &str) -> Result<SessionsListResult> {
    let mut rpc = connect(context).await?;
    let mut cursor = cursor.map(str::to_string);
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let mut params =
            json!({"limit":PAGE_SIZE,"cursor":cursor,"sortKey":"updated_at","sourceKinds":["cli","vscode","exec","appServer","unknown"]});
        if let Some(cwd) = &context.cwd {
            params["cwd"] = json!(cwd);
        }
        let (value, _) = rpc.call("thread/list", params).await?;
        sessions.extend(value["data"].as_array().into_iter().flatten().filter_map(summary).filter(|s| matches_query(s, query)));
        cursor = value["nextCursor"].as_str().map(str::to_string);
        if sessions.len() >= PAGE_SIZE || cursor.is_none() {
            break;
        }
        if !seen.insert(cursor.clone()) {
            return Err(DriverError::Protocol("Codex repeated a session page. Refresh and try again.".into()));
        }
    }
    Ok(SessionsListResult { sessions, next_cursor: cursor })
}

pub(super) async fn read(context: &ProbeContext, id: &str) -> Result<SessionHistory> {
    let mut rpc = connect(context).await?;
    let (value, _) = rpc.call("thread/read", json!({"threadId":id,"includeTurns":false})).await?;
    let session = summary(&value["thread"]).ok_or_else(|| DriverError::Protocol("Choose a top-level saved Codex conversation.".into()))?;
    let mut history = History::default();
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    let mut bytes = 0;
    loop {
        let (page, _) = rpc
            .call("thread/turns/list", json!({"threadId":id,"limit":50,"cursor":cursor,"sortDirection":"asc","itemsView":"full"}))
            .await?;
        bytes += page.to_string().len() as u64;
        if bytes > MAX_HISTORY_BYTES {
            return Err(DriverError::Unsupported(
                "Session history exceeds the 64 MB import limit. Fork a shorter conversation and try again.".into(),
            ));
        }
        for turn in page["data"].as_array().into_iter().flatten() {
            parse_turn(&mut history, &session, turn);
        }
        cursor = page["nextCursor"].as_str().map(str::to_string);
        match cursor.as_ref() {
            Some(cursor) if seen.insert(cursor.clone()) => {}
            Some(_) => return Err(DriverError::Protocol("Codex repeated a history page. Update Codex and try again.".into())),
            None => break,
        }
    }
    Ok(history.finish(session))
}

pub(super) fn parse_turn(history: &mut History, session: &SavedSession, turn: &Value) {
    let at = timestamp(&turn["startedAt"]).unwrap_or(session.updated_at);
    for item in turn["items"].as_array().into_iter().flatten() {
        let id = item["id"].as_str().unwrap_or("imported-tool");
        match item["type"].as_str().unwrap_or("") {
            "userMessage" => history.user(at, user_content(&item["content"])),
            "agentMessage" => history.assistant(at, item["text"].as_str().unwrap_or("").into(), None),
            "reasoning" => {
                let text = item["summary"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("\n");
                history.assistant(at, String::new(), Some(text));
            }
            "commandExecution" => {
                history.tool(at, id, "shell", json!({"command":item["command"],"cwd":item["cwd"]}));
                if item["status"] != "inProgress" {
                    history.result(
                        at,
                        id,
                        item["aggregatedOutput"].clone(),
                        item["status"] == "failed" || item["exitCode"].as_i64().is_some_and(|c| c != 0),
                    );
                }
            }
            "fileChange" => {
                history.tool(at, id, "apply_patch", json!({"changes":item["changes"]}));
                if item["status"] != "inProgress" {
                    history.result(at, id, item["changes"].clone(), item["status"] == "failed" || item["status"] == "declined");
                }
            }
            "mcpToolCall" | "dynamicToolCall" => {
                let name = item["tool"].as_str().unwrap_or("tool");
                history.tool(at, id, name, item["arguments"].clone());
                if item["status"] != "inProgress" {
                    history.result(
                        at,
                        id,
                        item.get("result").or_else(|| item.get("contentItems")).cloned().unwrap_or(Value::Null),
                        item["status"] == "failed" || item["success"] == false,
                    );
                }
            }
            "webSearch" => {
                history.tool(at, id, "web_search", json!({"query":item["query"]}));
                history.result(at, id, item["action"].clone(), false);
            }
            "contextCompaction" => history.notice(at, "Conversation compacted in Codex.".into()),
            "plan" => history.assistant(at, item["text"].as_str().unwrap_or("").into(), None),
            _ => {}
        }
    }
    history.end(match turn["status"].as_str().unwrap_or("") {
        "failed" => StopReason::Error,
        "interrupted" | "inProgress" => StopReason::Interrupted,
        _ => StopReason::Completed,
    });
}
