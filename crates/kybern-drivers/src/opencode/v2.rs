//! OpenCode 2 driver: runs `opencode serve` per session and speaks its v2
//! HTTP API (`/api/...`), consuming `/api/event` for progress.
//!
//! The v2 server keeps the v1 lifecycle (one process per kybern thread, cwd
//! is the project, sessions persist on disk) but every contract changed:
//! Basic auth with the fixed user `opencode`, typed `session.*` events keyed
//! by assistant message and ordinal, ordered permission rules that can be
//! replaced on a live session, questions delivered as forms, and per-session
//! instruction entries instead of a per-prompt system field.

use kybern_protocol::process::NoWindow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use kybern_protocol::*;
use reqwest::Method;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::{Mutex, mpsc};

use super::{
    CHILD_RULES_TIMEOUT, FIRST_SUBSCRIBE_TIMEOUT, OPENCODE_READ_ONLY_TOOLS, RECONCILE_CALL_TIMEOUT, SILENT_STREAM_TIMEOUT,
    SUBSCRIBE_TIMEOUT, StartFailure, StderrTail, is_database_locked, mcp_config, model_window, net, read_frames, retry_locked_start,
    split_model,
};
use crate::{
    AgentSession, DriverError, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, NativeToolBridge, Result, SessionConfig,
    SpawnedSession,
};

/// Instruction entry that carries the Kybern guide and coordinator role.
const INSTRUCTIONS_KEY: &str = "kybern";
/// Skills load after the server starts; built-ins always exist once they have.
const SKILL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// A private `opencode serve` with a random password. Dropping it stops the
/// process group.
pub(crate) struct Server {
    pub(crate) child: Child,
    pub(crate) tree: crate::process_tree::ProcessTree,
    pub(crate) http: reqwest::Client,
    pub(crate) base: String,
    password: String,
}

impl Server {
    pub(crate) async fn start<'a>(
        bin: &Path,
        cwd: Option<&Path>,
        env: impl IntoIterator<Item = (&'a String, &'a String)>,
        extra: &[(&str, &str)],
    ) -> Result<Self> {
        let env: Vec<(&String, &String)> = env.into_iter().collect();
        retry_locked_start(|| Self::start_once(bin, cwd, &env, extra)).await
    }

    async fn start_once(
        bin: &Path,
        cwd: Option<&Path>,
        env: &[(&String, &String)],
        extra: &[(&str, &str)],
    ) -> std::result::Result<Self, StartFailure> {
        let password = uuid::Uuid::new_v4().simple().to_string();
        let mut cmd = crate::binary::command(bin).no_window();
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        cmd.args(["serve", "--port", "0", "--hostname", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.envs(env.iter().copied());
        for (key, value) in extra {
            cmd.env(key, value);
        }
        // `OPENCODE_SERVER_PASSWORD` still works in v2; `OPENCODE_PASSWORD` is its new name.
        cmd.env("OPENCODE_PASSWORD", &password).env("OPENCODE_SERVER_PASSWORD", &password);
        #[cfg(unix)]
        cmd.process_group(0);
        tracing::info!(bin = %bin.display(), "spawning opencode serve (v2)");
        let mut child = cmd.spawn().map_err(|error| StartFailure::plain(error.into()))?;
        let tree = crate::process_tree::ProcessTree::new(child.id().expect("spawned opencode"));
        let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("no stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| DriverError::Protocol("no stderr".into()))?;
        let stderr = StderrTail::capture(stderr);
        // "Server listening on http://127.0.0.1:PORT".
        let mut lines = BufReader::new(stdout).lines();
        let announced = tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "provider.stdout", "{line}");
                if let Some(index) = line.find("http://") {
                    return Some(line[index..].split_whitespace().next().unwrap_or("").trim_end_matches('/').to_string());
                }
            }
            None
        })
        .await
        .ok()
        .flatten();
        let Some(base) = announced else {
            let _ = child.kill().await;
            let database_locked = is_database_locked(&stderr.finish().await);
            return Err(StartFailure {
                error: DriverError::Protocol("opencode serve did not announce a listening address".into()),
                database_locked,
            });
        };
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "provider.stdout", "{line}");
            }
        });
        let http = reqwest::Client::builder().build().map_err(|e| StartFailure::plain(DriverError::Protocol(e.to_string())))?;
        let server = Self { child, tree, http, base, password };
        for _ in 0..50 {
            if server.request(Method::GET, "/api/info").send().await.is_ok_and(|r| r.status().is_success()) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Ok(server)
    }

    pub(crate) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.base)).basic_auth("opencode", Some(&self.password))
    }

    /// Send one request and return its JSON body (`Null` for an empty reply).
    pub(crate) async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self.request(method, path).timeout(std::time::Duration::from_secs(120));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(net)?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(DriverError::Protocol(format!("opencode {path}: {status} {}", text.chars().take(500).collect::<String>())));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
}

