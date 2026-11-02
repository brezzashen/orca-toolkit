//! F-keys and Services always follow the desktop renderer's visible workspace.
//! A local resolveActive result may be stale while a remote workspace is on screen.
use anyhow::{Context, Result};
use std::{
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
};

pub fn command(home: &Path, account: &str, check: bool) -> Command {
    let dir = home.join(".orca/account-shortcuts");
    let mut command = Command::new(home.join(".local/bin/node"));
    command.arg(dir.join("shortcut-launch.mjs")).arg(account);
    if check {
        command.arg("--check");
    }
    // A desktop shortcut never inherits the invoking agent's terminal identity.
    command
        .env_remove("ORCA_TERMINAL_HANDLE")
        .current_dir(dir)
        .stdin(Stdio::null());
    command
}

pub fn uses_desktop(args: &[String], has_handle: bool) -> bool {
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    !has("--run") && !has("--restore") && !has("--chat")
        && (has("--from-shortcut") || !has_handle)
}

pub fn hand_off(home: &Path, account: &str, check: bool) -> Result<()> {
    eprintln!("account={account} using the visible Orca workspace");
    Err(command(home, account, check).exec()).context("execute account-shortcuts/shortcut-launch.mjs")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_path_drops_the_terminal_handle_and_keeps_check_read_only() {
        let c = command(Path::new("/Users/test"), "A3", true);
        assert_eq!(c.get_program(), "/Users/test/.local/bin/node");
        let args: Vec<_> = c.get_args().collect();
        assert_eq!(args, ["/Users/test/.orca/account-shortcuts/shortcut-launch.mjs", "A3", "--check"]);
        assert!(c
            .get_envs()
            .any(|(k, v)| k == "ORCA_TERMINAL_HANDLE" && v.is_none()));
        assert!(command(Path::new("/h"), "C1", false).get_args().all(|a| a != "--check"));
    }

    #[test]
    fn shortcut_routing_never_depends_on_a_local_terminal_or_account() {
        for has_handle in [false, true] {
            let args = vec!["C2".into(), "--from-shortcut".into()];
            assert!(uses_desktop(&args, has_handle));
        }
        assert!(uses_desktop(&["A5".into()], false));
        assert!(!uses_desktop(&["C2".into(), "--chat".into()], false));
        assert!(!uses_desktop(&["C2".into()], true));
        assert!(!uses_desktop(&["C2".into(), "--new-tab".into()], true));
        assert!(!uses_desktop(&["C2".into(), "--run".into()], false));
    }
}
