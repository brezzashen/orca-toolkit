# Toolkit for Orca plugin

The root `orca-plugin.json` declares the installable plugin. This directory contains only the
plugin's account launcher; the optional native toolkit remains in the other directories.

| File | Responsibility |
| --- | --- |
| `worker.ts` | Register commands and panel handlers; create terminals through Orca Host API 1. |
| `panel.tsx` | Render configured slots, open one, and edit all twelve. |
| `slots.ts` | Parse settings and choose the focused workspace without host calls. |
| `protocol.ts` | Type the panel/worker requests and change events. |
| `*.test.ts(x)` | Exercise parsing, workspace selection, rendering and host calls. |
| `panel.check.ts` | Empty and configured fixtures for `orca plugin check` and preview shots. |

The worker asks for workspace read/write, terminal send, agent read, own settings and
notifications. It does not read account credentials or launch any optional patcher. Commands are
user supplied and run in the workspace host's interactive shell. Configuration starts empty.

## Verify

1. `orca plugin types . --json` from the repository root.
2. `npm run typecheck:plugin` (downloads the pinned TypeScript outside the plugin directory).
3. `npm run test:plugin` and `npm run check:plugin`.
4. Load the plugin and verify import, terminal creation, settings persistence and errors in Orca.

The plugin test command targets only this directory. `npm test` separately runs the optional
toolkit tests with their required Node VM flag; `npm run test:title` runs the Bun title tests.
Do not put `node_modules` in a loaded development plugin: Orca refuses dependency symlinks
during worker integrity verification. The published plugin has no runtime npm dependencies.