/// Ask a short-lived v2 server for the effective skill catalog.
pub(super) async fn discover_skills(bin: &Path, cwd: &Path, env: &BTreeMap<String, String>) -> Option<Vec<SkillInfo>> {
    let server = Server::start(bin, Some(cwd), env, &[]).await.ok()?;
    let deadline = tokio::time::Instant::now() + SKILL_DISCOVERY_TIMEOUT;
    // Built-ins are listed first; project, user and plugin skills follow as
    // one batch. Settle on an unchanged list that has more than built-ins, or
    // on built-ins alone once they have held for two seconds.
    let mut last: Option<Vec<Value>> = None;
    let mut unchanged = 0;
    loop {
        if let Ok(value) = server.call(Method::GET, "/api/skill", None).await
            && let Some(entries) = value["data"].as_array().filter(|entries| !entries.is_empty())
        {
            if last.as_ref().is_some_and(|last| last.len() == entries.len()) {
                unchanged += 1;
            } else {
                unchanged = 0;
            }
            let beyond_builtins = entries.iter().any(|entry| !entry["path"].as_str().unwrap_or("").starts_with("/builtin/"));
            if (beyond_builtins && unchanged >= 1) || unchanged >= 8 {
                return Some(parse_skills(entries, cwd));
            }
            last = Some(entries.clone());
        }
        if tokio::time::Instant::now() >= deadline {
            return last.map(|entries| parse_skills(&entries, cwd));
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

/// The skill id is what a prompt attaches, so it is the Kybern name.
fn parse_skills(entries: &[Value], cwd: &Path) -> Vec<SkillInfo> {
    let mut seen = HashSet::new();
    // OpenCode reports canonical paths (`/private/var/...` for `/var/...`).
    let canonical = cwd.canonicalize().ok();
    let in_project = |path: &Path| path.starts_with(cwd) || canonical.as_ref().is_some_and(|root| path.starts_with(root));
    let mut skills: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry["id"].as_str().map(str::trim).filter(|id| !id.is_empty())?;
            let path = entry["path"].as_str().unwrap_or("");
            if !seen.insert(id.to_ascii_lowercase()) {
                return None;
            }
            let name = entry["name"].as_str().map(str::trim).filter(|name| !name.is_empty() && *name != id);
            let scope = if path.starts_with("/builtin/") {
                SkillScope::System
            } else if in_project(Path::new(path)) {
                SkillScope::Project
            } else {
                SkillScope::User
            };
            Some(SkillInfo {
                name: id.to_string(),
                display_name: name.map(str::to_string),
                description: entry["description"].as_str().map(str::trim).filter(|d| !d.is_empty()).map(str::to_string),
                path: path.to_string(),
                scope,
                enabled: true,
                home: None,
                plugin: None,
            })
        })
        .collect();
    skills.sort_by_key(|skill| skill.name.to_ascii_lowercase());
    skills
}

/// Ordered v2 permission rules for a kybern mode. Last matching rule wins.
fn ruleset(mode: PermissionMode) -> Vec<Value> {
    let rule = |action: &str, effect: &str| json!({ "action": action, "resource": "*", "effect": effect });
    match mode {
        PermissionMode::Supervised => vec![
            rule("*", "ask"),
            rule("read", "allow"),
            rule("glob", "allow"),
            rule("grep", "allow"),
            rule("list", "allow"),
            rule("question", "allow"),
            rule("skill", "allow"),
            rule("subagent", "allow"),
        ],
        PermissionMode::AcceptEdits => vec![
            rule("*", "allow"),
            rule("shell", "ask"),
            rule("webfetch", "ask"),
            rule("websearch", "ask"),
            rule("external_directory", "ask"),
        ],
        // v2 allows external directories by default; keep v1's prompt.
        PermissionMode::Auto => vec![rule("*", "allow"), rule("external_directory", "ask")],
        PermissionMode::FullAccess => vec![rule("*", "allow")],
    }
}

/// Rules appended after the mode so a coordinator keeps only Kybern's tools.
fn restriction_rules(bridge: Option<&NativeToolBridge>) -> Vec<Value> {
    let Some(bridge) = bridge.filter(|bridge| bridge.restrictions.require_enforcement) else { return Vec::new() };
    let rule = |action: &str, effect: &str| json!({ "action": action, "resource": "*", "effect": effect });
    // MCP tools are named `<server>_<tool>`; the gateway already filters the server's list.
    let mut rules = vec![rule("*", "deny"), rule(&format!("{}_*", bridge.server_name), "allow")];
    rules.extend(bridge.restrictions.allowed_mcp_servers.keys().map(|name| rule(&format!("{name}_*"), "allow")));
    if bridge.restrictions.allow_read_only_builtins {
        rules.extend(OPENCODE_READ_ONLY_TOOLS.iter().map(|tool| rule(tool, "allow")));
    }
    rules
}

fn model_ref(model: &str, effort: Option<&str>) -> Option<Value> {
    let (model, variant) = model.split_once('#').map_or((model, None), |(model, variant)| (model, Some(variant)));
    let variant = effort.map(str::trim).filter(|effort| !effort.is_empty()).or_else(|| variant.filter(|v| !v.is_empty()));
    let (provider, id) = split_model(model)?;
    let mut value = json!({ "providerID": provider, "id": id });
    if let Some(variant) = variant {
        value["variant"] = json!(variant);
    }
    Some(value)
}

fn model_key(model: &Value) -> Option<String> {
    Some(format!("{}/{}", model["providerID"].as_str()?, model["id"].as_str()?))
}

pub(super) async fn spawn(bin: &Path, config: SessionConfig) -> Result<SpawnedSession> {
    let bridge = config.native_tool_bridge.as_ref();
    let mut extra = Vec::new();
    let native_config = match bridge {
        Some(bridge) => {
            let mut value = mcp_config(config.env.get("OPENCODE_CONFIG_CONTENT"), bridge)?;
            let rules = restriction_rules(Some(bridge));
            if !rules.is_empty() {
                // Also in the global config so subagents and agents loaded from
                // files cannot widen a coordinator's tool scope.
                let permissions = value.as_object_mut().expect("object config").entry("permissions").or_insert_with(|| json!([]));
                let Some(list) = permissions.as_array_mut() else {
                    return Err(DriverError::Unsupported("OpenCode inline config has a non-array permissions section".into()));
                };
                list.extend(rules);
            }
            Some(serde_json::to_string(&value).map_err(|error| DriverError::Other(error.into()))?)
        }
        None => None,
    };
    let native_config = super::with_compaction(
        native_config,
        config.env.get("OPENCODE_CONFIG_CONTENT"),
        super::compaction_config(config.model.as_deref(), config.compaction.auto_compact_tokens),
    )?;
    if let Some(native_config) = native_config.as_deref() {
        extra.push(("OPENCODE_CONFIG_CONTENT", native_config));
    }
    let server = Server::start(bin, Some(&config.cwd), &config.env, &extra).await?;
    let dir = config.cwd.to_string_lossy().to_string();
    let restrictions = restriction_rules(bridge);
    let permissions = |mode| ruleset(mode).into_iter().chain(restrictions.iter().cloned()).collect::<Vec<_>>();

    // Subscribe before the session exists so no event of the first turn is missed.
    let stream = tokio::time::timeout(FIRST_SUBSCRIBE_TIMEOUT, server.request(Method::GET, "/api/event").send())
        .await
        .map_err(|_| DriverError::Protocol("opencode /api/event did not answer".into()))?
        .map_err(net)?;
    if !stream.status().is_success() {
        return Err(DriverError::Protocol(format!("opencode /api/event: {}", stream.status())));
    }

    let session_id = match (&config.resume_session_id, config.fork) {
        (Some(id), false) => {
            server
                .call(Method::GET, &format!("/api/session/{id}"), None)
                .await
                .map_err(|_| DriverError::Protocol(format!("opencode session {id} not found in {dir}")))?;
            id.clone()
        }
        (Some(id), true) => {
            // Fork keeps the messages before the first dropped turn's user message.
            let body = match config.rewind.as_ref().and_then(|r| r.drop_from.turn_id.clone()) {
                Some(message_id) => json!({ "before": message_id }),
                None => json!({}),
            };
            let value = server.call(Method::POST, &format!("/api/session/{id}/fork"), Some(body)).await?;
            value
                .pointer("/data/id")
                .and_then(Value::as_str)
                .ok_or_else(|| DriverError::Protocol("fork returned no id".into()))?
                .to_string()
        }
        (None, _) => {
            let mut body = json!({
                "title": "kybern",
                "location": { "directory": dir },
                "permissions": permissions(config.permission_mode),
            });
            if let Some(model) = config.model.as_deref().and_then(|model| model_ref(model, config.effort.as_deref())) {
                body["model"] = model;
            }
            let value = server.call(Method::POST, "/api/session", Some(body)).await?;
            value
                .pointer("/data/id")
                .and_then(Value::as_str)
                .ok_or_else(|| DriverError::Protocol(format!("session create failed: {value}")))?
                .to_string()
        }
    };
    if config.resume_session_id.is_some() {
        // A resumed or forked session keeps its stored rules; apply the
        // current mode and scope, which v2 can replace in place.
        server
            .call(Method::PATCH, &format!("/api/session/{session_id}"), Some(json!({ "permissions": permissions(config.permission_mode) })))
            .await?;
        if let Some(model) = config.model.as_deref().and_then(|model| model_ref(model, config.effort.as_deref())) {
            server.call(Method::POST, &format!("/api/session/{session_id}/model"), Some(json!({ "model": model }))).await?;
        }
    }
    // The guide and coordinator role are session instructions; a PUT replaces
    // the entry, so resuming keeps exactly one copy.
    if let Some(instructions) = bridge.and_then(|bridge| bridge.provider_instructions()) {
        server
            .call(
                Method::PUT,
                &format!("/api/experimental/session/{session_id}/instructions/entries/{INSTRUCTIONS_KEY}"),
                Some(json!({ "value": instructions })),
            )
            .await?;
    }

    let Server { child, tree, http, base, password } = server;
    let (tx, rx) = mpsc::channel(1024);
    let session = Arc::new(OpencodeSession {
        server: Api { http, base, password },
        child: Mutex::new(child),
        events: tx,
        state: {
            let mut state = State::new(session_id.clone(), restrictions);
            state.model = config.model.clone().filter(|model| split_model(model).is_some());
            state.effort = config.effort.clone();
            state.mode = config.permission_mode;
            Mutex::new(state)
        },
    });
    session.emit(DriverEvent::SessionBound { session_id, model: config.model.clone() }).await;
    let reader = session.clone();
    let worker = crate::process_tree::SessionTask(tokio::spawn(async move {
        tokio::join!(reader.discover_metadata(), reader.clone().event_loop(Some(stream)));
    }));
    Ok(SpawnedSession { session: Box::new(Handle(session, std::sync::Mutex::new(Some(tree)), Some(worker))), events: rx })
}

/// The connection half of [`Server`], kept by a live session.
struct Api {
    http: reqwest::Client,
    base: String,
    password: String,
}

impl Api {
    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{path}", self.base)).basic_auth("opencode", Some(&self.password))
    }
}

