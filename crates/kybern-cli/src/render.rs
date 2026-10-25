//! Terminal rendering for the CLI. Plain text; no colors dependency yet.

use std::io::Write;

use futures::StreamExt;

use anyhow::Result;
use kybern_protocol::methods::*;
use kybern_protocol::*;

use kybern_client::Client;

pub fn info(i: &DaemonInfo) {
    println!("kybernd {}  protocol v{}", i.version, i.protocol_version);
    println!("environment  {}", i.environment_id);
    println!("host         {} ({} {})", i.hostname, i.os, i.arch);
    println!("data dir     {}", i.data_dir);
    println!("started      {}", i.started_at.to_rfc3339());
    println!("scopes       {}", i.scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(" "));
}

pub fn activity(a: &DaemonActivity) {
    println!("connections      {}", a.connections);
    println!("agent processes  {} live, {} idle", a.live_sessions, a.idle_sessions);
    println!("running threads  {}", a.running_threads);
    println!("terminals        {}", a.terminals);
    println!("queued messages  {}", a.queued_messages);
    match (a.idle_since, a.idle_exit_at) {
        (Some(since), Some(exit)) => println!("idle since       {} (exits at {})", since.to_rfc3339(), exit.to_rfc3339()),
        (Some(since), None) => println!("idle since       {}", since.to_rfc3339()),
        _ => println!("idle since       busy"),
    }
    match a.on_battery {
        Some(true) => println!("power            battery"),
        Some(false) => println!("power            plugged in"),
        None => {}
    }
}

pub fn providers(list: &[ProviderStatus]) {
    for p in list {
        let state = if p.available { "available" } else { "unavailable" };
        let detail = p.version.clone().or_else(|| p.unavailable_reason.clone()).unwrap_or_default();
        println!("{:<12} {:<12} {}", p.kind, state, detail);
    }
}

pub fn projects(list: &[Project], spaces: &[Space]) {
    for p in list {
        let prefix = p.task_prefix.as_deref().map(|prefix| format!("  [{prefix}]")).unwrap_or_default();
        let space = p
            .space_id
            .and_then(|id| spaces.iter().find(|space| space.id == id))
            .map(|space| format!("  {}", space.name))
            .unwrap_or_default();
        let git = if p.kind == ProjectKind::Group || p.is_git { "" } else { "  (not git)" };
        println!("{}  {:<20} {}{}{}{}{}", p.id, p.name, p.path, repo_count(p), git, prefix, space);
    }
}

/// "  3 repos" for a group project, nothing for a single one.
pub fn repo_count(p: &Project) -> String {
    match (p.kind, p.members.len()) {
        (ProjectKind::Single, _) => String::new(),
        (_, 1) => "  1 repo".into(),
        (_, n) => format!("  {n} repos"),
    }
}

pub fn scan(r: &ProjectsScanReposResult) {
    println!("{}{}", r.path, if r.is_git { "  (a repository itself: \".\")" } else { "" });
    if let Some(id) = r.existing_project_id {
        println!("  already project {id}");
    }
    for c in &r.candidates {
        let branch = match (&c.branch, c.detached) {
            (Some(b), true) => format!("detached at {b}"),
            (Some(b), false) => b.clone(),
            (None, _) => "-".into(),
        };
        let mut notes = Vec::new();
        if let Some(parent) = &c.submodule_of {
            notes.push(format!("submodule of {parent}, not selectable"));
        }
        if let Some(id) = c.project_id {
            notes.push(format!("also project {id}"));
        }
        if c.added {
            notes.push("added".into());
        }
        let notes = if notes.is_empty() { String::new() } else { format!("  ({})", notes.join("; ")) };
        println!("  {:<24} {:<20} {}{notes}", c.path, c.name, branch);
    }
    for rejected in &r.rejected {
        println!("  ! {}: {}", rejected.path, rejected.reason);
    }
    if r.truncated {
        println!("  (stopped early: too many folders)");
    }
}

