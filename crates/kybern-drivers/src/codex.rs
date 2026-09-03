//! Codex driver: speaks `codex app-server` (JSON-RPC 2.0 without the
//! `jsonrpc` member, newline-delimited over stdio).
//!
//! One app-server process per kybern thread, hosting one Codex thread. The
//! server sends requests of its own for approvals; those become permission
//! requests and are answered by id.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use async_trait::async_trait;
use base64::Engine;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::binary::{at_least, resolve, version_of};
use crate::ndjson::NdjsonChild;
use crate::{
    AgentDriver, AgentSession, DriverError, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, Result, SessionConfig, SpawnedSession,
};

const MIN_VERSION: (u64, u64, u64) = (0, 140, 0);

#[derive(Default)]
pub struct CodexDriver;

async fn catalog_call(child: &NdjsonChild, id: i64, method: &str, params: Value) -> Option<Value> {
    child.write(&json!({ "id": id, "method": method, "params": params })).await.ok()?;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let frame = {
                let mut lines = child.lines.lock().await;
                lines.recv().await?
            };
            if frame.get("id").and_then(Value::as_i64) == Some(id) {
                return frame.get("result").cloned();
            }
            if let (Some(request_id), Some(_)) = (frame.get("id"), frame.get("method")) {
                let _ = child
                    .write(&json!({ "id": request_id, "error": { "code": -32601, "message": "unsupported during model discovery" } }))
                    .await;
            }
        }
    })
    .await
    .ok()
    .flatten()
}

