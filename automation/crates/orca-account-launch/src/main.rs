//! Rust account launcher; desktop shortcuts delegate before local account resolution.
//! `ACCOUNT --check` is read-only; `--run` executes inside the already-created local PTY.
//! New tabs carry their startup command in the create request and never receive injected input.
mod account;
mod launch;
mod restore;
mod rpc;
mod shortcut;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{env, fs, os::unix::process::CommandExt, path::PathBuf, process::Command};

fn main() {
    if let Err(error) = run() {
        eprintln!("orca-account-launch: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" {
        println!("orca-account-launch ACCOUNT [--check] [--chat] [--new-tab] [--from-shortcut]\norca-account-launch --restore [--restore-latest]\nRuns only on this Mac. --run [--agent-args TEXT] is the created terminal entry.");
        return Ok(());
    }
    let home = PathBuf::from(env::var_os("HOME").context("HOME is unset")?);
    if args[0] == "--restore" || args[0] == "--restore-latest" {
        return restore::command(&home, args[0] == "--restore-latest");
    }
    let has = |flag: &str| args.iter().any(|a| a == flag);
    if shortcut::uses_desktop(&args, env::var_os("ORCA_TERMINAL_HANDLE").is_some()) {
        return shortcut::hand_off(&home, &args[0], has("--check"));
    }
    let config: Value = serde_json::from_slice(&fs::read(
        home.join(".orca/account-shortcuts/accounts.json"),
    )?)?;
    let account = account::resolve(&config, &args[0], &home)?;
    account.ensure_profile()?;
    let supplied_args = args
        .iter()
        .position(|a| a == "--agent-args")
        .map(|i| args.get(i + 1).context("missing --agent-args value"))
        .transpose()?;
    if has("--run") {
        return execute(&account, supplied_args.map(String::as_str).unwrap_or(""));
    }
    let handle = (!has("--from-shortcut"))
        .then(|| env::var("ORCA_TERMINAL_HANDLE").ok())
        .flatten();
    anyhow::ensure!(
        !has("--chat") || (handle.is_some() && !has("--new-tab")),
        "--chat requires the current terminal and cannot be combined with --new-tab"
    );
    let rpc = rpc::Rpc::local(&home)?;
    let target = launch::local_target(&rpc, handle.as_deref())?;
    let settings = rpc.call("settings.get", json!({}))?["settings"].clone();
    let agent_args = settings["agentDefaultArgs"][&account.agent]
        .as_str()
        .unwrap_or("");
    let reuse = handle.is_some() && !has("--new-tab");
    if has("--check") {
        println!(
            "{}",
            json!({"account":account.id,"agent":account.agent,"executionHostId":"local","workspace":target["worktreeId"],"mode":if reuse {"current-terminal"} else {"new-tab"},"transport":"local-unix","injectedInput":false})
        );
        return Ok(());
    }
    if reuse {
        if has("--chat") {
            let _ = rpc.call("session.tabs.setTabProps", json!({"worktree":format!("id:{}",target["worktreeId"].as_str().unwrap()),"tabId":target["tabId"],"viewMode":"chat"}));
        }
        execute(&account, agent_args)
    } else {
        anyhow::ensure!(
            account.view_mode != "chat" || settings["experimentalNativeChat"] == true,
            "enable Orca Chat UI before opening account tabs"
        );
        let started = std::time::Instant::now();
        let params = launch::create_params(&account, &target, agent_args, &home, true);
        let response = launch::create(&rpc, params)?;
        eprintln!(
            "account={} host=local created={} elapsed_ms={}",
            account.id,
            response["tab"]["terminal"],
            started.elapsed().as_millis()
        );
        Ok(())
    }
}

/// Replace this process with the agent. Plain-word arguments exec directly: every account command
/// is an executable on the inherited PATH, so a second interactive zsh only re-read the rc files
/// and cost another process launch while Orca waited. Quoted arguments still go through zsh.
fn execute(account: &account::Account, args: &str) -> Result<()> {
    let mut command = match account.argv(args) {
        Some(argv) => {
            let mut direct = Command::new(&argv[0]);
            direct.args(&argv[1..]);
            direct
        }
        None => {
            let mut shell = Command::new("/bin/zsh");
            shell.args(["-ic", &account.shell_command(args)]);
            shell
        }
    };
    account.apply(&mut command);
    Err(command.exec()).context("execute local agent")
}
