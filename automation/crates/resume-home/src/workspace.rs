//! Resolve legacy session records against the execution host's transcript workspace.
//! No desktop-client history is consulted: this helper runs beside the restored PTY.

use super::{homes, Agent};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub fn matches(home: &Path, agent: Agent, session: &str, workspace: &Path) -> bool {
    homes(agent, home).iter().any(|root| {
        transcripts(root, agent, session).iter().any(|path| {
            transcript_workspace(path).is_some_and(|cwd| same_path(&cwd, workspace))
        })
    })
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.is_absolute() && b.is_absolute()
        && a.canonicalize().unwrap_or_else(|_| a.to_path_buf())
            == b.canonicalize().unwrap_or_else(|_| b.to_path_buf())
}

fn transcripts(root: &Path, agent: Agent, session: &str) -> Vec<PathBuf> {
    match agent {
        Agent::Claude => fs::read_dir(root.join("projects")).into_iter().flatten().flatten()
            .map(|p| p.path().join(format!("{session}.jsonl"))).filter(|p| p.is_file()).collect(),
        Agent::Codex => {
            let suffix = format!("-{session}.jsonl");
            let mut found = Vec::new();
            for dir in ["sessions", "archived_sessions"] {
                find(&root.join(dir), &suffix, 3, &mut found);
            }
            found
        }
    }
}

fn find(dir: &Path, suffix: &str, depth: u32, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() && depth > 0 {
            find(&path, suffix, depth - 1, found);
        } else if path.is_file() && entry.file_name().to_string_lossy().ends_with(suffix) {
            found.push(path);
        }
    }
}

fn transcript_workspace(path: &Path) -> Option<PathBuf> {
    // Only read session headers; do not load conversation bodies into memory.
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(64) {
        let value: Value = serde_json::from_str(&line.ok()?).ok()?;
        let cwd = if value["type"] == "session_meta" {
            value.pointer("/payload/cwd")
        } else {
            value.get("cwd")
        };
        if let Some(cwd) = cwd.and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Some(PathBuf::from(cwd));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_exact_workspace_and_rejects_missing_metadata() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude/projects/p");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("session.jsonl");
        fs::write(&path, "{\"cwd\":\"/work/one\"}\n").unwrap();
        assert!(matches(home.path(), Agent::Claude, "session", Path::new("/work/one")));
        assert!(!matches(home.path(), Agent::Claude, "session", Path::new("/work/two")));
        assert!(!matches(home.path(), Agent::Claude, "session", Path::new("/work")));
        fs::write(&path, "{}\n").unwrap();
        assert!(!matches(home.path(), Agent::Claude, "session", Path::new("/work/one")));
    }

    #[test]
    fn uses_execution_host_history_including_codex_archive() {
        let host = tempfile::tempdir().unwrap();
        let client = tempfile::tempdir().unwrap();
        let archive = host.path().join(".codex-profiles/work/archived_sessions");
        fs::create_dir_all(&archive).unwrap();
        fs::write(archive.join("rollout-date-session.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/work/one\"}}\n").unwrap();
        assert!(matches(host.path(), Agent::Codex, "session", Path::new("/work/one")));
        assert!(!matches(client.path(), Agent::Codex, "session", Path::new("/work/one")));
    }
}
