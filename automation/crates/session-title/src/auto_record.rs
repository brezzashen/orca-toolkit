//! Automatic pane records for sessions that never run `session-title set`.
//!
//! `resume-home reopen` (Orca Cmd+Shift+T) can only resume a closed pane that has a record
//! under `~/.local/state/session-title/orca/<handle>.json`. On the main Mac every agent runs
//! `set`, but on other paired Macs agents may not, so their panes had no record and a
//! reopened tab stayed a bare shell. The prompt hooks call `track` to fill that gap:
//!
//! - a pane whose record came from `set` is left alone (`set` stays authoritative);
//! - a tab that already carries a custom title is recorded under that title;
//! - a tab with Orca's default title ("Terminal N", "zsh", empty) is first named after the
//!   session's latest `custom-title`, else its `ai-title`, because Orca's reopen only brings
//!   back a custom title and an untitled tab could never be matched.
//!
//! The record is marked `auto`, so `sync_orca_quietly` never forces it back onto the tab: a
//! later manual rename is simply recorded on the next prompt. Silent on every failure.

use super::{find_transcript, orca_bin, orca_handle, query_visible_tab, read_sticky, run_bounded, write_sticky, StickyTitle};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;

const LIMIT: Duration = Duration::from_millis(1500);
/// Title records repeat through a transcript, so the tail always holds the latest ones.
const TAIL_BYTES: u64 = 512 * 1024;
const MAX_TITLE_CHARS: usize = 40;

/// Orca's own tab names; Orca's reopen does not restore them and `resume-home` ignores them.
pub fn is_default_title(title: &str) -> bool {
    let title = title.trim();
    title.is_empty() || title == "zsh" || title.starts_with("Terminal ")
}

pub fn track(session: &str) {
    let Some(handle) = orca_handle() else { return };
    let existing = read_sticky(&handle);
    if existing.as_ref().is_some_and(|s| !s.auto) {
        return;
    }
    let bin = orca_bin();
    let Ok(Some(tab)) = query_visible_tab(&bin, &handle, LIMIT) else { return };
    let title = if is_default_title(&tab.title) {
        let Some(title) = find_transcript(session).and_then(|path| transcript_title(&path)) else { return };
        let args = ["terminal", "rename", "--terminal", handle.as_str(), "--title", title.as_str()];
        if run_bounded(&bin, &args, LIMIT).is_err() {
            return;
        }
        title
    } else {
        tab.title
    };
    let record = StickyTitle { title, session: session.to_string(), auto: true };
    if existing.as_ref() != Some(&record) {
        let _ = write_sticky(&handle, &record);
    }
}

/// The session's latest `custom-title`, else its latest `ai-title`, read from the file tail.
fn transcript_title(path: &std::path::Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    latest_title(&String::from_utf8_lossy(&buf))
}

pub fn latest_title(text: &str) -> Option<String> {
    let (mut custom, mut ai) = (None, None);
    for line in text.lines().rev() {
        if custom.is_some() {
            break;
        }
        // Cheap filter before parsing; most lines are messages.
        if !line.contains("-title\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let pick = |key: &str| value.get(key).and_then(serde_json::Value::as_str).map(tidy).filter(|t| !t.is_empty());
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("custom-title") => custom = pick("customTitle"),
            Some("ai-title") if ai.is_none() => ai = pick("aiTitle"),
            _ => {}
        }
    }
    custom.or(ai).filter(|t| !is_default_title(t))
}

fn tidy(raw: &str) -> String {
    let joined = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(MAX_TITLE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_latest_custom_title_over_ai_title() {
        let text = concat!(
            "{\"type\":\"custom-title\",\"customTitle\":\"旧标题→完成\"}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"外置 2TB 磁盘分区重规划\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"分区建议→扇形报告\"}\n",
            "{\"type\":\"user\",\"message\":\"x\"}\n",
        );
        assert_eq!(latest_title(text).as_deref(), Some("分区建议→扇形报告"));
    }

    #[test]
    fn falls_back_to_ai_title_and_tidies_it() {
        let text = "{\"type\":\"ai-title\",\"aiTitle\":\"  Fix   the\\nbuild  \"}\n{\"type\":\"user\"}\n";
        assert_eq!(latest_title(text).as_deref(), Some("Fix the build"));
        assert_eq!(latest_title("{\"type\":\"user\"}\n"), None);
        assert_eq!(latest_title("{\"type\":\"ai-title\",\"aiTitle\":\"Terminal 2\"}\n"), None);
    }

    #[test]
    fn default_titles() {
        for title in ["", " ", "zsh", "Terminal 1", "Terminal 12"] {
            assert!(is_default_title(title), "{title}");
        }
        for title in ["WT→自动建链", "Terminals", "片S06→渲染报告"] {
            assert!(!is_default_title(title), "{title}");
        }
    }

    #[test]
    fn sticky_record_keeps_the_set_format_and_reads_old_records() {
        let manual = StickyTitle { title: "a→b".into(), session: "s".into(), auto: false };
        assert_eq!(serde_json::to_string(&manual).unwrap(), "{\"title\":\"a→b\",\"session\":\"s\"}");
        let old: StickyTitle = serde_json::from_str("{\"title\":\"a→b\",\"session\":\"s\"}").unwrap();
        assert!(!old.auto);
        let auto = StickyTitle { auto: true, ..manual };
        assert_eq!(serde_json::to_string(&auto).unwrap(), "{\"title\":\"a→b\",\"session\":\"s\",\"auto\":true}");
    }
}
