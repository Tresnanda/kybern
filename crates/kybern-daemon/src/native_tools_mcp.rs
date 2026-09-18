//! Session-scoped native tool transport. This endpoint never authenticates a
//! normal Kybern client token and never accepts a caller-selected identity.
//!
//! JSON-response Streamable HTTP supports the legacy initialize lifecycle and
//! the per-request 2026-07-28 lifecycle. Provider sessions own capability
//! lifetime; no independent MCP session IDs or resumable streams are issued.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{Result, ensure};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::post};
use kybern_drivers::{NativeToolBridge, NativeToolDefinition, NativeToolRestrictions};
use kybern_protocol::ThreadId;
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::state::AppState;

const CURRENT_VERSION: &str = "2026-07-28";
const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_VERSIONS: &[&str] = &[CURRENT_VERSION, "2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_SESSIONS: usize = 1024;
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

#[derive(Clone, Default)]
pub(crate) struct NativeToolsGateway {
    sessions: Arc<Mutex<HashMap<String, Arc<NativeToolSession>>>>,
    endpoint: Arc<RwLock<Option<String>>>,
}

struct NativeToolSession {
    thread_id: ThreadId,
    session_instance_id: Uuid,
    tools: Vec<NativeToolDefinition>,
    instructions: Option<String>,
    permits: Semaphore,
}

impl NativeToolsGateway {
    pub(crate) fn set_endpoint(&self, mut addr: SocketAddr) {
        if addr.ip().is_unspecified() {
            addr.set_ip(if addr.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
        }
        *self.endpoint.write().unwrap_or_else(|error| error.into_inner()) = Some(format!("http://{addr}/native-tools/mcp"));
    }

    #[cfg(test)]
    pub(crate) fn register(
        &self,
        thread_id: ThreadId,
        session_instance_id: Uuid,
        tools: Vec<NativeToolDefinition>,
        restrictions: NativeToolRestrictions,
    ) -> Result<NativeToolBridge> {
        self.register_coordinator(thread_id, session_instance_id, tools, restrictions, None)
    }

    pub(crate) fn register_coordinator(
        &self,
        thread_id: ThreadId,
        session_instance_id: Uuid,
        tools: Vec<NativeToolDefinition>,
        restrictions: NativeToolRestrictions,
        coordinator_instructions: Option<String>,
    ) -> Result<NativeToolBridge> {
        let authorization = crate::auth::generate();
        let endpoint = self.endpoint.read().unwrap_or_else(|error| error.into_inner()).clone();
        let bridge = NativeToolBridge {
            server_name: "kybern".into(),
            authorization: endpoint.as_ref().map(|_| authorization.clone()),
            endpoint,
            tools,
            restrictions,
            coordinator_instructions,
        };
        bridge.validate()?;
        let mut sessions = self.sessions.lock().unwrap_or_else(|error| error.into_inner());
        // A replacement invalidates the previous session even if its process
        // finishes shutting down later. Revocation is keyed to the instance.
        let replacing = sessions.values().any(|session| session.thread_id == thread_id);
        ensure!(replacing || sessions.len() < MAX_SESSIONS, "Too many native tool sessions. Release an idle thread and retry.");
        sessions.retain(|_, session| session.thread_id != thread_id);
        sessions.insert(
            crate::auth::hash(&authorization),
            Arc::new(NativeToolSession {
                thread_id,
                session_instance_id,
                tools: bridge.tools().cloned().collect(),
                instructions: mcp_instructions(&bridge),
                permits: Semaphore::new(4),
            }),
        );
        Ok(bridge)
    }

    pub(crate) fn revoke(&self, session_instance_id: Uuid) {
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|_, session| session.session_instance_id != session_instance_id);
    }

    fn authenticate(&self, credential: &str) -> Option<Arc<NativeToolSession>> {
        if credential.len() > 256 {
            return None;
        }
        self.sessions.lock().unwrap_or_else(|error| error.into_inner()).get(&crate::auth::hash(credential)).cloned()
    }
}

/// Brief MCP metadata only. Do not copy this into provider prompts or user
/// messages; native-tool providers already receive the tool descriptions.
fn mcp_instructions(bridge: &NativeToolBridge) -> Option<String> {
    if let Some(instructions) = &bridge.coordinator_instructions {
        return Some(instructions.clone());
    }
    bridge.tools().next()?;
    let mut parts = vec!["Kybern tools are scoped to this conversation and its permissions."];
    if bridge.has_tool("kybern_thread_read") {
        parts.push("Read conversation references with kybern_thread_read.");
    }
    if bridge.has_tool("kybern_collaboration_spawn") {
        parts.push("Create managed Kybern child chats with kybern_collaboration_spawn.");
    }
    if bridge.has_tool("computer_use") {
        parts.push("Drive the host desktop with computer_use.");
    }
    parts.push("See individual tool descriptions for details. Respect explicit plugin or provider-native choices.");
    Some(parts.join(" "))
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/native-tools/mcp", post(handle)).layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
}

fn authorize(gateway: &NativeToolsGateway, headers: &HeaderMap) -> std::result::Result<Arc<NativeToolSession>, StatusCode> {
    // Native provider clients do not send browser origins. No browser origin
    // is authorized to use this endpoint, including the desktop WebView.
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    gateway.authenticate(credential).ok_or(StatusCode::UNAUTHORIZED)
}

async fn handle(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let session = match authorize(&state.native_tools, &headers) {
        Ok(session) => session,
        Err(status) => return no_store((status, "Native tool session is unavailable").into_response()),
    };
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("");
    if content_type.split(';').next().map(str::trim) != Some("application/json") {
        return no_store((StatusCode::UNSUPPORTED_MEDIA_TYPE, "Use application/json").into_response());
    }
    if headers.get(header::ACCEPT).and_then(|value| value.to_str().ok()).is_some_and(|accept| {
        !accept.split(',').any(|part| matches!(part.split(';').next().unwrap_or("").trim(), "application/json" | "application/*" | "*/*"))
    }) {
        return no_store((StatusCode::NOT_ACCEPTABLE, "This endpoint returns application/json").into_response());
    }
    let request: Value = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return rpc_error(None, -32700, "Invalid JSON", StatusCode::BAD_REQUEST),
    };
    let id = request.get("id").cloned();
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !request.is_object()
        || id.as_ref().is_some_and(|id| !(id.is_string() || id.is_i64() || id.is_u64()))
    {
        return rpc_error(None, -32600, "Invalid JSON-RPC request", StatusCode::BAD_REQUEST);
    }
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return rpc_error(id, -32600, "A method is required", StatusCode::BAD_REQUEST);
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return rpc_error(id, -32602, "Parameters must be an object", StatusCode::BAD_REQUEST);
    }
    // Notifications never execute tools. Cancellation of a request does not
    // cancel an already accepted durable assignment; that has its own tool.
    if id.is_none() {
        return if matches!(method, "notifications/initialized" | "notifications/cancelled") {
            no_store(StatusCode::ACCEPTED.into_response())
        } else {
            rpc_error(None, -32600, "This method requires a request ID", StatusCode::BAD_REQUEST)
        };
    }
    let modern = match request_version(&headers, method, &params) {
        Ok(modern) => modern,
        Err((-32022, message)) => {
            let requested = headers
                .get("mcp-protocol-version")
                .and_then(|value| value.to_str().ok())
                .or_else(|| params.pointer("/_meta/io.modelcontextprotocol~1protocolVersion").and_then(Value::as_str))
                .unwrap_or("");
            let mut body = json!({ "jsonrpc": "2.0", "error": {
                "code": -32022, "message": message, "data": { "supported": SUPPORTED_VERSIONS, "requested": requested },
            }});
            if let Some(id) = id {
                body["id"] = id;
            }
            return no_store((StatusCode::BAD_REQUEST, Json(body)).into_response());
        }
        Err((code, message)) => return rpc_error(id, code, message, StatusCode::BAD_REQUEST),
    };
    let result = match method {
        "initialize" => {
            let Some(requested) = params.get("protocolVersion").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "protocolVersion is required", StatusCode::BAD_REQUEST);
            };
            if !params.get("capabilities").is_some_and(Value::is_object)
                || params.pointer("/clientInfo/name").and_then(Value::as_str).is_none()
                || params.pointer("/clientInfo/version").and_then(Value::as_str).is_none()
            {
                return rpc_error(id, -32602, "capabilities and clientInfo are required", StatusCode::BAD_REQUEST);
            }
            let version = if LEGACY_VERSIONS.contains(&requested) { requested } else { LEGACY_VERSIONS[0] };
            let mut result =
                json!({ "protocolVersion": version, "capabilities": { "tools": { "listChanged": false } }, "serverInfo": server_info() });
            if let Some(instructions) = &session.instructions {
                result["instructions"] = json!(instructions);
            }
            result
        }
        "server/discover" => json!({
            "supportedVersions": SUPPORTED_VERSIONS,
            "capabilities": { "tools": { "listChanged": false } },
            "ttlMs": 0,
            "cacheScope": "private",
        }),
        "ping" => json!({}),
        "tools/list" => {
            if params.get("cursor").is_some_and(|value| !value.is_null()) {
                return rpc_error(id, -32602, "The tool catalog has no additional page", StatusCode::BAD_REQUEST);
            }
            let mut catalog = json!({ "tools": session.tools.iter().map(|tool| json!({
                "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema,
            })).collect::<Vec<_>>() });
            if modern {
                catalog["ttlMs"] = json!(0);
                catalog["cacheScope"] = json!("private");
            }
            catalog
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return rpc_error(id, -32602, "Tool name is required", StatusCode::BAD_REQUEST);
            };
            if !session.tools.iter().any(|tool| tool.name == name) {
                return rpc_error(id, -32602, "Tool is unavailable in this session", StatusCode::BAD_REQUEST);
            }
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return rpc_error(id, -32602, "Tool arguments must be an object", StatusCode::BAD_REQUEST);
            }
            let Ok(_permit) = session.permits.try_acquire() else {
                return rpc_error(id, -32000, "Too many concurrent tool requests", StatusCode::TOO_MANY_REQUESTS);
            };
            let timeout = if name == crate::computer_use::TOOL_NAME { Duration::from_secs(10 * 60) } else { Duration::from_secs(65) };
            let response = tokio::time::timeout(
                timeout,
                state.orchestrator.execute_native_app_tool_call(
                    session.thread_id,
                    session.session_instance_id,
                    &format!("mcp:{}", id.as_ref().expect("tools/call has a request id")),
                    name,
                    arguments,
                ),
            )
            .await;
            match response {
                Ok(Ok(value)) if name == crate::computer_use::TOOL_NAME => {
                    let body = crate::computer_use::mcp_result(value, false);
                    if body.to_string().len() > MAX_RESPONSE_BYTES / 2 {
                        tool_result("Tool result is too large. Narrow the request and retry.".into(), true)
                    } else {
                        body
                    }
                }
                Ok(Ok(value)) => tool_result(value.to_string(), false),
                Ok(Err(error)) => tool_result(bounded_text(&error.to_string(), 4096), true),
                Err(_) => tool_result("The tool request timed out. Inspect its operation ID before retrying.".into(), true),
            }
        }
        _ => return rpc_error(id, -32601, "Method is not supported", StatusCode::NOT_FOUND),
    };
    rpc_result(id.unwrap(), result, modern)
}

