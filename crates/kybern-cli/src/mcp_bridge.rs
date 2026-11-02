//! `kybern mcp-bridge`: a stdio MCP server that forwards to a Kybern session's
//! Streamable-HTTP gateway.
//!
//! Antigravity (`agy`) has no per-session MCP configuration, only one global
//! entry that starts a stdio server, and that server inherits `agy`'s
//! environment. Kybern registers this command once and puts the session's
//! endpoint and credential in the environment of each `agy` turn
//! (`KYBERN_MCP_URL`, `KYBERN_MCP_AUTHORIZATION`).
//!
//! Without both variables the bridge is inert: it answers the handshake with an
//! empty tool list and exits when its input closes, which is what every
//! `agy` session outside Kybern sees. The authorization is read from the
//! environment only; it is never printed, logged or put in an error.

use std::sync::Arc;

use anyhow::Result;
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const URL_VARIABLE: &str = "KYBERN_MCP_URL";
const AUTHORIZATION_VARIABLE: &str = "KYBERN_MCP_AUTHORIZATION";
const SESSION_HEADER: &str = "mcp-session-id";
const MODERN_VERSION: &str = "2026-07-28";
const LEGACY_VERSION: &str = "2025-11-25";

/// The gateway to forward to, when this process runs inside a Kybern turn.
struct Upstream {
    client: reqwest::Client,
    url: String,
    authorization: String,
    /// The `Mcp-Session-Id` the gateway issued, if it ever does.
    session: std::sync::Mutex<Option<String>>,
}

pub async fn run() -> Result<()> {
    let url = std::env::var(URL_VARIABLE).ok().filter(|value| !value.is_empty());
    let authorization = std::env::var(AUTHORIZATION_VARIABLE).ok().filter(|value| !value.is_empty());
    let upstream = match (url, authorization) {
        (Some(url), Some(authorization)) => reqwest::Client::builder()
            .no_proxy()
            .build()
            .ok()
            .map(|client| Arc::new(Upstream { client, url, authorization, session: std::sync::Mutex::new(None) })),
        _ => None,
    };
    let (out, mut lines_out) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = lines_out.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    // Replies can take minutes (a question waits for a person), so each request runs on its own task.
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = stdin.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else { continue };
        match &upstream {
            None => {
                if let Some(reply) = inert_reply(&message) {
                    let _ = out.send(reply);
                }
            }
            Some(upstream) if message.get("method").and_then(Value::as_str) == Some("initialize") => {
                // The handshake finishes before anything that follows it is read.
                forward(upstream, message, &out).await;
            }
            Some(upstream) => {
                let (upstream, out) = (upstream.clone(), out.clone());
                tokio::spawn(async move { forward(&upstream, message, &out).await });
            }
        }
    }
    drop(out);
    writer.abort();
    Ok(())
}

/// What an inert bridge says: an MCP server with no tools.
fn inert_reply(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str)?;
    let result = match method {
        "initialize" => {
            let version = message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or(LEGACY_VERSION);
            json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": server_info() })
        }
        "server/discover" => json!({
            "supportedVersions": [MODERN_VERSION, LEGACY_VERSION],
            "capabilities": { "tools": {} },
            "serverInfo": server_info(),
        }),
        "tools/list" => json!({ "tools": [] }),
        "ping" => json!({}),
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method is not supported" } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn server_info() -> Value {
    json!({ "name": "kybern", "version": env!("CARGO_PKG_VERSION") })
}

/// The headers the 2026-07-28 lifecycle wants, read from the body, because stdio has none.
fn request_headers(message: &Value, session: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let mut put = |name: &'static str, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let version =
        message.pointer("/params/_meta").and_then(|meta| meta.get("io.modelcontextprotocol/protocolVersion")).and_then(Value::as_str);
    if let Some(version) = version {
        put("mcp-protocol-version", version);
        put("mcp-method", method);
        if method == "tools/call"
            && let Some(name) = message.pointer("/params/name").and_then(Value::as_str)
        {
            put("mcp-name", name);
        }
    } else if method == "server/discover" {
        put("mcp-protocol-version", MODERN_VERSION);
        put("mcp-method", method);
    }
    if let Some(session) = session {
        put(SESSION_HEADER, session);
    }
    headers
}

