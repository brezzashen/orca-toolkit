// Install account launchers as macOS Services scoped to Orca.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const home = homedir();
const root = `${home}/.orca/account-shortcuts`;
const accounts = JSON.parse(readFileSync(`${root}/accounts.json`, 'utf8')).accounts;
const backups = `${root}/backups/${Date.now()}`;
mkdirSync(backups, { recursive: true });
const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function encode(value: any): string {
  if (Array.isArray(value)) return `<array>${value.map(encode).join('')}</array>`;
  if (value !== null && typeof value === 'object') return `<dict>${Object.entries(value).map(([k, v]) => `<key>${xmlEscape(k)}</key>${encode(v)}`).join('')}</dict>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  return `<string>${xmlEscape(String(value))}</string>`;
}
const plist = (value: any) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`;
const fromPlist = (path: string) => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));
const template = fromPlist(fileURLToPath(new URL('./service-template/document.wflow', import.meta.url)));
let prefs: any = {};
try {
  const original = execFileSync('/usr/bin/defaults', ['export', 'pbs', '-'], { encoding: 'utf8' });
  writeFileSync(`${backups}/pbs.plist`, original);
  prefs = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: original, encoding: 'utf8' }));
} catch (error: any) {
  if (!String(error.stderr).includes('does not exist')) throw error;
}
prefs.NSServicesStatus ??= {};
// One Service per key equivalent. An account may claim more than one through `extraShortcuts`,
// which installs a second, differently titled Service running the same launcher — macOS allows
// exactly one key_equivalent per Service, so a second key needs a second menu item.
const shortcuts = (Object.entries(accounts) as [string, any][])
  .filter(([, account]) => account.shortcutMode !== 'native')
  .flatMap(([id, account]) =>
  [{ title: account.title, key: account.key }, ...(account.extraShortcuts ?? [])]
    .map((shortcut: any) => ({ id, title: shortcut.title, key: shortcut.key })));
const appKeys: Record<string, string> = {};
for (const { id, title, key } of shortcuts) {
  const directory = `${home}/Library/Services/${title}.workflow/Contents`;
  mkdirSync(directory, { recursive: true });
  const workflow = structuredClone(template);
  workflow.actions[0].action.ActionParameters.COMMAND_STRING = existsSync(`${home}/.local/bin/orca-account-launch`)
    ? `${home}/.local/bin/orca-account-launch ${id} --from-shortcut`
    : `${process.execPath} '${root}/launch.ts' ${id}`;
  workflow.actions[0].action.UUID = randomUUID();
  workflow.workflowMetaData = {
    ...workflow.workflowMetaData,
    applicationBundleID: 'com.stablyai.orca',
    applicationBundleIDsByPath: { '/Applications/Orca.app': 'com.stablyai.orca' },
    applicationPath: '/Applications/Orca.app',
    applicationPaths: ['/Applications/Orca.app'],
    inputTypeIdentifier: 'com.apple.Automator.nothing',
    outputTypeIdentifier: 'com.apple.Automator.nothing',
    serviceApplicationBundleID: 'com.stablyai.orca',
    serviceApplicationPath: '/Applications/Orca.app',
    serviceInputTypeIdentifier: 'com.apple.Automator.nothing',
    serviceOutputTypeIdentifier: 'com.apple.Automator.nothing',
    processesInput: false,
    serviceProcessesInput: false,
  };
  writeFileSync(`${directory}/document.wflow`, plist(workflow));
  writeFileSync(`${directory}/Info.plist`, plist({ NSServices: [{
    NSMenuItem: { default: title },
    NSMessage: 'runWorkflowAsService',
    NSRequiredContext: { NSApplicationIdentifier: 'com.stablyai.orca' },
    NSIconName: 'NSActionTemplate',
    NSBackgroundColorName: 'background',
  }] }));
  execFileSync('/usr/bin/plutil', ['-lint', `${directory}/Info.plist`, `${directory}/document.wflow`]);
  prefs.NSServicesStatus[`(null) - ${title} - runWorkflowAsService`] = {
    enabled_context_menu: true,
    enabled_services_menu: true,
    key_equivalent: key,
    presentation_modes: { ContextMenu: true, ServicesMenu: true },
  };
  appKeys[title] = key;
}
execFileSync('/usr/bin/defaults', ['import', 'pbs', '-'], { input: plist(prefs) });
for (const [title, key] of Object.entries(appKeys)) {
  execFileSync('/usr/bin/defaults', ['write', 'com.stablyai.orca', 'NSUserKeyEquivalents', '-dict-add', title, key]);
}
const keyPath = `${home}/.orca/keybindings.json`;
if (!existsSync(keyPath)) writeFileSync(keyPath, "{}\n");
copyFileSync(keyPath, `${backups}/keybindings.json`);
const keybindings = JSON.parse(readFileSync(keyPath, 'utf8'));
// The keys this installer claims are stripped from Orca's own bindings, or Orca would swallow the
// chord before the Service ever sees it. Both sides are reduced to one signature first: the same
// chord is spelled `^@3` by macOS and `Cmd+Ctrl+3`, `Mod+T` or `Cmd+T` by Orca, in any modifier
// order, so matching on the literal string silently misses a binding and leaves the key dead.
const APPLE_MODIFIERS: Record<string, string> = { '@': 'Cmd', '^': 'Ctrl', '~': 'Alt', $: 'Shift' };
function signature(modifiers: Iterable<string>, code: string): string {
  return `${[...new Set(modifiers)].sort().join('+')}|${code.replace(/^(Key|Digit)/, '').toUpperCase()}`;
}
function fromAppleKey(key: string): string {
  let index = 0;
  const modifiers: string[] = [];
  for (; index < key.length && APPLE_MODIFIERS[key[index]]; index++) modifiers.push(APPLE_MODIFIERS[key[index]]);
  const code = key.slice(index);
  const point = code.codePointAt(0) ?? 0;
  const normalized = code.length === 1 && point >= 0xf704 && point <= 0xf726
    ? `F${point - 0xf704 + 1}`
    : code;
  return signature(modifiers, normalized);
}
function fromOrcaKey(key: string): string {
  const parts = key.split('+');
  const code = parts.pop() ?? '';
  // Orca writes the command key as `Mod` on darwin and as `Cmd` in the same file; they are one key.
  return signature(parts.map(part => (part === 'Mod' ? 'Cmd' : part)), code);
}
const owned = new Set(shortcuts.map(shortcut => fromAppleKey(shortcut.key)));
for (const section of [keybindings.keybindings, keybindings.platforms?.darwin]) {
  for (const [action, keys] of Object.entries(section || {}) as [string, string[]][]) {
    section[action] = keys.filter(key => !owned.has(fromOrcaKey(key)));
  }
}
writeFileSync(`${keyPath}.account-shortcuts-tmp`, JSON.stringify(keybindings, null, 2) + '\n');
const { renameSync } = await import('node:fs');
renameSync(`${keyPath}.account-shortcuts-tmp`, keyPath);
execFileSync('/System/Library/CoreServices/pbs', ['-flush']);
execFileSync('/System/Library/CoreServices/pbs', ['-update'], { timeout: 30_000 });
console.log(JSON.stringify({ installed: Object.keys(accounts), backups, shortcuts: appKeys, stripped: [...owned] }));
console.error('Quit and reopen Orca to load new or renamed Service key equivalents.');
