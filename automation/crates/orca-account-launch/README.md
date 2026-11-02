# orca-account-launch

Rust entry for Orca account shortcuts on each Mac. macOS Services delegate to
`~/.orca/account-shortcuts/shortcut-launch.mjs` before inspecting local accounts or terminals.
Plain F-keys no longer pass through here: `orca-fkey-tap` opens their tabs in-process
(`crates/orca-fkey-tap/src/open.rs`). The local Orca IPC client lives in `shared/orca_rpc.rs`.
Typed aliases connect only to this Mac's authenticated Unix socket.
The local runtime resolves the caller's terminal; its explicit workspace and execution host
are verified before a single `session.tabs.createTerminal` request carries the startup command.
The created PTY runs `orca-account-launch ACCOUNT --run --agent-args TEXT` locally.

Account selection sets the known profile environment directly. It never calls `ccp`/`cxp`
or waits for `auth status`. Codex keeps `--no-daemon`; aliases reuse their current terminal.
The command attached to new tabs waits for shell readiness. Mutation failures are reported,
never retried, to avoid duplicate agents after a lost reply.

```
orca-account-launch C1 --check
orca-account-launch C1 --from-shortcut
orca-account-launch CO2 --chat
orca-account-launch A1 --new-tab
orca-account-launch --restore
```

F-keys always press Orca's New Terminal binding through the JavaScript entry, including
when a stale local active terminal exists. The desktop opens the tab in its visible workspace.
The JavaScript entry then uses that host's shared launcher or exact account alias.
For example, a host exposing only `co2` supports F9 without installing other profiles.
Missing accounts produce an error in that workspace, never a different project or account.
Typed aliases never hand off.
Existing TypeScript launchers stay available for rollback until every client is accepted.

`Cmd+Shift+T` remains Orca's native `tab.reopenClosed` action. The restored shell calls
`--restore`, which verifies its local terminal identity and asks the existing Rust
`resume-home reopen` engine for the exact local conversation and owning account. The
engine rejects live sessions, mismatched workspaces and records without local history.
