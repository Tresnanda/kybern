//! Wire protocol for the kybern daemon.
//!
//! Every client (GPUI desktop, CLI, Expo mobile) speaks this protocol over a
//! single WebSocket: JSON-RPC 2.0 requests and responses, plus server-initiated
//! notifications for subscriptions. The types here are the single source of
//! truth; `kybern-schema` emits JSON Schema from them for non-Rust clients.
//!
//! Versioning: `PROTOCOL_VERSION` is bumped on any breaking change and echoed by
//! `daemon.info`. Additive changes (new optional fields, new event kinds) do not
//! bump it; clients must ignore unknown event kinds and fields.

pub mod auth;
pub mod event;
pub mod methods;
pub mod model;
pub mod rpc;

pub use auth::*;
pub use event::*;
pub use model::*;
pub use rpc::*;

/// Bumped on breaking wire changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Default TCP port for a local daemon.
pub const DEFAULT_PORT: u16 = 4173;

/// Notification method used to deliver subscription events.
pub const EVENT_NOTIFICATION: &str = "event";
