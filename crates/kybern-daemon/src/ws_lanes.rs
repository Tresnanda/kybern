//! How many calls one WebSocket connection may have in flight, and which calls hold which share.
//!
//! A single pool of 16 let a handful of slow calls (git and `gh` subprocesses, a live usage read, a fan-out to
//! other machines) starve the cheap ones a page needs to draw (`tasks.items.list`, `threads.list`, `settings.get`),
//! and the client saw a bare internal error. Calls now run in three bounded lanes, so a slow call can only fill
//! its own lane:
//!
//! * `Control` – the calls that must never wait behind a read: subscriptions, interrupt, answers, approvals,
//!   cancel and stop calls.
//! * `Slow` – calls that start a subprocess, probe the network or fan out to other machines. They finish in
//!   seconds, not milliseconds.
//! * `Standard` – everything else.
//!
//! When a lane is full the request waits briefly for a permit (in its own task, never in the socket reader) and is
//! then refused with `codes::CAPACITY_EXCEEDED`, a retryable error that says the call did not start. The ledger
//! records which methods hold permits and for how long, so a rejection names its cause in the log.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kybern_protocol::{Problem, ProblemKind, RpcError, RpcId, codes};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Calls in flight per lane and connection. The shared client keeps its own budget below the first two.
const CONTROL_PERMITS: usize = 16;
const STANDARD_PERMITS: usize = 16;
const SLOW_PERMITS: usize = 8;
/// How long a request waits for a permit before it is refused.
pub const PERMIT_WAIT: Duration = Duration::from_secs(2);
/// What a refused request tells the client to wait before asking again.
pub const RETRY_AFTER_MS: u64 = 400;
/// A call that held its permit this long is worth a line in the log even without a rejection.
const SLOW_CALL_LOG: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    Control,
    Standard,
    Slow,
}

impl Lane {
    pub fn name(self) -> &'static str {
        match self {
            Lane::Control => "control",
            Lane::Standard => "standard",
            Lane::Slow => "slow",
        }
    }
}

/// The parts of a request the lane decision reads. Borrowed from the frame text, so `params` is skipped, not copied.
#[derive(Deserialize)]
struct Peek<'a> {
    #[serde(borrow, default)]
    method: Option<std::borrow::Cow<'a, str>>,
    #[serde(default)]
    id: Option<RpcId>,
    #[serde(default)]
    params: Option<Value>,
}

/// A request frame, read just far enough to place it: its method and lane. `None` for notifications and anything
/// that is not a request (those carry no id and never get an answer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    pub id: RpcId,
    pub method: String,
    pub lane: Lane,
}

impl Placed {
    /// What a frame that is not a well-formed request waits as: it costs a parse and an error reply.
    pub fn unreadable() -> Self {
        Self { id: RpcId::Number(0), method: "(unreadable frame)".into(), lane: Lane::Standard }
    }
}

pub fn place(text: &str) -> Option<Placed> {
    let peek: Peek = serde_json::from_str(text).ok()?;
    let id = peek.id?;
    let method = peek.method?.into_owned();
    // Parameters of any shape place the call; `handle_text` is what rejects bad ones.
    let params = peek.params.unwrap_or(Value::Null);
    let names_machine = params.get("machine").is_some_and(|machine| !machine.is_null());
    let cached = params.get("cached").and_then(Value::as_bool) == Some(true);
    let lane = lane_for(&method, names_machine, cached);
    Some(Placed { id, method, lane })
}

/// Methods whose handler must answer while every read is stuck.
const CONTROL: &[&str] = &[
    "daemon.info",
    "daemon.activity",
    "events.subscribe",
    "events.unsubscribe",
    "threads.send",
    "threads.steer",
    "threads.answer",
    "threads.interrupt",
    "threads.release",
    "subagents.send",
    "subagents.send_to_parent",
    "approvals.respond",
    "approvals.list",
    "requests.act",
    "tasks.stop",
    "tasks.background",
    "terminals.resize",
    "terminals.close",
    "terminals.subscribe",
    "terminals.unsubscribe",
    "previews.close",
    "ports.stop",
];

