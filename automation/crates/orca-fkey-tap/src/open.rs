//! Opens one account tab in the visible Orca workspace from inside the tap, with no child process.
//!
//! Orca exposes no RPC for the workspace on screen (`terminal.resolveActive` returns the first tab
//! with an active leaf), so the tab still comes from Orca's own New Terminal chord. The rest runs
//! here: snapshot the local terminals, post the chord, poll for the one new writable terminal,
//! claim it in the ledger the JavaScript Services path shares, and write the alias with its own
//! carriage return (Orca's `enter:true` waits a fixed ~500 ms). When no tab appears on this Mac
//! within REMOTE_HANDOFF, the visible workspace belongs to a paired host and `remote.rs` searches
//! there while this Mac keeps being polled; one chord opens one tab, so only one side can win.

use crate::account::{self, Chord};
use crate::claims::Claims;
use crate::orca_rpc::Rpc;
use crate::remote;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Child;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DISCOVER_DEADLINE: Duration = Duration::from_secs(30);
const DISCOVER_INTERVAL: Duration = Duration::from_millis(10);
const REMOTE_HANDOFF: Duration = Duration::from_millis(700);
const PAIRED_FAILURE_GRACE: Duration = Duration::from_secs(1);
const NATIVE_REOPEN_WAIT: Duration = Duration::from_millis(180);
const LOCK_WAIT: Duration = Duration::from_secs(2);
const DELIVERY_CHECK_DELAYS_MS: [u64; 4] = [100, 250, 500, 1_000];
const HID_EVENT_TAP: u32 = 0;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state_id: i32) -> *mut c_void;
    fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> *mut c_void;
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *mut c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const c_void);
}

/// Ties a launch to the press gate (`gate.rs`): `cancelled` turns true once a newer press
/// supersedes this one, and `found` marks the terminal as found so it can no longer be superseded.
pub struct Control<'a> {
    pub cancelled: &'a dyn Fn() -> bool,
    pub found: &'a dyn Fn(),
}

/// A newer press took over before this launch found its terminal; not a failure worth a banner.
#[derive(Debug)]
pub struct Superseded;

impl std::fmt::Display for Superseded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("superseded by a newer press")
    }
}

impl std::error::Error for Superseded {}

pub struct Timing {
    pub terminal: String,
    pub prepare_ms: u128,
    pub discover_ms: u128,
    pub send_ms: u128,
}

/// Runs one launch; `frontmost` re-checks Orca after the lock, right before the chord.
pub fn run(home: &Path, id: &str, frontmost: impl Fn() -> bool, control: &Control) -> Result<Timing> {
    let started = Instant::now();
    let dir = home.join(".orca/account-shortcuts");
    let _lock = acquire_lock(&dir.join("runtime"))?;
    let config: Value = read_json(&dir.join("accounts.json"))?;
    let command = account::local_command(&config, id)?;
    let chord = account::terminal_chord(&read_json(&home.join(".orca/keybindings.json"))?)?;
    let rpc = Rpc::local(home)?;
    let baseline: HashSet<String> = terminals(&rpc)?.iter().filter_map(handle).collect();
    if !frontmost() {
        bail!("Orca is no longer frontmost; no tab was opened");
    }
    press(&chord);
    let pressed = Instant::now();
    let pressed_epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let claims_path = dir.join("runtime/claimed-terminals.json");
    let search = Search { home, id, pressed_epoch_ms, paired: remote::has_paired_hosts(home), handoff: REMOTE_HANDOFF };
    let terminal = match discover(&rpc, &baseline, &Claims::load(&claims_path)?, &chord, &search, control)? {
        Found::Local(terminal) => {
            (control.found)();
            terminal
        }
        Found::Remote => {
            let found = pressed.elapsed().as_millis();
            return Ok(Timing { terminal: "paired-host".into(), prepare_ms: pressed.duration_since(started).as_millis(), discover_ms: found, send_ms: 0 });
        }
    };
    // Reload: a paired-host search that lost the race may have written the ledger meanwhile.
    Claims::load(&claims_path)?.claim(&terminal)?;
    let found = Instant::now();
    send(&rpc, &terminal, &command)?;
    Ok(Timing {
        terminal,
        prepare_ms: pressed.duration_since(started).as_millis(),
        discover_ms: found.duration_since(pressed).as_millis(),
        send_ms: found.elapsed().as_millis(),
    })
}

