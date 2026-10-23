//! `kybern askpass` (the helper behind `SUDO_ASKPASS`, `SSH_ASKPASS` and
//! `GIT_ASKPASS` in agent sessions) and `kybern requests` (the cards a daemon
//! is showing).

use anyhow::{Context, Result, bail};
use clap::Subcommand;
use kybern_client::Client;
use kybern_protocol::methods::*;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Subcommand)]
pub enum RequestsCmd {
    /// List the request cards that are waiting on a step (sign-ins, permissions, deadlines).
    List {
        /// Only this thread's cards.
        #[arg(long)]
        thread: Option<String>,
    },
    /// Press a button on a request card, e.g. `browser`, `paste`, `pause`.
    Act {
        approval: uuid::Uuid,
        action: String,
        /// The value some actions take (the code for `paste`).
        value: Option<String>,
    },
}

pub async fn requests(client: &Client, cmd: RequestsCmd) -> Result<()> {
    match cmd {
        RequestsCmd::List { thread } => {
            let thread_id = thread.map(|id| id.parse()).transpose().context("thread must be a thread id")?;
            let result = client.call::<RequestsProgress>(RequestsProgressParams { thread_id }).await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        RequestsCmd::Act { approval, action, value } => {
            client.call::<RequestsAct>(RequestsActParams { approval_id: approval, action, value }).await?;
            println!("{}", serde_json::to_string(&Empty {})?);
        }
    }
    Ok(())
}

/// Ask the daemon the prompt an agent's command hit. Prints the answer to
/// standard output and exits 0; any refusal prints a sentence to standard
/// error and exits 1, which makes the asking command fail like a cancelled
/// prompt. The answer is never logged.
pub async fn askpass(prompt: &[String]) -> Result<()> {
    let prompt = prompt.join(" ");
    let (url, token) = match (std::env::var("KYBERN_ASKPASS_URL"), std::env::var("KYBERN_ASKPASS_TOKEN")) {
        (Ok(url), Ok(token)) if !token.is_empty() => (url, token),
        _ => bail!("kybern askpass only works inside a Kybern agent session."),
    };
    let reply = post(&url, &token, &json!({ "prompt": prompt, "pid": std::process::id() })).await?;
    if let Some(answer) = reply.get("answer").and_then(Value::as_str) {
        println!("{answer}");
        return Ok(());
    }
    let message = reply.get("message").and_then(Value::as_str).unwrap_or("Kybern didn't get an answer.");
    eprintln!("kybern: {message}");
    std::process::exit(1);
}

/// One HTTP/1.1 POST to the daemon's loopback endpoint. The prompt may wait for
/// a person for minutes, so reads are not bounded here; the daemon bounds them.
async fn post(url: &str, token: &str, body: &Value) -> Result<Value> {
    let rest = url.strip_prefix("http://").context("the askpass endpoint must be a loopback http address")?;
    let (authority, path) = rest.split_once('/').map_or((rest, "/"), |(a, p)| (a, p));
    let path = if path == "/" { "/".to_string() } else { format!("/{path}") };
    let host = authority.rsplit_once(':').map_or(authority, |(host, _)| host);
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        bail!("the askpass endpoint must be on this machine.");
    }
    let payload = serde_json::to_vec(body)?;
    let mut stream = TcpStream::connect(authority).await.context("Kybern isn't running, so there is nobody to ask.")?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&payload).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    let text = String::from_utf8_lossy(&response);
    let (head, body) = text.split_once("\r\n\r\n").context("Kybern sent an unreadable reply.")?;
    let status = head.lines().next().unwrap_or("");
    if !status.contains(" 200") {
        bail!("Kybern refused the prompt ({}).", status.trim());
    }
    // Chunked bodies carry size lines around the JSON; the object is the only brace pair.
    let start = body.find('{').context("Kybern sent an unreadable reply.")?;
    let end = body.rfind('}').context("Kybern sent an unreadable reply.")?;
    Ok(serde_json::from_str(&body[start..=end])?)
}
