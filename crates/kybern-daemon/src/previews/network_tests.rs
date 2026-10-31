//! Server previews through authenticated client RPC, real machine sessions and the port relay.
//! Ephemeral ports on 127.0.0.1 keep this test runnable on macOS without extra loopback aliases.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::ws::{Message as AxumMessage, WebSocketUpgrade};
use axum::routing::get;
use futures::{SinkExt, StreamExt};
use kybern_client::{Client, Endpoint};
use kybern_protocol::{methods::*, *};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use uuid::Uuid;

use crate::network::{peers, session, tailscale::Fake, testutil::TempDir};

struct Node {
    state: crate::state::AppState,
    address: SocketAddr,
    server: tokio::task::JoinHandle<()>,
    dir: TempDir,
}

impl Node {
    async fn start(name: &str) -> Self {
        let dir = TempDir::new(name);
        let paths = crate::config::Paths::resolve(Some(dir.path().to_path_buf())).unwrap();
        // No fake tailnet nodes: membership is enrolled explicitly as code-joined machines.
        // Only Tailscale discovery is replaced; identity proofs, signatures and sockets are real.
        let state = crate::state::AppState::initialize_with_drivers(
            &paths,
            Arc::new(Fake::new(dir.path().join("no-tailnet.json"))),
            crate::network::Timing::default(),
            kybern_drivers::registry::DriverRegistry::default(),
        )
        .unwrap();
        let mut settings = state.settings.get();
        settings.network.enabled = true;
        state.settings.set(settings).unwrap();
        state.network.set_enabled(true);
        state.orchestrator.remote_start();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        *state.listen_addr.write().unwrap() = Some(address);
        state.port.store(address.port(), std::sync::atomic::Ordering::Relaxed);
        let app = Router::new()
            .merge(crate::http::routes())
            .merge(crate::network::routes())
            .route("/ws", get(crate::ws::upgrade))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
        Self { state, address, server, dir }
    }

    fn id(&self) -> String {
        self.state.network.machine_id().unwrap()
    }

    async fn client(&self, scopes: &[Scope]) -> (Client, Uuid) {
        let token = crate::auth::generate();
        let id = Uuid::now_v7();
        self.state.store.token_insert(id, &crate::auth::hash(&token), "preview test device", scopes).unwrap();
        let client = Client::connect(&Endpoint { url: format!("ws://{}/ws", self.address), token }).await.unwrap();
        (client, id)
    }

    async fn link(&self, other: &Self) {
        let target = session::Target::at_url(
            other.id(),
            other.state.network.membership().unwrap().keys().signing_public_b64(),
            format!("http://{}", other.address),
        );
        let established =
            session::open(&self.state.network, self.state.network.membership().unwrap(), &target, &Scope::MACHINE_DEFAULT, None)
                .await
                .unwrap();
        let mut request = format!("ws://{}/ws", other.address).into_client_request().unwrap();
        request.headers_mut().insert("authorization", format!("Bearer {}", established.token).parse().unwrap());
        let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        peers::run_dialed(self.state.clone(), target, established, socket);
        crate::network::harness::eventually("preview machine session", Duration::from_secs(5), || {
            self.state.network.peers.link(&other.id()).is_some() && other.state.network.peers.link(&self.id()).is_some()
        })
        .await;
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.state.shutdown.cancel();
        self.state.network.ports.close_all();
        self.state.network.peers.close_all();
        self.server.abort();
    }
}

#[test]
fn server_preview_rpc_forwards_a_third_machine_without_a_primary_thread() {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_stack_size(crate::RUNTIME_THREAD_STACK)
        .enable_all()
        .build()
        .unwrap()
        .block_on(run_server_preview());
}

