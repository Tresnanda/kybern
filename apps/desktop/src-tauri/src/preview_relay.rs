//! Loopback relay for in-app previews of dev servers on a remote (or local,
//! "Preview through Kybern") daemon.
//!
//! Dev servers emit root-absolute URLs (`/@vite/client`) that a path-prefixed
//! proxy cannot serve, so every relayed preview gets its own loopback origin
//! (`http://127.0.0.1:{port}`). Each connection carries one request: the head
//! is parsed, the target is rewritten to `{prefix}{target}`, `Host` is set to
//! the daemon, and the bytes are spliced. The ticket in the prefix is the only
//! credential; the relay never adds the daemon token and binds loopback only.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

const MAX_RELAYS: usize = 4;
const MAX_HEAD: usize = 64 * 1024;
const MAX_HEADERS: usize = 100;
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_SEGMENT: &str = "/preview-proxy/";
pub const WS_FAILED_EVENT: &str = "preview-relay://ws-failed";

type WsFailed = Arc<dyn Fn(u16) + Send + Sync>;

/// A parsed `{http_base}/preview-proxy/{ticket}` upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Upstream {
    /// `host:port`, used both for connecting and as the `Host` header.
    authority: String,
    /// `/preview-proxy/{ticket}` with no trailing slash.
    prefix: String,
}

fn parse_upstream(raw: &str) -> Result<Upstream, String> {
    let rest = raw.strip_prefix("http://").ok_or("Only http:// daemons can be forwarded")?;
    if rest.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err("Invalid preview address".into());
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.is_empty() || authority.contains('@') {
        return Err("Invalid preview address".into());
    }
    if !path.starts_with(PROXY_SEGMENT) || path.contains(['?', '#']) || path.split('/').any(|s| s == "..") {
        return Err("Not a preview proxy address".into());
    }
    let prefix = path.trim_end_matches('/');
    if prefix.len() <= PROXY_SEGMENT.len() {
        return Err("Not a preview proxy address".into());
    }
    let authority = if has_port(authority) { authority.to_string() } else { format!("{authority}:80") };
    Ok(Upstream { authority, prefix: prefix.to_string() })
}

