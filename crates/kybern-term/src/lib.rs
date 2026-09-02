//! Terminal emulation and rendering for the kybern desktop client.
//!
//! The daemon owns the PTY. This crate is the pure client half: a VT state
//! machine ([`TerminalState`], built on `alacritty_terminal`) that is fed the
//! raw bytes the daemon streams, and a GPUI element ([`TerminalElement`]) that
//! paints the resulting grid with the app's monospace font, forwards keyboard
//! input as bytes, and reports the grid size that fits its bounds so the app
//! can resize the PTY.

pub mod colors;
pub mod element;
pub mod keys;
pub mod state;

pub use alacritty_terminal;
pub use colors::Palette;
pub use element::TerminalElement;
pub use state::{TermSize, TerminalState};
