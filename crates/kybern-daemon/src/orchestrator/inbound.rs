//! Forwarded agent tools (ADE-86 M2 / R2, design §6.3): an agent on one machine names another in the
//! `machine` argument of a Kybern tool.
//!
//! **The calling machine (A).** [`Orchestrator::forward_native_tool`] sees `machine` before the tool runs
//! anywhere, refuses a thread that another machine started (no second hop), fails fast when the target is
//! offline or paused (a tool call never queues: the agent needs the answer now), and sends one
//! `peer.tool.call` carrying the caller's permission mode. `kybern_machines` lists the members and asks
//! each online one what it has.
//!
//! **The target machine (B).** [`Orchestrator::serve_tool_call`] checks the call against the rules in
//! `network::forward` (allow-list, scopes, the fence), finds or creates the *inbound thread* B keeps for
//! that one origin thread and project, and runs the tool through the same dispatch every agent tool goes
//! through, with the inbound thread as the caller. The inbound thread has no agent: an inert session
//! stands in for one while calls are in flight, so the approval cards, notes consent and terminal rules
//! that already exist work unchanged and their cards appear on the inbound thread ("From Mac · <title>")
//! where any client can answer them. Each call is recorded as `ToolCallStarted` / `ToolCallCompleted`
//! with the origin in the input, and the thread's `origin` is stamped from the session and never changes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use chrono::Utc;
use kybern_drivers::{AgentSession, DriverError};
use kybern_protocol::methods::{Method, PeerThreadArchiveInbound, PeerToolCall};
use kybern_protocol::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use super::remote_delegation::{CallFailure, MemberView, RemoteHub, RemoteTarget};
use super::{ActiveTurn, LiveSession, Orchestrator, SessionActivityTime};
use crate::network::forward::{self, Decision, MACHINES_TOOL, ToolClass};

/// What the audit events keep of one tool result.
const AUDIT_OUTPUT_BYTES: usize = 64 * 1024;
/// An inbound session nobody called for this long is retired (its thread and history stay).
const SESSION_IDLE: Duration = Duration::from_secs(30 * 60);
/// Results of the last forwarded calls, so a transport retry of one operation answers from the first run.
const RESULT_CACHE: usize = 128;
/// `kybern_machines` asks each online member for this long.
const ABOUT_WAIT: Duration = Duration::from_secs(4);
/// The `meta` key holding the machines a thread forwarded tool calls to, so archiving it can tell them.
fn forwarded_key(thread_id: ThreadId) -> String {
    format!("forwarded_to:{thread_id}")
}

pub(super) const INBOUND_READ_ONLY: &str =
    "This thread only records tool calls another machine made here. It has no agent to message; message the thread that called instead.";

/// The inbound threads' live sessions and the results kept for retries.
#[derive(Default)]
pub(super) struct InboundState {
    /// Creating an inbound thread and its session, one at a time.
    create: AsyncMutex<()>,
    sessions: Mutex<HashMap<ThreadId, InboundSession>>,
    results: Mutex<Vec<((String, Uuid), Value)>>,
}

struct InboundSession {
    turn_id: TurnId,
    in_flight: usize,
    last_call: Instant,
    started: Instant,
}

/// Stands in for an agent process on an inbound thread: nothing is ever sent to it.
struct InertSession;

#[async_trait]
impl AgentSession for InertSession {
    async fn send_message(&self, _message_id: &str, _message: &UserMessage) -> kybern_drivers::Result<()> {
        Err(DriverError::Unsupported(INBOUND_READ_ONLY.into()))
    }
    async fn interrupt(&self) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_permission_mode(&self, _mode: PermissionMode) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_model(&self, _model: &str) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_effort(&self, _effort: &str) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn respond_permission(&self, _request_id: &str, _decision: &ApprovalDecision) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn close(&self) -> kybern_drivers::Result<()> {
        Ok(())
    }
}

