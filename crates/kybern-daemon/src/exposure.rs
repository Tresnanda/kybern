//! Listeners opened at runtime besides the loopback port. Today that is the
//! machine's Tailscale address, so a phone on the same tailnet can pair and
//! connect directly, without an SSH tunnel or a Serve proxy. The choice is
//! persisted in settings and re-applied on start.

use std::net::{IpAddr, SocketAddr};

use anyhow::{Context, Result};
use axum::Router;
use kybern_protocol::methods::Exposure as ExposureInfo;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

struct Listener {
    addr: SocketAddr,
    stop: CancellationToken,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Default)]
struct Inner {
    router: Option<Router>,
    tailscale: Option<Listener>,
}

#[derive(Default)]
pub struct Exposure {
    inner: Mutex<Inner>,
}

/// Whether `bound` already accepts connections on `ip`.
fn covers(bound: SocketAddr, ip: IpAddr) -> bool {
    bound.ip() == ip || (bound.ip().is_unspecified() && bound.is_ipv4() == ip.is_ipv4())
}

impl Exposure {
    /// Hand over the app router once the daemon serves, so extra listeners
    /// run the same routes as the primary one.
    pub async fn attach(&self, router: Router) {
        self.inner.lock().await.router = Some(router);
    }

    /// Addresses of the extra listeners currently open.
    pub async fn extra_addrs(&self) -> Vec<SocketAddr> {
        self.inner.lock().await.tailscale.iter().map(|listener| listener.addr).collect()
    }

    pub async fn status(&self, primary: SocketAddr) -> ExposureInfo {
        let ip = crate::discovery::tailscale_ip().await;
        let inner = self.inner.lock().await;
        let mut listeners = vec![primary.to_string()];
        listeners.extend(inner.tailscale.iter().map(|listener| listener.addr.to_string()));
        let tailscale = inner.tailscale.is_some() || ip.is_some_and(|ip| covers(primary, ip));
        ExposureInfo { tailscale_ip: ip.map(|ip| ip.to_string()), tailscale, listeners }
    }

    /// Open or close the Tailscale listener on the primary listener's port.
    pub async fn set_tailscale(&self, primary: SocketAddr, enabled: bool) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if !enabled {
            if let Some(listener) = inner.tailscale.take() {
                tracing::info!(addr = %listener.addr, "stopped listening on Tailscale");
            }
            return Ok(());
        }
        let ip = crate::discovery::tailscale_ip()
            .await
            .context("Tailscale is not running on this machine, or it runs in userspace mode with no address the daemon can bind")?;
        if covers(primary, ip) || inner.tailscale.as_ref().is_some_and(|listener| listener.addr.ip() == ip) {
            return Ok(());
        }
        let router = inner.router.clone().context("The daemon is still starting; try again in a moment")?;
        let addr = SocketAddr::new(ip, primary.port());
        let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("Listen on {addr}"))?;
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        tokio::spawn(async move {
            let shutdown = async move { cancelled.cancelled().await };
            if let Err(error) = axum::serve(listener, router).with_graceful_shutdown(shutdown).await {
                tracing::warn!(%addr, %error, "Tailscale listener ended");
            }
        });
        tracing::info!(%addr, "listening on Tailscale");
        inner.tailscale = Some(Listener { addr, stop });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_and_exact_listeners_cover_the_tailscale_address() {
        let ip: IpAddr = "100.64.1.2".parse().unwrap();
        assert!(covers("0.0.0.0:4173".parse().unwrap(), ip));
        assert!(covers("100.64.1.2:4173".parse().unwrap(), ip));
        assert!(!covers("127.0.0.1:4173".parse().unwrap(), ip));
        assert!(!covers("[::]:4173".parse().unwrap(), ip));
    }

    #[tokio::test]
    async fn disabling_without_a_listener_is_a_no_op_and_enabling_needs_a_router() {
        let exposure = Exposure::default();
        let primary: SocketAddr = "127.0.0.1:4173".parse().unwrap();
        exposure.set_tailscale(primary, false).await.unwrap();
        assert!(exposure.extra_addrs().await.is_empty());
        let status = exposure.status(primary).await;
        assert_eq!(status.listeners, ["127.0.0.1:4173"]);
        assert!(!status.tailscale || status.tailscale_ip.is_none());
    }
}
