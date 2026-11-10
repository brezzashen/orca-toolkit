//! `orca-ghost-tabs`: keep paired Orca desktop clients in step when this Mac (the host) closes a tab.
//!
//!   orca-ghost-tabs run [--dry-run] [--quiet]   one round
//!   orca-ghost-tabs install                     (re)install the LaunchAgent (every 15 s)
//!
//! Orca 1.4.255 clients mirror this server's tabs, but drop a mirror only when the close was made
//! on that client. A tab closed from the phone, the CLI, automation or by its agent exiting stays
//! on the other clients as a dead tab whose finished-agent sidebar row cannot be opened. Each round
//! finds the tabs this server closed (`server.rs`) and removes their mirrors on each client
//! (`client.mjs`, run over ssh). Clients come from `~/.orca/ghost-tabs/clients.json`:
//! `{ "clients": ["<ssh alias>", ...], "node": "<node path on the clients, default node>" }`.
//! Workaround for https://github.com/stablyai/orca/issues/40683; remove it once Orca fixes that.
mod round;
mod server;

use anyhow::{bail, Context, Result};
use plist::{Dictionary, Value as Plist};
use std::{
    fs::File,
    path::PathBuf,
    process::{Command, ExitCode},
};

const LABEL: &str = "local.orca-toolkit.ghost-tabs";
const INTERVAL_SECS: i64 = 15;

fn home() -> Result<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).context("HOME is not set")
}

fn clients() -> Result<Vec<round::Client>> {
    let path = home()?.join(".orca/ghost-tabs/clients.json");
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?)?;
    let node = config["node"].as_str().unwrap_or("node").to_string();
    Ok(config["clients"]
        .as_array()
        .context("clients.json has no clients array")?
        .iter()
        .filter_map(|client| client.as_str())
        .map(|ssh| round::Client { ssh: ssh.to_string(), node: node.clone() })
        .collect())
}

fn run(args: &[String]) -> Result<ExitCode> {
    let dry_run = args.iter().any(|a| a == "--dry-run");
    let quiet = args.iter().any(|a| a == "--quiet");
    let dir = home()?.join(".orca/ghost-tabs");
    std::fs::create_dir_all(&dir)?;
    let lock = File::create(dir.join("run.lock"))?;
    if lock.try_lock().is_err() {
        return Ok(ExitCode::SUCCESS);
    }
    let state_path = dir.join("state.json");
    let mut state: round::State = match std::fs::read_to_string(&state_path) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("parse {}", state_path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => round::State::default(),
        Err(e) => return Err(e.into()),
    };
    let trace = home()?.join("Library/Application Support/Orca/logs/main.trace.ndjson");
    let clients = clients()?;
    let closed = round::detect(&mut state, &trace)?;
    round::queue(&mut state, &clients, &closed);
    let reports = round::flush(&mut state, &clients, !dry_run);
    if !dry_run {
        let tmp = state_path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&state)? + "\n")?;
        std::fs::rename(&tmp, &state_path)?;
    }
    if !quiet || !reports.is_empty() {
        let at = Command::new("/bin/date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output()?;
        let line = serde_json::json!({
            "at": String::from_utf8_lossy(&at.stdout).trim(),
            "dryRun": dry_run,
            "closedThisRound": closed.len(),
            "pending": state.pending.iter().map(|(k, v)| (k.clone(), v.len())).collect::<std::collections::BTreeMap<_, _>>(),
            "reports": reports,
        });
        println!("{line}");
    }
    let failed = reports.iter().any(|r| r.get("error").is_some() || r["reply"].get("error").is_some());
    Ok(if failed { ExitCode::from(1) } else { ExitCode::SUCCESS })
}

fn launchctl(args: &[&str]) -> Result<()> {
    let output = Command::new("/bin/launchctl").args(args).output().context("run launchctl")?;
    if !output.status.success() {
        bail!("launchctl {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

fn install() -> Result<ExitCode> {
    let home = home()?;
    let binary = std::env::current_exe().context("locate this executable")?;
    let plist_path = home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"));
    let logs = home.join("Library/Logs").join(LABEL);
    std::fs::create_dir_all(&logs)?;
    let text = |p: &std::path::Path| Plist::String(p.display().to_string());
    let mut job = Dictionary::new();
    job.insert("Label".into(), LABEL.into());
    job.insert("ProgramArguments".into(), Plist::Array(vec![text(&binary), "run".into(), "--quiet".into()]));
    job.insert("StartInterval".into(), INTERVAL_SECS.into());
    job.insert("RunAtLoad".into(), true.into());
    job.insert("ProcessType".into(), "Background".into());
    job.insert("StandardOutPath".into(), text(&logs.join("stdout.log")));
    job.insert("StandardErrorPath".into(), text(&logs.join("stderr.log")));
    Plist::Dictionary(job).to_file_xml(&plist_path).context("write LaunchAgent plist")?;
    let uid = Command::new("/usr/bin/id").arg("-u").output().context("read uid")?;
    let domain = format!("gui/{}", String::from_utf8_lossy(&uid.stdout).trim());
    let service = format!("{domain}/{LABEL}");
    let _ = launchctl(&["bootout", &service]);
    for _ in 0..20 {
        if launchctl(&["print", &service]).is_err() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    launchctl(&["bootstrap", &domain, &plist_path.display().to_string()])?;
    println!("Installed {LABEL}\nPlist: {}\nLogs: {}", plist_path.display(), logs.display());
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        Some("install") => install(),
        _ => Err(anyhow::anyhow!("usage: orca-ghost-tabs run [--dry-run] [--quiet] | install")),
    };
    result.unwrap_or_else(|error| {
        eprintln!("orca-ghost-tabs: {error:#}");
        ExitCode::from(2)
    })
}

#[cfg(test)]
mod tests;
