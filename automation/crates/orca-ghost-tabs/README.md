# orca-ghost-tabs

Workaround for [stablyai/orca#40683](https://github.com/stablyai/orca/issues/40683) (seen on Orca 1.4.255):
a paired desktop client keeps a mirrored terminal tab, and its finished-agent sidebar row, after the
host closed that tab from the mobile app, the `orca` CLI, an automation or a shell exit. Clicking the
row does nothing because the tab no longer exists on the host.

Run this on the **host** Mac. Every round it:

1. Finds the tabs the host closed, on positive evidence only: a close span in Orca's
   `main.trace.ndjson` (`terminal.closeTab`, `terminal.close` with `closeMode: tab`,
   `runtime.session-tabs.close`), or a tab that left `orca terminal list` while
   `orca terminal show` records an `exitCause` (`src/server.rs`).
2. Queues those tab ids for every paired client (24 h, `~/.orca/ghost-tabs/state.json`, `src/round.rs`).
3. Sends the queued ids to each client over ssh and runs `src/client.mjs` there with Node. The script
   calls Orca's own `closeTab('web-terminal-<id>', { remoteCloseOwnedByHost: true })` and
   `dismissRetainedAgent` in the client's renderer, only for mirrors whose `ptyId` is null. A mirror
   that is still attached is never touched, and no extra close is sent to the host.

## Install

```sh
cargo install --path automation/crates/orca-ghost-tabs --root ~/.local --locked
mkdir -p ~/.orca/ghost-tabs
echo '{ "clients": ["my-laptop"], "node": "/opt/homebrew/bin/node" }' > ~/.orca/ghost-tabs/clients.json
~/.local/bin/orca-ghost-tabs run --dry-run   # prints what each client would close
~/.local/bin/orca-ghost-tabs install         # LaunchAgent local.orca-toolkit.ghost-tabs, every 15 s
```

`clients` are ssh aliases the host reaches without a password (`ssh -o BatchMode=yes <alias>`).
`node` is the Node binary on the clients (22 or newer, for the built-in `WebSocket`); it defaults to `node`.

## What it touches

- Host: reads Orca's trace and calls the `orca` CLI bundled in `/Applications/Orca.app`. Nothing is written to Orca.
- Client: when, and only when, it has queued tabs, the script sends `SIGUSR1` to Orca's main process to
  open the Node inspector on `127.0.0.1:9229`, evaluates the cleanup, and closes the inspector again.
  Review `src/client.mjs` before enabling it; it relies on Orca internals and can break with an update.

## Remove

```sh
launchctl bootout "gui/$(id -u)/local.orca-toolkit.ghost-tabs"
rm ~/Library/LaunchAgents/local.orca-toolkit.ghost-tabs.plist
```

Not affiliated with Orca or Stably. Delete this crate once the upstream issue is fixed.
