// End-to-end boundaries: real HTTP, WebSocket authentication, replay and revocation.
use axum::{Router, routing::get};
use futures::{SinkExt, StreamExt};
use kybern_client::{Client, Endpoint};
use kybern_protocol::{methods::*, *};
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

struct Host {
    state: crate::state::AppState,
    url: String,
    root: PathBuf,
    server: tokio::task::JoinHandle<()>,
}
impl Host {
    async fn start() -> Self {
        let root = std::env::temp_dir().join(format!("kybern-remote-test-{}", Uuid::now_v7()));
        let paths = crate::config::Paths::resolve(Some(root.clone())).unwrap();
        let state = crate::state::AppState::initialize(&paths).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().merge(crate::http::routes()).route("/ws", get(crate::ws::upgrade)).with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { state, url, root, server }
    }
    async fn client(&self) -> Client {
        Client::connect(&Endpoint { url: format!("{}/ws", self.url.replace("http:", "ws:")), token: self.state.bootstrap_token.clone() })
            .await
            .unwrap()
    }
    fn thread(&self) -> Thread {
        let project = self.state.orchestrator.add_project(self.root.to_string_lossy().into_owned(), Some("Fixture".into())).unwrap();
        let now = chrono::Utc::now();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "Test".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path,
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
        };
        self.state.store.thread_upsert(&thread).unwrap();
        thread
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn environments_keep_projects_and_identity_separate() {
    let a = Host::start().await;
    let b = Host::start().await;
    a.thread();
    let ca = a.client().await;
    let cb = b.client().await;
    let ia = ca.call::<DaemonInfoMethod>(Empty {}).await.unwrap();
    let ib = cb.call::<DaemonInfoMethod>(Empty {}).await.unwrap();
    assert_ne!(ia.environment_id, ib.environment_id);
    assert_eq!(ca.call::<ProjectsList>(Empty {}).await.unwrap().projects.len(), 1);
    assert!(cb.call::<ProjectsList>(Empty {}).await.unwrap().projects.is_empty());
    let reopened = kybern_store::Store::open(&a.state.paths.db).unwrap();
    assert_eq!(reopened.meta_get("environment_id").unwrap().unwrap(), ia.environment_id);
    let browsed = ca.call::<ProjectsBrowse>(ProjectsBrowseParams { path: Some(a.root.to_string_lossy().into_owned()) }).await.unwrap();
    assert_eq!(PathBuf::from(browsed.path), a.root.canonicalize().unwrap());
}

#[tokio::test]
async fn browser_ticket_is_single_use_and_revocation_closes_an_existing_socket() {
    let host = Host::start().await;
    let (code, _) = host.state.pairing.create(None);
    let http = reqwest::Client::new();
    let paired: PairResponse = http
        .post(format!("{}/pair", host.url))
        .json(&PairRequest { code: code.clone(), device_name: Some("Test phone".into()) })
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!paired.scopes.contains(&Scope::AccessWrite));
    assert!(
        http.post(format!("{}/pair", host.url))
            .json(&PairRequest { code, device_name: None })
            .send()
            .await
            .unwrap()
            .status()
            .is_client_error()
    );
    let session: serde_json::Value = http
        .post(format!("{}/session", host.url))
        .bearer_auth(&paired.token)
        .header("Origin", "tauri://localhost")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!("{}/ws?ticket={}", host.url.replace("http:", "ws:"), session["ticket"].as_str().unwrap());
    let (mut socket, _) = connect_async(&url).await.unwrap();
    assert!(connect_async(&url).await.is_err());
    socket.send(Message::Text(json!({"jsonrpc":"2.0","id":1,"method":"daemon.info","params":{}}).to_string().into())).await.unwrap();
    let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(message.contains(&host.state.environment_id));
    let token = host.state.store.tokens_list().unwrap().into_iter().find(|token| token.label == "Test phone").unwrap();
    host.client().await.call::<TokensRevoke>(TokensRevokeParams { token_id: token.id }).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(3), socket.next()).await.unwrap();
    assert!(closed.is_none() || closed.is_some_and(|frame| matches!(frame, Err(_) | Ok(Message::Close(_)))));
    assert_eq!(
        http.post(format!("{}/session", host.url)).bearer_auth(paired.token).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn subscription_ack_precedes_all_replayed_events() {
    let host = Host::start().await;
    let thread = host.thread();
    for _ in 0..600 {
        host.state.store.event_append(thread.id, None, EventPayload::ThreadUpdated { thread: thread.clone() }).unwrap();
    }
    let principal = crate::auth::authenticate(&host.state.store, &host.state.bootstrap_token).unwrap().unwrap();
    let ticket = host.state.tickets.create(principal).unwrap();
    let (mut socket, _) = connect_async(format!("{}/ws?ticket={ticket}", host.url.replace("http:", "ws:"))).await.unwrap();
    socket
        .send(Message::Text(json!({"jsonrpc":"2.0","id":7,"method":"events.subscribe","params":{"after_seq":0}}).to_string().into()))
        .await
        .unwrap();
    let first: serde_json::Value = serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(first["id"], 7);
    let subscription = first["result"]["subscription_id"].clone();
    let live = host.state.store.event_append(thread.id, None, EventPayload::ThreadUpdated { thread }).unwrap();
    host.state.events.send(live).unwrap();
    for seq in 1..=601 {
        let message = tokio::time::timeout(Duration::from_secs(3), socket.next()).await.unwrap().unwrap().unwrap().into_text().unwrap();
        let frame: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(frame["params"]["subscription_id"], subscription);
        assert_eq!(frame["params"]["event"]["seq"], seq);
    }
}

#[tokio::test]
async fn queue_survives_restart_and_consumption_is_atomic_with_turn_started() {
    let host = Host::start().await;
    let thread = host.thread();
    let queued = QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("follow-up") };
    host.state.orchestrator.enqueue(queued.clone()).unwrap();
    host.state.orchestrator.enqueue(queued.clone()).unwrap();
    let reopened = kybern_store::Store::open(&host.state.paths.db).unwrap();
    assert_eq!(reopened.queue_list(None).unwrap().len(), 1);
    assert_eq!(reopened.events_for_thread(thread.id).unwrap().len(), 1);
    reopened
        .event_append(thread.id, Some(Uuid::now_v7()), EventPayload::TurnStarted { message_id: queued.id, message: queued.message.clone() })
        .unwrap();
    assert!(reopened.queue_list(None).unwrap().is_empty());
    host.state.orchestrator.enqueue(queued.clone()).unwrap();
    assert!(reopened.queue_list(None).unwrap().is_empty());
    assert!(host.state.orchestrator.remove_queued(thread.id, queued.id).is_err());
    let canceled = QueuedMessage { id: Uuid::now_v7(), ..queued };
    host.state.orchestrator.enqueue(canceled.clone()).unwrap();
    host.state.orchestrator.remove_queued(thread.id, canceled.id).unwrap();
    host.state.orchestrator.enqueue(canceled).unwrap();
    assert!(reopened.queue_list(None).unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn reconnect_reattaches_terminal_and_closed_identity_cannot_spawn_again() {
    let host = Host::start().await;
    let id = Uuid::now_v7();
    let cwd = host.root.to_string_lossy().into_owned();
    let create = || host.state.terminals.create(Some(id), None, cwd.clone(), 80, 24, Some(vec!["/bin/sh".into()])).unwrap();
    let first = create();
    let second = create();
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    first.write(b"printf 'reconnected-terminal\\n'\n").unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (_, bytes) = second.subscribe_output(true);
            if String::from_utf8_lossy(&bytes).contains("reconnected-terminal") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    host.state.terminals.close(id).unwrap();
    assert!(host.state.terminals.create(Some(id), None, cwd, 80, 24, Some(vec!["/bin/sh".into()])).is_err());
}

#[tokio::test]
async fn interrupted_host_recovery_pauses_remaining_follow_ups() {
    let host = Host::start().await;
    let mut thread = host.thread();
    thread.status = ThreadStatus::Running;
    host.state.store.thread_upsert(&thread).unwrap();
    host.state
        .orchestrator
        .enqueue(QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("wait for the interrupted turn") })
        .unwrap();
    host.state.orchestrator.recover_after_restart().await.unwrap();
    host.state.orchestrator.drain_queues().await.unwrap();
    assert_eq!(host.state.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Failed);
    assert_eq!(host.state.store.queue_list(Some(thread.id)).unwrap().len(), 1);
}

#[tokio::test]
async fn response_images_require_auth_and_stay_on_the_owning_host() {
    let host = Host::start().await;
    let other = Host::start().await;
    let thread = host.thread();
    let http = reqwest::Client::new();
    let url = format!("{}/threads/{}/image", host.url, thread.id);
    let png = b"\x89PNG\r\n\x1a\nfixture";
    std::fs::write(host.root.join("image with spaces.png"), png).unwrap();
    std::fs::write(host.root.join("not-an-image.png"), b"<html>no</html>").unwrap();
    assert_eq!(
        http.get(&url).query(&[("path", "image with spaces.png")]).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        http.get(&url).bearer_auth(&other.state.bootstrap_token).query(&[("path", "image with spaces.png")]).send().await.unwrap().status(),
        reqwest::StatusCode::FORBIDDEN
    );
    let response =
        http.get(&url).bearer_auth(&host.state.bootstrap_token).query(&[("path", "image with spaces.png")]).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.bytes().await.unwrap().as_ref(), png);
    let response = http.get(&url).bearer_auth(&host.state.bootstrap_token).query(&[("path", "not-an-image.png")]).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE);
    std::fs::write(other.root.join("outside.png"), png).unwrap();
    let outside = other.root.join("outside.png");
    assert_eq!(
        http.get(&url)
            .bearer_auth(&host.state.bootstrap_token)
            .query(&[("path", outside.to_string_lossy().as_ref())])
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside, host.root.join("linked.png")).unwrap();
        assert_eq!(
            http.get(&url).bearer_auth(&host.state.bootstrap_token).query(&[("path", "linked.png")]).send().await.unwrap().status(),
            reqwest::StatusCode::FORBIDDEN
        );
    }
}

