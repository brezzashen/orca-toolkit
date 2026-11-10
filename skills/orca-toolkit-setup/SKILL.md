---
name: orca-toolkit-setup
description: Guide a user step by step through installing orca-toolkit for F1-F12 account tabs and remote Chat UI images.
metadata:
  triggers: orca-toolkit, orca toolkit setup, Orca F1-F12, Orca account keys, remote Chat UI image, paste image remote Orca, 安装 orca-toolkit, 配置 F1 到 F12, 远程发图片
---

# Set up orca-toolkit with the user

You are installing [orca-toolkit](../../README.md) on the user's Mac(s) and guiding them through the
few steps only a person can do. Work through the phases in order. Each phase ends with a check; do not
start the next phase until it passes. Run every command yourself unless the step says **(user)**.

## What the user gets

| Experience | Where it runs |
| --- | --- |
| **F1–F12 account tabs:** a function key opens a new Orca tab in the workspace on screen, already running that key's account (Claude Code, Codex, Antigravity or Grok, each with its own profile). On a client Mac the tab opens on the host that owns the workspace. | Host: CLIs, profiles, shell functions. Every Mac that presses keys: the event tap. |
| **Remote Chat UI images:** paste, drop or attach a screenshot in the Chat UI of a session that runs on another Mac; the image is uploaded to that Mac and attached. | The bridge on each client desktop that pastes, and on the host for browser or phone clients. |

The **host** is the Mac whose Orca runs the agents. A **client** is a Mac whose Orca desktop app shows
the host's workspaces. One Mac on its own is `both`.

## Phase 0: role and consent

1. Ask the user one question: is this Mac the host, a client, or both? If they have a second Mac, set
   up the host first.
2. Before installing, tell the user what changes on their Mac and get a yes:
   - launchd agents `local.orca-toolkit.fkey-tap` (event tap) and, with the bridge,
     `local.orca-toolkit.antigravity-patch`, which injects a script into the running Orca app;
   - one macOS Service per account key under `~/Library/Services`, and Orca's `~/.orca/keybindings.json`
     with those chords removed (a backup is kept);
   - the bridge's Antigravity hooks in `~/.gemini/config/hooks.json` and `~/.orca/agent-hooks/`;
   - a `source` line in `~/.zshrc`, programs in `~/.local/bin`, and with `--statusline` two scripts
     linked into `~/.claude` plus a `statusLine` entry in `~/.claude/settings.json`;
   - the Accessibility permission for **OrcaFkeyTap**.
   The bridge patches Orca at run time, so an Orca update can break it until the bridge is re-run
   (Phase 5).

## Phase 1: clone and test

Skip the clone when the repository is already on disk; use its path wherever this skill says
`~/orca-toolkit`.
```sh
git clone https://github.com/brezzashen/orca-toolkit.git ~/orca-toolkit
cd ~/orca-toolkit && npm test
```
Check: `npm test` ends with `fail 0`. Requirements: macOS, `/Applications/Orca.app`, Node 22.18+, zsh,
Rust (`cargo`, install with `curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal` when it is
missing, then `. ~/.cargo/env`) and the Xcode command line tools (`xcode-select --install`) for the
native programs. Start Orca once before Phase 5 (`open -g -a Orca`). Never edit files in the
repository to configure accounts: its tests pin the template, and `git pull` keeps working.

## Phase 2: choose the accounts (host; a client copies the host's choice)

Inventory first, then propose; never ask the user to type a list you can detect.

1. Detect CLIs: `command -v claude codex agy grok`.
2. Detect profiles (`ls` of a missing folder only prints an error):
   `ls -d ~/.claude ~/.codex 2>/dev/null; ls ~/.claude-profiles ~/.codex-profiles 2>/dev/null`.
3. Check which are logged in: `CLAUDE_CONFIG_DIR=<dir> claude auth status` for a Claude profile
   (`~/.claude` without the variable) and `CODEX_HOME=<dir> codex login status` for Codex. A folder that
   is not logged in still needs a login **(user)**: `CLAUDE_CONFIG_DIR=<dir> claude` then `/login`, or
   `CODEX_HOME=<dir> codex login`.
4. Propose a slot table: F1–F7 Claude Code, F8–F9 Codex, F10–F11 Antigravity, F12 Grok, as in the
   template [`account-shortcuts/accounts.json`](../../account-shortcuts/accounts.json). Map each slot to a
   profile (`ccp default` = `~/.claude`, `ccp <name>` = `~/.claude-profiles/<name>`; `cxp` the same for
   Codex). Drop slots the user has no account for. Show the table and wait for the user's yes.

## Phase 3: install, then write the accounts

```sh
cd ~/orca-toolkit
node scripts/install.ts --dry-run --rust --fkey-tap --services --statusline   # show the user
node scripts/install.ts --rust --fkey-tap --services --statusline
```
The installer prints the exact `source …/shell/orca.zsh` line for this clone: append it to `~/.zshrc`
unless it is there. It also links `~/.local/bin/orca` to the CLI inside Orca.app; if `~/.local/bin` is not on
`PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` as well. On Node 22–23 every script prints an
`ExperimentalWarning` about type stripping: it is harmless. With `--statusline` it also prints a `statusLine` entry: merge it into
`~/.claude/settings.json` with a JSON-aware edit after backing that file up. `--statusline` is optional.

Now write the chosen accounts into the installed copy `~/.orca/account-shortcuts/accounts.json`
(the installer created it from the template and never overwrites it later):
1. Keep each chosen slot's object, change only `switchCommand` (and `command` if needed), and delete
   the dropped slots from `accounts` and their entries from `aliases`. Use a JSON-aware edit, such as a
   short Node script that parses and re-serializes the file.
