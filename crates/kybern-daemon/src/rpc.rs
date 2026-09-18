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
        DaemonActivityMethod::NAME => ok(crate::maintenance::activity(state).await.map_err(internal)?),
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
        SessionsList::NAME => {
            let p: SessionsListParams = parse(params)?;
            let cwd = match p.project_id {
                Some(id) => Some(std::path::PathBuf::from(
                    state.store.project_get(id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?.path,
                )),
                None => None,
            };
            let settings = crate::settings::provider_settings(&state.settings.get(), p.provider, cwd.as_deref().and_then(|p| p.to_str()));
            let context = kybern_drivers::ProbeContext { binary: settings.binary.map(std::path::PathBuf::from), cwd, env: settings.env };
            let driver = state.drivers.get(p.provider).ok_or_else(|| RpcError::not_found("harness"))?;
            let mut result =
                driver.list_sessions(&context, p.cursor.as_deref(), p.query.as_deref().unwrap_or("")).await.map_err(|e| bad(e.into()))?;
            let threads = state.store.threads_list(None, true).map_err(internal)?;
            for session in &mut result.sessions {
                session.thread_id = threads
                    .iter()
                    .find(|thread| thread.provider.kind == session.provider && thread.provider_session_id.as_deref() == Some(&session.id))
                    .map(|thread| thread.id);
            }
            ok(result)
        }
        SessionsResume::NAME => {
            let p: SessionsResumeParams = parse(params)?;
            ok(state.orchestrator.resume_external_session(p).await.map_err(bad)?)
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
            let cache_key = serde_json::to_string(&(p.project_id, cwd.as_ref(), &settings.providers)).map_err(internal)?;
            let providers = state
                .provider_catalogs
                .get_or_refresh(cache_key, p.force_refresh, || async move {
                    let probes = ProviderKind::ALL.into_iter().map(|kind| {
                        let driver = state.drivers.get(kind);
                        let provider_settings =
                            crate::settings::provider_settings(&settings, kind, cwd.as_deref().and_then(|p| p.to_str()));
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
                    futures::future::join_all(probes).await
                })
                .await;
            ok(ProvidersListResult { providers })
        }
        HarnessUpdatesList::NAME => ok(HarnessUpdatesResult { updates: state.harness_updates.list() }),
        HarnessUpdatesRun::NAME => {
            let p: HarnessUpdateParams = parse(params)?;
            let record = state.harness_updates.request(&state.store, p.kind);
            tokio::spawn(crate::harness_updates::tick(state.clone()));
            ok(record)
        }
        DaemonUpdateStatusMethod::NAME => ok(state.daemon_updates.get()),
        DaemonUpdateCheck::NAME => ok(crate::self_update::check(state).await),
        DaemonUpdateRun::NAME => {
            let record = state.daemon_updates.request(&state.store);
            tokio::spawn(crate::self_update::tick(state.clone()));
            ok(record)
        }
        ProjectsList::NAME => ok(ProjectsListResult { projects: state.store.projects_list().map_err(internal)? }),
        ProjectsBrowse::NAME => {
            let p: ProjectsBrowseParams = parse_or_default(params)?;
            ok(crate::files::browse_directories(p.path).await.map_err(bad)?)
        }
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
            let threads = state.store.threads_list(p.project_id, p.include_archived).map_err(internal)?;
            let activity = threads
                .iter()
                .map(|thread| {
                    let tasks = state.store.runtime_tasks_for_thread(thread.id).map_err(internal)?;
                    Ok(kybern_store::project_thread_activity(thread.id, &tasks))
                })
                .collect::<Result<Vec<_>, RpcError>>()?
                .into_iter()
                .filter(|summary| summary.state.is_some())
                .collect();
            ok(ThreadsListResult { threads, activity })
        }
        ThreadsSearch::NAME => {
            let p: ThreadsSearchParams = parse_or_default(params)?;
            let project_id = (!p.all_projects).then_some(p.project_id).flatten();
            let preferred_project_id = p.all_projects.then_some(p.project_id).flatten();
            let page = state
                .store
                .search_thread_history(
                    project_id,
                    preferred_project_id,
                    p.query.as_deref(),
                    p.include_archived,
                    p.cursor.as_deref(),
                    p.limit,
                )
                .map_err(bad)?;
            ok(ThreadsSearchResult { threads: page.threads, next_cursor: page.next_cursor })
        }
        ThreadsRead::NAME => {
            let p: ThreadsReadParams = parse(params)?;
            let page = state
                .store
                .read_thread_history(p.thread_id, p.before_seq, p.through_seq, p.limit, p.message_seq, p.text_offset)
                .map_err(bad)?;
            let messages = page
                .messages
                .into_iter()
                .map(|message| ThreadReadMessage {
                    seq: message.seq,
                    turn_id: message.turn_id,
                    role: message.role,
                    text: message.text,
                    created_at: message.created_at,
                    attribution: message.attribution,
                    text_offset: message.text_offset,
                    next_text_offset: message.next_text_offset,
                    text_truncated: message.text_truncated,
                })
                .collect();
            ok(ThreadsReadResult { thread: page.thread, messages, next_before_seq: page.next_before_seq, through_seq: page.through_seq })
        }
        ThreadsCreate::NAME => {
            let p: ThreadsCreateParams = parse(params)?;
            ok(state.orchestrator.create_thread(p).await.map_err(bad)?)
        }
        ThreadsGet::NAME => {
            let p: ThreadsGetParams = parse(params)?;
            if p.transcript_limit.is_some_and(|limit| !(1..=500).contains(&limit))
                || (p.before_seq.is_some() && p.transcript_limit.is_none())
                || p.before_seq.is_some_and(|seq| seq < 0)
                || p.through_seq.is_some_and(|seq| seq < 0)
            {
                return Err(RpcError::invalid_params("use transcript_limit 1..500 and nonnegative history cursors"));
            }
            let mut thread = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let through_seq = p.through_seq.map_or(thread.last_seq, |seq| seq.min(thread.last_seq));
            thread.last_seq = through_seq;
            let store = state.store.clone();
            let id = p.thread_id;
            let projection = state
                .thread_projections
                .get_or_build((id, through_seq), move || {
                    Ok(crate::thread_projection::ThreadProjection {
                        transcript: store.project_transcript_through(id, through_seq)?,
                        runtime_tasks: store.runtime_tasks_for_thread_through(id, through_seq)?,
                        provider_usage: store.provider_usage_through(id, through_seq)?,
                        provider_commands: store.provider_commands_through(id, through_seq)?,
                        pending_questions: store.pending_questions_through(id, through_seq)?,
                    })
                })
                .await
                .map_err(internal)?;
            let (mut transcript, next_before_seq) =
                kybern_store::transcript_page_ref(&projection.transcript, p.transcript_limit, p.before_seq);
            if p.defer_tool_stream.unwrap_or(false) {
                state.store.mark_tool_streams_omitted_through(id, &mut transcript, through_seq).map_err(internal)?;
            }
            if p.include_tool_output.unwrap_or(true) {
                state.store.hydrate_tool_outputs_through(id, &mut transcript, through_seq).map_err(internal)?;
            }
            let pending_approvals = state.store.approvals_pending(Some(id)).map_err(internal)?;
            ok(ThreadsGetResult {
                notes: state.store.thread_notes(thread.id).map_err(internal)?,
                thread,
                transcript,
                next_before_seq,
                pending_approvals,
                runtime_tasks: projection.runtime_tasks.clone(),
                provider_usage: projection.provider_usage.clone(),
                provider_commands: projection.provider_commands.clone(),
                pending_questions: projection.pending_questions.clone(),
            })
        }
        ThreadsToolOutput::NAME => {
            let p: ThreadsToolOutputParams = parse(params)?;
            if p.start_seq.is_some_and(|seq| seq < 0) || p.through_seq.is_some_and(|seq| seq < 0) {
                return Err(RpcError::invalid_params("use nonnegative tool and snapshot sequences"));
            }
            let thread = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let through_seq = p.through_seq.unwrap_or(thread.last_seq).min(thread.last_seq);
            let include_tool_stream = p.include_tool_stream.unwrap_or(false);
            let result = state
                .store
                .tool_call_result_through(p.thread_id, &p.tool_call_id, p.start_seq, through_seq, include_tool_stream)
                .map_err(internal)?
                .ok_or_else(|| RpcError::not_found("tool output"))?;
            ok(ThreadsToolOutputResult {
                output: result.output,
                is_error: result.is_error,
                stream: result.stream,
                stream_omitted: result.stream_omitted,
            })
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
            let sent = state.orchestrator.send_client_message(p).await.map_err(|e| {
                let msg = e.to_string();
                if msg.contains("busy") { RpcError::new(codes::THREAD_BUSY, msg) } else { bad(e) }
            })?;
            ok(sent)
        }
        ThreadsSteer::NAME => ok(state.orchestrator.steer(parse(params)?).await.map_err(bad)?),
        ThreadNotesGet::NAME => {
            let p: ThreadsInterruptParams = parse(params)?;
            state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| bad(anyhow::anyhow!("Thread not found.")))?;
            ok(state.store.thread_notes(p.thread_id).map_err(internal)?)
        }
        ThreadNotesSet::NAME => ok(state.orchestrator.set_notes(parse(params)?).map_err(bad)?),
        QueueUpdate::NAME => {
            state.orchestrator.update_queued(parse(params)?).map_err(bad)?;
            ok(Empty {})
        }
        QueueAdd::NAME => {
            state.orchestrator.enqueue(parse(params)?).map_err(bad)?;
            ok(Empty {})
        }
        QueueList::NAME => {
            let p: QueueListParams = parse(params)?;
            ok(QueueListResult { messages: state.store.queue_list(p.thread_id).map_err(internal)? })
        }
        QueueRemove::NAME => {
            let p: QueueRemoveParams = parse(params)?;
            state.orchestrator.remove_queued(p.thread_id, p.id).map_err(bad)?;
            ok(Empty {})
        }
        ThreadsRelease::NAME => {
            let p: ThreadsInterruptParams = parse(params)?;
            state.orchestrator.release_session(p.thread_id).await.map_err(bad)?;
            ok(Empty {})
        }
        ThreadsAnswer::NAME => {
            state.orchestrator.answer_questions(parse(params)?).await.map_err(bad)?;
            ok(Empty {})
        }
        ThreadsCompact::NAME => {
            let p: ThreadsInterruptParams = parse(params)?;
            let (turn_id, message_id) = state.orchestrator.send(p.thread_id, UserMessage::text("/compact")).await.map_err(bad)?;
            ok(ThreadsSendResult { turn_id, message_id })
        }
        ThreadsInterrupt::NAME => {
            let p: ThreadsInterruptParams = parse(params)?;
            state.orchestrator.interrupt(p.thread_id).await.map_err(bad)?;
            ok(Empty {})
        }
        CollaborationGroupsCreate::NAME => ok(state.orchestrator.collaboration_group_create(parse(params)?).map_err(bad)?),
        CollaborationCoordinatorGet::NAME => {
            let p: CollaborationCoordinatorGetParams = parse(params)?;
            ok(state.orchestrator.project_coordinator_get(p.project_id).map_err(bad)?)
        }
        CollaborationCoordinatorGetOrCreate::NAME => {
            ok(state.orchestrator.project_coordinator_get_or_create(parse(params)?).await.map_err(bad)?)
        }
        CollaborationCoordinatorDelete::NAME => ok(state.orchestrator.project_coordinator_delete(parse(params)?).await.map_err(bad)?),
        CollaborationCoordinatorSwitchHarness::NAME => {
            ok(state.orchestrator.project_coordinator_switch_harness(parse(params)?).await.map_err(bad)?)
        }
        CollaborationGroupsGet::NAME => {
            let p: CollaborationGroupsGetParams = parse(params)?;
            ok(state.orchestrator.collaboration_group_detail(p.group_id).map_err(bad)?)
        }
        CollaborationGroupsList::NAME => ok(state.orchestrator.collaboration_groups_list(parse(params)?).map_err(bad)?),
        CollaborationGroupsUpdate::NAME => ok(state.orchestrator.collaboration_group_update(parse(params)?).map_err(bad)?),
        CollaborationGroupsControl::NAME => ok(state.orchestrator.collaboration_group_control(parse(params)?).await.map_err(bad)?),
        CollaborationMembersAttach::NAME => ok(state.orchestrator.collaboration_member_attach(parse(params)?).map_err(bad)?),
        CollaborationMembersDetach::NAME => {
            state.orchestrator.collaboration_member_detach(parse(params)?).map_err(bad)?;
            ok(Empty {})
        }
        CollaborationAssignmentsCreate::NAME => {
            ok(state.orchestrator.collaboration_assignment_create(parse(params)?, None, None).await.map_err(bad)?)
        }
        CollaborationAssignmentsGet::NAME => {
            let p: CollaborationAssignmentsGetParams = parse(params)?;
            ok(state
                .store
                .collaboration_assignment_get(p.assignment_id)
                .map_err(internal)?
                .ok_or_else(|| RpcError::not_found("assignment"))?)
        }
        CollaborationAssignmentsList::NAME => ok(state.orchestrator.collaboration_assignments_list(parse(params)?).map_err(bad)?),
        CollaborationAssignmentsUpdate::NAME => {
            ok(state.orchestrator.collaboration_assignment_update(parse(params)?, None).map_err(bad)?)
        }
        CollaborationAssignmentsComplete::NAME => {
            ok(state.orchestrator.collaboration_assignment_complete(parse(params)?, None).map_err(bad)?)
        }
        CollaborationAssignmentsCancel::NAME => {
            ok(state.orchestrator.collaboration_assignment_cancel(parse(params)?, None, None).await.map_err(bad)?)
        }
        CollaborationMessagesSend::NAME => ok(state.orchestrator.collaboration_message_send(parse(params)?, None).map_err(bad)?),
        CollaborationMessagesList::NAME => ok(state.orchestrator.collaboration_messages_list(parse(params)?).map_err(bad)?),
        CollaborationContextPut::NAME => {
            let mut p: CollaborationContextPutParams = parse(params)?;
            p.author_thread_id = None;
            p.user_authored = true;
            ok(state.orchestrator.collaboration_context_put(p, None).map_err(bad)?)
        }
        CollaborationContextList::NAME => ok(state.orchestrator.collaboration_context_list(parse(params)?).map_err(bad)?),
        CollaborationContextHistoryMethod::NAME => {
            let p: CollaborationContextHistoryParams = parse(params)?;
            ok(state.orchestrator.collaboration_context_history(p).map_err(bad)?)
        }
        CollaborationWait::NAME => ok(state.orchestrator.collaboration_wait(parse(params)?).await.map_err(bad)?),
        TasksList::NAME => {
            let p: TasksListParams = parse(params)?;
            let mut tasks = state.store.runtime_tasks_for_thread(p.thread_id).map_err(internal)?;
            if !p.include_completed {
                tasks.retain(|task| task.status.is_active());
            }
            ok(TasksListResult { tasks })
        }
        TaskStop::NAME => {
            let p: TaskControlParams = parse(params)?;
            ok(state.orchestrator.stop_runtime_task(p.thread_id, &p.task_id).await.map_err(provider_err)?)
        }
        TaskBackground::NAME => {
            let p: TaskControlParams = parse(params)?;
            ok(state.orchestrator.background_runtime_task(p.thread_id, &p.task_id).await.map_err(provider_err)?)
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
            ok(state.orchestrator.diff(p.thread_id, p.turn_id, p.include_patch, p.path.as_deref()).await.map_err(bad)?)
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
            let t = state.terminals.create(p.terminal_id, p.thread_id, cwd, p.cols, p.rows, p.command).map_err(internal)?;
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
        UsageLimits::NAME => {
            let _p: UsageLimitsParams = parse_or_default(params)?;
            let mut providers = state.store.latest_provider_limits().map_err(internal)?;
            // Both harnesses expose a turn-free way to read current limits — Codex
            // via account/rateLimits/read, Claude via its local /usage command. cwd
            // only needs to be a real directory; account auth lives under $HOME,
            // which the daemon already inherits. Refresh both concurrently and
            // overlay the live values on the stored snapshot.
            let settings = state.settings.get();
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("."));
            let claude = crate::settings::provider_settings(&settings, ProviderKind::ClaudeCode, None);
            let codex = crate::settings::provider_settings(&settings, ProviderKind::Codex, None);
            let claude_bin: Option<std::path::PathBuf> = claude.binary.clone().map(Into::into);
            let codex_bin: Option<std::path::PathBuf> = codex.binary.clone().map(Into::into);
            let (claude_live, codex_live) = tokio::join!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    kybern_drivers::claude::read_account_limits(&home, claude_bin.as_ref(), &claude.env)
                ),
                tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    kybern_drivers::codex::read_account_limits(&home, codex_bin.as_ref(), &codex.env)
                ),
            );
            for (kind, live) in [(ProviderKind::ClaudeCode, claude_live.ok().flatten()), (ProviderKind::Codex, codex_live.ok().flatten())] {
                if let Some(limits) = live {
                    providers.retain(|entry| entry.provider != kind);
                    if !limits.is_empty() {
                        providers.push(ProviderLimits { provider: kind, limits });
                    }
                }
            }
            providers.sort_by_key(|entry| entry.provider != ProviderKind::ClaudeCode);
            ok(UsageLimitsResult { providers })
        }
        PairingCreate::NAME => {
            let p: PairingCreateParams = parse_or_default(params)?;
            let endpoints = crate::access::endpoints(state).await;
            let (code, expires_at) = state.pairing.create(p.label).map_err(bad)?;
            ok(PairingCreateResult { code, expires_at, endpoints })
        }
        ExposureGet::NAME => ok(crate::access::exposure(state).await),
        ExposureSet::NAME => {
            let p: ExposureSetParams = parse(params)?;
            ok(crate::access::set_exposure(state, p.tailscale).await.map_err(|e| internal(format!("{e:#}")))?)
        }
        TokensList::NAME => ok(TokensListResult { tokens: state.store.tokens_list().map_err(internal)? }),
        TokensRevoke::NAME => {
            let p: TokensRevokeParams = parse(params)?;
            if p.token_id == ctx.principal.token_id {
                return Err(RpcError::invalid_params("a token cannot revoke itself"));
            }
            state.store.token_revoke(p.token_id).map_err(internal)?;
            let _ = state.revoked_tokens.send(p.token_id);
            ok(Empty {})
        }
        FilesSearch::NAME => {
            let p: FilesSearchParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            let root = std::path::PathBuf::from(&project.path);
            let files = state.file_indexes.list(&root).await.map_err(internal)?;
            let total = files.len() as u32;
            let files = crate::files::rank(&files, &p.query, p.limit as usize);
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
        ThreadFileRead::NAME => {
            let p: ThreadFileReadParams = parse(params)?;
            let thread = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            ok(crate::files::read_thread_file(std::path::Path::new(&thread.cwd), &p.path, p.max_bytes).await.map_err(bad)?)
        }
        ArtifactsList::NAME => {
            let p: ArtifactsListParams = parse(params)?;
            let _thread = state.store.thread_get(p.thread_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("thread"))?;
            let limit = p.limit.clamp(1, 100) as usize;
            let mut artifacts = state.store.artifact_calls(p.thread_id, p.before_seq, limit as u32 + 1).map_err(internal)?;
            let more = artifacts.len() > limit;
            artifacts.truncate(limit);
            let next_before_seq = more.then(|| artifacts.last().unwrap().seq);
            ok(ArtifactsListResult { artifacts, next_before_seq })
        }
        ArtifactRead::NAME => ok(crate::artifacts::read(state, parse(params)?).await.map_err(bad)?),
        ArtifactPreview::NAME => ok(ArtifactPreviewResult { ticket: crate::artifacts::issue(state, parse(params)?).await.map_err(bad)? }),
        IntegrationsList::NAME => ok(crate::integrations::list(state, parse(params)?).await.map_err(bad)?),
        IntegrationChange::NAME => ok(crate::integrations::change(state, parse(params)?).await.map_err(bad)?),
        IntegrationLogin::NAME => ok(crate::integrations::login(state, parse(params)?).await.map_err(bad)?),
        SkillsList::NAME => {
            let p: SkillsListParams = parse(params)?;
            let project = state.store.project_get(p.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
            let cwd = std::path::Path::new(&project.path);
            let provider_settings = crate::settings::provider_settings(&state.settings.get(), p.provider, cwd.to_str());
            let binary = provider_settings.binary.as_ref().map(std::path::PathBuf::from);
            let skills = match p.provider {
                ProviderKind::ClaudeCode => {
                    let mut skills = crate::skills::list(cwd, p.provider, &provider_settings.env).await.map_err(internal)?;
                    let context = kybern_drivers::ProbeContext {
                        binary: binary.clone(),
                        cwd: Some(cwd.to_path_buf()),
                        env: provider_settings.env.clone(),
                    };
                    if let Ok(roots) = kybern_drivers::claude_integrations::skill_roots(&context).await {
                        skills.extend(crate::skills::plugin_skills(roots).await.map_err(internal)?);
                    }
                    skills
                }
                ProviderKind::Codex => match kybern_drivers::codex::discover_skills(cwd, binary.as_ref(), &provider_settings.env).await {
                    Some(skills) => skills,
                    None => crate::skills::list(cwd, p.provider, &provider_settings.env).await.map_err(internal)?,
                },
                ProviderKind::Opencode => {
                    match kybern_drivers::opencode::discover_skills(cwd, binary.as_ref(), &provider_settings.env).await {
                        Some(skills) => skills,
                        None => crate::skills::list(cwd, p.provider, &provider_settings.env).await.map_err(internal)?,
                    }
                }
                _ => crate::skills::list(cwd, p.provider, &provider_settings.env).await.map_err(internal)?,
            };
            ok(SkillsListResult { skills })
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
        // events.subscribe is handled by ws.rs, which acknowledges the
        // subscription before replay and serializes replay with live delivery.
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
