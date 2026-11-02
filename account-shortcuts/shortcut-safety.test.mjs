import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFKeyLaunch, sendCommand } from './shortcut-core.mjs';
import { createTerminalClaims, runWithProcessLock } from './shortcut-guard.mjs';

const chord = { label: 'Ctrl+Alt+T', keyCode: 17, flags: 786432 };

test('an ambiguous partial write is never sent a second time', async () => {
  let writes = 0;
  const client = { call: async method => {
    if (method === 'terminal.send') { writes++; throw new Error('reply lost after partial input'); }
    return { result: { terminals: [{ preview: 'if command -v orca_acco' }] } };
  } };
  await assert.rejects(sendCommand(client, 'new', 'if command -v orca_account_tab; then cl3; fi',
    { sleep: async () => {} }, () => {}));
  assert.equal(writes, 1);
});

test('a terminal claimed by a previous launch cannot receive another command', async () => {
  let pressed = false;
  const sent = [];
  const claims = {
    has: (_, handle) => handle === 'previously-claimed',
    claim: (_, handle) => { assert.notEqual(handle, 'previously-claimed'); return true; },
  };
  await runFKeyLaunch({
    runtimes: [{ environment: 'remote', client: { call: async (method, params) => {
      if (method === 'terminal.send') { sent.push(params.terminal); return { result: {} }; }
      return { result: { terminals: pressed ? [
        { handle: 'previously-claimed', writable: true }, { handle: 'own-new', writable: true },
      ] : [] } };
    } } }], chord, command: 'cl3', claims,
    press: () => { pressed = true; return true; },
    clock: { now: () => 0, sleep: async () => {} }, notify: assert.fail,
  });
  assert.deepEqual(sent, ['own-new']);
});

test('two unclaimed new terminals are ambiguous and receive no input', async () => {
  let pressed = false;
  let now = 0;
  let writes = 0;
  await assert.rejects(runFKeyLaunch({
    runtimes: [{ environment: 'remote', client: { call: async method => {
      if (method === 'terminal.send') { writes++; return { result: {} }; }
      return { result: { terminals: pressed ? [
        { handle: 'new-one', writable: true }, { handle: 'new-two', writable: true },
      ] : [] } };
    } } }], chord, command: 'cl3',
    press: () => { pressed = true; return true; },
    clock: { now: () => now, sleep: async () => { now += 10_000; } }, notify: () => {},
  }));
  assert.equal(writes, 0);
});

test('independent shortcut processes serialize and persist a single terminal claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-shortcut-guard-'));
  const log = join(directory, 'events.jsonl');
  const moduleURL = new URL('./shortcut-guard.mjs', import.meta.url).href;
  try {
    const worker = `
      import { appendFileSync } from 'node:fs';
      import { createTerminalClaims } from ${JSON.stringify(moduleURL)};
      const emit = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
      const claims = createTerminalClaims(${JSON.stringify(directory)});
      emit({phase:'enter',pid:process.pid,claimed:claims.claim('remote','same-terminal')});
      await new Promise(resolve => setTimeout(resolve, 50));
      emit({phase:'exit',pid:process.pid});
    `;
    const results = await Promise.all([0, 1, 2].map(() => runWithProcessLock(
      process.execPath, ['--input-type=module', '-e', worker], { directory, stdio: 'ignore' },
    )));
    assert.deepEqual(results, [0, 0, 0]);
    const events = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.phase), ['enter', 'exit', 'enter', 'exit', 'enter', 'exit']);
    assert.equal(events.filter(e => e.claimed).length, 1);
    for (let i = 0; i < events.length; i += 2) assert.equal(events[i].pid, events[i + 1].pid);
    assert.equal(createTerminalClaims(directory).has('remote', 'same-terminal'), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the OS releases a shortcut lock after a failed child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-shortcut-exit-'));
  try {
    assert.equal(await runWithProcessLock(process.execPath, ['-e', 'process.exit(7)'], { directory }), 7);
    assert.equal(await runWithProcessLock(process.execPath, ['-e', 'process.exit(0)'], { directory }), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a corrupt claim ledger fails closed instead of reusing an old terminal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-shortcut-claims-'));
  try {
    writeFileSync(join(directory, 'claimed-terminals.json'), '{}');
    assert.throws(() => createTerminalClaims(directory), /Invalid shortcut terminal claims/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
