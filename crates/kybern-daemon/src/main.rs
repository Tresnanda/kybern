mod auth;
mod config;
mod orchestrator;
mod rpc;
mod state;
mod ws;

use std::net::SocketAddr;

use anyhow::Result;
use axum::Router;
use axum::routing::get;
use clap::Parser;
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
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,kybern=debug")))
        .with_target(true)
        .init();

    let args = Args::parse();
    let paths = config::Paths::resolve(args.data_dir)?;
    let state = state::AppState::init(&paths).await?;

    if args.print_token {
        println!("{}", state.bootstrap_token);
        return Ok(());
    }

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/ws", get(ws::upgrade))
        .with_state(state.clone());

    let addr: SocketAddr = format!("{}:{}", args.bind, args.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, data_dir = %paths.root.display(), "kybernd listening");
    std::fs::write(&paths.port_file, addr.port().to_string())?;

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down");
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await?;
    state.orchestrator.shutdown().await;
    let _ = std::fs::remove_file(&paths.port_file);
    Ok(())
}