async fn run_server_preview() {
    let primary = Node::start("preview-primary").await;
    let thread_host = Node::start("preview-thread-host").await;
    let server_host = Node::start("preview-server-host").await;
    let members = primary.state.network.membership().unwrap();
    let mut info = primary.state.network.self_info().await;
    info.name = "Primary".into();
    members.genesis("owner@example.test", "test", &info).unwrap();
    for (node, name) in [(&thread_host, "Thread host"), (&server_host, "Server host")] {
        let mut info = node.state.network.self_info().await;
        info.name = name.into();
        let descriptor = node.state.network.membership().unwrap().self_descriptor(&info);
        members.add(descriptor, JoinVia::Code).unwrap();
    }
    for node in [&thread_host, &server_host] {
        node.state.network.membership().unwrap().join(members.all_ops()).unwrap();
    }
    primary.link(&thread_host).await;
    primary.link(&server_host).await;

    // A selected conversation belongs to B; primary A deliberately has no local threads.
    let (on_thread_host, _) = thread_host.client(&Scope::ALL).await;
    let project = on_thread_host
        .call::<ProjectsAdd>(ProjectsAddParams {
            path: thread_host.dir.path().to_string_lossy().into_owned(),
            name: Some("Thread project".into()),
            space_id: None,
            kind: None,
            members: None,
        })
        .await
        .unwrap();
    let thread = on_thread_host
        .call::<ThreadsCreate>(ThreadsCreateParams {
            project_id: Some(project.id),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: None,
            use_worktree: Some(false),
            base_branch: None,
            title: Some("Preview elsewhere".into()),
            message: None,
            thread_id: None,
            message_id: None,
            members: None,
            base_branches: None,
            pin_account: false,
        })
        .await
        .unwrap();
    assert!(primary.state.store.thread_get(thread.id).unwrap().is_none());
    let (client, device) = primary.client(&crate::access::paired_scopes()).await;
    assert!(client.call::<ThreadsList>(ThreadsListParams::default()).await.unwrap().threads.is_empty());

    // C serves its own identity, root-relative assets, and a Vite-style hot reload socket.
    let source = server_host.id();
    let page_source = source.clone();
    let socket_source = source.clone();
    let app = Router::new()
        .route(
            "/app",
            get(move || {
                let source = page_source.clone();
                async move { format!("<title>{source}</title><script src='/asset.js'></script>") }
            }),
        )
        .route("/asset.js", get(|| async { "window.sourceLoaded = true" }))
        .route(
            "/hmr",
            get(move |ws: WebSocketUpgrade| {
                let source = socket_source.clone();
                async move {
                    ws.protocols(["vite-hmr"]).on_upgrade(move |mut socket| async move {
                        while let Some(Ok(AxumMessage::Text(text))) = socket.recv().await {
                            if socket.send(AxumMessage::Text(format!("{source}:{text}").into())).await.is_err() {
                                break;
                            }
                        }
                    })
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote_port = listener.local_addr().unwrap().port();
    let dev = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let forward = client.call::<PortsForward>(PortsForwardParams { machine: source.clone(), remote_port, local_port: None }).await.unwrap();
    assert_eq!(forward.machine_id, source);
    assert_eq!(forward.remote_port, remote_port);
    assert_ne!(forward.local_port, remote_port);
    let params = PreviewServerOpenParams { url: format!("http://localhost:{}/app?q=1#hash", forward.local_port), proxy: true };
    let opened = client.call::<PreviewServerOpen>(params.clone()).await.unwrap();
    assert_eq!(opened.target, PreviewTargetInfo::Server { url: params.url.clone(), port: forward.local_port });
    let ticket = opened.ticket.unwrap();
    let capability = primary.state.previews.lookup(&ticket).unwrap();
    assert_eq!(capability.thread_id, None);
    assert_eq!(capability.principal, Some(device));
    let base = format!("http://{}{}", primary.address, opened.path.unwrap().trim_end_matches('/'));
    let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
    let page = http.get(format!("{base}/app?q=1")).send().await.unwrap();
    assert_eq!(page.status(), 200);
    assert!(page.text().await.unwrap().contains(&source));
    assert_eq!(http.get(format!("{base}/asset.js")).send().await.unwrap().text().await.unwrap(), "window.sourceLoaded = true");
    let mut request = format!("{}/hmr", base.replace("http://", "ws://")).into_client_request().unwrap();
    request.headers_mut().insert("sec-websocket-protocol", "vite-hmr".parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.headers().get("sec-websocket-protocol").unwrap(), "vite-hmr");
    for update in ["update-1", "update-2"] {
        socket.send(Message::Text(update.into())).await.unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
        assert_eq!(reply, Message::Text(format!("{source}:{update}").into()));
    }
    socket.close(None).await.unwrap();

    // Scope and address checks run at the actual client entry point.
    let (limited, _) = primary.client(&[Scope::OrchestrationRead]).await;
    let forbidden = limited.call::<PreviewServerOpen>(params.clone()).await.unwrap_err().to_string();
    assert!(forbidden.contains(&codes::FORBIDDEN.to_string()) && forbidden.contains("orchestration:operate"), "{forbidden}");
    for url in [
        format!("http://localhost:{}", primary.address.port()),
        "http://192.168.1.1:5173".into(),
        "https://example.test".into(),
        "file:///tmp/index.html".into(),
        "/tmp/index.html".into(),
    ] {
        assert!(client.call::<PreviewServerOpen>(PreviewServerOpenParams { url: url.clone(), proxy: true }).await.is_err(), "{url}");
    }
    assert!(
        client
            .call::<PortsForward>(PortsForwardParams { machine: source, remote_port: server_host.address.port(), local_port: None })
            .await
            .is_err()
    );
    let refused = client
        .call::<PreviewServerOpen>(PreviewServerOpenParams { url: format!("https://localhost:{remote_port}"), proxy: true })
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("HTTPS servers cannot be proxied"), "{refused}");

    client.call::<PreviewClose>(PreviewCloseParams { ticket }).await.unwrap();
    assert_eq!(http.get(format!("{base}/app")).send().await.unwrap().status(), 404);
    let opened = client.call::<PreviewServerOpen>(params).await.unwrap();
    let revoked = format!("http://{}{}app", primary.address, opened.path.unwrap());
    let (admin, _) = primary.client(&Scope::ALL).await;
    admin.call::<TokensRevoke>(TokensRevokeParams { token_id: device }).await.unwrap();
    assert_eq!(http.get(revoked).send().await.unwrap().status(), 404);
    assert!(primary.state.previews.lookup(&opened.ticket.unwrap()).is_none());
    admin.call::<PortsStop>(PortsStopParams { id: forward.id }).await.unwrap();
    dev.abort();
}
