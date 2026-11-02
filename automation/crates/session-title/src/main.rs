//! `session-title`: sets a Claude Code or Codex session title in the shared acceptance-title
//! format. Rust port of `~/.claude/skills/session-title/title.ts`; the CLI, messages, exit codes
//! and on-disk formats are a contract with the `session-title` skill and the profile hooks.
//!
//! `set "<title>"` accepts any form; `watch "<expected result>"` builds the monitor form and
//! `role <role> "<subject>"` builds the role form `<role>◆<subject>` for a role in `ROLES`.
//! `set`/`watch` (run by the model through Bash) writes the title to three places:
//!   1. the Orca tab title (`orca terminal rename`), visible at once;
//!   2. a `custom-title` record in the session transcript; /resume reads it, and the running
//!      session adopts it on its next metadata re-read (undocumented, seen on 2.1.291);
//!   3. a pending file that the `hook` mode turns into the live Claude Code title.
//!
//! Under Codex (`CODEX_THREAD_ID` set, `CLAUDE_CODE_SESSION_ID` unset) the title goes through
//! app-server `thread/name/set` and is verified with `thread/read` (see `codex.rs`).
//!
//! `hook` (run by the UserPromptSubmit hook) reads stdin, consumes the pending file of that
//! session and prints `hookSpecificOutput.sessionTitle`, the documented path, which guarantees
//! the title on the next prompt if the transcript re-read ever stops working.
//!
//! If `hook` prints anything but valid hook JSON, every prompt in every session of the profile
//! gets a hook error. It stays silent and exits 0 on all failures.
//!
//! The Orca title is bound to the PTY handle, not to a tab: `set` reads the visible tab back and
//! records the title under `~/.local/state/session-title/orca/<handle>.json`. When no visible tab
//! holds the PTY yet, `set` starts a detached `orca-sync --watch` that applies the title once
//! Orca mounts the PTY in a visible tab. `hook` (Claude) and `orca-sync` (a prompt hook, stdin
//! JSON) re-apply it on every prompt; `check` reports and repairs the binding on demand.
//! Panes that never ran `set` get an `auto` record from the same hooks (`auto_record.rs`), so
//! Orca's Cmd+Shift+T can resume them on Macs whose agents do not title their sessions.
//!
//! Title length is counted in Unicode code points (the TS `[...title].length`), limit 10.
//! Exit codes: 0 success, 1 usage / missing session / Codex RPC failure, 2 validation failure,
//! 3 `check` could not make the visible tab show the title.
//! Proof: the unit tests below and `tests/title.rs` (port of `title.test.ts`).

mod auto_record;
mod codex;

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::{mpsc, LazyLock};
use std::thread;
use std::time::{Duration, Instant};

const MAX_CHARS: usize = 10;
const ARROW: char = '→';
const WATCH_PREFIX: &str = "监控";
const WATCH_MARK: char = '◉';
const ROLE_MARK: char = '◆';
/// Standing roles that get their own title form, `<role>◆<subject>`, so the user can find
/// the session by role in the tab bar. Add a role here and in the skill's role table.
const ROLES: &[&str] = &["协调者", "崩溃复盘", "性能复盘"];
const DEFAULT_ORCA_BIN_DIR: &str = "/Applications/Orca.app/Contents/Resources/bin";

/// Matches the TS `/pasted|content id|<\/?\w+>/i`: ASCII-only case folding and ASCII `\w`,
/// because the JS regex has no `u` flag.
static RESIDUE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i-u:pasted|content id|</?\w+>)").expect("valid regex"));

/// JavaScript `\s` / `String.prototype.trim` whitespace set (differs from Rust's
/// `char::is_whitespace`: includes U+FEFF, excludes U+0085).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// Port of `clean()`: control chars become spaces, whitespace touching `→`/`◉` is dropped,
/// remaining whitespace runs collapse to one space, then the ends are trimmed.
fn clean(raw: &str) -> String {
    let chars: Vec<char> = raw
        .chars()
        .map(|c| if (c as u32) <= 0x1f || c as u32 == 0x7f { ' ' } else { c })
        .collect();
    let is_mark = |c: char| c == ARROW || c == WATCH_MARK || c == ROLE_MARK;
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < chars.len() {
        if !is_js_space(chars[i]) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_js_space(chars[i]) {
            i += 1;
        }
        let before_mark = start > 0 && is_mark(chars[start - 1]);
        let after_mark = i < chars.len() && is_mark(chars[i]);
        if !before_mark && !after_mark {
            out.push(' ');
        }
    }
    js_trim(&out).to_string()
}

