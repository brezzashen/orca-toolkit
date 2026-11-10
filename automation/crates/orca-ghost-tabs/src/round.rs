//! One round: find tabs this server closed since the last round, queue them for every paired
//! client, and ask each reachable client to drop its leftover mirror of them.
use crate::server::{self, Cursor};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CLIENT_JS: &str = include_str!("client.mjs");
/// A client that stays unreachable this long is assumed to have reloaded Orca since.
const PENDING_TTL_MS: u64 = 24 * 3600 * 1000;
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub cursor: Option<Cursor>,
    /// Live tab -> handle at the end of the previous round.
    #[serde(default)]
    pub live: BTreeMap<String, String>,
    /// Client ssh alias -> tab -> when it was queued (ms).
    #[serde(default)]
    pub pending: BTreeMap<String, BTreeMap<String, u64>>,
}

pub struct Client {
    pub ssh: String,
    pub node: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Tabs closed since the last round: a previously live tab with a recorded exit cause, or a close
/// span for a tab that is not live now.
pub fn detect(state: &mut State, trace: &Path) -> Result<BTreeSet<String>> {
    let live = server::live_tabs()?;
    let mut closed: BTreeSet<String> = state
        .live
        .iter()
        .filter(|(tab, handle)| !live.contains_key(*tab) && server::confirmed_closed(handle))
        .map(|(tab, _)| tab.clone())
        .collect();
    let (traced, cursor) = server::new_closes(trace, state.cursor.as_ref())?;
    closed.extend(traced.into_iter().filter(|tab| !live.contains_key(tab)));
    state.cursor = Some(cursor);
    state.live = live;
    Ok(closed)
}

pub fn queue(state: &mut State, clients: &[Client], closed: &BTreeSet<String>) {
    let now = now_ms();
    for client in clients {
        let pending = state.pending.entry(client.ssh.clone()).or_default();
        for tab in closed {
            pending.entry(tab.clone()).or_insert(now);
        }
        pending.retain(|_, queued| now.saturating_sub(*queued) < PENDING_TTL_MS);
    }
    state.pending.retain(|_, tabs| !tabs.is_empty());
}

/// Runs the client script for every client with queued tabs; settled tabs leave the queue.
pub fn flush(state: &mut State, clients: &[Client], apply: bool) -> Vec<Value> {
    let mut reports = Vec::new();
    for client in clients {
        let Some(pending) = state.pending.get_mut(&client.ssh) else { continue };
        let ids: Vec<String> = pending.keys().cloned().collect();
        match run_client(client, &ids, apply) {
            Ok(reply) => {
                let results = reply["results"].as_object().cloned().unwrap_or_default();
                for (tab, outcome) in &results {
                    if matches!(outcome.as_str(), Some("closed" | "absent" | "attached")) {
                        pending.remove(tab);
                    }
                }
                if reply["orca"] == "not-running" {
                    pending.clear();
                }
                let acted = results.values().any(|o| o != "absent");
                if acted || reply.get("error").is_some() {
                    reports.push(json!({"client": client.ssh, "reply": reply}));
                }
            }
            Err(error) => reports.push(json!({"client": client.ssh, "error": format!("{error:#}")})),
        }
    }
    state.pending.retain(|_, tabs| !tabs.is_empty());
    reports
}

fn run_client(client: &Client, ids: &[String], apply: bool) -> Result<Value> {
    // Ids are interpolated into the remote command line: pass only tab UUIDs.
    let ids: Vec<&str> =
        ids.iter().map(String::as_str).filter(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).collect();
    let mode = if apply { "apply" } else { "dry" };
    let remote = format!("GHOST_MODE={mode} GHOST_TAB_IDS={} {} --input-type=module", ids.join(","), client.node);
    let mut child = Command::new("/usr/bin/ssh")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", &client.ssh, &remote])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn ssh")?;
    child.stdin.take().context("ssh stdin")?.write_all(CLIENT_JS.as_bytes())?;
    let started = Instant::now();
    while child.try_wait()?.is_none() {
        if started.elapsed() > CLIENT_TIMEOUT {
            let _ = child.kill();
            anyhow::bail!("{} did not answer within {}s", client.ssh, CLIENT_TIMEOUT.as_secs());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().last().unwrap_or_default();
    serde_json::from_str(line).with_context(|| {
        format!("{} exit {}: {}", client.ssh, output.status, String::from_utf8_lossy(&output.stderr).trim())
    })
}