enum Pending {
    Permission { session: String },
    Form { session: String, fields: Vec<FormField> },
}

struct FormField {
    key: String,
    kind: String,
    /// Option label -> value.
    options: Vec<(String, String)>,
}

#[derive(Default)]
struct ChildRuntime {
    task_id: String,
    /// The tool call that started (or last resumed) this child.
    call_id: Option<String>,
    /// Whether the child holds the rules of this thread's current mode. A new
    /// child inherits its parent's rules; a resumed one may hold old ones.
    rules_current: bool,
    rules_warned: bool,
    terminal: bool,
    stop_requested: bool,
    stats: RuntimeTaskStats,
}

struct State {
    session_id: String,
    restrictions: Vec<Value>,
    mode: PermissionMode,
    /// Variant ids each model lists (`provider/model`), once known.
    model_variants: HashMap<String, HashSet<String>>,
    /// Text blocks of this turn already delivered, so a reply read back after a
    /// reconnect does not repeat them.
    completed_blocks: HashSet<String>,
    commands: Vec<ProviderCommand>,
    context_windows: HashMap<String, u64>,
    /// Model of the latest step, for its context window.
    step_model: Option<String>,
    /// The model the session runs (`provider/model`), for effort switches.
    model: Option<String>,
    effort: Option<String>,
    active: bool,
    turn_usage: Usage,
    turn_cost: f64,
    turn_started: Option<std::time::Instant>,
    /// OpenCode id of the current turn's user message: the rewind anchor.
    current_message_id: Option<String>,
    pending: HashMap<String, Pending>,
    /// Tool call id -> (name, input), to recognize subagent calls.
    calls: HashMap<String, (String, Value)>,
    /// Provider child session id -> runtime bookkeeping. Child output stays out
    /// of the parent transcript; only compact lifecycle/progress is projected.
    children: HashMap<String, ChildRuntime>,
}

impl State {
    fn new(session_id: String, restrictions: Vec<Value>) -> Self {
        Self {
            session_id,
            restrictions,
            mode: PermissionMode::Supervised,
            model_variants: HashMap::new(),
            completed_blocks: HashSet::new(),
            commands: Vec::new(),
            context_windows: HashMap::new(),
            step_model: None,
            model: None,
            effort: None,
            active: false,
            turn_usage: Usage::default(),
            turn_cost: 0.0,
            turn_started: None,
            current_message_id: None,
            pending: HashMap::new(),
            calls: HashMap::new(),
            children: HashMap::new(),
        }
    }
}

struct OpencodeSession {
    server: Api,
    child: Mutex<Child>,
    events: mpsc::Sender<DriverEvent>,
    state: Mutex<State>,
}

struct Handle(
    Arc<OpencodeSession>,
    #[allow(dead_code)] std::sync::Mutex<Option<crate::process_tree::ProcessTree>>,
    #[allow(dead_code)] Option<crate::process_tree::SessionTask>,
);

/// Text and reasoning blocks are numbered within their assistant message.
fn block_id(data: &Value) -> String {
    let message = data["assistantMessageID"].as_str().unwrap_or("");
    match data["ordinal"].as_u64().unwrap_or(0) {
        0 => message.to_string(),
        ordinal => format!("{message}:{ordinal}"),
    }
}

/// v2 tool content is a list of typed blocks; v1 clients read text as `content`.
fn tool_output(data: &Value, is_error: bool) -> Value {
    let blocks = data["content"].as_array().cloned().unwrap_or_default();
    let text = blocks.iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
    let attachments: Vec<_> = blocks.iter().filter(|block| block["type"] != "text").cloned().collect();
    let content = if is_error { data.pointer("/error/message").cloned().unwrap_or(Value::Null) } else { json!(text) };
    json!({
        "content": content,
        "metadata": data.get("metadata"),
        "attachments": (!attachments.is_empty()).then_some(attachments),
    })
}

fn subagent_task(call_id: &str, input: &Value, child_id: &str, parent_id: Option<String>) -> DriverRuntimeTask {
    let title = input
        .get("description")
        .or_else(|| input.get("prompt"))
        .and_then(Value::as_str)
        .map(|value| value.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(value).chars().take(120).collect())
        .filter(|value: &String| !value.is_empty())
        .unwrap_or_else(|| "Subagent".into());
    let backgrounded = input.get("background").and_then(Value::as_bool) == Some(true);
    DriverRuntimeTask {
        id: format!("opencode:{child_id}"),
        kind: RuntimeTaskKind::Agent,
        status: RuntimeTaskStatus::Running,
        title,
        detail: None,
        provider_type: Some(input.get("agent").and_then(Value::as_str).map_or_else(|| "task".into(), |agent| format!("task:{agent}"))),
        parent_id,
        tool_call_id: Some(call_id.to_string()),
        provider_thread_id: Some(child_id.to_string()),
        model: None,
        effort: None,
        backgrounded,
        last_tool_name: None,
        usage: None,
        stats: RuntimeTaskStats::default(),
        capabilities: RuntimeTaskCapabilities { stop: true, background: false },
    }
}