/// Completes `Shift+Cmd+T` when Orca's native `tab.reopenClosed` refuses a paired remote workspace.
pub fn run_reopen(home: &Path, pressed_epoch_ms: u64, frontmost: impl Fn() -> bool, control: &Control) -> Result<Timing> {
    let started = Instant::now();
    if !remote::has_paired_hosts(home) {
        return Ok(Timing { terminal: "native-local".into(), prepare_ms: 0, discover_ms: 0, send_ms: 0 });
    }
    let dir = home.join(".orca/account-shortcuts");
    let _lock = acquire_lock(&dir.join("runtime"))?;
    let rpc = Rpc::local(home)?;
    let claims_path = dir.join("runtime/claimed-terminals.json");
    let baseline: HashSet<String> = terminals(&rpc)?.iter().filter_map(handle).collect();
    let wait_started = Instant::now();
    while wait_started.elapsed() < NATIVE_REOPEN_WAIT {
        if (control.cancelled)() {
            return Err(Superseded.into());
        }
        if let Ok(current) = terminals(&rpc) {
            let claims = Claims::load(&claims_path)?;
            if let Some(found) = pick_native_reopened(&current, &baseline, &claims, pressed_epoch_ms) {
                Claims::load(&claims_path)?.claim(&found)?;
                return Ok(Timing {
                    terminal: format!("native:{found}"),
                    prepare_ms: wait_started.duration_since(started).as_millis(),
                    discover_ms: wait_started.elapsed().as_millis(),
                    send_ms: 0,
                });
            }
        }
        std::thread::sleep(DISCOVER_INTERVAL);
    }
    let chord = account::terminal_chord(&read_json(&home.join(".orca/keybindings.json"))?)?;
    if !frontmost() {
        bail!("Orca is no longer frontmost; no tab was reopened");
    }
    press(&chord);
    let pressed = Instant::now();
    let chord_epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let search = Search { home, id: "REOPEN", pressed_epoch_ms: chord_epoch_ms, paired: true, handoff: Duration::ZERO };
    let terminal = match discover(&rpc, &baseline, &Claims::load(&claims_path)?, &chord, &search, control)? {
        Found::Local(terminal) => {
            (control.found)();
            terminal
        }
        Found::Remote => {
            let found = pressed.elapsed().as_millis();
            return Ok(Timing { terminal: "paired-host".into(), prepare_ms: pressed.duration_since(started).as_millis(), discover_ms: found, send_ms: 0 });
        }
    };
    Claims::load(&claims_path)?.claim(&terminal)?;
    let found = Instant::now();
    send(&rpc, &terminal, "orca_reopen_tab")?;
    Ok(Timing {
        terminal,
        prepare_ms: pressed.duration_since(started).as_millis(),
        discover_ms: found.duration_since(pressed).as_millis(),
        send_ms: found.elapsed().as_millis(),
    })
}

fn read_json(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

/// Takes the lock the JavaScript path takes with `lockf -k` (flock on the same inode).
fn acquire_lock(dir: &Path) -> Result<File> {
    std::fs::create_dir_all(dir)?;
    let file = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(dir.join("launch.lock"))?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(std::fs::TryLockError::WouldBlock) => bail!("another account shortcut is still running"),
            Err(std::fs::TryLockError::Error(error)) => return Err(error).context("lock launch.lock"),
        }
    }
}

fn terminals(rpc: &Rpc) -> Result<Vec<Value>> {
    let result = rpc.call("terminal.list", json!({ "includeVisualLayouts": false }))?;
    Ok(result["terminals"].as_array().cloned().unwrap_or_default())
}

fn handle(terminal: &Value) -> Option<String> {
    terminal["handle"].as_str().map(str::to_owned)
}

fn press(chord: &Chord) {
    // Private source (-1 = kCGEventSourceStatePrivate) prevents physical Shift+Cmd keys still held
    // during Shift+Cmd+T from merging into the synthetic Ctrl+Alt+T chord.
    unsafe {
        let source = CGEventSourceCreate(-1);
        for down in [true, false] {
            let event = CGEventCreateKeyboardEvent(source, chord.key_code, down);
            if event.is_null() {
                continue;
            }
            CGEventSetFlags(event, chord.flags);
            CGEventPost(HID_EVENT_TAP, event);
            CFRelease(event);
        }
        if !source.is_null() {
            CFRelease(source);
        }
    }
}

/// The one new, writable, unclaimed terminal; two at once are ambiguous and get no input.
fn pick_new(current: &[Value], baseline: &HashSet<String>, claims: &Claims) -> Option<String> {
    let mut fresh = current
        .iter()
        .filter(|t| t["writable"] == true)
        .filter_map(handle)
        .filter(|h| !baseline.contains(h) && !claims.has(h));
    let first = fresh.next()?;
    fresh.next().is_none().then_some(first)
}

fn pick_native_reopened(current: &[Value], baseline: &HashSet<String>, claims: &Claims, pressed_epoch_ms: u64) -> Option<String> {
    if let Some(found) = pick_new(current, baseline, claims) {
        return Some(found);
    }
    let cutoff = pressed_epoch_ms.saturating_sub(300);
    let mut fresh = current.iter().filter(|t| {
        t["writable"] == true
            && (t["agentIdentity"].is_null() || t["agentIdentity"] == false)
            && t["lastOutputAt"].as_u64().is_some_and(|ts| ts >= cutoff)
            && t["preview"].as_str().unwrap_or("").len() <= 2_000
    }).filter_map(handle).filter(|h| !claims.has(h));
    let first = fresh.next()?;
    fresh.next().is_none().then_some(first)
}

