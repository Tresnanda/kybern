// Forwarded agent tools (ADE-86 R2, design §6.3, §11.2). Included into `orchestrator::tests`, after
// `remote_delegation_tests.rs`, so they share its two-daemon `Pair`: machine "a" runs an agent thread
// and names machine "b" in the `machine` argument of Kybern tools. They skip on a computer without the
// `127.x.0.n` loopback aliases.

use crate::network::forward::{Decision, ToolClass};

impl Pair {
    /// The calling thread's permission mode on machine a: the cap every forwarded call carries.
    fn set_mode(&self, mode: PermissionMode) {
        let mut thread = self.a.state.store.thread_get(self.parent.id).unwrap().unwrap();
        thread.permission_mode = mode;
        self.a.state.store.thread_upsert(&thread).unwrap();
    }

    /// A Kybern tool on machine b, called by the agent on a.
    async fn on_b(&self, tool: &str, mut args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        args["machine"] = json!(self.b.id());
        self.tool(tool, args).await
    }

    fn inbound_on_b(&self) -> Vec<Thread> {
        self.b.state.store.inbound_threads(&self.a.id(), self.parent.id).unwrap()
    }

    fn pending_on_b(&self) -> Vec<ApprovalRequest> {
        self.b.state.store.approvals_pending(None).unwrap()
    }

    fn events_on_b(&self, thread_id: Uuid) -> Vec<EventPayload> {
        self.b.state.store.events_for_thread(thread_id).unwrap().into_iter().map(|event| event.payload).collect()
    }

    /// What `peer.tool.call` carries from a, for tests that talk to machine b's side directly.
    fn call_params(&self, tool: &str, args: serde_json::Value, cap: PermissionMode) -> PeerToolCallParams {
        PeerToolCallParams {
            tool: tool.into(),
            args,
            origin: Origin {
                machine_id: self.a.id(),
                machine_name: "a".into(),
                thread_id: Some(self.parent.id),
                operation_id: Uuid::now_v7(),
                kind: OriginKind::ToolCall,
                permission_cap: cap,
                hops: vec![self.a.id()],
            },
            thread_title: "Parent on a".into(),
            repo: None,
            project: None,
            deadline_ms: None,
        }
    }

    /// Serve a call on b as if machine a sent it with every default capability.
    async fn serve_on_b(&self, params: PeerToolCallParams) -> Result<PeerToolCallResult, RpcError> {
        self.b.state.orchestrator.serve_tool_call(&self.a.id(), &Scope::MACHINE_DEFAULT, params).await
    }
}