fn child_session_task(data: &Value, parent_id: Option<String>) -> Option<(String, DriverRuntimeTask)> {
    let child_id = data["sessionID"].as_str()?.to_string();
    let title = data["title"]
        .as_str()
        .map(|value| value.rsplit_once(" (@").map_or(value, |(description, _)| description).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Subagent".into());
    let mut task = subagent_task("", &json!({ "description": title }), &child_id, parent_id);
    task.tool_call_id = None;
    task.provider_type = data["agent"].as_str().map(|agent| format!("task:{agent}"));
    Some((child_id, task))
}

/// A v2 form as the `opencode_question` input clients already render.
fn form_questions(form: &Value) -> (Value, Vec<FormField>) {
    let mut questions = Vec::new();
    let mut fields = Vec::new();
    for field in form["fields"].as_array().into_iter().flatten() {
        if field["hidden"] == true {
            continue;
        }
        let Some(key) = field["key"].as_str() else { continue };
        let kind = field["type"].as_str().unwrap_or("string").to_string();
        let mut options: Vec<(String, String, Option<String>)> = field["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|option| {
                let value = option["value"].as_str()?;
                let label = option["label"].as_str().unwrap_or(value);
                Some((label.to_string(), value.to_string(), option["description"].as_str().map(str::to_string)))
            })
            .collect();
        if kind == "boolean" {
            options = vec![("Yes".into(), "true".into(), None), ("No".into(), "false".into(), None)];
        }
        let title = field["title"].as_str();
        let description = field["description"].as_str();
        let question = description.or(title).unwrap_or(key);
        let custom = if kind == "boolean" { false } else { options.is_empty() || field["custom"] != false };
        questions.push(json!({
            "question": question,
            "header": description.and(title),
            "options": options.iter().map(|(label, _, description)| json!({ "label": label, "description": description })).collect::<Vec<_>>(),
            "multiple": kind == "multiselect",
            "custom": custom,
        }));
        fields.push(FormField {
            key: key.to_string(),
            kind,
            options: options.into_iter().map(|(label, value, _)| (label, value)).collect(),
        });
    }
    (json!({ "title": form["title"], "questions": questions, "form": form }), fields)
}

/// `{"answers": [[...], ...]}` (one list per question) as a v2 form answer.
fn form_answer(fields: &[FormField], response: &Value) -> Value {
    let answers = response["answers"].as_array().cloned().unwrap_or_default();
    let mut answer = serde_json::Map::new();
    for (field, chosen) in fields.iter().zip(answers) {
        let texts: Vec<String> = match &chosen {
            Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Value::String(text) => vec![text.clone()],
            _ => Vec::new(),
        };
        if texts.is_empty() {
            continue;
        }
        let value_of =
            |text: &String| field.options.iter().find(|(label, _)| label == text).map_or_else(|| text.clone(), |(_, v)| v.clone());
        let value = match field.kind.as_str() {
            "multiselect" => json!(texts.iter().map(value_of).collect::<Vec<_>>()),
            "boolean" => json!(value_of(&texts[0]) == "true"),
            "number" | "integer" => texts[0].trim().parse::<f64>().map_or_else(|_| json!(texts[0]), |n| json!(n)),
            _ => json!(texts.iter().map(value_of).collect::<Vec<_>>().join(", ")),
        };
        answer.insert(field.key.clone(), value);
    }
    Value::Object(answer)
}

struct Prompt {
    text: String,
    files: Vec<Value>,
    skills: Vec<Value>,
}

fn prompt(message: &UserMessage) -> Prompt {
    let mut text = String::new();
    let mut files = Vec::new();
    let mut skills = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text: value } => text.push_str(value),
            ContentPart::FileMention { path } => {
                text.push('@');
                text.push_str(path);
            }
            ContentPart::ThreadReference { thread_id, title, .. } => text.push_str(&thread_reference_text(*thread_id, title)),
            ContentPart::Skill { name, .. } => {
                // v2 activates attached skills itself; the slash keeps the text readable.
                text.push('/');
                text.push_str(name);
                skills.push(json!({ "id": name }));
            }
            ContentPart::Mention { name, .. } => {
                text.push('@');
                text.push_str(name);
            }
            ContentPart::Image { media_type, data } => {
                files.push(json!({ "uri": format!("data:{media_type};base64,{data}"), "name": "image" }))
            }
            ContentPart::Attachment { name, .. } => text.push_str(&format!("[attached file: {name}]")),
            ContentPart::Media { .. } => text.push_str("[image]"),
            ContentPart::ThreadMessage { .. } | ContentPart::AgentResults { .. } | ContentPart::SystemRow { .. } => {
                if let Some(value) = part.orchestration_text() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&value);
                }
            }
        }
    }
    Prompt { text, files, skills }
}

