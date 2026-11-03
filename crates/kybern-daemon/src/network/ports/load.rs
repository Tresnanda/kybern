//! What a forward has fetched for the page loading now (ADE-126), so a slow page looks slow instead of broken.
//!
//! The viewing side of a forward that parses HTTP ([`super::http`]) counts each response's bytes as they arrive. A load
//! starts with the first request after [`QUIET`] without one open, and ends when none has been open for [`QUIET`]. Its
//! total is kept as the estimate of the next load. The forward's view carries the load ([`PortLoad`]) while requests are
//! open; `ports.changed` repeats it once a second, but only after [`ANNOUNCE_AFTER`], so a fast page sends nothing extra.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use kybern_protocol::PortLoad;

/// A load ends, and the next request starts a new one, after this long with no request open.
pub const QUIET: Duration = Duration::from_millis(1500);
/// A load is announced to clients only once it has run this long: shorter ones never show.
pub const ANNOUNCE_AFTER: Duration = Duration::from_secs(2);
/// The transfer rate is measured over this window.
const RATE_WINDOW: Duration = Duration::from_secs(3);
/// A load that runs longer than this (a long poll that never ends) is no longer shown.
pub const LONGEST: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct State {
    started: Option<Instant>,
    open: u32,
    received: u64,
    cached: u64,
    last_activity: Option<Instant>,
    /// Bytes received at each moment, for the rate.
    samples: VecDeque<(Instant, u64)>,
    /// The total of the last complete load.
    previous: Option<u64>,
}

impl State {
    /// End a load that has been quiet long enough, keeping its total.
    fn settle(&mut self, now: Instant) {
        if self.started.is_some() && self.open == 0 && self.last_activity.is_none_or(|at| now.duration_since(at) >= QUIET) {
            let total = self.received + self.cached;
            if total > 0 {
                self.previous = Some(total);
            }
            self.started = None;
            self.samples.clear();
        }
    }
}

/// The load of one forward.
#[derive(Default)]
pub struct LoadMeter {
    state: Mutex<State>,
    /// A task repeats the load to clients while it runs.
    ticking: AtomicBool,
    /// Every byte received over the forward's life.
    total: AtomicU64,
}

impl LoadMeter {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A request starts. True when it starts a new load.
    pub fn begin(&self) -> bool {
        let now = Instant::now();
        let mut state = self.lock();
        state.settle(now);
        let fresh = state.started.is_none();
        if fresh {
            state.started = Some(now);
            state.received = 0;
            state.cached = 0;
        }
        state.open += 1;
        state.last_activity = Some(now);
        fresh
    }

    /// Bytes of a response arrived over the network.
    pub fn received(&self, bytes: usize) {
        self.total.fetch_add(bytes as u64, Ordering::Relaxed);
        let now = Instant::now();
        let mut state = self.lock();
        state.received += bytes as u64;
        let total = state.received;
        state.samples.push_back((now, total));
        while state.samples.front().is_some_and(|(at, _)| now.duration_since(*at) > RATE_WINDOW) && state.samples.len() > 1 {
            state.samples.pop_front();
        }
        state.last_activity = Some(now);
    }

    /// A response was answered from this machine's cache.
    pub fn cached(&self, bytes: usize) {
        let mut state = self.lock();
        state.cached += bytes as u64;
        state.last_activity = Some(Instant::now());
    }

    /// A request ended (answered in full, failed or abandoned).
    pub fn end(&self) {
        let mut state = self.lock();
        state.open = state.open.saturating_sub(1);
        state.last_activity = Some(Instant::now());
    }

    /// The load in progress, while a request is open.
    pub fn view(&self) -> Option<PortLoad> {
        let now = Instant::now();
        let mut state = self.lock();
        state.settle(now);
        let started = state.started?;
        if state.open == 0 || now.duration_since(started) > LONGEST {
            return None;
        }
        let rate = match (state.samples.front(), state.samples.back()) {
            (Some((first_at, first)), Some((_, last))) => {
                // From the oldest sample in the window to now: a stall shows as a falling rate.
                let span = now.duration_since(*first_at).as_secs_f64().max(0.25);
                ((last - first) as f64 / span) as u64
            }
            _ => 0,
        };
        Some(PortLoad {
            received_bytes: state.received,
            cached_bytes: state.cached,
            expected_bytes: state.previous,
            bytes_per_second: rate,
            open_requests: state.open,
            elapsed_ms: now.duration_since(started).as_millis().min(u64::MAX as u128) as u64,
        })
    }

    /// Every byte received over the forward's life.
    pub fn total_received(&self) -> u64 {
        self.total.load(Ordering::Relaxed)
    }

    /// Whether a load runs (requests open, or not yet quiet).
    pub fn active(&self) -> bool {
        let mut state = self.lock();
        state.settle(Instant::now());
        state.started.is_some()
    }

    /// Claim the task that repeats the load to clients; false when one runs already.
    pub fn start_ticking(&self) -> bool {
        !self.ticking.swap(true, Ordering::AcqRel)
    }

    pub fn stop_ticking(&self) {
        self.ticking.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_load_counts_bytes_while_requests_are_open_and_estimates_the_next_from_its_total() {
        let meter = LoadMeter::default();
        assert!(meter.view().is_none());
        assert!(meter.begin(), "the first request starts a load");
        assert!(!meter.begin(), "a second one joins it");
        meter.received(1000);
        meter.cached(500);
        let load = meter.view().unwrap();
        assert_eq!((load.received_bytes, load.cached_bytes, load.open_requests, load.expected_bytes), (1000, 500, 2, None));
        meter.end();
        meter.end();
        assert!(meter.view().is_none(), "nothing shows once every request is answered");
        assert!(meter.active(), "the load is still settling");
        // After the quiet time the total becomes the estimate of the next load.
        meter.lock().last_activity = Some(Instant::now() - QUIET);
        assert!(!meter.active());
        assert!(meter.begin());
        assert_eq!(meter.view().unwrap().expected_bytes, Some(1500));
        assert_eq!(meter.view().unwrap().received_bytes, 0, "a new load counts from zero");
    }

    #[test]
    fn the_rate_covers_recent_bytes() {
        let meter = LoadMeter::default();
        meter.begin();
        {
            let mut state = meter.lock();
            let now = Instant::now();
            state.samples.push_back((now - Duration::from_secs(2), 0));
            state.received = 200_000;
            state.samples.push_back((now, 200_000));
        }
        let rate = meter.view().unwrap().bytes_per_second;
        assert!((90_000..=110_000).contains(&rate), "{rate}");
    }
}
