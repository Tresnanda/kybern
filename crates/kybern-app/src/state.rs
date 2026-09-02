//! Client-side model. Mirrors the daemon's threads and folds the event stream
//! into per-thread transcripts so views render from local state only.

use std::collections::{BTreeMap, HashMap};

use kybern_protocol::*;

#[derive(Debug, Clone)]
pub struct TranscriptBlock {
    pub id: String,
    pub turn_id: TurnId,
    pub kind: BlockKind,
    pub at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub enum BlockKind {
    User(UserMessage),
    Assistant { text: String, thinking: String, complete: bool },
    Tool { call: ToolCall, output_stream: String, output: Option<serde_json::Value>, is_error: bool, complete: bool },
    Approval { approval: ApprovalRequest, decision: Option<ApprovalDecision> },
    Notice { level: NoticeLevel, text: String },
    TurnEnd { stop_reason: StopReason, usage: Usage, cost_usd: Option<f64>, duration_ms: u64, error: Option<String> },
    Reverted { commit: String },
}

#[derive(Debug, Default, Clone)]
pub struct ThreadState {
    pub thread: Option<Thread>,
    pub blocks: Vec<TranscriptBlock>,
    pub pending_approvals: Vec<ApprovalRequest>,
    pub checkpoints: Vec<Checkpoint>,
    /// Highest event seq folded in; used to skip replayed duplicates.
    pub last_seq: EventSeq,
    pub loaded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    Connecting,
    Connected,
    Lost(String),
}

#[derive(Debug)]
pub struct Model {
    pub connection: Connection,
    pub info: Option<methods::DaemonInfo>,
    pub providers: Vec<ProviderStatus>,
    pub projects: BTreeMap<ProjectId, Project>,
    pub threads: BTreeMap<ThreadId, Thread>,
    pub transcripts: HashMap<ThreadId, ThreadState>,
    pub selected_thread: Option<ThreadId>,
    pub selected_project: Option<ProjectId>,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            connection: Connection::Connecting,
            info: None,
            providers: Vec::new(),
            projects: BTreeMap::new(),
            threads: BTreeMap::new(),
            transcripts: HashMap::new(),
            selected_thread: None,
            selected_project: None,
        }
    }
}

impl Model {
    pub fn thread_state(&mut self, id: ThreadId) -> &mut ThreadState {
        self.transcripts.entry(id).or_default()
    }

