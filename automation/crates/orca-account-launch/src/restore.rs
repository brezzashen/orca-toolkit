//! Resume the local closed-tab record after Orca recreates its original tab and workspace.
//! Native Cmd+Shift+T owns tab placement; resume-home owns session/account selection.
use crate::{launch, rpc::Rpc};
use anyhow::{Context, Result};
use std::{
    env,
    path::Path,
    process::{Command, Stdio},
};

pub fn command(home: &Path) -> Result<()> {
    let Some(handle) = env::var("ORCA_TERMINAL_HANDLE")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    // Resolve only this recreated local PTY. Never search paired desktops or their history.
    let rpc = Rpc::local(home)?;
    let mut checked = launch::local_target(&rpc, Some(&handle));
    for _ in 0..3 {
        if checked.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        checked = launch::local_target(&rpc, Some(&handle));
    }
    checked?;
    let output = Command::new(home.join(".local/bin/resume-home"))
        .arg("reopen")
        .stdin(Stdio::inherit())
        .env_remove("ORCA_ENVIRONMENT")
        .env_remove("ORCA_PAIRING_CODE")
        .output()
        .context("resolve the locally closed conversation")?;
    anyhow::ensure!(output.status.success(), "local resume lookup failed");
    let text = String::from_utf8(output.stdout)?;
    print!("{text}");
    Ok(())
}
