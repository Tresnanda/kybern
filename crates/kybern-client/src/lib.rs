//! Minimal async JSON-RPC-over-WebSocket client for the kybern daemon.
//!
//! Runs on tokio. Notifications are delivered on an unbounded futures channel so
//! non-tokio executors (GPUI) can consume them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result, anyhow};
use futures::channel::mpsc as fmpsc;
use futures::{SinkExt, StreamExt};
use kybern_protocol::methods::Method;
use kybern_protocol::*;
use serde_json::Value;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

pub mod address;
pub mod pairing;

pub struct Client {
    tasks: [tokio::task::JoinHandle<()>; 2],
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
        let url = url.or_else(|| std::env::var("KYBERN_URL").ok());
        let token = token.or_else(|| std::env::var("KYBERN_TOKEN").ok());
        if url.is_some() && token.is_none() {
            return Err(anyhow!("An explicit environment address requires --token or KYBERN_TOKEN; pair a device on that environment"));
        }
        let explicit_dir = data_dir.is_some();
        let root = Self::data_dir(data_dir);
        let token = match token {
            Some(t) => t,
            None => {
                let path = root.as_ref().context("no home dir")?.join("daemon.token");
                std::fs::read_to_string(&path)
                    .with_context(|| format!("no token at {}; is kybernd running?", path.display()))?
                    .trim()
                    .to_string()
            }
        };
        let url = match url {
            Some(u) => u,
            None => {
                let recorded = root
                    .as_ref()
                    .and_then(|r| std::fs::read_to_string(r.join("daemon.port")).ok())
                    .and_then(|p| p.trim().parse::<u16>().ok());
                // A data directory the caller named is that daemon or none: without its port file (it
                // stopped, e.g. for `kybern machines rejoin`) the default port may be another daemon.
                let port = match recorded {
                    Some(port) => port,
                    None if explicit_dir => return Err(anyhow!(stopped_message(root.as_deref()))),
                    None => DEFAULT_PORT,
                };
                let bound = root
                    .as_ref()
                    .and_then(|root| std::fs::read_to_string(root.join("daemon.listen")).ok())
                    .and_then(|value| value.trim().parse::<std::net::SocketAddr>().ok())
                    .filter(|addr| addr.port() == port);
                local_listener_url(bound, port)
            }
        };
        Ok(Self { url: address::normalize(&url)?, token })
    }
}

/// What to tell someone whose `--data-dir` names a daemon that is not running.
pub fn stopped_message(data_dir: Option<&std::path::Path>) -> String {
    let at = data_dir.map(|dir| format!(" at {}", dir.display())).unwrap_or_default();
    format!("the daemon{at} is not running (it stops for `kybern machines rejoin`); start it again, then retry")
}

fn local_listener_url(bound: Option<std::net::SocketAddr>, port: u16) -> String {
    let mut bound = bound.unwrap_or_else(|| std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    if bound.ip().is_unspecified() {
        bound.set_ip(if bound.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
    }
    format!("ws://{bound}/ws")
}

impl Client {
    pub async fn connect(ep: &Endpoint) -> Result<Self> {
        let mut req = ep.url.as_str().into_client_request()?;
        req.headers_mut().insert(AUTHORIZATION, format!("Bearer {}", ep.token).parse()?);
        let (ws, _) = tokio_tungstenite::connect_async(req).await.with_context(|| format!("connect {}", ep.url))?;
        let (mut sink, mut stream) = ws.split();

        let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
        let writer = tokio::spawn(async move {
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
        let reader = tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let text = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => t,
                    tokio_tungstenite::tungstenite::Message::Close(_) => break,
                    _ => continue,
                };
                match serde_json::from_str::<ServerFrame>(&text) {
                    Ok(ServerFrame::Response(resp)) => {
                        if let RpcId::Number(n) = resp.id
                            && let Some(tx) = p2.lock().await.remove(&n)
                        {
                            let _ = tx.send(resp);
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

        Ok(Self { tasks: [writer, reader], next_id: AtomicI64::new(1), pending, out: out_tx, notifications: Mutex::new(note_rx), closed })
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

impl Drop for Client {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[cfg(test)]
mod listener_tests {
    use super::local_listener_url;
    #[test]
    fn resolves_specific_private_and_ipv6_listeners_and_legacy_port_files() {
        assert_eq!(local_listener_url(Some("100.101.102.103:4173".parse().unwrap()), 4173), "ws://100.101.102.103:4173/ws");
        assert_eq!(local_listener_url(Some("[::]:4173".parse().unwrap()), 4173), "ws://[::1]:4173/ws");
        assert_eq!(local_listener_url(Some("0.0.0.0:4173".parse().unwrap()), 4173), "ws://127.0.0.1:4173/ws");
        assert_eq!(local_listener_url(None, 4199), "ws://127.0.0.1:4199/ws");
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::Endpoint;

    fn data_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-client-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_named_data_dir_without_a_port_file_never_falls_back_to_the_default_port() {
        let dir = data_dir("stopped");
        std::fs::write(dir.join("daemon.token"), "token\n").unwrap();
        let error = Endpoint::resolve(None, None, Some(dir.clone())).unwrap_err().to_string();
        assert!(error.contains("is not running") && error.contains(&dir.display().to_string()), "{error}");
        std::fs::write(dir.join("daemon.port"), "4555\n").unwrap();
        assert_eq!(Endpoint::resolve(None, None, Some(dir.clone())).unwrap().url, "ws://127.0.0.1:4555/ws");
        // An explicit URL is used as given.
        let explicit = Endpoint::resolve(Some("ws://127.0.0.1:4600/ws".into()), Some("t".into()), Some(dir.clone())).unwrap();
        assert_eq!(explicit.url, "ws://127.0.0.1:4600/ws");
        let _ = std::fs::remove_dir_all(dir);
    }
}
