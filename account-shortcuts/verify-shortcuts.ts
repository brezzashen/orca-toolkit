// Verify that every account Service key in accounts.json is wired end to end on this Mac:
// workflow, pbs key equivalent, Orca's NSUserKeyEquivalents, no stale Orca Service holding a key,
// no Orca keybinding swallowing an account key, and tab.newTerminal free for the Service to press.
// `--live` also reads the key each Services menu item carries in the running Orca.
// Usage: node verify-shortcuts.ts [--live]   (exit 1 on any failure)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const home = homedir();
const config = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
const failures: string[] = [];
const rows: string[][] = [];

const plistJson = (args: string[], input?: string) =>
  JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', ...args], { encoding: 'utf8', input }));
// Extract one key: a whole domain can hold data values that plutil cannot express as JSON.
const exportKey = (domain: string, key: string) => {
  try {
    const plist = execFileSync('/usr/bin/defaults', ['export', domain, '-'], { encoding: 'utf8' });
    return JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', key, 'json', '-o', '-', '-'], { encoding: 'utf8', input: plist }));
  } catch {
    return {};
  }
};

// macOS spells a chord `^~1` or U+F704 (F1); Orca spells it `Ctrl+Alt+1` or `F1`. Reduce both to
// one signature, as install.ts does, so a differently spelled conflict is still found.
const APPLE_MODIFIERS: Record<string, string> = { '@': 'Cmd', '^': 'Ctrl', '~': 'Alt', $: 'Shift' };
const signature = (modifiers: string[], code: string) =>
  `${[...new Set(modifiers)].sort().join('+')}|${code.replace(/^(Key|Digit)/, '').toUpperCase()}`;
function fromAppleKey(key: string): string {
  let index = 0;
  const modifiers: string[] = [];
  for (; index < key.length && APPLE_MODIFIERS[key[index]]; index++) modifiers.push(APPLE_MODIFIERS[key[index]]);
  const code = key.slice(index);
  const point = code.codePointAt(0) ?? 0;
  return signature(modifiers, code.length === 1 && point >= 0xf704 && point <= 0xf726 ? `F${point - 0xf704 + 1}` : code);
}
function fromOrcaKey(key: string): string {
  const parts = key.split('+');
  const code = parts.pop() ?? '';
  return signature(parts.map((part) => (part === 'Mod' ? 'Cmd' : part === 'Option' ? 'Alt' : part)), code);
}
const label = (key: string) => fromAppleKey(key).replace('|', ' ').replace(/^ /, '');

const shortcuts = (Object.entries(config.accounts) as [string, any][])
  .filter(([, account]) => account.shortcutMode !== 'native')
  .flatMap(([id, account]) => [{ title: account.title, key: account.key }, ...(account.extraShortcuts ?? [])]
    .map((shortcut: any) => ({ id, title: shortcut.title as string, key: shortcut.key as string })));

const pbs = exportKey('pbs', 'NSServicesStatus');
const userKeys = exportKey('com.stablyai.orca', 'NSUserKeyEquivalents');
const seen = new Map<string, string>();
for (const { id, title, key } of shortcuts) {
  const problems: string[] = [];
  if (!key) problems.push('no key in accounts.json');
  const owner = seen.get(fromAppleKey(key));
  if (owner) problems.push(`key also used by ${owner}`);
  seen.set(fromAppleKey(key), title);
  const contents = `${home}/Library/Services/${title}.workflow/Contents`;
  if (!existsSync(`${contents}/document.wflow`)) {
    problems.push('workflow missing');
  } else {
    const command: string = plistJson([`${contents}/document.wflow`]).actions[0].action.ActionParameters.COMMAND_STRING;
    const launcher = existsSync(`${home}/.local/bin/orca-account-launch`)
      ? new RegExp(`orca-account-launch ${id} --from-shortcut$`)
      : new RegExp(`launch\\.ts' ${id}(\\s|$)`);
    if (!launcher.test(command)) problems.push(`workflow runs "${command}"`);
    const service = plistJson([`${contents}/Info.plist`]).NSServices?.[0];
    if (service?.NSMenuItem?.default !== title) problems.push('Info.plist menu title differs');
    if (service?.NSRequiredContext?.NSApplicationIdentifier !== 'com.stablyai.orca') problems.push('not scoped to Orca');
  }
  const status = pbs[`(null) - ${title} - runWorkflowAsService`];
  if (status?.key_equivalent !== key) problems.push(`pbs key ${status ? JSON.stringify(status.key_equivalent) : 'missing'}`);
  if (status && status.enabled_services_menu === false) problems.push('disabled in Services menu');
  if (userKeys[title] !== key) problems.push(`NSUserKeyEquivalents ${userKeys[title] === undefined ? 'missing' : JSON.stringify(userKeys[title])}`);
  rows.push([label(key), id, title, problems.length ? problems.join('; ') : 'ok']);
  for (const problem of problems) failures.push(`${title}: ${problem}`);
}

