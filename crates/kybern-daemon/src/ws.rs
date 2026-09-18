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
    if headers.contains_key(axum::http::header::ORIGIN) && crate::http::allowed_asset_origin(&headers).is_none() {
        return (StatusCode::FORBIDDEN, "origin cannot connect").into_response();
    }
    let raw = headers
        .get(AUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::to_string)
        .or_else(|| query.get(AUTH_QUERY_PARAM).cloned());
    let authentication = if let Some(ticket) = query.get("ticket") {
        state.tickets.redeem(&state.store, ticket)
    } else if let Some(raw) = raw {
        authenticate(&state.store, &raw)
    } else {
        return (StatusCode::UNAUTHORIZED, "missing credential").into_response();
    };
    let principal = match authentication {
        Ok(Some(p)) => p,
        Ok(None) => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
        Err(e) => {
            tracing::error!(%e, "auth lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "auth failure").into_response();
        }
    };
    ws.on_upgrade(move |socket| run(state, socket, principal))
}

/// Serialized output owns permits until the socket write completes. One
/// oversized response may use the whole budget, so history is never truncated.
const OUTBOX_BYTES: usize = 8 * 1024 * 1024;
struct QueuedFrame {
    text: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

#[derive(Clone)]
struct Outbox {
    sender: mpsc::Sender<QueuedFrame>,
    budget: Arc<tokio::sync::Semaphore>,
    closed: tokio_util::sync::CancellationToken,
}

// Internal serialization-only envelopes. Public wire/schema types stay unchanged.
// These typed notifications always have object params; null-param notifications
// keep using RpcNotification so its skip-null behavior is preserved.
#[derive(serde::Serialize)]
struct TypedNotification<P> {
    jsonrpc: JsonRpcVersion,
    method: &'static str,
    params: P,
}

#[derive(serde::Serialize)]
struct BorrowedEventNotification<'a> {
    subscription_id: SubscriptionId,
    event: &'a ThreadEvent,
}

/// Build the small event sent to clients that opt into lazy tool outputs.
/// Constructing a fresh `ThreadEvent` here intentionally copies only scalar
/// metadata and the call id. Cloning the original `Value` before serialization
/// would briefly retain a second copy of a large result, defeating the point
/// of compact delivery.
fn compact_tool_completion(event: &ThreadEvent) -> Option<ThreadEvent> {
    let EventPayload::ToolCallCompleted { tool_call_id, output, output_omitted, is_error } = &event.payload else {
        return None;
    };
    if *output_omitted || !kybern_store::should_omit_tool_output(output) {
        return None;
    }
    Some(ThreadEvent {
        seq: event.seq,
        thread_id: event.thread_id,
        turn_id: event.turn_id,
        at: event.at,
        payload: EventPayload::ToolCallCompleted {
            tool_call_id: tool_call_id.clone(),
            output: Value::Null,
            output_omitted: true,
            is_error: *is_error,
        },
    })
}

impl Outbox {
    async fn notify(&self, method: &'static str, params: impl serde::Serialize) -> Result<(), ()> {
        self.send(TypedNotification { jsonrpc: JsonRpcVersion, method, params }).await
    }

    async fn send(&self, frame: impl serde::Serialize) -> Result<(), ()> {
        struct Count(usize);
        impl std::io::Write for Count {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self.0.saturating_add(bytes.len());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut size = Count(0);
        serde_json::to_writer(&mut size, &frame).map_err(|_| ())?;
        let send = async {
            let permit = self.budget.clone().acquire_many_owned(size.0.clamp(1, OUTBOX_BYTES) as u32).await.map_err(|_| ())?;
            let text = serde_json::to_string(&frame).map_err(|_| ())?;
            self.sender.send(QueuedFrame { text, _permit: permit }).await.map_err(|_| ())
        };
        tokio::select! {
            _ = self.closed.cancelled() => Err(()),
            result = tokio::time::timeout(std::time::Duration::from_secs(30), send) => match result {
                Ok(result) => result,
                Err(_) => { self.closed.cancel(); Err(()) }
            }
        }
    }
}

struct Subscription {
    thread_id: Option<ThreadId>,
    /// Live events at or below this seq were covered by replay and are skipped.
    floor_seq: EventSeq,
    /// Whether completed tool outputs should be included in the wire event.
    include_tool_output: bool,
}

pub struct ConnectionCtx {
    pub id: Uuid,
    pub principal: Principal,
    /// A replay is a single ordered delivery operation. Live events stay in
    /// the broadcast receiver until acknowledgment and replay are enqueued.
    delivery: Mutex<()>,
    subs: Mutex<HashMap<SubscriptionId, Subscription>>,
    terminal_subs: Mutex<HashMap<TerminalId, tokio::task::JoinHandle<()>>>,
    out: Outbox,
}

impl ConnectionCtx {
    pub async fn subscribe(&self, thread_id: Option<ThreadId>, head_seq: EventSeq, include_tool_output: bool) -> SubscriptionId {
        let id = Uuid::now_v7();
        self.subs.lock().await.insert(id, Subscription { thread_id, floor_seq: head_seq, include_tool_output });
        id
    }

