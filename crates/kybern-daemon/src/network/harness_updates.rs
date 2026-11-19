//! **Update on all machines** for harnesses (`harness_updates.run_all`), the way `network.update_all` updates
//! Kybern itself: this machine queues its own updates and asks each online member with
//! `peer.harness_updates.run`. Every machine decides for itself which of its harnesses have a newer version
//! and waits until each one is idle there. The result lists every member once, started or skipped with the
//! reason.

use std::time::Duration;

use kybern_protocol::methods::{HarnessUpdatesRunAllResult, HarnessUpdatesStarted, PeerHarnessUpdatesRun};
use kybern_protocol::{
    MachineId, NetworkUpdateSkipped, PeerHarnessUpdatesRunParams, PeerHarnessUpdatesRunResult, ProviderKind, RpcError, codes, features,
};

use crate::state::AppState;

/// How long one member gets to answer.
const ASK_BUDGET: Duration = Duration::from_secs(15);

/// `harness_updates.run_all`. Without a network it is this machine alone.
pub async fn run_all(state: &AppState, kinds: &[ProviderKind]) -> HarnessUpdatesRunAllResult {
    let mut result = HarnessUpdatesRunAllResult { started: Vec::new(), skipped: Vec::new() };
    let membership = state.network.membership().filter(|membership| state.network.is_enabled() && membership.self_is_member());
    let Some(membership) = membership else {
        let answer = crate::harness_updates::start_local(state, kinds);
        record(&mut result, &state.environment_id, answer);
        return result;
    };
    let me = membership.machine_id();
    let members: Vec<MachineId> = membership.projection().members().map(|(id, _)| id.clone()).collect();
    let mut asked = Vec::new();
    for id in &members {
        if *id == me {
            let answer = crate::harness_updates::start_local(state, kinds);
            record(&mut result, id, answer);
            continue;
        }
        let Some(link) = state.network.peers.link(id) else {
            result.skipped.push(NetworkUpdateSkipped { machine_id: id.clone(), reason: "Offline".into() });
            continue;
        };
        let presence = state.network.peers.status(id).presence;
        if let Some(presence) = &presence
            && !presence.features.iter().any(|feature| feature == features::HARNESS_UPDATE_V1)
        {
            result.skipped.push(NetworkUpdateSkipped { machine_id: id.clone(), reason: needs_newer(&presence.version) });
            continue;
        }
        asked.push((id.clone(), link));
    }
    // Members answer on their own sessions at the same time; one slow machine does not hold the rest.
    let answers = futures::future::join_all(asked.into_iter().map(|(id, link)| {
        let params = PeerHarnessUpdatesRunParams { kinds: kinds.to_vec() };
        async move { (id, tokio::time::timeout(ASK_BUDGET, link.call::<PeerHarnessUpdatesRun>(params)).await) }
    }))
    .await;
    for (id, answer) in answers {
        match answer {
            Ok(Ok(answer)) => record(&mut result, &id, answer),
            Ok(Err(error)) => result.skipped.push(NetworkUpdateSkipped { machine_id: id, reason: describe_failure(&error) }),
            Err(_) => result.skipped.push(NetworkUpdateSkipped { machine_id: id, reason: "It did not answer in time".into() }),
        }
    }
    // Members in the order the network lists them, not the order their answers arrived.
    let position = |id: &MachineId| members.iter().position(|member| member == id).unwrap_or(usize::MAX);
    result.started.sort_by_key(|started| position(&started.machine_id));
    result.skipped.sort_by_key(|skipped| position(&skipped.machine_id));
    result
}

fn needs_newer(version: &str) -> String {
    format!("Running Kybern {version}, which cannot update its harnesses from here. Update Kybern there first")
}

fn describe_failure(error: &RpcError) -> String {
    match error.code {
        codes::METHOD_NOT_FOUND => "It runs an older Kybern that cannot update its harnesses from here. Update Kybern there first".into(),
        codes::FORBIDDEN => "It does not let other machines change its settings".into(),
        _ => error.message.clone(),
    }
}

fn record(result: &mut HarnessUpdatesRunAllResult, id: &MachineId, answer: PeerHarnessUpdatesRunResult) {
    if answer.started.is_empty() {
        let reason = answer.reason.unwrap_or_else(|| "Every harness is up to date".into());
        result.skipped.push(NetworkUpdateSkipped { machine_id: id.clone(), reason });
    } else {
        result.started.push(HarnessUpdatesStarted { machine_id: id.clone(), kinds: answer.started });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_and_old_members_are_described_for_people() {
        assert!(describe_failure(&RpcError::new(codes::METHOD_NOT_FOUND, "x")).contains("older Kybern"));
        assert!(describe_failure(&RpcError::forbidden("machine:settings")).contains("settings"));
        assert!(needs_newer("0.24.0").contains("0.24.0"));
        let mut result = HarnessUpdatesRunAllResult { started: Vec::new(), skipped: Vec::new() };
        record(&mut result, &"m".to_string(), PeerHarnessUpdatesRunResult { started: vec![], reason: None });
        assert_eq!(result.skipped[0].reason, "Every harness is up to date");
        record(&mut result, &"n".to_string(), PeerHarnessUpdatesRunResult { started: vec![ProviderKind::Codex], reason: None });
        assert_eq!(result.started, [HarnessUpdatesStarted { machine_id: "n".into(), kinds: vec![ProviderKind::Codex] }]);
    }
}