/// `kybern_preview_open` with a machine (M4 / U3): forward the dev server's port to this machine and show
/// it from here, as an ordinary local page. The page, its assets and its hot-reload socket are plain TCP
/// to the browser, so nothing in the page changes.
async fn preview_on_machine(
    hub: &Arc<dyn RemoteHub>,
    target: &RemoteTarget,
    cap: PermissionMode,
    mut arguments: Value,
) -> Result<Option<Forwarded>> {
    let address = arguments.get("target").and_then(Value::as_str).unwrap_or_default().to_string();
    // Only a dev server on that machine's localhost is shown from here. A file of that machine, or an address outside
    // it, goes to the machine as any operate tool does: its tool runs there and asks there.
    let Ok((port, path)) = crate::network::ports::parse_server_target(&address) else { return Ok(None) };
    if let Some(features) = &target.features {
        anyhow::ensure!(
            features.iter().any(|feature| feature == features::PORTS_V1),
            "{} needs a newer Kybern to forward ports. Update it from Settings → Machines.",
            target.name
        );
    }
    // A forward lets this machine's processes reach a port of the other machine, so the table's "ask" for
    // operate tools holds here too. The calling side has no card for it, so it declines and says what to do.
    anyhow::ensure!(
        forward::decide(cap, ToolClass::Operate) == Decision::Run,
        "Showing a page from {} needs your approval at this permission level. Open it yourself from the Preview panel (Ports menu), or switch this thread to Auto or Full access.",
        target.name
    );
    let local = hub.forward_port(&target.id, port).await.map_err(|reason| anyhow!("{}: {reason}", target.name))?;
    if let Some(object) = arguments.as_object_mut() {
        object.remove(forward::MACHINE_ARG);
        object.remove(forward::PROJECT_ARG);
        object.insert("target".into(), json!(format!("http://localhost:{local}{path}")));
        let titled = object.get("title").and_then(Value::as_str).is_some_and(|title| !title.trim().is_empty());
        if !titled {
            object.insert("title".into(), json!(format!("localhost:{port} on {}", target.name)));
        }
    }
    Ok(Some(Forwarded::Local(arguments)))
}

/// What the calling side decided about a tool call that may name a machine.
pub(super) enum Forwarded {
    /// It ran on another machine; this is its result.
    Done(Value),
    /// It runs here: the arguments, without `machine` and `project`.
    Local(Value),
}

/// A call's operation id when the tool has no `operation_id` argument of its own, derived the way
/// `prepare_native_operation` derives one so a transport retry is the same operation.
pub(super) fn derived_call_operation(thread_id: ThreadId, session_id: Uuid, turn_id: TurnId, call_id: &str, name: &str) -> Uuid {
    let identity = json!(["kybern-forward-call-v1", thread_id, session_id, turn_id, name, call_id]);
    let digest = Sha256::digest(serde_json::to_vec(&identity).unwrap_or_default());
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA-256 contains 16 bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// The arguments' `machine`, when the call names one.
pub(super) fn named_machine(arguments: &Value) -> Option<String> {
    arguments.get(forward::MACHINE_ARG).and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned)
}

fn rpc_internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::internal(error)
}

fn tool_error(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(codes::CONFLICT, format!("{error}"))
}

impl Orchestrator {
    pub(super) fn forward_hub(&self) -> Result<&Arc<dyn RemoteHub>> {
        self.remote_hub().ok_or_else(|| anyhow!("This daemon cannot reach other machines."))
    }

    // ---- the calling machine ----

