//! What this Mac (the Orca host) knows about closed tabs: its live terminal list, a terminal's
//! exit cause, and the close spans in Orca's main trace.
use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::Path,
    process::Command,
};

/// Orca's CLI as installed with the app; launchd does not put it on PATH.
const ORCA: &str = "/Applications/Orca.app/Contents/Resources/bin/orca";

fn orca(args: &[&str]) -> Result<Value> {
    let output = Command::new(ORCA).args(args).output().with_context(|| format!("run orca {}", args.join(" ")))?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("orca {} printed no JSON: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()))?;
    Ok(value)
}

/// Live tab id -> one terminal handle in it. Errors when Orca does not answer, so a round never
/// mistakes an unreachable Orca for "every tab closed".
pub fn live_tabs() -> Result<BTreeMap<String, String>> {
    let reply = orca(&["terminal", "list", "--limit", "1000", "--json"])?;
    if reply["ok"] != Value::Bool(true) {
        bail!("orca terminal list failed: {}", reply["error"]);
    }
    let terminals = reply.pointer("/result/terminals").and_then(Value::as_array).context("terminal list has no terminals")?;
    Ok(terminals
        .iter()
        .filter(|t| t["orphaned"] != Value::Bool(true))
        .filter_map(|t| Some((t["tabId"].as_str()?.to_string(), t["handle"].as_str()?.to_string())))
        .collect())
}

/// True only on positive evidence: Orca still knows the terminal and records why it ended.
/// An unknown handle is not evidence (Orca may have restarted and re-issued handles).
pub fn confirmed_closed(handle: &str) -> bool {
    let Ok(reply) = orca(&["terminal", "show", "--terminal", handle, "--json"]) else { return false };
    let terminal = &reply["result"]["terminal"];
    reply["ok"] == Value::Bool(true) && terminal["connected"] == Value::Bool(false) && terminal["exitCause"].is_object()
}

/// The tab a close span names, when the close went through. Mobile closes name `tab::leaf`.
pub fn closed_tab(line: &str) -> Option<String> {
    let span: Value = serde_json::from_str(line).ok()?;
    let name = span["name"].as_str()?;
    if !matches!(name, "terminal.closeTab" | "terminal.close" | "runtime.session-tabs.close") {
        return None;
    }
    let attrs = &span["attributes"];
    if attrs["decision"].as_str() != Some("allowed") || attrs["outcome"].as_str() == Some("failed") {
        return None;
    }
    if name == "terminal.close" && attrs["closeMode"].as_str() != Some("tab") {
        return None;
    }
    let tab = attrs["tabId"].as_str()?.split("::").next()?;
    (tab.len() == 36).then(|| tab.to_string())
}

/// Read position in the trace file; a new inode means Orca rotated it.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Cursor {
    pub inode: u64,
    pub offset: u64,
}

/// Close spans written since `cursor`. On rotation the rest of the rotated file (`.1`, same
/// inode as before) is read first. `None` cursor (first run) reads both files from the start.
pub fn new_closes(trace: &Path, cursor: Option<&Cursor>) -> Result<(BTreeSet<String>, Cursor)> {
    let inode = std::fs::metadata(trace).with_context(|| format!("stat {}", trace.display()))?.ino();
    let rotated = trace.with_extension("ndjson.1");
    let mut tabs = BTreeSet::new();
    let start = match cursor {
        Some(c) if c.inode == inode => c.offset,
        Some(c) => {
            if std::fs::metadata(&rotated).map(|m| m.ino()).ok() == Some(c.inode) {
                read_from(&rotated, c.offset, &mut tabs)?;
            }
            0
        }
        None => {
            if rotated.exists() {
                read_from(&rotated, 0, &mut tabs)?;
            }
            0
        }
    };
    let offset = read_from(trace, start, &mut tabs)?;
    Ok((tabs, Cursor { inode, offset }))
}

/// Collects close spans of whole lines after `offset`; returns the offset after the last full line.
fn read_from(path: &Path, offset: u64, tabs: &mut BTreeSet<String>) -> Result<u64> {
    let mut file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let len = file.metadata()?.len();
    let offset = if offset > len { 0 } else { offset };
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    for line in String::from_utf8_lossy(&bytes[..complete]).lines() {
        if line.contains("close") {
            tabs.extend(closed_tab(line));
        }
    }
    Ok(offset + complete as u64)
}
