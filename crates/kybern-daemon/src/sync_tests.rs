// Threads load instantly (#245, #248): list cursors, page budgets, gap snapshots, the subscribe-then-get order,
// the gzip snapshot route, and the transfer budget a first load may spend.
use futures::{SinkExt, StreamExt};
use kybern_protocol::{methods::*, *};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

use crate::remote_tests::Host;

/// The page budget clients send on a first load (`FIRST_PAGE_BUDGET` in packages/kybern-client).
const FIRST_PAGE: TranscriptPageBudget = TranscriptPageBudget { turns: 10, max_rows: 500, max_bytes: 1024 * 1024 };

fn project(host: &Host, name: &str) -> Project {
    let path = host.root.join(name);
    std::fs::create_dir_all(&path).unwrap();
    host.state.orchestrator.add_project(path.to_string_lossy().into_owned(), Some(name.into()), None).unwrap()
}

fn thread_in(host: &Host, project: &Project, title: &str, minutes_ago: i64) -> Thread {
    let at = chrono::Utc::now() - chrono::Duration::minutes(minutes_ago);
    let thread = Thread {
        id: Uuid::now_v7(),
        project_id: project.id,
        title: title.into(),
        provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Supervised,
        status: ThreadStatus::Idle,
        worktree: None,
        cwd: project.path.clone(),
        provider_session_id: None,
        pinned: false,
        created_at: at,
        updated_at: at,
        last_seq: 0,
        parent_thread_id: None,
        coordinator_project_id: None,
        origin: None,
        inbound: None,
        moved: None,
        subagent: None,
        delegation: None,
        members: Vec::new(),
    };
    host.state.store.thread_upsert(&thread).unwrap();
    thread
}

fn delegation(parent: ThreadId, status: DelegationStatus) -> DelegationInfo {
    DelegationInfo {
        task_id: Uuid::now_v7(),
        operation_id: Uuid::now_v7(),
        parent_thread_id: parent,
        depth: 1,
        role: DelegationRole::default(),
        workspace: DelegationWorkspace::default(),
        owns: Vec::new(),
        status,
        result: None,
        error: None,
        files_touched: Vec::new(),
        conflicts: Vec::new(),
        base_commit: None,
        branch: None,
        head_commit: None,
        diffstat: None,
        worktree_state: None,
        started_at: chrono::Utc::now(),
        completed_at: None,
        parent_notified: true,
        default_override: None,
    }
}

fn notice(host: &Host, thread: ThreadId, turn: Option<Uuid>, text: String) -> ThreadEvent {
    host.state
        .orchestrator
        .emit(thread, turn, EventPayload::ProviderNotice { data: None, level: NoticeLevel::Info, text, problem: None })
        .unwrap()
}

fn row_seq(entry: &TranscriptEntry) -> EventSeq {
    serde_json::to_value(entry).unwrap()["seq"].as_i64().unwrap()
}

fn notice_text(entry: &TranscriptEntry) -> Option<&str> {
    match entry {
        TranscriptEntry::Notice { text, .. } => Some(text),
        _ => None,
    }
}

fn wire_bytes<T: serde::Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).unwrap().len()
}

/// Event notifications for `thread` until `events.ready`, then until one with `seq >= until` arrives.
async fn events_until(client: &kybern_client::Client, until: EventSeq) -> Vec<ThreadEvent> {
    let mut events = Vec::new();
    let mut notifications = client.notifications.lock().await;
    loop {
        let notification = tokio::time::timeout(Duration::from_secs(10), notifications.next()).await.expect("event in time").unwrap();
        if notification.method != EVENT_NOTIFICATION {
            continue;
        }
        let event: EventNotification = serde_json::from_value(notification.params).unwrap();
        let seq = event.event.seq;
        events.push(event.event);
        if seq >= until {
            return events;
        }
    }
}

// ---- threads.get page budgets ----