fn request_version(headers: &HeaderMap, method: &str, params: &Value) -> std::result::Result<bool, (i64, &'static str)> {
    let header_version = headers.get("mcp-protocol-version").and_then(|value| value.to_str().ok());
    let meta = params.get("_meta");
    let body_version = meta.and_then(|meta| meta.get("io.modelcontextprotocol/protocolVersion")).and_then(Value::as_str);
    let modern = header_version == Some(CURRENT_VERSION) || body_version == Some(CURRENT_VERSION) || method == "server/discover";
    if modern {
        if header_version != Some(CURRENT_VERSION) || body_version != Some(CURRENT_VERSION) {
            return Err((-32602, "Protocol version header and request metadata must agree"));
        }
        if !meta.and_then(|meta| meta.get("io.modelcontextprotocol/clientCapabilities")).is_some_and(Value::is_object) {
            return Err((-32602, "Client capabilities are required in request metadata"));
        }
        if headers.get("mcp-method").and_then(|value| value.to_str().ok()) != Some(method) {
            return Err((-32602, "Mcp-Method must match the request method"));
        }
        if method == "tools/call"
            && headers.get("mcp-name").and_then(|value| value.to_str().ok()) != params.get("name").and_then(Value::as_str)
        {
            return Err((-32602, "Mcp-Name must match the requested tool"));
        }
    } else if header_version.is_some_and(|version| !LEGACY_VERSIONS.contains(&version))
        || body_version.is_some_and(|version| !LEGACY_VERSIONS.contains(&version))
    {
        return Err((-32022, "Protocol version is not supported"));
    }
    Ok(modern)
}