2. F-keys are invisible private-use characters, U+F704 (F1) to U+F70F (F12); the template writes them
   as the escapes `\uF704` … `\uF70F`. Never type a key by hand: keep each kept slot's `key` as
   parsed, and give a moved slot `String.fromCharCode(0xF704 + n - 1)` for F<n>. `JSON.stringify` then
   writes the raw character, which is correct but invisible, so read the result back only through
   `doctor.ts` (its `F-key map` line).
3. Typed aliases for dropped slots (for example `cl3`) stay defined in `shell/orca.zsh` and only print
   an unknown-account error; leave the repository file alone.
4. If you used `--services`, run `node scripts/install.ts --services` again so the Services match.
5. Check: `node scripts/doctor.ts --role host` prints the `F-key map` you agreed on.

On a client, copy the host's `~/.orca/account-shortcuts/accounts.json` to the same path: the client only
needs the key → account ID map; profiles and credentials stay on the host.

Then, only a person can do these **(user)**:
1. **Accessibility:** System Settings > Privacy & Security > Accessibility > turn on **OrcaFkeyTap**.
   Open the pane for them with `open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"`.
   After every rebuild of the tap, macOS may need it toggled off and on again.
2. **Function keys:** System Settings > Keyboard > Keyboard Shortcuts > Function Keys > turn on
   "Use F1, F2, etc. keys as standard function keys". F11 is "Show Desktop" by default: turn that
   shortcut off, or move the F11 slot.
3. **Restart Orca** (Cmd+Q, reopen) so the Services and keybindings take effect.

## Phase 4: pair a client with the host (skip for `both`)

Orca's own pairing, from <https://www.onorca.dev/docs/remote-servers>:
1. **(user, host)** Settings > Remote Orca Servers > *Advertise this app as a server* > **New Link**.
   Pick a private address (Tailscale `100.x.y.z` or the LAN), **Generate Access Link**, copy it.
   Never expose port 6768 to the internet.
2. **(user, client)** Settings > Remote Orca Servers > **Add Server**, paste the link, **Connect**.
3. Check: `orca environment list --json` on the client lists the host, and the server row shows Connected.

## Phase 5: remote image bridge

Run on the host and on every client desktop the user pastes from:
```sh
mkdir -p ~/.orca/agent-hooks ~/.local/bin
cp -R ~/orca-toolkit/agent-hooks/. ~/.orca/agent-hooks/
node ~/.orca/agent-hooks/antigravity-chat-sync.mjs --bootstrap
node ~/.orca/agent-hooks/antigravity-chat-sync.mjs --patch-orca --force    # prints {"ok":true}
ln -sf ~/.orca/agent-hooks/orca-chat-image.mjs ~/.local/bin/orca-chat-image
```
`--bootstrap` prints nothing on success; on a Mac without Antigravity it still writes
`~/.gemini/config/hooks.json`, which is harmless. Re-run the `--patch-orca --force` line after every Orca update.

## Phase 6: verify with the user

1. Run `node ~/orca-toolkit/scripts/doctor.ts --role host|client|both`. Fix every `FAIL` with the line under
   it, then run it again until it prints `All checks passed.` Its `F-key map` line shows what each key opens.
2. **F-keys (user):** focus any Orca terminal and press F1. Expect a new tab in that workspace running
   slot 1's account; on a client with a host workspace on screen, the tab opens on the host. Then press
   each other key once. `tail -5 ~/Library/Logs/orca-fkey-tap.log` shows `F<n> -> <ID>` per press.
3. **Images (user, on a client):** open a Chat UI session of a host workspace, copy a screenshot, press
   Cmd+V. Expect an attachment chip and no "Local attachments are not available for remote sessions"
   notice. `tail -20 ~/Library/Logs/orca-remote-chat-image.log` shows a `main-save` line whose `env` is the host and whose `path` is on the host.
4. Tell the user what works, what you skipped and why.

## When something fails

| Symptom | Cause and fix |
| --- | --- |
| F-key does nothing while a terminal has focus | Tap not running or not trusted: doctor shows `event tap refused`; toggle OrcaFkeyTap in Accessibility, then `launchctl kickstart -k gui/$(id -u)/local.orca-toolkit.fkey-tap`. |
| F-key brightness or volume changes instead | Standard function keys are off (Phase 3, step 2). |
| New tab prints `command not found` | The slot's CLI is missing on the host, or AG2's `agy-work` wrapper does not exist (see account-shortcuts/README.md). |
| New tab opens the wrong account | `switchCommand` points at the wrong profile; fix `accounts.json` on the host and copy it to `~/.orca/account-shortcuts/`. |
| "Local attachments are not available for remote sessions" | The bridge is not injected on this client, often after an Orca update: re-run Phase 5. |
| Paste works on the host but not from a phone or browser | Run Phase 5 on the host as well. |
| A key or alias prints `enable Orca Chat UI before opening account tabs` | The slot uses `"viewMode": "chat"` and Orca's Chat UI is off on that Mac: turn it on in Orca Settings (search "Chat"), or set the slot's `viewMode` to `terminal`. |
| `orca: command not found` | Run `node scripts/install.ts` again (it links `~/.local/bin/orca`) and put `~/.local/bin` on `PATH`. |

Undo: `launchctl bootout gui/$(id -u)/local.orca-toolkit.fkey-tap`, the same for
`local.orca-toolkit.antigravity-patch`, delete `~/Library/LaunchAgents/local.orca-toolkit.*.plist` and the
account Services `install.ts` wrote under `~/Library/Services`,
remove the `source` line from `~/.zshrc`, and restore `~/.orca/keybindings.json` from its backup.
