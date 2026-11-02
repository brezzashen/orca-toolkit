// Port of `title.test.ts`: drives the built binary with the same env contract, against a fake
// Codex app-server (a POSIX sh script instead of the TS suite's Bun script).

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const FAKE_SERVER: &str = r#"#!/bin/sh
export LC_ALL=C
name=
while IFS= read -r line || [ -n "$line" ]; do
  printf '%s\n' "$line" >> "$TEST_RPC_LOG"
  id=$(printf '%s\n' "$line" | sed -n 's/^{"id":\([0-9][0-9]*\),.*$/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/name/set"'*)
      if [ -n "$TEST_RPC_ERROR" ]; then
        printf '{"id":%s,"error":{"message":"rename refused"}}\n' "$id"
        continue
      fi
      name=$(printf '%s\n' "$line" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
      ;;
  esac
  case "$line" in
    *'"method":"thread/read"'*) printf '{"id":%s,"result":{"thread":{"name":"%s"}}}\n' "$id" "$name" ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#;

struct Fixture {
    dir: tempfile::TempDir,
    server: PathBuf,
    log: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("session-title-test-").tempdir().unwrap();
    let server = dir.path().join("codex");
    fs::write(&server, FAKE_SERVER).unwrap();
    fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();
    let log = dir.path().join("rpc.jsonl");
    Fixture { dir, server, log }
}

fn run(fx: &Fixture, args: &[&str], extra: &[(&str, &str)], input: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_session-title"));
    command
        .args(args)
        .env("CODEX_THREAD_ID", "fixture-thread")
        .env("CLAUDE_CODE_SESSION_ID", "")
        .env("ORCA_TERMINAL_HANDLE", "")
        .env("CODEX_APP_SERVER_BIN", &fx.server)
        .env("TEST_RPC_LOG", &fx.log)
        .env_remove("TEST_RPC_ERROR")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    for (key, value) in extra {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    if let Some(text) = input {
        child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    }
    child.wait_with_output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn read_requests(log: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(log)
        .unwrap()
        .trim()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn codex_replaces_an_existing_title_and_verifies_it_through_rpc() {
    let fx = fixture();
    let result = run(&fx, &["set", "标题 → 自动命名"], &[], None);
    assert_eq!(result.status.code(), Some(0), "stderr: {}", text(&result.stderr));
    let requests = read_requests(&fx.log);
    let methods: Vec<&str> = requests.iter().map(|r| r["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["initialize", "initialized", "thread/name/set", "thread/read"]);
    assert_eq!(requests[2]["params"], serde_json::json!({ "threadId": "fixture-thread", "name": "标题→自动命名" }));
    assert!(text(&result.stdout).contains("renamed and verified"));
}

#[test]
fn monitor_mode_constructs_the_shared_monitor_format() {
    let fx = fixture();
    let result = run(&fx, &["watch", "CI全绿"], &[], None);
    assert_eq!(result.status.code(), Some(0), "stderr: {}", text(&result.stderr));
    assert!(text(&result.stdout).contains("title: 监控◉CI全绿"));
}

#[test]
fn rejects_invalid_titles() {
    let fx = fixture();
    for title in ["标题命名", "标题→12345678", "标题→结果→丢失", "监控→CI全绿", "其他◉CI全绿", "标题→"] {
        let result = run(&fx, &["set", title], &[], None);
        assert_eq!(result.status.code(), Some(2), "{title}");
        assert!(text(&result.stderr).contains("title rejected"), "{title}");
    }
}

#[test]
fn rpc_rejection_fails_visibly_instead_of_reporting_success() {
    let fx = fixture();
    let result = run(&fx, &["set", "标题→自动命名"], &[("TEST_RPC_ERROR", "1")], None);
    assert_ne!(result.status.code(), Some(0));
    assert!(text(&result.stderr).contains("rename refused"));
    assert!(!text(&result.stdout).contains("renamed and verified"));
}

#[test]
fn claude_routing_preserves_transcript_and_next_prompt_hook_behavior() {
    let fx = fixture();
    let config = fx.dir.path().join("claude");
    let project = config.join("projects").join("fixture");
    fs::create_dir_all(&project).unwrap();
    let transcript = project.join("claude-fixture.jsonl");
    fs::write(&transcript, "").unwrap();
    let config_str = config.to_str().unwrap();
    let env = [("CLAUDE_CONFIG_DIR", config_str), ("CLAUDE_CODE_SESSION_ID", "claude-fixture")];

    let set = run(&fx, &["set", "标题→自动命名"], &env, None);
    assert_eq!(set.status.code(), Some(0), "stderr: {}", text(&set.stderr));
    let record: serde_json::Value = serde_json::from_str(fs::read_to_string(&transcript).unwrap().trim()).unwrap();
    assert_eq!(record["customTitle"], "标题→自动命名");
    assert_eq!(
        fs::read_to_string(&transcript).unwrap(),
        "{\"type\":\"custom-title\",\"customTitle\":\"标题→自动命名\",\"sessionId\":\"claude-fixture\"}\n"
    );

    let payload = serde_json::json!({ "session_id": "claude-fixture" }).to_string();
    let hook = run(&fx, &["hook"], &env, Some(&payload));
    assert_eq!(hook.status.code(), Some(0));
    assert_eq!(
        text(&hook.stdout),
        "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"sessionTitle\":\"标题→自动命名\"}}"
    );
    let again = run(&fx, &["hook"], &env, Some(&payload));
    assert_eq!(again.status.code(), Some(0));
    assert_eq!(text(&again.stdout), "");
}

// Fake `orca` CLI: the PTY `term_fx` is owned by a hidden pending tab until `$STATE/visible`
// exists, then by visible tab `tab-new`, which starts without the custom title (as Orca's
// adoption does). Renames land on whichever tab owns the PTY at that moment.
const FAKE_ORCA: &str = r#"#!/bin/sh
export LC_ALL=C
printf '%s\n' "$*" >> "$FAKE_ORCA_STATE/calls"
case "$1 $2" in
  "terminal rename")
    if [ -f "$FAKE_ORCA_STATE/visible" ]; then printf '%s' "$6" > "$FAKE_ORCA_STATE/visible_title"
    else printf '%s' "$6" > "$FAKE_ORCA_STATE/hidden_title"; fi
    printf '{"ok":true}\n' ;;
  "terminal list")
    if [ -f "$FAKE_ORCA_STATE/visible" ]; then
      title=$(cat "$FAKE_ORCA_STATE/visible_title" 2>/dev/null || printf 'my-repo')
      printf '{"ok":true,"result":{"visualLayouts":[{"root":{"type":"group","tabs":[{"tabId":"tab-new-0001","title":"%s","panes":{"type":"terminal","handle":"term_fx","tabId":"tab-new-0001"}}]}}]}}\n' "$title"
    else
      printf '{"ok":true,"result":{"visualLayouts":[{"root":{"type":"group","tabs":[]}}]}}\n'
    fi ;;
  *) exit 9 ;;
esac
"#;

struct OrcaFixture {
    fx: Fixture,
    state: PathBuf,
    bin: PathBuf,
}

fn orca_fixture() -> OrcaFixture {
    let fx = fixture();
    let state = fx.dir.path().join("orca-state");
    fs::create_dir_all(&state).unwrap();
    let bin = fx.dir.path().join("orca");
    fs::write(&bin, FAKE_ORCA).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    OrcaFixture { fx, state, bin }
}

fn orca_env<'a>(of: &'a OrcaFixture, config: &'a str, session: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("HOME", of.fx.dir.path().to_str().unwrap()),
        ("CLAUDE_CONFIG_DIR", config),
        ("CLAUDE_CODE_SESSION_ID", session),
        ("ORCA_TERMINAL_HANDLE", "term_fx"),
        ("ORCA_CLI_COMMAND", of.bin.to_str().unwrap()),
        ("FAKE_ORCA_STATE", of.state.to_str().unwrap()),
        ("SESSION_TITLE_WATCH_ROUNDS", "0"),
    ]
}