    pub fn threads_for_project(&self, project: ProjectId) -> Vec<&Thread> {
        let mut v: Vec<&Thread> = self.threads.values().filter(|t| t.project_id == project && t.status != ThreadStatus::Archived).collect();
        v.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at)));
        v
    }

    pub fn available_providers(&self) -> Vec<&ProviderStatus> {
        self.providers.iter().filter(|p| p.available).collect()
    }

    /// Replace a transcript from a `threads.get` result.
    pub fn load_transcript(&mut self, r: methods::ThreadsGetResult) {
        let id = r.thread.id;
        let last_seq = r.thread.last_seq;
        self.threads.insert(id, r.thread.clone());
        let st = self.thread_state(id);
        st.thread = Some(r.thread);
        st.blocks = r.transcript.into_iter().map(entry_to_block).collect();
        st.pending_approvals = r.pending_approvals;
        st.last_seq = last_seq;
        st.loaded = true;
    }

    /// Fold one live event. Returns true when something visible changed.
    pub fn apply_event(&mut self, ev: ThreadEvent) -> bool {
        let thread_id = ev.thread_id;
        let st = self.transcripts.entry(thread_id).or_default();
        if ev.seq <= st.last_seq {
            return false;
        }
        st.last_seq = ev.seq;
        let turn_id = ev.turn_id.unwrap_or_default();
        let at = ev.at;
        match ev.payload {
            EventPayload::ThreadCreated { thread } | EventPayload::ThreadUpdated { thread } => {
                st.thread = Some(thread.clone());
                self.threads.insert(thread_id, thread);
            }
            EventPayload::ThreadArchived => {
                if let Some(t) = self.threads.get_mut(&thread_id) {
                    t.status = ThreadStatus::Archived;
                }
            }
            EventPayload::TurnStarted { message_id, message } => {
                st.blocks.push(TranscriptBlock { id: message_id.to_string(), turn_id, kind: BlockKind::User(message), at });
            }
            EventPayload::ProviderSessionBound { .. } => {}
            EventPayload::AssistantTextDelta { message_id, delta } => {
                let id = message_id.to_string();
                match st.blocks.iter_mut().rev().find(|b| b.id == id) {
                    Some(TranscriptBlock { kind: BlockKind::Assistant { text, .. }, .. }) => text.push_str(&delta),
                    _ => st.blocks.push(TranscriptBlock { id, turn_id, kind: BlockKind::Assistant { text: delta, thinking: String::new(), complete: false }, at }),
                }
            }
            EventPayload::AssistantThinkingDelta { message_id, delta } => {
                let id = message_id.to_string();
                match st.blocks.iter_mut().rev().find(|b| b.id == id) {
                    Some(TranscriptBlock { kind: BlockKind::Assistant { thinking, .. }, .. }) => thinking.push_str(&delta),
                    _ => st.blocks.push(TranscriptBlock { id, turn_id, kind: BlockKind::Assistant { text: String::new(), thinking: delta, complete: false }, at }),
                }
            }
            EventPayload::AssistantMessageCompleted { message_id, text, thinking } => {
                let id = message_id.to_string();
                match st.blocks.iter_mut().rev().find(|b| b.id == id) {
                    Some(TranscriptBlock { kind: BlockKind::Assistant { text: t, thinking: th, complete }, .. }) => {
                        *t = text;
                        if let Some(x) = thinking {
                            *th = x;
                        }
                        *complete = true;
                    }
                    _ => st.blocks.push(TranscriptBlock { id, turn_id, kind: BlockKind::Assistant { text, thinking: thinking.unwrap_or_default(), complete: true }, at }),
                }
            }
            EventPayload::ToolCallStarted { call } => {
                st.blocks.push(TranscriptBlock { id: format!("tool:{}", call.id), turn_id, kind: BlockKind::Tool { call, output_stream: String::new(), output: None, is_error: false, complete: false }, at });
            }
            EventPayload::ToolCallOutputDelta { tool_call_id, delta } => {
                let id = format!("tool:{tool_call_id}");
                if let Some(TranscriptBlock { kind: BlockKind::Tool { output_stream, .. }, .. }) = st.blocks.iter_mut().rev().find(|b| b.id == id) {
                    output_stream.push_str(&delta);
                }
            }
            EventPayload::ToolCallCompleted { tool_call_id, output, is_error } => {
                let id = format!("tool:{tool_call_id}");
                if let Some(TranscriptBlock { kind: BlockKind::Tool { output: o, is_error: e, complete, .. }, .. }) = st.blocks.iter_mut().rev().find(|b| b.id == id) {
                    *o = Some(output);
                    *e = is_error;
                    *complete = true;
                }
            }
            EventPayload::ApprovalRequested { approval } => {
                st.pending_approvals.push(approval.clone());
                st.blocks.push(TranscriptBlock { id: format!("approval:{}", approval.id), turn_id, kind: BlockKind::Approval { approval, decision: None }, at });
            }
            EventPayload::ApprovalResolved { approval_id, decision } => {
                st.pending_approvals.retain(|a| a.id != approval_id);
                let id = format!("approval:{approval_id}");
                if let Some(TranscriptBlock { kind: BlockKind::Approval { decision: d, .. }, .. }) = st.blocks.iter_mut().rev().find(|b| b.id == id) {
                    *d = Some(decision);
                }
            }
            EventPayload::TurnCompleted { stop_reason, usage, cost_usd, duration_ms } => {
                finish_turn(st, turn_id);
                st.blocks.push(TranscriptBlock { id: format!("end:{turn_id}"), turn_id, kind: BlockKind::TurnEnd { stop_reason, usage, cost_usd, duration_ms, error: None }, at });
            }
            EventPayload::TurnFailed { error } => {
                finish_turn(st, turn_id);
                st.blocks.push(TranscriptBlock { id: format!("end:{turn_id}"), turn_id, kind: BlockKind::TurnEnd { stop_reason: StopReason::Error, usage: Usage::default(), cost_usd: None, duration_ms: 0, error: Some(error) }, at });
            }
            EventPayload::ProviderNotice { level, text, .. } => {
                st.blocks.push(TranscriptBlock { id: format!("notice:{}", ev.seq), turn_id, kind: BlockKind::Notice { level, text }, at });
            }
            EventPayload::CheckpointUpdated { checkpoint } => {
                match st.checkpoints.iter_mut().find(|c| c.turn_id == checkpoint.turn_id) {
                    Some(c) => *c = checkpoint,
                    None => st.checkpoints.push(checkpoint),
                }
            }
            EventPayload::WorkspaceReverted { commit, .. } => {
                st.blocks.push(TranscriptBlock { id: format!("revert:{}", ev.seq), turn_id, kind: BlockKind::Reverted { commit }, at });
            }
        }
        true
    }
}

