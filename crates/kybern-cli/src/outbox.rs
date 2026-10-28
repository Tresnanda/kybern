//! `kybern outbox`: the work waiting for machines that are offline (design §6.4).

use anyhow::{Result, anyhow};
use clap::Subcommand;
use kybern_client::Client;
use kybern_protocol::methods::*;
use kybern_protocol::*;

#[derive(Subcommand)]
pub enum OutboxCmd {
    /// List queued work, newest first.
    List {
        /// Only items for this machine id.
        #[arg(long)]
        target: Option<String>,
        /// Only items in this state: queued, sending, delivered, failed, expired or cancelled.
        #[arg(long)]
        state: Option<String>,
    },
    /// Queue a failed, expired or cancelled item again for another seven days.
    Retry {
        /// An item id from `kybern outbox list`.
        id: uuid::Uuid,
    },
    /// Cancel an item that has not been delivered.
    Cancel {
        /// An item id from `kybern outbox list`.
        id: uuid::Uuid,
    },
}

fn parse_state(value: &str) -> Result<OutboxState> {
    serde_json::from_value(serde_json::Value::String(value.to_lowercase()))
        .map_err(|_| anyhow!("States are queued, sending, delivered, failed, expired and cancelled."))
}

fn render(items: &[OutboxItem]) {
    if items.is_empty() {
        println!("nothing waiting");
    }
    for item in items {
        println!(
            "{}  {:<9} {:<10} {}  {}{}",
            item.id,
            item.state.as_str(),
            item.kind.as_str(),
            item.target,
            item.expires_at.format("expires %Y-%m-%d %H:%M"),
            item.last_error.as_deref().map(|error| format!("  ({error})")).unwrap_or_default()
        );
    }
}

pub async fn run(client: &Client, cmd: OutboxCmd, json: bool) -> Result<()> {
    match cmd {
        OutboxCmd::List { target, state } => {
            let state = state.as_deref().map(parse_state).transpose()?;
            let result = client.call::<OutboxList>(OutboxListParams { target, state }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&result)?) } else { render(&result.items) }
        }
        OutboxCmd::Retry { id } => {
            let item = client.call::<OutboxRetry>(OutboxIdParams { id }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&item)?) } else { render(&[item]) }
        }
        OutboxCmd::Cancel { id } => {
            let item = client.call::<OutboxCancel>(OutboxIdParams { id }).await?;
            if json { println!("{}", serde_json::to_string_pretty(&item)?) } else { render(&[item]) }
        }
    }
    Ok(())
}
