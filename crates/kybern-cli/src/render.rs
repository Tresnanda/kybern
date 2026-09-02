//! Terminal rendering for the CLI. Plain text; no colors dependency yet.

use std::io::Write;

use anyhow::Result;
use kybern_protocol::methods::*;
use kybern_protocol::*;

use crate::client::Client;

pub fn info(i: &DaemonInfo) {
    println!("kybernd {}  protocol v{}", i.version, i.protocol_version);
    println!("environment  {}", i.environment_id);
    println!("host         {} ({} {})", i.hostname, i.os, i.arch);
    println!("data dir     {}", i.data_dir);
    println!("started      {}", i.started_at.to_rfc3339());
    println!("scopes       {}", i.scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(" "));
}

pub fn providers(list: &[ProviderStatus]) {
    for p in list {
        let state = if p.available { "available" } else { "unavailable" };
        let detail = p.version.clone().or_else(|| p.unavailable_reason.clone()).unwrap_or_default();
        println!("{:<12} {:<12} {}", p.kind, state, detail);
    }
}

pub fn projects(list: &[Project]) {
    for p in list {
        println!("{}  {:<20} {}{}", p.id, p.name, p.path, if p.is_git { "" } else { "  (not git)" });
    }
}

pub fn threads(list: &[Thread]) {
    for t in list {
        let status = serde_json::to_value(t.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        println!("{}  {:<18} {:<12} {}{}", t.id, status, t.provider.kind, t.title, if t.pinned { "  📌" } else { "" });
    }
}

pub fn approvals(list: &[ApprovalRequest]) {
    if list.is_empty() {
        println!("no pending approvals");
    }
    for a in list {
        println!("{}  thread {}  {}", a.id, a.thread_id, a.summary);
    }
}

pub fn transcript(r: &ThreadsGetResult) {
    println!("# {}  [{}]", r.thread.title, r.thread.provider.kind);
    for e in &r.transcript {
        match e {
            TranscriptEntry::User { message, .. } => println!("\n> {}\n", message.plain_text()),
            TranscriptEntry::Assistant { text, thinking, .. } => {
                if let Some(th) = thinking {
                    println!("  ⋯ {}", th.lines().next().unwrap_or(""));
                }
                println!("{text}");
            }
            TranscriptEntry::ToolCall { call, is_error, .. } => {
                println!("  ▸ {} {}", call.name, kybern_summary(&call.name, &call.input));
                if *is_error {
                    println!("    (error)");
                }
            }
            TranscriptEntry::TurnSummary { usage, cost_usd, duration_ms, error, stop_reason, .. } => {
                let cost = cost_usd.map(|c| format!("  ${c:.4}")).unwrap_or_default();
                match error {
                    Some(err) => println!("\n  ✗ {err}"),
                    None => println!(
                        "\n  ✓ {:?}  {}in/{}out tokens  {:.1}s{}",
                        stop_reason,
                        usage.input_tokens,
                        usage.output_tokens,
                        *duration_ms as f64 / 1000.0,
                        cost
                    ),
                }
            }
        }
    }
    for a in &r.pending_approvals {
        println!("\n  ? awaiting approval {}  {}", a.id, a.summary);
    }
}

fn kybern_summary(name: &str, input: &serde_json::Value) -> String {
    for key in ["command", "file_path", "path", "url", "pattern", "query"] {
        if let Some(v) = input.get(key).and_then(|v| v.as_str()) {
            let _ = name;
            return v.lines().next().unwrap_or("").chars().take(100).collect();
        }
    }
    String::new()
}

/// Print the turn as it streams, prompting on approvals, until the turn ends.
pub async fn follow_turn(client: &Client, subscription_id: SubscriptionId, thread_id: ThreadId, json: bool) -> Result<()> {
    let mut notes = client.notifications.lock().await;
    let mut stdout = std::io::stdout();
    let mut line_open = false;
    while let Some(n) = notes.recv().await {
        if n.method != EVENT_NOTIFICATION {
            continue;
        }
        let Ok(en) = serde_json::from_value::<EventNotification>(n.params) else { continue };
        if en.subscription_id != subscription_id || en.event.thread_id != thread_id {
            continue;
        }
        if json {
            println!("{}", serde_json::to_string(&en.event)?);
        }
        match &en.event.payload {
            EventPayload::AssistantTextDelta { delta, .. } if !json => {
                print!("{delta}");
                stdout.flush()?;
                line_open = true;
            }
            EventPayload::ToolCallStarted { call } if !json => {
                if line_open {
                    println!();
                    line_open = false;
                }
                println!("  ▸ {} {}", call.name, kybern_summary(&call.name, &call.input));
            }
            EventPayload::ApprovalRequested { approval } => {
                if line_open {
                    println!();
                    line_open = false;
                }
                let decision = prompt_approval(approval)?;
                client.call::<ApprovalsRespond>(ApprovalsRespondParams { approval_id: approval.id, decision }).await?;
            }
            EventPayload::ProviderNotice { level, text, .. } if !json => {
                if line_open {
                    println!();
                    line_open = false;
                }
                eprintln!("  [{level:?}] {text}");
            }
            EventPayload::TurnCompleted { usage, cost_usd, duration_ms, stop_reason } => {
                if !json {
                    if line_open {
                        println!();
                    }
                    let cost = cost_usd.map(|c| format!("  ${c:.4}")).unwrap_or_default();
                    eprintln!(
                        "\n  ✓ {:?}  {}in/{}out tokens  {:.1}s{}",
                        stop_reason,
                        usage.input_tokens,
                        usage.output_tokens,
                        *duration_ms as f64 / 1000.0,
                        cost
                    );
                }
                return Ok(());
            }
            EventPayload::TurnFailed { error } => {
                if !json {
                    if line_open {
                        println!();
                    }
                    eprintln!("\n  ✗ {error}");
                }
                return Ok(());
            }
            _ => {}
        }
    }
    Ok(())
}

fn prompt_approval(a: &ApprovalRequest) -> Result<ApprovalDecision> {
    eprintln!("\n  ? {} wants to run: {}", a.tool_name, a.summary);
    if let Ok(pretty) = serde_json::to_string_pretty(&a.input) {
        for l in pretty.lines().take(30) {
            eprintln!("      {l}");
        }
    }
    eprint!("    allow once [y] / always [a] / deny [n]: ");
    std::io::stderr().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(match line.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" | "" => ApprovalDecision::AllowOnce,
        "a" | "always" => ApprovalDecision::AllowAlways,
        _ => ApprovalDecision::Deny { reason: None },
    })
}

