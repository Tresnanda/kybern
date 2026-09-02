//! Method dispatch. Every handler parses typed params, checks nothing about
//! auth (the connection layer already did), and returns a typed result.

use kybern_protocol::methods::*;
use kybern_protocol::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::state::AppState;
use crate::ws::ConnectionCtx;

pub async fn dispatch(state: &AppState, ctx: &ConnectionCtx, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        DaemonInfoMethod::NAME => {
            let info = DaemonInfo {
                version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: PROTOCOL_VERSION,
                environment_id: state.environment_id.clone(),
                hostname: hostname(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                data_dir: state.paths.root.display().to_string(),
                scopes: ctx.principal.scopes.clone(),
                started_at: state.started_at,
            };
            ok(info)
        }
        ProvidersList::NAME => {
            let mut providers = Vec::new();
            for kind in ProviderKind::ALL {
                match state.drivers.get(kind) {
                    Some(d) => providers.push(d.probe(None).await),
                    None => providers.push(ProviderStatus {
                        kind,
                        display_name: kind.display_name().to_string(),
                        available: false,
                        binary_path: None,
                        version: None,
                        unavailable_reason: Some("driver not implemented yet".into()),
                        supported_permission_modes: vec![],
                        supports_fork: false,
                        supports_model_switch: false,
                        instances: vec![],
                    }),
                }
            }
            ok(ProvidersListResult { providers })
        }
        ProjectsList::NAME => ok(ProjectsListResult { projects: state.store.projects_list().map_err(internal)? }),
        ProjectsAdd::NAME => {
            let p: ProjectsAddParams = parse(params)?;
            ok(state.orchestrator.add_project(p.path, p.name).map_err(bad)?)
        }
        ProjectsUpdate::NAME => {
            let p: ProjectsUpdateParams = parse(params)?;
            let mut project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            if let Some(n) = p.name {
                project.name = n;
            }
            if let Some(w) = p.worktrees_default {
                project.worktrees_default = w;
            }
            project.updated_at = chrono::Utc::now();
            state.store.project_update(&project).map_err(internal)?;
            ok(project)
        }
        ProjectsRemove::NAME => {
            let p: ProjectsRemoveParams = parse(params)?;
            state.store.project_delete(p.project_id).map_err(internal)?;
            ok(Empty {})
        }
        ThreadsList::NAME => {
            let p: ThreadsListParams = parse_or_default(params)?;
            ok(ThreadsListResult { threads: state.store.threads_list(p.project_id, p.include_archived).map_err(internal)? })
        }
        ThreadsCreate::NAME => {
            let p: ThreadsCreateParams = parse(params)?;
            ok(state.orchestrator.create_thread(p).await.map_err(bad)?)
        }
        ThreadsGet::NAME => {
            let p: ThreadsGetParams = parse(params)?;
            let thread = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let store = state.store.clone();
            let id = p.thread_id;
            let (transcript, pending_approvals) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                let events = store.events_for_thread(id)?;
                Ok((kybern_store::project_transcript(&events), store.approvals_pending(Some(id))?))
            })
            .await
            .map_err(internal)?
            .map_err(internal)?;
            ok(ThreadsGetResult { thread, transcript, pending_approvals })
        }
        ThreadsUpdate::NAME => {
            let p: ThreadsUpdateParams = parse(params)?;
            let mode = p.permission_mode;
            let model = p.model.clone();
            let thread = state.orchestrator.update_thread_fields(p).map_err(bad)?;
            state.orchestrator.apply_session_settings(thread.id, mode, model.as_deref()).await.map_err(provider_err)?;
            ok(thread)
        }
        ThreadsArchive::NAME => {
            let p: ThreadsArchiveParams = parse(params)?;
            state.orchestrator.archive_thread(p.thread_id).await.map_err(bad)?;
            ok(Empty {})
        }
        ThreadsSend::NAME => {
            let p: ThreadsSendParams = parse(params)?;
            let (turn_id, message_id) = state.orchestrator.send(p.thread_id, p.message).await.map_err(|e| {
                let msg = e.to_string();
                if msg.contains("busy") { RpcError::new(codes::THREAD_BUSY, msg) } else { bad(e) }
            })?;
            ok(ThreadsSendResult { turn_id, message_id })
        }
        ThreadsInterrupt::NAME => {
            let p: ThreadsInterruptParams = parse(params)?;
            state.orchestrator.interrupt(p.thread_id).await.map_err(bad)?;
            ok(Empty {})
        }
        ThreadsRegenerateTitle::NAME => {
            let p: ThreadsRegenerateTitleParams = parse(params)?;
            let events = state.store.events_for_thread(p.thread_id).map_err(internal)?;
            let first = events.iter().find_map(|e| match &e.payload {
                EventPayload::TurnStarted { message, .. } => Some(message.clone()),
                _ => None,
            });
            let title = first.map(|m| crate::orchestrator::title_from_message(&m)).unwrap_or_else(|| crate::orchestrator::DEFAULT_TITLE.into());
            let thread = state
                .orchestrator
                .update_thread_fields(ThreadsUpdateParams { thread_id: p.thread_id, title: Some(title), pinned: None, permission_mode: None, model: None })
                .map_err(bad)?;
            ok(thread)
        }
        ApprovalsRespond::NAME => {
            let p: ApprovalsRespondParams = parse(params)?;
            state.orchestrator.respond_approval(p.approval_id, p.decision).await.map_err(bad)?;
            ok(Empty {})
        }
        ApprovalsList::NAME => {
            let p: ApprovalsListParams = parse_or_default(params)?;
            ok(ApprovalsListResult { approvals: state.store.approvals_pending(p.thread_id).map_err(internal)? })
        }
        EventsSubscribe::NAME => {
            let p: EventsSubscribeParams = parse_or_default(params)?;
            let head_seq = state.store.events_head_seq().map_err(internal)?;
            let subscription_id = ctx.subscribe(p.thread_id, head_seq).await;
            if let Some(after) = p.after_seq {
                ctx.replay(state, subscription_id, p.thread_id, after, head_seq).await.map_err(internal)?;
            }
            ok(EventsSubscribeResult { subscription_id, head_seq })
        }
        EventsUnsubscribe::NAME => {
            let p: EventsUnsubscribeParams = parse(params)?;
            ctx.unsubscribe(p.subscription_id).await;
            ok(Empty {})
        }
        EventsRange::NAME => {
            let p: EventsRangeParams = parse(params)?;
            let limit = p.limit.clamp(1, 5000);
            let mut events = state.store.events_after(Some(p.thread_id), p.after_seq, limit + 1).map_err(internal)?;
            let has_more = events.len() > limit as usize;
            events.truncate(limit as usize);
            ok(EventsRangeResult { events, has_more })
        }
        _ => Err(RpcError::method_not_found(method)),
    }
}

fn ok<T: Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(internal)
}

fn parse<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(RpcError::invalid_params)
}

fn parse_or_default<T: DeserializeOwned + Default>(v: Value) -> Result<T, RpcError> {
    if v.is_null() { Ok(T::default()) } else { parse(v) }
}

fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::internal(e)
}

/// User-facing failures from the orchestrator: not found, busy, bad input.
fn bad(e: anyhow::Error) -> RpcError {
    let msg = e.to_string();
    if msg.contains("not found") {
        RpcError::new(codes::NOT_FOUND, msg)
    } else if msg.contains("not available") || msg.contains("not found:") {
        RpcError::new(codes::PROVIDER_UNAVAILABLE, msg)
    } else {
        RpcError::new(codes::INVALID_PARAMS, msg)
    }
}

fn provider_err(e: anyhow::Error) -> RpcError {
    RpcError::new(codes::PROVIDER_ERROR, e.to_string())
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