    pub async fn unsubscribe(&self, id: SubscriptionId) {
        self.subs.lock().await.remove(&id);
    }

    async fn establish_subscription(&self, state: &AppState, request_id: RpcId, params: Value) {
        use kybern_protocol::methods::{EventsSubscribeParams, EventsSubscribeResult};
        let params: EventsSubscribeParams = match serde_json::from_value(if params.is_null() { serde_json::json!({}) } else { params }) {
            Ok(params) => params,
            Err(e) => {
                let _ = self.out.send(ServerFrame::Response(RpcResponse::err(request_id, RpcError::invalid_params(e.to_string())))).await;
                return;
            }
        };
        let _delivery = self.delivery.lock().await;
        let head_seq = match state.store.events_head_seq() {
            Ok(head) => head,
            Err(e) => {
                let _ = self.out.send(ServerFrame::Response(RpcResponse::err(request_id, RpcError::internal(e.to_string())))).await;
                return;
            }
        };
        if params.after_seq.is_some_and(|after| after > head_seq) {
            let _ = self
                .out
                .send(ServerFrame::Response(RpcResponse::err(
                    request_id,
                    RpcError::invalid_params("Event cursor is ahead of this environment"),
                )))
                .await;
            return;
        }
        let include_tool_output = params.include_tool_output.unwrap_or(true);
        let subscription_id = self.subscribe(params.thread_id, head_seq, include_tool_output).await;
        let result = serde_json::to_value(EventsSubscribeResult { subscription_id, head_seq, replay_ready: true }).unwrap();
        if self.out.send(ServerFrame::Response(RpcResponse::ok(request_id, result))).await.is_err() {
            return;
        }
        if let Some(after) = params.after_seq
            && self.replay(state, subscription_id, params.thread_id, after, head_seq, include_tool_output).await.is_err()
        {
            let _ =
                self.out.send(ServerFrame::Notification(RpcNotification::new("events.lagged", serde_json::json!({ "dropped": 0 })))).await;
            return;
        }
        let ready = kybern_protocol::EventsReadyNotification { subscription_id, head_seq };
        let _ = self.out.notify(kybern_protocol::EVENTS_READY_NOTIFICATION, ready).await;
    }

    /// Forward a terminal's output to this connection until it exits or is unsubscribed.
    pub async fn subscribe_terminal(&self, terminal: Arc<crate::terminal::Terminal>, replay: bool) {
        use base64::Engine;
        let id = terminal.info().id;
        self.unsubscribe_terminal(id).await;
        let (mut rx, data) = terminal.subscribe_output(replay);
        let replay_data = (replay && !data.is_empty()).then(|| base64::engine::general_purpose::STANDARD.encode(&data));
        // The terminal's own ring stays intact. Release only this owned replay copy
        // before a slow socket can make the serialized notification wait.
        drop(data);
        let out = self.out.clone();
        if replay {
            if let Some(data) = replay_data {
                let params = kybern_protocol::methods::TerminalOutputNotification { terminal_id: id, data };
                let _ = out.notify(kybern_protocol::methods::TERMINAL_OUTPUT_NOTIFICATION, params).await;
            }
            if !terminal.info().alive {
                let params = kybern_protocol::methods::TerminalExitedNotification { terminal_id: id, exit_code: terminal.info().exit_code };
                let _ = out.notify(kybern_protocol::methods::TERMINAL_EXITED_NOTIFICATION, params).await;
                return;
            }
        }
        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => match &*ev {
                        crate::terminal::TerminalEvent::Output(bytes) => {
                            let params = kybern_protocol::methods::TerminalOutputNotification {
                                terminal_id: id,
                                data: base64::engine::general_purpose::STANDARD.encode(bytes),
                            };
                            if out.notify(kybern_protocol::methods::TERMINAL_OUTPUT_NOTIFICATION, params).await.is_err() {
                                break;
                            }
                        }
                        crate::terminal::TerminalEvent::Exited(code) => {
                            let params = kybern_protocol::methods::TerminalExitedNotification { terminal_id: id, exit_code: *code };
                            let _ = out.notify(kybern_protocol::methods::TERMINAL_EXITED_NOTIFICATION, params).await;
                            break;
                        }
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = out
                            .send(ServerFrame::Notification(RpcNotification::new(
                                "terminal.lagged",
                                serde_json::json!({ "terminal_id": id }),
                            )))
                            .await;
                        break;
                    }
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
        include_tool_output: bool,
    ) -> anyhow::Result<()> {
        let mut cursor = after;
        while cursor < head {
            let store = state.store.clone();
            let batch = tokio::task::spawn_blocking(move || store.events_after_bounded(thread_id, cursor, 500, 2 * 1024 * 1024)).await??;
            if batch.is_empty() {
                break;
            }
            for ev in batch {
                if ev.seq > head {
                    return Ok(());
                }
                cursor = ev.seq;
                self.send_event(subscription_id, &ev, include_tool_output).await;
            }
        }
        Ok(())
    }