/// A thread of `turns` turns, each a prompt and `rows` notices of `text_bytes` each.
fn turns_fixture(host: &Host, thread: &Thread, turns: usize, rows: usize, text_bytes: usize) -> Vec<Uuid> {
    (0..turns)
        .map(|turn| {
            let turn_id = Uuid::now_v7();
            host.state
                .store
                .event_append(
                    thread.id,
                    Some(turn_id),
                    EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text(format!("Prompt {turn}")) },
                )
                .unwrap();
            for row in 0..rows {
                host.state
                    .store
                    .event_append(
                        thread.id,
                        Some(turn_id),
                        EventPayload::ProviderNotice {
                            data: None,
                            level: NoticeLevel::Info,
                            text: format!("{turn}.{row} {}", "x".repeat(text_bytes)),
                            problem: None,
                        },
                    )
                    .unwrap();
            }
            turn_id
        })
        .collect()
}

fn turn_of(entry: &TranscriptEntry) -> Uuid {
    serde_json::from_value(serde_json::to_value(entry).unwrap()["turn_id"].clone()).unwrap()
}

#[tokio::test]
async fn page_budgets_take_whole_turns_cap_rows_and_bytes_and_page_back_with_before_seq() {
    let host = Host::start().await;
    let thread = host.thread();
    let turns = turns_fixture(&host, &thread, 12, 4, 100);
    let client = host.client().await;
    let get = |budget: TranscriptPageBudget, before_seq: Option<EventSeq>| ThreadsGetParams {
        thread_id: thread.id,
        page_budget: Some(budget),
        before_seq,
        include_tool_output: Some(false),
        transcript_only: before_seq.map(|_| true),
        ..Default::default()
    };

    // Three whole turns: the page starts at the first row of the oldest one.
    let page = client.call::<ThreadsGet>(get(TranscriptPageBudget { turns: 3, max_rows: 500, max_bytes: 1 << 20 }, None)).await.unwrap();
    let page_turns: BTreeSet<Uuid> = page.transcript.iter().map(turn_of).collect();
    assert_eq!(page_turns, turns[9..].iter().copied().collect());
    assert!(matches!(page.transcript.first(), Some(TranscriptEntry::User { .. })), "starts at a prompt");
    assert_eq!(page.next_before_seq, Some(row_seq(&page.transcript[0])));
    assert!(page.as_of_seq.is_some_and(|seq| seq >= page.thread.last_seq));

    // The row cap cuts inside a turn.
    let rows = client.call::<ThreadsGet>(get(TranscriptPageBudget { turns: 10, max_rows: 7, max_bytes: 1 << 20 }, None)).await.unwrap();
    assert_eq!(rows.transcript.len(), 7);

    // The byte cap: exactly the newest 3 rows (their timestamps make sizes differ by a few bytes).
    let newest_three: usize = rows.transcript[rows.transcript.len() - 3..].iter().map(kybern_store::transcript_entry_bytes).sum();
    let bytes = client
        .call::<ThreadsGet>(get(TranscriptPageBudget { turns: 10, max_rows: 500, max_bytes: newest_three as u32 }, None))
        .await
        .unwrap();
    assert_eq!(bytes.transcript.len(), 3);
    // A budget smaller than one row still returns the newest row.
    let tiny = client.call::<ThreadsGet>(get(TranscriptPageBudget { turns: 1, max_rows: 1, max_bytes: 1 }, None)).await.unwrap();
    assert_eq!(tiny.transcript.len(), 1);

    // before_seq pages walk back two turns at a time and add up to the whole history.
    let full = client.call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.id, ..Default::default() }).await.unwrap();
    let budget = TranscriptPageBudget { turns: 2, max_rows: 500, max_bytes: 1 << 20 };
    let first = client.call::<ThreadsGet>(get(budget, None)).await.unwrap();
    let mut collected = first.transcript;
    let mut cursor = first.next_before_seq;
    let mut pages = 1;
    while let Some(before) = cursor {
        let older = client.call::<ThreadsGet>(get(budget, Some(before))).await.unwrap();
        assert!(older.runtime_tasks.is_empty() && older.pending_approvals.is_empty());
        assert_eq!(older.transcript.iter().map(turn_of).collect::<BTreeSet<_>>().len(), 2, "two whole turns per page");
        cursor = older.next_before_seq;
        let mut rows = older.transcript;
        rows.append(&mut collected);
        collected = rows;
        pages += 1;
    }
    assert_eq!(pages, 6);
    assert_eq!(serde_json::to_value(collected).unwrap(), serde_json::to_value(full.transcript).unwrap());

    // before_seq without a limit or a budget is still refused.
    let refused =
        client.call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.id, before_seq: Some(5), ..Default::default() }).await.unwrap_err();
    assert!(refused.to_string().contains("transcript_limit"), "{refused}");
}