fn failure(message: &Value, text: &str) -> Option<Value> {
    let id = message.get("id")?.clone();
    Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": text } }))
}

async fn forward(upstream: &Upstream, message: Value, out: &mpsc::UnboundedSender<Value>) {
    let session = upstream.session.lock().unwrap_or_else(|error| error.into_inner()).clone();
    let request = upstream
        .client
        .post(&upstream.url)
        .headers(request_headers(&message, session.as_deref()))
        .header(AUTHORIZATION, format!("Bearer {}", upstream.authorization))
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json, text/event-stream")
        .body(message.to_string());
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            // The error text of a request can echo the URL; say only what to do next.
            if let Some(reply) = failure(&message, "Kybern isn't reachable. Send your message again.") {
                let _ = out.send(reply);
            }
            return;
        }
    };
    if let Some(issued) = response.headers().get(SESSION_HEADER).and_then(|value| value.to_str().ok()) {
        *upstream.session.lock().unwrap_or_else(|error| error.into_inner()) = Some(issued.to_string());
    }
    let status = response.status();
    if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
        return;
    }
    let is_stream = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
    let mut answered = false;
    if is_stream {
        let mut buffer = String::new();
        let mut body = response.bytes_stream();
        while let Some(Ok(chunk)) = body.next().await {
            buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
            while let Some(end) = buffer.find("\n\n") {
                let event: String = buffer.drain(..end + 2).collect();
                answered |= emit_event(&event, out);
            }
        }
        answered |= emit_event(&buffer, out);
    } else if let Ok(bytes) = response.bytes().await {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Array(batch)) => {
                for item in batch {
                    answered = true;
                    let _ = out.send(item);
                }
            }
            Ok(value) if value.is_object() => {
                answered = true;
                let _ = out.send(value);
            }
            _ => {}
        }
    }
    if !answered && let Some(reply) = failure(&message, &format!("Kybern refused the request (HTTP {}).", status.as_u16())) {
        let _ = out.send(reply);
    }
}

/// Send the JSON of each `data:` line of one server-sent event. Whether it sent any.
fn emit_event(event: &str, out: &mpsc::UnboundedSender<Value>) -> bool {
    let data: String = event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|rest| rest.strip_prefix(' ').unwrap_or(rest))
        .collect::<Vec<_>>()
        .join("\n");
    match serde_json::from_str::<Value>(&data) {
        Ok(value) if value.is_object() => out.send(value).is_ok(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inert_bridge_serves_an_empty_catalog() {
        let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"agy","version":"1"}}});
        let reply = inert_reply(&initialize).unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(reply["result"]["capabilities"], json!({"tools":{}}));
        let list = inert_reply(&json!({"jsonrpc":"2.0","id":"a","method":"tools/list"})).unwrap();
        assert_eq!(list["result"]["tools"], json!([]));
        assert!(inert_reply(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let unknown = inert_reply(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x"}})).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
        let discover = inert_reply(&json!({"jsonrpc":"2.0","id":3,"method":"server/discover"})).unwrap();
        assert_eq!(discover["result"]["capabilities"], json!({"tools":{}}));
    }

    #[test]
    fn modern_requests_carry_their_headers() {
        let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kybern_project_map",
            "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}});
        let headers = request_headers(&call, Some("s1"));
        assert_eq!(headers["mcp-protocol-version"], "2026-07-28");
        assert_eq!(headers["mcp-method"], "tools/call");
        assert_eq!(headers["mcp-name"], "kybern_project_map");
        assert_eq!(headers["mcp-session-id"], "s1");
        let legacy = request_headers(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), None);
        assert!(legacy.is_empty());
    }

    #[test]
    fn event_streams_yield_their_json() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert!(emit_event("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n", &tx));
        assert!(!emit_event(": keepalive\n\n", &tx));
        assert_eq!(rx.try_recv().unwrap()["id"], 1);
    }

    #[test]
    fn failures_never_carry_the_credential() {
        let message = json!({"jsonrpc":"2.0","id":7,"method":"tools/call"});
        let reply = failure(&message, "Kybern isn't reachable. Send your message again.").unwrap();
        assert_eq!(reply["id"], 7);
        assert!(failure(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}), "x").is_none());
    }
}
