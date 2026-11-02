# resume-home

The execution host owns session recovery. The desktop client only sends Orca's
`tab.reopenClosed` action; the restored PTY's first zsh prompt runs `resume-home reopen`.

Recovery matches the restored tab title and exact `worktreePath` against local
Claude/Codex transcript metadata. It rejects remote PTYs in the local runtime,
missing workspace metadata, live panes, running Claude sessions and transcripts
older than the existing seven-day idle limit. Account lookup includes local
profiles and Codex archives. No transcripts or credentials move between hosts.

The native `Cmd+Shift+T` binding is in `~/.orca/keybindings.json`; each host also
needs the `orca reopen resume` block from `shell/orca.zsh`. The MacBook binding
was enabled on 2026-10-22 while preserving all other bindings.

Sources are installed under `~/automation/crates/resume-home` on each execution
host. Build and install through the existing gate:

```sh
cd ~/automation
PATH=/opt/homebrew/opt/rustup/bin:$PATH cpu-build-gate run -- cargo test -p resume-home --locked
PATH=/opt/homebrew/opt/rustup/bin:$PATH cpu-build-gate run -- cargo install --path crates/resume-home --root ~/.local --locked --force
```

This repository preserves the source host's full workspace lockfile, including
uncollected crates. When building this smaller snapshot for the first time, run
`cargo generate-lockfile --offline` in its `automation/` directory first.

Studio and the MacBook are both Apple Silicon; the verified Studio binary can be
copied to the MacBook when its Rust toolchain is unavailable. Back up the installed
binary first, install via a temporary path, compare SHA-256 digests, and retain
the previous binary and keybindings for rollback. Do not copy session-title
records or account histories.