#[derive(Debug)]
struct Rejection {
    title: String,
    problems: Vec<String>,
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "title rejected: \"{}\"\n- {}", self.title, self.problems.join("\n- "))
    }
}

fn common_problems(title: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let count = title.chars().count();
    if count > MAX_CHARS {
        problems.push(format!("is {count} chars, limit is {MAX_CHARS}"));
    }
    if RESIDUE.is_match(title) {
        problems.push("contains prompt residue (Pasted / content id / tags)".to_string());
    }
    problems
}

fn validate_watch(result: &str) -> Result<String, Rejection> {
    let title = format!("{WATCH_PREFIX}{WATCH_MARK}{result}");
    let mut problems = common_problems(&title);
    if result.is_empty() {
        problems.push(format!("expected result (right of {WATCH_MARK}) is empty"));
    }
    if result.contains(ARROW) || result.contains(WATCH_MARK) {
        problems.push(format!("monitor result must not contain \"{ARROW}\" or \"{WATCH_MARK}\""));
    }
    if problems.is_empty() {
        Ok(title)
    } else {
        Err(Rejection { title, problems })
    }
}

fn validate_role(role: &str, subject: &str) -> Result<String, Rejection> {
    let title = format!("{role}{ROLE_MARK}{subject}");
    let mut problems = common_problems(&title);
    if !ROLES.contains(&role) {
        problems.push(format!("role \"{role}\" is not one of: {}", ROLES.join(", ")));
    }
    if subject.is_empty() {
        problems.push(format!("subject (right of {ROLE_MARK}) is empty"));
    }
    if subject.contains(ARROW) || subject.contains(WATCH_MARK) || subject.contains(ROLE_MARK) {
        problems.push(format!("role subject must not contain \"{ARROW}\", \"{WATCH_MARK}\" or \"{ROLE_MARK}\""));
    }
    if problems.is_empty() {
        Ok(title)
    } else {
        Err(Rejection { title, problems })
    }
}

/// `role <role> <subject...>`: the first word is the role, the rest is the subject.
fn validate_role_args(raw: &str) -> Result<String, Rejection> {
    let cleaned = clean(raw);
    let (role, subject) = cleaned.split_once(' ').unwrap_or((cleaned.as_str(), ""));
    validate_role(role, &clean(subject))
}

fn validate(raw: &str) -> Result<String, Rejection> {
    let title = clean(raw);
    if title.contains(ROLE_MARK) {
        let (role, subject) = title.split_once(ROLE_MARK).unwrap_or(("", ""));
        return validate_role(role, subject);
    }
    if title.contains(WATCH_MARK) {
        let mut parts = title.split(WATCH_MARK);
        let prefix = parts.next().unwrap_or("");
        if prefix != WATCH_PREFIX {
            return Err(Rejection {
                problems: vec![format!("monitor form must start with \"{WATCH_PREFIX}{WATCH_MARK}\"")],
                title,
            });
        }
        let mark = WATCH_MARK.to_string();
        let result = parts.collect::<Vec<_>>().join(mark.as_str());
        return validate_watch(&result);
    }
    let mut problems = common_problems(&title);
    if !title.contains(ARROW) {
        problems.push(format!("must contain \"{ARROW}\" between acceptance item and expected result"));
    }
    let parts: Vec<&str> = title.split(ARROW).map(js_trim).collect();
    if parts.len() != 2 {
        problems.push("edit form must contain exactly one arrow".to_string());
    }
    let item = parts.first().copied().unwrap_or("");
    let result = parts.get(1).copied().unwrap_or("");
    if item.is_empty() {
        problems.push(format!("acceptance item (left of {ARROW}) is empty"));
    }
    if result.is_empty() {
        problems.push(format!("expected result (right of {ARROW}) is empty"));
    }
    if item == WATCH_PREFIX {
        problems.push(format!(
            "monitoring uses the \"{WATCH_PREFIX}{WATCH_MARK}<result>\" form; run `watch \"<result>\"`"
        ));
    }
    if !problems.is_empty() {
        return Err(Rejection { title, problems });
    }
    Ok(format!("{item}{ARROW}{result}"))
}

