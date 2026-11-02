//! Create one terminal with its startup command attached. No key simulation or terminal search.
use crate::{
    account::{quote, Account},
    rpc::Rpc,
};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;

pub fn local_target(rpc: &Rpc, handle: Option<&str>) -> Result<Value> {
    let handle = match handle {
        Some(value) => value.to_string(),
        None => rpc.call("terminal.resolveActive", json!({}))?["handle"]
            .as_str()
            .context("select a local Orca workspace with a terminal")?
            .to_string(),
    };
    let terminal = rpc.call("terminal.show", json!({"terminal":handle}))?["terminal"].clone();
    validate_local(&terminal)?;
    Ok(terminal)
}

pub fn validate_local(terminal: &Value) -> Result<()> {
    anyhow::ensure!(
        terminal["executionHostId"] == "local",
        "select a workspace on this Mac; account shortcuts never forward to another host"
    );
    anyhow::ensure!(
        terminal["worktreeId"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "terminal has no workspace identity"
    );
    Ok(())
}

pub fn create_params(
    account: &Account,
    target: &Value,
    args: &str,
    home: &Path,
    focus: bool,
) -> Value {
    let command = format!(
        "{} {} --run --agent-args {}",
        quote(
            &home
                .join(".local/bin/orca-account-launch")
                .to_string_lossy()
        ),
        quote(&account.id),
        quote(args)
    );
    let request_id = format!(
        "account-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    json!({"worktree":format!("id:{}",target["worktreeId"].as_str().unwrap()),
        "command":command,"launchAgent":account.agent,"startupCommandDelivery":"shell-ready",
        "viewMode":account.view_mode,"activate":focus,"select":focus,"navigation":if focus {"host"} else {"none"},"clientMutationId":request_id})
}

pub fn create(rpc: &Rpc, params: Value) -> Result<Value> {
    // A lost response can already have created a terminal. Never retry this mutation.
    let response = rpc.call("session.tabs.createTerminal", params)?;
    anyhow::ensure!(
        response["tab"]["terminal"].as_str().is_some(),
        "Orca did not confirm the new terminal; do not retry automatically"
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_or_unidentified_targets_fail_closed() {
        for host in [Value::Null, json!("runtime:remote"), json!("ssh:remote-mac")] {
            assert!(
                validate_local(&json!({"executionHostId":host,"worktreeId":"repo::/tmp"})).is_err()
            );
        }
        assert!(
            validate_local(&json!({"executionHostId":"local","worktreeId":"repo::/tmp"})).is_ok()
        );
    }
    #[test]
    fn startup_command_is_attached_to_one_identified_workspace() {
        let a = Account {
            id: "C1".into(),
            agent: "codex".into(),
            command: "codex".into(),
            view_mode: "chat".into(),
            set: Default::default(),
            unset: vec![],
        };
        let p = create_params(
            &a,
            &json!({"worktreeId":"repo::/Users/test/repo"}),
            "--foo",
            Path::new("/Users/test"),
            true,
        );
        assert_eq!(p["worktree"], "id:repo::/Users/test/repo");
        assert_eq!(p["startupCommandDelivery"], "shell-ready");
        assert_eq!(p["launchAgent"], "codex");
        assert!(p["command"]
            .as_str()
            .unwrap()
            .contains("--run --agent-args"));
        assert!(p.get("environment").is_none());
    }
}