pub fn members(r: &ProjectsMembersStatusResult, project: Option<&Project>) {
    for m in &r.members {
        let state = match m.status {
            MemberStatus::Ok => match (&m.branch, m.detached) {
                (Some(b), true) => format!("detached at {b}"),
                (Some(b), false) => b.clone(),
                (None, _) => "-".into(),
            },
            MemberStatus::Missing => "missing".into(),
            MemberStatus::NotGit => "not a repository".into(),
        };
        let dirty = if m.dirty_files > 0 { format!("  {} uncommitted", m.dirty_files) } else { String::new() };
        let instructions = m.instructions.as_deref().map(|f| format!("  {f}")).unwrap_or_default();
        println!("  {:<24} {:<20} {state}{dirty}{instructions}", m.path, m.name);
    }
    let shared: Vec<&str> =
        [("AGENTS.md", r.agents_md), ("CLAUDE.md", r.claude_md)].into_iter().filter(|(_, on)| *on).map(|(f, _)| f).collect();
    println!("shared instructions: {}", if shared.is_empty() { "none".to_string() } else { shared.join(", ") });
    if let Some(project) = project.filter(|p| !p.worktree_copy.is_empty()) {
        println!("copied into worktrees: {}", project.worktree_copy.join(", "));
    }
}

pub fn project_map(map: &methods::ProjectMap) {
    println!("{}", map.header);
    println!("\nbuilt {}", map.built_at.format("%Y-%m-%d %H:%M:%SZ"));
    println!("\nlayout");
    for a in &map.layout {
        let name = match (&a.name, &a.manifest) {
            (Some(name), Some(kind)) => format!("  {name} ({kind})"),
            (Some(name), None) => format!("  {name}"),
            _ => String::new(),
        };
        println!("  {:<12} {:<40} {:>6}{name}", a.repo, a.path, a.files);
    }
    println!("\ncommands");
    for c in &map.commands {
        println!("  {:<12} {:<28} {:<24} {}", c.repo, c.source, c.name, c.run.replace('\n', " ; "));
    }
    println!("\nbusy areas");
    for b in &map.busy {
        println!("  {:<12} {:<40} {:>4}", b.repo, b.path, b.commits);
    }
    println!("\nremoved and renamed");
    for c in &map.removed {
        let what = match &c.from {
            Some(from) => format!("{from} -> {}", c.path),
            None => format!("deleted {}", c.path),
        };
        println!("  {:<12} {what}  {} {} {}", c.repo, c.commit, c.date.get(..10).unwrap_or(&c.date), c.subject);
    }
}

pub fn threads(list: &[Thread]) {
    for t in list {
        let status = serde_json::to_value(t.status).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        let delegation = t
            .delegation
            .as_ref()
            .map(|d| {
                format!(
                    "  [delegated {} {}{}]",
                    d.role,
                    d.status,
                    d.worktree_state.map(|s| format!(", worktree {s:?}")).unwrap_or_default()
                )
            })
            .unwrap_or_default();
        println!("{}  {:<18} {:<12} {}{}{}", t.id, status, t.provider.kind, t.title, if t.pinned { "  📌" } else { "" }, delegation);
    }
}

pub fn thread_messages(list: &[ThreadMessageRecord]) {
    if list.is_empty() {
        println!("no messages");
    }
    for m in list {
        let from = m.from_thread_id.map_or_else(|| "kybern".to_string(), |id| id.to_string());
        let reply = m.reply_to.map(|id| format!(" reply to {id}")).unwrap_or_default();
        let held = m.held_reason.as_deref().map(|reason| format!("  ({reason})")).unwrap_or_default();
        let body = m.body.lines().next().unwrap_or("").chars().take(80).collect::<String>();
        println!("{}  {:<9} {:<8} from {} to {}{}{}\n    {}", m.id, m.state.as_str(), m.purpose, from, m.to_thread_id, reply, held, body);
    }
}

/// One line for an event that carries thread-to-thread messaging, for `watch` and `send`.
fn messaging_summary(payload: &EventPayload) -> Option<String> {
    match payload {
        EventPayload::ThreadMessageHeld { message } => Some(format!(
            "held {} {} from {}",
            message.purpose,
            message.id,
            message.from_thread_id.map_or_else(|| "kybern".to_string(), |id| id.to_string())
        )),
        EventPayload::ThreadMessageResolved { message_id, resolution } => Some(format!("{resolution:?} {message_id}").to_lowercase()),
        EventPayload::SubagentMessageUpdated { message } => Some(format!(
            "subagent message {}: {:?}{}",
            message.id,
            message.status,
            message.error.as_deref().map(|s| format!(" — {s}")).unwrap_or_default()
        )),
        EventPayload::ThreadMessageUpdated { message } => Some(format!("{} {} {}", message.state.as_str(), message.purpose, message.id)),
        _ => None,
    }
}

