//! Run a resumed agent session under the account home that owns it.
//!
//! Orca restores a pane by typing a plain resume command into a fresh shell (`claude --resume
//! <id>`, `codex resume <id>`), so the resume reads whatever `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
//! that shell has, not the account the session started on (`cc1`..`cc4`, `co1`/`co2`). The
//! session is then reported missing.
//!
//! Two entry points:
//! - `resume-home claude -- <args>` prints the owning `CLAUDE_CONFIG_DIR`; the zsh `claude`
//!   function in `~/.zshrc` runs the real binary under it.
//! - Invoked as `codex` (the `~/.local/shims/codex` symlink, first on PATH in interactive zsh),
//!   it sets `CODEX_HOME` to the owning home and execs the next `codex` on PATH. A shim is used
//!   because Orca installs its own `codex` shell function after the rc files, which replaces
//!   any user function of that name; that function still calls `command codex`.
//!
//! - `resume-home reopen` prints the resume command for a tab Orca reopened (see `reopen.rs`).
//!
//! Nothing changes when the arguments carry no session id, the current home already owns the
//! session, or no home does.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::SystemTime;

mod reopen;
mod orca_view;
mod workspace;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Agent {
    Claude,
    Codex,
}

impl Agent {
    fn env_var(self) -> &'static str {
        match self {
            Agent::Claude => "CLAUDE_CONFIG_DIR",
            Agent::Codex => "CODEX_HOME",
        }
    }

    fn default_home(self, home: &Path) -> PathBuf {
        match self {
            Agent::Claude => home.join(".claude"),
            Agent::Codex => home.join(".codex"),
        }
    }

    fn profiles_dir(self, home: &Path) -> PathBuf {
        match self {
            Agent::Claude => home.join(".claude-profiles"),
            Agent::Codex => home.join(".codex-profiles"),
        }
    }

    /// The session id this invocation resumes, if any.
    fn resume_id(self, args: &[String]) -> Option<String> {
        match self {
            // `--resume <id>`, `--resume=<id>` or `-r <id>`.
            Agent::Claude => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    let candidate = if arg == "--resume" || arg == "-r" {
                        iter.next().cloned()
                    } else {
                        arg.strip_prefix("--resume=").map(str::to_owned)
                    };
                    if let Some(id) = candidate.filter(|id| is_session_id(id)) {
                        return Some(id);
                    }
                }
                None
            }
            // `codex [flags] resume [flags] <id>`.
            Agent::Codex => {
                let at = args.iter().position(|a| a == "resume")?;
                args[at + 1..].iter().find(|a| is_session_id(a)).cloned()
            }
        }
    }

    /// Newest modification time of the session's transcript under `root`.
    fn session_mtime(self, root: &Path, id: &str) -> Option<SystemTime> {
        match self {
            // <root>/projects/<cwd>/<id>.jsonl
            Agent::Claude => {
                let name = format!("{id}.jsonl");
                fs::read_dir(root.join("projects"))
                    .ok()?
                    .flatten()
                    .filter_map(|project| file_mtime(&project.path().join(&name)))
                    .max()
            }
            // <root>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl or <root>/archived_sessions/...
            Agent::Codex => {
                let suffix = format!("-{id}.jsonl");
                [root.join("sessions"), root.join("archived_sessions")]
                    .iter()
                    .filter_map(|dir| newest_match(dir, &suffix, 3))
                    .max()
            }
        }
    }
}

/// A session id is a UUID; anything else (a search term, a path) is left to the agent.
fn is_session_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok().filter(|m| m.is_file())?.modified().ok()
}

/// Newest file under `dir` (descending at most `depth` levels) whose name ends with `suffix`.
fn newest_match(dir: &Path, suffix: &str, depth: u32) -> Option<SystemTime> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                (depth > 0).then(|| newest_match(&path, suffix, depth - 1)).flatten()
            } else if entry.file_name().to_string_lossy().ends_with(suffix) {
                file_mtime(&path)
            } else {
                None
            }
        })
        .max()
}

/// Every account home of `agent` on this host: the default home plus each profile directory.
fn homes(agent: Agent, home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![agent.default_home(home)];
    if let Ok(entries) = fs::read_dir(agent.profiles_dir(home)) {
        let mut profiles: Vec<PathBuf> =
            entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        profiles.sort();
        roots.extend(profiles);
    }
    roots
}

/// The home to switch to, or `None` when `current` already owns the session or no home does.
fn resolve(agent: Agent, home: &Path, current: &Path, id: &str) -> Option<PathBuf> {
    if agent.session_mtime(current, id).is_some() {
        return None;
    }
    homes(agent, home)
        .into_iter()
        .filter_map(|root| agent.session_mtime(&root, id).map(|t| (t, root)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, root)| root)
}

/// The owning home for this invocation, if it differs from the current one.
fn owner(agent: Agent, args: &[String]) -> Option<PathBuf> {
    let id = agent.resume_id(args)?;
    let home = PathBuf::from(env::var_os("HOME")?);
    let current = env::var_os(agent.env_var())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| agent.default_home(&home));
    resolve(agent, &home, &current, &id)
}

/// The first `name` on PATH that is not this binary, so the shim never execs itself.
fn next_on_path(name: &str) -> Option<PathBuf> {
    let me = env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    env::split_paths(&env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .filter(|p| p.is_file())
        .find(|p| p.canonicalize().ok() != me)
}

fn run_codex_shim(args: Vec<OsString>) -> ExitCode {
    let Some(real) = next_on_path("codex") else {
        eprintln!("codex shim: no other codex on PATH");
        return ExitCode::from(127);
    };
    let text: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let mut command = Command::new(&real);
    command.args(&args);
    if let Some(root) = owner(Agent::Codex, &text) {
        let home = env::var_os("HOME").map(PathBuf::from);
        if home.map(|h| Agent::Codex.default_home(&h)) == Some(root.clone()) {
            command.env_remove("CODEX_HOME");
        } else {
            command.env("CODEX_HOME", &root);
        }
        eprintln!("codex: resuming under {}", root.display());
    }
    let error = command.exec();
    eprintln!("codex shim: cannot start {}: {error}", real.display());
    ExitCode::from(127)
}

fn main() -> ExitCode {
    let mut argv = env::args_os();
    let invoked = argv.next().map(PathBuf::from).unwrap_or_default();
    let rest: Vec<OsString> = argv.collect();
    if invoked.file_name().is_some_and(|n| n == "codex") {
        return run_codex_shim(rest);
    }
    let mut text = rest.iter().map(|a| a.to_string_lossy().into_owned());
    let agent = match text.next().as_deref() {
        Some("claude") => Agent::Claude,
        Some("codex") => Agent::Codex,
        Some("reopen") => return reopen::run(),
        _ => {
            eprintln!("usage: resume-home <claude|codex> -- <agent args...> | resume-home reopen");
            return ExitCode::from(2);
        }
    };
    let args: Vec<String> = text.skip_while(|a| a == "--").collect();
    if let Some(root) = owner(agent, &args) {
        println!("{}", root.display());
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
