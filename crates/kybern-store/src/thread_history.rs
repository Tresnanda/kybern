//! Bounded, inert thread discovery and persisted message history.
//!
//! Search cursors use immutable creation order and carry a query/scope fingerprint.
//! Message cursors use the append-only event sequence. Neither path hydrates a
//! provider session or decodes unrelated event payloads.

use anyhow::{Result, anyhow, bail, ensure};
use chrono::{DateTime, Utc};
use kybern_protocol::*;
use rusqlite::{Connection, OptionalExtension, named_params};
use serde::{Deserialize, Serialize};

use super::{Store, THREAD_SELECT, parse_time, parse_uuid, row_to_thread};

const MAX_SEARCH_LIMIT: u32 = 100;
const MAX_READ_LIMIT: u32 = 200;
const MAX_SNIPPET_BYTES: usize = 500;
const MAX_TEXT_CHUNK_BYTES: usize = 24 * 1024;
const MAX_PAGE_JSON_BYTES: usize = 192 * 1024;
const MESSAGE_JSON_OVERHEAD: usize = 512;

#[derive(Debug, Clone, Serialize)]
pub struct ThreadHistorySearchPage {
    pub threads: Vec<ThreadSearchHit>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadHistoryReadPage {
    pub thread: Thread,
    pub messages: Vec<ThreadHistoryMessage>,
    pub next_before_seq: Option<EventSeq>,
    pub through_seq: EventSeq,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadHistoryMessage {
    pub seq: EventSeq,
    pub turn_id: Option<TurnId>,
    pub role: ThreadMessageRole,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub attribution: ThreadMessageAttribution,
    /// UTF-8 byte offset of `text` in the complete persisted message.
    pub text_offset: u64,
    /// Pass this with `message_seq` to continue this exact message.
    pub next_text_offset: Option<u64>,
    pub text_truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct SearchCursor {
    version: u8,
    scope: u64,
    snapshot_second: i64,
    snapshot_id: String,
    last_rank: i64,
    last_second: i64,
    last_id: String,
}

#[derive(Debug)]
struct SearchRow {
    thread: Thread,
    rank: i64,
    created_second: i64,
}

#[derive(Debug)]
struct MessageRow {
    seq: EventSeq,
    turn_id: Option<TurnId>,
    at: DateTime<Utc>,
    role: ThreadMessageRole,
    bytes: Vec<u8>,
    total_bytes: u64,
    attribution: ThreadMessageAttribution,
}

impl Store {
    /// Search titles and all settled user/assistant text without projecting
    /// transcripts. `project_id=None` searches every project. A preferred
    /// project is a stable leading partition when searching all projects.
    pub fn search_thread_history(
        &self,
        project_id: Option<ProjectId>,
        preferred_project_id: Option<ProjectId>,
        query: Option<&str>,
        include_archived: bool,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<ThreadHistorySearchPage> {
        ensure!((1..=MAX_SEARCH_LIMIT).contains(&limit), "thread search limit must be 1..={MAX_SEARCH_LIMIT}");
        if project_id.is_some() && preferred_project_id.is_some() {
            bail!("preferred_project_id is only valid for an all-project search");
        }
        let query = query.unwrap_or_default().trim().to_lowercase();
        let scope = search_scope_fingerprint(project_id, preferred_project_id, include_archived, &query);
        self.with(|connection| {
            let decoded = cursor.map(decode_cursor).transpose()?;
            if let Some(decoded) = &decoded {
                ensure!(decoded.version == 1 && decoded.scope == scope, "thread search cursor belongs to another query or scope");
            }
            let (snapshot_second, snapshot_id) = match decoded.as_ref() {
                Some(cursor) => (cursor.snapshot_second, cursor.snapshot_id.clone()),
                None => search_snapshot(connection, project_id, include_archived, &query)?,
            };
            if snapshot_id.is_empty() {
                return Ok(ThreadHistorySearchPage { threads: Vec::new(), next_cursor: None });
            }

            let mut statement = connection.prepare(&search_sql())?;
            let project = project_id.map(|id| id.to_string());
            let preferred = preferred_project_id.map(|id| id.to_string());
            let cursor_rank = decoded.as_ref().map(|value| value.last_rank);
            let cursor_second = decoded.as_ref().map(|value| value.last_second);
            let cursor_id = decoded.as_ref().map(|value| value.last_id.as_str());
            let mut rows = statement.query(named_params! {
                ":project": project,
                ":preferred": preferred,
                ":include_archived": include_archived,
                ":query": query,
                ":snapshot_second": snapshot_second,
                ":snapshot_id": snapshot_id,
                ":cursor_rank": cursor_rank,
                ":cursor_second": cursor_second,
                ":cursor_id": cursor_id,
                ":row_limit": limit + 1,
            })?;
            let mut found = Vec::with_capacity(limit as usize + 1);
            while let Some(row) = rows.next()? {
                found.push(SearchRow { thread: row_to_thread(row)?, rank: row.get(22)?, created_second: row.get(23)? });
            }
            let has_more = found.len() > limit as usize;
            found.truncate(limit as usize);
            let next_cursor = if has_more {
                let last = found.last().expect("bounded nonempty search page");
                Some(encode_cursor(&SearchCursor {
                    version: 1,
                    scope,
                    snapshot_second,
                    snapshot_id,
                    last_rank: last.rank,
                    last_second: last.created_second,
                    last_id: last.thread.id.to_string(),
                })?)
            } else {
                None
            };
            let mut hits = Vec::with_capacity(found.len());
            for row in found {
                let title_matches = !query.is_empty() && row.thread.title.to_lowercase().contains(&query);
                let (snippet, matched_at) = message_snippet(connection, row.thread.id, &query, !query.is_empty() && !title_matches)?;
                hits.push(ThreadSearchHit { thread: row.thread, snippet, matched_at });
            }
            let page = ThreadHistorySearchPage { threads: hits, next_cursor };
            ensure!(serde_json::to_vec(&page)?.len() <= 256 * 1024, "thread search result exceeds the 256 KiB limit");
            Ok(page)
        })
    }

    /// Read settled messages newest-page-first but return each page in
    /// conversation order. `message_seq` selects one message text continuation;
    /// `text_offset > 0` is invalid without it.
    pub fn read_thread_history(
        &self,
        thread_id: ThreadId,
        before_seq: Option<EventSeq>,
        through_seq: Option<EventSeq>,
        limit: u32,
        message_seq: Option<EventSeq>,
        text_offset: Option<u64>,
    ) -> Result<ThreadHistoryReadPage> {
        ensure!((1..=MAX_READ_LIMIT).contains(&limit), "thread history limit must be 1..={MAX_READ_LIMIT}");
        ensure!(before_seq.is_none_or(|seq| seq >= 0) && through_seq.is_none_or(|seq| seq >= 0), "history cursors must be nonnegative");
        let offset = text_offset.unwrap_or(0);
        ensure!(offset == 0 || message_seq.is_some(), "message_seq is required when text_offset is nonzero");
        ensure!(message_seq.is_none() || before_seq.is_none(), "before_seq cannot be combined with message_seq");
        ensure!(message_seq.is_none() || through_seq.is_some(), "through_seq is required when continuing an exact message");

        self.with(|connection| {
            let mut thread = connection
                .query_row(&format!("{THREAD_SELECT} WHERE id=?1"), [thread_id.to_string()], row_to_thread)
                .optional()?
                .ok_or_else(|| anyhow!("thread not found"))?;
            let through = through_seq.unwrap_or(thread.last_seq).min(thread.last_seq);
            thread.last_seq = through;
            if let Some(seq) = message_seq {
                ensure!(seq <= through, "message_seq is newer than through_seq");
            }
            let row_limit = if message_seq.is_some() { 1 } else { limit + 1 };
            let mut statement = connection.prepare(&read_sql())?;
            let mut rows = statement.query(named_params! {
                ":thread_id": thread_id.to_string(),
                ":through_seq": through,
                ":before_seq": before_seq,
                ":message_seq": message_seq,
                ":text_offset": i64::try_from(offset).map_err(|_| anyhow!("text_offset is too large"))?,
                ":chunk_bytes": MAX_TEXT_CHUNK_BYTES as i64 + 4,
                ":row_limit": row_limit,
            })?;
            let mut messages = Vec::with_capacity(limit as usize);
            let mut json_budget = MAX_PAGE_JSON_BYTES;
            let mut has_more = false;
            while let Some(row) = rows.next()? {
                if message_seq.is_none() && messages.len() == limit as usize {
                    has_more = true;
                    break;
                }
                let raw = read_message_row(row, thread_id)?;
                let allowance = json_budget.saturating_sub(MESSAGE_JSON_OVERHEAD);
                if !page_allows_message(allowance, !messages.is_empty()) {
                    has_more = true;
                    break;
                }
                let message = finish_message(raw, offset, allowance.max(2))?;
                let cost = serde_json::to_vec(&message.text)?.len() + MESSAGE_JSON_OVERHEAD;
                if cost > json_budget && !messages.is_empty() {
                    has_more = true;
                    break;
                }
                json_budget = json_budget.saturating_sub(cost);
                messages.push(message);
            }
            if message_seq.is_none() {
                messages.reverse();
            }
            ensure!(message_seq.is_none() || !messages.is_empty(), "message_seq does not identify a settled message");
            let next_before_seq =
                (message_seq.is_none() && has_more).then(|| messages.first().expect("history page with continuation is nonempty").seq);
            let page = ThreadHistoryReadPage { thread, messages, next_before_seq, through_seq: through };
            ensure!(serde_json::to_vec(&page)?.len() <= 256 * 1024, "thread history result exceeds the 256 KiB limit");
            Ok(page)
        })
    }
}

fn search_sql() -> String {
    format!(
        "WITH candidates AS (
           SELECT t.*,
             CASE WHEN :preferred IS NOT NULL AND t.project_id=:preferred THEN 0 ELSE 1 END AS preference_rank,
             CAST(strftime('%s',t.created_at) AS INTEGER) AS created_second
           FROM threads t
           WHERE (:project IS NULL OR t.project_id=:project)
             AND t.subagent IS NULL
             AND (:include_archived OR t.status!='archived')
             AND (:query='' OR instr(lower(t.title),:query)>0 OR {message_match})
         )
         SELECT id,project_id,title,provider_kind,provider_instance,model,effort,permission_mode,status,
                worktree_path,worktree_branch,cwd,provider_session_id,pinned,created_at,updated_at,last_seq,
                parent_thread_id,coordinator_project_id,collaboration_group_id,subagent,delegation,preference_rank,created_second
         FROM candidates
         WHERE (created_second<:snapshot_second OR (created_second=:snapshot_second AND id<=:snapshot_id))
           AND (:cursor_rank IS NULL OR preference_rank>:cursor_rank
             OR (preference_rank=:cursor_rank AND (created_second<:cursor_second
               OR (created_second=:cursor_second AND id<:cursor_id))))
         ORDER BY preference_rank,created_second DESC,id DESC LIMIT :row_limit",
        message_match = message_match_sql("t.id")
    )
}

fn search_snapshot(connection: &Connection, project_id: Option<ProjectId>, include_archived: bool, query: &str) -> Result<(i64, String)> {
    let sql = format!(
        "SELECT CAST(strftime('%s',t.created_at) AS INTEGER),t.id FROM threads t
         WHERE (:project IS NULL OR t.project_id=:project) AND t.subagent IS NULL AND (:include_archived OR t.status!='archived')
           AND (:query='' OR instr(lower(t.title),:query)>0 OR {})
         ORDER BY CAST(strftime('%s',t.created_at) AS INTEGER) DESC,t.id DESC LIMIT 1",
        message_match_sql("t.id")
    );
    Ok(connection
        .query_row(
            &sql,
            named_params! { ":project": project_id.map(|id| id.to_string()), ":include_archived": include_archived, ":query": query },
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, String::new())))
}

fn message_match_sql(thread_column: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM events e WHERE e.thread_id={thread_column}
          AND e.kind IN ('turn_started','assistant_message_completed')
          AND instr(lower(CASE WHEN e.kind='assistant_message_completed'
            THEN COALESCE(json_extract(e.payload,'$.text'),'') ELSE {user_text} END),:query)>0)",
        user_text = user_text_sql("e.payload", false)
    )
}

