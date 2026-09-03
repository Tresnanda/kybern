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
        DaemonShutdown::NAME => {
            if ctx.principal.label != "bootstrap" {
                return Err(RpcError::new(codes::FORBIDDEN, "daemon shutdown requires the local bootstrap client"));
            }
            let shutdown = state.shutdown.clone();
            tokio::spawn(async move {
                // Let the response reach the desktop before closing every socket.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                shutdown.cancel();
            });
            ok(Empty {})
        }
        ProvidersList::NAME => {
            let p: ProvidersListParams = parse_or_default(params)?;
            let cwd = p
                .project_id
                .map(|project_id| {
                    state
                        .store
                        .project_get(project_id)
                        .map_err(internal)?
                        .map(|project| std::path::PathBuf::from(project.path))
                        .ok_or_else(|| RpcError::not_found("project"))
                })
                .transpose()?;
            let settings = state.settings.get();
            let probes = ProviderKind::ALL.into_iter().map(|kind| {
                let driver = state.drivers.get(kind);
                let provider_settings = settings.providers.get(&kind).cloned().unwrap_or_default();
                let context = kybern_drivers::ProbeContext {
                    binary: provider_settings.binary.map(std::path::PathBuf::from),
                    cwd: cwd.clone(),
                    env: provider_settings.env,
                };
                async move {
                    match driver {
                        Some(driver) => driver.probe_with_context(&context).await,
                        None => ProviderStatus {
                            kind,
                            display_name: kind.display_name().to_string(),
                            available: false,
                            binary_path: None,
                            version: None,
                            unavailable_reason: Some("driver not implemented yet".into()),
                            supported_permission_modes: vec![],
                            supports_fork: false,
                            supports_model_switch: false,
                            supports_effort_switch: false,
                            supported_efforts: vec![],
                            models: vec![],
                            instances: vec![],
                        },
                    }
                }
            });
            let providers = futures::future::join_all(probes).await;
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
            let effort = p.effort.clone();
            let thread = state.orchestrator.update_thread_fields(p).map_err(bad)?;
            state.orchestrator.apply_session_settings(thread.id, mode, model.as_deref(), effort.as_deref()).await.map_err(provider_err)?;
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
            let thread = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let events = state.store.events_for_thread(p.thread_id).map_err(internal)?;
            let first = events.iter().find_map(|e| match &e.payload {
                EventPayload::TurnStarted { message, .. } => Some(message.clone()),
                _ => None,
            });
            let generated = match &first {
                Some(m) => state.orchestrator.generate_title(&thread, m).await.map_err(provider_err)?,
                None => None,
            };
            let title = generated
                .or_else(|| first.map(|m| crate::orchestrator::title_from_message(&m)))
                .unwrap_or_else(|| crate::orchestrator::DEFAULT_TITLE.into());
            let thread = state
                .orchestrator
                .update_thread_fields(ThreadsUpdateParams {
                    thread_id: p.thread_id,
                    title: Some(title),
                    pinned: None,
                    permission_mode: None,
                    model: None,
                    effort: None,
                })
                .map_err(bad)?;
            ok(thread)
        }
        ThreadsCheckpoints::NAME => {
            let p: ThreadsCheckpointsParams = parse(params)?;
            ok(ThreadsCheckpointsResult { checkpoints: state.store.checkpoints_for_thread(p.thread_id).map_err(internal)? })
        }
        ThreadsDiff::NAME => {
            let p: ThreadsDiffParams = parse(params)?;
            ok(state.orchestrator.diff(p.thread_id, p.turn_id).await.map_err(bad)?)
        }
        ThreadsRevert::NAME => {
            let p: ThreadsRevertParams = parse(params)?;
            let (commit, conversation_rewound) = state.orchestrator.revert(p.thread_id, p.turn_id).await.map_err(bad)?;
            ok(ThreadsRevertResult { commit, conversation_rewound })
        }
        TerminalsCreate::NAME => {
            let p: TerminalsCreateParams = parse(params)?;
            let cwd = match (p.cwd, p.thread_id) {
                (Some(c), _) => c,
                (None, Some(t)) => state.store.thread_get(t).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?.cwd,
                (None, None) => return Err(RpcError::invalid_params("thread_id or cwd is required")),
            };
            let t = state.terminals.create(p.thread_id, cwd, p.cols, p.rows, p.command).map_err(internal)?;
            ok(t.info())
        }
        TerminalsList::NAME => {
            let p: TerminalsListParams = parse_or_default(params)?;
            ok(TerminalsListResult { terminals: state.terminals.list(p.thread_id) })
        }
        TerminalsInput::NAME => {
            use base64::Engine;
            let p: TerminalsInputParams = parse(params)?;
            let t = state.terminals.get(p.terminal_id).ok_or_else(|| RpcError::not_found("terminal"))?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(&p.data).map_err(RpcError::invalid_params)?;
            t.write(&bytes).map_err(internal)?;
            ok(Empty {})
        }
        TerminalsResize::NAME => {
            let p: TerminalsResizeParams = parse(params)?;
            let t = state.terminals.get(p.terminal_id).ok_or_else(|| RpcError::not_found("terminal"))?;
            t.resize(p.cols, p.rows).map_err(internal)?;
            ok(Empty {})
        }
        TerminalsClose::NAME => {
            let p: TerminalsCloseParams = parse(params)?;
            ctx.unsubscribe_terminal(p.terminal_id).await;
            state.terminals.close(p.terminal_id).map_err(bad)?;
            ok(Empty {})
        }
        TerminalsSubscribe::NAME => {
            let p: TerminalsSubscribeParams = parse(params)?;
            let t = state.terminals.get(p.terminal_id).ok_or_else(|| RpcError::not_found("terminal"))?;
            ctx.subscribe_terminal(t, p.replay).await;
            ok(Empty {})
        }
        TerminalsUnsubscribe::NAME => {
            let p: TerminalsCloseParams = parse(params)?;
            ctx.unsubscribe_terminal(p.terminal_id).await;
            ok(Empty {})
        }
        SettingsGet::NAME => ok(state.settings.get()),
        SettingsUpdate::NAME => {
            let p: SettingsUpdateParams = parse(params)?;
            ok(state.settings.set(p.settings).map_err(internal)?)
        }
        UsageSummary::NAME => {
            let p: UsageSummaryParams = parse_or_default(params)?;
            let rows = state.store.usage_summary(p.since, p.group_by).map_err(internal)?;
            let mut total = UsageRow { key: "total".into(), turns: 0, usage: Usage::default(), cost_usd: 0.0 };
            for r in &rows {
                total.turns += r.turns;
                total.usage.add(&r.usage);
                total.cost_usd += r.cost_usd;
            }
            ok(UsageSummaryResult { rows, total })
        }
        PairingCreate::NAME => {
            let p: PairingCreateParams = parse_or_default(params)?;
            let (code, expires_at) = state.pairing.create(p.label);
            let port = state.port.load(std::sync::atomic::Ordering::Relaxed);
            ok(PairingCreateResult { code, expires_at, endpoints: crate::access::advertised_endpoints(port) })
        }
        TokensList::NAME => ok(TokensListResult { tokens: state.store.tokens_list().map_err(internal)? }),
        TokensRevoke::NAME => {
            let p: TokensRevokeParams = parse(params)?;
            if p.token_id == ctx.principal.token_id {
                return Err(RpcError::invalid_params("a token cannot revoke itself"));
            }
            state.store.token_revoke(p.token_id).map_err(internal)?;
            ok(Empty {})
        }
        FilesSearch::NAME => {
            let p: FilesSearchParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            let root = std::path::PathBuf::from(&project.path);
            let files = crate::files::list(&root).await.map_err(internal)?;
            let total = files.len() as u32;
            let files = crate::files::rank(files, &p.query, p.limit as usize);
            ok(FilesSearchResult { files, total })
        }
        FilesList::NAME => {
            let p: FilesListParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            let entries = crate::files::list_dir(std::path::Path::new(&project.path), &p.path).await.map_err(bad)?;
            ok(FilesListResult { entries })
        }
        FilesRead::NAME => {
            let p: FilesReadParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            ok(crate::files::read_file(std::path::Path::new(&project.path), &p.path, p.max_bytes).await.map_err(bad)?)
        }
        GitStatusMethod::NAME => {
            let p: GitStatusParams = parse(params)?;
            let t = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            ok(crate::github::status(std::path::Path::new(&t.cwd)).await.map_err(internal)?)
        }
        GitBranches::NAME => {
            let p: GitBranchesParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            ok(crate::github::branches(std::path::Path::new(&project.path)).await.map_err(internal)?)
        }
        GitCommit::NAME => {
            let p: GitCommitParams = parse(params)?;
            let t = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let cwd = std::path::PathBuf::from(&t.cwd);
            if !crate::github::has_changes(&cwd).await {
                return Err(RpcError::invalid_params("nothing to commit"));
            }
            let message = match p.message {
                Some(m) => m,
                None => state.orchestrator.generate_commit_message(&t).await.map_err(provider_err)?,
            };
            let commit = crate::github::commit_all(&cwd, &message).await.map_err(bad)?;
            ok(GitCommitResult { commit, message })
        }
        PrCreate::NAME => {
            let p: PrCreateParams = parse(params)?;
            let t = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let cwd = std::path::PathBuf::from(&t.cwd);
            if !crate::github::gh_available().await {
                return Err(RpcError::new(codes::PROVIDER_UNAVAILABLE, "GitHub CLI (gh) is not installed or not logged in"));
            }
            if p.commit_first && crate::github::has_changes(&cwd).await {
                let message = state.orchestrator.generate_commit_message(&t).await.map_err(provider_err)?;
                crate::github::commit_all(&cwd, &message).await.map_err(bad)?;
            }
            let base = match p.base {
                Some(b) => b,
                None => crate::github::default_base(&cwd).await,
            };
            crate::github::push_current(&cwd).await.map_err(bad)?;
            let (title, body) = match (p.title, p.body) {
                (Some(t), Some(b)) => (t, b),
                (title, body) => {
                    let (gt, gb) = state.orchestrator.generate_pr_text(&t, &base).await.map_err(provider_err)?;
                    (title.unwrap_or(gt), body.unwrap_or(gb))
                }
            };
            ok(crate::github::pr_create(&cwd, &title, &body, &base, p.draft).await.map_err(bad)?)
        }
        PrList::NAME => {
            let p: PrListParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            ok(PrListResult {
                pull_requests: crate::github::pr_list(std::path::Path::new(&project.path), &p.state, p.limit).await.map_err(bad)?,
            })
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
