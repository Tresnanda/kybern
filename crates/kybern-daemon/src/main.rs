mod access;
mod auth;
mod config;
mod files;
mod github;
mod http;
mod orchestrator;
mod rpc;
mod settings;
mod skills;
mod state;
mod terminal;
mod ws;

use std::fs::OpenOptions;
use std::io::Write;
use std::net::SocketAddr;

use anyhow::{Result, anyhow};
use axum::Router;
use axum::routing::get;
use clap::Parser;
use kybern_protocol::PROTOCOL_VERSION;
use serde::Serialize;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "kybernd", version, about = "kybern daemon")]
struct Args {
    /// Port to listen on (loopback only unless --bind is given).
    #[arg(long, env = "KYBERN_PORT", default_value_t = kybern_protocol::DEFAULT_PORT)]
    port: u16,
    /// Bind address. Defaults to 127.0.0.1. Use 0.0.0.0 for LAN/Tailscale pairing.
    #[arg(long, env = "KYBERN_BIND", default_value = "127.0.0.1")]
    bind: String,
    /// Data directory. Defaults to ~/.kybern.
    #[arg(long, env = "KYBERN_DATA_DIR")]
    data_dir: Option<std::path::PathBuf>,
    /// Print the bootstrap token and exit.
    #[arg(long)]
    print_token: bool,
    /// Private desktop bootstrap handshake. Not part of the public daemon CLI.
    #[arg(long, hide = true)]
    desktop_startup_id: Option<String>,
}

#[derive(Serialize)]
struct DesktopStartupAnnouncement {
    port: u16,
    protocol_version: u32,
    version: &'static str,
}

fn startup_announcement_filename(id: &str) -> Result<String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err(anyhow!("invalid desktop startup id"));
    }
    Ok(format!(".desktop-startup-{id}.json"))
}

fn write_startup_announcement(paths: &config::Paths, id: &str, port: u16) -> Result<()> {
    let path = paths.root.join(startup_announcement_filename(id)?);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path)?;
    serde_json::to_writer(
        &mut file,
        &DesktopStartupAnnouncement { port, protocol_version: PROTOCOL_VERSION, version: env!("CARGO_PKG_VERSION") },
    )?;
    file.flush()?;
    tracing::debug!(path = %path.display(), port, "published desktop startup endpoint");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,kybern=debug")))
        .with_target(true)
        .init();

    let args = Args::parse();
    let paths = config::Paths::resolve(args.data_dir)?;
    let state = state::AppState::initialize(&paths)?;

    if args.print_token {
        state.orchestrator.recover_after_restart().await?;
        println!("{}", state.bootstrap_token);
        return Ok(());
    }

    let requested_addr: SocketAddr = format!("{}:{}", args.bind, args.port).parse()?;
    let listener = tokio::net::TcpListener::bind(requested_addr).await?;
    let addr = listener.local_addr()?;
    state.port.store(addr.port(), std::sync::atomic::Ordering::Relaxed);
    if let Some(startup_id) = &args.desktop_startup_id {
        write_startup_announcement(&paths, startup_id, addr.port())?;
    }

    // Recovery may need to close interrupted turns and capture final snapshots.
    // Keep the port reserved while it runs, but do not serve requests or publish
    // daemon.port to general clients until the state is consistent.
    state.orchestrator.recover_after_restart().await?;

    let app = Router::new()
        .merge(http::routes())
        .route("/ws", get(ws::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state.clone());

    tracing::info!(%addr, data_dir = %paths.root.display(), "kybernd listening");
    std::fs::write(&paths.port_file, addr.port().to_string())?;

    let shutdown_token = state.shutdown.clone();
    let shutdown = async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = shutdown_token.cancelled() => {}
        }
        tracing::info!("shutting down");
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    state.orchestrator.shutdown().await;
    state.terminals.shutdown().await;
    let _ = std::fs::remove_file(&paths.port_file);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::startup_announcement_filename;

    #[test]
    fn startup_announcement_filename_is_scoped_to_the_data_directory() {
        assert_eq!(startup_announcement_filename("123-456-0").unwrap(), ".desktop-startup-123-456-0.json");
    }

    #[test]
    fn startup_announcement_id_rejects_path_traversal() {
        assert!(startup_announcement_filename("../daemon.token").is_err());
        assert!(startup_announcement_filename("nested/file").is_err());
        assert!(startup_announcement_filename("").is_err());
    }
}
