use super::*;

pub(super) fn root(context: &ProbeContext) -> Result<PathBuf> {
    Ok(env(context, "CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or(home(context)?.join(".claude")).join("projects"))
}

pub(super) fn summary(path: &Path, records: &[Value]) -> Option<SavedSession> {
    let first = records.iter().find(|v| v["cwd"].is_string() && v["sessionId"].is_string() && v["isSidechain"] != true)?;
    // A saved title can be the markup of the command that opened the session; that is no title.
    let saved = |key: &str| records.iter().rev().find_map(|v| v[key].as_str()).map(str::trim).filter(|title| plain_title(title));
    let typed = || {
        let prompts = records.iter().filter(|v| v["type"] == "user" && v["isMeta"] != true).map(|v| content_text(&v["message"]["content"]));
        let shown = prompts.map(|text| typed_text(&text)).collect::<Vec<_>>();
        // A prompt names the session; a bare command such as `/review` only when nothing else does.
        shown
            .iter()
            .find_map(|typed| typed.as_ref().map(|typed| typed.title.clone()).filter(|title| !title.is_empty()))
            .or_else(|| shown.iter().find_map(|typed| typed.as_ref().map(|typed| typed.text.clone()).filter(|text| !text.is_empty())))
    };
    let name =
        saved("customTitle").or_else(|| saved("aiTitle")).map(str::to_string).or_else(typed).unwrap_or_else(|| "Untitled session".into());
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
        Ok(file_page(&files, start, &context, &query, summary).0)
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
        read_path(&paths[0], &id)
    })
    .await
    .map_err(|e| DriverError::Other(e.into()))?
}

/// Read the file a listing found for `id`.
pub(super) fn read_path(path: &Path, id: &str) -> Result<SessionHistory> {
    let records = read_records(path)?;
    let session = summary(path, &records)
        .filter(|s| s.id == id)
        .ok_or_else(|| DriverError::Protocol("Claude session has no working folder. Open it in Claude Code first.".into()))?;
    Ok(parse(session, records))
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
                let mut user = user_content(&message["content"]);
                if record["isMeta"] != true && record["isCompactSummary"] != true {
                    user = typed_message(user);
                }
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

/// What a person typed in a Claude Code user turn, and the part of it that may name the session.
#[derive(Debug, PartialEq)]
struct Typed {
    text: String,
    title: String,
}

/// Claude Code records its own UI as user turns: slash commands, `!` shell runs and their output, task
/// notifications and interruptions. `None` for its output, which nobody typed; a command or shell run as
/// it was typed (`/review src`, `!ls`); any other text as is. A prompt Claude Code was woken with
/// (`<wake reason=…>…</wake>`) is titled after the prompt inside.
fn typed_text(text: &str) -> Option<Typed> {
    let trimmed = text.trim();
    const OUTPUT: &[&str] = &[
        "<task-notification>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
        "<bash-stdout>",
        "<bash-stderr>",
    ];
    if OUTPUT.iter().any(|tag| trimmed.starts_with(tag))
        || trimmed == "[Request interrupted by user]"
        || trimmed == "[Request interrupted by user for tool use]"
    {
        return None;
    }
    if let Some(command) = trimmed.strip_prefix("<bash-input>").and_then(|rest| rest.strip_suffix("</bash-input>")) {
        return Some(Typed { text: format!("!{command}"), title: String::new() });
    }
    if trimmed.starts_with("<command-name>") || trimmed.starts_with("<command-message>") {
        let name = tag(trimmed, "command-name")
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("/{}", tag(trimmed, "command-message").unwrap_or("").trim()));
        let args = tag(trimmed, "command-args").unwrap_or("").trim();
        let text = if args.is_empty() { name } else { format!("{name} {args}") };
        return Some(Typed { text, title: args.to_string() });
    }
    let title = woken_prompt(trimmed).unwrap_or(trimmed).to_string();
    Some(Typed { text: text.to_string(), title })
}

/// The text between `<name>` and `</name>`.
fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let start = text.find(&format!("<{name}>"))? + name.len() + 2;
    let end = text[start..].find(&format!("</{name}>"))?;
    Some(&text[start..start + end])
}

/// The prompt inside `<wake reason=… current-time=…>…</wake>`, the envelope of a session an agent started.
fn woken_prompt(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("<wake")?;
    if !rest.starts_with('>') && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let body = &rest[rest.find('>')? + 1..];
    Some(body.split("</wake>").next().unwrap_or(body).trim())
}

/// A saved title that is plain text, not the markup of a turn.
fn plain_title(title: &str) -> bool {
    !title.is_empty() && typed_text(title).is_some_and(|typed| typed.text == title)
}

/// A user turn as the person typed it: Claude Code's output parts dropped, commands and shell runs written
/// out. A turn of nothing but output becomes empty, and the history skips it.
fn typed_message(message: UserMessage) -> UserMessage {
    let parts = message
        .parts
        .into_iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => typed_text(&text).map(|typed| ContentPart::Text { text: typed.text }),
            other => Some(other),
        })
        .collect();
    UserMessage { parts }
}