    /// [`Self::forward_native_tool`] for a call the native tool gateway received. Boxed, so the future of
    /// every ordinary tool call stays as small as it was.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn forward_named_call<'a>(
        &'a self,
        thread_id: ThreadId,
        session_instance_id: Uuid,
        turn_id: TurnId,
        call_id: &'a str,
        name: &'a str,
        arguments: Value,
        operation_id: Option<Uuid>,
    ) -> futures::future::BoxFuture<'a, Result<Forwarded>> {
        Box::pin(async move {
            let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("native tool caller thread no longer exists"))?;
            let operation = operation_id.unwrap_or_else(|| derived_call_operation(thread_id, session_instance_id, turn_id, call_id, name));
            self.forward_native_tool(&thread, name, arguments, operation).await
        })
    }

    /// A tool call that names a machine: run it there, or (when the name is this machine) hand the
    /// arguments back to run here.
    async fn forward_native_tool(&self, thread: &Thread, name: &str, mut arguments: Value, operation_id: Uuid) -> Result<Forwarded> {
        let machine = named_machine(&arguments).unwrap_or_default();
        let project =
            arguments.get(forward::PROJECT_ARG).and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
        let class = forward::classify(name);
        if class == ToolClass::Delegation || name == super::provision::ADD_TOOL {
            // Remote delegation reads `machine` itself, and so does adding a project: there `machine` is
            // the TARGET to provision, not a machine to run the call on.
            return Ok(Forwarded::Local(arguments));
        }
        let hub = self.forward_hub()?.clone();
        let this_machine = machine.eq_ignore_ascii_case(&hub.self_id()) || machine.eq_ignore_ascii_case(&hub.self_name());
        let own = |mut arguments: Value| {
            if let Some(object) = arguments.as_object_mut() {
                object.remove(forward::MACHINE_ARG);
                object.remove(forward::PROJECT_ARG);
            }
            Forwarded::Local(arguments)
        };
        if this_machine {
            return Ok(own(arguments));
        }
        if !class.is_forwardable() || class == ToolClass::Machines {
            anyhow::bail!("{name} cannot run on another machine. Leave out `machine`.");
        }
        // Work another machine started here may not reach a third machine (§6.3: hops == 1).
        anyhow::ensure!(
            !super::fork_machine::second_hop(thread) && thread.inbound.is_none(),
            "Another machine started this thread, so it cannot use tools on a third machine. Use the tools on this machine."
        );
        let members = hub.members();
        let target = hub.resolve(&machine).map_err(|reason| anyhow!(reason))?;
        let view = members.iter().find(|member| member.id == target.id);
        if target.paused {
            anyhow::bail!("{} is paused in your network. Resume it in Settings → Machines to use it.", target.name);
        }
        if !target.online {
            anyhow::bail!("{}", offline_message(&target.name, view.and_then(|member| member.last_seen)));
        }
        if name == "kybern_preview_open"
            && let Some(local) = preview_on_machine(&hub, &target, thread.permission_mode, arguments.clone()).await?
        {
            return Ok(local);
        }
        if let Some(features) = &target.features {
            anyhow::ensure!(
                features.iter().any(|feature| feature == features::TOOLS_FORWARD_V1),
                "{} needs a newer Kybern to run tools for another machine. Update it from Settings → Machines.",
                target.name
            );
        }
        if let Some(object) = arguments.as_object_mut() {
            object.remove(forward::MACHINE_ARG);
            object.remove(forward::PROJECT_ARG);
        }
        let params = self.tool_call_params(thread, &hub, name, arguments, operation_id, project).await;
        self.remember_forwarded(thread.id, &target.id);
        match hub.call(&target.id, PeerToolCall::NAME, serde_json::to_value(&params)?).await {
            Ok(value) => {
                let mut result: PeerToolCallResult =
                    serde_json::from_value(value).map_err(|error| anyhow!("{}: unreadable answer: {error}", target.name))?;
                if let Some(object) = result.result.as_object_mut()
                    && !object.contains_key("_kybern_content")
                {
                    object.insert("ran_on".into(), json!(target.name));
                }
                Ok(Forwarded::Done(result.result))
            }
            Err(CallFailure::Offline(reason)) => {
                anyhow::bail!("{reason}. Tool calls do not queue: use kybern_agent_delegate with machine to queue work there.")
            }
            Err(CallFailure::Gone(reason)) => anyhow::bail!("{reason}"),
            // The target's refusals already name it ("satyamas does not allow …"); don't say it twice.
            Err(CallFailure::Remote(error)) if error.message.starts_with(&target.name) => anyhow::bail!("{}", error.message),
            Err(CallFailure::Remote(error)) => anyhow::bail!("{}: {}", target.name, error.message),
        }
    }

    pub(super) async fn tool_call_params(
        &self,
        thread: &Thread,
        hub: &Arc<dyn RemoteHub>,
        tool: &str,
        args: Value,
        operation_id: Uuid,
        project: Option<String>,
    ) -> PeerToolCallParams {
        let repo = match self.inner.store.project_get(thread.project_id) {
            Ok(Some(project)) if project.is_git => match project.repo.clone().filter(|repo| !repo.is_empty()) {
                Some(repo) => Some(repo),
                None => Some(crate::network::git_transfer::identity_of(std::path::Path::new(&project.path)).await),
            },
            _ => None,
        };
        let self_id = hub.self_id();
        PeerToolCallParams {
            tool: tool.to_string(),
            args,
            origin: Origin {
                machine_id: self_id.clone(),
                machine_name: hub.self_name(),
                thread_id: Some(thread.id),
                operation_id,
                kind: OriginKind::ToolCall,
                permission_cap: thread.permission_mode,
                hops: vec![self_id],
            },
            thread_title: thread.title.clone(),
            repo,
            project,
            deadline_ms: Some(TOOL_CALL_MAX_MS),
        }
    }

    /// Remember that this thread forwarded calls to `machine`, so archiving it tells that machine.
    pub(super) fn remember_forwarded(&self, thread_id: ThreadId, machine: &str) {
        let key = forwarded_key(thread_id);
        let Ok(current) = self.inner.store.meta_get(&key) else { return };
        let mut machines: Vec<String> = current.map(|text| text.split(',').map(str::to_owned).collect()).unwrap_or_default();
        if !machines.iter().any(|known| known == machine) {
            machines.push(machine.to_string());
            let _ = self.inner.store.meta_set(&key, &machines.join(","));
        }
    }

    /// Tell the machines this thread forwarded calls to that it was archived (best effort).
    pub(super) fn archive_forwarded(&self, thread_id: ThreadId) {
        let Some(hub) = self.remote_hub().cloned() else { return };
        let Ok(Some(machines)) = self.inner.store.meta_get(&forwarded_key(thread_id)) else { return };
        for machine in machines.split(',').filter(|machine| !machine.is_empty()).map(str::to_owned) {
            let hub = hub.clone();
            tokio::spawn(async move {
                let params = serde_json::to_value(PeerThreadArchiveInboundParams { thread_id }).unwrap_or(Value::Null);
                if let Err(error) = hub.call(&machine, PeerThreadArchiveInbound::NAME, params).await {
                    tracing::debug!(%thread_id, %machine, %error, "could not tell a machine its inbound thread was archived");
                }
            });
        }
    }

    // ---- kybern_machines ----

    /// `kybern_machines`: the members of the network, what each allows and has.
    pub(super) async fn execute_machines(&self, thread: &Thread) -> Result<Value> {
        let hub = self.forward_hub()?.clone();
        let members = hub.members();
        anyhow::ensure!(members.len() > 1, "This machine is not in a network with other machines.");
        // A thread another machine started lists the members but asks none of them: that would be a second hop.
        let ask_others = !super::fork_machine::second_hop(thread) && thread.inbound.is_none();
        let asked = members.iter().filter(|member| ask_others && !member.is_self && member.status == "online").map(|member| {
            let hub = hub.clone();
            let id = member.id.clone();
            async move {
                let params = self.tool_call_params(thread, &hub, MACHINES_TOOL, json!({}), Uuid::now_v7(), None).await;
                let call = hub.call(&id, PeerToolCall::NAME, serde_json::to_value(&params).unwrap_or(Value::Null));
                let answer = tokio::time::timeout(ABOUT_WAIT, call).await.ok()?.ok()?;
                let result: PeerToolCallResult = serde_json::from_value(answer).ok()?;
                Some((id, result.result))
            }
        });
        let mut about: HashMap<String, Value> = futures::future::join_all(asked).await.into_iter().flatten().collect();
        let mut machines = Vec::new();
        for member in &members {
            let details = if member.is_self { Some(self.machine_about_self().await) } else { about.remove(&member.id) };
            machines.push(member_json(member, details));
        }
        Ok(json!({ "machines": machines }))
    }

    /// What this machine says about itself to `kybern_machines`: its projects with their repository
    /// identity and the harnesses it can run.
    pub(super) async fn machine_about_self(&self) -> Value {
        let mut projects = Vec::new();
        let list = self.inner.store.projects_list().unwrap_or_default();
        for project in list.into_iter().filter(|project| !is_free_chat_project(project.id)).take(100) {
            let repo = if project.is_git {
                match project.repo.clone().filter(|repo| !repo.is_empty()) {
                    Some(repo) => Some(repo),
                    None => Some(crate::network::git_transfer::identity_of(std::path::Path::new(&project.path)).await),
                }
            } else {
                None
            };
            projects.push(json!({ "id": project.id, "name": project.name, "path": project.path, "repo": repo }));
        }
        let harnesses: Vec<Value> = ProviderKind::ALL
            .into_iter()
            .filter(|kind| self.inner.drivers.get(*kind).is_some())
            .map(|kind| json!({ "kind": kind }))
            .collect();
        json!({ "projects": projects, "harnesses": harnesses })
    }

    // ---- the target machine ----

    /// `peer.tool.call`: run one tool for an agent on machine `from`. `granted` is what this machine lets
    /// `from` use right now.
    pub async fn serve_tool_call(&self, from: &str, granted: &[Scope], params: PeerToolCallParams) -> Result<PeerToolCallResult, RpcError> {
        let hub = self.forward_hub().map_err(rpc_internal)?.clone();
        let from_name = hub.target(from).map(|target| target.name).unwrap_or_else(|| from.to_string());
        let tool = params.tool.clone();
        let class = forward::classify(&tool);
        // The origin machine is the session's; one hop only (§6.3).
        if params.origin.hops.len() != 1 || params.origin.hops[0] != from {
            return Err(RpcError::new(codes::FORBIDDEN, "Tool calls are not forwarded to a third machine."));
        }
        let Some(origin_thread) = params.origin.thread_id else {
            return Err(RpcError::invalid_params("origin.thread_id is required"));
        };
        if class == ToolClass::Delegation {
            return Err(RpcError::new(
                codes::FORBIDDEN,
                "Delegation runs with `machine` on kybern_agent_delegate, not as a forwarded tool.",
            ));
        }
        if !class.is_forwardable() {
            return Err(RpcError::new(
                codes::FORBIDDEN,
                format!(
                    "{tool} is not available to other machines. {} keeps its projects, settings and network to itself.",
                    hub.self_name()
                ),
            ));
        }
        for scope in class.scopes() {
            if !granted.contains(scope) {
                let capability = scope.capability().unwrap_or("tools");
                return Err(RpcError::new(
                    codes::FORBIDDEN,
                    format!("{} does not allow \"{capability}\" from other machines. Turn it on in Settings → Machines.", hub.self_name()),
                ));
            }
        }
        let args = match params.args.clone() {
            Value::Null => json!({}),
            args @ Value::Object(_) => args,
            _ => return Err(RpcError::invalid_params("args must be an object")),
        };
        if let Some(cached) = self.inbound_cached(from, params.origin.operation_id) {
            return Ok(cached);
        }
        self.inbound_sweep().await;
        let cap = params.origin.permission_cap;

        // The fence: below Full access a call may change only a thread the calling machine started.
        if let Some(target) = forward::changes_thread(&tool, &args) {
            let thread = self.inner.store.thread_get(target).map_err(rpc_internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            if thread.inbound.is_some() || thread.subagent.is_some() {
                return Err(RpcError::new(codes::FORBIDDEN, INBOUND_READ_ONLY));
            }
            if forward::fenced(cap) && !thread.origin.as_ref().is_some_and(|origin| origin.machine_id == from) {
                return Err(RpcError::new(
                    codes::FORBIDDEN,
                    format!(
                        "This thread was not started by {from_name}, so it can't change it at this permission mode. Use the app on {} or run the calling thread with Full access.",
                        hub.self_name()
                    ),
                ));
            }
        }

        let project = self.inbound_project(&params, &tool, &hub.self_name()).await?;
        let thread = self.inbound_thread(from, &from_name, &params, &project).await?;
        let mode = forward::effective_mode(cap, class);
        let (live, turn_id) = self.inbound_session(&thread, &from_name).await.map_err(rpc_internal)?;
        let mut call_thread = thread.clone();
        call_thread.permission_mode = mode;
        if thread.permission_mode != mode {
            self.update_thread(call_thread.clone()).map_err(rpc_internal)?;
        }
        live.touch();

        let call_id = format!("fwd:{}", params.origin.operation_id);
        let origin_json = json!({
            "machine": from_name, "machine_id": from, "thread_id": origin_thread, "thread_title": params.thread_title,
            "permission_cap": cap, "operation_id": params.origin.operation_id,
        });
        self.emit(
            thread.id,
            Some(turn_id),
            EventPayload::ToolCallStarted {
                call: ToolCall {
                    id: call_id.clone(),
                    name: tool.clone(),
                    input: json!({ "args": args, "from": origin_json }),
                    parent_id: None,
                },
                origin: EventOrigin::Root,
            },
        )
        .map_err(rpc_internal)?;
        tracing::info!(machine = from, %tool, ?cap, thread_id = %thread.id, "running a tool for another machine");

        self.inbound_enter(thread.id);
        let deadline = Duration::from_millis(params.deadline_ms.unwrap_or(TOOL_CALL_MAX_MS).clamp(1_000, TOOL_CALL_MAX_MS));
        let ran = tokio::time::timeout(
            deadline,
            self.run_inbound(&hub.self_name(), &call_thread, turn_id, &live, class, cap, &from_name, &params, &tool, args),
        )
        .await;
        self.inbound_leave(thread.id).await;
        let outcome: Result<Value, RpcError> = match ran {
            Ok(outcome) => outcome,
            Err(_) => Err(RpcError::new(
                codes::NOT_AVAILABLE,
                format!("{tool} did not finish within {} seconds on {}.", deadline.as_secs(), hub.self_name()),
            )),
        };
        let (output, is_error) = match &outcome {
            Ok(value) => (audit_output(value), false),
            Err(error) => (json!(error.message), true),
        };
        let _ = self.emit(
            thread.id,
            Some(turn_id),
            EventPayload::ToolCallCompleted { tool_call_id: call_id, output, output_omitted: false, stream_recoverable: false, is_error },
        );
        let result = PeerToolCallResult { result: outcome?, inbound_thread_id: thread.id };
        self.inbound_remember(from, params.origin.operation_id, &result);
        Ok(result)
    }

    /// The tool itself, after the checks: ask first when the table says so, then dispatch.
    #[allow(clippy::too_many_arguments)]
    async fn run_inbound(
        &self,
        this_machine: &str,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        class: ToolClass,
        cap: PermissionMode,
        from_name: &str,
        params: &PeerToolCallParams,
        tool: &str,
        args: Value,
    ) -> Result<Value, RpcError> {
        if class == ToolClass::Machines {
            return Ok(self.machine_about_self().await);
        }
        // Operate tools have no consent of their own, so the table's "ask on B" is a card here. Terminal
        // commands, note and task writes and computer use already ask by their own rules, which read the
        // mode the thread carries for this call.
        if class == ToolClass::Operate && forward::decide(cap, class) == Decision::Ask {
            let key = format!("fwd:{tool}:{}", hex_digest(&args));
            let summary = format!("From {from_name} · {}: {}", display_title(&params.thread_title), operate_summary(tool, &args));
            let (card, answer) = self
                .ask_daemon_approval_within(
                    thread.id,
                    turn_id,
                    live,
                    key,
                    tool,
                    args.clone(),
                    summary,
                    Some(params.origin.operation_id),
                    crate::computer::CONSENT_WAIT,
                )
                .await
                .map_err(tool_error)?;
            match answer {
                super::DaemonAnswer::Decided(ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways) => {
                    if !self.consume_daemon_approval(live, card, params.origin.operation_id).await.map_err(tool_error)? {
                        return Err(tool_error(format!(
                            "{this_machine} already used that approval for another call. Repeat the call to ask again."
                        )));
                    }
                }
                super::DaemonAnswer::Decided(_) | super::DaemonAnswer::TurnEnded => {
                    return Err(tool_error(format!("The user on {this_machine} declined this call.")));
                }
                super::DaemonAnswer::Pending => {
                    return Err(RpcError::new(
                        codes::NOT_AVAILABLE,
                        format!(
                            "Waiting for the user on {this_machine} to approve this call (\"From {from_name} · {}\"). Repeat the same call to keep waiting.",
                            display_title(&params.thread_title)
                        ),
                    ));
                }
            }
        }
        self.dispatch_native_tool(thread, turn_id, live, live.session_instance_id, tool, args).await.map_err(tool_error)
    }

    /// The project a call runs in: the one named, else this machine's checkout of the caller's repository,
    /// else (for tools that are not about a checkout) the free-chat project.
    async fn inbound_project(&self, params: &PeerToolCallParams, tool: &str, this_machine: &str) -> Result<Project, RpcError> {
        let bound = forward::project_bound(tool);
        if let Some(hint) = params.project.as_deref().map(str::trim).filter(|hint| !hint.is_empty()) {
            let projects = self.inner.store.projects_list().map_err(rpc_internal)?;
            let matches: Vec<Project> = projects
                .into_iter()
                .filter(|project| !is_free_chat_project(project.id))
                .filter(|project| project.id.to_string() == hint || project.name.eq_ignore_ascii_case(hint) || project.path == hint)
                .collect();
            return match matches.len() {
                0 => Err(RpcError::new(
                    codes::NOT_FOUND,
                    format!("{this_machine} has no project \"{hint}\". kybern_machines lists its projects."),
                )),
                1 => Ok(matches.into_iter().next().expect("one match")),
                _ => Err(RpcError::new(
                    codes::CONFLICT,
                    format!("{this_machine} has several projects called \"{hint}\". Use the project id from kybern_machines."),
                )),
            };
        }
        if let Some(repo) = &params.repo {
            match self.match_project(repo, None, this_machine).await {
                Ok(project) => return Ok(project),
                Err(error) if bound => return Err(error),
                Err(_) => {}
            }
        } else if bound {
            return Err(RpcError::new(
                codes::NOT_FOUND,
                format!("{this_machine} cannot tell which project you mean. Pass `project` (a name, id or path from kybern_machines)."),
            ));
        }
        self.ensure_free_chat_project().map_err(rpc_internal)
    }

    /// B's hidden thread for one origin thread and project, created on the first call.
    async fn inbound_thread(
        &self,
        from: &str,
        from_name: &str,
        params: &PeerToolCallParams,
        project: &Project,
    ) -> Result<Thread, RpcError> {
        let origin_thread = params.origin.thread_id.expect("checked by the caller");
        let _creating = self.inner.inbound.create.lock().await;
        let existing = self.inner.store.inbound_threads(from, origin_thread).map_err(rpc_internal)?;
        if let Some(thread) = existing.into_iter().find(|thread| thread.project_id == project.id && thread.status != ThreadStatus::Archived)
        {
            return Ok(thread);
        }
        let now = Utc::now();
        let title = format!("From {from_name} · {}", display_title(&params.thread_title));
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title,
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            // Stamped from the session, never from the payload; it never changes (§6.3).
            origin: Some(Origin {
                machine_id: from.to_string(),
                machine_name: from_name.to_string(),
                thread_id: Some(origin_thread),
                operation_id: params.origin.operation_id,
                kind: OriginKind::ToolCall,
                permission_cap: params.origin.permission_cap,
                hops: vec![from.to_string()],
            }),
            inbound: Some(Box::new(InboundInfo {
                machine_id: from.to_string(),
                thread_id: origin_thread,
                title: if params.thread_title.trim().is_empty() { INBOUND_TITLE_FALLBACK.to_string() } else { params.thread_title.clone() },
            })),
            moved: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        self.inner.store.thread_upsert(&thread).map_err(rpc_internal)?;
        let event = self.emit(thread.id, None, EventPayload::ThreadCreated { thread: thread.clone() }).map_err(rpc_internal)?;
        let thread = Thread { last_seq: event.seq, ..thread };
        self.inner.store.thread_upsert(&thread).map_err(rpc_internal)?;
        Ok(thread)
    }

    /// The inert session and the turn that carry an inbound thread's calls. Created with the first call
    /// and retired when it has been idle for a while, when its thread is archived or on restart.
    async fn inbound_session(&self, thread: &Thread, from_name: &str) -> Result<(Arc<LiveSession>, TurnId)> {
        let _creating = self.inner.inbound.create.lock().await;
        let existing = self.inner.sessions.lock().await.get(&thread.id).cloned();
        if let Some(live) = existing
            && !live.is_released()
        {
            let current = live.turn.lock().await.as_ref().filter(|turn| !turn.completed).map(|turn| turn.id);
            if let Some(turn) = current {
                return Ok((live, turn));
            }
        }
        let turn_id = Uuid::now_v7();
        let live = Arc::new(LiveSession {
            session_instance_id: Uuid::now_v7(),
            session: Box::new(InertSession),
            computer_tools: false,
            last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
            released: std::sync::atomic::AtomicBool::new(false),
            retained: std::sync::atomic::AtomicBool::new(false),
            stop_cleanup: std::sync::atomic::AtomicBool::new(false),
            turn: AsyncMutex::new(Some(ActiveTurn {
                response_id: Uuid::now_v7(),
                id: turn_id,
                started: Instant::now(),
                startup_started: Instant::now(),
                provider: ProviderKind::ClaudeCode,
                session_reused: false,
                first_event_observed: false,
                messages: HashMap::new(),
                active_messages: HashMap::new(),
                terminal_message_id: None,
                completed: false,
                pending_completion: None,
                internal: None,
                rotation_seed: None,
            })),
            continuation: AsyncMutex::new(None),
            turn_ready: tokio::sync::Notify::new(),
            last_turn_id: AsyncMutex::new(Some(turn_id)),
            tasks: AsyncMutex::new(HashMap::new()),
            task_aliases: AsyncMutex::new(HashMap::new()),
            deferred_checkpoints: AsyncMutex::new(std::collections::HashSet::new()),
            pending: AsyncMutex::new(HashMap::new()),
            daemon_approvals: AsyncMutex::new(HashMap::new()),
            app_tool_requests: AsyncMutex::new(std::collections::HashSet::new()),
            app_tool_permits: Arc::new(tokio::sync::Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
            brief_revision: AsyncMutex::new(None),
            lead_settings: AsyncMutex::new(None),
            context_usage: std::sync::Mutex::new(None),
            instructions_unconfirmed: std::sync::atomic::AtomicBool::new(false),
        });
        let message = UserMessage::text(format!("Tool calls from {from_name} · {}", display_title(&thread.title)));
        self.emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id: Uuid::now_v7(), message })?;
        self.inner.sessions.lock().await.insert(thread.id, live.clone());
        self.inner
            .inbound
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(thread.id, InboundSession { turn_id, in_flight: 0, last_call: Instant::now(), started: Instant::now() });
        Ok((live, turn_id))
    }

    fn inbound_enter(&self, thread_id: ThreadId) {
        if let Some(session) = self.inner.inbound.sessions.lock().unwrap_or_else(|error| error.into_inner()).get_mut(&thread_id) {
            session.in_flight += 1;
            session.last_call = Instant::now();
        }
    }

    /// A call ended: with none left in flight the thread rests as idle (an approval leaves it running).
    async fn inbound_leave(&self, thread_id: ThreadId) {
        let idle = {
            let mut sessions = self.inner.inbound.sessions.lock().unwrap_or_else(|error| error.into_inner());
            sessions.get_mut(&thread_id).is_some_and(|session| {
                session.in_flight = session.in_flight.saturating_sub(1);
                session.last_call = Instant::now();
                session.in_flight == 0
            })
        };
        if idle
            && let Ok(Some(mut thread)) = self.inner.store.thread_get(thread_id)
            && matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
        {
            thread.status = ThreadStatus::Idle;
            let _ = self.update_thread(thread);
        }
    }

    /// Retire the inbound sessions nobody has called for a while. A session with a call in flight, or an
    /// approval nobody answered yet, stays.
    async fn inbound_sweep(&self) {
        let stale: Vec<(ThreadId, TurnId, Instant)> = {
            let sessions = self.inner.inbound.sessions.lock().unwrap_or_else(|error| error.into_inner());
            sessions
                .iter()
                .filter(|(_, session)| session.in_flight == 0 && session.last_call.elapsed() >= SESSION_IDLE)
                .map(|(id, session)| (*id, session.turn_id, session.started))
                .collect()
        };
        for (thread_id, turn_id, started) in stale {
            let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
            if let Some(live) = &live
                && live.daemon_approvals.lock().await.values().any(|entry| entry.decision.borrow().is_none())
            {
                continue;
            }
            self.retire_inbound_session(thread_id, turn_id, started.elapsed()).await;
        }
    }

    async fn retire_inbound_session(&self, thread_id: ThreadId, turn_id: TurnId, ran_for: Duration) {
        self.inner.inbound.sessions.lock().unwrap_or_else(|error| error.into_inner()).remove(&thread_id);
        if let Some(live) = self.inner.sessions.lock().await.remove(&thread_id) {
            live.mark_released();
            if let Some(turn) = live.turn.lock().await.as_mut() {
                turn.completed = true;
            }
            let _ = self.resolve_finished_requests(thread_id, turn_id, &live).await;
        }
        let _ = self.emit(
            thread_id,
            Some(turn_id),
            EventPayload::TurnCompleted {
                stop_reason: StopReason::Completed,
                usage: Usage::default(),
                cost_usd: None,
                duration_ms: ran_for.as_millis() as u64,
                terminal_message_id: None,
            },
        );
    }

    /// `peer.thread.archive_inbound`: the origin thread on `from` was archived.
    pub async fn archive_inbound_threads(&self, from: &str, origin_thread: ThreadId) -> Result<(), RpcError> {
        for thread in self.inner.store.inbound_threads(from, origin_thread).map_err(rpc_internal)? {
            if thread.status == ThreadStatus::Archived {
                continue;
            }
            let session = self.inner.inbound.sessions.lock().unwrap_or_else(|error| error.into_inner()).remove(&thread.id);
            if let Some(session) = session {
                self.retire_inbound_session(thread.id, session.turn_id, session.started.elapsed()).await;
            }
            self.archive_single(thread.id).await.map_err(rpc_internal)?;
        }
        Ok(())
    }

    fn inbound_cached(&self, from: &str, operation: Uuid) -> Option<PeerToolCallResult> {
        let results = self.inner.inbound.results.lock().unwrap_or_else(|error| error.into_inner());
        let (_, value) = results.iter().find(|((machine, id), _)| machine == from && *id == operation)?;
        serde_json::from_value(value.clone()).ok()
    }

    fn inbound_remember(&self, from: &str, operation: Uuid, result: &PeerToolCallResult) {
        let Ok(value) = serde_json::to_value(result) else { return };
        let mut results = self.inner.inbound.results.lock().unwrap_or_else(|error| error.into_inner());
        if results.len() >= RESULT_CACHE {
            results.remove(0);
        }
        results.push(((from.to_string(), operation), value));
    }
}

