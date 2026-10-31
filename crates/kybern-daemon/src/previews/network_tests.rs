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
        Self::start_tailnet(name, None).await
    }

    async fn start_tailnet(name: &str, peer: Option<&str>) -> Self {
        let dir = TempDir::new(name);
        let paths = crate::config::Paths::resolve(Some(dir.path().to_path_buf())).unwrap();
        let fixture = dir.path().join("no-tailnet.json");
        if let Some(peer) = peer {
            write_tailnet(&fixture, name, peer);
        }
        // No fake tailnet nodes: membership is enrolled explicitly as code-joined machines.
        // Only Tailscale discovery is replaced; identity proofs, signatures and sockets are real.
        let state = crate::state::AppState::initialize_with_drivers(
            &paths,
            Arc::new(Fake::new(fixture)),
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
    assert!(primary.state.network.peers.link(&server_host.id()).unwrap().relays.len() > 0, "code-only peers must use the fallback stream");
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

// Two loopback-only nodes exercise production TCP forwarding even on Macs without aliases.
fn write_tailnet(path: &std::path::Path, name: &str, peer: &str) {
    use crate::network::tailscale::{FakeFixture, FakeNode};
    let nodes = [peer, name]
        .into_iter()
        .enumerate()
        .map(|(i, name)| FakeNode {
            name: name.into(),
            node_id: format!("n{name}"),
            ip: format!("100.64.0.{}", i + 1).parse().unwrap(),
            listen: "127.0.0.1".parse().unwrap(),
            login: "owner@example.test".into(),
            user_id: 1,
            tags: vec![],
            shared_in: false,
            online: true,
        })
        .collect();
    let fixture = FakeFixture { self_name: name.into(), tailnet: "test".into(), nodes };
    std::fs::write(path, serde_json::to_vec(&fixture).unwrap()).unwrap();
}

async fn direct_pair() -> (Node, Node) {
    let a = Node::start_tailnet("a", Some("b")).await;
    let b = Node::start_tailnet("b", Some("a")).await;
    let members = a.state.network.membership().unwrap();
    members.genesis("owner@example.test", "test", &a.state.network.self_info().await).unwrap();
    let descriptor = b.state.network.membership().unwrap().self_descriptor(&b.state.network.self_info().await);
    members.add(descriptor, JoinVia::Code).unwrap();
    b.state.network.membership().unwrap().join(members.all_ops()).unwrap();
    a.link(&b).await;
    (a, b)
}

#[test]
fn direct_port_forward_authorizes_tokens_members_and_policy_and_carries_websockets() {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_stack_size(crate::RUNTIME_THREAD_STACK)
        .enable_all()
        .build()
        .unwrap()
        .block_on(run_direct_ports());
}

async fn run_direct_ports() {
    use crate::network::ports::direct;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (a, b) = direct_pair().await;
    let app = Router::new().route("/", get(|| async { "hello direct" })).route(
        "/hmr",
        get(|ws: WebSocketUpgrade| async {
            ws.protocols(["vite-hmr"]).on_upgrade(|mut socket| async move {
                while let Some(Ok(message)) = socket.recv().await {
                    if socket.send(message).await.is_err() {
                        break;
                    }
                }
            })
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let remote_port = listener.local_addr().unwrap().port();
    let dev = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let link = a.state.network.peers.link(&b.id()).unwrap();
    let id = Uuid::now_v7();
    let prepared = link.call::<PeerPortsPrepare>(PeerPortsPrepareParams { forward_id: id, port: remote_port }).await.unwrap();
    let endpoint = prepared.direct.expect("a direct listener on the fake tailnet");
    let destination = direct::destination(&a.state.network, &b.id(), endpoint.port).await.unwrap();
    let bad = PeerPortsDirect { token: "0".repeat(64), port: endpoint.port };
    assert!(direct::connect(&a.state.network, destination, &bad).await.is_none(), "invalid token accepted");
    // A node outside membership with a stolen per-forward token is still refused.
    write_tailnet(&b.dir.path().join("no-tailnet.json"), "b", "outsider");
    assert!(direct::connect(&a.state.network, destination, &endpoint).await.is_none(), "non-member accepted");
    write_tailnet(&b.dir.path().join("no-tailnet.json"), "b", "a");
    let mut raw = direct::connect(&a.state.network, destination, &endpoint).await.unwrap();
    raw.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut response = String::new();
    raw.read_to_string(&mut response).await.unwrap();
    assert!(response.contains("hello direct"));
    link.call::<PeerPortsRelease>(PeerPortsReleaseParams { forward_id: id }).await.unwrap();

    let (client, _) = a.client(&Scope::ALL).await;
    let forwarded = client.call::<PortsForward>(PortsForwardParams { machine: b.id(), remote_port, local_port: None }).await.unwrap();
    assert!(forwarded.local_port > remote_port, "the occupied remote port is followed by a higher free port");
    assert!(a.state.network.ports.lock().iter().find(|f| f.id == forwarded.id).unwrap().direct.is_some(), "no negotiated direct route");
    let page = reqwest::get(format!("http://127.0.0.1:{}/", forwarded.local_port)).await.unwrap().text().await.unwrap();
    assert_eq!(page, "hello direct");
    let mut request = format!("ws://127.0.0.1:{}/hmr", forwarded.local_port).into_client_request().unwrap();
    request.headers_mut().insert("sec-websocket-protocol", "vite-hmr".parse().unwrap());
    let (mut websocket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "vite-hmr");
    websocket.send(Message::Text("update".into())).await.unwrap();
    assert_eq!(websocket.next().await.unwrap().unwrap(), Message::Text("update".into()));
    assert_eq!(a.state.network.peers.link(&b.id()).unwrap().relays.len(), 0, "the direct path used the WebSocket tunnel");
    assert_eq!(b.state.network.peers.link(&a.id()).unwrap().relays.len(), 0);
    // A third member gets a separate listener and token for the same remote service.
    // This loopback-only fixture attributes new handshakes to c; a's established socket stays live.
    let c = Node::start_tailnet("c", Some("b")).await;
    let members = a.state.network.membership().unwrap();
    let descriptor = c.state.network.membership().unwrap().self_descriptor(&c.state.network.self_info().await);
    let added = members.add(descriptor, JoinVia::Code).unwrap();
    b.state.network.apply_remote(Some(&a.id()), vec![added]).unwrap();
    c.state.network.membership().unwrap().join(members.all_ops()).unwrap();
    write_tailnet(&b.dir.path().join("no-tailnet.json"), "b", "c");
    c.link(&b).await;
    let (on_c, _) = c.client(&Scope::ALL).await;
    let second = on_c.call::<PortsForward>(PortsForwardParams { machine: b.id(), remote_port, local_port: None }).await.unwrap();
    let token_a = a.state.network.ports.lock().iter().find(|f| f.id == forwarded.id).unwrap().direct.as_ref().unwrap().1.token.clone();
    let token_c = c.state.network.ports.lock().iter().find(|f| f.id == second.id).unwrap().direct.as_ref().unwrap().1.token.clone();
    assert!(token_a != token_c, "each member must get its own token");
    let (mut other, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/hmr", second.local_port)).await.unwrap();
    other.send(Message::Text("client-c".into())).await.unwrap();
    assert_eq!(other.next().await.unwrap().unwrap(), Message::Text("client-c".into()));
    websocket.send(Message::Text("still-a".into())).await.unwrap();
    assert_eq!(websocket.next().await.unwrap().unwrap(), Message::Text("still-a".into()));
    on_c.call::<PortsStop>(PortsStopParams { id: second.id }).await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(3), other.next()).await.is_ok());
    websocket.send(Message::Text("a-after-c-stopped".into())).await.unwrap();
    assert_eq!(websocket.next().await.unwrap().unwrap(), Message::Text("a-after-c-stopped".into()));
    write_tailnet(&b.dir.path().join("no-tailnet.json"), "b", "a");

    // Narrowing policy must end the socket that is already open.
    let op = b.state.network.membership().unwrap().set(&format!("allow.{}.ports", b.id()), serde_json::json!(false)).unwrap();
    b.state.network.publish_ops(vec![op]);
    let end = tokio::time::timeout(Duration::from_secs(3), websocket.next()).await.expect("policy did not end TCP");
    assert!(end.is_none_or(|frame| frame.is_err() || matches!(frame, Ok(Message::Close(_)))));
    assert!(client.call::<PortsForward>(PortsForwardParams { machine: b.id(), remote_port: 1, local_port: None }).await.is_err());
    client.call::<PortsStop>(PortsStopParams { id: forwarded.id }).await.unwrap();
    let op = b.state.network.membership().unwrap().set(&format!("allow.{}.ports", b.id()), serde_json::json!(true)).unwrap();
    b.state.network.publish_ops(vec![op]);
    let mut old = b.state.network.presence();
    old.version = "0.20.4".into();
    old.features.retain(|f| f != features::PORTS_DIRECT_V1);
    a.state.network.peers.set_presence(&b.id(), old);
    let legacy = client.call::<PortsForward>(PortsForwardParams { machine: b.id(), remote_port, local_port: None }).await.unwrap();
    let (mut legacy_ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/hmr", legacy.local_port)).await.unwrap();
    legacy_ws.send(Message::Text("legacy".into())).await.unwrap();
    assert_eq!(legacy_ws.next().await.unwrap().unwrap(), Message::Text("legacy".into()));
    assert_eq!(a.state.network.peers.link(&b.id()).unwrap().relays.len(), 1, "old peers must use stream transport");
    client.call::<PortsStop>(PortsStopParams { id: legacy.id }).await.unwrap();
    dev.abort();
}

/// Kept ignored because it holds scratch nodes open for the external browser benchmark.
#[test]
#[ignore = "run with KYBERN_PORT_BENCHMARK_ROOT and a scratch Vite server"]
fn port_forward_benchmark_fixture() {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_stack_size(crate::RUNTIME_THREAD_STACK)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = std::path::PathBuf::from(std::env::var_os("KYBERN_PORT_BENCHMARK_ROOT").expect("scratch benchmark folder"));
            let remote_port = std::env::var("KYBERN_PORT_BENCHMARK_PORT").unwrap_or_else(|_| "58173".into()).parse().unwrap();
            let (a, b) = direct_pair().await;
            let (client, _) = a.client(&Scope::ALL).await;
            let started = std::time::Instant::now();
            let direct = client.call::<PortsForward>(PortsForwardParams { machine: b.id(), remote_port, local_port: None }).await.unwrap();
            let open_ms = started.elapsed().as_secs_f64() * 1000.0;
            let mut old = b.state.network.presence();
            old.features.retain(|f| f != features::PORTS_DIRECT_V1);
            a.state.network.peers.set_presence(&b.id(), old);
            let tunnel =
                client.call::<PortsForward>(PortsForwardParams { machine: b.id(), remote_port, local_port: Some(0) }).await.unwrap();
            let info =
                serde_json::json!({ "direct": remote_port, "tcp": direct.local_port, "tunnel": tunnel.local_port, "open_ms": open_ms });
            std::fs::write(root.join("forwards.json"), serde_json::to_vec_pretty(&info).unwrap()).unwrap();
            println!("{info}");
            for _ in 0..1200 {
                if root.join("done").exists() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            panic!("benchmark did not signal completion within 10 minutes");
        });
}
