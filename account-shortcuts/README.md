# Account shortcuts

Open a new Orca terminal tab that starts a specific Claude Code, Codex, Antigravity or Grok account,
from a key, a macOS Service or a typed alias. Installed copy: `~/.orca/account-shortcuts`.

## Template layout: twelve accounts on F1–F12

`accounts.json` ships with every function key taken. Delete the slots you do not use, or point
them at your own profiles; each slot also has a typed alias (upper or lower case).

| Key | Account ID | Agent | Typed alias | Profile the template expects |
| --- | --- | --- | --- | --- |
| F1 | A1 | Claude Code | `cl1` | `~/.claude` |
| F2–F7 | A2–A7 | Claude Code | `cl2`–`cl7` | `~/.claude-profiles/work`, `team1` … `team5` |
| F8 | C1 | Codex | `co1` | `~/.codex` |
| F9 | C2 | Codex | `co2` | `~/.codex-profiles/work` |
| F10 | AG1 | Antigravity | `ag1` | the login `agy` already has |
| F11 | AG2 | Antigravity | `ag2` | your own wrapper `agy-work` (see below) |
| F12 | G1 | Grok | `go1` | the login `grok` already has |

The key always opens its tab in the workspace on screen: with a paired host's workspace in front,
F3 pressed on the laptop starts account A3 in a new terminal on that host, in that workspace's
directory. Credentials stay on the host; a host without the account prints an error instead of
falling back to another account. Details: [shortcut-routing.md](shortcut-routing.md).

## accounts.json

```json
"A2": { "title": "Orca A2 Claude Work", "agent": "claude", "switchCommand": "ccp work",
        "viewMode": "chat", "key": "" }
```

- `agent`: `claude`, `codex`, `grok` or `antigravity`; `command` overrides the executable (default: the agent name).
- `switchCommand` selects the profile without running a shell:
  - `ccp default` → `~/.claude`; `ccp <name>` → `CLAUDE_CONFIG_DIR=~/.claude-profiles/<name>`.
  - `cxp default` → `~/.codex`; `cxp <name>` → `CODEX_HOME=~/.codex-profiles/<name>`.
  - `true` → no profile switch (for example Grok, or Antigravity's single login).
  - `export AG2_ACCOUNT=<name>` → sets that variable for the account's `command`.
- `key`: an AppKit key equivalent. F1–F12 are `""`–`""`; prefixes `@` Command, `^` Control,
  `~` Option, `$` Shift (for example `^~1`). `extraShortcuts` adds more keys for the same account.
- `viewMode`: `chat` (Orca Chat UI) or `terminal`.
- `aliases` maps typed names (`CL2`, `cl2`) to account IDs. Keep `_orca_aliases` in `shell/orca.zsh` in step,
  and never name an alias after its account's `command`.

A profile directory must exist before its account can launch. Log in once with, for example,
`CLAUDE_CONFIG_DIR=~/.claude-profiles/work claude` or `CODEX_HOME=~/.codex-profiles/work codex login`.

Antigravity: `agy` keeps one login and has no profile switch, so AG1 runs it as is. AG2 is a slot
for a second login: put an executable named `agy-work` on `PATH` that selects that login (it
receives `AG2_ACCOUNT=work`) and starts `agy`. This toolkit does not ship that wrapper; without
it F11 reports `command not found` in the new tab. Delete the AG2 slot if you have one login.

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
orca-fkey-tap check                                     # prints F1 -> A1 … F12 -> G1
orca-account-launch C2 --from-shortcut --check          # read-only dry run
```
