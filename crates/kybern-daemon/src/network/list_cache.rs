//! Bounded observations of peer lists for clients without a local offline cache.
use crate::state::AppState;
use chrono::Utc;
use kybern_protocol::{methods::*, *};
use std::time::Duration;

const PREFIX: &str = "network.list_cache.";
const MAX_BYTES: usize = 1024 * 1024;

fn member(state: &AppState, id: &str) -> bool {
    state.network.membership().is_some_and(|m| m.self_is_member() && m.projection().entry(id).is_some_and(|e| e.removed.is_none()))
}

fn bounded(mut value: NetworkListSnapshot) -> NetworkListSnapshot {
    value.threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
    value.threads.truncate(300);
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
        s
    });
    Ok(NetworkCachedListsResult { snapshot })
}

pub async fn refresh(state: &AppState) {
    if !state.settings.get().network.keep_network_data || !state.network.membership().is_some_and(|m| m.self_is_member()) {
        let _ = state.store.meta_delete_prefix(PREFIX);
        return;
    }
    let calls = state.network.peers.links().into_iter().map(|link| async move {
        let status = state.network.peers.status(&link.machine_id);
        if !status.presence.is_some_and(|p| p.features.iter().any(|f| f == features::OFFLINE_LISTS_V1)) {
            return;
        }
        let Ok(Ok(snapshot)) = tokio::time::timeout(Duration::from_secs(5), link.call::<PeerListSnapshot>(Empty {})).await else {
            return;
        };
        if snapshot.machine_id != link.machine_id || !member(state, &link.machine_id) || !state.settings.get().network.keep_network_data {
            return;
        }
        let mut snapshot = bounded(snapshot);
        snapshot.fetched_at = Utc::now();
        snapshot.stale = true;
        if let Ok(raw) = serde_json::to_string(&snapshot) {
            let _ = state.store.meta_set(&format!("{PREFIX}{}", link.machine_id), &raw);
        }
    });
    futures::future::join_all(calls).await;
}