async fn codex_models(bin: &std::path::Path) -> Vec<ProviderModel> {
    let mut cmd = Command::new(bin);
    cmd.arg("app-server");
    let child = match NdjsonChild::spawn(cmd) {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };
    let initialized = catalog_call(
        &child,
        1,
        "initialize",
        json!({
            "clientInfo": { "name": "kybern", "title": "Kybern", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": false }
        }),
    )
    .await
    .is_some();
    if !initialized {
        child.kill().await;
        return Vec::new();
    }
    if child.write(&json!({ "method": "initialized" })).await.is_err() {
        child.kill().await;
        return Vec::new();
    }

    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..10i64 {
        let Some(result) =
            catalog_call(&child, page + 2, "model/list", json!({ "limit": 100, "cursor": cursor, "includeHidden": false })).await
        else {
            break;
        };
        if let Some(items) = result.get("data").and_then(Value::as_array) {
            models.extend(items.iter().filter_map(|item| {
                if item.get("hidden").and_then(Value::as_bool).unwrap_or(false) {
                    return None;
                }
                let id = item.get("model").or_else(|| item.get("id")).and_then(Value::as_str)?.to_string();
                let display_name = item.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
                let efforts = item
                    .get("supportedReasoningEfforts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|option| option.get("reasoningEffort").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect();
                Some(ProviderModel {
                    id,
                    display_name,
                    provider: None,
                    efforts,
                    default_effort: item.get("defaultReasoningEffort").and_then(Value::as_str).map(str::to_string),
                    is_default: item.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                })
            }));
        }
        cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    child.kill().await;
    models
}

/// Ask Codex's own app-server for its effective skill catalog. This preserves
/// plugin namespaces, disabled state, and repo/system precedence that cannot be
/// reconstructed reliably from a blind filesystem walk.
pub async fn discover_skills(cwd: &std::path::Path, binary: Option<&PathBuf>) -> Option<Vec<SkillInfo>> {
    let bin = resolve(ProviderKind::Codex, binary).ok()?;
    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd).arg("app-server");
    let child = NdjsonChild::spawn(cmd).ok()?;
    let initialized = catalog_call(
        &child,
        1,
        "initialize",
        json!({
            "clientInfo": { "name": "kybern", "title": "Kybern", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": false }
        }),
    )
    .await
    .is_some();
    if !initialized || child.write(&json!({ "method": "initialized" })).await.is_err() {
        child.kill().await;
        return None;
    }

    let cwd_text = cwd.to_string_lossy().to_string();
    let result = catalog_call(&child, 2, "skills/list", json!({ "cwds": [&cwd_text] })).await;
    child.kill().await;
    let result = result?;
    let entries = result.get("data")?.as_array()?;
    let entry =
        entries.iter().find(|entry| entry.get("cwd").and_then(Value::as_str) == Some(cwd_text.as_str())).or_else(|| entries.first())?;
    let skills = entry
        .get("skills")?
        .as_array()?
        .iter()
        .filter_map(|skill| {
            let name = skill.get("name")?.as_str()?.trim();
            let path = skill.get("path")?.as_str()?.trim();
            if name.is_empty() || path.is_empty() {
                return None;
            }
            let interface = skill.get("interface");
            let display_name = interface
                .and_then(|value| value.get("displayName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let description = skill
                .get("shortDescription")
                .and_then(Value::as_str)
                .or_else(|| interface.and_then(|value| value.get("shortDescription")).and_then(Value::as_str))
                .or_else(|| skill.get("description").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let scope = match skill.get("scope").and_then(Value::as_str) {
                Some("repo") => SkillScope::Repo,
                Some("user") => SkillScope::User,
                Some("system") => SkillScope::System,
                Some("admin") => SkillScope::Admin,
                Some("project") => SkillScope::Project,
                _ => SkillScope::Other,
            };
            Some(SkillInfo {
                name: name.to_string(),
                display_name,
                description,
                path: path.to_string(),
                scope,
                enabled: skill.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            })
        })
        .collect();
    Some(skills)
}

#[async_trait]
impl AgentDriver for CodexDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: ProviderKind::Codex,
            display_name: ProviderKind::Codex.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: true,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::Codex, binary) {
            Ok(b) => b,
            Err(e) => {
                status.unavailable_reason = Some(format!("{e}. Install with: npm install -g @openai/codex"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let ok = at_least(&v, MIN_VERSION);
                status.available = ok;
                if !ok {
                    status.unavailable_reason =
                        Some(format!("Codex {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                status.version = Some(v);
                if ok {
                    status.models = codex_models(&bin).await;
                    for model in &status.models {
                        for effort in &model.efforts {
                            if !status.supported_efforts.contains(effort) {
                                status.supported_efforts.push(effort.clone());
                            }
                        }
                    }
                }
            }
            None => status.unavailable_reason = Some("could not run `codex --version`".into()),
        }
        status
    }

    async fn one_shot(&self, cwd: &std::path::Path, prompt: &str, binary: Option<&PathBuf>) -> Result<String> {
        let bin = resolve(ProviderKind::Codex, binary)?;
        let dir = tempfile_dir()?;
        let last = dir.join("last.txt");
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(90),
            Command::new(&bin)
                .current_dir(cwd)
                .args(["exec", "-s", "read-only", "--skip-git-repo-check", "--output-last-message"])
                .arg(&last)
                .arg(prompt)
                .stdin(std::process::Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| DriverError::Protocol("codex one-shot timed out".into()))??;
        if !out.status.success() {
            return Err(DriverError::Protocol(format!("codex exited with {}", out.status)));
        }
        let text = tokio::fs::read_to_string(&last).await.unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).to_string());
        let _ = tokio::fs::remove_dir_all(&dir).await;
        Ok(text.trim().to_string())
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let bin = resolve(ProviderKind::Codex, config.binary.as_ref())?;
        let mut cmd = Command::new(&bin);
        cmd.current_dir(&config.cwd).arg("app-server");
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        tracing::info!(bin = %bin.display(), cwd = %config.cwd.display(), "spawning codex app-server");
        let child = Arc::new(NdjsonChild::spawn(cmd)?);

        let (tx, rx) = mpsc::channel(1024);
        let session = Arc::new(CodexSession {
            child,
            events: tx,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State {
                thread_id: None,
                turn_id: None,
                mode: config.permission_mode,
                model: config.model.clone(),
                effort: config.effort.clone(),
                cwd: config.cwd.clone(),
                last_total_tokens: None,
                message_ids: HashMap::new(),
                file_changes: HashMap::new(),
                subagents: HashMap::new(),
                background_processes: HashMap::new(),
                stopping_processes: HashSet::new(),
            }),
            turn_usage: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        let reader = session.clone();
        tokio::spawn(async move { reader.read_loop().await });

        session
            .call(
                "initialize",
                json!({
                    "clientInfo": { "name": "kybern", "title": "kybern", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await?;
        session.child.write(&json!({ "method": "initialized" })).await?;

        let (approval, sandbox) = policy_for(config.permission_mode);
        let mut params = json!({ "cwd": config.cwd, "approvalPolicy": approval, "sandbox": sandbox });
        if let Some(m) = &config.model {
            params["model"] = Value::String(m.clone());
        }
        let (method, params) = match (&config.resume_session_id, config.fork) {
            (Some(id), false) => {
                params["threadId"] = Value::String(id.clone());
                ("thread/resume", params)
            }
            (Some(id), true) => {
                params["threadId"] = Value::String(id.clone());
                if let Some(turn) = config.rewind.as_ref().and_then(|r| r.drop_from.turn_id.clone()) {
                    params["beforeTurnId"] = Value::String(turn);
                }
                ("thread/fork", params)
            }
            (None, _) => ("thread/start", params),
        };
        let resp = session.call(method, params).await?;
        let thread_id = resp
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DriverError::Protocol(format!("{method}: no thread id in response")))?
            .to_string();
        let model = resp.get("model").and_then(|m| m.as_str()).map(str::to_string);
        {
            let mut st = session.state.lock().await;
            st.thread_id = Some(thread_id.clone());
            if model.is_some() {
                st.model = model.clone();
            }
        }
        session.emit(DriverEvent::SessionBound { session_id: thread_id, model }).await;
        let monitor = session.clone();
        tokio::spawn(async move { monitor.poll_background_terminals().await });

        Ok(SpawnedSession { session: Box::new(Handle(session)), events: rx })
    }
}

/// (approvalPolicy, sandbox mode) for a kybern permission mode.
fn policy_for(mode: PermissionMode) -> (&'static str, &'static str) {
    match mode {
        PermissionMode::Supervised => ("untrusted", "workspace-write"),
        PermissionMode::AcceptEdits => ("on-request", "workspace-write"),
        PermissionMode::Auto => ("never", "workspace-write"),
        PermissionMode::FullAccess => ("never", "danger-full-access"),
    }
}

fn sandbox_policy_for(mode: PermissionMode, cwd: &std::path::Path) -> Value {
    match mode {
        PermissionMode::FullAccess => json!({ "type": "dangerFullAccess" }),
        _ => {
            json!({ "type": "workspaceWrite", "writableRoots": [cwd], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false })
        }
    }
}

struct State {
    thread_id: Option<String>,
    turn_id: Option<String>,
    mode: PermissionMode,
    model: Option<String>,
    effort: Option<String>,
    cwd: PathBuf,
    /// Cumulative thread total at the end of the previous turn, to compute per-turn usage.
    last_total_tokens: Option<Usage>,
    /// Agent message item ids seen this turn (for completion bookkeeping).
    message_ids: HashMap<String, ()>,
    /// fileChange item id -> changes[], so the approval card can show the diff.
    file_changes: HashMap<String, Value>,
    /// Child Codex thread id -> active turn, when one is running.
    subagents: HashMap<String, Option<String>>,
    /// Process ids returned by the experimental background terminal API.
    background_processes: HashMap<String, RuntimeTaskStats>,
    stopping_processes: HashSet<String>,
}

struct CodexSession {
    child: Arc<NdjsonChild>,
    events: mpsc::Sender<DriverEvent>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// Our request key -> (server request id, kind) for approvals awaiting the user.
    pending_approvals: Mutex<HashMap<String, (Value, ApprovalKind)>>,
    state: Mutex<State>,
    /// Per-turn usage derived from thread totals, consumed at turn/completed.
    turn_usage: Mutex<Option<Usage>>,
    closed: AtomicBool,
}

#[derive(Clone, Copy)]
enum ApprovalKind {
    Command,
    FileChange,
}

struct Handle(Arc<CodexSession>);

impl CodexSession {
    async fn emit(&self, ev: DriverEvent) {
        let _ = self.events.send(ev).await;
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.child.write(&json!({ "id": id, "method": method, "params": params })).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(DriverError::Protocol(format!("{method}: {e}"))),
            Ok(Err(_)) => Err(DriverError::ProcessExited("codex exited while waiting for a response".into())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(DriverError::Protocol(format!("{method}: timed out")))
            }
        }
    }

    async fn poll_background_terminals(self: Arc<Self>) {
        loop {
            if self.closed.load(Ordering::Relaxed) {
                return;
            }
            let thread_id = match self.state.lock().await.thread_id.clone() {
                Some(thread_id) => thread_id,
                None => {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    continue;
                }
            };
            let result = match self.call("thread/backgroundTerminals/list", json!({ "threadId": thread_id, "limit": 100 })).await {
                Ok(result) => result,
                Err(error) => {
                    tracing::debug!(%error, "Codex background terminal API unavailable");
                    return;
                }
            };
            let rows = result.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut current = HashMap::new();
            let mut snapshots = Vec::new();
            for row in rows {
                let Some(process_id) = row.get("processId").and_then(Value::as_str).map(str::to_string) else { continue };
                let stats = RuntimeTaskStats {
                    token_count: None,
                    tool_uses: None,
                    duration_ms: None,
                    cpu_percent: row.get("cpuPercent").and_then(Value::as_f64),
                    rss_kb: row.get("rssKb").and_then(Value::as_u64),
                };
                current.insert(process_id.clone(), stats.clone());
                snapshots.push((process_id, row, stats));
            }
            let (previous, stopping) = {
                let mut state = self.state.lock().await;
                let previous = std::mem::replace(&mut state.background_processes, current.clone());
                (previous, state.stopping_processes.clone())
            };
            for (process_id, row, stats) in snapshots {
                let id = format!("process:{process_id}");
                if let Some(before) = previous.get(&process_id) {
                    if process_stats_changed(before, &stats) {
                        self.emit(DriverEvent::RuntimeTaskUpdated(DriverRuntimeTaskUpdate {
                            id,
                            status: Some(RuntimeTaskStatus::Running),
                            detail: None,
                            backgrounded: Some(true),
                            last_tool_name: None,
                            usage: None,
                            stats: Some(stats),
                            capabilities: None,
                        }))
                        .await;
                    }
                } else {
                    self.emit(DriverEvent::RuntimeTaskStarted(codex_background_process(&process_id, &row, stats))).await;
                }
            }
            for process_id in previous.keys().filter(|process_id| !current.contains_key(*process_id)) {
                let status = if stopping.contains(process_id) { RuntimeTaskStatus::Stopped } else { RuntimeTaskStatus::Completed };
                self.emit(DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status(format!("process:{process_id}"), status)))
                    .await;
                self.state.lock().await.stopping_processes.remove(process_id);
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    async fn respond(&self, id: &Value, result: std::result::Result<Value, String>) -> Result<()> {
        let frame = match result {
            Ok(r) => json!({ "id": id, "result": r }),
            Err(e) => json!({ "id": id, "error": { "code": -32601, "message": e } }),
        };
        self.child.write(&frame).await
    }

    async fn read_loop(self: Arc<Self>) {
        loop {
            let line = {
                let mut rx = self.child.lines.lock().await;
                rx.recv().await
            };
            let Some(v) = line else { break };
            self.handle_frame(v).await;
        }
        let code = self.child.wait().await;
        self.closed.store(true, Ordering::Relaxed);
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err("process exited".into()));
        }
        let error = match code {
            Some(0) | None => None,
            Some(c) => Some(format!("exit code {c}")),
        };
        self.emit(DriverEvent::Exited { code, error }).await;
    }

    async fn handle_frame(&self, v: Value) {
        let has_id = v.get("id").is_some_and(|i| !i.is_null());
        let method = v.get("method").and_then(|m| m.as_str());
        match (has_id, method) {
            (true, Some(m)) => self.handle_server_request(v["id"].clone(), m, &v["params"]).await,
            (false, Some(m)) => self.handle_notification(m, &v["params"]).await,
            (true, None) => {
                let Some(id) = v["id"].as_i64() else { return };
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let out = if let Some(err) = v.get("error") {
                        Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("error").to_string())
                    } else {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(out);
                }
            }
            _ => {}
        }
    }

    async fn handle_server_request(&self, id: Value, method: &str, params: &Value) {
        let item_id = params.get("itemId").and_then(|i| i.as_str()).map(str::to_string);
        match method {
            "item/commandExecution/requestApproval" => {
                let command = params.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
                let key = format!("cmd:{}", serde_json::to_string(&id).unwrap_or_default());
                self.pending_approvals.lock().await.insert(key.clone(), (id, ApprovalKind::Command));
                let input = json!({
                    "command": command,
                    "cwd": params.get("cwd"),
                    "reason": params.get("reason"),
                    "network": params.get("networkApprovalContext"),
                });
                let summary = if command.is_empty() {
                    match params.pointer("/networkApprovalContext/host").and_then(|h| h.as_str()) {
                        Some(host) => format!("network access to {host}"),
                        None => "run command".into(),
                    }
                } else {
                    format!("run: {}", command.lines().next().unwrap_or("").chars().take(120).collect::<String>())
                };
                self.emit(DriverEvent::PermissionRequest {
                    request_id: key,
                    tool_call_id: item_id,
                    tool_name: "shell".into(),
                    input,
                    summary,
                    suggestions: vec![],
                })
                .await;
            }
            "item/fileChange/requestApproval" => {
                let mode = self.state.lock().await.mode;
                if matches!(mode, PermissionMode::AcceptEdits | PermissionMode::Auto | PermissionMode::FullAccess) {
                    let _ = self.respond(&id, Ok(json!({ "decision": "accept" }))).await;
                    return;
                }
                let key = format!("patch:{}", serde_json::to_string(&id).unwrap_or_default());
                self.pending_approvals.lock().await.insert(key.clone(), (id, ApprovalKind::FileChange));
                let changes = match &item_id {
                    Some(i) => self.state.lock().await.file_changes.get(i).cloned().unwrap_or(Value::Null),
                    None => Value::Null,
                };
                let paths: Vec<String> = changes
                    .as_array()
                    .map(|a| a.iter().filter_map(|c| c.get("path").and_then(|p| p.as_str()).map(str::to_string)).collect())
                    .unwrap_or_default();
                let summary = if paths.is_empty() { "apply file changes".to_string() } else { format!("edit: {}", paths.join(", ")) };
                let input = json!({ "changes": changes, "reason": params.get("reason"), "grant_root": params.get("grantRoot") });
                self.emit(DriverEvent::PermissionRequest {
                    request_id: key,
                    tool_call_id: item_id,
                    tool_name: "apply_patch".into(),
                    input,
                    summary,
                    suggestions: vec![],
                })
                .await;
            }
            "item/tool/requestUserInput" => {
                // Not mappable to yes/no approvals yet; decline so the turn continues.
                let _ = self.respond(&id, Err("kybern does not support tool questions yet".into())).await;
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: "Codex asked a question kybern cannot relay yet".into(),
                    data: Some(params.clone()),
                })
                .await;
            }
            other => {
                let _ = self.respond(&id, Err(format!("kybern does not support {other}"))).await;
            }
        }
    }

    async fn handle_thread_started(&self, thread: &Value) {
        let Some(thread_id) = thread.get("id").and_then(Value::as_str).map(str::to_string) else { return };
        let Some(spawn) = thread.pointer("/source/subAgent/thread_spawn").or_else(|| thread.pointer("/source/subAgent/threadSpawn")) else {
            return;
        };
        let parent_id = spawn.get("parent_thread_id").or_else(|| spawn.get("parentThreadId")).and_then(Value::as_str).map(str::to_string);
        let known_parent = {
            let state = self.state.lock().await;
            parent_id.as_deref() == state.thread_id.as_deref()
                || parent_id.as_ref().is_some_and(|parent| state.subagents.contains_key(parent))
        };
        if !known_parent {
            return;
        }
        let title = spawn
            .get("agent_nickname")
            .or_else(|| spawn.get("agentNickname"))
            .or_else(|| spawn.get("agent_role"))
            .or_else(|| spawn.get("agentRole"))
            .and_then(Value::as_str)
            .or_else(|| thread.get("name").and_then(Value::as_str))
            .unwrap_or("Subagent")
            .to_string();
        let provider_type = spawn.get("agent_role").or_else(|| spawn.get("agentRole")).and_then(Value::as_str).map(str::to_string);
        let is_new = {
            let mut state = self.state.lock().await;
            if let std::collections::hash_map::Entry::Vacant(entry) = state.subagents.entry(thread_id.clone()) {
                entry.insert(None);
                true
            } else {
                false
            }
        };
        if is_new {
            self.emit(DriverEvent::RuntimeTaskStarted(DriverRuntimeTask {
                id: thread_id.clone(),
                kind: RuntimeTaskKind::Agent,
                status: RuntimeTaskStatus::Pending,
                title,
                detail: None,
                provider_type,
                parent_id,
                tool_call_id: None,
                provider_thread_id: Some(thread_id),
                model: thread.get("model").and_then(Value::as_str).map(str::to_string),
                effort: None,
                backgrounded: true,
                last_tool_name: None,
                usage: None,
                stats: RuntimeTaskStats::default(),
                capabilities: RuntimeTaskCapabilities::default(),
            }))
            .await;
        }
    }

    async fn ensure_subagent(&self, thread_id: &str) {
        let is_new = {
            let mut state = self.state.lock().await;
            if let std::collections::hash_map::Entry::Vacant(entry) = state.subagents.entry(thread_id.to_string()) {
                entry.insert(None);
                true
            } else {
                false
            }
        };
        if is_new {
            self.emit(DriverEvent::RuntimeTaskStarted(DriverRuntimeTask {
                id: thread_id.to_string(),
                kind: RuntimeTaskKind::Agent,
                status: RuntimeTaskStatus::Pending,
                title: "Subagent".into(),
                detail: None,
                provider_type: Some("sub_agent".into()),
                parent_id: None,
                tool_call_id: None,
                provider_thread_id: Some(thread_id.to_string()),
                model: None,
                effort: None,
                backgrounded: true,
                last_tool_name: None,
                usage: None,
                stats: RuntimeTaskStats::default(),
                capabilities: RuntimeTaskCapabilities::default(),
            }))
            .await;
        }
    }

    async fn handle_subagent_notification(&self, thread_id: &str, method: &str, p: &Value) {
        self.ensure_subagent(thread_id).await;
        match method {
            "turn/started" => {
                let turn_id = p.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
                self.state.lock().await.subagents.insert(thread_id.to_string(), turn_id);
                self.emit(DriverEvent::RuntimeTaskUpdated(DriverRuntimeTaskUpdate {
                    id: thread_id.to_string(),
                    status: Some(RuntimeTaskStatus::Running),
                    detail: None,
                    backgrounded: None,
                    last_tool_name: None,
                    usage: None,
                    stats: None,
                    capabilities: Some(RuntimeTaskCapabilities { stop: true, background: false }),
                }))
                .await;
            }
            "item/started" | "item/completed" => {
                let item = &p["item"];
                let tool = codex_item_label(item);
                let detail = codex_item_detail(item);
                self.emit(DriverEvent::RuntimeTaskUpdated(DriverRuntimeTaskUpdate {
                    id: thread_id.to_string(),
                    status: Some(RuntimeTaskStatus::Running),
                    detail,
                    backgrounded: None,
                    last_tool_name: tool,
                    usage: None,
                    stats: None,
                    capabilities: Some(RuntimeTaskCapabilities { stop: true, background: false }),
                }))
                .await;
            }
            "thread/tokenUsage/updated" => {
                let usage = p.pointer("/tokenUsage/total").map(parse_usage);
                self.emit(DriverEvent::RuntimeTaskUpdated(DriverRuntimeTaskUpdate {
                    id: thread_id.to_string(),
                    status: None,
                    detail: None,
                    backgrounded: None,
                    last_tool_name: None,
                    usage,
                    stats: None,
                    capabilities: None,
                }))
                .await;
            }
            "turn/completed" => {
                self.state.lock().await.subagents.insert(thread_id.to_string(), None);
                let status = match p.pointer("/turn/status").and_then(Value::as_str) {
                    Some("interrupted") => RuntimeTaskStatus::Interrupted,
                    Some("failed") => RuntimeTaskStatus::Failed,
                    _ => RuntimeTaskStatus::Waiting,
                };
                let terminal = !status.is_active();
                self.emit(if terminal {
                    DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate {
                        id: thread_id.to_string(),
                        status: Some(status),
                        detail: p.pointer("/turn/error/message").and_then(Value::as_str).map(str::to_string),
                        backgrounded: None,
                        last_tool_name: None,
                        usage: None,
                        stats: None,
                        capabilities: Some(RuntimeTaskCapabilities::default()),
                    })
                } else {
                    DriverEvent::RuntimeTaskUpdated(DriverRuntimeTaskUpdate {
                        id: thread_id.to_string(),
                        status: Some(status),
                        detail: None,
                        backgrounded: None,
                        last_tool_name: None,
                        usage: None,
                        stats: None,
                        capabilities: Some(RuntimeTaskCapabilities::default()),
                    })
                })
                .await;
            }
            "thread/status/changed" => {
                let status = p.pointer("/status/type").and_then(Value::as_str).unwrap_or("");
                let mapped = match status {
                    "active" => RuntimeTaskStatus::Running,
                    "systemError" => RuntimeTaskStatus::Failed,
                    _ => RuntimeTaskStatus::Waiting,
                };
                let terminal = !mapped.is_active();
                let update = DriverRuntimeTaskUpdate {
                    id: thread_id.to_string(),
                    status: Some(mapped),
                    detail: None,
                    backgrounded: None,
                    last_tool_name: None,
                    usage: None,
                    stats: None,
                    capabilities: Some(RuntimeTaskCapabilities { stop: mapped == RuntimeTaskStatus::Running, background: false }),
                };
                self.emit(if terminal { DriverEvent::RuntimeTaskCompleted(update) } else { DriverEvent::RuntimeTaskUpdated(update) }).await;
            }
            _ => {}
        }
    }

    async fn handle_notification(&self, method: &str, p: &Value) {
        if method == "thread/started" {
            self.handle_thread_started(&p["thread"]).await;
            return;
        }
        let root_thread_id = self.state.lock().await.thread_id.clone();
        if let Some(thread_id) = p.get("threadId").and_then(Value::as_str)
            && root_thread_id.as_deref() != Some(thread_id)
        {
            self.handle_subagent_notification(thread_id, method, p).await;
            return;
        }
        match method {
            "turn/started" => {
                if let Some(id) = p.pointer("/turn/id").and_then(|i| i.as_str()) {
                    self.state.lock().await.turn_id = Some(id.to_string());
                }
            }
            "item/started" => self.handle_item(&p["item"], false).await,
            "item/completed" => self.handle_item(&p["item"], true).await,
            "item/agentMessage/delta" => {
                if let (Some(id), Some(delta)) = (p.get("itemId").and_then(|i| i.as_str()), p.get("delta").and_then(|d| d.as_str())) {
                    self.emit(DriverEvent::TextDelta { message_id: id.to_string(), delta: delta.to_string() }).await;
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                if let (Some(id), Some(delta)) = (p.get("itemId").and_then(|i| i.as_str()), p.get("delta").and_then(|d| d.as_str())) {
                    // Attribute reasoning to the turn's current message stream under the reasoning item id.
                    self.emit(DriverEvent::ThinkingDelta { message_id: id.to_string(), delta: delta.to_string() }).await;
                }
            }
            "item/commandExecution/outputDelta" => {
                if let (Some(id), Some(delta)) = (p.get("itemId").and_then(|i| i.as_str()), p.get("delta").and_then(|d| d.as_str())) {
                    self.emit(DriverEvent::ToolOutputDelta { tool_call_id: id.to_string(), delta: delta.to_string() }).await;
                }
            }
            "turn/plan/updated" => {
                let steps = p.get("plan").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Info,
                    text: format!("plan updated ({steps} steps)"),
                    data: Some(p.clone()),
                })
                .await;
            }
            "thread/tokenUsage/updated" => {
                let total = p.pointer("/tokenUsage/total").map(parse_usage).unwrap_or_default();
                let mut st = self.state.lock().await;
                let per_turn = match &st.last_total_tokens {
                    Some(prev) => Usage {
                        input_tokens: total.input_tokens.saturating_sub(prev.input_tokens),
                        output_tokens: total.output_tokens.saturating_sub(prev.output_tokens),
                        cache_read_tokens: total.cache_read_tokens.saturating_sub(prev.cache_read_tokens),
                        cache_write_tokens: total.cache_write_tokens.saturating_sub(prev.cache_write_tokens),
                    },
                    None => total.clone(),
                };
                st.last_total_tokens = Some(total);
                drop(st);
                *self.turn_usage.lock().await = Some(per_turn);
            }
            "turn/completed" => {
                let turn = &p["turn"];
                let status = turn.get("status").and_then(|s| s.as_str()).unwrap_or("completed");
                let duration_ms = turn.get("durationMs").and_then(|d| d.as_u64()).unwrap_or(0);
                let usage = self.turn_usage.lock().await.take().unwrap_or_default();
                let anchors =
                    crate::TurnAnchors { turn_id: turn.get("id").and_then(|i| i.as_str()).map(str::to_string), previous_end: None };
                {
                    let mut st = self.state.lock().await;
                    st.turn_id = None;
                    st.message_ids.clear();
                    st.file_changes.clear();
                }
                self.pending_approvals.lock().await.clear();
                let ev = match status {
                    "completed" => {
                        DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, usage, cost_usd: None, duration_ms, anchors }
                    }
                    "interrupted" => {
                        DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, usage, cost_usd: None, duration_ms, anchors }
                    }
                    _ => DriverEvent::TurnFailed {
                        error: turn.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("turn failed").to_string(),
                    },
                };
                self.emit(ev).await;
            }
            "error" => {
                let msg = p.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("error").to_string();
                let retry = p.get("willRetry").and_then(|r| r.as_bool()).unwrap_or(false);
                self.emit(DriverEvent::Notice {
                    level: if retry { NoticeLevel::Warning } else { NoticeLevel::Error },
                    text: if retry { format!("{msg} (retrying)") } else { msg },
                    data: Some(p.clone()),
                })
                .await;
            }
            "warning" | "configWarning" | "deprecationNotice" => {
                let text = p.get("message").or_else(|| p.get("summary")).and_then(|m| m.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    self.emit(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
                }
            }
            "serverRequest/resolved" => {
                // A pending approval was resolved elsewhere (interrupt). Drop it if still pending.
                let rid = p.get("requestId").cloned().unwrap_or(Value::Null);
                let mut pend = self.pending_approvals.lock().await;
                if let Some(key) = pend.iter().find(|(_, (id, _))| *id == rid).map(|(k, _)| k.clone()) {
                    pend.remove(&key);
                    drop(pend);
                    self.emit(DriverEvent::PermissionWithdrawn { request_id: key }).await;
                }
            }
            "thread/settings/updated" => {
                if let Some(model) = p.pointer("/threadSettings/model").and_then(|m| m.as_str()) {
                    let mut st = self.state.lock().await;
                    if st.model.as_deref() != Some(model) {
                        st.model = Some(model.to_string());
                        let tid = st.thread_id.clone().unwrap_or_default();
                        drop(st);
                        self.emit(DriverEvent::SessionBound { session_id: tid, model: Some(model.to_string()) }).await;
                    }
                }
            }
            _ => tracing::trace!(method, "ignored codex notification"),
        }
    }

    async fn handle_item(&self, item: &Value, completed: bool) {
        let ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let id = item.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        match ty {
            "agentMessage" => {
                if completed {
                    let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    self.emit(DriverEvent::MessageCompleted { message_id: id, text, thinking: None }).await;
                }
            }
            "reasoning" => {
                if completed {
                    let summary = item
                        .get("summary")
                        .and_then(|s| s.as_array())
                        .map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join("\n\n"))
                        .unwrap_or_default();
                    if !summary.is_empty() {
                        // Reasoning belongs to the next agent message; surfaced as a notice with data for the UI.
                        self.emit(DriverEvent::Notice {
                            level: NoticeLevel::Info,
                            text: "reasoning".into(),
                            data: Some(json!({ "reasoning": summary, "item_id": id })),
                        })
                        .await;
                    }
                }
            }
            "commandExecution" => {
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall {
                        id,
                        name: "shell".into(),
                        input: json!({ "command": item.get("command"), "cwd": item.get("cwd"), "actions": item.get("commandActions") }),
                        parent_id: None,
                    }))
                    .await;
                } else {
                    let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id.clone(),
                        output: json!({ "content": item.get("aggregatedOutput"), "exit_code": item.get("exitCode"), "status": status, "duration_ms": item.get("durationMs") }),
                        is_error: matches!(status, "failed" | "declined"),
                    })
                    .await;
                    if status == "inProgress"
                        && let Some(process_id) = item.get("processId").and_then(Value::as_str)
                    {
                        let stats = RuntimeTaskStats { duration_ms: item.get("durationMs").and_then(Value::as_u64), ..Default::default() };
                        self.state.lock().await.background_processes.insert(process_id.to_string(), stats.clone());
                        self.emit(DriverEvent::RuntimeTaskStarted(codex_background_process(
                            process_id,
                            &json!({
                                "command": item.get("command"),
                                "cwd": item.get("cwd"),
                                "itemId": id,
                            }),
                            stats,
                        )))
                        .await;
                    }
                }
            }
            "fileChange" => {
                let changes = item.get("changes").cloned().unwrap_or(Value::Array(vec![]));
                if !completed {
                    self.state.lock().await.file_changes.insert(id.clone(), changes.clone());
                    self.emit(DriverEvent::ToolStarted(ToolCall {
                        id,
                        name: "apply_patch".into(),
                        input: json!({ "changes": changes }),
                        parent_id: None,
                    }))
                    .await;
                } else {
                    let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id,
                        output: json!({ "status": status, "changes": changes }),
                        is_error: matches!(status, "failed" | "declined"),
                    })
                    .await;
                }
            }
            "mcpToolCall" => {
                let name = format!(
                    "mcp:{}/{}",
                    item.get("server").and_then(|s| s.as_str()).unwrap_or(""),
                    item.get("tool").and_then(|s| s.as_str()).unwrap_or("")
                );
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall {
                        id,
                        name,
                        input: item.get("arguments").cloned().unwrap_or(Value::Null),
                        parent_id: None,
                    }))
                    .await;
                } else {
                    let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id,
                        output: json!({ "result": item.get("result"), "error": item.get("error"), "status": status }),
                        is_error: status == "failed" || !item.get("error").is_none_or(Value::is_null),
                    })
                    .await;
                }
            }
            "webSearch" => {
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall {
                        id,
                        name: "web_search".into(),
                        input: json!({ "query": item.get("query"), "action": item.get("action") }),
                        parent_id: None,
                    }))
                    .await;
                } else {
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id,
                        output: json!({ "results": item.get("results") }),
                        is_error: false,
                    })
                    .await;
                }
            }
            "imageView" | "imageGeneration" | "dynamicToolCall" => {
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall { id, name: ty.to_string(), input: item.clone(), parent_id: None })).await;
                } else {
                    self.emit(DriverEvent::ToolCompleted { tool_call_id: id, output: item.clone(), is_error: false }).await;
                }
            }
            "collabAgentToolCall" => {
                let receiver_ids = item
                    .get("receiverThreadIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                for thread_id in receiver_ids {
                    self.ensure_subagent(&thread_id).await;
                }
                if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
                    for (thread_id, state) in states {
                        self.ensure_subagent(thread_id).await;
                        let status = codex_agent_status(state.get("status").and_then(Value::as_str).unwrap_or("running"));
                        let update = DriverRuntimeTaskUpdate {
                            id: thread_id.clone(),
                            status: Some(status),
                            detail: state.get("message").and_then(Value::as_str).map(str::to_string),
                            backgrounded: None,
                            last_tool_name: None,
                            usage: None,
                            stats: None,
                            capabilities: Some(RuntimeTaskCapabilities { stop: status == RuntimeTaskStatus::Running, background: false }),
                        };
                        self.emit(if status.is_active() {
                            DriverEvent::RuntimeTaskUpdated(update)
                        } else {
                            DriverEvent::RuntimeTaskCompleted(update)
                        })
                        .await;
                    }
                }
            }
            "subAgentActivity" => {
                let Some(thread_id) = item.get("agentThreadId").and_then(Value::as_str) else { return };
                self.ensure_subagent(thread_id).await;
                let status = match item.get("kind").and_then(Value::as_str).unwrap_or("started") {
                    "interrupted" => RuntimeTaskStatus::Interrupted,
                    "completed" => RuntimeTaskStatus::Completed,
                    _ => RuntimeTaskStatus::Running,
                };
                let update = DriverRuntimeTaskUpdate {
                    id: thread_id.to_string(),
                    status: Some(status),
                    detail: None,
                    backgrounded: None,
                    last_tool_name: None,
                    usage: None,
                    stats: None,
                    capabilities: Some(RuntimeTaskCapabilities { stop: status == RuntimeTaskStatus::Running, background: false }),
                };
                self.emit(if status.is_active() {
                    DriverEvent::RuntimeTaskUpdated(update)
                } else {
                    DriverEvent::RuntimeTaskCompleted(update)
                })
                .await;
            }
            "contextCompaction" if completed => {
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "context compacted".into(), data: None }).await;
            }
            _ => {}
        }
    }
}

