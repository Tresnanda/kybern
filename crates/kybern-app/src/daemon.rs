//! Bridge between GPUI and the daemon: a dedicated tokio runtime owns the
//! WebSocket; GPUI awaits runtime-agnostic futures and drains notifications.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use kybern_client::{Client, Endpoint};
use kybern_protocol::methods::Method;
use kybern_protocol::*;
use serde_json::Value;

pub struct Daemon {
    rt: tokio::runtime::Runtime,
    client: Arc<Client>,
    pub endpoint: Endpoint,
}

impl Daemon {
    /// Connect to the local daemon, starting one if nothing is listening.
    pub fn connect_or_spawn() -> Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().thread_name("kybern-io").build()?;
        let endpoint = match Endpoint::resolve(None, None, None) {
            Ok(ep) => ep,
            Err(_) => {
                spawn_daemon()?;
                wait_for_token()?
            }
        };
        let client = match rt.block_on(Client::connect(&endpoint)) {
            Ok(c) => c,
            Err(first) => {
                tracing::info!(%first, "daemon not reachable; starting kybernd");
                spawn_daemon()?;
                let endpoint = wait_for_token()?;
                let mut last = None;
                let mut client = None;
                for _ in 0..50 {
                    match rt.block_on(Client::connect(&endpoint)) {
                        Ok(c) => {
                            client = Some(c);
                            break;
                        }
                        Err(e) => {
                            last = Some(e);
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                    }
                }
                client.ok_or_else(|| anyhow!("could not reach kybernd: {}", last.map(|e| e.to_string()).unwrap_or_default()))?
            }
        };
        Ok(Self { rt, client: Arc::new(client), endpoint })
    }

    pub fn call<M: Method>(&self, params: M::Params) -> impl std::future::Future<Output = Result<M::Result>> + Send + 'static
    where
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        let client = self.client.clone();
        let _guard = self.rt.enter();
        async move { client.call::<M>(params).await }
    }

    pub fn call_raw(&self, method: &str, params: Value) -> impl std::future::Future<Output = Result<Value>> + Send + 'static {
        let client = self.client.clone();
        let method = method.to_string();
        async move { client.call_raw(&method, params).await }
    }

    /// Take the notification stream. Call once.
    pub fn take_notifications(&self) -> UnboundedReceiver<RpcNotification> {
        let mut guard = self.rt.block_on(self.client.notifications.lock());
        let (_, empty) = futures::channel::mpsc::unbounded();
        std::mem::replace(&mut *guard, empty)
    }

    pub fn is_closed(&self) -> bool {
        self.client.closed.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Turn a notification into a typed thread event, if it is one.
pub fn as_thread_event(n: &RpcNotification) -> Option<EventNotification> {
    if n.method != EVENT_NOTIFICATION {
        return None;
    }
    serde_json::from_value(n.params.clone()).ok()
}

fn daemon_binary() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().context("exe dir")?;
    for name in ["kybernd", "kybernd.exe"] {
        let p = dir.join(name);
        if p.is_file() {
            return Ok(p);
        }
    }
    which_in_path("kybernd").ok_or_else(|| anyhow!("kybernd not found next to the app or on PATH"))
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file())
    })
}

fn spawn_daemon() -> Result<()> {
    let bin = daemon_binary()?;
    let log = Endpoint::data_dir(None).map(|d| d.join("daemon.log"));
    if let Some(l) = &log {
        std::fs::create_dir_all(l.parent().unwrap())?;
    }
    let mut cmd = std::process::Command::new(&bin);
    cmd.stdin(std::process::Stdio::null());
    match log.and_then(|l| std::fs::File::create(l).ok()) {
        Some(f) => {
            let f2 = f.try_clone()?;
            cmd.stdout(f).stderr(f2);
        }
        None => {
            cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().with_context(|| format!("start {}", bin.display()))?;
    tracing::info!(bin = %bin.display(), "started kybernd");
    Ok(())
}

fn wait_for_token() -> Result<Endpoint> {
    for _ in 0..100 {
        if let Ok(ep) = Endpoint::resolve(None, None, None) {
            return Ok(ep);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(anyhow!("kybernd did not write its token in time"))
}

/// Drain notifications on the GPUI executor, invoking `f` for each.
pub async fn pump(mut rx: UnboundedReceiver<RpcNotification>, mut f: impl FnMut(RpcNotification)) {
    while let Some(n) = rx.next().await {
        f(n);
    }
}