impl OpencodeSession {
    async fn emit(&self, event: DriverEvent) {
        let _ = self.events.send(event).await;
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self.server.request(method, path).timeout(std::time::Duration::from_secs(120));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(net)?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(DriverError::Protocol(format!("opencode {path}: {status} {}", text.chars().take(500).collect::<String>())));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn discover_metadata(&self) {
        let (commands, models) = tokio::join!(self.call(Method::GET, "/api/command", None), self.call(Method::GET, "/api/model", None));
        if let Ok(value) = commands {
            let commands = crate::provider_commands(&value["data"]);
            self.state.lock().await.commands = commands.clone();
            self.emit(DriverEvent::CommandsUpdated(commands)).await;
        }
        if let Ok(value) = models {
            let models = value["data"].as_array().map(Vec::as_slice).unwrap_or_default();
            let key = |model: &Value| Some(format!("{}/{}", model["providerID"].as_str()?, model["id"].as_str()?));
            let windows = models.iter().filter_map(|model| Some((key(model)?, model_window(model.get("limit")?)?))).collect();
            let variants: HashMap<String, HashSet<String>> = models
                .iter()
                .filter_map(|model| {
                    let ids = model["variants"].as_array()?.iter().filter_map(|variant| variant["id"].as_str().map(str::to_string));
                    Some((key(model)?, ids.collect()))
                })
                .collect();
            super::remember_windows(&windows);
            let mut state = self.state.lock().await;
            state.context_windows = windows;
            state.model_variants = variants;
        }
    }

    async fn event_loop(self: Arc<Self>, first: Option<reqwest::Response>) {
        self.event_loop_with(first, SILENT_STREAM_TIMEOUT).await
    }

    /// Read events until the server exits. A stream that closes, breaks or goes
    /// silent is subscribed again, and the turn it may have lost the end of is
    /// settled from the stored messages.
    async fn event_loop_with(self: Arc<Self>, mut first: Option<reqwest::Response>, silence: std::time::Duration) {
        let mut backoff = 200u64;
        let mut reconnect = false;
        loop {
            let response = match first.take() {
                Some(response) => Some(response),
                None => tokio::time::timeout(SUBSCRIBE_TIMEOUT, self.server.request(Method::GET, "/api/event").send())
                    .await
                    .ok()
                    .and_then(|response| response.ok()),
            };
            if let Some(response) = response.filter(|response| response.status().is_success()) {
                backoff = 200;
                if reconnect {
                    self.settle_after_reconnect().await;
                }
                reconnect = true;
                let this = &*self;
                read_frames(response.bytes_stream(), silence, |event| async move { this.handle_event(&event).await }).await;
            }
            if let Ok(Some(status)) = self.child.lock().await.try_wait() {
                let code = status.code();
                self.emit(DriverEvent::Exited {
                    code,
                    error: code.filter(|c| *c != 0).map(|c| format!("opencode serve exited with code {c}")),
                })
                .await;
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(backoff)).await;
            backoff = (backoff * 2).min(5000);
        }
    }

    /// The event stream was down, so the end of the running turn may have gone
    /// by. Read what OpenCode stored: if the session stopped running, finish
    /// the turn the way its idle message says, with the reply text it was missing.
    async fn settle_after_reconnect(&self) {
        let (session_id, message_id) = {
            let state = self.state.lock().await;
            match (state.active, &state.current_message_id) {
                (true, Some(message)) => (state.session_id.clone(), message.clone()),
                _ => return,
            }
        };
        let read = |path: String| async move { self.server_call(Method::GET, &path, None, RECONCILE_CALL_TIMEOUT).await };
        let Ok(active) = read("/api/session/active".into()).await else { return };
        if active["data"].get(&session_id).is_some() {
            return;
        }
        let Ok(page) = read(format!("/api/session/{session_id}/message?order=desc&limit=50")).await else { return };
        // Newest first. The turn is what follows its prompt; a prompt that is not
        // stored yet leaves nothing to settle.
        let messages = page["data"].as_array().map(Vec::as_slice).unwrap_or_default();
        let Some(start) = messages.iter().position(|message| message["id"].as_str() == Some(&message_id)) else { return };
        let turn = &messages[..start];
        let idle = turn.iter().find(|message| message["type"] == "idle");
        let replies: Vec<&Value> = turn.iter().rev().filter(|message| message["type"] == "assistant").collect();
        if idle.is_none() && replies.is_empty() {
            return;
        }
        for reply in replies {
            for (ordinal, part) in reply["content"].as_array().into_iter().flatten().filter(|part| part["type"] == "text").enumerate() {
                let block = block_id(&json!({ "assistantMessageID": reply["id"], "ordinal": ordinal }));
                let text = part["text"].as_str().unwrap_or("");
                if text.is_empty() || !self.state.lock().await.completed_blocks.insert(block.clone()) {
                    continue;
                }
                self.emit(DriverEvent::MessageCompleted {
                    message_id: block,
                    origin: EventOrigin::Root,
                    text: text.to_string(),
                    thinking: None,
                })
                .await;
            }
        }
        match idle.and_then(|idle| idle["outcome"].as_str()) {
            Some("succeeded") => self.finish_turn(StopReason::Completed).await,
            Some("failed") => {
                let text = "OpenCode ended the turn with an error while Kybern was reconnecting. Send the message again.".to_string();
                self.fail_turn(text, None).await;
            }
            // Without an idle message the execution was lost: nothing is running it.
            _ => self.finish_turn(StopReason::Interrupted).await,
        }
    }

    /// One request with its own time limit.
    async fn server_call(&self, method: Method, path: &str, body: Option<Value>, timeout: std::time::Duration) -> Result<Value> {
        let mut request = self.server.request(method, path).timeout(timeout);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(net)?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(DriverError::Protocol(format!("opencode {path}: {status} {}", text.chars().take(500).collect::<String>())));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// The turn ended with `stop_reason`.
    async fn finish_turn(&self, stop_reason: StopReason) {
        let (usage, cost, duration_ms, active, anchors) = {
            let mut state = self.state.lock().await;
            let active = std::mem::take(&mut state.active);
            let duration = state.turn_started.take().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
            let anchors = crate::TurnAnchors { turn_id: state.current_message_id.take(), previous_end: None };
            (std::mem::take(&mut state.turn_usage), state.turn_cost, duration, active, anchors)
        };
        if active {
            self.emit(DriverEvent::TurnCompleted { stop_reason, usage, cost_usd: Some(cost), duration_ms, anchors }).await;
        }
    }

    /// The turn failed with `text`; between turns it is only a notice.
    async fn fail_turn(&self, text: String, error: Option<&Value>) {
        let active = {
            let mut state = self.state.lock().await;
            state.turn_started = None;
            std::mem::take(&mut state.active)
        };
        if active {
            self.emit(DriverEvent::turn_failed(ProviderKind::Opencode, text)).await;
        } else {
            self.emit(DriverEvent::Notice { level: NoticeLevel::Error, text, data: error.cloned() }).await;
        }
    }

    async fn handle_event(&self, event: &Value) {
        let ty = event["type"].as_str().unwrap_or("");
        let data = &event["data"];
        let sid = data["sessionID"].as_str().unwrap_or("");
        let (mine, child_task) = {
            let state = self.state.lock().await;
            (state.session_id == sid, state.children.get(sid).map(|child| child.task_id.clone()))
        };
        match ty {
            "session.created" => {
                let parent = data["parentID"].as_str();
                let parent_task = {
                    let state = self.state.lock().await;
                    match parent {
                        Some(parent) if parent == state.session_id => Some(None),
                        Some(parent) => state.children.get(parent).map(|child| Some(child.task_id.clone())),
                        None => None,
                    }
                };
                if let Some(parent_task) = parent_task
                    && let Some((child_id, task)) = child_session_task(data, parent_task)
                {
                    self.observe_child(child_id, task, true).await;
                }
                return;
            }
            "permission.asked" if mine || child_task.is_some() => return self.permission_asked(data).await,
            "form.created" => {
                let form = &data["form"];
                let form_session = form["sessionID"].as_str().unwrap_or("");
                let known = {
                    let state = self.state.lock().await;
                    state.session_id == form_session || state.children.contains_key(form_session)
                };
                if known {
                    self.form_created(form).await;
                }
                return;
            }
            "permission.replied" | "form.replied" | "form.cancelled" => {
                let id = data["requestID"].as_str().or_else(|| data["id"].as_str()).unwrap_or("").to_string();
                if self.state.lock().await.pending.remove(&id).is_some() {
                    self.emit(DriverEvent::PermissionWithdrawn { request_id: id }).await;
                }
                return;
            }
            _ => {}
        }
        if let Some(task_id) = child_task {
            return self.handle_child_event(sid, &task_id, ty, data).await;
        }
        if !mine {
            return;
        }
        match ty {
            "session.execution.started" => {
                let mut state = self.state.lock().await;
                if !state.active {
                    state.active = true;
                    state.turn_started = Some(std::time::Instant::now());
                    state.turn_usage = Usage::default();
                    state.turn_cost = 0.0;
                }
            }
            "session.text.delta" => {
                let delta = data["delta"].as_str().unwrap_or("").to_string();
                self.emit(DriverEvent::TextDelta { message_id: block_id(data), origin: EventOrigin::Root, delta }).await;
            }
            "session.text.ended" => {
                let text = data["text"].as_str().unwrap_or("").to_string();
                if !text.is_empty() {
                    self.state.lock().await.completed_blocks.insert(block_id(data));
                    self.emit(DriverEvent::MessageCompleted {
                        message_id: block_id(data),
                        origin: EventOrigin::Root,
                        text,
                        thinking: None,
                    })
                    .await;
                }
            }
            "session.reasoning.delta" => {
                let delta = data["delta"].as_str().unwrap_or("").to_string();
                self.emit(DriverEvent::ThinkingDelta { message_id: block_id(data), origin: EventOrigin::Root, delta }).await;
            }
            "session.reasoning.ended" => {
                self.emit(DriverEvent::ThinkingCompleted { message_id: block_id(data), origin: EventOrigin::Root }).await;
            }
            "session.tool.called" => {
                let id = data["id"].as_str().unwrap_or("").to_string();
                let input = data.get("input").cloned().unwrap_or(Value::Null);
                let name = {
                    let mut state = self.state.lock().await;
                    // `tool.input.started` carries the name; keep the input with it.
                    let name = state.calls.get(&id).map(|(name, _)| name.clone()).unwrap_or_else(|| "tool".into());
                    state.calls.insert(id.clone(), (name.clone(), input.clone()));
                    name
                };
                self.emit(DriverEvent::ToolStarted(ToolCall { id, name, input, parent_id: None })).await;
            }
            "session.tool.input.started" => {
                let id = data["id"].as_str().unwrap_or("").to_string();
                let name = data["name"].as_str().unwrap_or("tool").to_string();
                self.state.lock().await.calls.insert(id, (name, Value::Null));
            }
            "session.tool.progress" => {
                let id = data["id"].as_str().unwrap_or("");
                let child = data.pointer("/metadata/sessionID").and_then(Value::as_str);
                let call = self.state.lock().await.calls.get(id).cloned();
                if let (Some(child_id), Some((name, input))) = (child, call)
                    && name == "subagent"
                {
                    self.observe_child(child_id.to_string(), subagent_task(id, &input, child_id, None), false).await;
                }
            }
            "session.tool.success" | "session.tool.failed" => {
                let id = data["id"].as_str().unwrap_or("").to_string();
                let is_error = ty == "session.tool.failed";
                self.state.lock().await.calls.remove(&id);
                self.emit(DriverEvent::ToolCompleted { tool_call_id: id, output: tool_output(data, is_error), is_error }).await;
            }
            "session.step.started" => {
                self.state.lock().await.step_model = model_key(&data["model"]);
            }
            "session.step.ended" => {
                let tokens = &data["tokens"];
                let count = |path: &str| tokens.pointer(path).and_then(Value::as_u64).unwrap_or(0);
                let window = {
                    let mut state = self.state.lock().await;
                    state.turn_usage.input_tokens += count("/input");
                    state.turn_usage.output_tokens += count("/output") + count("/reasoning");
                    state.turn_usage.cache_read_tokens += count("/cache/read");
                    state.turn_usage.cache_write_tokens += count("/cache/write");
                    state.turn_cost += data["cost"].as_f64().unwrap_or(0.0);
                    state.step_model.as_ref().and_then(|model| state.context_windows.get(model).copied())
                };
                if let Some(window_tokens) = window {
                    let used_tokens = ["/input", "/output", "/reasoning", "/cache/read", "/cache/write"].iter().map(|p| count(p)).sum();
                    self.emit(DriverEvent::UsageUpdated(ProviderUsage {
                        context: Some(ContextUsage { used_tokens, window_tokens }),
                        limits: None,
                        prompt_cache: None,
                    }))
                    .await;
                }
            }
            "session.retry.scheduled" => {
                let text = data.pointer("/error/message").or_else(|| data.get("message")).and_then(Value::as_str).unwrap_or("retrying");
                self.emit(DriverEvent::Notice { level: NoticeLevel::Warning, text: text.to_string(), data: None }).await;
            }
            "session.compaction.ended" => {
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "context compacted".into(), data: None }).await
            }
            "session.compaction.failed" => {
                let text = data.pointer("/error/message").and_then(Value::as_str).unwrap_or("compaction failed");
                self.emit(DriverEvent::Notice { level: NoticeLevel::Error, text: text.to_string(), data: Some(data.clone()) }).await
            }
            "session.execution.succeeded" => self.finish_turn(StopReason::Completed).await,
            "session.execution.interrupted" => self.finish_turn(StopReason::Interrupted).await,
            "session.execution.failed" => {
                let error = &data["error"];
                let kind = error["type"].as_str().unwrap_or("error");
                let message = error["message"].as_str().unwrap_or("");
                self.fail_turn(format!("{kind}: {message}"), Some(error)).await;
            }
            _ => {}
        }
    }