/// The most bytes of conversation records an import holds at once. The file itself may be larger: the
/// records an import never reads (API request copies, attachments, structured duplicates of tool results)
/// are kept only as the links that order the conversation.
const MAX_RETAINED_BYTES: u64 = 128 * 1024 * 1024;
/// The longest single record an import reads.
const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
/// The words that classify a transcript as too large (`classify_read_error`).
pub(super) const TOO_LARGE_TEXT: &str = "128 MB of messages";

/// Read a Claude Code transcript line by line, keeping what `summary` and `parse` read.
fn read_records(path: &Path) -> Result<Vec<Value>> {
    read_records_within(path, MAX_RETAINED_BYTES)
}

fn read_records_within(path: &Path, budget: u64) -> Result<Vec<Value>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut records = Vec::new();
    let mut retained = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut reader).take(MAX_RECORD_BYTES as u64 + 1).read_until(b'\n', &mut line)?;
        if read == 0 {
            break;
        }
        let complete = line.last() == Some(&b'\n');
        if !complete && line.len() > MAX_RECORD_BYTES {
            return Err(too_large());
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let record = match serde_json::from_slice::<Value>(&line) {
            Ok(record) => record,
            // The last line of a session Claude Code is still writing.
            Err(_) if !complete && reader.fill_buf()?.is_empty() => {
                return Err(DriverError::Protocol(format!("{STILL_WRITING} Stop the original session and try again.")));
            }
            Err(e) => {
                return Err(DriverError::Protocol(format!(
                    "Unable to read saved history: {e}. Open the session in its harness to repair it."
                )));
            }
        };
        match conversation_record(record) {
            Kept::Whole(record) => {
                retained += line.len() as u64;
                if retained > budget {
                    return Err(too_large());
                }
                records.push(record);
            }
            Kept::Link(record) => records.push(record),
        }
    }
    Ok(records)
}

fn too_large() -> DriverError {
    DriverError::Unsupported(format!(
        "This conversation is too long to import (more than {TOO_LARGE_TEXT}). Fork a shorter conversation in Claude Code and import that session."
    ))
}

enum Kept {
    Whole(Value),
    /// Only the fields that link it into the conversation and describe the session.
    Link(Value),
}

/// A record `parse` reads whole (user, assistant and system records), less the structured copy of a tool
/// result Claude Code stores beside the result itself; any other record as a link.
fn conversation_record(mut record: Value) -> Kept {
    if matches!(record["type"].as_str(), Some("user" | "assistant" | "system")) {
        if let Some(object) = record.as_object_mut() {
            object.remove("toolUseResult");
        }
        return Kept::Whole(record);
    }
    const LINK_FIELDS: &[&str] = &[
        "type",
        "subtype",
        "uuid",
        "parentUuid",
        "logicalParentUuid",
        "isSidechain",
        "sessionId",
        "cwd",
        "timestamp",
        "customTitle",
        "aiTitle",
    ];
    let link = LINK_FIELDS.iter().filter_map(|key| record.get(*key).map(|value| (key.to_string(), value.clone()))).collect();
    Kept::Link(Value::Object(link))
}

#[cfg(test)]
mod markup_tests {
    use super::*;