#[tokio::test]
async fn threads_get_without_a_budget_pages_as_before() {
    let host = Host::start().await;
    let thread = host.thread();
    turns_fixture(&host, &thread, 5, 10, 50);
    let client = host.client().await;
    let page = client
        .call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.id, transcript_limit: Some(12), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(page.transcript.len(), 12);
    let all = client.call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.id, ..Default::default() }).await.unwrap();
    assert_eq!(all.transcript.len(), 55);
    assert_eq!(all.next_before_seq, None);
}

// ---- events.subscribe gap snapshots ----

#[tokio::test]
async fn a_large_gap_answers_with_a_snapshot_through_head_and_live_events_continue_it() {
    let host = Host::start().await;
    let thread = host.thread();
    let first = notice(&host, thread.id, Some(thread.id), "Entry 0".into());
    for index in 1..300 {
        notice(&host, thread.id, Some(thread.id), format!("Entry {index}"));
    }
    let client = host.client().await;
    // Events land while the subscription is set up: each belongs to the snapshot or to the live stream, never both.
    let writer = {
        let state = host.state.clone();
        let thread_id = thread.id;
        std::thread::spawn(move || {
            let mut last = 0;
            for index in 300..400 {
                std::thread::sleep(Duration::from_micros(200));
                last = state
                    .orchestrator
                    .emit(
                        thread_id,
                        Some(thread_id),
                        EventPayload::ProviderNotice {
                            data: None,
                            level: NoticeLevel::Info,
                            text: format!("Entry {index}"),
                            problem: None,
                        },
                    )
                    .unwrap()
                    .seq;
            }
            last
        })
    };
    let subscribed = client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            thread_id: Some(thread.id),
            after_seq: Some(first.seq),
            include_tool_output: Some(false),
            gap_snapshot: Some(ThreadsGetParams { thread_id: thread.id, include_tool_output: Some(false), ..Default::default() }),
        })
        .await
        .unwrap();
    let last = writer.join().unwrap();
    let snapshot = subscribed.snapshot.expect("a gap of 299 events is a snapshot");
    assert_eq!(snapshot.as_of_seq, Some(subscribed.head_seq));
    assert!(snapshot.thread.last_seq <= subscribed.head_seq);
    assert!(snapshot.transcript.iter().all(|row| row_seq(row) <= subscribed.head_seq), "projected exactly through head");
    let live = if last > subscribed.head_seq { events_until(&client, last).await } else { Vec::new() };
    assert!(live.iter().all(|event| event.seq > subscribed.head_seq), "no replayed event");
    let mut texts: Vec<String> = snapshot.transcript.iter().filter_map(notice_text).map(str::to_string).collect();
    texts.extend(live.iter().filter_map(|event| match &event.payload {
        EventPayload::ProviderNotice { text, .. } => Some(text.clone()),
        _ => None,
    }));
    let expected: Vec<String> = (0..400).map(|index| format!("Entry {index}")).collect();
    assert_eq!(texts, expected, "no gap and no duplicate");
}

