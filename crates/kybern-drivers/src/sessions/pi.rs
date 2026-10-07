use super::*;

fn root(kind: ProviderKind, context: &ProbeContext) -> Result<PathBuf> {
    let user_home = home(context)?;
    if kind == ProviderKind::Pi {
        return Ok(env(context, "PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or(user_home.join(".pi/agent")).join("sessions"));
    }
    let selected = crate::omp_profile::resolve(&context.env)?;
    let profile = (!selected.is_empty()).then_some(selected.as_str());
    let base = user_home.join(".omp");
    let config_root = profile.map(|p| base.join("profiles").join(p)).unwrap_or(base);
    let agent = if profile.is_none() {
        env(context, "PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or(config_root.join("agent"))
    } else {
        config_root.join("agent")
    };
    if agent == config_root.join("agent")
        && let Some(xdg) = env(context, "XDG_DATA_HOME")
    {
        let app = PathBuf::from(xdg).join("omp");
        let app = profile.map(|p| app.join("profiles").join(p)).unwrap_or(app);
        if app.is_dir() {
            return Ok(app.join("sessions"));
        }
    }
    Ok(agent.join("sessions"))
}

fn summary(kind: ProviderKind, path: &Path, records: &[Value]) -> Option<SavedSession> {
    let header = records.iter().find(|v| v["type"] == "session")?;
    let name = records
        .iter()
        .rev()
        .find_map(|v| {
            if v["type"] == "title" {
                v["title"].as_str()
            } else if v["type"] == "session_info" {
                v["name"].as_str()
            } else {
                None
            }
        })
        .map(str::to_string)
        .or_else(|| records.iter().find(|v| v["message"]["role"] == "user").map(|v| content_text(&v["message"]["content"])))
        .unwrap_or_else(|| "Untitled session".into());
    let model = records.iter().rev().find_map(|v| {
        if v["type"] == "model_change" {
            let m = v["modelId"].as_str().or_else(|| v["model"]["id"].as_str());
            let p = v["provider"].as_str().or_else(|| v["model"]["provider"].as_str());
            m.map(|m| p.map(|p| format!("{p}/{m}")).unwrap_or_else(|| m.into()))
        } else {
            None
        }
    });
    Some(SavedSession {
        provider: kind,
        id: header["id"].as_str()?.into(),
        title: title(&name),
        cwd: header["cwd"].as_str()?.into(),
        updated_at: path.metadata().and_then(|m| m.modified()).ok().map(DateTime::<Utc>::from).unwrap_or_else(Utc::now),
        model,
        thread_id: None,
    })
}

pub(super) async fn list(kind: ProviderKind, context: &ProbeContext, cursor: Option<&str>, query: &str) -> Result<SessionsListResult> {
    let root = root(kind, context)?;
    let context = context.clone();
    let start = offset(cursor)?;
    let query = query.to_string();
    tokio::task::spawn_blocking(move || {
        let files = jsonl_files(&root)?;
        let mut sessions = Vec::new();
        let mut next_cursor = None;
        for (index, path) in files.iter().enumerate().skip(start) {
            if let Ok(records) = metadata_lines(path)
                && let Some(session) = summary(kind, path, &records)
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

pub(super) async fn read(kind: ProviderKind, context: &ProbeContext, id: &str) -> Result<SessionHistory> {
    let root = root(kind, context)?;
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        // Resolve by exact native id, never accept an arbitrary client file path.
        for path in jsonl_files(&root)? {
            let Ok(metadata) = metadata_lines(&path) else { continue };
            let Some(session) = summary(kind, &path, &metadata).filter(|s| s.id == id) else { continue };
            let records = read_lines(&path)?;
            return Ok(parse(session, records));
        }
        Err(DriverError::Protocol("Session was not found. Check the harness profile and refresh the session list.".into()))
    })
    .await
    .map_err(|e| DriverError::Other(e.into()))?
}

pub(super) fn parse(session: SavedSession, records: Vec<Value>) -> SessionHistory {
    let mut history = History::default();
    for record in active_branch(&records, "id", "parentId") {
        let at = timestamp(&record["timestamp"]).unwrap_or(session.updated_at);
        if record["type"] == "compaction" || record["type"] == "branch_summary" {
            if let Some(summary) = record["summary"].as_str() {
                history.notice(at, format!("Conversation summary\n\n{summary}"));
            }
            continue;
        }
        if record["type"] != "message" {
            continue;
        }
        let message = &record["message"];
        match message["role"].as_str().unwrap_or("") {
            "user" => history.user(at, user_content(&message["content"])),
            "assistant" => {
                for part in message["content"].as_array().into_iter().flatten() {
                    match part["type"].as_str().unwrap_or("") {
                        "text" => history.assistant(at, part["text"].as_str().unwrap_or("").into(), None),
                        "thinking" => history.assistant(at, String::new(), part["thinking"].as_str().map(str::to_string)),
                        "toolCall" => {
                            if let (Some(id), Some(name)) = (part["id"].as_str(), part["name"].as_str()) {
                                history.tool(at, id, name, part["arguments"].clone());
                            }
                        }
                        _ => {}
                    }
                }
                if message["stopReason"] == "aborted" || message["stopReason"] == "error" {
                    history.end(StopReason::Interrupted);
                }
            }
            "toolResult" => {
                if let Some(id) = message["toolCallId"].as_str() {
                    history.result(at, id, message["content"].clone(), message["isError"] == true);
                }
            }
            _ => {}
        }
    }
    history.finish(session)
}

/// Recovery requires one exact retained entry, including explicit native tool boundaries.
pub(super) async fn recover_message(context: &ProbeContext, id: &str, text: &str) -> Result<NativeOmpMessage> {
    let root = root(ProviderKind::Omp, context)?;
    let context = context.clone();
    let id = id.to_string();
    let text = text.to_string();
    tokio::task::spawn_blocking(move || {
        let files = jsonl_files_bounded(&root, 10_000)?;
        let mut matched = None;
        for path in files {
            let metadata = metadata_lines(&path)?;
            let Some(session) = summary(ProviderKind::Omp, &path, &metadata).filter(|s| s.id == id) else { continue };
            if matched.is_some() {
                return Err(DriverError::Protocol(
                    "More than one native file has this OMP session id. Resolve the duplicate history before recovering.".into(),
                ));
            }
            if context.cwd.as_ref().is_none_or(|cwd| Path::new(&session.cwd) != cwd) {
                return Err(DriverError::Protocol(
                    "The retained OMP session belongs to a different workspace. Restore its original workspace binding.".into(),
                ));
            }
            matched = Some(recovery_entry(&read_lines(&path)?, &text)?);
        }
        matched.ok_or_else(|| {
            DriverError::Protocol(
                "Native OMP history is unavailable. Restore the original account/profile session history and retry.".into(),
            )
        })
    })
    .await
    .map_err(|e| DriverError::Other(e.into()))?
}

fn recovery_entry(records: &[Value], expected: &str) -> Result<NativeOmpMessage> {
    let mut matched = None;
    // Consider all retained branches. An identical entry on another branch is
    // ambiguous even if only one currently belongs to the active branch.
    for record in records {
        if record["type"] != "message" || record["message"]["role"] != "assistant" {
            continue;
        }
        let Some(parts) = record["message"]["content"].as_array() else { continue };
        let text = parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<String>();
        if text != expected {
            continue;
        }
        if matched.is_some() {
            return Err(DriverError::Protocol(
                "Native OMP history contains multiple exact message matches. Recovery cannot choose an entry safely.".into(),
            ));
        }
        if parts.len() > 4096 || record["message"]["stopReason"] != "stop" {
            return Err(DriverError::Protocol("This native OMP message is not a bounded successful final response.".into()));
        }
        let entry_id = record["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| DriverError::Protocol("Native OMP entry identity is missing.".into()))?
            .to_string();
        let at = timestamp(&record["timestamp"]).ok_or_else(|| DriverError::Protocol("Native OMP entry timestamp is missing.".into()))?;
        let mut blocks = Vec::new();
        for part in parts {
            let block = match part["type"].as_str() {
                Some("text") => part["text"].as_str().map(|s| NativeOmpBlock::Text(s.to_string())),
                Some("thinking") => part["thinking"].as_str().map(|s| NativeOmpBlock::Thinking(s.to_string())),
                Some("toolCall") => part["id"].as_str().filter(|s| !s.is_empty()).map(|s| NativeOmpBlock::ToolCall(s.to_string())),
                _ => None,
            }
            .ok_or_else(|| {
                DriverError::Protocol(
                    "Native OMP entry has unsupported or incomplete content blocks. Recovery left the transcript unchanged.".into(),
                )
            })?;
            blocks.push(block);
        }
        matched = Some(NativeOmpMessage { entry_id, at, blocks });
    }
    matched.ok_or_else(|| {
        DriverError::Protocol(
            "No exact retained native OMP message matches the stored response. Recovery left the transcript unchanged.".into(),
        )
    })
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn native() -> Value {
        json!({"type":"message", "id":"entry", "timestamp":"2026-10-07T14:32:19.392Z", "message":{
        "role":"assistant", "stopReason":"stop", "content":[
            {"type":"text","text":"Progress"}, {"type":"thinking","thinking":"Reasoning"},
            {"type":"toolCall","id":"tool"}, {"type":"text","text":"Exact 🪴 final\n"}
        ]}})
    }

    #[test]
    fn native_recovery_requires_unique_complete_explicit_blocks() {
        let record = native();
        let message = recovery_entry(std::slice::from_ref(&record), "ProgressExact 🪴 final\n").unwrap();
        assert_eq!(message.entry_id, "entry");
        assert_eq!(message.blocks.len(), 4);
        assert!(matches!(message.blocks.last(), Some(NativeOmpBlock::Text(text)) if text == "Exact 🪴 final\n"));
        assert!(recovery_entry(&[record.clone(), record.clone()], "ProgressExact 🪴 final\n").is_err());
        assert!(recovery_entry(std::slice::from_ref(&record), "Progress\nExact 🪴 final\n").is_err());
        let mut incomplete = record.clone();
        incomplete["message"]["stopReason"] = json!("aborted");
        assert!(recovery_entry(&[incomplete], "ProgressExact 🪴 final\n").is_err());
        let mut unsupported = record;
        unsupported["message"]["content"].as_array_mut().unwrap().push(json!({"type":"image"}));
        assert!(recovery_entry(&[unsupported], "ProgressExact 🪴 final\n").is_err());
    }
}