    async fn permission_asked(&self, data: &Value) {
        let id = data["id"].as_str().unwrap_or("").to_string();
        let session = data["sessionID"].as_str().unwrap_or("").to_string();
        let action = data["action"].as_str().unwrap_or("tool").to_string();
        let resources = data.get("resources").cloned().unwrap_or(json!([]));
        let first = resources.as_array().and_then(|list| list.first()).and_then(Value::as_str).unwrap_or("");
        let first = first.lines().next().unwrap_or("").chars().take(120).collect::<String>();
        let summary = match action.as_str() {
            "shell" => format!("run: {first}"),
            _ if first.is_empty() => action.clone(),
            _ => format!("{action}: {first}"),
        };
        let input = json!({
            "permission": action,
            "patterns": resources,
            "metadata": data.get("metadata").cloned().unwrap_or(Value::Null),
            "message": data.get("message"),
        });
        let suggestions = data["save"].as_array().cloned().unwrap_or_default();
        self.state.lock().await.pending.insert(id.clone(), Pending::Permission { session });
        self.emit(DriverEvent::PermissionRequest {
            request_id: id,
            tool_call_id: data.pointer("/source/id").and_then(Value::as_str).map(str::to_string),
            tool_name: action,
            input,
            summary,
            suggestions,
        })
        .await;
    }

    async fn form_created(&self, form: &Value) {
        let id = form["id"].as_str().unwrap_or("").to_string();
        let session = form["sessionID"].as_str().unwrap_or("").to_string();
        let (input, fields) = form_questions(form);
        if fields.is_empty() {
            return;
        }
        let summary = match form.pointer("/metadata/kind").and_then(Value::as_str) {
            Some("question") | None => "Answer the agent's questions".to_string(),
            Some(_) => form["title"].as_str().unwrap_or("Answer the agent's questions").to_string(),
        };
        self.state.lock().await.pending.insert(id.clone(), Pending::Form { session, fields });
        self.emit(DriverEvent::PermissionRequest {
            request_id: id,
            tool_call_id: form.pointer("/metadata/tool/id").and_then(Value::as_str).map(str::to_string),
            tool_name: "opencode_question".into(),
            input,
            summary,
            suggestions: vec![],
        })
        .await;
    }

    /// A subagent session showed up (or showed up again). `created` is true when
    /// the server just made it: it inherits its parent's rules in full. Any
    /// other child may hold the rules of an earlier mode, so it gets the
    /// current ones before it is announced.
    async fn observe_child(&self, child_id: String, task: DriverRuntimeTask, created: bool) {
        let stale = {
            let mut state = self.state.lock().await;
            let child = state.children.entry(child_id.clone()).or_default();
            // A new tool call for a finished child resumes it: its earlier end
            // must not swallow the new run's, and its rules may be old.
            let resumed = child.terminal && matches!((&child.call_id, &task.tool_call_id), (Some(old), Some(new)) if old != new);
            if resumed {
                child.terminal = false;
                child.stop_requested = false;
                child.rules_current = false;
            }
            if task.tool_call_id.is_some() {
                child.call_id = task.tool_call_id.clone();
            }
            child.task_id = task.id.clone();
            child.rules_current |= created;
            !child.rules_current
        };
        if stale {
            self.write_child_rules(&child_id).await;
        }
        self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
    }

    /// This thread's rules for `mode`: the mode's, then the coordinator's scope.
    fn mode_rules(&self, state: &State, mode: PermissionMode) -> Vec<Value> {
        ruleset(mode).into_iter().chain(state.restrictions.iter().cloned()).collect()
    }