fn user_text_sql(payload: &str, include_thread_id: bool) -> String {
    let thread_reference = if include_thread_id {
        "'@thread['||COALESCE(json_extract(part.value,'$.thread_id'),'')||'] '||COALESCE(json_extract(part.value,'$.title'),'')"
    } else {
        "'@'||COALESCE(json_extract(part.value,'$.title'),'')"
    };
    format!(
        "COALESCE((SELECT group_concat(CASE json_extract(part.value,'$.type')
          WHEN 'text' THEN COALESCE(json_extract(part.value,'$.text'),'')
          WHEN 'file_mention' THEN '@'||COALESCE(json_extract(part.value,'$.path'),'')
          WHEN 'thread_reference' THEN {thread_reference}
          WHEN 'skill' THEN '$'||COALESCE(json_extract(part.value,'$.name'),'')
          WHEN 'mention' THEN '@'||COALESCE(json_extract(part.value,'$.display_name'),json_extract(part.value,'$.name'),'')
          WHEN 'thread_message' THEN COALESCE(json_extract(part.value,'$.body'),'')
          WHEN 'agent_results' THEN COALESCE((SELECT group_concat(COALESCE(json_extract(item.value,'$.title'),'')||' '||
            COALESCE(json_extract(item.value,'$.result'),json_extract(item.value,'$.error'),''),' ')
            FROM json_each(json_extract(part.value,'$.items')) item),'')
          WHEN 'image' THEN '[image]'
          WHEN 'attachment' THEN '['||COALESCE(json_extract(part.value,'$.name'),'')||']'
          ELSE '' END,'') FROM json_each(json_extract({payload},'$.message.parts')) part),'')"
    )
}

