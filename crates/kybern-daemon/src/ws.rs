//! WebSocket transport: authenticate the upgrade, then run one JSON-RPC
//! connection with its own subscription set.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use kybern_protocol::methods::scope_for;
use kybern_protocol::*;
use serde_json::Value;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::auth::{Principal, authenticate};
use crate::state::AppState;

pub async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let raw = headers
        .get(AUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::to_string)
        .or_else(|| query.get(AUTH_QUERY_PARAM).cloned());
    let Some(raw) = raw else {
        return (StatusCode::UNAUTHORIZED, "missing token").into_response();
    };
    let principal = match authenticate(&state.store, &raw) {
        Ok(Some(p)) => p,
        Ok(None) => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
        Err(e) => {
            tracing::error!(%e, "auth lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "auth failure").into_response();
        }
    };
    ws.on_upgrade(move |socket| run(state, socket, principal))
}

struct Subscription {
    thread_id: Option<ThreadId>,
    /// Live events at or below this seq were covered by replay and are skipped.
    floor_seq: EventSeq,
}

pub struct ConnectionCtx {
    pub id: Uuid,
    pub principal: Principal,
    subs: Mutex<HashMap<SubscriptionId, Subscription>>,
    terminal_subs: Mutex<HashMap<TerminalId, tokio::task::JoinHandle<()>>>,
    out: mpsc::Sender<ServerFrame>,
}

impl ConnectionCtx {
    pub async fn subscribe(&self, thread_id: Option<ThreadId>, head_seq: EventSeq) -> SubscriptionId {
        let id = Uuid::now_v7();
        self.subs.lock().await.insert(id, Subscription { thread_id, floor_seq: head_seq });
        id
    }

    pub async fn unsubscribe(&self, id: SubscriptionId) {
        self.subs.lock().await.remove(&id);
    }