// A leftover Orca Service with a key steals that chord from the current one.
const titles = new Set(shortcuts.map(({ title }) => title));
for (const [title, key] of Object.entries(userKeys) as [string, string][]) {
  if (title.startsWith('Orca ') && !titles.has(title) && key) failures.push(`stale NSUserKeyEquivalents "${title}" = ${label(key)}`);
}
for (const [name, status] of Object.entries(pbs) as [string, any][]) {
  const title = name.match(/^\(null\) - (Orca .+) - runWorkflowAsService$/)?.[1];
  if (title && !titles.has(title) && status.key_equivalent) failures.push(`stale pbs Service "${title}" = ${label(status.key_equivalent)}`);
}
for (const name of readdirSync(`${home}/Library/Services`)) {
  const title = name.replace(/\.workflow$/, '');
  if (name.startsWith('Orca ') && !titles.has(title) && userKeys[title]) failures.push(`stale workflow "${name}" still has a key`);
}

// Orca must not bind an account key itself, and its New Terminal chord must stay usable.
const keybindings = JSON.parse(readFileSync(`${home}/.orca/keybindings.json`, 'utf8'));
const owned = new Map(shortcuts.map(({ key, title }) => [fromAppleKey(key), title]));
for (const section of [keybindings.keybindings, keybindings.platforms?.darwin]) {
  for (const [action, keys] of Object.entries(section ?? {}) as [string, string[]][]) {
    for (const key of keys) {
      const title = owned.get(fromOrcaKey(key));
      if (title) failures.push(`Orca binds ${key} to ${action}, which swallows "${title}"`);
    }
  }
}
const newTerminal: string | undefined = keybindings.platforms?.darwin?.['tab.newTerminal']?.[0] ?? keybindings.keybindings?.['tab.newTerminal']?.[0];
if (!newTerminal) failures.push('tab.newTerminal has no binding; Services press it to open the tab');
else if (owned.has(fromOrcaKey(newTerminal))) failures.push(`tab.newTerminal ${newTerminal} is also an account key`);
const functionKeys = shortcuts.some(({ key }) => /^[-]$/.test(key.replace(/^[@^~$]+/, '')));
let fnState: string | null = null;
try {
  fnState = execFileSync('/usr/bin/defaults', ['read', '-g', 'com.apple.keyboard.fnState'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {}
if (functionKeys && fnState !== '1') failures.push('F keys are bound but "Use F1, F2, etc. keys as standard function keys" is off');

// The running Orca reads NSUserKeyEquivalents at launch only; the menu shows what it loaded.
if (process.argv.includes('--live')) {
  const script = 'tell application "System Events" to tell process "Orca" to get {name, value of attribute "AXMenuItemCmdChar"} of menu items of menu 1 of menu item "Services" of menu 1 of menu bar item 2 of menu bar 1';
  let menu: [string[], (string | null)[]] | null = null;
  try {
    menu = JSON.parse(execFileSync('/usr/bin/osascript', ['-s', 's', '-e', script], { encoding: 'utf8', timeout: 120_000 })
      .replace(/missing value/g, 'null').replace(/^\{/, '[').replace(/\}$/, ']').replace(/\{/g, '[').replace(/\}/g, ']'));
  } catch (error: any) {
    // An ssh session without Accessibility waits on the consent prompt; say so instead of guessing.
    failures.push(`live check unavailable (${error.code ?? error.message}); run --live from a terminal with Accessibility`);
  }
  const [names, chars] = menu ?? [[], []];
  for (const { title, key } of menu ? shortcuts : []) {
    const index = names.indexOf(title);
    const expected = key.replace(/^[@^~$]+/, '').toUpperCase();
    const actual = index < 0 ? undefined : chars[index];
    if (actual === undefined) failures.push(`Orca's Services menu has no "${title}"; quit and reopen Orca`);
    else if ((actual ?? '').toUpperCase() !== expected) failures.push(`Orca's menu gives "${title}" ${actual === null ? 'no key' : JSON.stringify(actual)}; quit and reopen Orca to load ${label(key)}`);
  }
}

const width = rows.reduce((widths, row) => row.map((cell, i) => Math.max(widths[i] ?? 0, cell.length)), [] as number[]);
for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(width[i])).join('  '));
console.log(`tab.newTerminal: ${newTerminal ?? 'unbound'}${functionKeys ? `, fnState: ${fnState}` : ''}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${shortcuts.length} account shortcuts verified${process.argv.includes('--live') ? ' against the running Orca' : ''}.`);
}
