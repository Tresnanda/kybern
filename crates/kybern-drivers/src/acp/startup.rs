//! Starting an ACP agent: the steps that can fail, what its stderr said, and handing the failure to `spawn`'s caller.

use std::time::Duration;

use tokio::sync::oneshot;

use crate::{DriverError, Result};

/// The step of a session start that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Startup {
    /// The agent quit before it answered anything.
    Launch,
    Initialize,
    NewSession,
    Resume,
    /// `session/load` got no answer and no replay in time.
    ResumeTimedOut,
}

/// How much of the end of the agent's stderr is kept to explain a startup failure.
pub(crate) const STDERR_TAIL_BYTES: usize = 600;

/// How long a failed start waits for the agent's stderr to close, so an agent that quit has said why.
const STDERR_SETTLE: Duration = Duration::from_secs(1);

pub(crate) fn remember_stderr(tail: &std::sync::Mutex<String>, line: &str) {
    let Ok(mut tail) = tail.lock() else { return };
    if !tail.is_empty() {
        tail.push('\n');
    }
    tail.push_str(line.trim_end());
    if tail.len() > STDERR_TAIL_BYTES {
        let mut cut = tail.len() - STDERR_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail.drain(..cut);
    }
}

pub(crate) fn stderr_text(tail: &std::sync::Mutex<String>) -> String {
    tail.lock().map(|t| t.trim().to_string()).unwrap_or_default()
}

/// Wait (briefly) until the agent's stderr has closed, which it does once the agent has quit.
pub(crate) async fn stderr_settled(closed: &mut tokio::sync::watch::Receiver<bool>) {
    let _ = tokio::time::timeout(STDERR_SETTLE, closed.wait_for(|closed| *closed)).await;
}

/// `clap`'s words for an option it doesn't know: this agent predates a flag Kybern passes.
pub(crate) fn rejects_arguments(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    ["unexpected argument", "unrecognized option", "unrecognized argument", "unknown argument", "unknown option"]
        .iter()
        .any(|needle| lower.contains(needle))
        || lower.contains("found argument") && lower.contains("wasn't expected")
}

/// Fail the session start: the caller of `spawn` gets `error`, not just "exited during startup". The
/// connection ends with the error's text.
pub(crate) fn fail_startup<T>(
    bound: &mut Option<oneshot::Sender<Result<T>>>,
    error: impl Into<DriverError>,
) -> agent_client_protocol::Error {
    let error = error.into();
    let detail = error.to_string();
    if let Some(b) = bound.take() {
        let _ = b.send(Err(error));
    }
    agent_client_protocol::Error::from(anyhow::anyhow!(detail))
}
