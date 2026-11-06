//! Bounded observations of peer lists for clients without a local offline cache.
use crate::state::AppState;
use chrono::Utc;
use kybern_protocol::{methods::*, *};
use std::time::Duration;

pub(crate) static CACHE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const PREFIX: &str = "network.list_cache.";
const MAX_BYTES: usize = 1024 * 1024;

fn member(state: &AppState, id: &str) -> bool {
    state.network.membership().is_some_and(|m| m.self_is_member() && m.projection().entry(id).is_some_and(|e| e.removed.is_none()))
}

fn bounded(mut value: NetworkListSnapshot) -> NetworkListSnapshot {
    // Construct the allowlist explicitly: new Thread fields require a privacy review.
    value.threads = value
        .threads
        .into_iter()
        .filter(|t| t.subagent.is_none() && t.inbound.is_none())
        .map(|t| Thread {
            id: t.id,
            project_id: t.project_id,
            title: t.title,
            provider: t.provider,
            model: t.model,
            effort: t.effort,
            permission_mode: t.permission_mode,
            status: t.status,
            pinned: t.pinned,
            created_at: t.created_at,
            updated_at: t.updated_at,
            last_seq: t.last_seq,
            parent_thread_id: t.parent_thread_id,
            coordinator_project_id: t.coordinator_project_id,
            cwd: String::new(),
            worktree: None,
            provider_session_id: None,
            subagent: None,
            delegation: None,
            members: Vec::new(),
            origin: None,
            inbound: None,
            moved: None,
        })
        .collect();
    value.threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
    value.threads.truncate(300);
    value.projects = value
        .projects
        .into_iter()
        .map(|p| Project {
            id: p.id,
            name: p.name,
            path: p.path,
            is_git: p.is_git,
            worktrees_default: p.worktrees_default,
            task_prefix: p.task_prefix,
            brief_in_all_threads: p.brief_in_all_threads,
            coordinator: None,
            space_id: p.space_id,
            kind: p.kind,
            members: p.members,
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: p.instructions_offer_dismissed,
            repo: p.repo,
            repos: p.repos,
            created_at: p.created_at,
            updated_at: p.updated_at,
        })
        .collect();
    value.projects.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    value.projects.truncate(500);
    while serde_json::to_vec(&value).map_or(usize::MAX, |s| s.len()) > MAX_BYTES {
        if value.threads.pop().is_none() && value.projects.pop().is_none() {
            break;
        }
    }
    value
}

pub fn local(state: &AppState) -> Result<NetworkListSnapshot, RpcError> {
    Ok(bounded(NetworkListSnapshot {
        machine_id: state.network.machine_id().unwrap_or_default(),
        fetched_at: Utc::now(),
        stale: false,
        projects: state.store.projects_list().map_err(RpcError::internal)?,
        threads: state.store.threads_list(None, false).map_err(RpcError::internal)?.into_iter().filter(|t| t.subagent.is_none()).collect(),
    }))
}

pub fn read(state: &AppState, params: NetworkCachedListsParams) -> Result<NetworkCachedListsResult, RpcError> {
    let _guard = CACHE_LOCK.lock().unwrap();
    if !state.settings.get().network.keep_network_data {
        state.store.meta_delete_prefix(PREFIX).map_err(RpcError::internal)?;
        return Ok(NetworkCachedListsResult::default());
    }
    if !member(state, &params.machine_id) {
        return Ok(NetworkCachedListsResult::default());
    }
    let raw = state.store.meta_get(&format!("{PREFIX}{}", params.machine_id)).map_err(RpcError::internal)?;
    let snapshot = raw.and_then(|s| serde_json::from_str::<NetworkListSnapshot>(&s).ok()).map(|mut s| {
        s.stale = true;
        bounded(s)
    });
    Ok(NetworkCachedListsResult { snapshot })
}

pub async fn refresh(state: &AppState) {
    {
        let _guard = CACHE_LOCK.lock().unwrap();
        if !state.settings.get().network.keep_network_data || !state.network.membership().is_some_and(|m| m.self_is_member()) {
            let _ = state.store.meta_delete_prefix(PREFIX);
            return;
        }
    }
    let calls = state.network.peers.links().into_iter().map(|link| async move {
        let status = state.network.peers.status(&link.machine_id);
        if !status.presence.is_some_and(|p| p.features.iter().any(|f| f == features::OFFLINE_LISTS_V1)) {
            return;
        }
        let Ok(Ok(snapshot)) = tokio::time::timeout(Duration::from_secs(5), link.call::<PeerListSnapshot>(Empty {})).await else {
            return;
        };
        if snapshot.machine_id == link.machine_id {
            store_snapshot(state, snapshot);
        }
    });
    futures::future::join_all(calls).await;
}

// A response may have started before removal/opt-out. Check under the same lock
// as cleanup, immediately before committing it.
pub(super) fn store_snapshot(state: &AppState, snapshot: NetworkListSnapshot) {
    let _guard = CACHE_LOCK.lock().unwrap();
    if !member(state, &snapshot.machine_id) || !state.settings.get().network.keep_network_data {
        return;
    }
    let mut snapshot = bounded(snapshot);
    snapshot.fetched_at = Utc::now();
    snapshot.stale = true;
    if let Ok(raw) = serde_json::to_string(&snapshot) {
        let _ = state.store.meta_set(&format!("{PREFIX}{}", snapshot.machine_id), &raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_allowlist_drops_transcript_fields() {
        let now = Utc::now();
        let id = uuid::Uuid::now_v7();
        let thread: Thread = serde_json::from_value(serde_json::json!({
            "id":id,"project_id":id,"title":"List title","provider":{"kind":"codex","instance":"default"},
            "permission_mode":"supervised","status":"idle","cwd":"private","pinned":false,
            "created_at":now,"updated_at":now,"last_seq":0,"last_message_preview":"TRANSCRIPT_SENTINEL",
            "delegation":{"task_id":id,"operation_id":id,"parent_thread_id":id,"depth":1,
                "status":"completed","started_at":now,"result":"TRANSCRIPT_SENTINEL",
                "error":"TRANSCRIPT_SENTINEL","files_touched":["TRANSCRIPT_SENTINEL"]}
        }))
        .unwrap();
        let snapshot =
            NetworkListSnapshot { machine_id: "test".into(), fetched_at: now, stale: false, projects: vec![], threads: vec![thread] };
        let wire = serde_json::to_string(&bounded(snapshot)).unwrap();
        assert!(!wire.contains("TRANSCRIPT_SENTINEL"));
        assert!(!wire.contains("private"));
        assert!(wire.contains("List title"));
        let cached = bounded(serde_json::from_str(&wire).unwrap());
        assert!(!serde_json::to_string(&cached).unwrap().contains("TRANSCRIPT_SENTINEL"));
    }
}
