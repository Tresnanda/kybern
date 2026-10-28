//! Removing a machine (design §2.5) and everything that follows from it.
//!
//! `remove` writes a signed `remove` operation (and one per machine in `also_remove`), tells every
//! connected member **including the one being removed**, so a cooperating machine learns it, and
//! then closes the sessions. Every member that receives the operation runs
//! [`Network::drop_machine`](super::Network::drop_machine): it closes the sessions with the removed
//! machine, revokes the grants it issued to it and the client tokens it minted for the removed
//! machine's clients. A machine that finds itself removed runs [`Network::forget_network_state`].

use std::time::Duration;

use kybern_protocol::methods::PeerOpsPush;
use kybern_protocol::{OpEnvelope, PeerOpsPushParams, RemoveReason};

use super::join::JoinError;
use super::membership::MembershipError;
use super::{Network, TARGET};
use crate::state::AppState;

/// How long a removal waits for each member to take the operation before it moves on. An
/// unreachable member catches up from its next sync.
const PUSH_TIMEOUT: Duration = Duration::from_secs(3);

/// The machines the user asked to remove, each with the operation that removes it.
#[derive(Debug, Default)]
pub struct Removed {
    pub machines: Vec<String>,
    pub ops: Vec<OpEnvelope>,
}

/// Remove `machine_id` and `also_remove`. `stolen` writes `reason: stolen` for all of them (§2.5).
///
/// The first machine must be a current member (an error says so); a machine in `also_remove` that
/// is already gone is skipped.
pub async fn remove(state: &AppState, machine_id: &str, stolen: bool, also_remove: &[String]) -> Result<Removed, JoinError> {
    let network = &state.network;
    let membership =
        network.membership().ok_or_else(|| JoinError::Unavailable("The machine network is unavailable on this machine.".into()))?;
    let reason = if stolen { RemoveReason::Stolen } else { RemoveReason::User };
    let mut wanted: Vec<&str> = vec![machine_id];
    for other in also_remove {
        if !wanted.contains(&other.as_str()) {
            wanted.push(other);
        }
    }
    let mut removed = Removed::default();
    for (index, id) in wanted.iter().enumerate() {
        match membership.remove(id, reason) {
            Ok(op) => {
                removed.machines.push((*id).to_string());
                removed.ops.push(op);
            }
            Err(MembershipError::UnknownMachine | MembershipError::AlreadyRemoved) if index > 0 => continue,
            Err(MembershipError::UnknownMachine) => return Err(JoinError::NotFound("that machine is not in your network".into())),
            Err(error) => {
                // Nothing was kept for the machines before the failure, except what was written:
                // report them as removed so the caller is not misled.
                if removed.machines.is_empty() {
                    return Err(error.into());
                }
                tracing::warn!(target: TARGET, %error, machine = id, "could not remove a machine of the list");
            }
        }
    }
    let me = membership.machine_id();
    // Tell everyone, the removed machines included, before their sessions are closed.
    let links = network.peers.links();
    let pushes = links.iter().map(|link| {
        let ops = removed.ops.clone();
        let link = link.clone();
        async move {
            let sent = tokio::time::timeout(PUSH_TIMEOUT, link.call::<PeerOpsPush>(PeerOpsPushParams { ops })).await;
            if !matches!(sent, Ok(Ok(_))) {
                tracing::debug!(target: TARGET, machine = %link.machine_id, "could not push a removal before closing the session");
            }
        }
    });
    futures::future::join_all(pushes).await;
    for id in &removed.machines {
        if *id == me {
            network.forget_network_state();
        } else {
            network.drop_machine(id);
        }
        tracing::info!(target: TARGET, machine = %id, ?reason, "removed a machine from the network");
    }
    network.notify_changed();
    network.wake();
    Ok(removed)
}

impl Network {
    /// A machine that was removed (or removed itself) forgets what it held for the network: every
    /// session, every grant it issued, and every client token other members minted on it. Its keys
    /// and operation set stay, so Settings can say it was removed and offer Rejoin (§2.6).
    pub fn forget_network_state(&self) {
        self.peers.close_all();
        for grant in self.grants.held() {
            self.grants.revoke(grant.id);
        }
        match self.store.tokens_revoke_all_issued_via() {
            Ok(ids) if !ids.is_empty() => {
                tracing::info!(target: TARGET, count = ids.len(), "revoked the client tokens other machines issued")
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(target: TARGET, %error, "could not revoke client tokens issued through the network"),
        }
        // Keys other machines pushed arrive with the secret store (M5); it clears them here.
    }

    /// The tokens another machine asked this one to issue for its clients die with that machine
    /// (§2.5, §3.4).
    pub(super) fn revoke_tokens_issued_via(&self, machine_id: &str) {
        match self.store.tokens_revoke_issued_via(machine_id) {
            Ok(ids) if !ids.is_empty() => {
                tracing::info!(target: TARGET, machine = machine_id, count = ids.len(), "revoked the client tokens a removed machine issued");
                for id in ids {
                    self.announce_revoked(id);
                }
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(target: TARGET, %error, "could not revoke client tokens a removed machine issued"),
        }
    }
}