fn codex_background_process(process_id: &str, value: &Value, stats: RuntimeTaskStats) -> DriverRuntimeTask {
    let command = value
        .get("command")
        .and_then(|command| {
            command
                .as_str()
                .map(str::to_string)
                .or_else(|| command.as_array().map(|parts| parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")))
        })
        .filter(|command| !command.trim().is_empty())
        .unwrap_or_else(|| "Background process".into());
    DriverRuntimeTask {
        id: format!("process:{process_id}"),
        kind: RuntimeTaskKind::Process,
        status: RuntimeTaskStatus::Running,
        title: command.lines().next().unwrap_or(&command).chars().take(120).collect(),
        detail: value.get("cwd").and_then(Value::as_str).map(str::to_string),
        provider_type: Some("background_terminal".into()),
        parent_id: None,
        tool_call_id: value.get("itemId").and_then(Value::as_str).map(str::to_string),
        provider_thread_id: None,
        model: None,
        effort: None,
        backgrounded: true,
        last_tool_name: Some("shell".into()),
        usage: None,
        stats,
        capabilities: RuntimeTaskCapabilities { stop: true, background: false },
    }
}

fn process_stats_changed(before: &RuntimeTaskStats, after: &RuntimeTaskStats) -> bool {
    let cpu_changed = match (before.cpu_percent, after.cpu_percent) {
        (Some(before), Some(after)) => (before - after).abs() >= 1.0,
        (before, after) => before != after,
    };
    let memory_changed = match (before.rss_kb, after.rss_kb) {
        (Some(before), Some(after)) => before.abs_diff(after) >= 1024,
        (before, after) => before != after,
    };
    cpu_changed || memory_changed
}

fn codex_agent_status(status: &str) -> RuntimeTaskStatus {
    match status {
        "pendingInit" => RuntimeTaskStatus::Pending,
        "running" => RuntimeTaskStatus::Running,
        "interrupted" => RuntimeTaskStatus::Interrupted,
        "completed" | "shutdown" => RuntimeTaskStatus::Completed,
        "errored" | "notFound" => RuntimeTaskStatus::Failed,
        _ => RuntimeTaskStatus::Waiting,
    }
}

fn codex_item_label(item: &Value) -> Option<String> {
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => Some("shell".into()),
        "fileChange" => Some("apply_patch".into()),
        "mcpToolCall" => Some(format!(
            "mcp:{}/{}",
            item.get("server").and_then(Value::as_str).unwrap_or(""),
            item.get("tool").and_then(Value::as_str).unwrap_or("")
        )),
        "webSearch" => Some("web_search".into()),
        "imageView" => Some("image_view".into()),
        "imageGeneration" => Some("image_generation".into()),
        "dynamicToolCall" => item.get("tool").and_then(Value::as_str).map(str::to_string).or_else(|| Some("tool".into())),
        _ => None,
    }
}

fn codex_item_detail(item: &Value) -> Option<String> {
    item.get("command")
        .or_else(|| item.get("query"))
        .or_else(|| item.get("tool"))
        .and_then(Value::as_str)
        .map(|detail| detail.lines().next().unwrap_or(detail).chars().take(160).collect())
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("kybern-codex-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn parse_usage(u: &Value) -> Usage {
    let g = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    Usage {
        input_tokens: g("inputTokens"),
        output_tokens: g("outputTokens"),
        cache_read_tokens: g("cachedInputTokens"),
        cache_write_tokens: g("cacheWriteInputTokens"),
    }
}

fn input_items(message: &UserMessage) -> Vec<Value> {
    let mut items = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => items.push(json!({ "type": "text", "text": text, "text_elements": [] })),
            ContentPart::FileMention { path } => items.push(json!({ "type": "text", "text": format!("@{path}"), "text_elements": [] })),
            ContentPart::Skill { name, path } => {
                // App-server currently expects both the visible `$skill` text
                // and the structured item that identifies the canonical file.
                items.push(json!({ "type": "text", "text": format!("${name}"), "text_elements": [] }));
                items.push(json!({ "type": "skill", "name": name, "path": path }));
            }
            ContentPart::Image { media_type, data } => {
                if base64::engine::general_purpose::STANDARD.decode(data).is_ok() {
                    items.push(json!({ "type": "image", "url": format!("data:{media_type};base64,{data}"), "detail": "auto" }));
                }
            }
            ContentPart::Attachment { name, .. } => {
                items.push(json!({ "type": "text", "text": format!("[attached file: {name}]"), "text_elements": [] }))
            }
        }
    }
    items
}