fn message_snippet(
    connection: &Connection,
    thread_id: ThreadId,
    query: &str,
    require_match: bool,
) -> Result<(Option<String>, Option<DateTime<Utc>>)> {
    let user_text = user_text_sql("e.payload", false);
    let assistant_text = corrected_assistant_text_sql("e", "9223372036854775807");
    let sql = format!(
        "WITH texts AS (SELECT e.at,e.seq,CASE WHEN e.kind='assistant_message_completed'
           THEN CASE WHEN :require_match THEN COALESCE(json_extract(e.payload,'$.text'),'') ELSE {assistant_text} END ELSE {user_text} END AS text
         FROM events e WHERE e.thread_id=:thread_id AND e.kind IN ('turn_started','assistant_message_completed'))
         SELECT CAST(substr(CAST(text AS BLOB),1,:bytes) AS BLOB),length(CAST(text AS BLOB)),at
         FROM texts WHERE NOT :require_match OR instr(lower(text),:query)>0 ORDER BY seq DESC LIMIT 1"
    );
    let row: Option<(Vec<u8>, i64, String)> = connection
        .query_row(
            &sql,
            named_params! { ":thread_id": thread_id.to_string(), ":bytes": MAX_SNIPPET_BYTES as i64 + 4, ":require_match": require_match, ":query": query },
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((bytes, total, at)) = row else { return Ok((None, None)) };
    let mut snippet = valid_utf8_prefix(&bytes, MAX_SNIPPET_BYTES)?.to_owned();
    if snippet.len() < usize::try_from(total.max(0)).unwrap_or(usize::MAX) {
        while snippet.len() + '…'.len_utf8() > MAX_SNIPPET_BYTES {
            snippet.pop();
        }
        snippet.push('…');
    }
    Ok((Some(snippet), Some(parse_time(at).map_err(anyhow::Error::from)?)))
}