pub fn notes(list: &[NoteSummary]) {
    for note in list {
        let scope = match note.scope {
            NoteScope::Global => "global",
            NoteScope::Project => "project",
            NoteScope::Thread => "thread",
        };
        let title = if note.title.is_empty() { "Untitled" } else { note.title.as_str() };
        let checklist =
            if note.checklist.total > 0 { format!("  [{}/{}]", note.checklist.done, note.checklist.total) } else { String::new() };
        let preview =
            if note.preview.is_empty() { String::new() } else { format!("  {}", note.preview.chars().take(60).collect::<String>()) };
        let category = note.category.map_or(String::new(), |category| format!("  ({})", category.as_str()));
        let flag = match (&note.stale, note.undated) {
            (Some(stale), _) => format!("  may be outdated: {}", stale.path),
            (None, true) => "  undated".to_owned(),
            (None, false) => String::new(),
        };
        println!(
            "{}  {:<8} {}{}{}{}{}{}",
            note.id,
            scope,
            title,
            category,
            if note.pinned { "  📌" } else { "" },
            checklist,
            flag,
            preview
        );
    }
}

pub fn task_status(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Inbox => "inbox",
        TaskStatus::Todo => "todo",
        TaskStatus::Running => "running",
        TaskStatus::NeedsReview => "needs review",
        TaskStatus::Done => "done",
        TaskStatus::Canceled => "canceled",
    }
}

const PRIORITY_LABELS: [&str; 5] = ["-", "urgent", "high", "medium", "low"];

pub fn tasks(list: &[TaskItem]) {
    for task in list {
        let run = match task.runs.last() {
            Some(run) if run.state.is_live() => {
                let activity = run.activity.as_deref().map(|activity| format!(" {activity}")).unwrap_or_default();
                format!("  [run {}: {}{}]", run.number, run.state.as_str(), activity)
            }
            Some(run) => match run.diff {
                Some(diff) => {
                    format!("  [run {}: {} +{} -{} in {} files]", run.number, run.state.as_str(), diff.added, diff.removed, diff.files)
                }
                None => format!("  [run {}: {}]", run.number, run.state.as_str()),
            },
            None => String::new(),
        };
        println!(
            "{:<8} {:<13} {:<6} {}{}",
            task.key,
            task_status(task.status),
            PRIORITY_LABELS.get(usize::from(task.priority)).copied().unwrap_or("-"),
            task.title,
            run
        );
    }
}