#[async_trait]
impl AgentSession for Handle {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()> {
        let s = &self.0;
        let (thread_id, mode, model, effort, cwd) = {
            let st = s.state.lock().await;
            (
                st.thread_id.clone().ok_or_else(|| DriverError::Protocol("no codex thread".into()))?,
                st.mode,
                st.model.clone(),
                st.effort.clone(),
                st.cwd.clone(),
            )
        };
        let (approval, _) = policy_for(mode);
        let mut params = json!({
            "threadId": thread_id,
            "clientUserMessageId": message_id,
            "input": input_items(message),
            "approvalPolicy": approval,
            "sandboxPolicy": sandbox_policy_for(mode, &cwd),
        });
        if let Some(m) = model {
            params["model"] = Value::String(m);
        }
        if let Some(effort) = effort {
            params["effort"] = Value::String(effort);
        }
        let resp = s.call("turn/start", params).await?;
        if let Some(id) = resp.pointer("/turn/id").and_then(|i| i.as_str()) {
            s.state.lock().await.turn_id = Some(id.to_string());
        }
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        let (thread_id, turn_id) = {
            let st = self.0.state.lock().await;
            (st.thread_id.clone(), st.turn_id.clone())
        };
        match (thread_id, turn_id) {
            (Some(t), Some(turn)) => self.0.call("turn/interrupt", json!({ "threadId": t, "turnId": turn })).await.map(|_| ()),
            _ => Ok(()),
        }
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        self.0.state.lock().await.mode = mode;
        Ok(())
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        self.0.state.lock().await.model = Some(model.to_string());
        Ok(())
    }