/// Select the semantic final answer while keeping immutable event/cursor identity.
/// The partial recovery index makes the usual no-correction case a cheap lookup.
pub(crate) fn corrected_assistant_text_sql(event: &str, through: &str) -> String {
    format!(
        "COALESCE((SELECT json_extract(r.payload,'$.blocks[#-1].text') FROM events r
        WHERE r.thread_id={event}.thread_id AND r.turn_id={event}.turn_id
          AND r.kind='assistant_message_blocks_recovered' AND r.seq<={through}
          AND json_extract(r.payload,'$.message_id')=json_extract({event}.payload,'$.message_id')
        ORDER BY r.seq DESC LIMIT 1),json_extract({event}.payload,'$.text'),'')"
    )
}

fn read_sql() -> String {
    let assistant_text = corrected_assistant_text_sql("e", ":through_seq");
    let user_text = user_text_sql("e.payload", true);
    format!(
        "WITH texts AS (
          SELECT e.seq,e.turn_id,e.at,e.kind,
            CASE WHEN cm.payload IS NOT NULL THEN COALESCE(json_extract(cm.payload,'$.body'),'')
                 WHEN e.kind='assistant_message_completed' THEN {assistant_text}
                 ELSE {user_text} END AS text,
            json_extract(cm.payload,'$.from_thread_id') AS source_thread_id,
            json_extract(cm.payload,'$.id') AS collaboration_message_id
          FROM events e LEFT JOIN collaboration_messages cm
            ON cm.delivery_message_id=json_extract(e.payload,'$.message_id')
          WHERE e.thread_id=:thread_id AND e.kind IN ('turn_started','assistant_message_completed')
            AND e.seq<=:through_seq AND (:message_seq IS NOT NULL OR :before_seq IS NULL OR e.seq<:before_seq)
            AND (:message_seq IS NULL OR e.seq=:message_seq)
        )
        SELECT seq,turn_id,at,kind,
          CAST(substr(CAST(text AS BLOB),:text_offset+1,:chunk_bytes) AS BLOB),
          length(CAST(text AS BLOB)),source_thread_id,collaboration_message_id
        FROM texts ORDER BY seq DESC LIMIT :row_limit"
    )
}