    /// Forward a terminal's output to this connection until it exits or is unsubscribed.
    pub async fn subscribe_terminal(&self, terminal: Arc<crate::terminal::Terminal>, replay: bool) {
        use base64::Engine;
        let id = terminal.info().id;
        self.unsubscribe_terminal(id).await;
        let mut rx = terminal.events.subscribe();
        let out = self.out.clone();
        if replay {
            let data = terminal.scrollback();
            if !data.is_empty() {
                let params = serde_json::to_value(kybern_protocol::methods::TerminalOutputNotification { terminal_id: id, data: base64::engine::general_purpose::STANDARD.encode(&data) }).unwrap_or(Value::Null);
                let _ = out.send(ServerFrame::Notification(RpcNotification::new(kybern_protocol::methods::TERMINAL_OUTPUT_NOTIFICATION, params))).await;
            }
            if !terminal.info().alive {
                let params = serde_json::to_value(kybern_protocol::methods::TerminalExitedNotification { terminal_id: id, exit_code: terminal.info().exit_code }).unwrap_or(Value::Null);
                let _ = out.send(ServerFrame::Notification(RpcNotification::new(kybern_protocol::methods::TERMINAL_EXITED_NOTIFICATION, params))).await;
                return;
            }
        }
        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => match &*ev {
                        crate::terminal::TerminalEvent::Output(bytes) => {
                            let params = serde_json::to_value(kybern_protocol::methods::TerminalOutputNotification { terminal_id: id, data: base64::engine::general_purpose::STANDARD.encode(bytes) }).unwrap_or(Value::Null);
                            if out.send(ServerFrame::Notification(RpcNotification::new(kybern_protocol::methods::TERMINAL_OUTPUT_NOTIFICATION, params))).await.is_err() {
                                break;
                            }
                        }
                        crate::terminal::TerminalEvent::Exited(code) => {
                            let params = serde_json::to_value(kybern_protocol::methods::TerminalExitedNotification { terminal_id: id, exit_code: *code }).unwrap_or(Value::Null);
                            let _ = out.send(ServerFrame::Notification(RpcNotification::new(kybern_protocol::methods::TERMINAL_EXITED_NOTIFICATION, params))).await;
                            break;
                        }
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        self.terminal_subs.lock().await.insert(id, handle);
    }

    pub async fn unsubscribe_terminal(&self, id: TerminalId) {
        if let Some(h) = self.terminal_subs.lock().await.remove(&id) {
            h.abort();
        }
    }

    pub async fn replay(
        &self,
        state: &AppState,
        subscription_id: SubscriptionId,
        thread_id: Option<ThreadId>,
        after: EventSeq,
        head: EventSeq,
    ) -> anyhow::Result<()> {
        let mut cursor = after;
        while cursor < head {
            let store = state.store.clone();
            let batch = tokio::task::spawn_blocking(move || store.events_after(thread_id, cursor, 500)).await??;
            if batch.is_empty() {
                break;
            }
            for ev in batch {
                if ev.seq > head {
                    return Ok(());
                }
                cursor = ev.seq;
                self.send_event(subscription_id, ev).await;
            }
        }
        Ok(())
    }

    async fn send_event(&self, subscription_id: SubscriptionId, event: ThreadEvent) {
        let params = serde_json::to_value(EventNotification { subscription_id, event }).unwrap_or(Value::Null);
        let _ = self.out.send(ServerFrame::Notification(RpcNotification::new(EVENT_NOTIFICATION, params))).await;
    }

    async fn deliver_live(&self, ev: &ThreadEvent) {
        let targets: Vec<SubscriptionId> = {
            let subs = self.subs.lock().await;
            subs.iter()
                .filter(|(_, s)| s.thread_id.is_none_or(|t| t == ev.thread_id) && ev.seq > s.floor_seq)
                .map(|(id, _)| *id)
                .collect()
        };
        for id in targets {
            self.send_event(id, ev.clone()).await;
        }
    }
}

async fn run(state: AppState, socket: WebSocket, principal: Principal) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<ServerFrame>(1024);
    let ctx = Arc::new(ConnectionCtx { id: Uuid::now_v7(), principal, subs: Mutex::new(HashMap::new()), terminal_subs: Mutex::new(HashMap::new()), out: out_tx });
    let mut live = state.events.subscribe();
    tracing::info!(conn = %ctx.id, label = %ctx.principal.label, "client connected");

    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            let text = match serde_json::to_string(&frame) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    loop {
        tokio::select! {
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let state = state.clone();
                        let ctx = ctx.clone();
                        // Requests run concurrently so a slow provider call never blocks event delivery.
                        tokio::spawn(async move { handle_text(&state, &ctx, text.as_str()).await });
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { tracing::debug!(%e, "ws read error"); break; }
                }
            }
            ev = live.recv() => {
                match ev {
                    Ok(ev) => ctx.deliver_live(&ev).await,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(conn = %ctx.id, lagged = n, "client fell behind; asking it to resubscribe");
                        let _ = ctx.out.send(ServerFrame::Notification(RpcNotification::new("events.lagged", serde_json::json!({ "dropped": n })))).await;
                    }
                    Err(_) => break,
                }
            }
        }
    }
    for (_, h) in ctx.terminal_subs.lock().await.drain() {
        h.abort();
    }
    drop(ctx);
    writer.abort();
    tracing::info!("client disconnected");
}

async fn handle_text(state: &AppState, ctx: &Arc<ConnectionCtx>, text: &str) {
    let frame: ClientFrame = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => {
            let resp = RpcResponse::err(RpcId::Number(0), RpcError::new(codes::PARSE_ERROR, e.to_string()));
            let _ = ctx.out.send(ServerFrame::Response(resp)).await;
            return;
        }
    };
    let req = match frame {
        ClientFrame::Request(r) => r,
        ClientFrame::Notification(_) => return,
    };
    let result = match scope_for(&req.method) {
        None => Err(RpcError::method_not_found(&req.method)),
        Some(Some(scope)) if !ctx.principal.has(scope) => Err(RpcError::forbidden(scope.as_str())),
        Some(_) => crate::rpc::dispatch(state, ctx, &req.method, req.params).await,
    };
    let resp = match result {
        Ok(v) => RpcResponse::ok(req.id, v),
        Err(e) => RpcResponse::err(req.id, e),
    };
    let _ = ctx.out.send(ServerFrame::Response(resp)).await;
}
