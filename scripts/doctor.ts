// Read-only setup check for orca-toolkit. Run with Node 22.18+ (or Bun) from the repository root:
//   node scripts/doctor.ts [--role host|client|both]
// host   = the Mac whose Orca runs the agents (profiles, CLIs, shell functions live here).
// client = a Mac whose Orca desktop app shows the host's workspaces (paste images, press F-keys).
// Prints one line per check with a fix for each failure, and exits 1 when any check fails.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { role: { type: 'string', default: 'both' } } });
const role = String(values.role);
if (!['host', 'client', 'both'].includes(role)) throw new Error('--role must be host, client or both');
const host = role !== 'client';
const client = role !== 'host';
const home = homedir();
let failed = 0;

const run = (cmd: string, args: string[]) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }); }
  catch { return null; }
};
const check = (ok: boolean, label: string, fix: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     fix: ${fix}`}`);
  if (!ok) failed += 1;
};
const note = (label: string) => console.log(`info ${label}`);
const uid = String(process.getuid?.() ?? '');
const launchdLoaded = (label: string) => run('/bin/launchctl', ['print', `gui/${uid}/${label}`]) !== null;
const tail = (path: string, lines = 200) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').slice(-lines) : [];

console.log(`orca-toolkit doctor (role: ${role})`);

// 1. Platform and Orca.
check(process.platform === 'darwin', 'macOS', 'orca-toolkit supports macOS only.');
const [major, minor] = process.versions.node.split('.').map(Number);
check(major > 22 || (major === 22 && minor >= 18), `Node ${process.versions.node} (22.18+ runs .ts files)`, 'Install Node 22.18 or newer.');
const orcaVersion = run('/usr/bin/defaults', ['read', '/Applications/Orca.app/Contents/Info.plist', 'CFBundleShortVersionString'])?.trim();
check(Boolean(orcaVersion), `Orca.app ${orcaVersion ?? 'missing'}`, 'Install Orca from https://orca.dev into /Applications.');
check(existsSync(join(home, '.local/bin/node')), '~/.local/bin/node (the launchers start it)', 'node scripts/install.ts');

// 2. Accounts and the F-key map.
const accountsPath = join(home, '.orca/account-shortcuts/accounts.json');
let accounts: Record<string, any> = {};
try { accounts = JSON.parse(readFileSync(accountsPath, 'utf8')).accounts ?? {}; } catch {}
check(Object.keys(accounts).length > 0, `${accountsPath} with ${Object.keys(accounts).length} account(s)`,
  'node scripts/install.ts, then edit that file (account-shortcuts/README.md).');
const fkey = (key: unknown) => {
  const code = typeof key === 'string' && key.length === 1 ? key.charCodeAt(0) - 0xf704 : -1;
  return code >= 0 && code < 12 ? `F${code + 1}` : null;
};
const mapped: string[] = [];
for (const [id, account] of Object.entries(accounts)) {
  const keys = [account.key, ...(account.extraShortcuts ?? []).map((s: any) => s.key)].map(fkey).filter(Boolean);
  for (const key of keys) mapped.push(`${key}=${id}`);
}
note(`F-key map: ${mapped.sort((a, b) => Number(a.slice(1).split('=')[0]) - Number(b.slice(1).split('=')[0])).join('  ') || 'none'}`);

// 3. Host: every account's CLI and profile exist here.
if (host) {
  for (const [id, account] of Object.entries(accounts)) {
    const command = String(account.command ?? (account.agent === 'antigravity' ? 'agy' : account.agent));
    const onPath = run('/bin/zsh', ['-lc', `command -v ${command}`]) !== null;
    check(onPath, `${id}: ${command} on PATH`, `Install the ${account.agent} CLI, or delete ${id} from accounts.json.`);
    const switchCommand = String(account.switchCommand ?? '');
    const match = /^(ccp|cxp) (\S+)$/.exec(switchCommand);
    if (match && match[2] !== 'default') {
      const dir = join(home, match[1] === 'ccp' ? '.claude-profiles' : '.codex-profiles', match[2]);
      check(existsSync(dir), `${id}: profile ${dir}`,
        match[1] === 'ccp' ? `CLAUDE_CONFIG_DIR=${dir} claude  (then /login)` : `CODEX_HOME=${dir} codex login`);
    }
  }
  const zshrc = existsSync(join(home, '.zshrc')) ? readFileSync(join(home, '.zshrc'), 'utf8') : '';
  check(/source .*shell\/orca\.zsh/.test(zshrc), '~/.zshrc sources shell/orca.zsh (aliases, ccp/cxp, reopen)',
    "echo 'source ~/orca-toolkit/shell/orca.zsh' >> ~/.zshrc");
}

// 4. F-keys on this Mac: binaries, the event tap and standard function keys.
for (const bin of ['orca-account-launch', 'orca-fkey-tap', 'resume-home']) {
  check(existsSync(join(home, '.local/bin', bin)), `~/.local/bin/${bin}`, 'node scripts/install.ts --rust --fkey-tap');
}
check(launchdLoaded('local.orca-toolkit.fkey-tap'), 'launchd job local.orca-toolkit.fkey-tap loaded', 'node scripts/install.ts --fkey-tap');
// The tap's own log is the truth: a `check` run from a shell can report trust the job does not have.
const tapLog = tail(join(home, 'Library/Logs/orca-fkey-tap.log')).filter((l) => /event tap (active|refused)/.test(l));
check(/event tap active/.test(tapLog.at(-1) ?? ''), `event tap: ${tapLog.at(-1)?.trim() ?? 'no log yet'}`,
  'System Settings > Privacy & Security > Accessibility: turn on OrcaFkeyTap (remove and re-add it after a rebuild).');
const fnState = run('/usr/bin/defaults', ['read', '-g', 'com.apple.keyboard.fnState'])?.trim();
check(fnState === '1', 'F1-F12 act as standard function keys',
  'System Settings > Keyboard > Keyboard Shortcuts > Function Keys: turn on "Use F1, F2, etc. keys as standard function keys".');

// 5. Remote image bridge (needed on the host for browser/phone clients, on each client desktop for paste).
check(existsSync(join(home, '.orca/agent-hooks/antigravity-chat-sync.mjs')), '~/.orca/agent-hooks bridge installed',
  'cp -R agent-hooks/. ~/.orca/agent-hooks/ && node ~/.orca/agent-hooks/antigravity-chat-sync.mjs --bootstrap');
check(launchdLoaded('local.orca-toolkit.antigravity-patch'), 'launchd job local.orca-toolkit.antigravity-patch loaded',
  'node ~/.orca/agent-hooks/antigravity-chat-sync.mjs --bootstrap');
const imageLog = tail(join(home, 'Library/Logs/orca-remote-chat-image.log'), 400);
const lastUpload = imageLog.filter((l) => /renderer-upload-saved|main-save |renderer-upload-failed|main-save-failed/.test(l)).at(-1);
note(`last remote image upload: ${lastUpload ? lastUpload.slice(0, 160) : 'none yet (paste one image to test)'}`);

// 6. Pairing.
if (client) {
  const envs = run('orca', ['environment', 'list', '--json']);
  let names: string[] = [];
  try { names = (JSON.parse(envs ?? '{}').result?.environments ?? []).map((e: any) => e.name); } catch {}
  check(names.length > 0, `paired hosts: ${names.join(', ') || 'none'}`,
    'Host: Settings > Remote Orca Servers > New Link > Generate Access Link. Client: Settings > Remote Orca Servers > Add Server, paste it.');
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