pub async fn watch(client: &Client, subscription_id: SubscriptionId, json: bool) -> Result<()> {
    let mut notes = client.notifications.lock().await;
    while let Some(n) = notes.recv().await {
        if n.method == "events.lagged" {
            eprintln!("(fell behind; some events were dropped)");
            continue;
        }
        if n.method != EVENT_NOTIFICATION {
            continue;
        }
        let Ok(en) = serde_json::from_value::<EventNotification>(n.params) else { continue };
        if en.subscription_id != subscription_id {
            continue;
        }
        if json {
            println!("{}", serde_json::to_string(&en.event)?);
        } else {
            let kind = serde_json::to_value(&en.event.payload).ok().and_then(|v| v.get("kind").and_then(|k| k.as_str().map(str::to_string))).unwrap_or_default();
            let short = match &en.event.payload {
                EventPayload::AssistantTextDelta { delta, .. } => delta.replace('\n', "⏎"),
                EventPayload::ToolCallStarted { call } => call.name.clone(),
                EventPayload::ApprovalRequested { approval } => approval.summary.clone(),
                EventPayload::TurnFailed { error } => error.clone(),
                EventPayload::ThreadUpdated { thread } => format!("{:?} {}", thread.status, thread.title),
                _ => String::new(),
            };
            println!("{:>6}  {}  {:<28} {}", en.event.seq, &en.event.thread_id.to_string()[..8], kind, short);
        }
    }
    Ok(())
}
