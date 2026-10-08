//! In-memory capability tickets for previews (spec 6.1). A ticket is an
//! unguessable UUIDv4 that grants access to one folder (`Files`) or one
//! loopback port (`Proxy`). It slides forward on use, has a hard lifetime cap,
//! and the store holds at most [`MAX_TICKETS`] (oldest evicted first).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kybern_protocol::ThreadId;
use uuid::Uuid;

pub const SLIDING_EXPIRY: Duration = Duration::from_secs(30 * 60);
pub const HARD_CAP: Duration = Duration::from_secs(12 * 60 * 60);
pub const MAX_TICKETS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TicketKind {
    /// Serve files under this canonical root.
    Files { root: PathBuf },
    /// Forward to `127.0.0.1:{port}` / `[::1]:{port}` on the daemon host.
    Proxy { port: u16 },
}

#[derive(Debug, Clone)]
pub struct TicketInfo {
    pub kind: TicketKind,
    pub thread_id: ThreadId,
    /// Device id the ticket was minted for, when the caller had one.
    pub principal: Option<Uuid>,
}

struct Entry {
    info: TicketInfo,
    created: Instant,
    last_used: Instant,
}

pub struct PreviewTickets {
    entries: Mutex<HashMap<String, Entry>>,
    sliding: Duration,
    hard_cap: Duration,
    max: usize,
}

impl Default for PreviewTickets {
    fn default() -> Self {
        Self::with_limits(SLIDING_EXPIRY, HARD_CAP, MAX_TICKETS)
    }
}

impl PreviewTickets {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limits(sliding: Duration, hard_cap: Duration, max: usize) -> Self {
        Self { entries: Mutex::default(), sliding, hard_cap, max }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn live(&self, entry: &Entry, now: Instant) -> bool {
        now.saturating_duration_since(entry.last_used) < self.sliding && now.saturating_duration_since(entry.created) < self.hard_cap
    }

    /// Mint a ticket, evicting expired entries and then the oldest ones.
    pub fn mint(&self, kind: TicketKind, thread_id: ThreadId, principal: Option<Uuid>) -> String {
        self.mint_at(kind, thread_id, principal, Instant::now())
    }

    pub fn mint_at(&self, kind: TicketKind, thread_id: ThreadId, principal: Option<Uuid>, now: Instant) -> String {
        let mut entries = self.lock();
        entries.retain(|_, entry| self.live(entry, now));
        while entries.len() >= self.max {
            let Some(oldest) = entries.iter().min_by_key(|(_, entry)| entry.created).map(|(id, _)| id.clone()) else { break };
            entries.remove(&oldest);
        }
        let ticket = Uuid::new_v4().to_string();
        entries.insert(ticket.clone(), Entry { info: TicketInfo { kind, thread_id, principal }, created: now, last_used: now });
        ticket
    }

    /// Look a ticket up and slide its expiry. Expired tickets are removed.
    pub fn lookup(&self, ticket: &str) -> Option<TicketInfo> {
        self.lookup_at(ticket, Instant::now())
    }

    pub fn lookup_at(&self, ticket: &str, now: Instant) -> Option<TicketInfo> {
        let mut entries = self.lock();
        let live = entries.get(ticket).map(|entry| self.live(entry, now))?;
        if !live {
            entries.remove(ticket);
            return None;
        }
        let entry = entries.get_mut(ticket)?;
        entry.last_used = now;
        Some(entry.info.clone())
    }

    /// Revoke one ticket. Idempotent; returns whether it existed.
    pub fn revoke(&self, ticket: &str) -> bool {
        self.lock().remove(ticket).is_some()
    }

    /// Revoke every ticket of a thread (archive). Returns the count.
    pub fn revoke_thread(&self, thread_id: ThreadId) -> usize {
        let mut entries = self.lock();
        let before = entries.len();
        entries.retain(|_, entry| entry.info.thread_id != thread_id);
        before - entries.len()
    }

    /// Revoke every ticket minted for a device (device revocation).
    pub fn revoke_principal(&self, principal: Uuid) -> usize {
        let mut entries = self.lock();
        let before = entries.len();
        entries.retain(|_, entry| entry.info.principal != Some(principal));
        before - entries.len()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(root: &str) -> TicketKind {
        TicketKind::Files { root: PathBuf::from(root) }
    }

    #[test]
    fn expiry_slides_with_use() {
        let tickets = PreviewTickets::new();
        let t0 = Instant::now();
        let thread = Uuid::new_v4();
        let id = tickets.mint_at(files("/a"), thread, None, t0);
        assert!(tickets.lookup_at(&id, t0 + Duration::from_secs(25 * 60)).is_some());
        assert!(tickets.lookup_at(&id, t0 + Duration::from_secs(50 * 60)).is_some());
        assert!(tickets.lookup_at(&id, t0 + Duration::from_secs(50 * 60 + 31 * 60)).is_none());
        assert!(tickets.lookup_at(&id, t0 + Duration::from_secs(51 * 60)).is_none(), "expired tickets are removed");
    }

    #[test]
    fn hard_cap_beats_sliding() {
        let tickets = PreviewTickets::new();
        let t0 = Instant::now();
        let id = tickets.mint_at(files("/a"), Uuid::new_v4(), None, t0);
        let mut at = t0;
        while at < t0 + HARD_CAP - Duration::from_secs(600) {
            at += Duration::from_secs(20 * 60);
            if at >= t0 + HARD_CAP {
                break;
            }
            assert!(tickets.lookup_at(&id, at).is_some());
        }
        assert!(tickets.lookup_at(&id, t0 + HARD_CAP + Duration::from_secs(1)).is_none());
    }

    #[test]
    fn revoke_by_ticket_thread_and_principal() {
        let tickets = PreviewTickets::new();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let device = Uuid::new_v4();
        let t1 = tickets.mint(files("/a"), a, Some(device));
        let t2 = tickets.mint(TicketKind::Proxy { port: 5173 }, a, None);
        let t3 = tickets.mint(files("/b"), b, None);
        assert!(tickets.revoke(&t1));
        assert!(!tickets.revoke(&t1), "idempotent");
        assert_eq!(tickets.revoke_thread(a), 1);
        assert!(tickets.lookup(&t2).is_none());
        assert!(tickets.lookup(&t3).is_some());
        let t4 = tickets.mint(files("/c"), b, Some(device));
        assert_eq!(tickets.revoke_principal(device), 1);
        assert!(tickets.lookup(&t4).is_none());
    }

    #[test]
    fn evicts_oldest_beyond_cap() {
        let tickets = PreviewTickets::new();
        let t0 = Instant::now();
        let thread = Uuid::new_v4();
        let ids: Vec<String> = (0..MAX_TICKETS + 1).map(|i| tickets.mint_at(files("/a"), thread, None, t0 + Duration::from_millis(i as u64))).collect();
        assert_eq!(tickets.len(), MAX_TICKETS);
        assert!(tickets.lookup_at(&ids[0], t0 + Duration::from_secs(1)).is_none());
        assert!(tickets.lookup_at(&ids[MAX_TICKETS], t0 + Duration::from_secs(1)).is_some());
    }

    #[test]
    fn tickets_are_distinct_uuids() {
        let tickets = PreviewTickets::new();
        let thread = Uuid::new_v4();
        let a = tickets.mint(files("/a"), thread, None);
        let b = tickets.mint(files("/a"), thread, None);
        assert_ne!(a, b);
        assert!(Uuid::parse_str(&a).is_ok());
    }
}
