---
name: session-title
description: "Rename the session to '<acceptance item>→<expected result>' for edits, or '监控◉<expected result>' for monitoring (10 chars max) as the first tool call of a task, once the requirement is understood and before any search, read or edit, so the title shows what the user gets and whether the session edits or watches. Rerun when acceptance criteria change. Also use for 标题, 改标题, 会话标题, 监控标题, session title, rename session."
---

# Session Title: acceptance item → expected result

The default Claude Code or Codex title is a summary of the first prompt.
A pasted first prompt gives titles such as `Pasted content id 5d2a 任务 把 Mars CRM`.
This skill replaces it with the result the user can verify.

## When to run

The title is the first step of execution, not a step after investigation.
A long task can run for hours; a title that arrives late leaves the session list unreadable for that time.

1. Run once per task, as soon as you understand the requirement and start to execute.
   - Make the title call the first tool call of the task, before any search, read, edit, deploy or subagent.
   - You can send it in the same parallel batch as the first independent calls. Do not send it after them.
   - Do not wait for investigation to settle the criteria. Take the expected result from the requirement as the user stated it.
   - A clarifying question comes first only when the deliverable is unknown. Run the title right after the answer.
2. Run again only when the acceptance criteria change: scope added, removed or redefined, or investigation turns a vague result into a number.
3. Do not run for a pure question with no deliverable.
4. Do not run again at task end. The title states the target, not the status.

| Situation | First tool call |
|---|---|
| "把事件切换做到 100ms 内" | `set "切换→<100ms"`, then profile |
| "排查 beta 为什么 500" | `set "beta→无500"`, then read logs |
| "盯一下 CI" | `watch "CI全绿"`, then poll |
| Investigation later lowers the target to 80ms | rerun `set "切换→<80ms"` |

## Title format

Two forms. The user tells editing from watching by the symbol alone, so pick the form by what the session does:

| Session does | Form | Example |
|---|---|---|
| Changes code, config, data or a design (修改) | `<acceptance item>→<expected result>` | `缓存→命中≥90%` |
| Only watches something run: CI, deploy, rollout, a background job, a /loop poll (监控) | `监控◉<expected result>` | `监控◉CI全绿` |

- A session that monitors and then has to fix what it saw changes its acceptance criteria: rerun with the edit form.
- `◉` is reserved for the monitor form. `监控` never appears left of `→`; the script rejects it.

### Edit form

- **Hard limit: 10 characters in total**, the arrow included. The user set this limit. The script rejects a longer title.
- No spaces around the arrow. The script removes them.
- **Acceptance item**: the object under acceptance, 2-4 chars. Use a noun.
- **Expected result**: the observable outcome the user gets, 3-6 chars. Use a number, a state or a visible behavior.
- Cut words before you cut the result. Remove 端, 的, 功能, 优化 and platform names first.
- Use the language of the user's latest message. Keep identifiers in original form.
- Do not use process verbs without a result: 排查, 研究, 优化, 处理, investigate, fix.
- Do not use prompt residue: `Pasted`, content ids, tags, `任务`, `帮我`.

| First-prompt title (bad) | Acceptance title (good, ≤10) |
|---|---|
| Pasted content id 5d2a 任务 把 Mars CRM | 缓存→命中≥90% |
| PC端事件切换性能优化 | 切换→<100ms |
| Pcsort 圆角和大小统一 | 圆角→两端一致 |
| Redis 滚动更新 | Redis→零中断 |
| 标题命名指南 | 标题→显示结果 |

Take the expected result from the strongest acceptance criterion.
If the criterion has a number, put the number in the title.

### Monitor form

`监控◉<expected result>`

- `监控◉` is fixed and takes 3 of the 10 chars, so the expected result gets **at most 7**.
- The expected result is the state that ends the watch: `CI全绿`, `Pod就绪`, `beta已上线`, `日志无报错`, `队列清空`.
- Do not name the activity (`看CI`, `等部署`); name the state you are waiting for.

| Monitoring task | Monitor title (≤10) |
|---|---|
| 盯 CI 直到通过 | 监控◉CI全绿 |
| 看 beta 发布滚动完成 | 监控◉beta已上线 |
| /loop 轮询 rollout | 监控◉Pod就绪 |
| 观察日志有没有再报错 | 监控◉日志无报错 |

## How to set it

Run one Bash call:

```bash
bun ~/.claude/skills/session-title/title.ts set "缓存→命中≥90%"   # edit form
bun ~/.claude/skills/session-title/title.ts watch "CI全绿"        # monitor form → 监控◉CI全绿
```

`set "监控◉CI全绿"` is accepted too; `watch` saves typing the symbol.

The script detects the current agent from its session environment.

For **Codex**, use the same command through `~/.codex/skills/session-title/title.ts`.
It reads `CODEX_THREAD_ID`, sets the name through app-server `thread/name/set`,
and verifies it with `thread/read`. It also renames the Orca tab when present.
RPC errors fail visibly; the script does not edit SQLite or create a new conversation.
The Codex resume name is persisted immediately. An already-open TUI can take time
to refresh the name; the Orca tab is renamed explicitly.

For **Claude Code**, the script writes the title to three places:

1. **Orca tab**: renamed at once (`orca terminal rename`).
2. **Transcript**: a `custom-title` record goes into the session transcript. The /resume list reads it. The running session also adopts it, usually within seconds (observed on Claude Code 2.1.291).
3. **Hook fallback**: a queued copy. The UserPromptSubmit hook applies it as `sessionTitle` on the next prompt. This is the documented path, so the title is guaranteed by the next prompt at the latest.

Exit code 2 means the title failed validation. Read the reasons, fix the title, and run again.

Tell the user the new title in one line. Example: `标题已更新：缓存→命中≥90%`.

## Setup

Codex and Claude Code share this directory through skill symlinks at
`~/.codex/skills/session-title` and `~/.agents/skills/session-title`.
The shared `~/.codex/AGENTS.md` tells Codex to invoke the skill when task execution starts.
This path does not depend on the legacy end-of-turn title notifier or another model call.
Pure questions without a deliverable keep their current title.

### Claude Code hook (already installed)

Each profile's `settings.json` (`~/.claude-profiles/<profile>/settings.json`) runs this UserPromptSubmit hook:

```json
{ "type": "command", "command": "bun \"$HOME/.claude/skills/session-title/title.ts\" hook", "timeout": 5 }
```

The hook prints nothing when no title is queued.
A new profile needs the same hook entry.