#[test]
fn title_set_before_orca_adopts_the_pty_reaches_the_visible_tab_on_the_next_prompt() {
    let of = orca_fixture();
    let config = of.fx.dir.path().join("claude");
    let config_str = config.to_str().unwrap().to_string();
    let env = orca_env(&of, &config_str, "claude-a");

    let set = run(&of.fx, &["set", "改名→标签对应"], &env, None);
    assert_eq!(set.status.code(), Some(0), "stderr: {}", text(&set.stderr));
    assert!(text(&set.stdout).contains("renamed a hidden tab"), "{}", text(&set.stdout));
    assert_eq!(fs::read_to_string(of.state.join("hidden_title")).unwrap(), "改名→标签对应");

    // Orca mounts the PTY in a new visible tab that lacks the custom title.
    fs::write(of.state.join("visible"), "").unwrap();
    let check = run(&of.fx, &["check"], &env, None);
    assert_eq!(check.status.code(), Some(0), "{}", text(&check.stdout));
    assert!(text(&check.stdout).contains("re-applied, tab tab-new- shows \"改名→标签对应\""), "{}", text(&check.stdout));

    // A drifted visible title is repaired by the prompt hook, whose stdout stays hook-only.
    fs::write(of.state.join("visible_title"), "⠹ my-repo").unwrap();
    let payload = serde_json::json!({ "session_id": "claude-a" }).to_string();
    let hook = run(&of.fx, &["hook"], &env, Some(&payload));
    assert_eq!(hook.status.code(), Some(0));
    assert_eq!(
        text(&hook.stdout),
        "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"sessionTitle\":\"改名→标签对应\"}}"
    );
    assert_eq!(fs::read_to_string(of.state.join("visible_title")).unwrap(), "改名→标签对应");

    let verified = run(&of.fx, &["check"], &env, None);
    assert_eq!(verified.status.code(), Some(0));
    assert!(text(&verified.stdout).contains("verified, tab tab-new-"), "{}", text(&verified.stdout));
}

