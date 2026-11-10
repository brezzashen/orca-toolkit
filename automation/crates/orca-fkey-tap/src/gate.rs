//! Press gate: one press opens one tab, yet an abandoned launch never holds the keys for long.
//!
//! A burst of presses must not open several tabs (2026-10-28: three F5 presses in two seconds
//! opened three conversations), so a press within SUPERSEDE_AFTER_MS of the launch in flight is
//! refused. The old gate held every key for the launch's whole search (a 15 s hold, a 30 s
//! deadline): closing a just-opened tab before its alias landed left the search running and
//! swallowed F7 for 30 s (2026-11-10, a client Mac over its host). A press after that window, while the
//! launch has still not found its terminal, now supersedes it: the old search sees its generation
//! change, stops and releases the launch lock. SUPERSEDE_AFTER_MS sits above the p95 paired-host
//! discovery time (186 client launches: p50 1.7 s, p95 3.1 s, p99 8.6 s), so a slow but live launch
//! is rarely cut short. A launch that already found its terminal is never superseded.

use std::sync::{Mutex, MutexGuard};

pub const SUPERSEDE_AFTER_MS: u64 = 4_000;
// After a launch ends, presses this soon still belong to the tab whose agent is booting; the tail
// never reaches past SUPERSEDE_AFTER_MS from the press, so a slow launch leaves no extra wait.
pub const LAUNCH_TAIL_MS: u64 = 1_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Refuse,
    Supersede,
}

struct InFlight {
    press_ms: u64,
    found: bool,
}

pub struct Gate {
    generation: u64,
    in_flight: Option<InFlight>,
    tail_until_ms: u64,
}

impl Gate {
    pub const fn new() -> Self {
        Self { generation: 0, in_flight: None, tail_until_ms: 0 }
    }

    pub fn decide(&self, now_ms: u64) -> Decision {
        match &self.in_flight {
            Some(launch) if launch.found || now_ms < launch.press_ms + SUPERSEDE_AFTER_MS => Decision::Refuse,
            Some(_) => Decision::Supersede,
            None if now_ms < self.tail_until_ms => Decision::Refuse,
            None => Decision::Accept,
        }
    }

    /// Decides a press and, unless refused, makes it the launch in flight with a new generation.
    pub fn admit(&mut self, now_ms: u64) -> (Decision, u64) {
        let decision = self.decide(now_ms);
        if decision != Decision::Refuse {
            self.generation += 1;
            self.in_flight = Some(InFlight { press_ms: now_ms, found: false });
        }
        (decision, self.generation)
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    pub fn found(&mut self, generation: u64) {
        if let (true, Some(launch)) = (self.is_current(generation), self.in_flight.as_mut()) {
            launch.found = true;
        }
    }

    /// Ends a launch; a superseded generation leaves the newer launch's state alone.
    pub fn finish(&mut self, generation: u64, now_ms: u64) {
        if !self.is_current(generation) {
            return;
        }
        if let Some(launch) = self.in_flight.take() {
            self.tail_until_ms = (now_ms + LAUNCH_TAIL_MS).min(launch.press_ms + SUPERSEDE_AFTER_MS);
        }
    }
}

static GATE: Mutex<Gate> = Mutex::new(Gate::new());

pub fn lock() -> MutexGuard<'static, Gate> {
    GATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_opens_one_tab() {
        let mut gate = Gate::new();
        assert_eq!(gate.admit(1_000), (Decision::Accept, 1));
        assert_eq!(gate.admit(1_300).0, Decision::Refuse);
        assert_eq!(gate.admit(4_900).0, Decision::Refuse);
        gate.finish(1, 2_900);
        assert_eq!(gate.admit(4_000).0, Decision::Refuse, "tail after a fast launch");
        assert_eq!(gate.admit(4_400).0, Decision::Accept);
    }

    #[test]
    fn an_abandoned_search_is_superseded_after_the_window() {
        let mut gate = Gate::new();
        gate.admit(1_000);
        assert_eq!(gate.admit(4_999).0, Decision::Refuse);
        assert_eq!(gate.admit(5_000), (Decision::Supersede, 2));
        assert!(!gate.is_current(1));
        gate.finish(1, 5_020);
        assert_eq!(gate.admit(5_100).0, Decision::Refuse, "the stale finish must not reopen the gate");
        gate.found(1);
        assert_eq!(gate.admit(9_000).0, Decision::Supersede, "the stale found must not pin the new launch");
    }

    #[test]
    fn a_found_terminal_is_never_superseded() {
        let mut gate = Gate::new();
        gate.admit(1_000);
        gate.found(1);
        assert_eq!(gate.admit(20_000).0, Decision::Refuse);
        gate.finish(1, 20_100);
        assert_eq!(gate.admit(20_200).0, Decision::Accept, "the tail never reaches past the window");
    }
}
