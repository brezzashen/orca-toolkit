# Visible-workspace account shortcuts

Function keys map to the account IDs in `accounts.json` (A1, A2, C1, C2, G1 in the template).
The execution host is selected by the workspace on screen, never by the account.

`orca-fkey-tap` and macOS Services invoke `orca-account-launch --from-shortcut`.
That path delegates to `shortcut-launch.mjs` before reading local profile directories
or resolving a local active terminal. The JavaScript entry uses Orca's official
runtime client and presses the configured New Terminal binding. `shortcut-core.mjs`
observes the new writable terminal and delivers one account command to its runtime.

The shortcut runtime reuses Orca's `RemoteRuntimeSharedControlConnection` for the
snapshot, observations and final send within one launch. `RuntimeClient` still
owns compatibility checks, durable request IDs and ambiguous-send recovery. The
first observation runs immediately; further remote polls retain their 80 ms
spacing so connection reuse does not increase server query pressure. Failed
observations back off from 250 ms to 1 s. Each launch closes
its own control connections in `finally`, including unused environments. Older
Orca builds without shared control keep their official request transport.
`shortcut-timing` log rows record preparation, terminal discovery and command
delivery separately. They do not measure the agent's first token or UI readiness.

Desktop invocations are serialized on each keyboard host by macOS `lockf -k`.
The lock covers the pre-launch snapshot, native New Terminal action, observation
and command delivery. A persistent local ledger claims each chosen terminal
before any input is sent, so a late snapshot cannot select a previous launch's
still-starting shell. Multiple unclaimed candidates are rejected as ambiguous.
Raw shell input is sent once. A lost reply triggers read-only delivery checks,
never a second write; the UI preview can be wrapped or incomplete. This fixes
concurrent invocations appending two `if ... fi` commands into the same shell.
The lock file and claim ledger are host-local runtime state and are not synced.

When the new terminal belongs to this Mac's runtime, it receives only the account
alias, such as `cl2 --chat`, because the local shell defines every alias.
A remote terminal receives the probing command instead.
On a fully configured remote host, the command uses `orca_account_tab ID --chat`.
On a host exposing only shell account aliases, it uses the exact configured alias,
such as `co2`. It preserves the new terminal's working directory. A missing account
prints an error there and never falls back to another account, host, or project.
F11 and F12 use the same mapping mechanism without changing their account IDs.

Typed aliases and `--new-tab` with a terminal identity keep the Rust launcher path.
No credentials are copied to make a remote shortcut work. Existing sessions stay alive.
The prior TypeScript entry remains available for rollback.

Validation:

```sh
npm run test:shortcuts
cargo test -p orca-account-launch --locked
orca-account-launch C2 --from-shortcut --check
```

The check command is read-only. A real acceptance run must select a remote workspace,
press an account key, then verify its new terminal, account, working directory and editable UI.
The command's success alone does not prove a physical key event was received.
