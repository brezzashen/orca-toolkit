//! Resume the local closed-tab record after Orca recreates its original tab and workspace.
//! Native Cmd+Shift+T owns tab placement; resume-home owns session/account selection.
use crate::{launch, rpc::Rpc};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    env,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn command(home: &Path, latest: bool) -> Result<()> {
    let Some(handle) = env::var("ORCA_TERMINAL_HANDLE")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    // Resolve only this recreated local PTY. Never search paired desktops or their history.
    let rpc = Rpc::local(home)?;
    let target = show_within(&rpc, &handle, LOOKUP_BUDGET)?;
    let mut cmd = Command::new(home.join(".local/bin/resume-home"));
    cmd.arg("reopen");
    if latest {
        cmd.arg("--latest");
    }
    let output = cmd
        .stdin(Stdio::inherit())
        .env_remove("ORCA_ENVIRONMENT")
        .env_remove("ORCA_PAIRING_CODE")
        .output()
        .context("resolve the locally closed conversation")?;
    anyhow::ensure!(output.status.success(), "local resume lookup failed");
    let text = String::from_utf8(output.stdout)?;
    if latest && !text.trim().is_empty() {
        if let (Some(worktree), Some(tab_id)) = (target["worktreeId"].as_str(), target["tabId"].as_str()) {
            let chat_enabled = rpc
                .call_within("settings.get", serde_json::json!({}), LOOKUP_BUDGET)
                .ok()
                .is_some_and(|s| s["settings"]["experimentalNativeChat"] == true);
            if chat_enabled {
                let _ = rpc.call_within(
                    "session.tabs.setTabProps",
                    serde_json::json!({"worktree": format!("id:{worktree}"), "tabId": tab_id, "viewMode": "chat"}),
                    LOOKUP_BUDGET,
                );
            }
        }
    }
    print!("{text}");
    Ok(())
}

/// The whole terminal lookup, retries included, ends within this budget: a reopened tab is
/// resumed in the background, and a stalled Orca must not keep that check alive for minutes.
const LOOKUP_BUDGET: Duration = Duration::from_millis(1000);

/// `terminal.show` for this PTY, retried briefly while Orca adopts a just-created tab.
fn show_within(rpc: &Rpc, handle: &str, budget: Duration) -> Result<Value> {
    let end = Instant::now() + budget;
    loop {
        let remaining = end.saturating_duration_since(Instant::now());
        let shown = rpc
            .call_within("terminal.show", json!({ "terminal": handle }), remaining.max(Duration::from_millis(1)))
            .and_then(|r| {
                let terminal = r["terminal"].clone();
                launch::validate_local(&terminal).map(|_| terminal)
            });
        if shown.is_ok() || Instant::now() + Duration::from_millis(20) >= end {
            return shown;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