    /// Replace a subagent's rules with this thread's current ones.
    async fn write_child_rules(&self, child_id: &str) {
        let rules = {
            let state = self.state.lock().await;
            self.mode_rules(&state, state.mode)
        };
        let body = Some(json!({ "permissions": rules }));
        match self.server_call(Method::PATCH, &format!("/api/session/{child_id}"), body, CHILD_RULES_TIMEOUT).await {
            Ok(_) => {
                if let Some(child) = self.state.lock().await.children.get_mut(child_id) {
                    child.rules_current = true;
                }
            }
            Err(error) => {
                tracing::warn!(%error, child_id, "could not write approval rules into an OpenCode subagent");
                let first = self
                    .state
                    .lock()
                    .await
                    .children
                    .get_mut(child_id)
                    .is_some_and(|child| !std::mem::replace(&mut child.rules_warned, true));
                if first {
                    self.emit(DriverEvent::Notice {
                        level: NoticeLevel::Warning,
                        text: "A subagent could not get this thread's approval rules and may follow an older mode. Stop it and ask again."
                            .into(),
                        data: None,
                    })
                    .await;
                }
            }
        }
    }

    async fn update_child(
        &self,
        child_id: &str,
        status: Option<RuntimeTaskStatus>,
        detail: Option<String>,
        last_tool_name: Option<String>,
        stats: Option<RuntimeTaskStats>,
        terminal: bool,
    ) {
        let task_id = {
            let mut state = self.state.lock().await;
            let Some(child) = state.children.get_mut(child_id) else { return };
            if child.terminal {
                return;
            }
            child.terminal = terminal;
            child.task_id.clone()
        };
        let update = DriverRuntimeTaskUpdate {
            id: task_id,
            status,
            detail,
            backgrounded: None,
            last_tool_name,
            usage: None,
            stats,
            capabilities: terminal.then(RuntimeTaskCapabilities::default),
        };
        self.emit(if terminal { DriverEvent::RuntimeTaskCompleted(update) } else { DriverEvent::RuntimeTaskUpdated(update) }).await;
    }

    async fn emit_child(&self, task_id: &str, event: DriverEvent) {
        self.emit(DriverEvent::SubagentOnly { task_id: task_id.to_string(), event: Box::new(event) }).await;
    }

    /// A subagent's own text, reasoning and tool calls go to its thread. Its
    /// launch prompt is an inbox item, never an assistant event.
    async fn handle_child_event(&self, session_id: &str, task_id: &str, ty: &str, data: &Value) {
        match ty {
            "session.text.delta" => {
                let delta = data["delta"].as_str().unwrap_or("").to_string();
                self.emit_child(task_id, DriverEvent::TextDelta { message_id: block_id(data), origin: EventOrigin::Root, delta }).await;
            }
            "session.text.ended" => {
                let text = data["text"].as_str().unwrap_or("").to_string();
                if !text.is_empty() {
                    let event =
                        DriverEvent::MessageCompleted { message_id: block_id(data), origin: EventOrigin::Root, text, thinking: None };
                    self.emit_child(task_id, event).await;
                }
            }
            "session.reasoning.delta" => {
                let delta = data["delta"].as_str().unwrap_or("").to_string();
                self.emit_child(task_id, DriverEvent::ThinkingDelta { message_id: block_id(data), origin: EventOrigin::Root, delta }).await;
            }
            "session.reasoning.ended" => {
                self.emit_child(task_id, DriverEvent::ThinkingCompleted { message_id: block_id(data), origin: EventOrigin::Root }).await;
            }
            "session.tool.input.started" => {
                let id = data["id"].as_str().unwrap_or("").to_string();
                let name = data["name"].as_str().unwrap_or("tool").to_string();
                self.state.lock().await.calls.insert(id, (name, Value::Null));
            }
            "session.tool.called" => {
                let id = data["id"].as_str().unwrap_or("").to_string();
                let input = data.get("input").cloned().unwrap_or(Value::Null);
                let (name, stats) = {
                    let mut state = self.state.lock().await;
                    let name = state.calls.get(&id).map(|(name, _)| name.clone()).unwrap_or_else(|| "tool".into());
                    state.calls.insert(id.clone(), (name.clone(), input.clone()));
                    let Some(child) = state.children.get_mut(session_id) else { return };
                    child.stats.tool_uses = Some(child.stats.tool_uses.unwrap_or(0) + 1);
                    (name, child.stats.clone())
                };
                self.emit_child(task_id, DriverEvent::ToolStarted(ToolCall { id, name: name.clone(), input, parent_id: None })).await;
                self.update_child(session_id, Some(RuntimeTaskStatus::Running), None, Some(name), Some(stats), false).await;
            }
            "session.tool.progress" => {
                // A subagent's own subagent.
                let id = data["id"].as_str().unwrap_or("");
                let child = data.pointer("/metadata/sessionID").and_then(Value::as_str);
                let call = self.state.lock().await.calls.get(id).cloned();
                if let (Some(child_id), Some((name, input))) = (child, call)
                    && name == "subagent"
                {
                    self.observe_child(child_id.to_string(), subagent_task(id, &input, child_id, Some(task_id.to_string())), false).await;
                }
            }
            "session.tool.success" | "session.tool.failed" => {
                let id = data["id"].as_str().unwrap_or("").to_string();
                let is_error = ty == "session.tool.failed";
                self.state.lock().await.calls.remove(&id);
                self.emit_child(task_id, DriverEvent::ToolCompleted { tool_call_id: id, output: tool_output(data, is_error), is_error })
                    .await;
            }
            "session.step.ended" => {
                let tokens = &data["tokens"];
                let count = |path: &str| tokens.pointer(path).and_then(Value::as_u64).unwrap_or(0);
                let step = count("/input") + count("/output") + count("/reasoning") + count("/cache/write");
                let stats = {
                    let mut state = self.state.lock().await;
                    let Some(child) = state.children.get_mut(session_id) else { return };
                    child.stats.token_count = Some(child.stats.token_count.unwrap_or(0) + step);
                    child.stats.clone()
                };
                self.update_child(session_id, Some(RuntimeTaskStatus::Running), None, None, Some(stats), false).await;
            }
            "session.retry.scheduled" => {
                let detail = data.pointer("/error/message").and_then(Value::as_str).map(str::to_string);
                self.update_child(session_id, Some(RuntimeTaskStatus::Waiting), detail, None, None, false).await;
            }
            "session.execution.succeeded" | "session.execution.interrupted" | "session.execution.failed" => {
                let stop_requested = self.state.lock().await.children.get(session_id).is_some_and(|child| child.stop_requested);
                let (status, detail) = match ty {
                    _ if stop_requested => (RuntimeTaskStatus::Stopped, None),
                    "session.execution.succeeded" => (RuntimeTaskStatus::Completed, None),
                    "session.execution.interrupted" => (RuntimeTaskStatus::Stopped, None),
                    _ => (RuntimeTaskStatus::Failed, data.pointer("/error/message").and_then(Value::as_str).map(str::to_string)),
                };
                self.update_child(session_id, Some(status), detail, None, None, true).await;
            }
            _ => {}
        }
    }

    async fn stop_child(&self, session_id: &str) -> Result<()> {
        {
            let mut state = self.state.lock().await;
            let child = state
                .children
                .get_mut(session_id)
                .filter(|child| !child.terminal)
                .ok_or_else(|| DriverError::Unsupported("OpenCode child session is no longer active".into()))?;
            child.stop_requested = true;
        }
        if let Err(error) = self.call(Method::POST, &format!("/api/session/{session_id}/interrupt"), None).await {
            if let Some(child) = self.state.lock().await.children.get_mut(session_id) {
                child.stop_requested = false;
            }
            return Err(error);
        }
        self.update_child(session_id, Some(RuntimeTaskStatus::Stopped), Some("Stopped by user".into()), None, None, true).await;
        Ok(())
    }

