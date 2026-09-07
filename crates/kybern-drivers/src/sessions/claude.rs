use super::*;

fn root(context: &ProbeContext) -> Result<PathBuf> {
    Ok(env(context, "CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or(home(context)?.join(".claude")).join("projects"))
}

fn summary(path: &Path, records: &[Value]) -> Option<SavedSession> {
    let first = records.iter().find(|v| v["cwd"].is_string() && v["sessionId"].is_string() && v["isSidechain"] != true)?;
    let name = records
        .iter()
        .rev()
        .find_map(|v| v["customTitle"].as_str())
        .or_else(|| records.iter().rev().find_map(|v| v["aiTitle"].as_str()))
        .map(str::to_string)
        .or_else(|| records.iter().find(|v| v["type"] == "user" && v["isMeta"] != true).map(|v| content_text(&v["message"]["content"])))
        .unwrap_or_else(|| "Untitled session".into());
    Some(SavedSession {
        provider: ProviderKind::ClaudeCode,
        id: first["sessionId"].as_str()?.into(),
        title: title(&name),
        cwd: first["cwd"].as_str()?.into(),
        updated_at: path.metadata().and_then(|m| m.modified()).ok().map(DateTime::<Utc>::from).unwrap_or_else(Utc::now),
        model: records
            .iter()
            .rev()
            .find_map(|v| v.pointer("/message/model").and_then(Value::as_str))
            .filter(|m| *m != "<synthetic>")
            .map(str::to_string),
        thread_id: None,
    })
}

pub(super) async fn list(context: &ProbeContext, cursor: Option<&str>, query: &str) -> Result<SessionsListResult> {
    let root = root(context)?;
    let context = context.clone();
    let start = offset(cursor)?;
    let query = query.to_string();
    tokio::task::spawn_blocking(move || {
        let files = jsonl_files(&root)?;
        let mut sessions = Vec::new();
        let mut next_cursor = None;
        for (index, path) in files.iter().enumerate().skip(start) {
            if let Ok(records) = metadata_lines(path)
                && let Some(session) = summary(path, &records)
                && matches_cwd(&session, &context)
                && matches_query(&session, &query)
            {
                sessions.push(session);
            }
            if sessions.len() == PAGE_SIZE {
                next_cursor = (index + 1 < files.len()).then(|| (index + 1).to_string());
                break;
            }
        }
        Ok(SessionsListResult { sessions, next_cursor })
    })
    .await
    .map_err(|e| DriverError::Other(e.into()))?
}

pub(super) async fn read(context: &ProbeContext, id: &str) -> Result<SessionHistory> {
    let root = root(context)?;
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        let paths = jsonl_files(&root)?.into_iter().filter(|p| p.file_stem().and_then(|s| s.to_str()) == Some(&id)).collect::<Vec<_>>();
        if paths.len() != 1 {
            return Err(DriverError::Protocol(
                "Session is missing or ambiguous. Open it in Claude Code, then refresh the session list.".into(),
            ));
        }
        let path = &paths[0];
        let records = read_lines(path)?;
        let session = summary(path, &records)
            .filter(|s| s.id == id)
            .ok_or_else(|| DriverError::Protocol("Claude session has no working folder. Open it in Claude Code first.".into()))?;
        Ok(parse(session, records))
    })
    .await
    .map_err(|e| DriverError::Other(e.into()))?
}

pub(super) fn parse(session: SavedSession, records: Vec<Value>) -> SessionHistory {
    let records = records
        .into_iter()
        .filter(|v| v["isSidechain"] != true)
        .map(|mut record| {
            // Native compaction resets parentUuid but retains the historical link.
            if record["subtype"] == "compact_boundary" && record["parentUuid"].is_null() && record["logicalParentUuid"].is_string() {
                record["parentUuid"] = record["logicalParentUuid"].clone();
            }
            record
        })
        .collect::<Vec<_>>();
    let mut history = History::default();
    for record in active_branch(&records, "uuid", "parentUuid") {
        let at = timestamp(&record["timestamp"]).unwrap_or(session.updated_at);
        let message = &record["message"];
        match record["type"].as_str().unwrap_or("") {
            "user" => {
                for part in message["content"].as_array().into_iter().flatten() {
                    if part["type"] == "tool_result"
                        && let Some(id) = part["tool_use_id"].as_str()
                    {
                        history.result(at, id, part["content"].clone(), part["is_error"] == true);
                    }
                }
                let user = user_content(&message["content"]);
                if record["isMeta"] == true || record["isCompactSummary"] == true {
                    let text = user.plain_text();
                    if !text.is_empty() {
                        history.notice(at, text);
                    }
                } else {
                    history.user(at, user);
                }
            }
            "assistant" => {
                for part in message["content"].as_array().into_iter().flatten() {
                    match part["type"].as_str().unwrap_or("") {
                        "text" => history.assistant(at, part["text"].as_str().unwrap_or("").into(), None),
                        "thinking" => history.assistant(at, String::new(), part["thinking"].as_str().map(str::to_string)),
                        "tool_use" => {
                            if let (Some(id), Some(name)) = (part["id"].as_str(), part["name"].as_str()) {
                                history.tool(at, id, name, part["input"].clone());
                            }
                        }
                        _ => {}
                    }
                }
            }
            "system" if record["subtype"] == "compact_boundary" => history.notice(at, "Conversation compacted in Claude Code.".into()),
            _ => {}
        }
    }
    history.finish(session)
}