/// An environment variable with JS truthiness: unset and empty are both `None`.
pub(crate) fn env_nonempty(key: &str) -> Option<String> {
    std::env::var_os(key)
        .map(|v| v.to_string_lossy().into_owned())
        .filter(|v| !v.is_empty())
}

/// Node `os.homedir()`: `$HOME` when non-empty, else the passwd entry.
fn home_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(home);
    }
    // SAFETY: getpwuid returns a pointer into static storage or null; it is read once here
    // before any other thread could call it.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_dir.is_null() {
            let dir = std::ffi::CStr::from_ptr((*pw).pw_dir);
            return PathBuf::from(OsStr::from_bytes(dir.to_bytes()));
        }
    }
    PathBuf::from("/")
}

fn config_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => home_dir().join(".claude"),
    }
}

/// Appends `name` under `dir` as a plain path segment. Unlike `Path::join`, an absolute or
/// odd `name` (it comes from env or hook stdin) never replaces `dir`.
fn under(dir: &Path, name: &str) -> PathBuf {
    let mut joined: OsString = dir.as_os_str().to_os_string();
    joined.push("/");
    joined.push(name);
    PathBuf::from(joined)
}

fn pending_dir() -> PathBuf {
    config_dir().join("state").join("session-title")
}

fn pending_path(session_id: &str) -> PathBuf {
    under(&pending_dir(), &format!("{session_id}.txt"))
}

fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let projects = config_dir().join("projects");
    let entries = fs::read_dir(&projects).ok()?;
    let mut names: Vec<OsString> = entries.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    names.sort();
    names.into_iter().find_map(|dir| {
        let candidate = under(&projects.join(dir), &format!("{session_id}.jsonl"));
        candidate.exists().then_some(candidate)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomTitleRecord<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    custom_title: &'a str,
    session_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookOutput<'a> {
    hook_specific_output: HookSpecificOutput<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookSpecificOutput<'a> {
    hook_event_name: &'a str,
    session_title: &'a str,
}

/// Mirrors an uncaught exception in the TS script: message on stderr, exit 1.
fn fatal(message: impl fmt::Display) -> ExitCode {
    eprintln!("error: {message}");
    ExitCode::from(1)
}

fn set(title: &str) -> ExitCode {
    let claude_session = env_nonempty("CLAUDE_CODE_SESSION_ID")
        .or_else(|| env_nonempty("ANTIGRAVITY_CONVERSATION_ID"));
    if let (Some(thread_id), None) = (env_nonempty("CODEX_THREAD_ID"), claude_session.as_ref()) {
        if let Err(message) = codex::set_codex_title(&thread_id, title) {
            return fatal(message);
        }
        rename_orca(title);
        println!("title: {title}");
        return ExitCode::SUCCESS;
    }
    let Some(session_id) = claude_session else {
        eprintln!("No session ID: run from Claude Code, Codex, or Antigravity (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID / ANTIGRAVITY_CONVERSATION_ID)");
        return ExitCode::from(1);
    };

    if let Err(e) = fs::create_dir_all(pending_dir()) {
        return fatal(e);
    }
    if let Err(e) = fs::write(pending_path(&session_id), title) {
        return fatal(e);
    }
    println!("hook fallback: queued for the next prompt");

    match find_transcript(&session_id) {
        Some(transcript) => {
            let record = CustomTitleRecord { kind: "custom-title", custom_title: title, session_id: &session_id };
            let line = format!("{}\n", serde_json::to_string(&record).expect("serializable record"));
            let appended = fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(&transcript)
                .and_then(|mut f| f.write_all(line.as_bytes()));
            if let Err(e) = appended {
                return fatal(e);
            }
            println!("resume list: written to {}", transcript.display());
        }
        None => println!("resume list: transcript not found, skipped"),
    }

    rename_orca(title);
    println!("title: {title}");
    ExitCode::SUCCESS
}

pub(crate) fn errno_name(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => "ENOENT".to_string(),
        io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => e.to_string(),
    }
}