    async fn send_event(&self, subscription_id: SubscriptionId, event: &ThreadEvent, include_tool_output: bool) {
        if !include_tool_output && let Some(compact) = compact_tool_completion(event) {
            let params = BorrowedEventNotification { subscription_id, event: &compact };
            let _ = self.out.notify(EVENT_NOTIFICATION, params).await;
            return;
        }
        let params = BorrowedEventNotification { subscription_id, event };
        let _ = self.out.notify(EVENT_NOTIFICATION, params).await;
    }

    async fn deliver_live(&self, ev: &ThreadEvent) {
        let _delivery = self.delivery.lock().await;
        let targets: Vec<(SubscriptionId, bool)> = {
            let subs = self.subs.lock().await;
            subs.iter()
                .filter(|(_, s)| s.thread_id.is_none_or(|t| t == ev.thread_id) && ev.seq > s.floor_seq)
                .map(|(id, s)| (*id, s.include_tool_output))
                .collect()
        };
        for (id, include_tool_output) in targets {
            self.send_event(id, ev, include_tool_output).await;
        }
    }
}

/// Counts one open connection for the idle-exit decision; released on drop so
/// every exit path, including panics, is covered.
struct ConnectionSlot(AppState);

impl ConnectionSlot {
    fn claim(state: &AppState) -> Self {
        state.connections.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // A client arriving ends any idle stretch at once, without waiting for a sweep.
        *state.idle_since.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        Self(state.clone())
    }
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn run(state: AppState, socket: WebSocket, principal: Principal) {
    let _slot = ConnectionSlot::claim(&state);
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<QueuedFrame>(64);
    let closed = tokio_util::sync::CancellationToken::new();
    let requests = Arc::new(tokio::sync::Semaphore::new(16));
    let ctx = Arc::new(ConnectionCtx {
        id: Uuid::now_v7(),
        principal,
        delivery: Mutex::new(()),
        subs: Mutex::new(HashMap::new()),
        terminal_subs: Mutex::new(HashMap::new()),
        out: Outbox { sender: out_tx, budget: Arc::new(tokio::sync::Semaphore::new(OUTBOX_BYTES)), closed: closed.clone() },
    });
    let mut live = state.events.subscribe();
    let mut revoked = state.revoked_tokens.subscribe();
    if !state.store.token_is_active(ctx.principal.token_id).unwrap_or(false) {
        return;
    }
    tracing::info!(conn = %ctx.id, label = %ctx.principal.label, "client connected");

    let writer_closed = closed.clone();
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if sink.send(Message::Text(frame.text.into())).await.is_err() {
                break;
            }
        }
        writer_closed.cancel();
        let _ = sink.close().await;
    });

    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = closed.cancelled() => break,
            notice = revoked.recv() => {
                if matches!(notice, Ok(id) if id == ctx.principal.token_id)
                    || !state.store.token_is_active(ctx.principal.token_id).unwrap_or(false)
                { break; }
            }
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let state = state.clone();
                        let ctx = ctx.clone();
                        // Bound producers as well as queued bytes. Do not make a
                        // saturated RPC lane block event/approval delivery.
                        if let Ok(permit) = requests.clone().try_acquire_owned() {
                            tokio::spawn(async move {
                                let _permit = permit;
                                handle_text(&state, &ctx, text.as_str()).await;
                            });
                        } else if let Ok(ClientFrame::Request(request)) = serde_json::from_str(text.as_str()) {
                            let _ = ctx.out.send(ServerFrame::Response(RpcResponse::err(request.id,
                                RpcError::internal("Too many concurrent requests; retry after pending requests finish")))).await;
                        }
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
    closed.cancel();
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
    if !state.store.token_is_active(ctx.principal.token_id).unwrap_or(false) {
        let _ = ctx
            .out
            .send(ServerFrame::Response(RpcResponse::err(req.id, RpcError::new(codes::UNAUTHORIZED, "Device access was revoked"))))
            .await;
        return;
    }
    if req.method == "events.subscribe" && ctx.principal.has(Scope::OrchestrationRead) {
        ctx.establish_subscription(state, req.id, req.params).await;
        return;
    }
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