#[test]
fn prompt_sync_leaves_a_pane_alone_once_another_session_owns_it() {
    let of = orca_fixture();
    let config = of.fx.dir.path().join("claude");
    let config_str = config.to_str().unwrap().to_string();
    fs::write(of.state.join("visible"), "").unwrap();
    let set = run(&of.fx, &["set", "旧会话→标题"], &orca_env(&of, &config_str, "claude-old"), None);
    assert!(text(&set.stdout).contains("verified on visible tab tab-new-"), "{}", text(&set.stdout));

    fs::write(of.state.join("visible_title"), "新会话").unwrap();
    let payload = serde_json::json!({ "session_id": "claude-new" }).to_string();
    let env = orca_env(&of, &config_str, "claude-new");
    let hook = run(&of.fx, &["hook"], &env, Some(&payload));
    assert_eq!(text(&hook.stdout), "");
    let sync = run(&of.fx, &["orca-sync"], &env, Some(&payload));
    assert_eq!(text(&sync.stdout), "");
    assert_eq!(fs::read_to_string(of.state.join("visible_title")).unwrap(), "新会话");

    let check = run(&of.fx, &["check"], &env, None);
    assert_eq!(check.status.code(), Some(1));
    assert!(text(&check.stderr).contains("belongs to session claude-old"));
}

#[test]
fn codex_prompt_sync_reapplies_the_title_silently() {
    let of = orca_fixture();
    let home = of.fx.dir.path().to_str().unwrap();
    let env = [
        ("HOME", home),
        ("ORCA_TERMINAL_HANDLE", "term_fx"),
        ("ORCA_CLI_COMMAND", of.bin.to_str().unwrap()),
        ("FAKE_ORCA_STATE", of.state.to_str().unwrap()),
        ("SESSION_TITLE_WATCH_ROUNDS", "0"),
    ];
    let set = run(&of.fx, &["set", "许线→三维呈现"], &env, None);
    assert_eq!(set.status.code(), Some(0), "stderr: {}", text(&set.stderr));
    assert!(text(&set.stdout).contains("renamed a hidden tab"));

    fs::write(of.state.join("visible"), "").unwrap();
    let payload = serde_json::json!({ "session_id": "fixture-thread" }).to_string();
    let sync = run(&of.fx, &["orca-sync"], &env, Some(&payload));
    assert_eq!(sync.status.code(), Some(0));
    assert_eq!(text(&sync.stdout), "");
    assert_eq!(fs::read_to_string(of.state.join("visible_title")).unwrap(), "许线→三维呈现");
}

#[test]
fn background_watcher_applies_the_title_once_orca_mounts_the_pty() {
    let of = orca_fixture();
    let home = of.fx.dir.path().to_str().unwrap();
    let env = [
        ("HOME", home),
        ("ORCA_TERMINAL_HANDLE", "term_fx"),
        ("ORCA_CLI_COMMAND", of.bin.to_str().unwrap()),
        ("FAKE_ORCA_STATE", of.state.to_str().unwrap()),
        ("SESSION_TITLE_WATCH_INTERVAL_MS", "50"),
        ("SESSION_TITLE_WATCH_ROUNDS", "200"),
    ];
    let set = run(&of.fx, &["set", "玻璃弹窗→同步端测"], &env, None);
    assert!(text(&set.stdout).contains("a background watcher re-applies it"), "{}", text(&set.stdout));
    let lock = of.fx.dir.path().join(".local/state/session-title/orca/term_fx.watch");
    assert!(lock.exists());

    fs::write(of.state.join("visible"), "").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while fs::read_to_string(of.state.join("visible_title")).ok().as_deref() != Some("玻璃弹窗→同步端测") {
        assert!(std::time::Instant::now() < deadline, "watcher never applied the title");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    while lock.exists() {
        assert!(std::time::Instant::now() < deadline, "watcher never released its lock");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn hook_is_silent_on_garbage_input() {
    let fx = fixture();
    let config = fx.dir.path().join("claude");
    let config_str = config.to_str().unwrap();
    for input in ["", "not json", "null", "{\"session_id\":\"missing\"}"] {
        let hook = run(&fx, &["hook"], &[("CLAUDE_CONFIG_DIR", config_str)], Some(input));
        assert_eq!(hook.status.code(), Some(0), "{input}");
        assert_eq!(text(&hook.stdout), "", "{input}");
    }
}