/// Port of `spawnSync(bin, args, { timeout })` as `renameOrca` uses it: `Ok(stdout)` on exit 0,
/// otherwise the detail TS prints, `stderr || error.message || ""`.
fn run_bounded(bin: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let label = bin.display().to_string();
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawnSync {label} {}", errno_name(&e)))?;
    // Drain stdout on its own thread so a chatty child never blocks on a full pipe.
    let (out_tx, out_rx) = mpsc::channel();
    if let Some(mut out) = child.stdout.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf);
            let _ = out_tx.send(buf);
        });
    }
    let (tx, rx) = mpsc::channel();
    if let Some(mut err) = child.stderr.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                // spawnSync's default killSignal is SIGTERM; escalate if it is ignored.
                // SAFETY: plain kill(2) on our own unreaped child.
                unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
                let grace = Instant::now() + Duration::from_secs(1);
                while matches!(child.try_wait(), Ok(None)) && Instant::now() < grace {
                    thread::sleep(Duration::from_millis(10));
                }
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("spawnSync {label} {e}")),
        }
    };
    let stderr = rx
        .recv_timeout(Duration::from_secs(1))
        .map(|buf| String::from_utf8_lossy(&buf).into_owned())
        .unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(out_rx
            .recv_timeout(Duration::from_secs(1))
            .map(|buf| String::from_utf8_lossy(&buf).into_owned())
            .unwrap_or_default()),
        Some(_) => Err(stderr),
        None if stderr.is_empty() => Err(format!("spawnSync {label} ETIMEDOUT")),
        None => Err(stderr),
    }
}

// Orca tab binding.
//
// `ORCA_TERMINAL_HANDLE` names a PTY, not a tab. Orca can create a tab with
// `pendingActivationSpawn`, keep it out of the tab bar, and later mount the same PTY in a new
// tab that has no custom title. A rename issued before that adoption lands on the hidden tab,
// so the visible tab never shows it and the sidebar row no longer matches the tab bar. The
// handle resolves to whichever tab holds the PTY now, so `set` reads the visible layout back,
// and the prompt hooks re-apply the remembered title once the PTY sits in a visible tab.

fn orca_bin() -> PathBuf {
    match env_nonempty("ORCA_CLI_COMMAND") {
        Some(command) => PathBuf::from(command),
        None if env_nonempty("ORCA_DEV_REPO_ROOT").is_some() => PathBuf::from("orca-dev"),
        None => PathBuf::from(env_nonempty("ORCA_CLI_BIN_DIR").unwrap_or_else(|| DEFAULT_ORCA_BIN_DIR.to_string()))
            .join("orca"),
    }
}

/// The handle of this pane, restricted to the runtime's `term_<id>` alphabet because it
/// becomes a file name.
fn orca_handle() -> Option<String> {
    env_nonempty("ORCA_TERMINAL_HANDLE")
        .filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
}

/// The agent session that owns a title: Claude Code (or Antigravity) first, then Codex.
fn current_session_id() -> Option<String> {
    env_nonempty("CLAUDE_CODE_SESSION_ID")
        .or_else(|| env_nonempty("ANTIGRAVITY_CONVERSATION_ID"))
        .or_else(|| env_nonempty("CODEX_THREAD_ID"))
}

/// Shared by every Claude profile and Codex, because the handle is per PTY, not per profile.
fn orca_state_dir() -> PathBuf {
    home_dir().join(".local").join("state").join("session-title").join("orca")
}

#[derive(Debug, PartialEq, serde::Deserialize, Serialize)]
struct StickyTitle {
    title: String,
    session: String,
    /// Written by the prompt hook (`auto_record`), not by `set`; never forced onto the tab.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    auto: bool,
}

fn sticky_path(handle: &str) -> PathBuf {
    under(&orca_state_dir(), &format!("{handle}.json"))
}

fn read_sticky(handle: &str) -> Option<StickyTitle> {
    serde_json::from_slice(&fs::read(sticky_path(handle)).ok()?).ok()
}

fn write_sticky(handle: &str, sticky: &StickyTitle) -> io::Result<()> {
    fs::create_dir_all(orca_state_dir())?;
    let json = serde_json::to_vec(sticky).map_err(io::Error::other)?;
    let path = sticky_path(handle);
    let tmp = under(&orca_state_dir(), &format!("{handle}.json.tmp"));
    fs::write(&tmp, json)?;
    fs::rename(tmp, path)
}

#[derive(Debug, PartialEq)]
struct VisibleTab {
    tab_id: String,
    title: String,
}

