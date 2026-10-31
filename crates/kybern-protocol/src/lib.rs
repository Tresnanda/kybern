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
pub mod fork;
pub mod forward;
pub mod integrations;
pub mod login_broker;
pub mod methods;
pub mod model;
pub mod move_thread;
pub mod network;
pub mod outbox;
mod plugin_sync;
pub mod process;
pub mod provision;
pub mod rpc;
pub mod shared_state;
pub mod skill_sync;
pub mod space_sync;
pub mod thread_read;
pub mod user_input;
pub mod utilities;

pub use auth::*;
pub use event::*;
pub use fork::*;
pub use forward::*;
pub use integrations::*;
pub use login_broker::*;
pub use model::*;
pub use move_thread::*;
pub use network::*;
pub use outbox::*;
pub use plugin_sync::*;
pub use provision::*;
pub use rpc::*;
pub use shared_state::*;
pub use skill_sync::*;
pub use space_sync::*;
pub use thread_read::*;
pub use user_input::*;
pub use utilities::*;

/// Bumped on breaking wire changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Default TCP port for a local daemon.
pub const DEFAULT_PORT: u16 = 4173;

/// Notification method used to deliver subscription events.
pub const EVENT_NOTIFICATION: &str = "event";
pub const EVENTS_READY_NOTIFICATION: &str = "events.ready";