#[cfg(test)]
mod memory_tests {
    use super::*;
    #[tokio::test]
    async fn oversized_frame_holds_budget_until_writer_releases_it_and_cancel_wakes_waiters() {
        let (sender, mut receiver) = mpsc::channel(64);
        let out = Outbox {
            sender,
            budget: Arc::new(tokio::sync::Semaphore::new(OUTBOX_BYTES)),
            closed: tokio_util::sync::CancellationToken::new(),
        };
        let frame = || ServerFrame::Notification(RpcNotification::new("test", serde_json::json!({"data": "x".repeat(OUTBOX_BYTES + 1)})));
        out.send(frame()).await.unwrap();
        assert_eq!(out.budget.available_permits(), 0);
        let received = receiver.recv().await.unwrap();
        assert!(received.text.len() > OUTBOX_BYTES);
        assert_eq!(out.budget.available_permits(), 0);
        let waiting = {
            let out = out.clone();
            tokio::spawn(async move { out.send(ServerFrame::Notification(RpcNotification::new("next", Value::Null))).await })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(received);
        waiting.await.unwrap().unwrap();
        drop(receiver.recv().await.unwrap());
        assert_eq!(out.budget.available_permits(), OUTBOX_BYTES);
        out.send(frame()).await.unwrap();
        let waiting = {
            let out = out.clone();
            tokio::spawn(async move { out.send(ServerFrame::Notification(RpcNotification::new("next", Value::Null))).await })
        };
        out.closed.cancel();
        assert!(waiting.await.unwrap().is_err());
    }
}

#[cfg(test)]
mod typed_notification_memory_tests {
    use super::*;

    fn event(output: Value) -> ThreadEvent {
        ThreadEvent {
            seq: 17,
            thread_id: ThreadId::nil(),
            turn_id: Some(TurnId::nil()),
            at: "2026-09-17T00:00:00Z".parse().unwrap(),
            payload: EventPayload::ToolCallCompleted { tool_call_id: "a:b\n\0é".into(), output, output_omitted: false, is_error: false },
        }
    }

    fn assert_typed_wire<T: serde::Serialize>(method: &'static str, params: T) {
        let old = ServerFrame::Notification(RpcNotification::new(method, serde_json::to_value(&params).unwrap()));
        let new = TypedNotification { jsonrpc: JsonRpcVersion, method, params };
        assert_eq!(serde_json::to_string(&new).unwrap(), serde_json::to_string(&old).unwrap());
    }

    #[test]
    fn borrowed_event_matches_owned_notification_wire_bytes() {
        for output in
            [Value::Null, serde_json::json!([null, true, -3, 0.125, "😀\n\"\\\0"]), serde_json::json!({ "long": "x".repeat(1024 * 1024) })]
        {
            let event = event(output);
            for turn_id in [None, Some(TurnId::nil())] {
                let event = ThreadEvent { turn_id, ..event.clone() };
                let params = BorrowedEventNotification { subscription_id: SubscriptionId::nil(), event: &event };
                let old = ServerFrame::Notification(RpcNotification::new(
                    EVENT_NOTIFICATION,
                    serde_json::to_value(EventNotification { subscription_id: SubscriptionId::nil(), event: event.clone() }).unwrap(),
                ));
                let new = TypedNotification { jsonrpc: JsonRpcVersion, method: EVENT_NOTIFICATION, params };
                let wire = serde_json::to_string(&new).unwrap();
                assert_eq!(wire, serde_json::to_string(&old).unwrap());
                assert!(matches!(serde_json::from_str::<ServerFrame>(&wire).unwrap(), ServerFrame::Notification(_)));
            }
        }
    }