fn holds_handle(node: &serde_json::Value, handle: &str) -> bool {
    match node {
        serde_json::Value::Object(map) => {
            map.get("handle").and_then(serde_json::Value::as_str) == Some(handle)
                || map.values().any(|v| holds_handle(v, handle))
        }
        serde_json::Value::Array(items) => items.iter().any(|v| holds_handle(v, handle)),
        _ => false,
    }
}

/// Finds the tab whose pane tree holds `handle` in `orca terminal list --include-visual-layouts`
/// output. A tab node carries both `tabId` and `panes`; a pane node carries `tabId` only.
/// Hidden tabs are absent from the visual layout, so `None` means "not visible".
fn find_visible_tab(node: &serde_json::Value, handle: &str) -> Option<VisibleTab> {
    match node {
        serde_json::Value::Object(map) => {
            if let (Some(tab_id), Some(panes)) =
                (map.get("tabId").and_then(serde_json::Value::as_str), map.get("panes"))
            {
                return holds_handle(panes, handle).then(|| VisibleTab {
                    tab_id: tab_id.to_string(),
                    title: map.get("title").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
                });
            }
            map.values().find_map(|v| find_visible_tab(v, handle))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_visible_tab(v, handle)),
        _ => None,
    }
}

fn query_visible_tab(bin: &Path, handle: &str, limit: Duration) -> Result<Option<VisibleTab>, String> {
    let out = run_bounded(bin, &["terminal", "list", "--include-visual-layouts", "--json"], limit)?;
    let value: serde_json::Value = serde_json::from_str(&out).map_err(|e| format!("bad list JSON: {e}"))?;
    let layouts = value.pointer("/result/visualLayouts").ok_or("list JSON has no visualLayouts")?;
    Ok(find_visible_tab(layouts, handle))
}

#[derive(Debug, PartialEq)]
enum Binding {
    /// The visible tab already shows the title.
    Verified(VisibleTab),
    /// The visible tab showed something else; the title was applied again and read back.
    Reapplied(VisibleTab),
    /// No visible tab holds the PTY yet (a hidden pending tab owns it).
    NotVisible,
    Failed(String),
}

/// Reads the visible tab back, renames it when it disagrees, and reads it again. The runtime
/// mirrors a rename into the layout asynchronously, so a mismatch right after a rename is
/// retried briefly before it counts as a failure.
fn reconcile(bin: &Path, handle: &str, title: &str, limit: Duration) -> Binding {
    let mut renamed = false;
    for attempt in 0..4 {
        let tab = match query_visible_tab(bin, handle, limit) {
            Ok(Some(tab)) => tab,
            Ok(None) => return Binding::NotVisible,
            Err(detail) => return Binding::Failed(js_trim(&detail).to_string()),
        };
        if tab.title == title {
            return if renamed { Binding::Reapplied(tab) } else { Binding::Verified(tab) };
        }
        if !renamed {
            if let Err(detail) =
                run_bounded(bin, &["terminal", "rename", "--terminal", handle, "--title", title], limit)
            {
                return Binding::Failed(js_trim(&detail).to_string());
            }
            renamed = true;
        } else if attempt == 3 {
            return Binding::Failed(format!("tab {} still shows \"{}\"", short_id(&tab.tab_id), tab.title));
        }
        thread::sleep(Duration::from_millis(150));
    }
    Binding::Failed("rename did not settle".to_string())
}

fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn rename_orca(title: &str) {
    let Some(handle) = orca_handle() else {
        println!("orca tab: not an Orca pane, skipped");
        return;
    };
    if let Some(session) = current_session_id() {
        if let Err(e) = write_sticky(&handle, &StickyTitle { title: title.to_string(), session, auto: false }) {
            println!("orca tab: could not remember the title ({e}); prompts will not re-apply it");
        }
    }
    let bin = orca_bin();
    let limit = Duration::from_millis(5000);
    let args = ["terminal", "rename", "--terminal", handle.as_str(), "--title", title];
    if let Err(detail) = run_bounded(&bin, &args, limit) {
        println!("orca tab: rename failed ({})", js_trim(&detail));
        return;
    }
    match reconcile(&bin, &handle, title, limit) {
        Binding::Verified(tab) | Binding::Reapplied(tab) => {
            println!("orca tab: renamed, verified on visible tab {}", short_id(&tab.tab_id))
        }
        Binding::NotVisible => match spawn_watcher(&handle) {
            Ok(()) => println!(
                "orca tab: renamed a hidden tab; no visible tab holds this pane yet, a background watcher re-applies it"
            ),
            Err(e) => println!(
                "orca tab: renamed a hidden tab; no visible tab holds this pane yet, watcher failed to start ({e})"
            ),
        },
        Binding::Failed(detail) => println!("orca tab: renamed, verification failed ({detail})"),
    }
}