    async fn set_effort(&self, effort: &str) -> Result<()> {
        self.0.state.lock().await.effort = Some(effort.to_string());
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let Some((id, _kind)) = self.0.pending_approvals.lock().await.remove(request_id) else {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        };
        let d = match decision {
            ApprovalDecision::AllowOnce => "accept",
            ApprovalDecision::AllowAlways => "acceptForSession",
            ApprovalDecision::Deny { .. } => "decline",
        };
        self.0.respond(&id, Ok(json!({ "decision": d }))).await
    }

    async fn stop_runtime_task(&self, task: &RuntimeTask) -> Result<()> {
        match task.kind {
            RuntimeTaskKind::Process => {
                let process_id = task.id.strip_prefix("process:").unwrap_or(&task.id);
                let thread_id =
                    self.0.state.lock().await.thread_id.clone().ok_or_else(|| DriverError::Protocol("no Codex thread".into()))?;
                let result =
                    self.0.call("thread/backgroundTerminals/terminate", json!({ "threadId": thread_id, "processId": process_id })).await?;
                if result.get("terminated").and_then(Value::as_bool) == Some(false) {
                    return Err(DriverError::Protocol("Codex could not terminate this background process".into()));
                }
                self.0.state.lock().await.stopping_processes.insert(process_id.to_string());
                Ok(())
            }
            RuntimeTaskKind::Agent => {
                let thread_id = task.provider_thread_id.as_deref().unwrap_or(&task.id);
                let mut turn_id = self.0.state.lock().await.subagents.get(thread_id).cloned().flatten();
                if turn_id.is_none()
                    && let Ok(thread) = self.0.call("thread/read", json!({ "threadId": thread_id, "includeTurns": true })).await
                {
                    turn_id = thread
                        .pointer("/thread/turns")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .rev()
                        .find(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
                        .and_then(|turn| turn.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                let turn_id = turn_id.ok_or_else(|| DriverError::Unsupported("this subagent has no active turn to interrupt".into()))?;
                self.0.call("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await.map(|_| ())
            }
            RuntimeTaskKind::Monitor => Err(DriverError::Unsupported("Codex does not expose a targeted monitor stop".into())),
        }
    }

    async fn close(&self) -> Result<()> {
        self.0.closed.store(true, Ordering::Relaxed);
        let _ = self.0.child.close_stdin().await;
        let child = self.0.child.clone();
        match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
            Ok(_) => {}
            Err(_) => child.kill().await,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{codex_agent_status, codex_background_process, input_items, process_stats_changed};
    use kybern_protocol::{ContentPart, RuntimeTaskKind, RuntimeTaskStats, RuntimeTaskStatus, UserMessage};
    use serde_json::json;

    #[test]
    fn sends_codex_skills_as_visible_text_and_structured_items() {
        let message = UserMessage {
            parts: vec![ContentPart::Skill { name: "Expo UI SwiftUI".into(), path: "/skills/expo-ui-swiftui/SKILL.md".into() }],
        };
        assert_eq!(
            input_items(&message),
            vec![
                json!({ "type": "text", "text": "$Expo UI SwiftUI", "text_elements": [] }),
                json!({ "type": "skill", "name": "Expo UI SwiftUI", "path": "/skills/expo-ui-swiftui/SKILL.md" }),
            ]
        );
    }

    #[test]
    fn maps_subagent_states_and_background_terminal_inventory() {
        assert_eq!(codex_agent_status("pendingInit"), RuntimeTaskStatus::Pending);
        assert_eq!(codex_agent_status("running"), RuntimeTaskStatus::Running);
        assert_eq!(codex_agent_status("completed"), RuntimeTaskStatus::Completed);
        assert_eq!(codex_agent_status("errored"), RuntimeTaskStatus::Failed);

        let task = codex_background_process(
            "42",
            &json!({ "command": ["pnpm", "dev"], "cwd": "/tmp/project", "itemId": "item-9" }),
            RuntimeTaskStats { cpu_percent: Some(2.5), rss_kb: Some(4096), ..Default::default() },
        );
        assert_eq!(task.id, "process:42");
        assert_eq!(task.kind, RuntimeTaskKind::Process);
        assert_eq!(task.title, "pnpm dev");
        assert!(task.backgrounded);
        assert!(task.capabilities.stop);
        assert_eq!(task.stats.rss_kb, Some(4096));
    }

    #[test]
    fn suppresses_noisy_background_process_metric_updates() {
        let before = RuntimeTaskStats { cpu_percent: Some(2.0), rss_kb: Some(4096), ..Default::default() };
        let noise = RuntimeTaskStats { cpu_percent: Some(2.5), rss_kb: Some(4600), ..Default::default() };
        let meaningful = RuntimeTaskStats { cpu_percent: Some(3.0), rss_kb: Some(5120), ..Default::default() };
        assert!(!process_stats_changed(&before, &noise));
        assert!(process_stats_changed(&before, &meaningful));
    }
}
