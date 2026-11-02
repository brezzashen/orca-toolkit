# Account shortcuts

Open a new Orca terminal tab that starts a specific Claude Code, Codex or Grok account,
from a key, a macOS Service or a typed alias. Installed copy: `~/.orca/account-shortcuts`.

## accounts.json

```json
"A2": { "title": "Orca A2 Claude Work", "agent": "claude", "switchCommand": "ccp work",
        "viewMode": "chat", "key": "" }
```

- `agent`: `claude`, `codex`, `grok` or `antigravity`; `command` overrides the executable (default: the agent name).
- `switchCommand` selects the profile without running a shell:
  - `ccp default` → `~/.claude`; `ccp <name>` → `CLAUDE_CONFIG_DIR=~/.claude-profiles/<name>`.
  - `cxp default` → `~/.codex`; `cxp <name>` → `CODEX_HOME=~/.codex-profiles/<name>`.
  - `true` → no profile switch (for example Grok).
- `key`: an AppKit key equivalent. F1–F12 are ``–``; prefixes `@` Command, `^` Control,
  `~` Option, `$` Shift (for example `^~1`). `extraShortcuts` adds more keys for the same account.
- `viewMode`: `chat` (Orca Chat UI) or `terminal`.
- `aliases` maps typed names (`CL2`, `cl2`) to account IDs. Keep `_orca_aliases` in `shell/orca.zsh` in step.

A profile directory must exist before its account can launch. Log in once with, for example,
`CLAUDE_CONFIG_DIR=~/.claude-profiles/work claude` or `CODEX_HOME=~/.codex-profiles/work codex login`.

## Paths

| Trigger | Path |
| --- | --- |
| Typed `cl2` in an Orca terminal | `orca_account_tab` → `orca-account-launch CL2` (or `launch.ts` without the binary) |
| Plain function key, terminal focused | `orca-fkey-tap` event tap → opens the tab in-process |
| Key from the Chat UI or Services menu | macOS Service from `install.ts` → `orca-account-launch <ID> --from-shortcut` |

`install.ts` writes one Service per key under `~/Library/Services`, registers its key equivalent
for Orca only, and removes the same chords from `~/.orca/keybindings.json` (with a backup) so Orca
does not swallow them. Quit and reopen Orca afterwards.
See [shortcut-routing.md](shortcut-routing.md) for the visible-workspace and remote-runtime rules.

## Checks

```sh
node --experimental-vm-modules --test account-shortcuts/*.test.ts account-shortcuts/*.test.mjs
node ~/.orca/account-shortcuts/verify-shortcuts.ts      # every key wired end to end on this Mac
orca-account-launch C2 --from-shortcut --check          # read-only dry run
```
