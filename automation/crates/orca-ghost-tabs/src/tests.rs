use crate::{round, server};
use std::collections::BTreeSet;

const TAB: &str = "11111111-2222-4333-8444-555555555555";

fn span(name: &str, attrs: &str) -> String {
    format!(r#"{{"type":"effect-span","name":"{name}","attributes":{{{attrs}}}}}"#)
}

#[test]
fn mobile_close_names_the_tab_before_the_leaf() {
    let line = span("runtime.session-tabs.close", &format!(r#""origin":"mobile","tabId":"{TAB}::66666666-7777-4888-8999-aaaaaaaaaaaa","decision":"allowed""#));
    assert_eq!(server::closed_tab(&line).as_deref(), Some(TAB));
}

#[test]
fn cli_tab_close_counts_only_when_it_succeeded() {
    let ok = span("terminal.closeTab", &format!(r#""decision":"allowed","outcome":"succeeded","tabId":"{TAB}""#));
    let failed = span("terminal.closeTab", &format!(r#""decision":"allowed","outcome":"failed","tabId":"{TAB}""#));
    assert_eq!(server::closed_tab(&ok).as_deref(), Some(TAB));
    assert_eq!(server::closed_tab(&failed), None);
}

#[test]
fn pane_close_and_denied_close_are_not_tab_closes() {
    let pane = span("terminal.close", &format!(r#""decision":"allowed","outcome":"succeeded","closeMode":"pane","tabId":"{TAB}""#));
    let denied = span("runtime.session-tabs.close", &format!(r#""decision":"denied","tabId":"{TAB}""#));
    let other = span("persistence.terminal-topology", r#""topology.kind":"close_tab""#);
    assert_eq!(server::closed_tab(&pane), None);
    assert_eq!(server::closed_tab(&denied), None);
    assert_eq!(server::closed_tab(&other), None);
}

#[test]
fn trace_reads_resume_at_the_cursor_and_follow_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let trace = dir.path().join("main.trace.ndjson");
    let close = |tab: &str| span("terminal.closeTab", &format!(r#""decision":"allowed","outcome":"succeeded","tabId":"{tab}""#)) + "\n";
    let a = "aaaaaaaa-0000-0000-0000-000000000000";
    let b = "bbbbbbbb-0000-0000-0000-000000000000";
    let c = "cccccccc-0000-0000-0000-000000000000";
    std::fs::write(&trace, close(a)).unwrap();
    let (first, cursor) = server::new_closes(&trace, None).unwrap();
    assert_eq!(first, BTreeSet::from([a.to_string()]));
    // A half-written line is left for the next round.
    std::fs::write(&trace, close(a) + &close(b) + "{\"name\":\"terminal.clo").unwrap();
    let (second, cursor2) = server::new_closes(&trace, Some(&cursor)).unwrap();
    assert_eq!(second, BTreeSet::from([b.to_string()]));
    // Rotation: the old file becomes `.1` with more lines, a fresh file starts.
    std::fs::write(&trace, close(a) + &close(b) + &close(c)).unwrap();
    let rotated = trace.with_extension("ndjson.1");
    std::fs::rename(&trace, &rotated).unwrap();
    std::fs::write(&trace, "").unwrap();
    let moved = server::Cursor { inode: std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&rotated).unwrap()), ..cursor2 };
    let (third, _) = server::new_closes(&trace, Some(&moved)).unwrap();
    assert!(third.contains(c), "{third:?}");
}

#[test]
fn queue_adds_each_close_once_per_client() {
    let clients = vec![round::Client { ssh: "laptop-a".into(), node: "node".into() }, round::Client { ssh: "laptop-b".into(), node: "node".into() }];
    let mut state = round::State::default();
    round::queue(&mut state, &clients, &BTreeSet::from([TAB.to_string()]));
    round::queue(&mut state, &clients, &BTreeSet::from([TAB.to_string()]));
    assert_eq!(state.pending["laptop-a"].len(), 1);
    assert_eq!(state.pending["laptop-b"].len(), 1);
    round::queue(&mut state, &clients, &BTreeSet::new());
    assert_eq!(state.pending.len(), 2);
}