#[tokio::test]
async fn a_small_gap_still_replays_and_a_large_one_replays_without_gap_snapshot() {
    let host = Host::start().await;
    let thread = host.thread();
    let mut seqs = Vec::new();
    for index in 0..200 {
        seqs.push(notice(&host, thread.id, Some(thread.id), format!("Entry {index}")).seq);
    }
    let client = host.client().await;
    let get = ThreadsGetParams { thread_id: thread.id, page_budget: Some(FIRST_PAGE), ..Default::default() };
    let after = seqs[200 - 6];
    let small = client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            thread_id: Some(thread.id),
            after_seq: Some(after),
            gap_snapshot: Some(get.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(small.snapshot.is_none());
    let replayed = events_until(&client, *seqs.last().unwrap()).await;
    assert_eq!(replayed.iter().map(|event| event.seq).collect::<Vec<_>>(), seqs[200 - 5..]);

    // An old client (no gap_snapshot) gets the whole replay as before.
    let legacy = host.client().await;
    let full = legacy
        .call::<EventsSubscribe>(EventsSubscribeParams { thread_id: Some(thread.id), after_seq: Some(0), ..Default::default() })
        .await
        .unwrap();
    assert!(full.snapshot.is_none());
    assert_eq!(events_until(&legacy, *seqs.last().unwrap()).await.len(), 200);

    // A byte-sized gap: three events of 400 KiB.
    let big = (0..3).map(|_| notice(&host, thread.id, Some(thread.id), "y".repeat(400 * 1024)).seq).collect::<Vec<_>>();
    let large = client
        .call::<EventsSubscribe>(EventsSubscribeParams {
            thread_id: Some(thread.id),
            after_seq: Some(*seqs.last().unwrap()),
            gap_snapshot: Some(get),
            ..Default::default()
        })
        .await
        .unwrap();
    let snapshot = large.snapshot.expect("1.2 MiB of events is a snapshot");
    assert_eq!(snapshot.thread.last_seq, *big.last().unwrap());
}

// ---- the subscribe-then-get order on one socket ----

#[tokio::test]
async fn threads_get_sent_after_events_subscribe_reads_at_or_after_its_head() {
    let host = Host::start().await;
    let thread = host.thread();
    notice(&host, thread.id, Some(thread.id), "Start".into());
    let url = format!("{}/ws?{AUTH_QUERY_PARAM}={}", host.url.replace("http:", "ws:"), host.state.bootstrap_token);
    let (mut socket, _) = connect_async(url).await.unwrap();
    // A busy daemon: events keep landing while each pair of requests is read.
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let (state, stop, thread_id) = (host.state.clone(), stop.clone(), thread.id);
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::sleep(Duration::from_micros(100));
                state
                    .orchestrator
                    .emit(
                        thread_id,
                        Some(thread_id),
                        EventPayload::ProviderNotice { data: None, level: NoticeLevel::Info, text: "tick".into(), problem: None },
                    )
                    .unwrap();
            }
        })
    };
    for round in 0..20 {
        let (subscribe_id, get_id) = (round * 2 + 1, round * 2 + 2);
        let subscribe = json!({"jsonrpc": "2.0", "id": subscribe_id, "method": "events.subscribe", "params": {"thread_id": thread.id}});
        let get =
            json!({"jsonrpc": "2.0", "id": get_id, "method": "threads.get", "params": {"thread_id": thread.id, "transcript_limit": 1}});
        socket.send(Message::Text(subscribe.to_string().into())).await.unwrap();
        socket.send(Message::Text(get.to_string().into())).await.unwrap();
        let (mut head, mut as_of) = (None, None);
        while head.is_none() || as_of.is_none() {
            let Message::Text(text) = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap().unwrap().unwrap() else {
                continue;
            };
            let frame: Value = serde_json::from_str(text.as_str()).unwrap();
            if frame["id"] == subscribe_id {
                head = frame["result"]["head_seq"].as_i64();
            } else if frame["id"] == get_id {
                as_of = frame["result"]["as_of_seq"].as_i64();
            }
        }
        assert!(as_of >= head, "round {round}: as_of_seq {as_of:?} before the subscribe head {head:?}");
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
}

// ---- threads.list cursors and settled limits ----