    #[test]
    fn compact_subscription_event_replaces_only_large_completion_payload() {
        let original = event(serde_json::json!({ "long": "x".repeat(kybern_store::LARGE_TOOL_OUTPUT_BYTES + 1) }));
        let compact = compact_tool_completion(&original).expect("large completion should be compacted");
        let EventPayload::ToolCallCompleted { output, output_omitted, tool_call_id, is_error } = &compact.payload else {
            panic!("expected tool completion")
        };
        assert_eq!(tool_call_id, "a:b\n\0é");
        assert_eq!(output, &Value::Null);
        assert!(*output_omitted);
        assert!(!is_error);
        assert!(serde_json::to_string(&compact).unwrap().len() < 512);

        let small = event(serde_json::json!("ok"));
        assert!(compact_tool_completion(&small).is_none());
        let full_wire = serde_json::to_value(&small.payload).unwrap();
        assert!(full_wire.get("output_omitted").is_none(), "legacy full wire stays unchanged");
    }

    #[test]
    fn typed_ready_and_terminal_notifications_preserve_wire_fields() {
        use kybern_protocol::methods::*;
        assert_typed_wire(EVENTS_READY_NOTIFICATION, EventsReadyNotification { subscription_id: SubscriptionId::nil(), head_seq: 123 });
        assert_typed_wire(
            TERMINAL_OUTPUT_NOTIFICATION,
            TerminalOutputNotification { terminal_id: TerminalId::nil(), data: "AAECAw==".into() },
        );
        assert_typed_wire(TERMINAL_EXITED_NOTIFICATION, TerminalExitedNotification { terminal_id: TerminalId::nil(), exit_code: None });
        assert_typed_wire(TERMINAL_EXITED_NOTIFICATION, TerminalExitedNotification { terminal_id: TerminalId::nil(), exit_code: Some(2) });
    }

    #[tokio::test]
    async fn queued_wire_owns_data_after_borrowed_source_drops() {
        let (sender, mut receiver) = mpsc::channel(1);
        let out = Outbox {
            sender,
            budget: Arc::new(tokio::sync::Semaphore::new(OUTBOX_BYTES)),
            closed: tokio_util::sync::CancellationToken::new(),
        };
        {
            let event = event(serde_json::json!({ "preserved": "😀\n" }));
            out.notify(EVENT_NOTIFICATION, BorrowedEventNotification { subscription_id: SubscriptionId::nil(), event: &event })
                .await
                .unwrap();
        }
        let queued = receiver.recv().await.unwrap();
        let wire: Value = serde_json::from_str(&queued.text).unwrap();
        assert_eq!(wire["params"]["event"]["output"]["preserved"], "😀\n");
        assert_eq!(out.budget.available_permits(), OUTBOX_BYTES - queued.text.len());
        drop(queued);
        assert_eq!(out.budget.available_permits(), OUTBOX_BYTES);
    }

    #[tokio::test]
    async fn typed_large_frames_obey_existing_budget_and_cancellation() {
        use kybern_protocol::methods::*;
        let (sender, mut receiver) = mpsc::channel(1);
        let out = Outbox {
            sender,
            budget: Arc::new(tokio::sync::Semaphore::new(OUTBOX_BYTES)),
            closed: tokio_util::sync::CancellationToken::new(),
        };
        out.notify(
            TERMINAL_OUTPUT_NOTIFICATION,
            TerminalOutputNotification { terminal_id: TerminalId::nil(), data: "x".repeat(OUTBOX_BYTES + 1) },
        )
        .await
        .unwrap();
        let queued = receiver.recv().await.unwrap();
        assert!(queued.text.len() > OUTBOX_BYTES);
        assert_eq!(out.budget.available_permits(), 0);
        let waiting = {
            let out = out.clone();
            tokio::spawn(async move {
                out.notify(TERMINAL_OUTPUT_NOTIFICATION, TerminalOutputNotification { terminal_id: TerminalId::nil(), data: "next".into() })
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        out.closed.cancel();
        assert!(waiting.await.unwrap().is_err());
        drop(queued);
        assert_eq!(out.budget.available_permits(), OUTBOX_BYTES);
        assert!(receiver.try_recv().is_err());
    }
}
