# Orca Toolkit

Unofficial add-ons for the [Orca](https://orca.stably.ai) agent terminal on macOS, for people who run
several Claude Code / Codex / Grok accounts side by side. Not affiliated with Orca or Stably.

| Part | What it does |
| --- | --- |
| [`account-shortcuts/`](account-shortcuts/README.md) | One key or typed alias per account opens a new Orca tab already running that account (Claude profiles via `CLAUDE_CONFIG_DIR`, Codex via `CODEX_HOME`). |
| `automation/crates/orca-account-launch` | Rust launcher behind those aliases, Services and keys. |
| `automation/crates/orca-fkey-tap` | Event tap so plain F-keys work even while a terminal has focus. |
| `automation/crates/resume-home` | `Cmd+Shift+T` reopen: resumes the closed tab's agent session under the account that owns it. |
| `automation/crates/session-title`, [`skills/session-title/`](skills/session-title/SKILL.md) | Names Claude Code / Codex sessions and their Orca tabs. |
| [`statusline/`](statusline/README.md) | Claude Code status line: model, context, 5-hour and weekly quota bars; Codex `[tui]` line. |
| `agent-hooks/` | Antigravity CLI → Orca Chat UI transcript bridge, and `orca-chat-image` to attach images to the Chat UI. |
| `integrations/` | Orca status plugins for the pi agent and OpenCode. |
| `shell/orca.zsh` | Typed aliases, `ccp`/`cxp` profile switches, OSC 52 clipboard and fast pane close for Orca shells. |

中文简介：Orca（AI 编码代理终端）的非官方多账号扩展。一个按键或别名就能在新标签里启动指定的
Claude Code / Codex / Grok 账号，并附带状态栏、标签恢复、会话命名和 Antigravity 对话桥。仅支持 macOS。

## Requirements

macOS, [Orca](https://orca.stably.ai) installed at `/Applications/Orca.app`, Node 22.18+, zsh,
and Rust (`cargo`) for the native launchers. Claude Code / Codex / Grok CLIs for the accounts you use.

## Install

```sh
git clone https://github.com/brezzashen/orca-toolkit.git ~/orca-toolkit
cd ~/orca-toolkit
npm test                                   # JavaScript tests
$EDITOR account-shortcuts/accounts.json    # your accounts and keys (see account-shortcuts/README.md)
node scripts/install.ts --dry-run --rust --fkey-tap --services --statusline   # preview
node scripts/install.ts --rust --fkey-tap --services --statusline
echo 'source ~/orca-toolkit/shell/orca.zsh' >> ~/.zshrc
```

| Flag | Effect |
| --- | --- |
| (none) | Copies `account-shortcuts/` to `~/.orca/account-shortcuts` (an existing `accounts.json` is kept) and links `~/.local/bin/node` if missing. |
| `--rust` | `cargo install` the four Rust programs into `~/.local/bin`. |
| `--fkey-tap` | Also loads the `local.orca-toolkit.fkey-tap` launchd agent. Grant Accessibility to **OrcaFkeyTap** when macOS asks. |
| `--services` | Creates one macOS Service per account key and frees those chords in Orca's keybindings (backed up). Restart Orca afterwards. |
| `--statusline` | Links the Claude Code status-line scripts into `~/.claude` (existing files are backed up). |

The Antigravity bridge is optional: copy `agent-hooks/` to `~/.orca/agent-hooks` and run
`node ~/.orca/agent-hooks/antigravity-chat-sync.mjs --bootstrap` (add `--chat` to open Antigravity tabs in the Chat UI).
It registers Antigravity hooks in `~/.gemini/config/hooks.json` and a `local.orca-toolkit.antigravity-patch`
launchd job that injects the bridge into the running Orca renderer; review the script before enabling it. `orca-chat-image` uploads only to the
Orca receiver you choose: `127.0.0.1:6768` by default, or `ORCA_CHAT_LAN_SERVER` /
`ORCA_CHAT_PUBLIC_SERVER` for `--lan` / `--public`.

## Privacy

Everything runs locally. No credential, token or transcript leaves your Mac through this toolkit;
launchers only set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and start the CLI you already logged into.

## Tests

```sh
npm test                 # account shortcuts and Antigravity bridge
npm run test:rust        # Rust crates
```

MIT licensed. See [LICENSE](LICENSE).
