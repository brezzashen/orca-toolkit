# Status lines

Bottom status bars for Claude Code and Codex, with the subscription accounts of every
agent (Claude `cc*`, Codex `co*`, Antigravity `ag1`) on one line.

| File | Installed as | Role |
| --- | --- | --- |
| `claude/statusline-orca-combined.sh` | `~/.claude/statusline-orca-combined.sh` (symlink) | `statusLine.command` in every Claude profile's `settings.json`. Feeds Orca's own reporter (`~/.orca/agent-hooks/claude-statusline.sh`, which prints nothing) and then prints the visible lines. |
| `claude/statusline-command.sh` | `~/.claude/statusline-command.sh` (symlink) | Draws the three lines below and persists `rate_limits` to `$CLAUDE_CONFIG_DIR/rate-limits.json` (read by [Token Arcade](https://github.com/brezzashen/token-arcade)). |
| `codex/tui.toml` | `[tui] status_line` in `~/.codex/config.toml` | Codex's built-in items: model, context left, 5-hour and weekly limits, branch, directory. |

Claude lines:

1. Current account alias, model, directory, git branch and session cost.
2. Context, 5-hour and weekly quota left for this session, each with a bar and reset time.
3. `Weekly left`: every account's weekly quota left and time to reset, ordered Claude,
   Codex, Antigravity; the current account is bracketed and readings older than 15 minutes are dimmed.

Line 3 is optional: it appears only when an executable `~/.local/bin/limit-resume` prints a
`route --json` account ranking (not included in this repository). Its output is
cached at `$TMPDIR/statusline-accounts.json` and refreshed in the background at most once a
minute, so a redraw never waits on the quota sources. The permission-mode line under the bar
is drawn by Claude Code itself; the status-line input carries no permission field.

Codex cannot run a custom status-line command, so `co1`/`co2` totals appear only in the
Claude line; Antigravity has no configurable bottom bar, so `ag1` appears there too.