/// Methods that run a subprocess, probe the network or wait on another machine.
const SLOW: &[&str] = &[
    "usage.summary",
    "providers.list",
    "providers.accounts.usage",
    "providers.accounts.catalog",
    "git.status",
    "git.branches",
    "git.commit",
    "threads.diff",
    "threads.checkpoints",
    "threads.revert",
    "threads.worktree.inspect",
    "threads.worktree.remove",
    "files.search",
    "previews.probe",
    "previews.servers.list",
    "projects.scan_repos",
    "projects.map",
    "machines.info",
    "cursor.status",
    "cursor.setup",
    "computer.status",
    "computer.setup",
    "network.doctor",
    "network.update_all",
    "network.join",
    "network.add",
    "network.rejoin",
    "network.merge",
    "skills.list",
];

/// Prefixes where every method is slow: `gh` and git subprocesses, other machines, sign-in, installs.
const SLOW_PREFIXES: &[&str] = &[
    "github.",
    "peer.",
    "plugins.",
    "skills.inventory",
    "skills.network",
    "skills.copy",
    "integrations.",
    "harness_updates.",
    "daemon_update.",
    "sessions.",
    "projects.provision",
];

/// Methods that fan out to other machines when the call names one (`machine`).
const FEDERATED_LISTS: &[&str] = &["tasks.items.list", "notes.list", "notes.search", "threads.list"];

pub fn lane_for(method: &str, names_machine: bool, cached: bool) -> Lane {
    if CONTROL.contains(&method) || method.ends_with("cancel") {
        return Lane::Control;
    }
    if method == "usage.limits" {
        return if cached { Lane::Standard } else { Lane::Slow };
    }
    if FEDERATED_LISTS.contains(&method) {
        return if names_machine { Lane::Slow } else { Lane::Standard };
    }
    if SLOW.contains(&method) || SLOW_PREFIXES.iter().any(|prefix| method.starts_with(prefix)) {
        return Lane::Slow;
    }
    Lane::Standard
}

struct Held {
    method: String,
    lane: Lane,
    since: Instant,
}

/// One connection's budgets and the calls holding them.
pub struct RequestBudget {
    conn: String,
    control: Arc<Semaphore>,
    standard: Arc<Semaphore>,
    slow: Arc<Semaphore>,
    held: Mutex<HashMap<u64, Held>>,
    next: std::sync::atomic::AtomicU64,
    /// Requests parked in `acquire`. Bounded, so a client that floods a full lane cannot pile up tasks.
    waiting: std::sync::atomic::AtomicUsize,
}

/// How many requests may wait for a permit at once, across the lanes of one connection.
const MAX_WAITING: usize = 128;

struct Waiting<'a>(&'a std::sync::atomic::AtomicUsize);

impl<'a> Waiting<'a> {
    fn enter(counter: &'a std::sync::atomic::AtomicUsize) -> Option<Self> {
        let before = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let guard = Self(counter);
        (before < MAX_WAITING).then_some(guard)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// A permit for one call. Dropping it frees the lane and removes the call from the ledger.
pub struct RequestPermit {
    _permit: OwnedSemaphorePermit,
    budget: Arc<RequestBudget>,
    key: u64,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        let held = self.budget.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&self.key);
        if let Some(held) = held {
            let elapsed = held.since.elapsed();
            if elapsed >= SLOW_CALL_LOG {
                tracing::debug!(conn = %self.budget.conn, method = %held.method, lane = held.lane.name(), elapsed_ms = elapsed.as_millis() as u64, "slow rpc finished");
            } else {
                tracing::trace!(conn = %self.budget.conn, method = %held.method, lane = held.lane.name(), elapsed_ms = elapsed.as_millis() as u64, "rpc finished");
            }
        }
    }
}

impl RequestBudget {
    pub fn new(conn: impl Into<String>) -> Arc<Self> {
        Self::with_sizes(conn, CONTROL_PERMITS, STANDARD_PERMITS, SLOW_PERMITS)
    }

