//! Hands a launch to the paired-host search when the chord opened no tab on this Mac.
//!
//! On a client Mac the visible workspace often belongs to another paired Mac, so the chord opens the tab in a
//! paired runtime. Reaching that runtime needs Orca's end-to-end encrypted pairing protocol, which
//! the official JavaScript client implements; `shortcut-launch.mjs --pressed-at` searches only the
//! paired hosts for a fresh terminal and never presses the chord again. The tap keeps holding the
//! launch lock and passes `--shortcut-locked` so the child does not wait on it.

use anyhow::{Context, Result};
use std::fs::OpenOptions;
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// True when this Mac has at least one paired Orca environment to search.
pub fn has_paired_hosts(home: &Path) -> bool {
    let path = home.join("Library/Application Support/orca/orca-environments.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value["environments"].as_array().map(|list| !list.is_empty()))
        .unwrap_or(false)
}

pub fn spawn(home: &Path, id: &str, pressed_epoch_ms: u64) -> Result<Child> {
    let dir = home.join(".orca/account-shortcuts");
    let log = OpenOptions::new().create(true).append(true).open(home.join("Library/Logs/orca-fkey-tap.log"))?;
    Command::new(home.join(".local/bin/node"))
        .arg(dir.join("shortcut-launch.mjs"))
        .args([id, "--pressed-at", &pressed_epoch_ms.to_string(), "--shortcut-locked"])
        .current_dir(&dir)
        .env_remove("ORCA_TERMINAL_HANDLE")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .context("start the paired-host search")
}
