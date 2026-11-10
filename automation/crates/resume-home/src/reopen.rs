//! `resume-home reopen`: resumes the agent of a tab brought back by Orca's Cmd+Shift+T.
//!
//! Orca's `tab.reopenClosed` recreates a closed terminal tab with its cwd, custom title and
//! colour, but starts a bare shell: the agent that ran there is gone. `session-title` records
//! each pane's title and owning session under `~/.local/state/session-title/orca/<handle>.json`.
//! The zsh precmd block "orca reopen resume" runs this once per new Orca shell. It reads the new
//! tab's title, picks the newest record with that title whose pane is closed and whose session
//! is not running, moves the record to the new pane and prints the resume command for zsh to
//! run. The `claude` zsh function and the `codex` shim then pick the owning account.
//!
//! It prints nothing (so the shell stays a plain shell) when the pane already has a record, the
//! tab title matches no closed pane, the session is running elsewhere or idle for more than
//! `MAX_IDLE`, or input is already waiting on the terminal: Orca types its own resume command
//! when it restores panes after its terminal daemon died, and that command wins.

use super::{homes, is_session_id, Agent};
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime};

/// A closed pane whose transcript has been quiet this long is not resumed by a reopen.
const MAX_IDLE: Duration = Duration::from_secs(7 * 24 * 3600);

#[derive(Debug, PartialEq)]
pub struct Pick {
    pub agent: Agent,
    pub session: String,
    pub title: String,
    /// The closed pane's record, moved to the new pane once the pick is accepted.
    pub record: PathBuf,
}

impl Pick {
    pub fn command(&self) -> String {
        match self.agent {
            Agent::Claude => format!("claude --dangerously-skip-permissions --resume {}", self.session),
            Agent::Codex => format!("codex --no-daemon resume {}", self.session),
        }
    }
}

/// The new pane's view of Orca: its tab's custom title and every live terminal handle.
pub struct OrcaView {
    pub title: String,
    pub live: HashSet<String>,
    pub workspace: PathBuf,
}

pub fn run(latest: bool) -> ExitCode {
    let Some(handle) = env::var("ORCA_TERMINAL_HANDLE")
        .ok()
        .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    else {
        return ExitCode::SUCCESS;
    };
    if !latest && input_pending() {
        return ExitCode::SUCCESS;
    }
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else { return ExitCode::SUCCESS };
    let records = home.join(".local/state/session-title/orca");
    // A pane with its own record already belongs to a session.
    if records.join(format!("{handle}.json")).exists() || !has_records(&records) {
        return ExitCode::SUCCESS;
    }
    let Some(view) = super::orca_view::query_orca(&home, &handle, latest) else { return ExitCode::SUCCESS };
    let now = SystemTime::now();
    let running = running_claude_sessions(&home);
    let chosen = pick(&home, &records, &handle, &view, now, &running)
        .or_else(|| latest.then(|| pick_latest(&home, &records, &handle, &view, now, &running)).flatten());
    let Some(pick) = chosen else {
        return ExitCode::SUCCESS;
    };
    if !latest && input_pending() {
        return ExitCode::SUCCESS;
    }
    // Move the record so hooks keep the title on the new pane and a second reopen cannot pick it.
    if fs::rename(&pick.record, records.join(format!("{handle}.json"))).is_err() {
        return ExitCode::SUCCESS;
    }
    if (latest || is_default_title(&view.title)) && !pick.title.is_empty() && view.title != pick.title {
        let _ = super::orca_view::rename_terminal(&home, &handle, &pick.title);
    }
    println!("{}", pick.command());
    ExitCode::SUCCESS
}

fn has_records(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|mut d| d.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().ends_with(".json"))))
}

fn is_default_title(title: &str) -> bool {
    title.is_empty() || title == "zsh" || title == "Terminal" || title.starts_with("Terminal ")
}