    pub fn with_sizes(conn: impl Into<String>, control: usize, standard: usize, slow: usize) -> Arc<Self> {
        Arc::new(Self {
            conn: conn.into(),
            control: Arc::new(Semaphore::new(control)),
            standard: Arc::new(Semaphore::new(standard)),
            slow: Arc::new(Semaphore::new(slow)),
            held: Mutex::new(HashMap::new()),
            next: std::sync::atomic::AtomicU64::new(0),
            waiting: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn semaphore(&self, lane: Lane) -> &Arc<Semaphore> {
        match lane {
            Lane::Control => &self.control,
            Lane::Standard => &self.standard,
            Lane::Slow => &self.slow,
        }
    }

    fn record(self: &Arc<Self>, permit: OwnedSemaphorePermit, placed: &Placed) -> RequestPermit {
        let key = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, Held { method: placed.method.clone(), lane: placed.lane, since: Instant::now() });
        RequestPermit { _permit: permit, budget: self.clone(), key }
    }

    /// A permit if the lane has room right now.
    pub fn try_acquire(self: &Arc<Self>, placed: &Placed) -> Option<RequestPermit> {
        let permit = self.semaphore(placed.lane).clone().try_acquire_owned().ok()?;
        Some(self.record(permit, placed))
    }

    /// Waits up to `wait` for a permit (first come, first served). On a timeout the refusal is logged with the methods
    /// that held the lane, and returned as the error to answer with.
    pub async fn acquire(self: &Arc<Self>, placed: &Placed, wait: Duration) -> Result<RequestPermit, RpcError> {
        let semaphore = self.semaphore(placed.lane).clone();
        let waiting = Waiting::enter(&self.waiting);
        let acquired = match &waiting {
            Some(_) => tokio::time::timeout(wait, semaphore.acquire_owned()).await.ok().and_then(Result::ok),
            None => None,
        };
        drop(waiting);
        match acquired {
            Some(permit) => Ok(self.record(permit, placed)),
            None => {
                tracing::warn!(
                    conn = %self.conn,
                    method = %placed.method,
                    lane = placed.lane.name(),
                    holders = %self.holders(placed.lane),
                    "rpc refused: lane is full"
                );
                Err(capacity_error(&placed.method))
            }
        }
    }

    /// `method (elapsed)` for every call holding `lane`, longest first.
    pub fn holders(&self, lane: Lane) -> String {
        let held = self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut rows: Vec<(Duration, &str)> =
            held.values().filter(|held| held.lane == lane).map(|held| (held.since.elapsed(), held.method.as_str())).collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.0));
        rows.iter().map(|(elapsed, method)| format!("{method} ({:.1}s)", elapsed.as_secs_f32())).collect::<Vec<_>>().join(", ")
    }

    /// Calls in flight in `lane`.
    #[cfg(test)]
    pub fn in_flight(&self, lane: Lane) -> usize {
        self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).values().filter(|held| held.lane == lane).count()
    }
}