fn finish_turn(st: &mut ThreadState, turn: TurnId) {
    for b in st.blocks.iter_mut().filter(|b| b.turn_id == turn) {
        match &mut b.kind {
            BlockKind::Assistant { complete, .. } => *complete = true,
            BlockKind::Tool { complete, .. } => *complete = true,
            _ => {}
        }
    }
}

fn entry_to_block(e: TranscriptEntry) -> TranscriptBlock {
    match e {
        TranscriptEntry::User { id, turn_id, message, at } => TranscriptBlock { id: id.to_string(), turn_id, kind: BlockKind::User(message), at },
        TranscriptEntry::Assistant { id, turn_id, text, thinking, at, complete } => {
            TranscriptBlock { id: id.to_string(), turn_id, kind: BlockKind::Assistant { text, thinking: thinking.unwrap_or_default(), complete }, at }
        }
        TranscriptEntry::ToolCall { turn_id, call, output, is_error, complete, at } => {
            TranscriptBlock { id: format!("tool:{}", call.id), turn_id, kind: BlockKind::Tool { call, output_stream: String::new(), output, is_error, complete }, at }
        }
        TranscriptEntry::Approval { turn_id, approval, decision } => {
            TranscriptBlock { id: format!("approval:{}", approval.id), turn_id, at: approval.created_at, kind: BlockKind::Approval { approval, decision } }
        }
        TranscriptEntry::TurnSummary { turn_id, stop_reason, usage, cost_usd, duration_ms, error } => TranscriptBlock {
            id: format!("end:{turn_id}"),
            turn_id,
            kind: BlockKind::TurnEnd { stop_reason, usage, cost_usd, duration_ms, error },
            at: chrono::Utc::now(),
        },
    }
}

/// Short human label for a tool call, used in the transcript and approval cards.
pub fn tool_summary(call: &ToolCall) -> String {
    let short = |key: &str| call.input.get(key).and_then(|v| v.as_str()).map(|s| s.lines().next().unwrap_or("").to_string());
    match call.name.as_str() {
        "Bash" | "bash" | "shell" | "execute" => short("command").unwrap_or_default(),
        "Write" | "Edit" | "MultiEdit" | "Read" | "write" | "edit" | "read" => short("file_path").or_else(|| short("path")).map(|p| shorten_path(&p)).unwrap_or_default(),
        "apply_patch" => call
            .input
            .get("changes")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().filter_map(|c| c.get("path").and_then(|p| p.as_str())).map(shorten_path).collect::<Vec<_>>().join(", "))
            .unwrap_or_default(),
        "WebFetch" | "webfetch" => short("url").unwrap_or_default(),
        "Grep" | "grep" | "Glob" | "glob" => short("pattern").unwrap_or_default(),
        _ => short("title")
            .or_else(|| short("query"))
            .or_else(|| call.input.pointer("/raw/command").and_then(|v| v.as_str()).map(|s| s.lines().next().unwrap_or("").to_string()))
            .or_else(|| short("command"))
            .unwrap_or_default(),
    }
    .trim_matches('`')
    .to_string()
}

pub fn shorten_path(p: &str) -> String {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 3 { p.to_string() } else { format!("…/{}", parts[parts.len() - 3..].join("/")) }
}

pub fn tool_display_name(name: &str) -> &str {
    match name {
        "Bash" | "bash" | "shell" | "execute" => "Ran",
        "Write" | "write" => "Wrote",
        "Edit" | "MultiEdit" | "edit" | "apply_patch" => "Edited",
        "Read" | "read" => "Read",
        "Grep" | "grep" | "Glob" | "glob" | "search" => "Searched",
        "WebFetch" | "webfetch" | "fetch" | "web_search" | "websearch" => "Fetched",
        "Task" | "task" => "Delegated",
        "TodoWrite" | "todowrite" => "Planned",
        _ => name,
    }
}
