// Read Orca account settings; aliases reuse their terminal and Services open a tab with Orca's
// own New Terminal binding. Codex always uses an embedded server so hooks retain this terminal's
// Orca identity.
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { reapIdleAutomatorRunners } from './runner-reaper.ts';

// Prefer IPv4 so .local mDNS paired runtimes do not stall 500 ms per RPC on unscoped fe80:: IPv6 timeouts.
setDefaultResultOrder('ipv4first');
const require = createRequire(import.meta.url);
const { RuntimeClient } = require('/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js');
const config = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
// Shell aliases (CO1, CO2, ...) resolve to account ids through accounts.json.
const requested = (process.argv[2] || '').toUpperCase();
const resolved = config.aliases?.[requested] || requested;
const account = config.accounts[resolved];
if (!account) {
  const names = [...Object.keys(config.accounts), ...Object.keys(config.aliases || {})].join(', ');
  throw new Error(`Unknown account "${process.argv[2] || ''}". Choose one of: ${names}.`);
}
const handle = process.env.ORCA_TERMINAL_HANDLE;
const currentChat = process.argv.includes('--chat');
if (currentChat && (process.argv.includes('--new-tab') || !handle)) {
  throw new Error('--chat requires the current Orca terminal and cannot be combined with --new-tab.');
}
const reuseTerminal = Boolean(handle) && !process.argv.includes('--new-tab');
const client = handle ? new RuntimeClient(undefined, 30_000) : null;

function buildAgentCommand(args: string): string {
  // The child interactive shell does not inherit Orca's codex shell function.
  // A shared daemon keeps the first pane's hook environment and mixes Chat UI sessions.
  const isolation = account.agent === 'codex' ? ' --no-daemon' : '';
  // `command` names a wrapper binary (ag1 for Antigravity) when it differs from Orca's agent id.
  return `${account.switchCommand} && ${account.command ?? account.agent}${isolation}${args ? ` ${args}` : ''}`;
}

// Services have no terminal identity, and Orca's persisted focus can name a workspace the user has
// already left: F1 pressed on a remote workspace opened its tab in a local repository. Tabs
// that a runtime RPC created on the remote Mac also never reached the client's tab list. Orca's own New
// Terminal binding avoids both: the desktop renderer opens the tab in the workspace on screen, and
// every paired desktop shows it. The account then starts in that terminal like a typed alias.
async function launchFromService(check: boolean) {
  const runtimes = [null, ...pairedEnvironments()].map((environment) => ({
    environment,
    client: new RuntimeClient(undefined, environment ? 1_500 : 30_000, null, environment),
  }));
  const chord = newTerminalChord();
  const command = `orca_account_tab ${resolved}${account.viewMode === 'chat' ? ' --chat' : ''}`;
  if (check) {
    console.log(JSON.stringify({ id: resolved, account, launchMode: 'service', chord, command, environments: runtimes.map(({ environment }) => environment) }));
    return;
  }
  // A runtime that cannot list before the keypress is left out, or all of its terminals would look new.
  // Start all snapshots up front, but only block the keypress on the 5 ms local socket so remote
  // WebSocket handshakes overlap with osascript instead of delaying local tab creation by 150-1500 ms.
  const before = new Map<string | null, Set<string>>();
  const snapshots = runtimes.map(async (runtime) => {
    const handles = await terminalHandles(runtime.client);
    if (handles) before.set(runtime.environment, new Set(handles.map(({ handle }) => handle)));
  });
  await snapshots[0];
  if (!pressInOrca(chord)) {
    await Promise.all(snapshots);
    return;
  }
  const deadline = Date.now() + 10_000;
  let settled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  // Poll each runtime independently so a 5 ms local socket never blocks on a slower remote runtime.
  const winner = await new Promise<{ runtime: (typeof runtimes)[number]; handle: string } | null>((resolve) => {
    let pending = runtimes.length;
    if (!pending) {
      resolve(null);
      return;
    }
    for (const [index, runtime] of runtimes.entries()) {
      const intervalMs = runtime.environment ? 80 : 15;
      (async () => {
        await snapshots[index];
        const known = before.get(runtime.environment);
        if (!known) {
          if (--pending === 0 && !settled) {
            clearTimers();
            resolve(null);
          }
          return;
        }
        while (!settled && Date.now() < deadline) {
          await new Promise<void>((r) => {
            const timer = setTimeout(() => {
              timers.delete(timer);
              r();
            }, intervalMs);
            timers.add(timer);
          });
          if (settled) return;
          const handles = await terminalHandles(runtime.client);
          const created = handles?.find(({ handle, writable }) => writable && !known.has(handle));
          if (created && !settled) {
            settled = true;
            clearTimers();
            resolve({ runtime, handle: created.handle });
            return;
          }
        }
        if (--pending === 0 && !settled) {
          clearTimers();
          resolve(null);
        }
      })();
    }
  });
  if (!winner) {
    throw new Error(`Orca opened no terminal within 10 s of ${chord.label}; is Orca frontmost with a workspace selected?`);
  }
  await winner.runtime.client.call('terminal.send', { terminal: winner.handle, text: command, enter: true });
}