/// Normalized `host:port` of a plain `http://` base, or `None` for anything else.
pub fn http_authority(base: &str) -> Option<String> {
    let rest = base.strip_prefix("http://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let authority = authority.to_ascii_lowercase();
    Some(if has_port(&authority) { authority } else { format!("{authority}:80") })
}

fn has_port(authority: &str) -> bool {
    match authority.rfind(':') {
        Some(i) => !authority[i + 1..].is_empty() && authority[i + 1..].bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

#[derive(Default)]
struct Relays {
    open: Mutex<HashMap<u16, JoinHandle<()>>>,
}

impl Relays {
    async fn open(&self, raw_upstream: &str, allowed: &[String], on_ws_failed: WsFailed) -> Result<u16, String> {
        let upstream = parse_upstream(raw_upstream)?;
        if !allowed.iter().any(|a| a.eq_ignore_ascii_case(&upstream.authority)) {
            return Err("Kybern only forwards previews from your configured daemon".into());
        }
        {
            let open = self.open.lock().unwrap();
            if open.len() >= MAX_RELAYS {
                return Err("Too many forwarded previews. Close one and try again.".into());
            }
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let mut open = self.open.lock().unwrap();
        if open.len() >= MAX_RELAYS {
            return Err("Too many forwarded previews. Close one and try again.".into());
        }
        open.insert(port, tokio::spawn(serve(listener, upstream, port, on_ws_failed)));
        Ok(port)
    }

    fn close(&self, port: u16) {
        if let Some(task) = self.open.lock().unwrap().remove(&port) {
            // Dropping the accept loop's JoinSet aborts its live connections.
            task.abort();
        }
    }

    fn close_all(&self) {
        for (_, task) in self.open.lock().unwrap().drain() {
            task.abort();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.open.lock().unwrap().len()
    }
}

static RELAYS: LazyLock<Relays> = LazyLock::new(Relays::default);

async fn serve(listener: TcpListener, upstream: Upstream, port: u16, on_ws_failed: WsFailed) {
    let upstream = Arc::new(upstream);
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((client, _)) = accepted else { continue };
                let upstream = upstream.clone();
                let on_ws_failed = on_ws_failed.clone();
                connections.spawn(async move {
                    let _ = handle(client, &upstream, port, on_ws_failed).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

async fn reply(client: &mut TcpStream, status: &str) {
    let head = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    let _ = client.write_all(head.as_bytes()).await;
    let _ = client.shutdown().await;
}

/// Reads until the blank line ending a message head; returns the buffer
/// (head plus any bytes already read past it).
async fn read_head(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(buf);
        }
        if buf.len() > MAX_HEAD {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
}

fn header_has_token(value: &[u8], token: &str) -> bool {
    String::from_utf8_lossy(value).split(',').any(|t| t.trim().eq_ignore_ascii_case(token))
}

/// Rewrites the request head; returns the new head, the number of source
/// bytes it consumed, and whether this is a protocol upgrade.
fn rewrite_head(buf: &[u8], upstream: &Upstream) -> Result<(Vec<u8>, usize, bool), &'static str> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut req = httparse::Request::new(&mut headers);
    let consumed = match req.parse(buf) {
        Ok(httparse::Status::Complete(n)) => n,
        Ok(httparse::Status::Partial) => return Err("400 Bad Request"),
        Err(httparse::Error::TooManyHeaders) => return Err("431 Request Header Fields Too Large"),
        Err(_) => return Err("400 Bad Request"),
    };
    let method = req.method.ok_or("400 Bad Request")?;
    let target = req.path.ok_or("400 Bad Request")?;
    if method.eq_ignore_ascii_case("CONNECT") {
        return Err("405 Method Not Allowed");
    }
    // Only origin-form targets (`/path?query`) are relayed.
    if !target.starts_with('/') || target.starts_with("//") {
        return Err("400 Bad Request");
    }
    let is_upgrade = req.headers.iter().any(|h| h.name.eq_ignore_ascii_case("connection") && header_has_token(h.value, "upgrade"))
        && req.headers.iter().any(|h| h.name.eq_ignore_ascii_case("upgrade"));

    let mut out = Vec::with_capacity(consumed + 64);
    out.extend_from_slice(format!("{method} {}{target} HTTP/1.1\r\n", upstream.prefix).as_bytes());
    out.extend_from_slice(format!("Host: {}\r\n", upstream.authority).as_bytes());
    for h in req.headers.iter() {
        let name = h.name.to_ascii_lowercase();
        match name.as_str() {
            "host" | "connection" | "proxy-connection" | "keep-alive" => continue,
            "upgrade" if !is_upgrade => continue,
            _ => {}
        }
        out.extend_from_slice(h.name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(h.value);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(if is_upgrade { b"Connection: Upgrade\r\n" } else { b"Connection: close\r\n" });
    out.extend_from_slice(b"\r\n");
    Ok((out, consumed, is_upgrade))
}

async fn handle(mut client: TcpStream, upstream: &Upstream, port: u16, on_ws_failed: WsFailed) -> std::io::Result<()> {
    let buf = match timeout(HEAD_TIMEOUT, read_head(&mut client)).await {
        Ok(Ok(buf)) => buf,
        Ok(Err(e)) => {
            if e.kind() == std::io::ErrorKind::InvalidData {
                reply(&mut client, "431 Request Header Fields Too Large").await;
            }
            return Err(e);
        }
        Err(_) => {
            reply(&mut client, "408 Request Timeout").await;
            return Ok(());
        }
    };
    let (head, consumed, is_upgrade) = match rewrite_head(&buf, upstream) {
        Ok(parts) => parts,
        Err(status) => {
            reply(&mut client, status).await;
            return Ok(());
        }
    };
    let connected = timeout(CONNECT_TIMEOUT, TcpStream::connect(upstream.authority.as_str())).await;
    let Ok(Ok(mut daemon)) = connected else {
        reply(&mut client, "502 Bad Gateway").await;
        return Ok(());
    };
    daemon.set_nodelay(true).ok();
    daemon.write_all(&head).await?;
    // Body bytes that arrived with the head belong to the request.
    daemon.write_all(&buf[consumed..]).await?;

    if is_upgrade {
        // Forward the answer head ourselves so a refused upgrade is noticed.
        let answer = read_head(&mut daemon).await?;
        client.write_all(&answer).await?;
        let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut res = httparse::Response::new(&mut headers);
        let switched = matches!(res.parse(&answer), Ok(httparse::Status::Complete(_))) && res.code == Some(101);
        if !switched {
            on_ws_failed(port);
        }
    }
    let _ = copy_bidirectional(&mut client, &mut daemon).await;
    Ok(())
}

/// Starts a loopback relay for `upstream` (`{http_base}/preview-proxy/{ticket}`)
/// and returns its origin, `http://127.0.0.1:{port}`.
#[tauri::command]
pub async fn preview_relay_open<R: tauri::Runtime>(app: tauri::AppHandle<R>, upstream: String) -> Result<String, String> {
    let allowed = crate::environments::daemon_authorities(&app).await;
    let on_ws_failed: WsFailed = Arc::new(move |port| {
        let _ = app.emit(WS_FAILED_EVENT, serde_json::json!({ "port": port }));
    });
    let port = RELAYS.open(&upstream, &allowed, on_ws_failed).await?;
    Ok(format!("http://127.0.0.1:{port}"))
}

#[tauri::command]
pub fn preview_relay_close(port: u16) {
    RELAYS.close(port);
}

/// Closes every relay (app quit).
pub fn close_all() {
    RELAYS.close_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU16, Ordering};

    fn any() -> Vec<String> {
        vec!["127.0.0.1:9".into()]
    }

    fn noop() -> WsFailed {
        Arc::new(|_| {})
    }

    async fn daemon() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        (listener, format!("http://{addr}/preview-proxy/T1"))
    }

    async fn connect(port: u16) -> TcpStream {
        TcpStream::connect(("127.0.0.1", port)).await.unwrap()
    }

    #[test]
    fn parses_upstreams() {
        let u = parse_upstream("http://127.0.0.1:4199/preview-proxy/abc/").unwrap();
        assert_eq!(u, Upstream { authority: "127.0.0.1:4199".into(), prefix: "/preview-proxy/abc".into() });
        assert_eq!(parse_upstream("http://box/preview-proxy/abc").unwrap().authority, "box:80");
        assert_eq!(parse_upstream("http://[::1]:9/preview-proxy/abc").unwrap().authority, "[::1]:9");
        for bad in [
            "https://h:1/preview-proxy/abc",
            "ftp://h/preview-proxy/abc",
            "h:1/preview-proxy/abc",
            "http://h:1/other/abc",
            "http://h:1/preview-proxy/",
            "http://h:1",
            "http://user@h:1/preview-proxy/abc",
            "http://h:1/preview-proxy/abc?x=1",
            "http://h:1/preview-proxy/../abc",
            "http://h:1/preview-proxy/a b",
            "http:///preview-proxy/abc",
        ] {
            assert!(parse_upstream(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn rejects_non_http_upstream() {
        let relays = Relays::default();
        assert!(relays.open("https://h:1/preview-proxy/abc", &any(), noop()).await.is_err());
        assert!(relays.open("http://h:1/nope", &any(), noop()).await.is_err());
        assert_eq!(relays.len(), 0);
    }

    #[test]
    fn normalizes_http_authorities() {
        assert_eq!(http_authority("http://127.0.0.1:4199").as_deref(), Some("127.0.0.1:4199"));
        assert_eq!(http_authority("http://Box.Local").as_deref(), Some("box.local:80"));
        assert_eq!(http_authority("http://[::1]:9/x").as_deref(), Some("[::1]:9"));
        assert_eq!(http_authority("https://h:443"), None);
        assert_eq!(http_authority("ws://h:1"), None);
    }

    #[tokio::test]
    async fn accepts_only_the_configured_daemon() {
        let relays = Relays::default();
        let allowed = vec!["127.0.0.1:4199".to_string(), "box.local:80".to_string()];
        for ok in ["http://127.0.0.1:4199/preview-proxy/a", "http://BOX.local/preview-proxy/a"] {
            let port = relays.open(ok, &allowed, noop()).await.unwrap();
            relays.close(port);
        }
        for bad in [
            "http://127.0.0.1:4198/preview-proxy/a",
            "http://127.0.0.2:4199/preview-proxy/a",
            "http://evil.com/preview-proxy/a",
            "http://127.0.0.1:80/preview-proxy/a",
            "http://box.local:8080/preview-proxy/a",
        ] {
            let err = relays.open(bad, &allowed, noop()).await.unwrap_err();
            assert!(err.contains("configured daemon"), "{bad}: {err}");
        }
        assert!(relays.open("http://127.0.0.1:4199/preview-proxy/a", &[], noop()).await.is_err());
        assert_eq!(relays.len(), 0);
    }

    #[tokio::test]
    async fn limits_relays_to_four() {
        let relays = Relays::default();
        let mut ports = vec![];
        for _ in 0..4 {
            ports.push(relays.open("http://127.0.0.1:9/preview-proxy/abc", &any(), noop()).await.unwrap());
        }
        assert!(relays.open("http://127.0.0.1:9/preview-proxy/abc", &any(), noop()).await.is_err());
        relays.close(ports[0]);
        assert!(relays.open("http://127.0.0.1:9/preview-proxy/abc", &any(), noop()).await.is_ok());
        relays.close_all();
        assert_eq!(relays.len(), 0);
    }

    #[tokio::test]
    async fn rewrites_target_and_sends_one_request_per_connection() {
        let (daemon, upstream) = daemon().await;
        let authority = daemon.local_addr().unwrap().to_string();
        let relays = Relays::default();
        let port = relays.open(&upstream, std::slice::from_ref(&authority), noop()).await.unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = daemon.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0u8; 1024];
            // Head plus the 5-byte body.
            while !(seen.windows(4).any(|w| w == b"\r\n\r\n") && seen.ends_with(b"hello")) {
                let n = sock.read(&mut chunk).await.unwrap();
                assert!(n > 0, "closed early: {}", String::from_utf8_lossy(&seen));
                seen.extend_from_slice(&chunk[..n]);
            }
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await.unwrap();
            sock.shutdown().await.unwrap();
            String::from_utf8(seen).unwrap()
        });

        let mut client = connect(port).await;
        client
            .write_all(
                format!(
                    "POST /src/main.tsx?x=1 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: keep-alive\r\nKeep-Alive: 5\r\nCookie: page=1\r\nContent-Length: 5\r\n\r\nhello"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut answer = String::new();
        client.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 200 OK"));
        assert!(answer.ends_with("ok"));

        let seen = server.await.unwrap();
        let lower = seen.to_ascii_lowercase();
        assert!(seen.starts_with("POST /preview-proxy/T1/src/main.tsx?x=1 HTTP/1.1\r\n"), "{seen}");
        assert!(seen.contains(&format!("Host: {authority}\r\n")), "{seen}");
        assert!(!seen.contains(&format!("127.0.0.1:{port}")), "{seen}");
        assert_eq!(lower.matches("connection:").count(), 1, "{seen}");
        assert!(lower.contains("connection: close\r\n"), "{seen}");
        assert!(!lower.contains("keep-alive"), "{seen}");
        // The page's own cookie passes through; the relay adds no credentials.
        assert!(seen.contains("Cookie: page=1\r\n"));
        assert!(!lower.contains("authorization"));
        assert!(seen.ends_with("\r\n\r\nhello"));
        relays.close_all();
    }

    async fn upgrade_roundtrip(answer: &'static [u8]) -> (String, Option<u16>) {
        let (daemon, upstream) = daemon().await;
        let authority = daemon.local_addr().unwrap().to_string();
        let failed = Arc::new(AtomicU16::new(0));
        let seen_failed = failed.clone();
        let relays = Relays::default();
        let port = relays
            .open(&upstream, std::slice::from_ref(&authority), Arc::new(move |p| seen_failed.store(p, Ordering::SeqCst)))
            .await
            .unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = daemon.accept().await.unwrap();
            let head = read_head(&mut sock).await.unwrap();
            sock.write_all(answer).await.unwrap();
            if answer.starts_with(b"HTTP/1.1 101") {
                let mut buf = [0u8; 16];
                let n = sock.read(&mut buf).await.unwrap();
                sock.write_all(&buf[..n]).await.unwrap();
            }
            sock.shutdown().await.ok();
            String::from_utf8(head).unwrap()
        });

        let mut client = connect(port).await;
        client
            .write_all(
                format!(
                    "GET /?token=1 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-hmr\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: x\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut got = Vec::new();
        let mut chunk = [0u8; 512];
        while !got.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = client.read(&mut chunk).await.unwrap();
            got.extend_from_slice(&chunk[..n]);
        }
        let mut text = String::from_utf8(got).unwrap();
        if text.starts_with("HTTP/1.1 101") {
            client.write_all(b"ping").await.unwrap();
            let mut echo = [0u8; 4];
            client.read_exact(&mut echo).await.unwrap();
            text.push_str(std::str::from_utf8(&echo).unwrap());
        }
        let head = server.await.unwrap();
        assert!(head.starts_with("GET /preview-proxy/T1/?token=1 HTTP/1.1\r\n"), "{head}");
        let lower = head.to_ascii_lowercase();
        assert!(lower.contains("connection: upgrade\r\n"), "{head}");
        assert!(lower.contains("upgrade: websocket\r\n"));
        assert!(lower.contains("sec-websocket-protocol: vite-hmr\r\n"));
        relays.close_all();
        let flag = failed.load(Ordering::SeqCst);
        (text, (flag != 0).then_some(flag))
    }

    #[tokio::test]
    async fn splices_an_upgrade_after_the_101() {
        let (text, failed) =
            upgrade_roundtrip(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await;
        assert!(text.starts_with("HTTP/1.1 101"));
        assert!(text.ends_with("ping"));
        assert_eq!(failed, None);
    }

    #[tokio::test]
    async fn reports_an_upgrade_that_is_not_switched() {
        let (text, failed) = upgrade_roundtrip(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        assert!(text.starts_with("HTTP/1.1 404"));
        assert!(failed.is_some());
    }

    #[tokio::test]
    async fn answers_502_when_the_daemon_is_unreachable() {
        let relays = Relays::default();
        let port = relays.open("http://127.0.0.1:1/preview-proxy/abc", &["127.0.0.1:1".into()], noop()).await.unwrap();
        let mut client = connect(port).await;
        client.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        client.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 502"));
        relays.close_all();
    }

    #[test]
    fn refuses_connect_and_absolute_targets() {
        let u = parse_upstream("http://h:1/preview-proxy/abc").unwrap();
        assert_eq!(rewrite_head(b"CONNECT h:1 HTTP/1.1\r\n\r\n", &u).unwrap_err(), "405 Method Not Allowed");
        assert!(rewrite_head(b"GET http://evil/ HTTP/1.1\r\n\r\n", &u).is_err());
        assert!(rewrite_head(b"GET //evil/x HTTP/1.1\r\n\r\n", &u).is_err());
    }
}