fn read_message_row(row: &rusqlite::Row<'_>, thread_id: ThreadId) -> Result<MessageRow> {
    let kind: String = row.get(3)?;
    let source_thread: Option<String> = row.get(6)?;
    let collaboration_message: Option<String> = row.get(7)?;
    let role = if kind == "assistant_message_completed" { ThreadMessageRole::Assistant } else { ThreadMessageRole::User };
    let attribution = if let Some(id) = collaboration_message {
        ThreadMessageAttribution {
            kind: ThreadMessageAttributionKind::Collaboration,
            thread_id: source_thread.map(parse_uuid).transpose()?,
            collaboration_message_id: Some(parse_uuid(id)?),
        }
    } else if role == ThreadMessageRole::Assistant {
        ThreadMessageAttribution { kind: ThreadMessageAttributionKind::Agent, thread_id: Some(thread_id), collaboration_message_id: None }
    } else {
        ThreadMessageAttribution { kind: ThreadMessageAttributionKind::User, thread_id: None, collaboration_message_id: None }
    };
    Ok(MessageRow {
        seq: row.get(0)?,
        turn_id: row.get::<_, Option<String>>(1)?.map(parse_uuid).transpose()?,
        at: parse_time(row.get(2)?)?,
        role,
        bytes: row.get(4)?,
        total_bytes: u64::try_from(row.get::<_, i64>(5)?).map_err(|_| anyhow!("stored message has an invalid byte length"))?,
        attribution,
    })
}

fn finish_message(row: MessageRow, offset: u64, json_allowance: usize) -> Result<ThreadHistoryMessage> {
    ensure!(offset <= row.total_bytes, "text_offset is beyond the message text");
    let candidate = valid_utf8_prefix(&row.bytes, MAX_TEXT_CHUNK_BYTES)?;
    let text = candidate[..json_prefix_bytes(candidate, json_allowance)?].to_owned();
    ensure!(!text.is_empty() || offset == row.total_bytes, "JSON result budget is too small to make progress through message text");
    let next = offset + text.len() as u64;
    let truncated = next < row.total_bytes;
    Ok(ThreadHistoryMessage {
        seq: row.seq,
        turn_id: row.turn_id,
        role: row.role,
        text,
        created_at: row.at,
        attribution: row.attribution,
        text_offset: offset,
        next_text_offset: truncated.then_some(next),
        text_truncated: truncated,
    })
}

fn page_allows_message(json_allowance: usize, already_has_messages: bool) -> bool {
    // Two quotes plus the largest single-character JSON escape. Ending the
    // page here guarantees that a later row cannot turn prior valid results
    // into a whole-request error merely because only 1..7 bytes remain.
    !already_has_messages || json_allowance >= 8
}

fn valid_utf8_prefix(bytes: &[u8], max_bytes: usize) -> Result<&str> {
    let end = bytes.len().min(max_bytes);
    match std::str::from_utf8(&bytes[..end]) {
        Ok(text) => Ok(text),
        Err(error) if error.error_len().is_none() => Ok(std::str::from_utf8(&bytes[..error.valid_up_to()])?),
        Err(error) => Err(anyhow!("stored message text is not UTF-8 at byte {}", error.valid_up_to())),
    }
}

