//! `/preview-proxy/{ticket}/{*path}`: forward a page from a dev server on the
//! daemon host so a remote client (or the desktop relay) can show it.
//!
//! The ticket is the only capability. It fixes the target to
//! `127.0.0.1:{port}` or `[::1]:{port}` on this machine; nothing in the
//! request (path, headers, query) can choose another host or port. The route
//! never reads the daemon bearer and never forwards `Authorization` or
//! `Cookie`. Responses lose `X-Frame-Options` and CSP `frame-ancestors` so
//! the Preview panel can frame them, `Location` headers that point back at
//! the dev server become root-relative, and `Set-Cookie` `Domain=` is dropped.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts as _, Request, State};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt as _, StreamExt as _};
use tokio::net::TcpStream;

use super::tickets::TicketKind;
use crate::state::AppState;

const PREFIX: &str = "/preview-proxy/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

const HOP_BY_HOP: [&str; 8] =
    ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/// The loopback address a dev server on `port` answers on, if it is listening.
/// `previews.open` calls this when minting a proxy ticket.
pub async fn listener_addr(port: u16) -> Option<SocketAddr> {
    for ip in [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)] {
        let addr = SocketAddr::new(ip, port);
        if matches!(tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await, Ok(Ok(_))) {
            return Some(addr);
        }
    }
    None
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(IDLE_TIMEOUT)
            .build()
            .expect("proxy client")
    })
}

/// Split `/preview-proxy/{ticket}{rest}` into the ticket and the forwarded
/// path-and-query (always starting with `/`).
fn split_target(path_and_query: &str) -> Option<(&str, String)> {
    let rest = path_and_query.strip_prefix(PREFIX)?;
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (ticket, tail) = rest.split_at(end);
    let tail = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('?') {
        format!("/{tail}")
    } else {
        tail.to_string()
    };
    (!ticket.is_empty()).then_some((ticket, tail))
}

fn is_hop_header(name: &HeaderName, connection_tokens: &[String]) -> bool {
    HOP_BY_HOP.contains(&name.as_str()) || connection_tokens.iter().any(|token| token == name.as_str())
}