#[tokio::test]
async fn since_seq_returns_only_changed_rows_archived_ones_and_parents_of_changed_children() {
    let host = Host::start().await;
    let project = project(&host, "cursor");
    let [edited, pinned, archived, quiet] = ["Edited", "Pinned", "Archived", "Quiet"].map(|title| thread_in(&host, &project, title, 5));
    let parent = thread_in(&host, &project, "Parent", 5);
    let mut child = thread_in(&host, &project, "Child", 5);
    child.parent_thread_id = Some(parent.id);
    child.delegation = Some(delegation(parent.id, DelegationStatus::Running));
    host.state.store.thread_upsert(&child).unwrap();
    // Rows written without an event are stamped one past the head. Until the next event they come back from a
    // cursor at that head once more (a redundant row, never a missed one), so the fixture settles with an event.
    notice(&host, edited.id, None, "Setup".into());
    let client = host.client().await;

    let before = client.call::<ThreadsList>(ThreadsListParams { project_id: Some(project.id), ..Default::default() }).await.unwrap();
    let cursor = before.head_seq.expect("cursor daemons always answer with head_seq");
    assert!(before.activity.iter().any(|summary| summary.thread_id == parent.id && summary.active_children == 1));

    // An event, two row writes without one, and a delegated child that finished.
    notice(&host, edited.id, None, "New output".into());
    host.state.store.thread_upsert(&Thread { pinned: true, ..pinned.clone() }).unwrap();
    host.state.store.thread_upsert(&Thread { status: ThreadStatus::Archived, ..archived.clone() }).unwrap();
    child.delegation = Some(delegation(parent.id, DelegationStatus::Completed));
    host.state.store.thread_upsert(&child).unwrap();

    let changed = client
        .call::<ThreadsList>(ThreadsListParams { project_id: Some(project.id), since_seq: Some(cursor), ..Default::default() })
        .await
        .unwrap();
    let ids: BTreeSet<ThreadId> = changed.threads.iter().map(|thread| thread.id).collect();
    assert_eq!(ids, [edited.id, pinned.id, archived.id, parent.id].into_iter().collect(), "quiet {} stays out", quiet.id);
    assert!(changed.threads.iter().any(|thread| thread.id == archived.id && thread.status == ThreadStatus::Archived));
    assert!(changed.threads.iter().any(|thread| thread.id == pinned.id && thread.pinned));
    assert!(!changed.activity.iter().any(|summary| summary.thread_id == parent.id), "the parent's summary is cleared");
    let head = changed.head_seq.unwrap();
    assert!(head >= cursor);

    // The child itself comes back only to clients that list children.
    let with_children = client
        .call::<ThreadsList>(ThreadsListParams { since_seq: Some(cursor), include_subagents: true, ..Default::default() })
        .await
        .unwrap();
    assert!(with_children.threads.iter().any(|thread| thread.id == child.id));

    // After the next event only that thread changed.
    notice(&host, quiet.id, None, "Later".into());
    let next = client.call::<ThreadsList>(ThreadsListParams { since_seq: Some(head), ..Default::default() }).await.unwrap();
    let next_ids: BTreeSet<ThreadId> = next.threads.iter().map(|thread| thread.id).collect();
    assert!(next_ids.contains(&quiet.id));
    assert!(!next_ids.contains(&edited.id), "an event-stamped change is not repeated");

    // Without since_seq the full list comes back as before, archived rows hidden.
    let full = client.call::<ThreadsList>(ThreadsListParams { project_id: Some(project.id), ..Default::default() }).await.unwrap();
    assert_eq!(full.threads.len(), 4, "edited, pinned, quiet and the parent");
    assert!(full.omitted.is_empty());
}

