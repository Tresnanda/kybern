//! Capability scopes carried by a session token.
//!
//! OAuth-style scopes: every RPC method declares the
//! scope it needs, and the daemon rejects calls whose token lacks it. The
//! desktop bootstrap token carries every scope; a pairing code for a phone
//! grants the four client-operation scopes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// Read threads, events, projects, provider status.
    OrchestrationRead,
    /// Send messages, interrupt, change modes, resolve approvals.
    OrchestrationOperate,
    /// Create and drive terminals.
    TerminalOperate,
    /// Read diff previews and submit review comments.
    ReviewWrite,
    /// Inspect pairing links and client sessions.
    AccessRead,
    /// Create or revoke pairing links and client sessions.
    AccessWrite,
    /// See the machine network: members, found machines, routes, doctor.
    NetworkRead,
    /// Change the machine network: add, remove, pause, rename, merge.
    NetworkAdmin,
    // Machine scopes. Only a daemon-to-daemon grant carries these, never a
    // device token, and `Scope::ALL` does not list them (see `Scope::MACHINE`).
    /// Op sync, presence and device token minting between members.
    MachinePeer,
    /// Relaying a client's connection through this machine to another member.
    MachineRelay,
    /// New threads, delegations, sends, git bundles and move leases.
    MachineDelegate,
    /// Forwarded agent tools.
    MachineTools,
    /// Forwarded terminal tools.
    MachineTerminals,
    /// File reads, writes and pushes from other machines.
    MachineFiles,
    /// Explicit clipboard send and paste.
    MachineClipboard,
    /// Universal clipboard (opt-in).
    MachineClipboardAuto,
    /// Port forwarding to this machine's loopback.
    MachinePorts,
    /// Settings fan-out.
    MachineSettings,
    /// Receiving pushed keys.
    MachineSecrets,
    /// Borrowing logins from this machine when it is the broker.
    MachineLogins,
}

impl Scope {
    /// Every client scope, which is what the bootstrap token carries. The machine
    /// scopes are not in it: they belong to daemon-to-daemon grants only.
    pub const ALL: [Scope; 8] = [
        Scope::OrchestrationRead,
        Scope::OrchestrationOperate,
        Scope::TerminalOperate,
        Scope::ReviewWrite,
        Scope::AccessRead,
        Scope::AccessWrite,
        Scope::NetworkRead,
        Scope::NetworkAdmin,
    ];

    /// Scopes granted to an ordinary paired client (phone, second desktop).
    // N1: the design gives `network:admin` to desktop and phone pairings too, but
    // not as part of this constant; the pairing flow (N4) adds it when it issues a token.
    pub const CLIENT: [Scope; 5] =
        [Scope::OrchestrationRead, Scope::OrchestrationOperate, Scope::TerminalOperate, Scope::ReviewWrite, Scope::NetworkRead];

    /// Every machine scope a daemon-to-daemon grant can carry.
    pub const MACHINE: [Scope; 12] = [
        Scope::MachinePeer,
        Scope::MachineRelay,
        Scope::MachineDelegate,
        Scope::MachineTools,
        Scope::MachineTerminals,
        Scope::MachineFiles,
        Scope::MachineClipboard,
        Scope::MachineClipboardAuto,
        Scope::MachinePorts,
        Scope::MachineSettings,
        Scope::MachineSecrets,
        Scope::MachineLogins,
    ];

    /// What a target grants a member by default: everything except the opt-in
    /// universal clipboard. Logins are listed because only a broker serves them.
    pub const MACHINE_DEFAULT: [Scope; 11] = [
        Scope::MachinePeer,
        Scope::MachineRelay,
        Scope::MachineDelegate,
        Scope::MachineTools,
        Scope::MachineTerminals,
        Scope::MachineFiles,
        Scope::MachineClipboard,
        Scope::MachinePorts,
        Scope::MachineSettings,
        Scope::MachineSecrets,
        Scope::MachineLogins,
    ];

    pub fn is_machine(self) -> bool {
        Scope::MACHINE.contains(&self)
    }

    /// The capability name used by the `allow.<machine>.<capability>` registers
    /// (`delegate`, `files`, ...). `peer` is always granted and has none.
    pub fn capability(self) -> Option<&'static str> {
        match self {
            Scope::MachineRelay => Some("relay"),
            Scope::MachineDelegate => Some("delegate"),
            Scope::MachineTools => Some("tools"),
            Scope::MachineTerminals => Some("terminals"),
            Scope::MachineFiles => Some("files"),
            Scope::MachineClipboard => Some("clipboard"),
            Scope::MachineClipboardAuto => Some("clipboard_auto"),
            Scope::MachinePorts => Some("ports"),
            Scope::MachineSettings => Some("settings"),
            Scope::MachineSecrets => Some("secrets"),
            Scope::MachineLogins => Some("logins"),
            _ => None,
        }
    }

    pub fn from_capability(capability: &str) -> Option<Scope> {
        Scope::MACHINE.into_iter().find(|scope| scope.capability() == Some(capability))
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::OrchestrationRead => "orchestration:read",
            Scope::OrchestrationOperate => "orchestration:operate",
            Scope::TerminalOperate => "terminal:operate",
            Scope::ReviewWrite => "review:write",
            Scope::AccessRead => "access:read",
            Scope::AccessWrite => "access:write",
            Scope::NetworkRead => "network:read",
            Scope::NetworkAdmin => "network:admin",
            Scope::MachinePeer => "machine:peer",
            Scope::MachineRelay => "machine:relay",
            Scope::MachineDelegate => "machine:delegate",
            Scope::MachineTools => "machine:tools",
            Scope::MachineTerminals => "machine:terminals",
            Scope::MachineFiles => "machine:files",
            Scope::MachineClipboard => "machine:clipboard",
            Scope::MachineClipboardAuto => "machine:clipboard_auto",
            Scope::MachinePorts => "machine:ports",
            Scope::MachineSettings => "machine:settings",
            Scope::MachineSecrets => "machine:secrets",
            Scope::MachineLogins => "machine:logins",
        }
    }
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Header carrying the bearer token on the WebSocket upgrade request.
pub const AUTH_HEADER: &str = "authorization";
/// Query parameter accepted as a fallback for clients that cannot set headers.
pub const AUTH_QUERY_PARAM: &str = "token";