fn connection_tokens(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

/// Request headers for the dev server: no hop-by-hop, no daemon credentials,
/// `Host` / `Origin` / `Referer` pointing at `localhost:{port}`.
pub fn upstream_request_headers(incoming: &HeaderMap, port: u16) -> HeaderMap {
    let tokens = connection_tokens(incoming);
    let origin = format!("http://localhost:{port}");
    let mut out = HeaderMap::new();
    for (name, value) in incoming {
        if is_hop_header(name, &tokens)
            || matches!(name.as_str(), "authorization" | "cookie" | "host" | "origin" | "referer")
            || name.as_str().starts_with("sec-websocket-")
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out.insert(header::HOST, HeaderValue::from_str(&format!("localhost:{port}")).expect("host"));
    if incoming.contains_key(header::ORIGIN) {
        out.insert(header::ORIGIN, HeaderValue::from_str(&origin).expect("origin"));
    }
    if incoming.contains_key(header::REFERER) {
        out.insert(header::REFERER, HeaderValue::from_str(&format!("{origin}/")).expect("referer"));
    }
    out
}

/// `Location` values that point at the dev server become root-relative.
pub fn rewrite_location(location: &str, port: u16) -> String {
    for host in ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"] {
        for scheme in ["http", "https"] {
            let origin = format!("{scheme}://{host}:{port}");
            if let Some(rest) = location.strip_prefix(&origin)
                && (rest.is_empty() || rest.starts_with(['/', '?', '#']))
            {
                return match rest.chars().next() {
                    None => "/".to_string(),
                    Some('/') => rest.to_string(),
                    Some(_) => format!("/{rest}"),
                };
            }
        }
    }
    location.to_string()
}

/// Drop the `Domain` attribute so the cookie stays on the proxy origin.
pub fn strip_cookie_domain(cookie: &str) -> String {
    cookie
        .split(';')
        .filter(|part| {
            let name = part.trim_start().split('=').next().unwrap_or_default().trim();
            !name.eq_ignore_ascii_case("domain")
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Remove `frame-ancestors` from a CSP value; `None` if nothing is left.
pub fn strip_frame_ancestors(csp: &str) -> Option<String> {
    let kept: Vec<&str> = csp.split(';').map(str::trim).filter(|d| !d.is_empty() && super::probe::frame_ancestors(d).is_none()).collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

/// Response headers for the client.
pub fn client_response_headers(upstream: &HeaderMap, port: u16) -> HeaderMap {
    let tokens = connection_tokens(upstream);
    let mut out = HeaderMap::new();
    for (name, value) in upstream {
        if is_hop_header(name, &tokens) || name == header::X_FRAME_OPTIONS || name == "x-frame-options" {
            continue;
        }
        let text = value.to_str().ok();
        let replacement = match (name.as_str(), text) {
            ("content-security-policy", Some(csp)) => match strip_frame_ancestors(csp) {
                Some(csp) => HeaderValue::from_str(&csp).ok(),
                None => continue,
            },
            ("location", Some(location)) => HeaderValue::from_str(&rewrite_location(location, port)).ok(),
            ("set-cookie", Some(cookie)) => HeaderValue::from_str(&strip_cookie_domain(cookie)).ok(),
            _ => Some(value.clone()),
        };
        out.append(name.clone(), replacement.unwrap_or_else(|| value.clone()));
    }
    out
}

fn plain(status: StatusCode, message: &'static str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], message).into_response()
}

/// Axum handler for every method on `/preview-proxy/{ticket}` and below.
pub async fn serve(State(state): State<AppState>, request: Request) -> Response {
    handle(&state.previews, request).await
}

/// The route's logic over just the ticket store (so tests need no daemon).
pub async fn handle(tickets: &super::tickets::PreviewTickets, request: Request) -> Response {
    let path_and_query = request.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
    let Some((ticket, target)) = split_target(&path_and_query) else { return plain(StatusCode::NOT_FOUND, "not found") };
    let Some(info) = tickets.lookup(ticket) else { return plain(StatusCode::NOT_FOUND, "not found") };
    let TicketKind::Proxy { port } = info.kind else { return plain(StatusCode::NOT_FOUND, "not found") };

    let is_upgrade = request.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if is_upgrade {
        return upgrade(request, port, target).await;
    }
    forward(request, port, target).await
}

async fn forward(request: Request, port: u16, target: String) -> Response {
    let Some(addr) = listener_addr(port).await else { return plain(StatusCode::BAD_GATEWAY, "The server isn't answering.") };
    let host = match addr.ip() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    // The target always starts with `/`, so it cannot change the authority.
    let Ok(url) = reqwest::Url::parse(&format!("http://{host}:{port}{target}")) else { return plain(StatusCode::BAD_REQUEST, "bad request") };
    if url.port() != Some(port) || url.host_str() != Some(host.as_str()) {
        return plain(StatusCode::BAD_REQUEST, "bad request");
    }
    let (parts, body) = request.into_parts();
    let headers = upstream_request_headers(&parts.headers, port);
    let mut builder = client().request(parts.method.clone(), url).headers(headers);
    if !matches!(parts.method, Method::GET | Method::HEAD) {
        builder = builder.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    match builder.send().await {
        Ok(upstream) => {
            let status = upstream.status();
            let headers = client_response_headers(upstream.headers(), port);
            let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
            *response.status_mut() = status;
            *response.headers_mut() = headers;
            response
        }
        Err(error) if error.is_timeout() => plain(StatusCode::GATEWAY_TIMEOUT, "The server didn't answer."),
        Err(_) => plain(StatusCode::BAD_GATEWAY, "The server isn't answering."),
    }
}

async fn upgrade(request: Request, port: u16, target: String) -> Response {
    let (mut parts, _body) = request.into_parts();
    let requested: Vec<String> = parts
        .headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let socket = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(socket) => socket,
        Err(rejection) => return rejection.into_response(),
    };
    socket
        .protocols(requested.clone())
        .on_upgrade(move |client| async move { pump(client, port, target, requested).await })
}

fn close_reason(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.into() }))
}

async fn pump(mut client: WebSocket, port: u16, target: String, protocols: Vec<String>) {
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest as _};
    let Some(addr) = listener_addr(port).await else {
        let _ = client.send(close_reason(1011, "upstream unavailable")).await;
        return;
    };
    let host = match addr.ip() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let upstream = async {
        let mut request = format!("ws://{host}:{port}{target}").into_client_request().ok()?;
        let headers = request.headers_mut();
        headers.insert(header::HOST, HeaderValue::from_str(&format!("localhost:{port}")).ok()?);
        headers.insert(header::ORIGIN, HeaderValue::from_str(&format!("http://localhost:{port}")).ok()?);
        if !protocols.is_empty() {
            headers.insert("sec-websocket-protocol", HeaderValue::from_str(&protocols.join(", ")).ok()?);
        }
        tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await.ok()?.ok()
    };
    let Some((upstream, _)) = upstream.await else {
        let _ = client.send(close_reason(1011, "upstream unavailable")).await;
        return;
    };
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut down_tx, mut down_rx) = client.split();
    loop {
        tokio::select! {
            message = down_rx.next() => {
                let Some(Ok(message)) = message else { break };
                let converted = match message {
                    Message::Text(text) => tungstenite::Message::text(text.as_str().to_owned()),
                    Message::Binary(bytes) => tungstenite::Message::binary(bytes),
                    Message::Ping(bytes) => tungstenite::Message::Ping(bytes),
                    Message::Pong(bytes) => tungstenite::Message::Pong(bytes),
                    Message::Close(frame) => {
                        let _ = up_tx.send(tungstenite::Message::Close(frame.map(|f| tungstenite::protocol::CloseFrame {
                            code: f.code.into(),
                            reason: f.reason.as_str().to_owned().into(),
                        }))).await;
                        break;
                    }
                };
                if up_tx.send(converted).await.is_err() { break }
            }
            message = up_rx.next() => {
                let Some(Ok(message)) = message else { break };
                let converted = match message {
                    tungstenite::Message::Text(text) => Message::text(text.as_str().to_owned()),
                    tungstenite::Message::Binary(bytes) => Message::Binary(bytes),
                    tungstenite::Message::Ping(bytes) => Message::Ping(bytes),
                    tungstenite::Message::Pong(bytes) => Message::Pong(bytes),
                    tungstenite::Message::Close(frame) => {
                        let _ = down_tx.send(Message::Close(frame.map(|f| CloseFrame {
                            code: u16::from(f.code),
                            reason: f.reason.as_str().to_owned().into(),
                        }))).await;
                        break;
                    }
                    tungstenite::Message::Frame(_) => continue,
                };
                if down_tx.send(converted).await.is_err() { break }
            }
        }
    }
    let _ = up_tx.close().await;
    let _ = down_tx.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::previews::tickets::PreviewTickets;
    use axum::Router;
    use axum::extract::ws::WebSocketUpgrade;
    use axum::routing::{any, get};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use uuid::Uuid;

    async fn bind(app: Router) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    }

    /// A stand-in dev server.
    async fn dev_server() -> u16 {
        let app = Router::new()
            .route(
                "/headers",
                get(|headers: HeaderMap| async move {
                    let pick = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
                    let body = format!(
                        "host={};origin={};referer={};auth={};cookie={};conn={}",
                        pick("host"),
                        pick("origin"),
                        pick("referer"),
                        pick("authorization"),
                        pick("cookie"),
                        pick("x-hop")
                    );
                    (
                        [
                            ("x-frame-options", "DENY"),
                            ("content-security-policy", "default-src 'self'; frame-ancestors 'none'; img-src *"),
                            ("set-cookie", "sid=1; Domain=localhost; Path=/; HttpOnly"),
                            ("x-keep", "yes"),
                        ],
                        body,
                    )
                }),
            )
            .route(
                "/redirect-abs",
                get(|headers: HeaderMap| async move {
                    let host = headers.get("host").unwrap().to_str().unwrap().to_string();
                    (StatusCode::FOUND, [("location", format!("http://{host}/next?x=1"))])
                }),
            )
            .route("/redirect-other", get(|| async { (StatusCode::FOUND, [("location", "http://example.com/x")]) }))
            .route("/post", axum::routing::post(|body: String| async move { format!("got:{body}") }))
            .route(
                "/ws",
                get(|headers: HeaderMap, ws: WebSocketUpgrade| async move {
                    let pick = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
                    let hello = format!("host={};origin={}", pick("host"), pick("origin"));
                    ws.protocols(["vite-hmr"]).on_upgrade(move |mut socket| async move {
                        let _ = socket.send(Message::text(hello)).await;
                        while let Some(Ok(message)) = socket.recv().await {
                            if matches!(message, Message::Text(_) | Message::Binary(_)) && socket.send(message).await.is_err() {
                                break;
                            }
                        }
                    })
                }),
            );
        bind(app).await
    }

    struct Rig {
        tickets: Arc<PreviewTickets>,
        proxy: u16,
    }

    async fn rig() -> Rig {
        let tickets = Arc::new(PreviewTickets::new());
        let app = Router::new()
            .route("/preview-proxy/{ticket}", any(handler))
            .route("/preview-proxy/{ticket}/", any(handler))
            .route("/preview-proxy/{ticket}/{*path}", any(handler))
            .with_state(tickets.clone());
        Rig { proxy: bind(app).await, tickets }
    }

    async fn handler(State(tickets): State<Arc<PreviewTickets>>, request: Request) -> Response {
        handle(&tickets, request).await
    }

    impl Rig {
        fn ticket(&self, port: u16) -> String {
            self.tickets.mint(TicketKind::Proxy { port }, Uuid::new_v4(), None)
        }
        fn url(&self, ticket: &str, path: &str) -> String {
            format!("http://127.0.0.1:{}/preview-proxy/{ticket}{path}", self.proxy)
        }
    }

    fn http() -> reqwest::Client {
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn http_passthrough_rewrites_headers_and_strips_credentials() {
        let dev = dev_server().await;
        let rig = rig().await;
        let ticket = rig.ticket(dev);
        let response = http()
            .get(rig.url(&ticket, "/headers"))
            .header("authorization", "Bearer daemon-secret")
            .header("cookie", "kybern=1")
            .header("origin", format!("http://127.0.0.1:{}", rig.proxy))
            .header("referer", format!("http://127.0.0.1:{}/preview-proxy/{ticket}/x", rig.proxy))
            .header("connection", "x-hop")
            .header("x-hop", "1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let headers = response.headers().clone();
        assert!(headers.get("x-frame-options").is_none(), "XFO stripped");
        let csp = headers.get("content-security-policy").unwrap().to_str().unwrap();
        assert_eq!(csp, "default-src 'self'; img-src *");
        assert!(!csp.contains("frame-ancestors"));
        let cookie = headers.get("set-cookie").unwrap().to_str().unwrap();
        assert!(!cookie.to_ascii_lowercase().contains("domain"), "{cookie}");
        assert!(cookie.contains("sid=1") && cookie.contains("HttpOnly") && cookie.contains("Path=/"));
        assert_eq!(headers.get("x-keep").unwrap(), "yes");
        let body = response.text().await.unwrap();
        assert_eq!(
            body,
            format!("host=localhost:{dev};origin=http://localhost:{dev};referer=http://localhost:{dev}/;auth=-;cookie=-;conn=-")
        );
    }

    #[tokio::test]
    async fn location_pointing_at_the_dev_server_becomes_relative() {
        let dev = dev_server().await;
        let rig = rig().await;
        let ticket = rig.ticket(dev);
        let response = http().get(rig.url(&ticket, "/redirect-abs")).send().await.unwrap();
        assert_eq!(response.status(), 302, "redirects are not followed");
        assert_eq!(response.headers().get("location").unwrap(), "/next?x=1");
        let other = http().get(rig.url(&ticket, "/redirect-other")).send().await.unwrap();
        assert_eq!(other.headers().get("location").unwrap(), "http://example.com/x");
    }

    #[tokio::test]
    async fn request_bodies_stream_upstream() {
        let dev = dev_server().await;
        let rig = rig().await;
        let ticket = rig.ticket(dev);
        let response = http().post(rig.url(&ticket, "/post")).body("payload").send().await.unwrap();
        assert_eq!(response.text().await.unwrap(), "got:payload");
    }

    #[tokio::test]
    async fn ticket_is_bound_to_its_port_and_host() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let other = bind(Router::new().fallback(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                "other"
            }
        }))
        .await;
        let dev = dev_server().await;
        let rig = rig().await;
        let ticket = rig.ticket(dev);
        // Paths that try to name another authority still land on the ticket's port.
        for path in [format!("//127.0.0.1:{other}/headers"), format!("/@127.0.0.1:{other}/"), format!("/..%2f..%2f127.0.0.1:{other}")] {
            let response = http().get(rig.url(&ticket, &path)).send().await.unwrap();
            assert_ne!(response.text().await.unwrap(), "other", "{path}");
        }
        // The Host header cannot redirect the request either.
        http().get(rig.url(&ticket, "/headers")).header("host", format!("127.0.0.1:{other}")).send().await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 0, "unlisted port must never be contacted");
    }

    #[tokio::test]
    async fn unknown_wrong_kind_and_closed_port_tickets_fail() {
        let rig = rig().await;
        assert_eq!(http().get(rig.url("nope", "/")).send().await.unwrap().status(), 404);
        let files = rig.tickets.mint(TicketKind::Files { root: std::env::temp_dir() }, Uuid::new_v4(), None);
        assert_eq!(http().get(rig.url(&files, "/")).send().await.unwrap().status(), 404);
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let ticket = rig.ticket(closed);
        assert_eq!(http().get(rig.url(&ticket, "/")).send().await.unwrap().status(), 502);
        // The daemon token is never a credential for this route.
        assert_eq!(http().get(rig.url("daemon-token", "/")).header("authorization", "Bearer daemon-token").send().await.unwrap().status(), 404);
        rig.tickets.revoke(&ticket);
        assert_eq!(http().get(rig.url(&ticket, "/")).send().await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn websocket_echoes_with_subprotocol_and_rewritten_headers() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
        let dev = dev_server().await;
        let rig = rig().await;
        let ticket = rig.ticket(dev);
        let mut request = format!("ws://127.0.0.1:{}/preview-proxy/{ticket}/ws?token=abc", rig.proxy).into_client_request().unwrap();
        request.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_static("vite-hmr"));
        request.headers_mut().insert("origin", HeaderValue::from_str(&format!("http://127.0.0.1:{}", rig.proxy)).unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(response.headers().get("sec-websocket-protocol").unwrap(), "vite-hmr");
        let hello = socket.next().await.unwrap().unwrap();
        assert_eq!(hello.into_text().unwrap().as_str(), format!("host=localhost:{dev};origin=http://localhost:{dev}"));
        socket.send(tokio_tungstenite::tungstenite::Message::text("ping-1")).await.unwrap();
        assert_eq!(socket.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "ping-1");
        socket.send(tokio_tungstenite::tungstenite::Message::binary(vec![1u8, 2, 3])).await.unwrap();
        assert_eq!(socket.next().await.unwrap().unwrap().into_data().as_ref(), &[1, 2, 3]);
        socket.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn websocket_to_a_dead_port_closes_with_1011() {
        let rig = rig().await;
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let ticket = rig.ticket(closed);
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/preview-proxy/{ticket}/ws", rig.proxy)).await.unwrap();
        match socket.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 1011);
                assert_eq!(frame.reason.as_str(), "upstream unavailable");
            }
            other => panic!("expected close 1011, got {other:?}"),
        }
    }

    #[test]
    fn rewriting_helpers() {
        assert_eq!(rewrite_location("http://localhost:5173", 5173), "/");
        assert_eq!(rewrite_location("http://127.0.0.1:5173/a?b=1#c", 5173), "/a?b=1#c");
        assert_eq!(rewrite_location("http://localhost:51733/a", 5173), "http://localhost:51733/a");
        assert_eq!(rewrite_location("/already", 5173), "/already");
        assert_eq!(strip_cookie_domain("a=b; domain=.example.com; Secure"), "a=b; Secure");
        assert_eq!(strip_frame_ancestors("frame-ancestors 'self'"), None);
        assert_eq!(split_target("/preview-proxy/abc?x=1"), Some(("abc", "/?x=1".to_string())));
        assert_eq!(split_target("/preview-proxy/abc/a/b?c"), Some(("abc", "/a/b?c".to_string())));
    }
}
