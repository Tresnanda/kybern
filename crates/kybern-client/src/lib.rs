//! Minimal async JSON-RPC-over-WebSocket client for the kybern daemon.
//!
//! Runs on tokio. Notifications are delivered on an unbounded futures channel so
//! non-tokio executors (GPUI) can consume them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result, anyhow};
use futures::{SinkExt, StreamExt};
use kybern_protocol::methods::Method;
use kybern_protocol::*;
use serde_json::Value;
use tokio::sync::{Mutex, mpsc, oneshot};
use futures::channel::mpsc as fmpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

pub struct Client {
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<RpcResponse>>>>,
    out: mpsc::Sender<String>,
    pub notifications: Mutex<fmpsc::UnboundedReceiver<RpcNotification>>,
    /// Set when the socket closes.
    pub closed: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

impl Endpoint {
    pub fn data_dir(override_dir: Option<PathBuf>) -> Option<PathBuf> {
        override_dir.or_else(|| directories::BaseDirs::new().map(|b| b.home_dir().join(".kybern")))
    }

    /// Resolve from flags, env, or the local daemon's files under ~/.kybern.
    pub fn resolve(url: Option<String>, token: Option<String>, data_dir: Option<PathBuf>) -> Result<Self> {
        let root = Self::data_dir(data_dir);
        let token = match token.or_else(|| std::env::var("KYBERN_TOKEN").ok()) {
            Some(t) => t,
            None => {
                let path = root.as_ref().context("no home dir")?.join("daemon.token");
                std::fs::read_to_string(&path)
                    .with_context(|| format!("no token at {}; is kybernd running?", path.display()))?
                    .trim()
                    .to_string()
            }
        };
        let url = match url.or_else(|| std::env::var("KYBERN_URL").ok()) {
            Some(u) => u,
            None => {
                let port = root
                    .as_ref()
                    .and_then(|r| std::fs::read_to_string(r.join("daemon.port")).ok())
                    .and_then(|p| p.trim().parse::<u16>().ok())
                    .unwrap_or(DEFAULT_PORT);
                format!("ws://127.0.0.1:{port}/ws")
            }
        };
        Ok(Self { url, token })
    }
}

impl Client {
    pub async fn connect(ep: &Endpoint) -> Result<Self> {
        let mut req = ep.url.as_str().into_client_request()?;
        req.headers_mut().insert(AUTHORIZATION, format!("Bearer {}", ep.token).parse()?);
        let (ws, _) = tokio_tungstenite::connect_async(req).await.with_context(|| format!("connect {}", ep.url))?;
        let (mut sink, mut stream) = ws.split();

        let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
        tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                if sink.send(tokio_tungstenite::tungstenite::Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<RpcResponse>>>> = Arc::new(Mutex::new(HashMap::new()));
        let (note_tx, note_rx) = fmpsc::unbounded::<RpcNotification>();
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed2 = closed.clone();
        let p2 = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let text = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => t,
                    tokio_tungstenite::tungstenite::Message::Close(_) => break,
                    _ => continue,
                };
                match serde_json::from_str::<ServerFrame>(&text) {
                    Ok(ServerFrame::Response(resp)) => {
                        if let RpcId::Number(n) = resp.id {
                            if let Some(tx) = p2.lock().await.remove(&n) {
                                let _ = tx.send(resp);
                            }
                        }
                    }
                    Ok(ServerFrame::Notification(n)) => {
                        let _ = note_tx.unbounded_send(n);
                    }
                    Err(e) => tracing::warn!("bad frame from daemon: {e}"),
                }
            }
            closed2.store(true, std::sync::atomic::Ordering::Relaxed);
            for (_, tx) in p2.lock().await.drain() {
                let _ = tx.send(RpcResponse::err(RpcId::Number(0), RpcError::internal("connection closed")));
            }
        });

        Ok(Self { next_id: AtomicI64::new(1), pending, out: out_tx, notifications: Mutex::new(note_rx), closed })
    }

    pub async fn call_raw(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let req = RpcRequest::new(RpcId::Number(id), method, params);
        tracing::debug!(id, method, "rpc ->");
        self.out.send(serde_json::to_string(&req)?).await.map_err(|_| anyhow!("connection closed"))?;
        let resp = rx.await.map_err(|_| anyhow!("connection closed before response"))?;
        tracing::debug!(id, method, ok = resp.error.is_none(), "rpc <-");
        match (resp.result, resp.error) {
            (Some(v), _) => Ok(v),
            (None, Some(e)) => Err(anyhow!("{} (code {})", e.message, e.code)),
            (None, None) => Ok(Value::Null),
        }
    }

    pub async fn call<M: Method>(&self, params: M::Params) -> Result<M::Result> {
        let v = self.call_raw(M::NAME, serde_json::to_value(params)?).await?;
        Ok(serde_json::from_value(v)?)
    }
}