fn watcher_lock(handle: &str) -> PathBuf {
    under(&orca_state_dir(), &format!("{handle}.watch"))
}

fn process_alive(pid: libc::pid_t) -> bool {
    // SAFETY: signal 0 only checks that the process exists and is ours.
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

/// Starts `orca-sync --watch` detached in its own session, so it outlives the agent's tool
/// call. One watcher per handle: a live one already re-reads the latest recorded title.
fn spawn_watcher(handle: &str) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    let lock = watcher_lock(handle);
    let running = fs::read_to_string(&lock).ok().and_then(|s| s.trim().parse().ok()).is_some_and(process_alive);
    if running {
        return Ok(());
    }
    let mut command = Command::new(std::env::current_exe()?);
    command.args(["orca-sync", "--watch"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no Rust state in the forked child.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = command.spawn()?;
    fs::write(lock, child.id().to_string())
}

fn env_number(key: &str, default: u64) -> u64 {
    env_nonempty(key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Polls until a visible tab holds the PTY, applies the recorded title, and exits. Orca has
/// mounted a pending PTY 1 to 27 minutes after it was created, hence the 60 minute budget.
fn watch_orca() -> ExitCode {
    let Some(handle) = orca_handle() else { return ExitCode::SUCCESS };
    let Some(owner) = read_sticky(&handle).map(|s| s.session) else { return ExitCode::SUCCESS };
    let interval = Duration::from_millis(env_number("SESSION_TITLE_WATCH_INTERVAL_MS", 10_000));
    let rounds = env_number("SESSION_TITLE_WATCH_ROUNDS", 360);
    let bin = orca_bin();
    for _ in 0..rounds {
        thread::sleep(interval);
        // Re-read every round: the session may have set a newer title, or another one owns the pane.
        let Some(sticky) = read_sticky(&handle).filter(|s| s.session == owner) else { break };
        if matches!(reconcile(&bin, &handle, &sticky.title, Duration::from_millis(5000)), Binding::Verified(_) | Binding::Reapplied(_)) {
            break;
        }
    }
    let _ = fs::remove_file(watcher_lock(&handle));
    ExitCode::SUCCESS
}

/// Re-applies the remembered title of this pane when `session` still owns it. Silent: it runs
/// inside prompt hooks, whose stdout belongs to the hook protocol. A shorter limit keeps the
/// worst case inside the 5 s hook timeout.
fn sync_orca_quietly(session: Option<&str>) {
    let Some(handle) = orca_handle() else { return };
    let Some(sticky) = read_sticky(&handle) else { return };
    if sticky.auto || session.is_some_and(|s| s != sticky.session) {
        return;
    }
    let _ = reconcile(&orca_bin(), &handle, &sticky.title, Duration::from_millis(1500));
}

/// `check`: reports whether the visible tab of this pane shows this session's title, fixing it
/// when it does not. Exit 0 when the tab matches, 3 when it cannot be made to match yet.
fn check() -> ExitCode {
    let Some(handle) = orca_handle() else {
        eprintln!("not an Orca pane (ORCA_TERMINAL_HANDLE unset)");
        return ExitCode::from(1);
    };
    let Some(sticky) = read_sticky(&handle) else {
        eprintln!("no title recorded for {handle}; run `session-title set` first");
        return ExitCode::from(1);
    };
    if let Some(session) = current_session_id().filter(|s| *s != sticky.session) {
        eprintln!("recorded title \"{}\" belongs to session {}, not {session}", sticky.title, sticky.session);
        return ExitCode::from(1);
    }
    match reconcile(&orca_bin(), &handle, &sticky.title, Duration::from_millis(5000)) {
        Binding::Verified(tab) => {
            println!("orca tab: verified, tab {} shows \"{}\"", short_id(&tab.tab_id), tab.title);
            ExitCode::SUCCESS
        }
        Binding::Reapplied(tab) => {
            println!("orca tab: re-applied, tab {} shows \"{}\"", short_id(&tab.tab_id), tab.title);
            ExitCode::SUCCESS
        }
        Binding::NotVisible => {
            println!("orca tab: no visible tab holds {handle} yet; title \"{}\" is pending", sticky.title);
            ExitCode::from(3)
        }
        Binding::Failed(detail) => {
            println!("orca tab: verification failed ({detail})");
            ExitCode::from(3)
        }
    }
}

/// UserPromptSubmit hook: never fails, never prints anything but the hook JSON.
fn hook() -> ExitCode {
    let session = try_hook();
    let _ = io::stdout().flush();
    sync_orca_quietly(session.as_deref());
    if let Some(session) = session {
        auto_record::track(&session);
    }
    ExitCode::SUCCESS
}

/// Codex UserPromptSubmit hook: drains stdin, re-applies the pane title, prints nothing.
fn orca_sync() -> ExitCode {
    let mut raw = Vec::new();
    let _ = io::stdin().read_to_end(&mut raw);
    let session = serde_json::from_slice::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("session_id").and_then(serde_json::Value::as_str).map(str::to_string))
        .filter(|s| !s.is_empty());
    sync_orca_quietly(session.as_deref());
    if let Some(session) = session {
        auto_record::track(&session);
    }
    ExitCode::SUCCESS
}

/// Emits the queued title, if any, and returns the hook's session id for the Orca re-check.
fn try_hook() -> Option<String> {
    let mut raw = Vec::new();
    io::stdin().read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let text: &str = if text.is_empty() { "{}" } else { text.as_ref() };
    let input: serde_json::Value = serde_json::from_str(text).ok()?;
    let session_id = input.get("session_id")?.as_str().filter(|s| !s.is_empty())?;
    emit_pending_title(session_id);
    Some(session_id.to_string())
}

fn emit_pending_title(session_id: &str) -> Option<()> {
    let path = pending_path(session_id);
    if !path.exists() {
        return None;
    }
    let content = fs::read(&path).ok()?;
    let title = js_trim(&String::from_utf8_lossy(&content)).to_string();
    let _ = fs::remove_file(&path);
    if title.is_empty() {
        return None;
    }
    let output = HookOutput {
        hook_specific_output: HookSpecificOutput { hook_event_name: "UserPromptSubmit", session_title: &title },
    };
    let json = serde_json::to_string(&output).ok()?;
    io::stdout().write_all(json.as_bytes()).ok()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let (mode, rest) = match args.split_first() {
        Some((mode, rest)) => (mode.as_str(), rest.join(" ")),
        None => ("", String::new()),
    };
    let validated = match mode {
        "set" => validate(&rest),
        "watch" => validate_watch(&clean(&rest)),
        "role" => validate_role_args(&rest),
        "hook" => return hook(),
        "orca-sync" if rest == "--watch" => return watch_orca(),
        "orca-sync" => return orca_sync(),
        "check" => return check(),
        _ => {
            eprintln!(
                "usage: session-title set \"<acceptance item>→<expected result>\" | session-title watch \"<expected result>\" | session-title role <role> \"<subject>\" | session-title check | session-title hook | session-title orca-sync"
            );
            return ExitCode::from(1);
        }
    };
    match validated {
        Ok(title) => set(&title),
        Err(rejection) => {
            eprintln!("{rejection}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_removes_spacing_around_marks_and_collapses_whitespace() {
        assert_eq!(clean("标题 → 自动命名"), "标题→自动命名");
        assert_eq!(clean("  a \t b  "), "a b");
        assert_eq!(clean("监控 ◉ CI 全绿"), "监控◉CI 全绿");
        assert_eq!(clean("a\u{0}b"), "a b");
        assert_eq!(clean("a\u{3000}→\u{FEFF}b"), "a→b");
    }

    #[test]
    fn edit_form_is_normalized() {
        assert_eq!(validate("标题 → 自动命名").unwrap(), "标题→自动命名");
        assert_eq!(validate("缓存→命中≥90%").unwrap(), "缓存→命中≥90%");
    }

    #[test]
    fn monitor_form_via_set_and_watch() {
        assert_eq!(validate("监控◉CI全绿").unwrap(), "监控◉CI全绿");
        assert_eq!(validate_watch(&clean("CI全绿")).unwrap(), "监控◉CI全绿");
    }

    #[test]
    fn role_form_via_set_and_role() {
        assert_eq!(validate("协调者 ◆ 发布队列").unwrap(), "协调者◆发布队列");
        assert_eq!(validate_role_args("崩溃复盘 Duo闪退").unwrap(), "崩溃复盘◆Duo闪退");
        assert_eq!(validate_role_args("性能复盘  iOS卡顿").unwrap(), "性能复盘◆iOS卡顿");
    }

    #[test]
    fn role_form_rejects_unknown_role_empty_subject_and_marks() {
        let rejection = validate("队长◆发布队列").unwrap_err();
        assert_eq!(rejection.problems, vec!["role \"队长\" is not one of: 协调者, 崩溃复盘, 性能复盘".to_string()]);
        assert!(validate_role_args("协调者").is_err());
        assert!(validate("协调者◆发布→完成").is_err());
        assert!(validate("协调者◆发布◆队列").is_err());
        assert!(validate("崩溃复盘◆1234567").is_err());
    }

    #[test]
    fn rejects_the_same_titles_as_the_ts_suite() {
        for title in ["标题命名", "标题→12345678", "标题→结果→丢失", "监控→CI全绿", "其他◉CI全绿", "标题→"] {
            let rejection = validate(title).expect_err(title);
            assert!(rejection.to_string().starts_with("title rejected: \""), "{title}");
        }
    }

    #[test]
    fn length_counts_code_points() {
        // Ten code points pass; the emoji is one code point but two UTF-16 units.
        assert!(validate("ab→1234567").is_ok());
        assert!(validate("a😀→1234567").is_ok());
        let rejection = validate("ab→12345678").unwrap_err();
        assert_eq!(rejection.problems, vec!["is 11 chars, limit is 10".to_string()]);
    }

    #[test]
    fn rejection_messages_match_ts_order() {
        let rejection = validate("标题命名").unwrap_err();
        assert_eq!(
            rejection.problems,
            vec![
                "must contain \"→\" between acceptance item and expected result".to_string(),
                "edit form must contain exactly one arrow".to_string(),
                "expected result (right of →) is empty".to_string(),
            ]
        );
        let rejection = validate("其他◉CI全绿").unwrap_err();
        assert_eq!(rejection.problems, vec!["monitor form must start with \"监控◉\"".to_string()]);
        let rejection = validate("监控◉CI◉绿").unwrap_err();
        assert_eq!(rejection.title, "监控◉CI◉绿");
        assert_eq!(rejection.problems, vec!["monitor result must not contain \"→\" or \"◉\"".to_string()]);
    }

    #[test]
    fn residue_is_ascii_case_insensitive() {
        assert!(validate("Pasted→x").is_err());
        assert!(validate("<b>→x").is_err());
        // U+017F (long s) folds to "s" under Unicode rules but not in a non-`u` JS regex.
        assert!(validate("pa\u{17F}ted→x").is_ok());
    }

    #[test]
    fn visible_tab_is_the_tab_whose_panes_hold_the_handle() {
        let layouts = serde_json::json!([{
            "worktreeId": "w",
            "root": {"type": "group", "tabs": [
                {"tabId": "tab-a", "title": "A→a", "panes": {"type": "terminal", "handle": "term_a", "tabId": "tab-a"}},
                {"tabId": "tab-b", "title": "⠹ my-repo", "panes": {"type": "split", "first":
                    {"type": "terminal", "handle": "term_x", "tabId": "tab-b"}, "second":
                    {"type": "terminal", "handle": "term_b", "tabId": "tab-b"}}}
            ]}
        }]);
        assert_eq!(
            find_visible_tab(&layouts, "term_b"),
            Some(VisibleTab { tab_id: "tab-b".into(), title: "⠹ my-repo".into() })
        );
        assert_eq!(find_visible_tab(&layouts, "term_a").unwrap().title, "A→a");
        // A PTY owned only by a hidden pending tab is absent from the layout.
        assert_eq!(find_visible_tab(&layouts, "term_hidden"), None);
    }

    #[test]
    fn under_never_lets_an_absolute_name_escape() {
        assert_eq!(under(Path::new("/a/b"), "/etc.txt"), PathBuf::from("/a/b//etc.txt"));
    }
}