/// Return a UTF-8 byte boundary whose JSON string encoding fits `budget`.
/// `serde_json` emits two surrounding quotes and escapes JSON controls.
fn json_prefix_bytes(text: &str, budget: usize) -> Result<usize> {
    ensure!(budget >= 2, "JSON result budget is too small for message text");
    let mut encoded = 2usize;
    for (index, character) in text.char_indices() {
        let cost = match character {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            '\u{0}'..='\u{1f}' => 6,
            _ => character.len_utf8(),
        };
        if encoded + cost > budget {
            return Ok(index);
        }
        encoded += cost;
    }
    Ok(text.len())
}

fn search_scope_fingerprint(
    project_id: Option<ProjectId>,
    preferred_project_id: Option<ProjectId>,
    include_archived: bool,
    query: &str,
) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in format!(
        "{}|{}|{}|{}",
        project_id.map_or(String::new(), |id| id.to_string()),
        preferred_project_id.map_or(String::new(), |id| id.to_string()),
        include_archived,
        query
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn encode_cursor(cursor: &SearchCursor) -> Result<String> {
    Ok(hex_encode(&serde_json::to_vec(cursor)?))
}

fn decode_cursor(value: &str) -> Result<SearchCursor> {
    serde_json::from_slice(&hex_decode(value)?).map_err(|_| anyhow!("invalid thread search cursor"))
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>> {
    let bytes = value.as_bytes();
    if !value.is_ascii() || !bytes.len().is_multiple_of(2) || bytes.len() > 2048 {
        bail!("invalid thread search cursor");
    }
    bytes.as_chunks::<2>().0.iter().map(|pair| Ok((hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?)).collect()
}

fn hex_nibble(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => bail!("invalid thread search cursor"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert_project(store: &Store, id: ProjectId, now: DateTime<Utc>) {
        store
            .project_insert(&Project {
                id,
                name: "History fixture".into(),
                path: format!("/tmp/{id}"),
                is_git: false,
                worktrees_default: Some(false),
                task_prefix: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
    }

    fn thread(project_id: ProjectId, title: &str, created_at: DateTime<Utc>) -> Thread {
        Thread {
            id: uuid::Uuid::now_v7(),
            project_id,
            title: title.into(),
            provider: ProviderInstance { kind: ProviderKind::Codex, instance: "default".into() },
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: "/tmp".into(),
            provider_session_id: None,
            pinned: false,
            created_at,
            updated_at: created_at,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
            subagent: None,
            delegation: None,
        }
    }

    #[test]
    fn recovered_answer_overlays_semantic_reads_without_rewriting_source_or_snapshot() {
        let store = Store::open_in_memory().unwrap();
        let now = Utc::now();
        let project = uuid::Uuid::now_v7();
        insert_project(&store, project, now);
        let thread = thread(project, "OMP recovery", now);
        store.thread_upsert(&thread).unwrap();
        let mut events: Vec<ThreadEvent> =
            serde_json::from_str(include_str!("../../../fixtures/transcript/omp-recovered-boundaries.json")).unwrap();
        let correction = events.pop().unwrap();
        for event in events {
            store.event_append(thread.id, event.turn_id, event.payload).unwrap();
        }
        let original = store.events_for_thread(thread.id).unwrap();
        let through = original.last().unwrap().seq;
        let before = store.read_thread_history(thread.id, None, Some(through), 10, None, None).unwrap();
        let assistant = before.messages.iter().find(|m| m.role == ThreadMessageRole::Assistant).unwrap();
        let original_text = assistant.text.clone();
        let source_seq = assistant.seq;
        let EventPayload::AssistantMessageBlocksRecovered { blocks, .. } = &correction.payload else { unreachable!() };
        let exact = blocks.last().unwrap().text.clone();
        store.event_append(thread.id, correction.turn_id, correction.payload).unwrap();
        let after = store.read_thread_history(thread.id, None, None, 10, None, None).unwrap();
        let recovered = after.messages.iter().find(|m| m.role == ThreadMessageRole::Assistant).unwrap();
        assert_eq!(recovered.text, exact);
        assert_eq!(recovered.seq, source_seq);
        assert_eq!(recovered.attribution.thread_id, Some(thread.id));
        let frozen = store.read_thread_history(thread.id, None, Some(through), 10, None, None).unwrap();
        assert_eq!(frozen.messages.iter().find(|m| m.role == ThreadMessageRole::Assistant).unwrap().text, original_text);
        let canonical = store.thread_message_events(thread.id, after.through_seq, None, 10).unwrap();
        assert!(canonical.iter().any(|e| matches!(&e.payload, EventPayload::AssistantMessageCompleted { text, .. } if text == &exact)));
        assert_eq!(
            serde_json::to_value(store.events_for_thread_through(thread.id, through).unwrap()).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        let continued = store
            .read_thread_history(thread.id, None, Some(after.through_seq), 1, Some(source_seq), Some("Recovered answer\n\n".len() as u64))
            .unwrap();
        assert_eq!(continued.messages[0].text, exact["Recovered answer\n\n".len()..]);
    }

    #[test]
    fn search_matches_old_messages_and_cursor_is_scope_bound_and_update_stable() {
        let store = Store::open_in_memory().unwrap();
        let project = uuid::Uuid::now_v7();
        let now = Utc::now();
        insert_project(&store, project, now);
        let mut first = thread(project, "Duplicate", now - chrono::Duration::seconds(2));
        let second = thread(project, "Duplicate", now - chrono::Duration::seconds(1));
        store.thread_upsert(&first).unwrap();
        store.thread_upsert(&second).unwrap();
        store
            .event_append(
                first.id,
                Some(uuid::Uuid::now_v7()),
                EventPayload::TurnStarted { message_id: uuid::Uuid::now_v7(), message: UserMessage::text("needle in an old turn") },
            )
            .unwrap();
        store
            .event_append(
                first.id,
                Some(uuid::Uuid::now_v7()),
                EventPayload::AssistantMessageCompleted {
                    message_id: uuid::Uuid::now_v7(),
                    origin: EventOrigin::default(),
                    text: "newest unrelated answer".into(),
                    thinking: None,
                },
            )
            .unwrap();

        let page = store.search_thread_history(Some(project), None, Some("needle"), false, None, 1).unwrap();
        assert_eq!(page.threads[0].thread.id, first.id);
        assert!(page.threads[0].snippet.as_deref().unwrap().contains("needle"));

        let page = store.search_thread_history(Some(project), None, None, false, None, 1).unwrap();
        let cursor = page.next_cursor.unwrap();
        first.updated_at = now + chrono::Duration::hours(1);
        store.thread_upsert(&first).unwrap();
        let next = store.search_thread_history(Some(project), None, None, false, Some(&cursor), 1).unwrap();
        assert_eq!(next.threads.len(), 1);
        assert_ne!(next.threads[0].thread.id, page.threads[0].thread.id);
        assert!(store.search_thread_history(Some(project), None, Some("other"), false, Some(&cursor), 1).is_err());
        assert!(store.search_thread_history(Some(project), None, None, false, Some("💥"), 1).is_err());
    }

    fn subagent_info(root: ThreadId, task_id: &str) -> SubagentInfo {
        SubagentInfo {
            task_id: task_id.into(),
            root_thread_id: root,
            parent_turn_id: uuid::Uuid::now_v7(),
            tool_call_id: Some("toolu_1".into()),
            provider_thread_id: None,
            agent_type: Some("Explore".into()),
            status: RuntimeTaskStatus::Running,
            backgrounded: false,
            last_tool_name: None,
            detail: None,
            progress: None,
            result: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities::default(),
            transcript: true,
            started_at: Utc::now(),
            completed_at: None,
        }
    }

    #[test]
    fn migration_17_adds_the_subagent_marker_without_touching_existing_threads() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::migrate_to(&conn, 16).unwrap();
        conn.execute_batch(
            "INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES ('p1', 'kybern', '/k', 0, '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00');
             INSERT INTO threads(id, project_id, title, provider_kind, provider_instance, permission_mode, status, cwd, created_at, updated_at, last_seq, pinned)
               VALUES ('t1', 'p1', 'Old thread', 'codex', 'codex', 'supervised', 'idle', '/k', '2026-09-01T00:00:00+00:00', '2026-09-02T00:00:00+00:00', 0, 0);",
        )
        .unwrap();
        crate::schema::migrate(&conn).unwrap();
        let subagent: Option<String> = conn.query_row("SELECT subagent FROM threads WHERE id = 't1'", [], |r| r.get(0)).unwrap();
        assert!(subagent.is_none());
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), crate::schema::migration_count() as i64);
    }

    #[test]
    fn subagent_threads_roundtrip_are_found_by_task_and_stay_out_of_search() {
        let store = Store::open_in_memory().unwrap();
        let project = uuid::Uuid::now_v7();
        let now = Utc::now();
        insert_project(&store, project, now);
        let root = thread(project, "needle parent", now);
        store.thread_upsert(&root).unwrap();
        let mut child = thread(project, "needle child", now);
        child.parent_thread_id = Some(root.id);
        child.subagent = Some(subagent_info(root.id, "task-1"));
        store.thread_upsert(&child).unwrap();

        let found = store.subagent_thread_find(root.id, "task-1").unwrap().unwrap();
        assert_eq!(found.id, child.id);
        assert_eq!(found.subagent, child.subagent);
        assert!(store.subagent_thread_find(root.id, "other").unwrap().is_none());
        assert_eq!(store.subagent_children(root.id).unwrap().len(), 1);
        assert!(store.subagent_children(child.id).unwrap().is_empty());
        // A task maps to exactly one child thread.
        let mut duplicate = thread(project, "dup", now);
        duplicate.subagent = Some(subagent_info(root.id, "task-1"));
        assert!(store.thread_upsert(&duplicate).is_err());
        // An ordinary write never drops the marker.
        let mut plain = found.clone();
        plain.subagent = None;
        plain.title = "renamed".into();
        store.thread_upsert(&plain).unwrap();
        assert!(store.thread_get(child.id).unwrap().unwrap().subagent.is_some());

        assert_eq!(store.threads_list(None, false).unwrap().len(), 2);
        let page = store.search_thread_history(Some(project), None, Some("needle"), false, None, 10).unwrap();
        assert_eq!(page.threads.len(), 1);
        assert_eq!(page.threads[0].thread.id, root.id);
        let page = store.search_thread_history(Some(project), None, None, false, None, 10).unwrap();
        assert!(page.threads.iter().all(|hit| hit.thread.subagent.is_none()));
    }

    #[test]
    fn read_pages_by_sequence_and_continues_json_heavy_giant_text() {
        let store = Store::open_in_memory().unwrap();
        let project = uuid::Uuid::now_v7();
        insert_project(&store, project, Utc::now());
        let thread = thread(project, "History", Utc::now());
        store.thread_upsert(&thread).unwrap();
        let first = store
            .event_append(
                thread.id,
                Some(uuid::Uuid::now_v7()),
                EventPayload::TurnStarted {
                    message_id: uuid::Uuid::now_v7(),
                    message: UserMessage {
                        parts: vec![ContentPart::ThreadReference {
                            thread_id: thread.id,
                            title: "Source".into(),
                            project_id: Some(project),
                        }],
                    },
                },
            )
            .unwrap();
        let giant = "\n\"\\".repeat(20_000);
        let second = store
            .event_append(
                thread.id,
                Some(uuid::Uuid::now_v7()),
                EventPayload::AssistantMessageCompleted {
                    message_id: uuid::Uuid::now_v7(),
                    origin: EventOrigin::default(),
                    text: giant.clone(),
                    thinking: None,
                },
            )
            .unwrap();
        let page = store.read_thread_history(thread.id, None, None, 2, None, None).unwrap();
        assert_eq!(page.messages[0].seq, first.seq);
        assert!(page.messages[0].text.contains("@thread["));
        let chunk = &page.messages[1];
        assert_eq!(chunk.seq, second.seq);
        assert!(chunk.text_truncated);
        assert!(
            serde_json::to_vec(&page.messages.iter().map(|message| &message.text).collect::<Vec<_>>()).unwrap().len() < MAX_PAGE_JSON_BYTES
        );
        let continued =
            store.read_thread_history(thread.id, None, Some(page.through_seq), 1, Some(second.seq), chunk.next_text_offset).unwrap();
        assert_eq!(continued.messages[0].text_offset, chunk.next_text_offset.unwrap());
        assert!(!continued.messages[0].text.is_empty());

        let escaped = "\"\\\n".repeat(10_000);
        let prefix = json_prefix_bytes(&escaped, 19).unwrap();
        assert!(prefix > 0 && prefix < escaped.len());
        assert!(serde_json::to_vec(&escaped[..prefix]).unwrap().len() <= 19);
        assert_eq!(json_prefix_bytes(&escaped, 3).unwrap(), 0);
        assert!(!page_allows_message(7, true));
        assert!(page_allows_message(8, true));
        assert!(page_allows_message(2, false));
    }
}
