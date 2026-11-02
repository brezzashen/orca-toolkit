//! Query the execution hosts Orca runtime and extract the restored PTY workspace.
use super::reopen::OrcaView;
use serde_json::{json, Value};
use std::{env, fs, thread};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
const DEFAULT_ORCA_BIN_DIR: &str = "/Applications/Orca.app/Contents/Resources/bin";
const ORCA_LIMIT: Duration = Duration::from_millis(3000);
const SOCKET_LIMIT: Duration = Duration::from_millis(500);
const SOCKET_RETRY_SLEEP: Duration = Duration::from_millis(20);
const CLI_RETRY_SLEEP: Duration = Duration::from_millis(300);
/// Reads this pane's tab title and the live handles. Queries the local Orca Unix socket (~4 ms)
/// unless `ORCA_CLI_BIN_DIR` overrides the binary for tests. The tab can sit in a pending slot for
/// one renderer frame (~16 ms) after the shell starts, so a missing tab is retried briefly.
pub(super) fn query_orca(home: &Path, handle: &str) -> Option<OrcaView> {
    let bin_dir = env::var("ORCA_CLI_BIN_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| DEFAULT_ORCA_BIN_DIR.to_string());
    let use_socket = bin_dir == DEFAULT_ORCA_BIN_DIR;
    let bin = PathBuf::from(bin_dir).join("orca");
    let attempts = if use_socket { 4 } else { 3 };
    let retry_sleep = if use_socket { SOCKET_RETRY_SLEEP } else { CLI_RETRY_SLEEP };
    for attempt in 0..attempts {
        if attempt > 0 {
            thread::sleep(retry_sleep);
        }
        let value = if use_socket {
            query_orca_socket(home).or_else(|| {
                let out = run_bounded(&bin, &["terminal", "list", "--include-visual-layouts", "--json"])?;
                serde_json::from_str(&out).ok()
            })?
        } else {
            let out = run_bounded(&bin, &["terminal", "list", "--include-visual-layouts", "--json"])?;
            serde_json::from_str(&out).ok()?
        };
        if let Some(view) = parse_view(&value, handle) {
            return Some(view);
        }
        if is_orphaned_terminal(&value, handle) {
            return None;
        }
    }
    None
}

pub(super) fn is_orphaned_terminal(value: &Value, handle: &str) -> bool {
    value
        .pointer("/result/terminals")
        .and_then(Value::as_array)
        .is_some_and(|terms| {
            terms.iter().any(|t| {
                t.get("handle").and_then(Value::as_str) == Some(handle)
                    && t.get("orphaned").and_then(Value::as_bool) == Some(true)
            })
        })
}

fn query_orca_socket(home: &Path) -> Option<Value> {
    let user_data = env::var_os("ORCA_USER_DATA_PATH")
        .filter(|p| !p.is_empty())
        .map_or_else(|| home.join("Library/Application Support/orca"), PathBuf::from);
    let meta: Value = serde_json::from_slice(&fs::read(user_data.join("orca-runtime.json")).ok()?).ok()?;
    let token = meta.get("authToken")?.as_str()?;
    let endpoint = meta
        .get("transports")
        .and_then(Value::as_array)
        .and_then(|arr| arr.iter().find(|t| t.get("kind").and_then(Value::as_str) == Some("unix")))
        .or_else(|| meta.get("transport").filter(|t| t.get("kind").and_then(Value::as_str) == Some("unix")))
        .and_then(|t| t.get("endpoint"))
        .and_then(Value::as_str)?;
    let mut stream = UnixStream::connect(endpoint).ok()?;
    let _ = stream.set_read_timeout(Some(SOCKET_LIMIT));
    let _ = stream.set_write_timeout(Some(SOCKET_LIMIT));
    let req = json!({
        "id": "reopen",
        "authToken": token,
        "method": "terminal.list",
        "params": { "includeVisualLayouts": true }
    });
    stream.write_all(format!("{req}\n").as_bytes()).ok()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let frame: Value = serde_json::from_str(trimmed).ok()?;
        if frame.get("_keepalive").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        return (frame.get("id").and_then(Value::as_str) == Some("reopen")
            && frame.get("ok").and_then(Value::as_bool) != Some(false))
        .then_some(frame);
    }
}

pub fn parse_view(value: &Value, handle: &str) -> Option<OrcaView> {
    let terminal = value.pointer("/result/terminals")?.as_array()?.iter()
        .find(|t| t["handle"].as_str() == Some(handle))?;
    // A desktop client must never resume a remote PTY against its own history.
    if terminal["executionHostId"].as_str() != Some("local") {
        return None;
    }
    let workspace = PathBuf::from(terminal["worktreePath"].as_str()?);
    if !workspace.is_absolute() { return None; }
    let live = value
        .pointer("/result/terminals")?
        .as_array()?
        .iter()
        .filter_map(|t| t["handle"].as_str().map(str::to_string))
        .collect();
    let title = tab_title(value.pointer("/result/visualLayouts")?, handle)?;
    Some(OrcaView { title, live, workspace })
}

/// The title of the tab whose pane tree holds `handle`; a tab node carries `tabId` and `panes`.
fn tab_title(node: &Value, handle: &str) -> Option<String> {
    match node {
        Value::Object(map) => {
            if let (Some(_), Some(panes)) = (map.get("tabId"), map.get("panes")) {
                return holds(panes, handle).then(|| map.get("title").and_then(Value::as_str).unwrap_or("").to_string());
            }
            map.values().find_map(|v| tab_title(v, handle))
        }
        Value::Array(items) => items.iter().find_map(|v| tab_title(v, handle)),
        _ => None,
    }
}

fn holds(node: &Value, handle: &str) -> bool {
    match node {
        Value::Object(map) => {
            map.get("handle").and_then(Value::as_str) == Some(handle) || map.values().any(|v| holds(v, handle))
        }
        Value::Array(items) => items.iter().any(|v| holds(v, handle)),
        _ => false,
    }
}

fn run_bounded(bin: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut buf = String::new();
        stdout.read_to_string(&mut buf).map(|_| buf)
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return reader.join().ok()?.ok(),
            Ok(Some(_)) => return None,
            Ok(None) if start.elapsed() > ORCA_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => return None,
        }
    }
}
