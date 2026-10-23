//! Live state of the daemon's request cards (`kybern_request_login`,
//! `kybern_request_permission`, `kybern_ask_user` with a deadline, and the
//! terminals `kybern_run_in_terminal` opens).
//!
//! A card is an ordinary approval (see `ApprovalRequest`); this hub carries what
//! changes while it is open: which step it is on, the page or code to show,
//! the time left. Clients read it with `requests.progress`, hear changes as
//! `requests.progress` notifications and press the card's buttons with
//! `requests.act`, which reaches the task driving the card through the channel
//! `register` returned. Nothing here is persisted: a card whose daemon
//! restarted resolves as `turn ended` like every other daemon-owned card.
//!
//! Another feature that needs "a pending request with a typed answer" (the
//! visuals that talk back) should open its card the same way: raise a
//! daemon-owned approval (`Orchestrator::open_daemon_card`), register progress
//! here only if the card has steps, wait on the card's decision, and resolve it
//! with `Orchestrator::finish_daemon_card`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow};
use chrono::Utc;
use kybern_protocol::{ApprovalId, RequestPhase, RequestProgress, ThreadId};
use tokio::sync::{broadcast, mpsc};

/// One press of a card button, as `requests.act` delivers it.
#[derive(Debug, Clone)]
pub struct RequestAct {
    pub action: String,
    pub value: Option<String>,
    /// The client may change the machine's own sign-ins (`access:write`).
    pub can_write: bool,
}

struct Entry {
    progress: RequestProgress,
    acts: mpsc::UnboundedSender<RequestAct>,
}

#[derive(Clone)]
pub struct RequestHub {
    inner: Arc<Inner>,
}

struct Inner {
    items: Mutex<HashMap<ApprovalId, Entry>>,
    changed: broadcast::Sender<RequestProgress>,
}

impl Default for RequestHub {
    fn default() -> Self {
        Self { inner: Arc::new(Inner { items: Mutex::new(HashMap::new()), changed: broadcast::channel(256).0 }) }
    }
}

impl RequestHub {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ApprovalId, Entry>> {
        self.inner.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RequestProgress> {
        self.inner.changed.subscribe()
    }

    /// Start tracking a card and return the channel its button presses arrive on.
    pub fn register(&self, progress: RequestProgress) -> mpsc::UnboundedReceiver<RequestAct> {
        let (acts, receiver) = mpsc::unbounded_channel();
        let _ = self.inner.changed.send(progress.clone());
        self.lock().insert(progress.approval_id, Entry { progress, acts });
        receiver
    }

    /// Change a card's state and tell clients when it differs from before.
    pub fn update(&self, id: ApprovalId, change: impl FnOnce(&mut RequestProgress)) {
        let published = {
            let mut items = self.lock();
            let Some(entry) = items.get_mut(&id) else { return };
            let before = entry.progress.clone();
            change(&mut entry.progress);
            let unchanged = {
                let mut same = entry.progress.clone();
                same.updated_at = before.updated_at;
                same == before
            };
            if unchanged {
                return;
            }
            entry.progress.updated_at = Utc::now();
            entry.progress.clone()
        };
        let _ = self.inner.changed.send(published);
    }

    pub fn set_phase(&self, id: ApprovalId, phase: RequestPhase) {
        self.update(id, |progress| progress.phase = phase);
    }

    pub fn get(&self, id: ApprovalId) -> Option<RequestProgress> {
        self.lock().get(&id).map(|entry| entry.progress.clone())
    }

    pub fn remove(&self, id: ApprovalId) {
        self.lock().remove(&id);
    }

    pub fn list(&self, thread_id: Option<ThreadId>) -> Vec<RequestProgress> {
        let mut items: Vec<_> =
            self.lock().values().map(|entry| entry.progress.clone()).filter(|p| thread_id.is_none_or(|id| p.thread_id == id)).collect();
        items.sort_by_key(|progress| progress.updated_at);
        items
    }

    /// Deliver a button press to the task that drives the card.
    pub fn act(&self, id: ApprovalId, act: RequestAct) -> Result<()> {
        let sender = self.lock().get(&id).map(|entry| entry.acts.clone());
        sender.ok_or_else(|| anyhow!("This request has ended."))?.send(act).map_err(|_| anyhow!("This request has ended."))
    }
}
