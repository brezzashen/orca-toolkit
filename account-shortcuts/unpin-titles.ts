// Release tabs whose title an older account launcher pinned.
//
// `terminal.rename` writes the tab's customTitle, and Orca resolves a tab label as
// customTitle || generatedTitle || title || defaultTitle || `Terminal N`. A pinned
// customTitle therefore outranks — and permanently hides — the auto-synced
// conversation title. Renaming to an empty string clears it (the runtime handler
// stores `title || null`), after which the normal title pipeline takes over again.
//
// Usage:
//   node --experimental-strip-types ~/.orca/account-shortcuts/unpin-titles.ts [--check]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { RuntimeClient } = require('/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js');

const dryRun = process.argv.includes('--check');
const config = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
const pinned = new Set<string>(Object.values(config.accounts).map((a: any) => a.title));
const client = new RuntimeClient(undefined, 30_000, null, null);

// listAll covers every worktree, so a tab pinned in another window is caught too.
const response = await client.call('session.tabs.listAll', {});
const snapshots: any[] = (response.result as any).snapshots ?? [];

let cleared = 0;
for (const snapshot of snapshots) {
  for (const tab of snapshot?.tabs ?? []) {
    if (!pinned.has(String(tab.title)) || !tab.terminal) continue;
    if (dryRun) {
      console.log(`would unpin ${tab.terminal}  ${tab.title}`);
    } else {
      await client.call('terminal.rename', { terminal: tab.terminal, title: '' });
      console.log(`unpinned ${tab.terminal}  ${tab.title}`);
    }
    cleared += 1;
  }
}

console.log(
  cleared === 0
    ? 'No pinned account titles found.'
    : dryRun
      ? `${cleared} tab(s) would be unpinned. Nothing changed.`
      : `${cleared} tab(s) unpinned; each falls back to "Terminal N" until Orca generates a title.`,
);