#[tokio::test]
async fn settled_limit_keeps_active_threads_and_counts_the_rest() {
    let host = Host::start().await;
    let first = project(&host, "first");
    let second = project(&host, "second");
    for index in 0..30 {
        thread_in(&host, &first, &format!("Settled {index}"), index + 10);
    }
    for index in 0..3 {
        thread_in(&host, &second, &format!("Other {index}"), index + 10);
    }
    let old_pinned = Thread { pinned: true, ..thread_in(&host, &first, "Pinned", 1000) };
    host.state.store.thread_upsert(&old_pinned).unwrap();
    let running = Thread { status: ThreadStatus::Running, ..thread_in(&host, &first, "Running", 2000) };
    host.state.store.thread_upsert(&running).unwrap();
    let waiting = Thread { status: ThreadStatus::AwaitingApproval, ..thread_in(&host, &first, "Waiting", 3000) };
    host.state.store.thread_upsert(&waiting).unwrap();
    let gone = Thread { status: ThreadStatus::Archived, ..thread_in(&host, &first, "Gone", 1) };
    host.state.store.thread_upsert(&gone).unwrap();
    let client = host.client().await;

    let page = client.call::<ThreadsList>(ThreadsListParams { settled_limit: Some(5), ..Default::default() }).await.unwrap();
    let titles: Vec<&str> = page.threads.iter().map(|thread| thread.title.as_str()).collect();
    for active in ["Pinned", "Running", "Waiting"] {
        assert!(titles.contains(&active), "{active} is always listed");
    }
    assert!(!titles.contains(&"Gone"));
    let settled_first: Vec<&str> = titles.iter().copied().filter(|title| title.starts_with("Settled")).collect();
    assert_eq!(settled_first, ["Settled 0", "Settled 1", "Settled 2", "Settled 3", "Settled 4"], "newest first");
    assert_eq!(titles.iter().filter(|title| title.starts_with("Other")).count(), 3);
    assert_eq!(page.omitted, vec![ProjectThreadCount { project_id: first.id, count: 25 }]);

    let older = client
        .call::<ThreadsList>(ThreadsListParams {
            project_id: Some(first.id),
            settled_limit: Some(5),
            settled_offset: Some(5),
            ..Default::default()
        })
        .await
        .unwrap();
    let older_settled: Vec<&str> =
        older.threads.iter().map(|thread| thread.title.as_str()).filter(|title| title.starts_with("Settled")).collect();
    assert_eq!(older_settled, ["Settled 5", "Settled 6", "Settled 7", "Settled 8", "Settled 9"]);
    assert_eq!(older.omitted, vec![ProjectThreadCount { project_id: first.id, count: 20 }]);

    // Archived threads count only when they are listed.
    let with_archived = client
        .call::<ThreadsList>(ThreadsListParams { settled_limit: Some(5), include_archived: true, ..Default::default() })
        .await
        .unwrap();
    assert_eq!(with_archived.omitted, vec![ProjectThreadCount { project_id: first.id, count: 26 }]);
}

// ---- gzip snapshot over HTTP ----

#[tokio::test]
async fn the_snapshot_route_answers_threads_get_gzipped_when_asked() {
    let host = Host::start().await;
    let thread = host.thread();
    for index in 0..200 {
        notice(&host, thread.id, Some(thread.id), format!("Entry {index}: {}", "readable output ".repeat(20)));
    }
    let url = format!("{}/threads/{}/snapshot", host.url, thread.id);
    let http = reqwest::Client::builder().no_gzip().build().unwrap();
    let body = json!({ "page_budget": FIRST_PAGE, "include_tool_output": false });
    let response =
        http.post(&url).bearer_auth(&host.state.bootstrap_token).header("accept-encoding", "gzip").json(&body).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-encoding"], "gzip");
    let compressed = response.bytes().await.unwrap();
    let mut json = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&compressed[..]), &mut json).unwrap();
    assert!(compressed.len() * 4 < json.len(), "{} -> {}", json.len(), compressed.len());
    let snapshot: ThreadsGetResult = serde_json::from_slice(&json).unwrap();
    let rpc = host
        .client()
        .await
        .call::<ThreadsGet>(ThreadsGetParams {
            thread_id: thread.id,
            page_budget: Some(FIRST_PAGE),
            include_tool_output: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&snapshot.transcript).unwrap(), serde_json::to_value(&rpc.transcript).unwrap());

    let plain = http.post(&url).bearer_auth(&host.state.bootstrap_token).json(&body).send().await.unwrap();
    assert!(plain.headers().get("content-encoding").is_none());
    assert!(serde_json::from_slice::<ThreadsGetResult>(&plain.bytes().await.unwrap()).is_ok());
    let refused = http.post(&url).bearer_auth("kyb_not-a-token").json(&body).send().await.unwrap();
    assert_eq!(refused.status(), 401);
    let missing = http
        .post(format!("{}/threads/{}/snapshot", host.url, Uuid::now_v7()))
        .bearer_auth(&host.state.bootstrap_token)
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
}