/// What the agent reads when its target is not connected.
pub(crate) fn offline_message(name: &str, last_seen: Option<chrono::DateTime<Utc>>) -> String {
    let seen = match last_seen {
        Some(at) => {
            let minutes = (Utc::now() - at).num_minutes().max(0);
            match minutes {
                0 => " (last seen just now)".to_string(),
                1..=59 => format!(" (last seen {minutes} min ago)"),
                60..=2879 => format!(" (last seen {} h ago)", minutes / 60),
                _ => format!(" (last seen {} days ago)", minutes / 1440),
            }
        }
        None => String::new(),
    };
    format!("{name} is offline{seen}. Tool calls do not queue: use kybern_agent_delegate with machine to queue work there.")
}

fn member_json(member: &MemberView, details: Option<Value>) -> Value {
    let mut out = json!({
        "machine_id": member.id,
        "name": member.name,
        "os": member.os,
        "this_machine": member.is_self,
        "status": member.status,
        "allows": member.capabilities,
        "features": member.features,
    });
    if let Some(version) = &member.version {
        out["version"] = json!(version);
    }
    if let Some(at) = member.last_seen
        && !member.is_self
    {
        out["last_seen"] = json!(at);
    }
    let mut harnesses = member.harnesses.iter().map(|harness| json!(harness)).collect::<Vec<_>>();
    match details {
        Some(details) => {
            if harnesses.is_empty() {
                harnesses = details.get("harnesses").and_then(Value::as_array).cloned().unwrap_or_default();
            }
            out["projects"] = details.get("projects").cloned().unwrap_or_else(|| json!([]));
        }
        None => {
            out["projects"] = Value::Null;
            out["note"] = json!(if member.status == "online" {
                "Its projects could not be read just now."
            } else {
                "Its projects are unknown while it is not online."
            });
        }
    }
    out["harnesses"] = json!(harnesses);
    out
}

