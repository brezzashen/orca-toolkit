// Installs orca-toolkit into the current user's home. Run with Node 22.18+ (or Bun) from the repository root:
//   node scripts/install.ts [--rust] [--fkey-tap] [--services] [--statusline] [--dry-run]
// Without flags it only copies the account shortcuts and links ~/.local/bin/node. Nothing is
// overwritten without a backup, and an existing ~/.orca/account-shortcuts/accounts.json is kept.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({ options: {
  rust: { type: 'boolean' }, 'fkey-tap': { type: 'boolean' }, services: { type: 'boolean' },
  statusline: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
if (process.platform !== 'darwin') throw new Error('orca-toolkit supports macOS only.');
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = homedir();
const dry = flags['dry-run'] === true;
const step = (text: string, action: () => void) => { console.log(`${dry ? '[dry-run] ' : ''}${text}`); if (!dry) action(); };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = (path: string) => { if (existsSync(path)) renameSync(path, `${path}.bak-${stamp}`); };

// 1. Account shortcuts: the launchers read ~/.orca/account-shortcuts/accounts.json.
const shortcuts = join(home, '.orca/account-shortcuts');
const keptAccounts = join(shortcuts, 'accounts.json');
const previous = existsSync(keptAccounts) ? readFileSync(keptAccounts, 'utf8') : null;
step(`copy account-shortcuts -> ${shortcuts}`, () => {
  mkdirSync(shortcuts, { recursive: true });
  cpSync(join(repo, 'account-shortcuts'), shortcuts, { recursive: true });
  if (previous !== null) writeFileSync(keptAccounts, previous);
});

// 2. The Rust launchers start ~/.local/bin/node; point it at this Node when it is missing.
const nodeLink = join(home, '.local/bin/node');
let hasNode = false;
try { lstatSync(nodeLink); hasNode = true; } catch {}
// An older install may point at a versioned Homebrew Cellar folder; repoint that one only.
let nodeTarget = '';
try { nodeTarget = readlinkSync(nodeLink, { encoding: 'utf8' }); } catch {}
if (/\/Cellar\//.test(nodeTarget)) {
  step(`unlink stale ${nodeLink} -> ${nodeTarget}`, () => unlinkSync(nodeLink));
  hasNode = false;
}
// Prefer a stable PATH entry (Homebrew's /opt/homebrew/bin/node) over process.execPath, which
// resolves into a versioned Cellar folder that the next `brew upgrade` deletes.
const stableNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? process.execPath;
if (!hasNode) step(`link ${nodeLink} -> ${stableNode}`, () => {
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(stableNode, nodeLink);
});
// The Orca CLI ships inside the app; link it so `orca` works in any shell.
const orcaCli = '/Applications/Orca.app/Contents/Resources/bin/orca';
const orcaLink = join(home, '.local/bin/orca');
let hasOrca = false;
try { lstatSync(orcaLink); hasOrca = true; } catch {}
if (!hasOrca && existsSync(orcaCli)) step(`link ${orcaLink} -> ${orcaCli}`, () => {
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(orcaCli, orcaLink);
});

// 3. Rust programs into ~/.local/bin.
if (flags.rust || flags['fkey-tap']) {
  for (const crate of ['orca-account-launch', 'orca-fkey-tap', 'resume-home', 'session-title']) {
    step(`cargo install ${crate} -> ${home}/.local/bin`, () => execFileSync('cargo',
      ['install', '--path', join(repo, 'automation/crates', crate), '--root', join(home, '.local'), '--locked', '--force'],
      { stdio: 'inherit' }));
  }
}

// 4. F-key event tap as a launchd agent; grant Accessibility to OrcaFkeyTap when macOS asks.
if (flags['fkey-tap']) {
  const label = 'local.orca-toolkit.fkey-tap';
  const plist = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const domain = `gui/${process.getuid!()}`;
  step(`write ${plist} and load it`, () => {
    const text = readFileSync(join(repo, 'launchd', `${label}.plist`), 'utf8').replaceAll('__HOME__', home);
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch {}
    backup(plist);
    writeFileSync(plist, text);
    execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
  });
}

// 5. macOS Services scoped to Orca (one per account key) and Orca keybinding cleanup.
if (flags.services) step('install macOS Services from accounts.json', () =>
  execFileSync(process.execPath, [join(shortcuts, 'install.ts')], { stdio: 'inherit' }));

// 6. Claude Code status line scripts.
if (flags.statusline) {
  for (const name of ['statusline-command.sh', 'statusline-orca-combined.sh']) {
    const target = join(home, '.claude', name);
    step(`link ${target}`, () => { backup(target); symlinkSync(join(repo, 'statusline/claude', name), target); });
  }
  console.log('Then set "statusLine": {"type": "command", "command": "~/.claude/statusline-orca-combined.sh"} in ~/.claude/settings.json.');
}

console.log(`Add to ~/.zshrc:  source "${join(repo, 'shell/orca.zsh')}"`);
