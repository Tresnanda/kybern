use super::*;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader as AsyncBufReader};

struct Server {
    _child: tokio::process::Child,
    _tree: crate::process_tree::ProcessTree,
    _stdout: tokio::io::Lines<AsyncBufReader<tokio::process::ChildStdout>>,
    http: reqwest::Client,
    base: String,
    password: String,
}

impl Server {
    async fn start(context: &ProbeContext) -> Result<Self> {
        let mut cmd = command(ProviderKind::Opencode, context)?;
        let password = Uuid::new_v4().to_string();
        cmd.args(["serve", "--port", "0", "--hostname", "127.0.0.1"])
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("OPENCODE_SERVER_USERNAME", "kybern")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn()?;
        let tree = crate::process_tree::ProcessTree(child.id().expect("spawned opencode"));
        let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("OpenCode session reader has no output.".into()))?;
        let mut lines = AsyncBufReader::new(stdout).lines();
        let base = tokio::time::timeout(Duration::from_secs(30), async {
            while let Some(line) = lines.next_line().await? {
                if let Some(start) = line.find("http://127.0.0.1:") {
                    return Ok::<_, std::io::Error>(Some(line[start..].trim().trim_end_matches('/').to_string()));
                }
            }
            Ok(None)
        })
        .await
        .map_err(|_| DriverError::Protocol("OpenCode took too long to start. Check its configuration and try again.".into()))??
        .ok_or_else(|| {
            DriverError::Protocol("OpenCode could not start its session reader. Check its configuration and try again.".into())
        })?;
        // Hold the pipe only as long as the owned child. The server logs requests
        // to stderr; no persistent reader task or detached subprocess is needed.
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| DriverError::Other(e.into()))?;
        Ok(Self { _child: child, _tree: tree, _stdout: lines, http, base, password })
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        self.page(path, query).await.map(|(value, _)| value)
    }

    async fn page(&self, path: &str, query: &[(&str, String)]) -> Result<(Value, Option<String>)> {
        let mut response = self
            .http
            .get(format!("{}{path}", self.base))
            .basic_auth("kybern", Some(&self.password))
            .query(query)
            .send()
            .await
            .map_err(|e| DriverError::Other(e.into()))?;
        if !response.status().is_success() {
            return Err(DriverError::Protocol(format!(
                "OpenCode could not read saved sessions ({}). Update OpenCode and try again.",
                response.status()
            )));
        }
        let cursor = response.headers().get("x-next-cursor").and_then(|v| v.to_str().ok()).map(str::to_string);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| DriverError::Other(e.into()))? {
            if bytes.len() as u64 + chunk.len() as u64 > MAX_HISTORY_BYTES {
                return Err(DriverError::Unsupported(
                    "Session history exceeds the 64 MB import limit. Fork a shorter conversation and try again.".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((serde_json::from_slice(&bytes).map_err(|e| DriverError::Other(e.into()))?, cursor))
    }
}

fn summary(value: &Value) -> Option<SavedSession> {
    if value["parentID"].is_string() {
        return None;
    }
    Some(SavedSession {
        provider: ProviderKind::Opencode,
        id: value["id"].as_str()?.into(),
        title: title(value["title"].as_str().unwrap_or("Untitled session")),
        cwd: value["directory"].as_str()?.into(),
        updated_at: timestamp(&value["time"]["updated"]).unwrap_or_else(Utc::now),
        model: None,
        thread_id: None,
    })
}

pub(super) async fn list(context: &ProbeContext, cursor: Option<&str>, search: &str) -> Result<SessionsListResult> {
    let server = Server::start(context).await?;
    let mut cursor = cursor.map(str::to_string);
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let mut query = vec![("roots", "true".into()), ("limit", PAGE_SIZE.to_string())];
        if let Some(cwd) = &context.cwd {
            query.push(("directory", cwd.to_string_lossy().into()));
        }
        if let Some(cursor) = &cursor {
            query.push(("cursor", cursor.clone()));
        }
        let (value, next) = server.page("/experimental/session", &query).await?;
        sessions.extend(value.as_array().into_iter().flatten().filter_map(summary).filter(|s| matches_query(s, search)));
        cursor = next;
        if sessions.len() >= PAGE_SIZE || cursor.is_none() {
            break;
        }
        if !seen.insert(cursor.clone()) {
            return Err(DriverError::Protocol("OpenCode repeated a session page. Refresh and try again.".into()));
        }
    }
    Ok(SessionsListResult { sessions, next_cursor: cursor })
}

pub(super) async fn read(context: &ProbeContext, id: &str) -> Result<SessionHistory> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(DriverError::Protocol("Choose a valid OpenCode session.".into()));
    }
    let server = Server::start(context).await?;
    let info = server.get(&format!("/session/{id}"), &[]).await?;
    let session =
        summary(&info).ok_or_else(|| DriverError::Protocol("Choose a top-level OpenCode session with a working folder.".into()))?;
    let messages = server.get(&format!("/session/{id}/message"), &[("directory", session.cwd.clone())]).await?;
    Ok(parse(session, messages))
}

pub(super) fn parse(mut session: SavedSession, messages: Value) -> SessionHistory {
    let mut history = History::default();
    for message in messages.as_array().into_iter().flatten() {
        let info = &message["info"];
        let at = timestamp(&info["time"]["created"]).unwrap_or(session.updated_at);
        if info["role"] == "user" {
            let content = message["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| (p["type"] == "text" || p["type"] == "file") && p["synthetic"] != true)
                .cloned()
                .collect::<Vec<_>>();
            history.user(at, user_content(&json!(content)));
        } else if info["role"] == "assistant" {
            if let (Some(provider), Some(model)) = (info["providerID"].as_str(), info["modelID"].as_str()) {
                session.model = Some(format!("{provider}/{model}"));
            }
            for part in message["parts"].as_array().into_iter().flatten() {
                match part["type"].as_str().unwrap_or("") {
                    "text" => history.assistant(at, part["text"].as_str().unwrap_or("").into(), None),
                    "reasoning" => history.assistant(at, String::new(), part["text"].as_str().map(str::to_string)),
                    "tool" => {
                        if let (Some(id), Some(name)) = (part["callID"].as_str(), part["tool"].as_str()) {
                            let state = &part["state"];
                            history.tool(at, id, name, state["input"].clone());
                            if state["status"] == "completed" || state["status"] == "error" {
                                history.result(
                                    at,
                                    id,
                                    state.get("output").or_else(|| state.get("error")).cloned().unwrap_or(Value::Null),
                                    state["status"] == "error",
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    history.finish(session)
}
