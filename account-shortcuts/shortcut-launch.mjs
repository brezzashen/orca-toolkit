// F-keys follow the desktop's visible workspace; account commands run on its execution host.
import { execFileSync } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runFKeyLaunch } from './shortcut-core.mjs';
import { createShortcutRuntime } from './shortcut-runtime.mjs';
import { createTerminalClaims, LOCKED_ARGUMENT, runWithProcessLock } from './shortcut-guard.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function accountCommand(config, requested) {
  const name = requested.toUpperCase();
  const id = config.aliases?.[name] ?? name;
  const account = config.accounts?.[id];
  if (!account) throw new Error(`Unknown account: ${requested}`);
  const alias = Object.entries(config.aliases ?? {}).find(([, value]) => value === id)?.[0]?.toLowerCase();
  if (!alias || !/^[a-z0-9]+$/.test(alias)) throw new Error(`Missing safe alias for account: ${id}`);
  // Sparse hosts can expose only one alias, such as co2, without the shared launcher.
  // Never substitute another account, switch directory, or inspect local credentials.
  const missing = `Orca account ${alias} is not installed on this execution host.`;
  const chat = account.viewMode === 'chat' ? ' --chat' : '';
  const command = `if command -v orca_account_tab >/dev/null 2>&1; then orca_account_tab ${quote(id)}${chat}; elif command -v ${quote(alias)} >/dev/null 2>&1; then ${alias}; else printf '%s\\n' ${quote(missing)} >&2; false; fi`;
  // This Mac's shell defines every account alias, so a local tab gets the alias alone.
  return { id, alias, command, localCommand: `${alias}${chat}` };
}

export function terminalChord(bindings) {
  const label = bindings.platforms?.darwin?.['tab.newTerminal']?.[0] ?? bindings.keybindings?.['tab.newTerminal']?.[0];
  if (!label) throw new Error('Bind tab.newTerminal in ~/.orca/keybindings.json.');
  const parts = label.split('+');
  const key = parts.pop().toUpperCase();
  const modifiers = { Shift: 0x20000, Ctrl: 0x40000, Alt: 0x80000, Option: 0x80000, Cmd: 0x100000, Mod: 0x100000 };
  const keys = { A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46 };
  if (!(key in keys) || parts.some((part) => !modifiers[part])) throw new Error(`Unsupported chord: ${label}`);
  return { label, keyCode: keys[key], flags: parts.reduce((flags, part) => flags | modifiers[part], 0) };
}

const PRESS = `ObjC.import('AppKit');
function run(argv) {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.isNil() || front.bundleIdentifier.js !== 'com.stablyai.orca') return 'not-frontmost';
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent($(), Number(argv[0]), down);
    $.CGEventSetFlags(event, Number(argv[1]));
    $.CGEventPost($.kCGHIDEventTap, event);
  }
}`;

async function main() {
  if (!process.argv.includes('--check') && !process.argv.includes(LOCKED_ARGUMENT)) {
    process.exitCode = await runWithProcessLock(process.execPath, [
      fileURLToPath(import.meta.url), ...process.argv.slice(2), LOCKED_ARGUMENT,
    ]);
    return;
  }
  setDefaultResultOrder('ipv4first');
  const home = homedir();
  const config = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
  const launch = accountCommand(config, process.argv[2] ?? '');
  const chord = terminalChord(JSON.parse(readFileSync(`${home}/.orca/keybindings.json`, 'utf8')));
  let paired = [];
  try {
    paired = JSON.parse(readFileSync(`${home}/Library/Application Support/orca/orca-environments.json`, 'utf8')).environments.map(({ id }) => id);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // --pressed-at: orca-fkey-tap pressed the chord and searches this Mac itself; only paired hosts remain.
  const pressedIndex = process.argv.indexOf('--pressed-at');
  const pressedAt = pressedIndex > 0 ? Number(process.argv[pressedIndex + 1]) : undefined;
  if (pressedAt !== undefined && !Number.isFinite(pressedAt)) throw new Error('--pressed-at needs epoch milliseconds');
  const environments = pressedAt === undefined ? [null, ...paired] : paired;
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ ...launch, chord, environments, mode: 'visible-workspace', localProfileRequired: false }));
    return;
  }
  const runtimes = environments.map((environment) => createShortcutRuntime(environment));
  try {
    const result = await runFKeyLaunch({
      runtimes, chord, pressedAt, command: launch.command, localCommand: launch.localCommand, claims: createTerminalClaims(),
      press: ({ keyCode, flags }) => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PRESS, String(keyCode), String(flags)], { encoding: 'utf8', timeout: 5_000 }).trim() !== 'not-frontmost',
      clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
      notify: (message) => execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title "Orca F-key"`], { timeout: 5_000 }),
    });
    if (result) console.error(`shortcut-timing ${JSON.stringify({ account: launch.id, ...result })}`);
  } finally {
    for (const runtime of runtimes) runtime.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } finally {
    if (process.argv.includes(LOCKED_ARGUMENT)) {
      const { reapIdleAutomatorRunners } = await import('./runner-reaper.ts');
      reapIdleAutomatorRunners();
    }
  }
}