fn display_title(title: &str) -> &str {
    let title = title.trim();
    if title.is_empty() { INBOUND_TITLE_FALLBACK } else { title }
}

fn hex_digest(value: &Value) -> String {
    let digest = Sha256::digest(serde_json::to_vec(value).unwrap_or_default());
    digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One line for an approval card about a forwarded operate tool.
fn operate_summary(tool: &str, args: &Value) -> String {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").chars().take(160).collect::<String>();
    match tool {
        "kybern_thread_send" => format!("send a message to a thread: {}", text("body")),
        "kybern_thread_interrupt" => "interrupt a thread".to_string(),
        "kybern_preview_open" => format!("show {} in Preview", text("target")),
        other => format!("run {other}"),
    }
}

/// An audit copy of a result: capped, and with embedded images left out.
fn audit_output(value: &Value) -> Value {
    let mut copy = value.clone();
    if let Some(blocks) = copy.get_mut("_kybern_content").and_then(Value::as_array_mut) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) == Some("image")
                && let Some(object) = block.as_object_mut()
            {
                object.insert("data".into(), json!("[image omitted]"));
            }
        }
    }
    let text = copy.to_string();
    if text.len() <= AUDIT_OUTPUT_BYTES {
        return copy;
    }
    let mut end = AUDIT_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!(format!("{}… [{} bytes cut]", &text[..end], text.len() - end))
}