fn tool_result(text: String, is_error: bool) -> Value {
    if text.len() > MAX_RESPONSE_BYTES / 2 {
        return json!({ "isError": true, "content": [{ "type": "text", "text": "Tool result is too large. Narrow the request and retry." }] });
    }
    json!({ "isError": is_error, "content": [{ "type": "text", "text": text }] })
}

fn server_info() -> Value {
    json!({ "name": "Kybern", "version": env!("CARGO_PKG_VERSION") })
}

fn rpc_result(id: Value, mut result: Value, modern: bool) -> Response {
    if modern {
        result["resultType"] = json!("complete");
        result["_meta"] = json!({ "io.modelcontextprotocol/serverInfo": server_info() });
    }
    let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    if response.to_string().len() > MAX_RESPONSE_BYTES {
        return rpc_error(
            response.get("id").cloned(),
            -32603,
            "Response is too large; narrow the request",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    no_store(Json(response).into_response())
}

fn rpc_error(id: Option<Value>, code: i64, message: &str, status: StatusCode) -> Response {
    let mut body = json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message } });
    if let Some(id) = id {
        body["id"] = id;
    }
    if code == -32022 {
        body["error"]["data"] = json!({ "supported": SUPPORTED_VERSIONS });
    }
    no_store((status, Json(body)).into_response())
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn bounded_text(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initialize_explains_effective_tools_before_discovery_without_widening_policy() {
        let root = std::env::temp_dir().join(format!("kybern-mcp-routing-test-{}", Uuid::new_v4()));
        let paths = crate::config::Paths::resolve(Some(root.clone())).unwrap();
        let state = AppState::initialize(&paths).unwrap();
        state.native_tools.set_endpoint("127.0.0.1:4199".parse().unwrap());
        for allow_spawn in [true, false] {
            let tools = ["kybern_thread_read", "kybern_collaboration_spawn"]
                .into_iter()
                .map(|name| NativeToolDefinition { name: name.into(), description: name.into(), input_schema: json!({"type":"object"}) })
                .collect();
            let restrictions = NativeToolRestrictions {
                denied_tools: if allow_spawn { vec![] } else { vec!["kybern_collaboration_spawn".into()] },
                ..Default::default()
            };
            let bridge = state.native_tools.register(Uuid::new_v4(), Uuid::new_v4(), tools, restrictions).unwrap();
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            headers.insert(header::AUTHORIZATION, format!("Bearer {}", bridge.authorization.as_deref().unwrap()).parse().unwrap());
            let response = handle(
                State(state.clone()),
                headers.clone(),
                Bytes::from(
                    json!({
                        "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
                            "protocolVersion":"2025-11-25", "capabilities":{}, "clientInfo":{"name":"fixture","version":"1"}
                        }
                    })
                    .to_string(),
                ),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), MAX_RESPONSE_BYTES).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            let instructions = body["result"]["instructions"].as_str().expect("MCP initialization must explain host routing");
            assert!(instructions.contains("kybern_thread_read"));
            assert_eq!(instructions.contains("kybern_collaboration_spawn"), allow_spawn);
            assert!(instructions.len() <= 400, "MCP metadata should stay brief");
            assert!(!instructions.contains(bridge.authorization.as_deref().unwrap()));
            let response = handle(
                State(state.clone()),
                headers,
                Bytes::from(
                    json!({
                        "jsonrpc":"2.0", "id":2, "method":"tools/list", "params":{}
                    })
                    .to_string(),
                ),
            )
            .await;
            let bytes = axum::body::to_bytes(response.into_body(), MAX_RESPONSE_BYTES).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            let names: Vec<_> = body["result"]["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
            assert!(names.contains(&"kybern_thread_read"));
            assert_eq!(names.contains(&"kybern_collaboration_spawn"), allow_spawn);
        }
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn session_replacement_revokes_old_credentials_without_revoking_the_replacement() {
        let gateway = NativeToolsGateway::default();
        gateway.set_endpoint("127.0.0.1:4199".parse().unwrap());
        let thread_id = Uuid::new_v4();
        let old_id = Uuid::new_v4();
        let old = gateway.register(thread_id, old_id, vec![], NativeToolRestrictions::default()).unwrap();
        let new_id = Uuid::new_v4();
        let new = gateway.register(thread_id, new_id, vec![], NativeToolRestrictions::default()).unwrap();
        assert!(gateway.authenticate(old.authorization.as_deref().unwrap()).is_none());
        gateway.revoke(old_id);
        assert!(gateway.authenticate(new.authorization.as_deref().unwrap()).is_some());
        gateway.revoke(new_id);
        assert!(gateway.authenticate(new.authorization.as_deref().unwrap()).is_none());
    }

    #[test]
    fn browser_origins_and_unregistered_tokens_cannot_use_native_capabilities() {
        let gateway = NativeToolsGateway::default();
        gateway.set_endpoint("127.0.0.1:4199".parse().unwrap());
        let bridge = gateway.register(Uuid::new_v4(), Uuid::new_v4(), vec![], NativeToolRestrictions::default()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, format!("Bearer {}", bridge.authorization.unwrap()).parse().unwrap());
        assert!(authorize(&gateway, &headers).is_ok());
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://untrusted.example"));
        assert!(matches!(authorize(&gateway, &headers), Err(StatusCode::FORBIDDEN)));
        headers.remove(header::ORIGIN);
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer normal-daemon-token"));
        assert!(matches!(authorize(&gateway, &headers), Err(StatusCode::UNAUTHORIZED)));
    }

    #[test]
    fn modern_requests_require_matching_per_request_metadata() {
        let mut headers = HeaderMap::new();
        headers.insert("mcp-protocol-version", HeaderValue::from_static(CURRENT_VERSION));
        headers.insert("mcp-method", HeaderValue::from_static("tools/call"));
        headers.insert("mcp-name", HeaderValue::from_static("inspect"));
        let mut params = json!({ "name": "inspect", "_meta": {
            "io.modelcontextprotocol/protocolVersion": CURRENT_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
        }});
        assert_eq!(request_version(&headers, "tools/call", &params), Ok(true));
        params["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("2025-11-25");
        assert!(request_version(&headers, "tools/call", &params).is_err());
        assert_eq!(request_version(&HeaderMap::new(), "initialize", &json!({ "protocolVersion": "2025-11-25" })), Ok(false));
    }
}