pub fn task(task: &TaskItem) {
    println!("{}  {}", task.key, task.title);
    println!(
        "status    {}\npriority  {}\nscope     {}{}",
        task_status(task.status),
        PRIORITY_LABELS.get(usize::from(task.priority)).copied().unwrap_or("-"),
        match task.scope {
            TaskScope::Global => "global",
            TaskScope::Project => "project",
        },
        task.project_id.map(|id| format!(" {id}")).unwrap_or_default()
    );
    println!("updated   {}", task.updated_at.to_rfc3339());
    if !task.note_ids.is_empty() {
        println!("notes     {}", task.note_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(" "));
    }
    if let Some(followup) = &task.pending_followup {
        println!("follow-up {}", followup.replace('\n', " "));
    }
    if !task.body.trim().is_empty() {
        println!("\n{}", task.body.trim_end());
    }
    for run in &task.runs {
        let diff = run.diff.map(|diff| format!("  +{} -{} in {} files", diff.added, diff.removed, diff.files)).unwrap_or_default();
        let activity = run.activity.as_deref().map(|activity| format!("  {activity}")).unwrap_or_default();
        println!("\nrun {}  {}  {}  thread {}{}{}", run.number, run.state.as_str(), run.provider.kind, run.thread_id, diff, activity);
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
            TranscriptEntry::Image { .. } => println!("  [Agent image — open the desktop to preview]"),
            TranscriptEntry::Visual { visual, .. } => {
                println!("  [Visual: {} — open the desktop to interact; id {}]", visual.title, visual.id)
            }
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
            TranscriptEntry::Approval { approval, decision, auto, .. } => {
                let d = match decision {
                    _ if *auto => "allowed by Full access",
                    Some(ApprovalDecision::Submit { .. }) => "answered",
                    Some(ApprovalDecision::AllowOnce) => "allowed",
                    Some(ApprovalDecision::AllowAlways) => "always allowed",
                    Some(ApprovalDecision::Deny { .. }) => "denied",
                    None => "pending",
                };
                println!("  ? {}  ({d})", approval.summary);
            }
            TranscriptEntry::RuntimeTask { task, .. } => println!("  ↳ {}  ({:?})", task.title, task.status),
            TranscriptEntry::Notice { text, .. } => println!("  ! {text}"),
            TranscriptEntry::Reverted { commit, .. } => println!("  ↶ reverted to {commit}"),
            TranscriptEntry::Rotation { rotation_id, pending: true, .. } => println!("  ⟳ refreshing context…  ({rotation_id})"),
            TranscriptEntry::Rotation { rotation_id, handoff_status, edited, .. } => {
                let how = match handoff_status {
                    Some(HandoffStatus::Missing { why }) => format!("without a handoff: {why}"),
                    _ if *edited => "handoff edited by you".to_owned(),
                    _ => "with a handoff".to_owned(),
                };
                println!("  ⟳ context refreshed {how}  ({rotation_id})");
            }
            TranscriptEntry::OutsideRepoChanged { repos, .. } => {
                for repo in repos {
                    println!("  ! {} changed outside this chat's worktree", repo.name);
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
    while let Some(n) = notes.next().await {
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
            EventPayload::ToolCallStarted { call, .. } if !json => {
                if line_open {
                    println!();
                    line_open = false;
                }
                println!("  ▸ {} {}", call.name, kybern_summary(&call.name, &call.input));
            }
            EventPayload::ApprovalRequested { approval } | EventPayload::UserInputRequested { approval } => {
                if line_open {
                    println!();
                    line_open = false;
                }
                let decision = prompt_approval(approval)?;
                client.call::<ApprovalsRespond>(ApprovalsRespondParams { approval_id: approval.id, decision }).await?;
            }
            EventPayload::ThreadMessageHeld { .. }
            | EventPayload::ThreadMessageResolved { .. }
            | EventPayload::ThreadMessageUpdated { .. }
            | EventPayload::SubagentMessageUpdated { .. }
                if !json =>
            {
                if line_open {
                    println!();
                    line_open = false;
                }
                eprintln!("  [message] {}", messaging_summary(&en.event.payload).unwrap_or_default());
            }
            EventPayload::ProviderNotice { level, text, .. } if !json => {
                if line_open {
                    println!();
                    line_open = false;
                }
                eprintln!("  [{level:?}] {text}");
            }
            EventPayload::TurnCompleted { usage, cost_usd, duration_ms, stop_reason, .. } => {
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
    if a.is_user_input() {
        eprintln!("\n  ? {}", a.summary);
        eprintln!("{}", serde_json::to_string_pretty(&a.input)?);
        eprint!("    Enter a JSON response, or leave blank to decline: ");
        std::io::stderr().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        return if line.trim().is_empty() {
            Ok(ApprovalDecision::Deny { reason: None })
        } else {
            Ok(ApprovalDecision::Submit { response: serde_json::from_str(&line)? })
        };
    }
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
    while let Some(n) = notes.next().await {
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
            let kind = serde_json::to_value(&en.event.payload)
                .ok()
                .and_then(|v| v.get("kind").and_then(|k| k.as_str().map(str::to_string)))
                .unwrap_or_default();
            let short = match &en.event.payload {
                EventPayload::AssistantTextDelta { delta, .. } => delta.replace('\n', "⏎"),
                EventPayload::ToolCallStarted { call, .. } => call.name.clone(),
                EventPayload::ApprovalRequested { approval } | EventPayload::UserInputRequested { approval } => approval.summary.clone(),
                EventPayload::TurnFailed { error } => error.clone(),
                EventPayload::ThreadUpdated { thread } => {
                    let delegation = thread.delegation.as_ref().map(|d| format!(" [delegated {}]", d.status)).unwrap_or_default();
                    format!("{:?} {}{}", thread.status, thread.title, delegation)
                }
                other => messaging_summary(other).unwrap_or_default(),
            };
            println!("{:>6}  {}  {:<28} {}", en.event.seq, &en.event.thread_id.to_string()[..8], kind, short);
        }
    }
    Ok(())
}

pub fn usage(r: &UsageSummaryResult) {
    println!("{:<28} {:>6} {:>10} {:>10} {:>10} {:>9}", "", "turns", "input", "output", "cache", "cost");
    for row in r.rows.iter().chain(std::iter::once(&r.total)) {
        println!(
            "{:<28} {:>6} {:>10} {:>10} {:>10} {:>9}",
            row.key.chars().take(28).collect::<String>(),
            row.turns,
            row.usage.input_tokens,
            row.usage.output_tokens,
            row.usage.cache_read_tokens + row.usage.cache_write_tokens,
            format!("${:.2}", row.cost_usd)
        );
    }
}

pub async fn terminal(client: &Client, cmd: crate::TerminalCommand, json: bool) -> Result<()> {
    use crate::TerminalCommand as T;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    match cmd {
        T::List => {
            let r = client.call::<TerminalsList>(TerminalsListParams { thread_id: None }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&r)?)
            } else {
                for t in r.terminals {
                    println!("{}  {:<6} {}x{:<4} {}  {}", t.id, if t.alive { "alive" } else { "exited" }, t.cols, t.rows, t.title, t.cwd);
                }
            }
        }
        T::Create { thread, cwd } => {
            let info = client
                .call::<TerminalsCreate>(TerminalsCreateParams {
                    terminal_id: None,
                    thread_id: thread.map(|t| t.parse()).transpose()?,
                    cwd,
                    cols: 120,
                    rows: 32,
                    command: None,
                })
                .await?;
            println!("{}", info.id);
        }
        T::Send { terminal, input } => {
            let mut line = input.join(" ");
            line.push('\n');
            client
                .call::<TerminalsInput>(TerminalsInputParams { terminal_id: terminal.parse()?, data: b64.encode(line.as_bytes()) })
                .await?;
        }
        T::Attach { terminal } => {
            let id: TerminalId = terminal.parse()?;
            client.call::<TerminalsSubscribe>(TerminalsSubscribeParams { terminal_id: id, replay: true }).await?;
            stream_terminal(client, id, None).await?;
        }
        T::Run { thread, cwd, seconds, command } => {
            let info = client
                .call::<TerminalsCreate>(TerminalsCreateParams {
                    terminal_id: None,
                    thread_id: thread.map(|t| t.parse()).transpose()?,
                    cwd,
                    cols: 120,
                    rows: 32,
                    command: None,
                })
                .await?;
            client.call::<TerminalsSubscribe>(TerminalsSubscribeParams { terminal_id: info.id, replay: true }).await?;
            let mut line = command.join(" ");
            line.push('\n');
            client.call::<TerminalsInput>(TerminalsInputParams { terminal_id: info.id, data: b64.encode(line.as_bytes()) }).await?;
            stream_terminal(client, info.id, Some(std::time::Duration::from_secs(seconds))).await?;
            let _ = client.call::<TerminalsClose>(TerminalsCloseParams { terminal_id: info.id }).await;
        }
        T::Close { terminal } => {
            client.call::<TerminalsClose>(TerminalsCloseParams { terminal_id: terminal.parse()? }).await?;
            println!("closed");
        }
    }
    Ok(())
}

async fn stream_terminal(client: &Client, id: TerminalId, limit: Option<std::time::Duration>) -> Result<()> {
    use base64::Engine;
    let mut notes = client.notifications.lock().await;
    let mut stdout = std::io::stdout();
    let deadline = limit.map(|d| tokio::time::Instant::now() + d);
    loop {
        let next = match deadline {
            Some(dl) => match tokio::time::timeout_at(dl, notes.next()).await {
                Ok(n) => n,
                Err(_) => break,
            },
            None => notes.next().await,
        };
        let Some(n) = next else { break };
        match n.method.as_str() {
            m if m == TERMINAL_OUTPUT_NOTIFICATION => {
                let Ok(p) = serde_json::from_value::<TerminalOutputNotification>(n.params) else { continue };
                if p.terminal_id != id {
                    continue;
                }
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&p.data) {
                    stdout.write_all(&bytes)?;
                    stdout.flush()?;
                }
            }
            m if m == TERMINAL_EXITED_NOTIFICATION => {
                let Ok(p) = serde_json::from_value::<TerminalExitedNotification>(n.params) else { continue };
                if p.terminal_id == id {
                    eprintln!("\n[terminal exited{}]", p.exit_code.map(|c| format!(" with code {c}")).unwrap_or_default());
                    break;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