#[tokio::test]
async fn harness_updates_wait_for_turns_and_block_new_sends_during_installation() {
    let host = Host::start().await;
    let mut thread = host.thread();
    for status in [ThreadStatus::Running, ThreadStatus::AwaitingApproval] {
        thread.status = status;
        host.state.store.thread_upsert(&thread).unwrap();
        assert!(host.state.orchestrator.idle_harness_for_update(thread.provider.kind).await.unwrap().is_none());
    }
    thread.status = ThreadStatus::Idle;
    host.state.store.thread_upsert(&thread).unwrap();
    let guard = host.state.orchestrator.idle_harness_for_update(thread.provider.kind).await.unwrap().unwrap();
    let error = host.state.orchestrator.send(thread.id, UserMessage::text("do not launch a real CLI")).await.unwrap_err();
    assert!(error.to_string().contains("updating"));
    assert!(host.state.store.events_for_thread(thread.id).unwrap().is_empty());
    assert!(host.state.orchestrator.idle_harness_for_update(thread.provider.kind).await.unwrap().is_none());
    drop(guard);
    let now = chrono::Utc::now();
    let turn_id = Uuid::now_v7();
    let mut task = RuntimeTask {
        id: "background".into(),
        thread_id: thread.id,
        origin_turn_id: turn_id,
        started_seq: 1,
        updated_seq: 1,
        kind: RuntimeTaskKind::Agent,
        status: RuntimeTaskStatus::Running,
        title: "Background agent".into(),
        detail: None,
        provider_type: None,
        parent_id: None,
        tool_call_id: None,
        provider_thread_id: None,
        model: None,
        effort: None,
        backgrounded: true,
        last_tool_name: None,
        usage: None,
        stats: RuntimeTaskStats::default(),
        capabilities: RuntimeTaskCapabilities::default(),
        started_at: now,
        updated_at: now,
        completed_at: None,
    };
    host.state.store.event_append(thread.id, Some(turn_id), EventPayload::RuntimeTaskStarted { task: task.clone() }).unwrap();
    assert!(host.state.orchestrator.idle_harness_for_update(thread.provider.kind).await.unwrap().is_none());
    task.status = RuntimeTaskStatus::Completed;
    host.state.store.event_append(thread.id, Some(turn_id), EventPayload::RuntimeTaskCompleted { task }).unwrap();
    assert!(host.state.orchestrator.idle_harness_for_update(thread.provider.kind).await.unwrap().is_some());
}

#[tokio::test]
async fn custom_harnesses_are_not_mutated_and_update_results_survive_reconnect() {
    let host = Host::start().await;
    let mut settings = host.state.settings.get();
    settings
        .providers
        .insert(ProviderKind::ClaudeCode, ProviderSettings { binary: Some("/custom/pinned-claude".into()), ..Default::default() });
    host.state.settings.set(settings).unwrap();
    let client = host.client().await;
    client.call::<HarnessUpdatesRun>(HarnessUpdateParams { kind: ProviderKind::ClaudeCode }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let records = client.call::<HarnessUpdatesList>(Empty {}).await.unwrap().updates;
            if records.iter().any(|record| record.kind == ProviderKind::ClaudeCode && record.status == HarnessUpdateStatus::Unsupported) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let reloaded = crate::harness_updates::HarnessUpdates::new(&host.state.store).unwrap().list();
    let record = reloaded.iter().find(|record| record.kind == ProviderKind::ClaudeCode).unwrap();
    assert_eq!(record.status, HarnessUpdateStatus::Unsupported);
    assert!(record.message.contains("Custom executable"));
}
