# Orca Toolkit

Unofficial add-ons for the [Orca](https://orca.dev) agent terminal on macOS, for people who run
several Claude Code / Codex / Antigravity / Grok accounts side by side. Not affiliated with Orca or Stably.

## Start here: three remote workflows

The agents run on one Mac (the host); a laptop or phone paired with it shows the same tabs.

| Workflow | What you do | Where it lives |
| --- | --- | --- |
| Remote image | Paste, drop or attach a screenshot in the Chat UI of a remote session; the image is uploaded to the host in 384 KB chunks (so a 1 MB reverse-proxy limit never rejects it) and shows up as a normal attachment. `orca-chat-image --clipboard --send` sends the clipboard image from a shell; a local file or an image URL works too. | [`agent-hooks/antigravity-chat-sync.mjs`](agent-hooks/antigravity-chat-sync.mjs) (renderer hook and `/orca-chat-upload` receiver), [`agent-hooks/orca-chat-image.mjs`](agent-hooks/orca-chat-image.mjs) |
| Remote F-keys | Press F1–F12 on the laptop while a host workspace is on screen: a new terminal opens on the host, in that workspace's directory, running that key's account. The template fills all twelve keys: F1–F7 Claude Code, F8–F9 Codex, F10–F11 Antigravity, F12 Grok, each with a typed alias (`cl2`, `co1`, …). | [`account-shortcuts/`](account-shortcuts/README.md), rules in [`shortcut-routing.md`](account-shortcuts/shortcut-routing.md); `automation/crates/orca-fkey-tap`, `automation/crates/orca-account-launch` |
| Ghost tabs | Tabs closed from a phone or the CLI can stay behind on a paired laptop as dead mirrors ([orca#40683](https://github.com/stablyai/orca/issues/40683)); this drops them. | [`automation/crates/orca-ghost-tabs`](automation/crates/orca-ghost-tabs/README.md) |

The first two patch the running Orca app, so an Orca update can break them: read the source before enabling them.

## Parts

| Part | What it does |
| --- | --- |
| [`account-shortcuts/`](account-shortcuts/README.md) | One key or typed alias per account opens a new Orca tab already running that account (Claude profiles via `CLAUDE_CONFIG_DIR`, Codex via `CODEX_HOME`). The template maps twelve accounts to F1–F12. |
| `automation/crates/orca-account-launch` | Rust launcher behind those aliases, Services and keys. |
| `automation/crates/orca-fkey-tap` | Event tap so plain F-keys work even while a terminal has focus. |
| `automation/crates/resume-home` | `Cmd+Shift+T` reopen: resumes the closed tab's agent session under the account that owns it. |
| [`automation/crates/orca-ghost-tabs`](automation/crates/orca-ghost-tabs/README.md) | Opt-in workaround for [orca#40683](https://github.com/stablyai/orca/issues/40683): drops a paired client's leftover mirror of a tab the host already closed. |
| `automation/crates/session-title`, [`skills/session-title/`](skills/session-title/SKILL.md) | Names Claude Code / Codex sessions and their Orca tabs. |
| [`statusline/`](statusline/README.md) | Claude Code status line: model, context, 5-hour and weekly quota bars; Codex `[tui]` line. |
| `agent-hooks/` | Antigravity CLI → Orca Chat UI transcript bridge, and `orca-chat-image` to attach images to the Chat UI. |
| `integrations/` | Orca status plugins for the pi agent and OpenCode. |
| `shell/orca.zsh` | Typed aliases, `ccp`/`cxp` profile switches, OSC 52 clipboard and fast pane close for Orca shells. |

中文简介：Orca（AI 编码代理终端）的非官方多账号扩展。一个按键或别名就能在新标签里启动指定的
Claude Code / Codex / Antigravity / Grok 账号（模板把 12 个账号排在 F1～F12 上），在远程设备上按键时终端开在主机上；
还可以在远程 Chat UI 里粘贴截图发给主机上的 Agent。另附状态栏、标签恢复、会话命名和 Antigravity 对话桥。仅支持 macOS。

## Requirements

macOS, [Orca](https://orca.dev) installed at `/Applications/Orca.app`, Node 22.18+, zsh,
and Rust (`cargo`) for the native launchers. Claude Code / Codex / Antigravity (`agy`) / Grok CLIs for the accounts you use.

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

Remote image and the Antigravity bridge are optional and share one script. Run this on the host and
on each Mac whose Orca desktop app you paste from:

```sh
mkdir -p ~/.orca/agent-hooks ~/.local/bin
cp -R agent-hooks/. ~/.orca/agent-hooks/
node ~/.orca/agent-hooks/antigravity-chat-sync.mjs --bootstrap     # add --chat to open Antigravity tabs in the Chat UI
ln -s ~/.orca/agent-hooks/orca-chat-image.mjs ~/.local/bin/orca-chat-image
orca-chat-image --clipboard --send                                 # clipboard image -> Orca's Chat UI
```

`--bootstrap` registers Antigravity hooks in `~/.gemini/config/hooks.json` and a `local.orca-toolkit.antigravity-patch`
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
