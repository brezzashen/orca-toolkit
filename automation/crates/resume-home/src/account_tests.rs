//! Regression tests for resuming sessions under their owning account.
use super::*;

const ID: &str = "30282c1e-b290-4943-a088-437ce40e1722";
const CODEX_ID: &str = "01a13627-f9ba-73e2-92ce-b77fca9b0965";

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn seed_claude(root: &Path, id: &str) {
    let project = root.join("projects").join("-Users-x-repo");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join(format!("{id}.jsonl")), "{}\n").unwrap();
}

fn seed_codex(root: &Path, dir: &str, id: &str) {
    let day = root.join(dir);
    fs::create_dir_all(&day).unwrap();
    fs::write(day.join(format!("rollout-2026-10-14T00-45-51-{id}.jsonl")), "{}\n").unwrap();
}

#[test]
fn parses_claude_resume_forms() {
    let c = Agent::Claude;
    assert_eq!(c.resume_id(&args(&["--dangerously-skip-permissions", "--resume", ID])), Some(ID.into()));
    assert_eq!(c.resume_id(&args(&[&format!("--resume={ID}")])), Some(ID.into()));
    assert_eq!(c.resume_id(&args(&["-r", ID])), Some(ID.into()));
    assert_eq!(c.resume_id(&args(&["--resume"])), None);
    assert_eq!(c.resume_id(&args(&["--resume", "../etc/passwd"])), None);
    assert_eq!(c.resume_id(&args(&["auth", "status"])), None);
}

#[test]
fn parses_codex_resume_forms() {
    let c = Agent::Codex;
    assert_eq!(
        c.resume_id(&args(&["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "resume", CODEX_ID])),
        Some(CODEX_ID.into())
    );
    assert_eq!(c.resume_id(&args(&["resume", "--last"])), None);
    assert_eq!(c.resume_id(&args(&["exec", CODEX_ID])), None);
    assert_eq!(c.resume_id(&args(&["login", "status"])), None);
}

#[test]
fn claude_switches_to_the_owning_profile() {
    let home = tempfile::tempdir().unwrap();
    let team = home.path().join(".claude-profiles/team");
    let team2 = home.path().join(".claude-profiles/team2");
    fs::create_dir_all(team.join("projects")).unwrap();
    seed_claude(&team2, ID);
    assert_eq!(resolve(Agent::Claude, home.path(), &team, ID), Some(team2));
}

#[test]
fn claude_keeps_the_current_owner_and_finds_the_default() {
    let home = tempfile::tempdir().unwrap();
    let default = home.path().join(".claude");
    let team2 = home.path().join(".claude-profiles/team2");
    seed_claude(&default, ID);
    assert_eq!(resolve(Agent::Claude, home.path(), &default, ID), None);
    assert_eq!(resolve(Agent::Claude, home.path(), &team2, ID), Some(default));
}

#[test]
fn codex_switches_between_default_and_profile_homes() {
    let home = tempfile::tempdir().unwrap();
    let main = home.path().join(".codex");
    let work = home.path().join(".codex-profiles/work");
    fs::create_dir_all(&main).unwrap();
    seed_codex(&work, "sessions/2026/10/14", CODEX_ID);
    assert_eq!(resolve(Agent::Codex, home.path(), &main, CODEX_ID), Some(work.clone()));
    assert_eq!(resolve(Agent::Codex, home.path(), &work, CODEX_ID), None);
}

#[test]
fn codex_finds_archived_sessions() {
    let home = tempfile::tempdir().unwrap();
    let main = home.path().join(".codex");
    seed_codex(&main, "archived_sessions", CODEX_ID);
    let work = home.path().join(".codex-profiles/work");
    assert_eq!(resolve(Agent::Codex, home.path(), &work, CODEX_ID), Some(main));
}

#[test]
fn nothing_when_no_home_owns_the_session() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(resolve(Agent::Claude, home.path(), &home.path().join(".claude"), ID), None);
    assert_eq!(resolve(Agent::Codex, home.path(), &home.path().join(".codex"), CODEX_ID), None);
}