function pairedEnvironments(): string[] {
  try {
    const file = `${homedir()}/Library/Application Support/orca/orca-environments.json`;
    return JSON.parse(readFileSync(file, 'utf8')).environments.map((environment: { id: string }) => environment.id);
  } catch {
    return [];
  }
}

async function terminalHandles(runtime: any): Promise<{ handle: string; writable: boolean }[] | null> {
  try {
    return (await runtime.call('terminal.list', { includeVisualLayouts: false })).result.terminals;
  } catch {
    return null;
  }
}

// Read the chord from Orca's keybindings so a rebinding there keeps the Service working.
function newTerminalChord(): { label: string; keyCode: number; flags: number } {
  const bindings = JSON.parse(readFileSync(`${homedir()}/.orca/keybindings.json`, 'utf8'));
  const label: string | undefined = bindings.platforms?.darwin?.['tab.newTerminal']?.[0] ?? bindings.keybindings?.['tab.newTerminal']?.[0];
  if (!label) throw new Error('Bind tab.newTerminal in ~/.orca/keybindings.json; account Services press it.');
  const parts = label.split('+');
  const key = parts.pop()!.toUpperCase();
  // CGEventFlags masks: Shift, Control, Option, Command.
  const MODIFIERS: Record<string, number> = { Shift: 0x20000, Ctrl: 0x40000, Alt: 0x80000, Option: 0x80000, Cmd: 0x100000, Mod: 0x100000 };
  // ANSI virtual key codes. Pressing a key code, not a character, keeps a CJK input source out of the chord.
  const KEY_CODES: Record<string, number> = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46 };
  if (!(key in KEY_CODES) || parts.some((part) => !MODIFIERS[part])) {
    throw new Error(`Unsupported tab.newTerminal binding for account Services: ${label}`);
  }
  return { label, keyCode: KEY_CODES[key], flags: parts.reduce((flags, part) => flags | MODIFIERS[part], 0) };
}

// The Service only runs inside Orca, but a slow press could land in another app; skip it cleanly
// without raising an Automator modal error dialog if focus left Orca before the press.
// AppKit and CoreGraphics answer directly. System Events serialises Apple events: on a busy Mac under
// load a single frontmost query took 85-89 s while earlier timed-out queries were still queued.
const PRESS_IN_ORCA = `ObjC.import('AppKit');
function run(argv) {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.isNil() || front.bundleIdentifier.js !== 'com.stablyai.orca') return 'not-frontmost';
  const keyCode = Number(argv[0]), flags = Number(argv[1]);
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent($(), keyCode, down);
    $.CGEventSetFlags(event, flags);
    $.CGEventPost($.kCGHIDEventTap, event);
  }
}`;

function pressInOrca(chord: { keyCode: number; flags: number }): boolean {
  const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PRESS_IN_ORCA, String(chord.keyCode), String(chord.flags)], { encoding: 'utf8', timeout: 5_000 });
  return String(out ?? '').trim() !== 'not-frontmost';
}

async function targetWorktree(): Promise<string> {
  const worktreeId = (await client.call('terminal.show', { terminal: handle })).result.terminal.worktreeId;
  const { worktree } = (await client.call('worktree.show', { worktree: `id:${worktreeId}` })).result;
  if (worktree.hostId !== 'local') {
    throw new Error('Account shortcuts require a local workspace on the selected Orca runtime.');
  }
  return worktreeId;
}

