//! Capability scopes carried by a session token.
//!
//! Mirrors the OAuth-style model T3 Code uses: every RPC method declares the
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
}

impl Scope {
    pub const ALL: [Scope; 6] = [
        Scope::OrchestrationRead,
        Scope::OrchestrationOperate,
        Scope::TerminalOperate,
        Scope::ReviewWrite,
        Scope::AccessRead,
        Scope::AccessWrite,
    ];

    /// Scopes granted to an ordinary paired client (phone, second desktop).
    pub const CLIENT: [Scope; 4] = [Scope::OrchestrationRead, Scope::OrchestrationOperate, Scope::TerminalOperate, Scope::ReviewWrite];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::OrchestrationRead => "orchestration:read",
            Scope::OrchestrationOperate => "orchestration:operate",
            Scope::TerminalOperate => "terminal:operate",
            Scope::ReviewWrite => "review:write",
            Scope::AccessRead => "access:read",
            Scope::AccessWrite => "access:write",
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