/// The newest closed pane whose recorded title equals this tab's title and whose session can be
/// resumed now.
pub fn pick(
    home: &Path,
    records: &Path,
    handle: &str,
    view: &OrcaView,
    now: SystemTime,
    running: &HashSet<String>,
) -> Option<Pick> {
    if is_default_title(&view.title) {
        return None;
    }
    let mut candidates: Vec<(SystemTime, PathBuf, String, String)> = fs::read_dir(records)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_name()?.to_str()?.strip_suffix(".json")?.to_string();
            if stem == handle || view.live.contains(&stem) {
                return None;
            }
            let record: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            let title = record["title"].as_str()?;
            if title != view.title {
                return None;
            }
            let session = record["session"].as_str().filter(|s| is_session_id(s))?.to_string();
            Some((entry.metadata().ok()?.modified().ok()?, path, session, title.to_string()))
        })
        .collect();
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    candidates.into_iter().find_map(|(_, record, session, title)| {
        resolve_resumable(home, &view.workspace, now, running, &session)
            .map(|(agent, _)| Pick { agent, session, title, record })
    })
}

/// The most recently active closed pane in `view.workspace`, used when a remote runtime reopened a
/// tab without carrying its custom title over `session.tabs.createTerminal`.
pub fn pick_latest(
    home: &Path,
    records: &Path,
    handle: &str,
    view: &OrcaView,
    now: SystemTime,
    running: &HashSet<String>,
) -> Option<Pick> {
    let mut recent: Vec<(SystemTime, PathBuf)> = fs::read_dir(records)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_name()?.to_str()?.strip_suffix(".json")?.to_string();
            if stem == handle || view.live.contains(&stem) {
                return None;
            }
            let mtime = entry.metadata().ok()?.modified().ok()?;
            (now.duration_since(mtime).unwrap_or_default() <= MAX_IDLE).then_some((mtime, path))
        })
        .collect();
    recent.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
    recent.into_iter().take(64).find_map(|(_, path)| {
        let record: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
        let title = record["title"].as_str().filter(|t| !is_default_title(t))?.to_string();
        let session = record["session"].as_str().filter(|s| is_session_id(s))?.to_string();
        let (agent, _) = resolve_resumable(home, &view.workspace, now, running, &session)?;
        Some(Pick { agent, session, title, record: path })
    })
}

fn resolve_resumable(
    home: &Path,
    workspace: &Path,
    now: SystemTime,
    running: &HashSet<String>,
    session: &str,
) -> Option<(Agent, SystemTime)> {
    if running.contains(session) {
        return None;
    }
    let (agent, last) = [Agent::Claude, Agent::Codex].into_iter().find_map(|agent| {
        if !super::workspace::matches(home, agent, session, workspace) {
            return None;
        }
        let last = homes(agent, home).iter().filter_map(|root| agent.session_mtime(root, session)).max()?;
        Some((agent, last))
    })?;
    (now.duration_since(last).unwrap_or_default() <= MAX_IDLE).then_some((agent, last))
}

/// Session ids of Claude processes alive in any account home (`<home>/sessions/<pid>.json`).
fn running_claude_sessions(home: &Path) -> HashSet<String> {
    homes(Agent::Claude, home)
        .iter()
        .filter_map(|root| fs::read_dir(root.join("sessions")).ok())
        .flat_map(|dir| dir.flatten())
        .filter_map(|entry| {
            let v: Value = serde_json::from_slice(&fs::read(entry.path()).ok()?).ok()?;
            let pid = v["pid"].as_i64()? as libc::pid_t;
            // SAFETY: signal 0 only checks that the process exists.
            (pid > 0 && unsafe { libc::kill(pid, 0) } == 0).then(|| v["sessionId"].as_str().map(str::to_string))?
        })
        .collect()
}

/// True when bytes are already queued on the terminal, i.e. something typed a command.
fn input_pending() -> bool {
    let mut n: libc::c_int = 0;
    // SAFETY: FIONREAD writes one c_int; fd 0 is this shell's terminal.
    let ok = unsafe { libc::ioctl(0, libc::FIONREAD, &mut n) } == 0;
    ok && n > 0
}


#[cfg(test)]
#[path = "reopen_tests.rs"]
mod tests;