    #[test]
    fn claude_code_output_is_hidden_and_commands_read_as_typed() {
        let typed = |text: &str| typed_text(text).map(|typed| (typed.text, typed.title));
        assert_eq!(typed("<local-command-stdout>Cleared</local-command-stdout>"), None);
        assert_eq!(typed("<local-command-caveat>Caveat: generated by a command</local-command-caveat>"), None);
        assert_eq!(typed("<task-notification><task-id>a</task-id></task-notification>"), None);
        assert_eq!(typed("<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>"), None);
        assert_eq!(typed("[Request interrupted by user for tool use]"), None);
        assert_eq!(typed("<bash-input>ls -la</bash-input>"), Some(("!ls -la".into(), String::new())));
        assert_eq!(
            typed(
                "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the auth flow</command-args>"
            ),
            Some(("/review the auth flow".into(), "the auth flow".into()))
        );
        assert_eq!(
            typed("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
            Some(("/clear".into(), String::new()))
        );
        assert_eq!(typed("<command-message>compact</command-message>"), Some(("/compact".into(), String::new())));
        assert_eq!(
            typed("<wake reason=\"schedule\" current-time=\"2026-11-20T09:00\">Check main is green\nthen report</wake>"),
            Some((
                "<wake reason=\"schedule\" current-time=\"2026-11-20T09:00\">Check main is green\nthen report</wake>".into(),
                "Check main is green\nthen report".into()
            ))
        );
        assert_eq!(typed("Fix the <b> tag in README"), Some(("Fix the <b> tag in README".into(), "Fix the <b> tag in README".into())));
        assert!(!plain_title("<command-name>/init</command-name>"));
        assert!(plain_title("Fix login redirect"));
    }

    fn write(lines: &[Value]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for line in lines {
            use std::io::Write;
            writeln!(file, "{line}").unwrap();
        }
        file
    }

    fn user(uuid: &str, parent: Option<&str>, content: Value) -> Value {
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"sessionId":"s1","cwd":"/work","timestamp":"2026-11-20T09:00:00Z",
               "message":{"role":"user","content":content}})
    }

    fn assistant(uuid: &str, parent: &str, text: &str) -> Value {
        json!({"type":"assistant","uuid":uuid,"parentUuid":parent,"sessionId":"s1","timestamp":"2026-11-20T09:00:01Z",
               "message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":text}]}})
    }

    /// Recorded shapes of Claude Code 2.1.327: `/clear` and its output, a `!` run, then a prompt.
    #[test]
    fn imported_sessions_show_what_the_user_typed_and_are_titled_after_a_prompt() {
        let records = vec![
            user(
                "u1",
                None,
                json!("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
            ),
            user("u2", Some("u1"), json!("<local-command-stdout></local-command-stdout>")),
            user("u3", Some("u2"), json!("<bash-input>git status</bash-input>")),
            user("u4", Some("u3"), json!("<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>")),
            user("u5", Some("u4"), json!([{"type":"text","text":"Fix the flaky login test"}])),
            assistant("a1", "u5", "Fixed."),
            json!({"type":"ai-title","aiTitle":"<command-name>/clear</command-name>","sessionId":"s1"}),
        ];
        let file = write(&records);
        let parsed = read_records(file.path()).unwrap();
        let session = summary(file.path(), &parsed).unwrap();
        assert_eq!(session.title, "Fix the flaky login test");
        let history = parse(session, parsed);
        let prompts: Vec<_> = history
            .events
            .iter()
            .filter_map(|event| match &event.payload {
                EventPayload::TurnStarted { message, .. } => Some(message.plain_text()),
                _ => None,
            })
            .collect();
        assert_eq!(prompts, ["/clear", "!git status", "Fix the flaky login test"]);

        // A session of nothing but a bare command is titled with it.
        let file = write(&[user("u1", None, json!("<command-name>/review</command-name>\n<command-args></command-args>"))]);
        assert_eq!(summary(file.path(), &read_records(file.path()).unwrap()).unwrap().title, "/review");
    }

    /// The records an import never reads keep only their links, so they don't count against the budget:
    /// here they are ten times it, and the conversation through them still follows the chain.
    #[test]
    fn long_sessions_import_and_keep_the_conversation_chain() {
        use std::io::Write;
        const BUDGET: u64 = 256 * 1024;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "{}", user("u1", None, json!("First prompt"))).unwrap();
        let blob = "x".repeat(64 * 1024);
        let mut parent = "u1".to_string();
        for n in 0..20 {
            // An attachment in the chain and an API request copy outside it.
            let id = format!("att{n}");
            writeln!(file, "{}", json!({"type":"attachment","uuid":id,"parentUuid":parent,"attachment":{"content":blob}})).unwrap();
            writeln!(file, "{}", json!({"type":"api-request-blob","blob":blob})).unwrap();
            parent = id;
        }
        let mut result = user("t1", Some(&parent), json!([{"type":"tool_result","tool_use_id":"call","content":"done"}]));
        result["toolUseResult"] = json!({"stdout": "z".repeat(1024)});
        writeln!(file, "{result}").unwrap();
        writeln!(file, "{}", assistant("a1", "t1", "Last answer")).unwrap();
        file.flush().unwrap();
        assert!(file.as_file().metadata().unwrap().len() > 10 * BUDGET);

        let records = read_records_within(file.path(), BUDGET).unwrap();
        assert!(
            records
                .iter()
                .all(|record| record.get("attachment").is_none() && record.get("blob").is_none() && record.get("toolUseResult").is_none())
        );
        let history = parse(summary(file.path(), &records).unwrap(), records);
        let text = serde_json::to_string(&history.events).unwrap();
        assert!(text.contains("First prompt") && text.contains("Last answer"), "the chain reaches the first prompt");
    }

    #[test]
    fn conversations_past_the_budget_and_half_written_lines_are_refused_with_their_reason() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let text = "y".repeat(64 * 1024);
        for n in 0..5 {
            writeln!(file, "{}", user(&format!("u{n}"), None, json!(text))).unwrap();
        }
        file.flush().unwrap();
        let error = read_records_within(file.path(), 256 * 1024).unwrap_err();
        assert_eq!(classify_read_error(&error), ReadFailure::TooLarge, "{error}");

        let mut file = tempfile::NamedTempFile::new().unwrap();
        write!(file, "{}\n{{\"type\":\"user\",\"mess", user("u1", None, json!("hi"))).unwrap();
        file.flush().unwrap();
        assert_eq!(classify_read_error(&read_records(file.path()).unwrap_err()), ReadFailure::InUse);
    }
}