struct Search<'a> {
    home: &'a Path,
    id: &'a str,
    pressed_epoch_ms: u64,
    paired: bool,
    handoff: Duration,
}

enum Found {
    Local(String),
    /// The paired-host search delivered the command and exited successfully.
    Remote,
}

fn discover(rpc: &Rpc, baseline: &HashSet<String>, claims: &Claims, chord: &Chord, search: &Search, control: &Control) -> Result<Found> {
    let started = Instant::now();
    let mut child: Option<Child> = None;
    let mut handed_off = false;
    let mut limit = DISCOVER_DEADLINE;
    let mut paired_failed = false;
    while started.elapsed() < limit {
        if (control.cancelled)() {
            // Free the launch lock at once so the superseding press can open its tab.
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(Superseded.into());
        }
        if let Ok(current) = terminals(rpc) {
            if let Some(found) = pick_new(&current, baseline, claims) {
                if let Some(mut child) = child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Ok(Found::Local(found));
            }
        }
        if !handed_off && search.paired && started.elapsed() >= search.handoff {
            handed_off = true;
            child = Some(remote::spawn(search.home, search.id, search.pressed_epoch_ms)?);
        }
        if let Some(running) = child.as_mut() {
            if let Some(status) = running.try_wait()? {
                child = None;
                if status.success() {
                    return Ok(Found::Remote);
                }
                // The paired search found nothing it could use, e.g. the user closed the new tab
                // before the alias landed (terminal_not_writable). One chord opens one tab, so
                // polling this Mac for the rest of DISCOVER_DEADLINE only holds the launch lock
                // and swallows every F-key for ~30 s (2026-11-10, a client Mac over its host).
                paired_failed = true;
                limit = limit_after_paired_failure(limit, started.elapsed());
            }
        }
        std::thread::sleep(DISCOVER_INTERVAL);
    }
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    if paired_failed {
        bail!("the paired-host search after {} failed (its error is logged above) and no tab opened on this Mac", chord.label)
    }
    bail!("Orca opened no terminal within 30 s of {}; is a workspace selected?", chord.label)
}

/// After a failed paired-host search, this Mac gets a short grace for a slow local tab, never more
/// than the original deadline.
fn limit_after_paired_failure(limit: Duration, elapsed: Duration) -> Duration {
    limit.min(elapsed + PAIRED_FAILURE_GRACE)
}

/// One write only: a lost reply is checked, never resent.
fn send(rpc: &Rpc, terminal: &str, command: &str) -> Result<()> {
    let text = format!("{command}\r");
    let Err(error) = rpc.call("terminal.send", json!({ "terminal": terminal, "text": text, "enter": false })) else {
        return Ok(());
    };
    for delay in DELIVERY_CHECK_DELAYS_MS {
        std::thread::sleep(Duration::from_millis(delay));
        let shown = rpc.call("terminal.list", json!({ "handles": [terminal] }));
        let row = shown.as_ref().ok().and_then(|r| r["terminals"].get(0).cloned()).unwrap_or(Value::Null);
        let has_agent = !row["agentIdentity"].is_null() && row["agentIdentity"] != false;
        if has_agent || row["preview"].as_str().is_some_and(|p| p.contains(command)) {
            return Ok(());
        }
    }
    Err(error.context("send the account command; nothing was resent"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_one_new_writable_unclaimed_terminal_wins() {
        let dir = tempfile::tempdir().unwrap();
        let mut claims = Claims::load(&dir.path().join("claims.json")).unwrap();
        let baseline: HashSet<String> = ["old".to_owned()].into();
        let row = |h: &str, w: bool| json!({ "handle": h, "writable": w });
        assert_eq!(pick_new(&[row("old", true), row("new", true)], &baseline, &claims).as_deref(), Some("new"));
        assert_eq!(pick_new(&[row("new", false)], &baseline, &claims), None);
        assert_eq!(pick_new(&[row("a", true), row("b", true)], &baseline, &claims), None);
        claims.claim("new").unwrap();
        assert_eq!(pick_new(&[row("new", true)], &baseline, &claims), None);
        let reloaded = Claims::load(&dir.path().join("claims.json")).unwrap();
        assert!(reloaded.has("new"));
        assert_eq!(std::fs::read_to_string(dir.path().join("claims.json")).unwrap(), r#"["[null,\"new\"]"]"#);
    }

    #[test]
    fn a_failed_paired_search_ends_the_launch_within_the_grace() {
        let at = |ms| Duration::from_millis(ms);
        assert_eq!(limit_after_paired_failure(DISCOVER_DEADLINE, at(2_400)), at(3_400));
        assert_eq!(limit_after_paired_failure(DISCOVER_DEADLINE, at(29_500)), DISCOVER_DEADLINE);
        assert_eq!(limit_after_paired_failure(at(3_400), at(5_000)), at(3_400));
    }
}