// ---- transfer budget ----

/// What a first load may send for a realistic large machine. Budgets have about 2x headroom over what this
/// fixture measures (printed by the test), so a regression that ships whole histories, tool outputs or every
/// settled thread fails here:
/// - `threads.get` first page (client defaults): at most 500 rows and 1.25 MiB. The rows are capped at 1 MiB
///   (plus one row group); the rest is thread state. The long fixture thread is 4,000+ events with 10 MB of
///   tool output and ends in a turn of 30 assistant messages of 100 KB. Measured: 10 rows, 0.96 MiB.
/// - An older page of ordinary turns (10 turns, tool output omitted): at most 128 KiB. Measured: 118 rows, 49 KB.
/// - `threads.list {settled_limit: 25}` over 1,000 threads in 4 projects: at most 120 rows and 160 KiB.
///   Measured: 108 rows, 52 KB (the full list is 1,000 rows, 477 KB).
/// - `threads.list {since_seq}` after one thread changed: at most 3 rows and 8 KiB. Measured: 1 row, 511 B.
#[tokio::test]
async fn a_first_load_stays_inside_its_transfer_budget() {
    const FIRST_PAGE_MAX_BYTES: usize = 1280 * 1024;
    const FIRST_PAGE_MAX_ROWS: usize = 500;
    const OLDER_PAGE_MAX_BYTES: usize = 128 * 1024;
    const LIST_MAX_ROWS: usize = 120;
    const LIST_MAX_BYTES: usize = 160 * 1024;
    const CURSOR_MAX_ROWS: usize = 3;
    const CURSOR_MAX_BYTES: usize = 8 * 1024;

    let host = Host::start().await;
    let projects: Vec<Project> = (0..4).map(|index| project(&host, &format!("project-{index}"))).collect();
    let mut threads = Vec::new();
    for index in 0..1000 {
        threads.push(thread_in(&host, &projects[index % 4], &format!("Thread {index} with a realistic title"), index as i64));
    }
    for thread in threads.iter().take(8) {
        host.state.store.thread_upsert(&Thread { status: ThreadStatus::Running, ..thread.clone() }).unwrap();
    }
    let long = &threads[500];
    let store = &host.state.store;
    for turn in 0..200 {
        let turn_id = Uuid::now_v7();
        store
            .event_append(
                long.id,
                Some(turn_id),
                EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text(format!("Prompt {turn}")) },
            )
            .unwrap();
        for call in 0..10 {
            let id = format!("call-{turn}-{call}");
            store
                .event_append(
                    long.id,
                    Some(turn_id),
                    EventPayload::ToolCallStarted {
                        call: ToolCall { id: id.clone(), name: "Bash".into(), input: json!({ "command": "cargo test" }), parent_id: None },
                        origin: EventOrigin::Root,
                    },
                )
                .unwrap();
            let output = if call % 2 == 0 { json!({ "stdout": "test output line\n".repeat(300) }) } else { json!("ok") };
            store
                .event_append(
                    long.id,
                    Some(turn_id),
                    EventPayload::ToolCallCompleted {
                        tool_call_id: id,
                        output,
                        output_omitted: false,
                        stream_recoverable: false,
                        is_error: false,
                    },
                )
                .unwrap();
        }
        let messages = if turn == 199 { 30 } else { 1 };
        for _ in 0..messages {
            let size = if turn == 199 { 100_000 } else { 2_000 };
            store
                .event_append(
                    long.id,
                    Some(turn_id),
                    EventPayload::AssistantMessageCompleted {
                        message_id: Uuid::now_v7(),
                        origin: EventOrigin::Root,
                        text: "The answer. ".repeat(size / 12),
                        thinking: None,
                    },
                )
                .unwrap();
        }
    }
    let client = host.client().await;

    let first = client
        .call::<ThreadsGet>(ThreadsGetParams {
            thread_id: long.id,
            transcript_limit: Some(60),
            page_budget: Some(FIRST_PAGE),
            include_tool_output: Some(false),
            defer_tool_stream: Some(true),
            whole_turns: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    let first_bytes = wire_bytes(&first);
    let first_rows = first.transcript.len();
    // The rest of the huge last turn is byte-capped too; the pages behind it hold ordinary turns, so the turn
    // budget sizes them: 10 turns of 22 rows.
    let prompts = |page: &ThreadsGetResult| page.transcript.iter().filter(|row| matches!(row, TranscriptEntry::User { .. })).count();
    let mut cursor = first.next_before_seq;
    let older = loop {
        let page = client
            .call::<ThreadsGet>(ThreadsGetParams {
                thread_id: long.id,
                transcript_limit: Some(60),
                page_budget: Some(FIRST_PAGE),
                before_seq: cursor,
                through_seq: Some(first.thread.last_seq),
                include_tool_output: Some(false),
                defer_tool_stream: Some(true),
                whole_turns: Some(true),
                transcript_only: Some(true),
            })
            .await
            .unwrap();
        let bytes = wire_bytes(&page);
        assert!(page.transcript.len() <= FIRST_PAGE_MAX_ROWS && bytes <= FIRST_PAGE_MAX_BYTES, "older page {bytes} B");
        if prompts(&page) == 10 {
            break page;
        }
        cursor = page.next_before_seq;
        assert!(cursor.is_some(), "a page of ordinary turns follows the large one");
    };
    let older_bytes = wire_bytes(&older);
    assert!(older.transcript.len() <= FIRST_PAGE_MAX_ROWS && older_bytes <= OLDER_PAGE_MAX_BYTES, "older page {older_bytes} B");

    let list = client.call::<ThreadsList>(ThreadsListParams { settled_limit: Some(25), ..Default::default() }).await.unwrap();
    let list_bytes = wire_bytes(&list);
    let full = client.call::<ThreadsList>(ThreadsListParams::default()).await.unwrap();

    notice(&host, threads[3].id, None, "One change".into());
    let cursor = client.call::<ThreadsList>(ThreadsListParams { since_seq: list.head_seq, ..Default::default() }).await.unwrap();
    let cursor_bytes = wire_bytes(&cursor);
    println!(
        "first page: {first_rows} rows, {first_bytes} B; older page: {} rows, {older_bytes} B; settled list: {} rows, {list_bytes} B (full list {} rows, {} B); cursor: {} rows, {cursor_bytes} B",
        older.transcript.len(),
        list.threads.len(),
        full.threads.len(),
        wire_bytes(&full),
        cursor.threads.len()
    );
    assert!(first_rows <= FIRST_PAGE_MAX_ROWS && first_bytes <= FIRST_PAGE_MAX_BYTES, "first page {first_rows} rows, {first_bytes} B");
    assert!(first.next_before_seq.is_some(), "a long thread pages");
    assert!(list.threads.len() <= LIST_MAX_ROWS && list_bytes <= LIST_MAX_BYTES, "list {} rows, {list_bytes} B", list.threads.len());
    assert_eq!(list.omitted.iter().map(|count| count.count).sum::<u32>() as usize + list.threads.len(), 1000);
    assert!(
        cursor.threads.len() <= CURSOR_MAX_ROWS && cursor_bytes <= CURSOR_MAX_BYTES,
        "cursor {} rows, {cursor_bytes} B",
        cursor.threads.len()
    );
    assert!(cursor.threads.iter().any(|thread| thread.id == threads[3].id));
}
