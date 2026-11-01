//! The two Antigravity rules, in one place so no path can forget them.
//!
//! Kybern can neither approve nor limit what Antigravity's tools do, so:
//! - a thread on Antigravity is always in Full access, and any other mode is
//!   refused wherever a mode or a provider is set (create, update, send, fork,
//!   move, rotation, delegation, task runs);
//! - Antigravity cannot be a project's Coordinator lead.

use anyhow::{Result, anyhow};
use kybern_protocol::{PermissionMode, ProviderKind};

/// Refuses any mode but Full access for an Antigravity thread.
pub(crate) fn require_full_access(kind: ProviderKind, mode: PermissionMode) -> Result<()> {
    if kind == ProviderKind::Antigravity {
        kybern_drivers::antigravity::require_full_access(mode).map_err(|sentence| anyhow!(sentence))?;
    }
    Ok(())
}

/// Refuses Antigravity as the harness of a project's Coordinator.
pub(crate) fn refuse_lead(kind: ProviderKind) -> Result<()> {
    if kind == ProviderKind::Antigravity {
        return Err(anyhow!(kybern_drivers::antigravity::NO_LEAD));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_antigravity_is_held_to_full_access() {
        for mode in PermissionMode::ALL {
            assert_eq!(require_full_access(ProviderKind::ClaudeCode, mode).is_ok(), true);
            assert_eq!(require_full_access(ProviderKind::Antigravity, mode).is_ok(), mode == PermissionMode::FullAccess);
        }
        let error = require_full_access(ProviderKind::Antigravity, PermissionMode::Auto).unwrap_err();
        assert_eq!(error.to_string(), "Antigravity only runs in Full access. Choose Full access, or pick another agent.");
        assert!(refuse_lead(ProviderKind::Codex).is_ok());
        assert_eq!(
            refuse_lead(ProviderKind::Antigravity).unwrap_err().to_string(),
            "Antigravity can't lead a project: Kybern can't limit its tools. Choose Claude Code or Codex for the lead."
        );
    }
}
