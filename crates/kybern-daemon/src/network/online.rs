//! How much of the last seven days each machine was online, sampled from heartbeats (`MachineCard::online_ratio_7d`).
//!
//! The week is cut into 15-minute slots. A machine's slot is marked when this daemon saw it online then: a
//! peer on a heartbeat of its live link ([`super::peers::touch_seen`]), this machine on every pass of the
//! network worker. A peer's ratio counts only the slots this daemon was running for, so a laptop that was
//! closed does not make the always-on machine look offline. Each machine keeps one 84-byte bitmap in
//! `meta`; at most [`MAX_MACHINES`] are kept.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use kybern_store::Store;
use serde::{Deserialize, Serialize};

const KEY: &str = "network.online.v1";
const SLOT_SECONDS: i64 = 15 * 60;
/// Seven days of slots.
pub const SLOTS: i64 = 7 * 24 * 4;
/// A ratio needs a day of samples.
const MIN_SPAN: i64 = 24 * 4;
const MAX_MACHINES: usize = 64;

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Track {
    /// The newest marked slot.
    last: i64,
    /// The first slot this machine was ever marked in.
    since: i64,
    /// Bit `i` of the hex bitmap: slot `last - i` was marked.
    bits: String,
}

impl Track {
    fn bitmap(&self) -> Vec<u8> {
        let mut bytes: Vec<u8> =
            (0..self.bits.len() / 2).filter_map(|i| u8::from_str_radix(self.bits.get(i * 2..i * 2 + 2)?, 16).ok()).collect();
        bytes.resize((SLOTS as usize).div_ceil(8), 0);
        bytes
    }

    fn set_bitmap(&mut self, bytes: &[u8]) {
        self.bits = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    }

    fn marked(&self, slot: i64) -> bool {
        let age = self.last - slot;
        if !(0..SLOTS).contains(&age) {
            return false;
        }
        let bytes = self.bitmap();
        bytes[(age / 8) as usize] & (1 << (age % 8)) != 0
    }

    /// Mark `slot`; returns whether that changed anything.
    fn mark(&mut self, slot: i64) -> bool {
        if self.bits.is_empty() {
            *self = Track { last: slot, since: slot, bits: String::new() };
            let mut bytes = self.bitmap();
            bytes[0] = 1;
            self.set_bitmap(&bytes);
            return true;
        }
        if slot < self.last - SLOTS + 1 || self.marked(slot) {
            return false;
        }
        let mut bytes = self.bitmap();
        if slot > self.last {
            let shift = (slot - self.last).min(SLOTS) as usize;
            let mut shifted = vec![0u8; bytes.len()];
            for age in 0..(SLOTS as usize).saturating_sub(shift) {
                if bytes[age / 8] & (1 << (age % 8)) != 0 {
                    let to = age + shift;
                    shifted[to / 8] |= 1 << (to % 8);
                }
            }
            bytes = shifted;
            self.last = slot;
        }
        let age = (self.last - slot) as usize;
        bytes[age / 8] |= 1 << (age % 8);
        self.set_bitmap(&bytes);
        true
    }
}

fn slot_of(at: DateTime<Utc>) -> i64 {
    at.timestamp().div_euclid(SLOT_SECONDS)
}

fn read(store: &Store) -> BTreeMap<String, Track> {
    store.meta_get(KEY).ok().flatten().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// `machine_id` was online at `at`. Writes only when the slot was not marked yet.
pub fn mark(store: &Store, machine_id: &str, at: DateTime<Utc>) {
    let _held = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut tracks = read(store);
    if !tracks.contains_key(machine_id) && tracks.len() >= MAX_MACHINES {
        // Make room by forgetting the machine seen longest ago.
        if let Some(oldest) = tracks.iter().min_by_key(|(_, track)| track.last).map(|(id, _)| id.clone()) {
            tracks.remove(&oldest);
        }
    }
    if tracks.entry(machine_id.to_string()).or_default().mark(slot_of(at))
        && let Ok(text) = serde_json::to_string(&tracks)
    {
        let _ = store.meta_set(KEY, &text);
    }
}

/// Forget a machine (it left the network).
pub fn forget(store: &Store, machine_id: &str) {
    let _held = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut tracks = read(store);
    if tracks.remove(machine_id).is_some()
        && let Ok(text) = serde_json::to_string(&tracks)
    {
        let _ = store.meta_set(KEY, &text);
    }
}

/// The share of the last seven days `machine_id` was online, as `self_id` (this daemon) saw it. `None`
/// until this daemon has a day of samples.
pub fn ratio(store: &Store, machine_id: &str, self_id: &str, now: DateTime<Utc>) -> Option<f32> {
    let tracks = read(store);
    ratio_of(&tracks, machine_id, self_id, slot_of(now))
}

fn ratio_of(tracks: &BTreeMap<String, Track>, machine_id: &str, self_id: &str, now: i64) -> Option<f32> {
    let me = tracks.get(self_id)?;
    let first = me.since.max(now - SLOTS + 1);
    let span = now - first + 1;
    if span < MIN_SPAN {
        return None;
    }
    let mine: Vec<i64> = (first..=now).filter(|slot| me.marked(*slot)).collect();
    if machine_id == self_id {
        return Some(mine.len() as f32 / span as f32);
    }
    if mine.is_empty() {
        return None;
    }
    let theirs = tracks.get(machine_id);
    let both = mine.iter().filter(|slot| theirs.is_some_and(|track| track.marked(**slot))).count();
    Some(both as f32 / mine.len() as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marking_shifts_the_window_and_counts_once_per_slot() {
        let mut track = Track::default();
        assert!(track.mark(100));
        assert!(!track.mark(100));
        assert!(track.mark(101));
        assert!(track.mark(99));
        assert!(track.marked(99) && track.marked(100) && track.marked(101));
        assert!(!track.mark(101 - SLOTS), "older than the window");
        assert!(track.mark(101 + SLOTS - 1));
        assert!(!track.marked(100), "shifted out of the week");
        assert!(track.marked(101));
        assert_eq!(track.bitmap().len(), 84);
    }

    #[test]
    fn ratios_need_a_day_and_count_peers_only_while_this_daemon_ran() {
        let mut tracks = BTreeMap::new();
        let start = 10_000;
        let me = tracks.entry("me".to_string()).or_insert_with(Track::default);
        // This daemon ran the first half of every 4-slot block for two days.
        for slot in start..start + 2 * MIN_SPAN {
            if slot % 4 < 2 {
                me.mark(slot);
            }
        }
        let peer = tracks.entry("vps".to_string()).or_insert_with(Track::default);
        for slot in start..start + 2 * MIN_SPAN {
            peer.mark(slot);
        }
        let laptop = tracks.entry("laptop".to_string()).or_insert_with(Track::default);
        for slot in start..start + 2 * MIN_SPAN {
            if slot % 8 == 0 {
                laptop.mark(slot);
            }
        }
        let now = start + 2 * MIN_SPAN - 1;
        assert!((ratio_of(&tracks, "me", "me", now).unwrap() - 0.5).abs() < 0.01);
        assert_eq!(ratio_of(&tracks, "vps", "me", now), Some(1.0), "always on while this daemon looked");
        assert!((ratio_of(&tracks, "laptop", "me", now).unwrap() - 0.25).abs() < 0.01);
        assert_eq!(ratio_of(&tracks, "unknown", "me", now), Some(0.0));
        assert_eq!(ratio_of(&tracks, "vps", "me", start + 10), None, "under a day of samples");
    }
}