/// The refusal for a call that found its lane full: it did not start, and trying again is safe.
pub fn capacity_error(method: &str) -> RpcError {
    let problem = Problem::new(ProblemKind::Conflict, format!("Too many calls in flight on this connection; {method} did not start"))
        .with_subject("busy")
        .with_copy("Kybern is busy", "It's finishing other work. Try again in a moment.");
    RpcError::new(codes::CAPACITY_EXCEEDED, "Too many calls in flight on this connection; try again in a moment")
        .with_data(json!({ "retry_after_ms": RETRY_AFTER_MS }))
        .with_problem(&problem)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, params: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string()
    }

    #[test]
    fn cheap_reads_are_standard_and_slow_work_is_slow() {
        for method in ["tasks.items.list", "threads.list", "settings.get", "notes.list", "threads.get"] {
            assert_eq!(place(&request(method, json!({}))).unwrap().lane, Lane::Standard, "{method}");
        }
        for method in [
            "git.status",
            "git.branches",
            "threads.diff",
            "github.pr.list",
            "github.actions.log",
            "providers.list",
            "previews.probe",
            "files.search",
            "peer.federated.read",
        ] {
            assert_eq!(place(&request(method, json!({}))).unwrap().lane, Lane::Slow, "{method}");
        }
    }

    #[test]
    fn control_calls_have_their_own_lane() {
        for method in [
            "events.subscribe",
            "threads.interrupt",
            "threads.send",
            "threads.steer",
            "approvals.respond",
            "sessions.scan_cancel",
            "providers.accounts.login.cancel",
            "peer.delegation.cancel",
        ] {
            assert_eq!(place(&request(method, json!({}))).unwrap().lane, Lane::Control, "{method}");
        }
    }

    #[test]
    fn a_list_that_names_a_machine_fans_out_and_a_cached_usage_read_does_not() {
        assert_eq!(place(&request("tasks.items.list", json!({ "machine": "all" }))).unwrap().lane, Lane::Slow);
        assert_eq!(place(&request("tasks.items.list", json!({ "machine": null }))).unwrap().lane, Lane::Standard);
        assert_eq!(place(&request("usage.limits", json!({}))).unwrap().lane, Lane::Slow);
        assert_eq!(place(&request("usage.limits", json!({ "cached": true }))).unwrap().lane, Lane::Standard);
    }

    #[test]
    fn parameters_of_an_odd_shape_still_place_the_call() {
        assert_eq!(place(&request("usage.limits", json!({ "cached": "yes" }))).unwrap().lane, Lane::Slow);
        assert_eq!(place(&request("git.status", json!("not an object"))).unwrap().lane, Lane::Slow);
    }

    #[test]
    fn notifications_and_garbage_are_not_requests() {
        assert!(place(r#"{"jsonrpc":"2.0","method":"git.status"}"#).is_none());
        assert!(place("not json").is_none());
    }

    #[test]
    fn the_refusal_is_a_distinct_retryable_problem_with_plain_words() {
        let error = capacity_error("git.status").ensure_problem();
        assert_eq!(error.code, codes::CAPACITY_EXCEEDED);
        assert_ne!(error.code, codes::INTERNAL_ERROR);
        let problem = error.problem().expect("a problem");
        assert_eq!(problem.subject.as_deref(), Some("busy"));
        assert!(problem.retryable);
        assert_eq!(problem.title.as_deref(), Some("Kybern is busy"));
        assert_eq!(error.data.as_ref().unwrap()["retry_after_ms"], RETRY_AFTER_MS);
    }

    #[tokio::test]
    async fn a_full_slow_lane_leaves_cheap_reads_and_control_calls_alone() {
        let budget = RequestBudget::with_sizes("test", 2, 2, 2);
        let slow = place(&request("git.status", json!({}))).unwrap();
        let held: Vec<_> = (0..2).map(|_| budget.try_acquire(&slow).expect("slow permit")).collect();
        assert!(budget.try_acquire(&slow).is_none());
        assert!(budget.try_acquire(&place(&request("tasks.items.list", json!({}))).unwrap()).is_some());
        assert!(budget.try_acquire(&place(&request("threads.interrupt", json!({}))).unwrap()).is_some());
        assert_eq!(budget.in_flight(Lane::Slow), 2);
        drop(held);
        assert_eq!(budget.in_flight(Lane::Slow), 0);
    }

    #[tokio::test]
    async fn a_request_waits_for_a_permit_and_runs_when_one_frees() {
        let budget = RequestBudget::with_sizes("test", 1, 1, 1);
        let read = place(&request("tasks.items.list", json!({}))).unwrap();
        let first = budget.try_acquire(&read).unwrap();
        let waiter = tokio::spawn({
            let budget = budget.clone();
            let read = read.clone();
            async move { budget.acquire(&read, Duration::from_secs(5)).await.map(|_| ()) }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(first);
        assert!(waiter.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn a_request_that_waits_too_long_is_refused_and_the_log_can_name_the_holders() {
        let budget = RequestBudget::with_sizes("test", 1, 1, 1);
        let slow = place(&request("github.pr.list", json!({}))).unwrap();
        let _held = budget.try_acquire(&slow).unwrap();
        let refused = budget.acquire(&slow, Duration::from_millis(40)).await.err().expect("refused");
        assert_eq!(refused.code, codes::CAPACITY_EXCEEDED);
        assert!(budget.holders(Lane::Slow).starts_with("github.pr.list ("));
    }
}