/// One cell of the narrowing table, end to end: the agent on a holds `mode`, calls `tool` on b, and b
/// either runs it at once or opens a card on the inbound thread that the user on b answers.
async fn matrix_cell(p: &Pair, mode: PermissionMode, tool: &str, args: serde_json::Value, expected: Decision) -> anyhow::Result<serde_json::Value> {
    p.set_mode(mode);
    let cards_before = p.pending_on_b().len();
    let call = p.on_b(tool, args);
    let driver = async {
        match expected {
            Decision::Ask => {
                let card = eventually(|| async { p.pending_on_b().into_iter().nth(cards_before) }).await;
                let inbound = p.inbound_on_b();
                assert_eq!(inbound.len(), 1, "{tool} at {mode:?}");
                assert_eq!(card.thread_id, inbound[0].id, "the card sits on the inbound thread: {tool} at {mode:?}");
                p.b.state.orchestrator.respond_approval(card.id, ApprovalDecision::AllowOnce).await.unwrap();
            }
            Decision::Run => {
                tokio::time::sleep(Duration::from_millis(150)).await;
                assert_eq!(p.pending_on_b().len(), cards_before, "{tool} at {mode:?} must run without asking");
            }
        }
    };
    let (result, ()) = tokio::join!(call, driver);
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_narrowing_table_holds_end_to_end_for_every_mode_and_tool_class() {
    let Some(p) = Pair::new().await else { return };
    let modes = [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto, PermissionMode::FullAccess];
    for mode in modes {
        let ask_unless = |lowest_running: PermissionMode| {
            let rank = |m: PermissionMode| modes.iter().position(|candidate| *candidate == m).unwrap();
            if rank(mode) >= rank(lowest_running) { Decision::Run } else { Decision::Ask }
        };
        // Reads run in every mode, files and terminal listings included.
        for (tool, args) in [
            ("kybern_threads_search", json!({})),
            ("kybern_list_files", json!({})),
            ("kybern_list_terminals", json!({})),
            ("kybern_notes_search", json!({})),
        ] {
            let class = crate::network::forward::classify(tool);
            assert_eq!(crate::network::forward::decide(mode, class), Decision::Run);
            matrix_cell(&p, mode, tool, args, Decision::Run).await.unwrap_or_else(|error| panic!("{tool} at {mode:?}: {error:#}"));
        }
        // Operate: a card below Auto.
        let class = ToolClass::Operate;
        assert_eq!(crate::network::forward::decide(mode, class), ask_unless(PermissionMode::Auto));
        let shown = matrix_cell(&p, mode, "kybern_preview_open", json!({"target": "http://localhost:5173"}), ask_unless(PermissionMode::Auto)).await;
        assert!(shown.is_ok(), "preview at {mode:?}: {shown:?}");
        // Note writes: the notes-and-tasks consent, below Auto.
        let title = format!("From a at {mode:?}");
        assert_eq!(crate::network::forward::decide(mode, ToolClass::NoteWrite), ask_unless(PermissionMode::Auto));
        let note = matrix_cell(&p, mode, "kybern_note_create", json!({"title": title, "body": "hello from a"}), ask_unless(PermissionMode::Auto)).await;
        assert!(note.is_ok(), "note at {mode:?}: {note:?}");
        // Terminal commands: a card until Full access.
        assert_eq!(crate::network::forward::decide(mode, ToolClass::TerminalRun), ask_unless(PermissionMode::FullAccess));
        let ran = matrix_cell(
            &p,
            mode,
            "kybern_run_in_terminal",
            json!({"command": "echo forwarded-ok", "reason": "matrix", "timeout_seconds": 20}),
            ask_unless(PermissionMode::FullAccess),
        )
        .await
        .unwrap();
        assert_eq!(ran["status"], "exited", "{mode:?}: {ran}");
        assert!(ran["output"].as_str().unwrap().contains("forwarded-ok"), "{ran}");
    }
    // All of it was recorded on one inbound thread, with the caller's mode of the moment on every call.
    let inbound = p.inbound_on_b();
    assert_eq!(inbound.len(), 1, "one inbound thread per origin thread and project: {inbound:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forwarded_read_runs_on_the_other_machine_and_leaves_audit_events_on_an_inbound_thread() {
    let Some(p) = Pair::new().await else { return };
    p.set_mode(PermissionMode::Auto);
    let listing = p.on_b("kybern_list_files", json!({})).await.unwrap();
    assert_eq!(listing["ran_on"], json!(crate::rpc::hostname()), "{listing}");
    assert!(listing.to_string().contains("tracked.txt"), "b's own checkout was read: {listing}");
    let file = p.on_b("kybern_read_file", json!({"path": "tracked.txt"})).await.unwrap();
    assert!(file["content"].as_str().unwrap_or_default().contains("one"), "{file}");

    // The inbound thread: hidden, stamped with where it came from, in b's checkout of the repository.
    let inbound = p.inbound_on_b();
    assert_eq!(inbound.len(), 1);
    let thread = &inbound[0];
    assert_eq!(thread.cwd, p.repo_b.to_string_lossy());
    let info = thread.inbound.as_ref().expect("inbound info");
    assert_eq!((info.machine_id.as_str(), info.thread_id, info.title.as_str()), (p.a.id().as_str(), p.parent.id, "Parent on a"));
    let origin = thread.origin.as_ref().expect("origin");
    assert_eq!((origin.machine_id.as_str(), origin.thread_id, origin.hops.as_slice()), (p.a.id().as_str(), Some(p.parent.id), [p.a.id()].as_slice()));
    assert!(matches!(origin.kind, OriginKind::ToolCall));
    assert!(thread.title.contains("Parent on a"), "{}", thread.title);

    // Every call is a started and a completed event naming the caller.
    let events = p.events_on_b(thread.id);
    let started: Vec<&ToolCall> = events
        .iter()
        .filter_map(|event| match event {
            EventPayload::ToolCallStarted { call, .. } => Some(call),
            _ => None,
        })
        .collect();
    assert_eq!(started.iter().map(|call| call.name.as_str()).collect::<Vec<_>>(), ["kybern_list_files", "kybern_read_file"]);
    assert_eq!(started[0].input["from"]["machine_id"], json!(p.a.id()));
    assert_eq!(started[0].input["from"]["thread_id"], json!(p.parent.id));
    assert_eq!(started[0].input["from"]["permission_cap"], "auto");
    let completed = events.iter().filter(|event| matches!(event, EventPayload::ToolCallCompleted { is_error: false, .. })).count();
    assert_eq!(completed, 2);

    // Nothing can message it (`threads.list` leaves it out unless `include_inbound`).
    let error = p.b.state.orchestrator.send(thread.id, UserMessage::text("hello?")).await.unwrap_err();
    assert!(error.to_string().contains("only records"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_inbound_threads_origin_comes_from_the_session_and_not_from_the_payload() {
    let Some(p) = Pair::new().await else { return };
    let mut params = p.call_params("kybern_threads_search", json!({}), PermissionMode::Auto);
    params.origin.machine_id = "mallory".into();
    params.origin.machine_name = "mallory".into();
    let result = p.serve_on_b(params).await.unwrap();
    let thread = p.b.state.store.thread_get(result.inbound_thread_id).unwrap().unwrap();
    let origin = thread.origin.unwrap();
    assert_eq!((origin.machine_id, origin.machine_name), (p.a.id(), crate::rpc::hostname()), "the session's machine, named by b's own membership");
    assert_eq!(origin.hops, vec![p.a.id()]);
    assert_eq!(thread.inbound.unwrap().machine_id, p.a.id());
    assert_eq!(p.inbound_on_b().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_fence_refuses_what_changes_projects_settings_or_the_network_at_every_mode() {
    let Some(p) = Pair::new().await else { return };
    for cap in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto, PermissionMode::FullAccess] {
        for tool in [
            "kybern_git",
            "kybern_coordinator_propose_brief",
            "kybern_request_secret",
            "kybern_request_login",
            "kybern_html_publish",
            "kybern_task_claim",
            "kybern_agent_delegate",
            "projects.add",
            "settings.update",
            "network.remove",
        ] {
            let error = p.serve_on_b(p.call_params(tool, json!({}), cap)).await.unwrap_err();
            assert_eq!(error.code, codes::FORBIDDEN, "{tool} at {cap:?}: {error:?}");
        }
    }
    assert!(p.inbound_on_b().is_empty(), "a refused call leaves no inbound thread behind");

    // The agent on a hears it before anything is sent.
    for tool in ["kybern_request_secret", "kybern_html_publish", "kybern_task_claim"] {
        let error = p.on_b(tool, json!({})).await.unwrap_err().to_string();
        assert!(error.contains("cannot run on another machine"), "{tool}: {error}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn below_full_access_a_call_may_change_only_threads_the_calling_machine_started() {
    let Some(p) = Pair::new().await else { return };
    // Two idle threads on b: one a started (a remote child), one the user's own.
    let project = p.b.state.store.projects_list().unwrap().into_iter().find(|project| project.name == "repo-b").unwrap();
    let own = |title: &str, origin: Option<Origin>| {
        let now = chrono::Utc::now();
        Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: title.into(),
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
            origin,
            inbound: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        }
    };
    let started_by_a = own(
        "Started by a",
        Some(Origin {
            machine_id: p.a.id(),
            machine_name: "a".into(),
            thread_id: Some(p.parent.id),
            operation_id: Uuid::now_v7(),
            kind: OriginKind::Composer,
            permission_cap: PermissionMode::Supervised,
            hops: vec![p.a.id()],
        }),
    );
    let users = own("The user's thread on b", None);
    for thread in [&started_by_a, &users] {
        p.b.state.store.thread_upsert(thread).unwrap();
    }
    let send = |thread: &Thread| json!({"thread_id": thread.id, "body": "hello", "operation_id": Uuid::now_v7()});

    for cap in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let error = p.serve_on_b(p.call_params("kybern_thread_send", send(&users), cap)).await.unwrap_err();
        assert_eq!(error.code, codes::FORBIDDEN, "{cap:?}: {error:?}");
        assert!(error.message.contains("not started by"), "{}", error.message);
        let error = p.serve_on_b(p.call_params("kybern_thread_interrupt", json!({"thread_id": users.id}), cap)).await.unwrap_err();
        assert_eq!(error.code, codes::FORBIDDEN, "{cap:?}: {error:?}");
    }
    // Its own work is fair game, once the (Auto) call is allowed to run.
    let own_call = p.serve_on_b(p.call_params("kybern_thread_send", send(&started_by_a), PermissionMode::Auto)).await;
    assert!(own_call.is_ok(), "{own_call:?}");
    // Full access is stamped but not fenced.
    let full = p.serve_on_b(p.call_params("kybern_thread_send", send(&users), PermissionMode::FullAccess)).await;
    assert!(full.is_ok(), "{full:?}");
    // Never an inbound thread: it has no agent.
    let inbound = p.serve_on_b(p.call_params("kybern_threads_search", json!({}), PermissionMode::Auto)).await.unwrap().inbound_thread_id;
    let error = p.serve_on_b(p.call_params("kybern_thread_send", send(&p.b.state.store.thread_get(inbound).unwrap().unwrap()), PermissionMode::FullAccess)).await.unwrap_err();
    assert!(error.message.contains("only records"), "{error:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn there_is_no_second_hop_at_any_mode() {
    let Some(p) = Pair::new().await else { return };
    for cap in [PermissionMode::Supervised, PermissionMode::FullAccess] {
        // The target refuses a call that already crossed a machine, and one whose hop is not the session's.
        let mut twice = p.call_params("kybern_threads_search", json!({}), cap);
        twice.origin.hops = vec!["somewhere-else".into(), p.a.id()];
        assert_eq!(p.serve_on_b(twice).await.unwrap_err().code, codes::FORBIDDEN);
        let mut forged = p.call_params("kybern_threads_search", json!({}), cap);
        forged.origin.hops = vec!["somewhere-else".into()];
        assert_eq!(p.serve_on_b(forged).await.unwrap_err().code, codes::FORBIDDEN);
        let mut none = p.call_params("kybern_threads_search", json!({}), cap);
        none.origin.hops.clear();
        assert_eq!(p.serve_on_b(none).await.unwrap_err().code, codes::FORBIDDEN);
    }
    // The calling side refuses work another machine started: a thread with an origin, or an inbound one.
    let mut thread = p.a.state.store.thread_get(p.parent.id).unwrap().unwrap();
    thread.origin = Some(Origin {
        machine_id: p.b.id(),
        machine_name: "b".into(),
        thread_id: None,
        operation_id: Uuid::now_v7(),
        kind: OriginKind::Delegation { task_id: Uuid::now_v7().to_string() },
        permission_cap: PermissionMode::FullAccess,
        hops: vec![p.b.id()],
    });
    p.a.state.store.thread_upsert(&thread).unwrap();
    p.set_mode(PermissionMode::FullAccess);
    let error = p.on_b("kybern_threads_search", json!({})).await.unwrap_err().to_string();
    assert!(error.contains("third machine"), "{error}");
    assert!(p.inbound_on_b().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn files_and_terminals_need_their_own_capability_on_the_target() {
    let Some(p) = Pair::new().await else { return };
    p.set_mode(PermissionMode::FullAccess);
    p.b.membership().set(&format!("allow.{}.files", p.b.id()), json!(false)).unwrap();
    let error = p.on_b("kybern_read_file", json!({"path": "tracked.txt"})).await.unwrap_err().to_string();
    assert!(error.contains("\"files\"") && error.contains("Settings → Machines"), "{error}");
    let error = p.on_b("kybern_list_files", json!({})).await.unwrap_err().to_string();
    assert!(error.contains("\"files\""), "{error}");
    // Other reads and terminals still work.
    assert!(p.on_b("kybern_threads_search", json!({})).await.is_ok());
    assert!(p.on_b("kybern_list_terminals", json!({})).await.is_ok());

    p.b.membership().set(&format!("allow.{}.terminals", p.b.id()), json!(false)).unwrap();
    let error = p.on_b("kybern_list_terminals", json!({})).await.unwrap_err().to_string();
    assert!(error.contains("\"terminals\""), "{error}");
    let error = p.on_b("kybern_run_in_terminal", json!({"command": "echo no", "reason": "scope"})).await.unwrap_err().to_string();
    assert!(error.contains("\"terminals\""), "{error}");

    p.b.membership().set(&format!("allow.{}.tools", p.b.id()), json!(false)).unwrap();
    let error = p.on_b("kybern_threads_search", json!({})).await.unwrap_err().to_string();
    assert!(error.contains("machine:tools"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tool_call_to_an_offline_machine_fails_at_once_and_never_queues() {
    let Some(p) = Pair::new().await else { return };
    p.b_offline().await;
    let started = std::time::Instant::now();
    let error = p.on_b("kybern_threads_search", json!({})).await.unwrap_err().to_string();
    assert!(started.elapsed() < Duration::from_secs(5), "it failed at once");
    assert!(error.contains("is offline") && error.contains("kybern_agent_delegate"), "{error}");
    assert!(p.outbox().is_empty(), "tool calls never queue: {:?}", p.outbox());
    let error = p.tool("kybern_threads_search", json!({"machine": "nowhere"})).await.unwrap_err().to_string();
    assert!(error.contains("no machine called"), "{error}");
    // The machine's own name runs the tool here.
    let here = p.tool("kybern_threads_search", json!({"machine": crate::rpc::hostname()})).await.unwrap();
    assert!(here.get("ran_on").is_none());
    p.b_online().await;
    assert!(p.on_b("kybern_threads_search", json!({})).await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_repeated_operation_runs_once_and_a_decline_reaches_the_agent() {
    let Some(p) = Pair::new().await else { return };
    let mut params = p.call_params("kybern_note_create", json!({"title": "Once only", "body": "x", "operation_id": Uuid::now_v7()}), PermissionMode::Auto);
    let first = p.serve_on_b(params.clone()).await.unwrap();
    params.args["body"] = json!("a retry that must not run");
    let second = p.serve_on_b(params).await.unwrap();
    assert_eq!(first.result, second.result, "the repeated operation answers with the first run");
    let found = p.serve_on_b(p.call_params("kybern_notes_search", json!({"query": "Once only"}), PermissionMode::Auto)).await.unwrap();
    assert_eq!(found.result["notes"].as_array().map(Vec::len), Some(1), "{}", found.result);

    // A declined card is an error the agent can read, and nothing happened.
    p.set_mode(PermissionMode::Supervised);
    let call = p.on_b("kybern_preview_open", json!({"target": "http://localhost:3000"}));
    let decline = async {
        let card = eventually(|| async { p.pending_on_b().into_iter().next() }).await;
        assert!(card.summary.starts_with(&format!("From {} · Parent on a", crate::rpc::hostname())), "{}", card.summary);
        p.b.state.orchestrator.respond_approval(card.id, ApprovalDecision::Deny { reason: None }).await.unwrap();
    };
    let (result, ()) = tokio::join!(call, decline);
    assert!(result.unwrap_err().to_string().contains("declined"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kybern_machines_lists_the_network_without_addresses_or_keys() {
    let Some(p) = Pair::new().await else { return };
    let listing = p.tool("kybern_machines", json!({})).await.unwrap();
    let machines = listing["machines"].as_array().unwrap();
    assert_eq!(machines.len(), 2, "{listing}");
    let this = machines.iter().find(|machine| machine["this_machine"] == true).unwrap();
    let other = machines.iter().find(|machine| machine["machine_id"] == json!(p.b.id())).unwrap();
    assert_eq!((this["machine_id"].clone(), this["name"].clone()), (json!(p.a.id()), json!(crate::rpc::hostname())));
    assert_eq!((other["name"].clone(), other["status"].as_str()), (json!(crate::rpc::hostname()), Some("online")));
    assert!(other["os"].as_str().is_some() && other["allows"]["tools"] == true && other["allows"]["clipboard_auto"] == false, "{other}");
    assert!(other["features"].as_array().unwrap().iter().any(|f| f == "tools.forward.v1"));
    let projects = other["projects"].as_array().expect("b answered about itself");
    assert!(projects.iter().any(|project| project["name"] == "repo-b" && project["repo"]["root_commit"].is_string()), "{other}");
    let text = listing.to_string();
    for forbidden in ["signing_key", "sealing_key", "127.", "token", "address"] {
        assert!(!text.contains(forbidden), "kybern_machines must not show {forbidden}: {text}");
    }
    // Offline members stay listed, with the reason their projects are missing.
    p.b_offline().await;
    let listing = p.tool("kybern_machines", json!({})).await.unwrap();
    let other = listing["machines"].as_array().unwrap().iter().find(|machine| machine["machine_id"] == json!(p.b.id())).unwrap().clone();
    assert_eq!(other["status"], "offline");
    assert!(other["projects"].is_null() && other["note"].as_str().unwrap().contains("not online"), "{other}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn archiving_the_calling_thread_archives_its_inbound_thread() {
    let Some(p) = Pair::new().await else { return };
    p.set_mode(PermissionMode::Auto);
    p.on_b("kybern_threads_search", json!({})).await.unwrap();
    let inbound = p.inbound_on_b().remove(0);
    assert_eq!(inbound.status, ThreadStatus::Idle);
    p.a.state.orchestrator.archive_thread(p.parent.id).await.unwrap();
    eventually(|| async { (p.inbound_on_b()[0].status == ThreadStatus::Archived).then_some(()) }).await;
    assert!(p.b.state.orchestrator.inner.sessions.lock().await.get(&inbound.id).is_none(), "its inert session is gone");
}

#[test]
fn an_offline_message_says_how_long_ago_and_what_to_do() {
    let now = chrono::Utc::now();
    let ago = |minutes: i64| crate::orchestrator::inbound::offline_message("satyamas", Some(now - chrono::Duration::minutes(minutes)));
    assert!(ago(5).starts_with("satyamas is offline (last seen 5 min ago)."), "{}", ago(5));
    assert!(ago(180).contains("last seen 3 h ago"));
    assert!(ago(4000).contains("2 days ago"));
    let never = crate::orchestrator::inbound::offline_message("satyamas", None);
    assert!(never.starts_with("satyamas is offline.") && never.contains("kybern_agent_delegate"), "{never}");
}

#[test]
fn a_calls_operation_id_is_stable_across_a_transport_retry() {
    let (thread, session, turn) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let id = |call: &str, tool: &str| crate::orchestrator::inbound::derived_call_operation(thread, session, turn, call, tool);
    assert_eq!(id("c1", "kybern_read_file"), id("c1", "kybern_read_file"));
    assert_ne!(id("c1", "kybern_read_file"), id("c2", "kybern_read_file"));
    assert_ne!(id("c1", "kybern_read_file"), id("c1", "kybern_list_files"));
}
