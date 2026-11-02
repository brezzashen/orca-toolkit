# Session title boundary

`title.ts` validates the shared acceptance-title format and routes by session environment.
Codex uses `CODEX_THREAD_ID` and the JSON-RPC adapter in `codex.ts`.
Claude Code uses `CLAUDE_CODE_SESSION_ID`, transcript records and its pending hook queue.
Both agents rename the enclosing Orca terminal when its handle is available.

Skill symlinks expose this directory to Codex and Claude Code without duplicated rules.
The shared global instructions call it at task start, then only when acceptance criteria change.
Titles contain at most ten Unicode code points. Edit titles use one arrow;
monitor titles use the fixed prefix `监控◉`.

`title.test.ts` checks agent routing, validation, RPC errors and Claude hook compatibility.