    /// Queue (`send_message`) or steer a prompt; returns its message id.
    async fn submit(&self, message: &UserMessage, delivery: Option<&str>) -> Result<Option<String>> {
        let (session_id, commands) = {
            let state = self.state.lock().await;
            (state.session_id.clone(), state.commands.clone())
        };
        let prompt = prompt(message);
        // Only advertised commands are routed to /command; prose stays prose.
        let command = prompt.skills.is_empty().then(|| prompt.text.trim().strip_prefix('/')).flatten().and_then(|rest| {
            let (name, arguments) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            commands.iter().any(|command| command.name == name).then(|| (name.to_string(), arguments.trim().to_string()))
        });
        let mut body = match &command {
            Some((name, arguments)) => json!({ "name": name, "text": arguments, "files": prompt.files }),
            None => json!({ "text": prompt.text, "files": prompt.files, "skills": prompt.skills }),
        };
        if let Some(delivery) = delivery {
            body["delivery"] = json!(delivery);
        }
        let path = if command.is_some() { "command" } else { "prompt" };
        let value = self.call(Method::POST, &format!("/api/session/{session_id}/{path}"), Some(body)).await?;
        Ok(value.pointer("/data/id").and_then(Value::as_str).map(str::to_string))
    }

    async fn begin_turn(&self) {
        let mut state = self.state.lock().await;
        state.active = true;
        state.turn_started = Some(std::time::Instant::now());
        state.turn_usage = Usage::default();
        state.turn_cost = 0.0;
        state.current_message_id = None;
        state.completed_blocks.clear();
    }
}

#[async_trait]
impl AgentSession for Handle {
    async fn compact(&self) -> Result<()> {
        let s = &self.0;
        let session_id = s.state.lock().await.session_id.clone();
        s.begin_turn().await;
        s.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "Compacting context…".into(), data: None }).await;
        // Compaction runs as its own execution; its succeeded event ends the turn.
        if let Err(error) = s.call(Method::POST, &format!("/api/session/{session_id}/compact"), Some(json!({}))).await {
            s.state.lock().await.active = false;
            return Err(error);
        }
        Ok(())
    }

    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let s = &self.0;
        s.begin_turn().await;
        match s.submit(message, None).await {
            Ok(id) => {
                // The returned user message id anchors rewinds (`fork` before it).
                let mut state = s.state.lock().await;
                if state.active {
                    state.current_message_id = id;
                }
                Ok(())
            }
            Err(error) => {
                s.state.lock().await.active = false;
                Err(error)
            }
        }
    }

    async fn steer(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        if !self.0.state.lock().await.active {
            return Err(DriverError::Unsupported("OpenCode is not running a turn. Send the message instead.".into()));
        }
        self.0.submit(message, Some("steer")).await.map(|_| ())
    }

    async fn interrupt(&self) -> Result<()> {
        let s = &self.0;
        let session_id = s.state.lock().await.session_id.clone();
        s.call(Method::POST, &format!("/api/session/{session_id}/interrupt"), None).await.map(|_| ())
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        let s = &self.0;
        let (session_id, rules, children) = {
            let mut state = s.state.lock().await;
            state.mode = mode;
            let children: Vec<String> = state.children.iter().filter(|(_, child)| !child.terminal).map(|(id, _)| id.clone()).collect();
            (state.session_id.clone(), s.mode_rules(&state, mode), children)
        };
        s.call(Method::PATCH, &format!("/api/session/{session_id}"), Some(json!({ "permissions": rules }))).await?;
        // OpenCode copies a parent's rules into a subagent once, when it is made,
        // so running subagents keep the old mode unless they are rewritten too.
        for child in children {
            s.write_child_rules(&child).await;
        }
        Ok(())
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        let s = &self.0;
        // A variant the new model does not list makes OpenCode refuse the turn, so
        // it is left off; the choice itself stays for a model that lists it.
        let effort = {
            let state = s.state.lock().await;
            let bare = model.split('#').next().unwrap_or(model);
            let listed = state.model_variants.get(bare);
            state.effort.clone().filter(|effort| listed.is_none_or(|variants| variants.contains(effort.trim())))
        };
        let reference = model_ref(model, effort.as_deref())
            .ok_or_else(|| DriverError::Unsupported(format!("OpenCode models are named provider/model, got {model}")))?;
        let session_id = s.state.lock().await.session_id.clone();
        s.call(Method::POST, &format!("/api/session/{session_id}/model"), Some(json!({ "model": reference }))).await.map(|_| ())?;
        let bare = model.split('#').next().unwrap_or(model).to_string();
        s.state.lock().await.model = Some(bare);
        Ok(())
    }

    async fn set_effort(&self, effort: &str) -> Result<()> {
        let s = &self.0;
        let current = s.state.lock().await.model.clone();
        let Some(model) = current else {
            return Err(DriverError::Unsupported("Pick an OpenCode model first, then change its effort.".into()));
        };
        let bare = model.split('#').next().unwrap_or(&model).to_string();
        let reference = model_ref(&bare, Some(effort))
            .ok_or_else(|| DriverError::Unsupported(format!("OpenCode models are named provider/model, got {model}")))?;
        let session_id = s.state.lock().await.session_id.clone();
        s.call(Method::POST, &format!("/api/session/{session_id}/model"), Some(json!({ "model": reference }))).await?;
        let mut state = s.state.lock().await;
        state.model = Some(bare);
        state.effort = Some(effort.to_string());
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let s = &self.0;
        let pending = s.state.lock().await.pending.remove(request_id);
        let Some(pending) = pending else {
            return Err(DriverError::Protocol(format!("no pending permission {request_id}")));
        };
        let result = match &pending {
            Pending::Form { session, fields } => match decision {
                ApprovalDecision::Submit { response } => {
                    let body = json!({ "answer": form_answer(fields, response) });
                    s.call(Method::POST, &format!("/api/session/{session}/form/{request_id}/reply"), Some(body)).await
                }
                ApprovalDecision::Deny { .. } => s.call(Method::DELETE, &format!("/api/session/{session}/form/{request_id}"), None).await,
                _ => Err(DriverError::Protocol("this question needs an answer".into())),
            },
            Pending::Permission { session } => {
                let (reply, message) = match decision {
                    ApprovalDecision::Submit { .. } => return Err(DriverError::Protocol("expected permission decision".into())),
                    ApprovalDecision::AllowOnce => ("once", None),
                    ApprovalDecision::AllowAlways => ("always", None),
                    ApprovalDecision::Deny { reason } => ("reject", reason.clone()),
                };
                let body = json!({ "decision": reply, "message": message });
                s.call(Method::POST, &format!("/api/session/{session}/permission/{request_id}/reply"), Some(body)).await
            }
        };
        if result.is_err() {
            s.state.lock().await.pending.insert(request_id.to_string(), pending);
        }
        result.map(|_| ())
    }

    async fn stop_runtime_task(&self, task: &RuntimeTask) -> Result<()> {
        let session_id = task
            .provider_thread_id
            .as_deref()
            .ok_or_else(|| DriverError::Unsupported("OpenCode did not expose the child session id needed to stop this task".into()))?;
        self.0.stop_child(session_id).await
    }

    async fn close(&self) -> Result<()> {
        self.1.lock().unwrap().take();
        let _ = self.0.child.lock().await.kill().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