if (!handle) {
  const check = process.argv.includes('--check');
  try {
    await launchFromService(check);
  } finally {
    if (!check) reapIdleAutomatorRunners();
  }
} else if (process.argv.includes('--check')) {
  const response = await client.call('settings.get');
  const settings = response.result.settings;
  // Also report the workspace a launch would join, so targeting can be checked without opening a tab.
  console.log(JSON.stringify({
    id: resolved,
    account,
    chatEnabled: settings.experimentalNativeChat,
    terminalHandle: handle,
    launchMode: reuseTerminal ? 'current-terminal' : 'new-tab',
    viewMode: currentChat ? 'chat' : undefined,
    activeWorktree: await targetWorktree(),
    environment: process.env.ORCA_ENVIRONMENT ?? null,
  }));
} else if (reuseTerminal) {
  const [settingsResponse, terminalResponse] = await Promise.all([
    client.call('settings.get'),
    currentChat ? client.call('terminal.show', { terminal: handle }) : null,
  ]);
  const settings = settingsResponse.result.settings;
  if (currentChat) {
    if (!settings.experimentalNativeChat) {
      throw new Error('Enable Orca Settings > Experimental > Chat UI first.');
    }
    const terminal = terminalResponse.result.terminal;
    // Change only the caller's view; never activate, create, or close a tab.
    // While a desktop window owns the layout Orca refuses view edits (capability_unsupported,
    // 2026-10-24); the account still starts, in the terminal view.
    await client.call('session.tabs.setTabProps', {
      worktree: `id:${terminal.worktreeId}`,
      tabId: terminal.tabId,
      viewMode: 'chat',
    }).catch((error: { code?: string }) => {
      if (error?.code !== 'capability_unsupported') throw error;
    });
  }
  const args = settings.agentDefaultArgs?.[account.agent] || '';
  // Keep the existing PTY and UI focus. The interactive shell loads cxp/ccp from .zshrc.
  // Never focus or close a tab from this path: closing the caller can select another tab.
  const result = spawnSync(process.env.SHELL || '/bin/zsh', ['-ic', buildAgentCommand(args)], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const [worktreeId, settingsResponse] = await Promise.all([
    targetWorktree(),
    client.call('settings.get'),
  ]);
  const settings = settingsResponse.result.settings;
  if (account.viewMode === 'chat' && !settings.experimentalNativeChat) {
    throw new Error('Enable Orca Settings > Experimental > Chat UI first.');
  }
  const args = settings.agentDefaultArgs?.[account.agent] || '';
  const command = buildAgentCommand(args);
  const response = await client.call('session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command,
    launchAgent: account.agent,
    startupCommandDelivery: 'shell-ready',
    // Keep a terminal-backed tab; its Chat UI becomes visible on the single focus below.
    viewMode: account.viewMode,
    // Activate and select the new tab immediately so the renderer mounts it visibly
    // (display: "flex") and spawns its PTY on T1 within waitForMobileTerminalSurface's
    // 1000ms window. Passing activate: false leaves T1 hidden with placeholder leafId
    // "pane:1", causing runCreateMobileSessionTerminal to fall back to
    // createRuntimeOwnedMobileSessionTerminal, which discards T1 (because "pane:1" is
    // not a UUID) and mints a second tab T2 while leaving T1 behind as an unopenable
    // pendingActivationSpawn phantom tab.
    activate: true,
    select: true,
    // 'all' also selects the tab in every paired client UI. With 'host' only the runtime's
    // own window moved: a desktop driving a remote runtime (client Mac -> remote Mac) kept its previous
    // tab selected, so the new tab looked switched away (2026-10-14).
    navigation: 'all',
    clientMutationId: randomUUID(),
  });
  // Deliberately no terminal.rename here. A rename sets the tab's customTitle, which
  // sits ABOVE generatedTitle in Orca's title resolution
  // (customTitle || generatedTitle || title || defaultTitle), so pinning the account
  // name permanently suppresses the auto-synced conversation title. The agent icon
  // already distinguishes claude from codex; run unpin-titles.ts to release a tab that
  // an older launcher pinned.
  // Stay silent on success: a typed alias (CO1, CL2, ...) runs in the user's terminal, and
  // the raw RPC result would land there. Pass --verbose to print it for debugging.
  if (process.argv.includes('--verbose')) console.log(JSON.stringify(response.result));
  // Keep terminal.focus as an idempotent fallback in case the renderer fell back to a
  // runtime-owned PTY when the window was occluded.
  const created = response.result?.tab?.terminal;
  if (!created) throw new Error('Orca did not return the created terminal handle.');
  await client.call('terminal.focus', { terminal: created, navigation: 'host' });
  // Explicit --new-tab launches keep the caller alive so closing it cannot move UI focus.
}
