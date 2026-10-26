//! The "a wake message is on its way" flag between Bun's thread (which queues commands and posts the wake) and GPUI's
//! UI thread (which drains them). Platform independent so its rules are unit-tested anywhere.
//!
//! A posted wake can be lost: its window is destroyed before the message is taken off the queue, or the post races a
//! window closing. So the flag carries the time it was set and a claim older than [`STALE_MS`] wins again, and the host
//! clears it when the window it woke is destroyed.

use std::sync::atomic::{AtomicU64, Ordering};

/// A wake not drained after this long is treated as lost and posted again.
pub const STALE_MS: u64 = 100;

/// 0 when no wake is pending, else the claim time in milliseconds plus one.
pub struct WakeFlag(AtomicU64);

impl WakeFlag {
    pub const fn new() -> Self {
        WakeFlag(AtomicU64::new(0))
    }

    /// Whether the caller should post a wake now (`now_ms` on a monotonic clock): none is pending, or the pending one
    /// is older than [`STALE_MS`]. A `true` claims the flag until [`clear`](Self::clear) or until it goes stale.
    pub fn claim(&self, now_ms: u64) -> bool {
        let mut current = self.0.load(Ordering::Acquire);
        loop {
            if current != 0 && now_ms.saturating_sub(current - 1) < STALE_MS {
                return false;
            }
            match self.0.compare_exchange_weak(current, now_ms + 1, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(seen) => current = seen,
            }
        }
    }

    /// The wake was taken off the queue, its post failed, or its window is gone.
    pub fn clear(&self) {
        self.0.store(0, Ordering::Release);
    }

    pub fn pending(&self) -> bool {
        self.0.load(Ordering::Acquire) != 0
    }
}

impl Default for WakeFlag {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_wake_until_drained_or_stale() {
        let flag = WakeFlag::new();
        assert!(flag.claim(1_000), "the first command posts");
        assert!(!flag.claim(1_010), "later commands ride on the pending wake");
        assert!(!flag.claim(1_000 + STALE_MS - 1));
        assert!(flag.claim(1_000 + STALE_MS), "a wake pending this long was lost: post again");
        assert!(!flag.claim(1_000 + STALE_MS + 5));
        flag.clear();
        assert!(!flag.pending());
        assert!(flag.claim(1_200), "drained: the next command posts");
    }

    #[test]
    fn a_destroyed_window_clears_the_flag() {
        let flag = WakeFlag::new();
        assert!(flag.claim(0), "time zero still counts as a claim");
        assert!(flag.pending());
        // `window_destroyed` clears it, so the next command (or the repost) wakes another window at once.
        flag.clear();
        assert!(flag.claim(1));
    }
}
