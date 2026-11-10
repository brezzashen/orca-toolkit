use super::*;
use crate::orca_view::{parse_view, is_orphaned_terminal};
use serde_json::json;

const OLD: &str = "30282c1e-b290-4943-a088-437ce40e1722";
const NEWER: &str = "4a1b2c3d-0000-4000-8000-000000000001";

fn seed_claude(home: &Path, profile: &str, id: &str) {
    let project = home.join(".claude-profiles").join(profile).join("projects/-Users-x-repo");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join(format!("{id}.jsonl")), "{\"cwd\":\"/Users/x/repo\"}\n").unwrap();
}

fn record(dir: &Path, handle: &str, title: &str, session: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("{handle}.json"));
    fs::write(&path, json!({"title": title, "session": session}).to_string()).unwrap();
    path
}

fn view(title: &str, live: &[&str]) -> OrcaView {
    OrcaView { title: title.into(), live: live.iter().map(|s| s.to_string()).collect(), workspace: "/Users/x/repo".into() }
}

#[test]
fn picks_the_closed_pane_with_the_tab_title() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("records");
    seed_claude(home.path(), "team2", OLD);
    let rec = record(&dir, "term_closed", "告警→一键接管", OLD);
    record(&dir, "term_other", "别的→标题", NEWER);
    let got = pick(home.path(), &dir, "term_new", &view("告警→一键接管", &["term_new"]), SystemTime::now(), &HashSet::new());
    assert_eq!(got, Some(Pick { agent: Agent::Claude, session: OLD.into(), title: "告警→一键接管".into(), record: rec }));
    assert_eq!(got.unwrap().command(), format!("claude --dangerously-skip-permissions --resume {OLD}"));
}

#[test]
fn skips_live_panes_running_sessions_and_untitled_tabs() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("records");
    seed_claude(home.path(), "team", OLD);
    record(&dir, "term_live", "告警→一键接管", OLD);
    let v = view("告警→一键接管", &["term_live", "term_new"]);
    assert_eq!(pick(home.path(), &dir, "term_new", &v, SystemTime::now(), &HashSet::new()), None);
    fs::rename(dir.join("term_live.json"), dir.join("term_closed.json")).unwrap();
    let running: HashSet<String> = [OLD.to_string()].into();
    assert_eq!(pick(home.path(), &dir, "term_new", &v, SystemTime::now(), &running), None);
    assert_eq!(pick(home.path(), &dir, "term_new", &view("", &[]), SystemTime::now(), &HashSet::new()), None);
    assert_eq!(pick(home.path(), &dir, "term_new", &view("zsh", &[]), SystemTime::now(), &HashSet::new()), None);
    assert_eq!(pick(home.path(), &dir, "term_new", &view("Terminal 31", &[]), SystemTime::now(), &HashSet::new()), None);
}

#[test]
fn skips_long_idle_and_unknown_sessions() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("records");
    seed_claude(home.path(), "team", OLD);
    record(&dir, "term_a", "t→x", OLD);
    record(&dir, "term_b", "u→y", NEWER);
    let later = SystemTime::now() + MAX_IDLE + Duration::from_secs(60);
    assert_eq!(pick(home.path(), &dir, "term_new", &view("t→x", &[]), later, &HashSet::new()), None);
    assert_eq!(pick(home.path(), &dir, "term_new", &view("u→y", &[]), SystemTime::now(), &HashSet::new()), None);
}

#[test]
fn resumes_codex_threads_through_the_shim() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("records");
    let day = home.path().join(".codex/sessions/2026/10/20");
    fs::create_dir_all(&day).unwrap();
    fs::write(day.join(format!("rollout-2026-10-20T10-00-00-{NEWER}.jsonl")),
        "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/Users/x/repo\"}}\n").unwrap();
    record(&dir, "term_closed", "c→z", NEWER);
    let got = pick(home.path(), &dir, "term_new", &view("c→z", &[]), SystemTime::now(), &HashSet::new()).unwrap();
    assert_eq!(got.command(), format!("codex --no-daemon resume {NEWER}"));
}

#[test]
fn reads_the_tab_title_and_live_handles() {
    let list = json!({"result": {
        "terminals": [{"handle": "term_a"}, {"handle": "term_new", "executionHostId":"local", "worktreePath":"/Users/x/repo"}, {"handle": "term_orphan", "orphaned": true}],
        "visualLayouts": [{"root": {"tabs": [
            {"tabId": "t1", "title": "其他→标题", "panes": {"type": "terminal", "handle": "term_a"}},
            {"tabId": "t2", "title": "告警→一键接管", "panes": {"type": "split", "children": [
                {"type": "terminal", "handle": "term_new", "title": "✳ zsh"}]}}
        ]}}]
    }});
    let v = parse_view(&list, "term_new").unwrap();
    assert_eq!(v.title, "告警→一键接管");
    assert!(v.live.contains("term_a") && v.live.contains("term_new"));
    assert!(parse_view(&list, "term_hidden").is_none());
    assert!(is_orphaned_terminal(&list, "term_orphan"));
    assert!(!is_orphaned_terminal(&list, "term_new"));
    let mut remote = list.clone();
    remote["result"]["terminals"][1]["executionHostId"] = json!("environment:other-host");
    assert!(parse_view(&remote, "term_new").is_none());
    remote["result"]["terminals"][1]["executionHostId"] = json!("local");
    remote["result"]["terminals"][1].as_object_mut().unwrap().remove("worktreePath");
    assert!(parse_view(&remote, "term_new").is_none());
}

#[test]
fn same_title_in_another_workspace_cannot_win() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("records");
    seed_claude(home.path(), "team", OLD);
    seed_claude(home.path(), "team", NEWER);
    let other = home.path().join(format!(".claude-profiles/team/projects/-Users-x-repo/{NEWER}.jsonl"));
    fs::write(other, "{\"cwd\":\"/Users/x/other\"}\n").unwrap();
    record(&dir, "term_right", "same title", OLD);
    record(&dir, "term_wrong", "same title", NEWER);
    let got = pick(home.path(), &dir, "term_new", &view("same title", &[]),
        SystemTime::now(), &HashSet::new()).unwrap();
    assert_eq!(got.session, OLD);
    fs::remove_file(dir.join("term_right.json")).unwrap();
    assert_eq!(pick(home.path(), &dir, "term_new", &view("same title", &[]),
        SystemTime::now(), &HashSet::new()), None);
}

#[test]
fn pick_latest_restores_most_recent_closed_pane_for_workspace_on_default_title() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("records");
    seed_claude(home.path(), "team", OLD);
    seed_claude(home.path(), "team2", NEWER);
    record(&dir, "term_older", "旧→会话", OLD);
    std::thread::sleep(Duration::from_millis(20));
    let newest_rec = record(&dir, "term_newer", "新→会话", NEWER);
    let got = pick_latest(
        home.path(),
        &dir,
        "term_new",
        &view("Terminal 1", &["term_new"]),
        SystemTime::now(),
        &HashSet::new(),
    )
    .unwrap();
    assert_eq!(
        got,
        Pick {
            agent: Agent::Claude,
            session: NEWER.into(),
            title: "新→会话".into(),
            record: newest_rec,
        }
    );
}
