import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { accountCommand, terminalChord } from './shortcut-launch.mjs';
import { runFKeyLaunch, sendCommand } from './shortcut-core.mjs';

const config = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
const chord = terminalChord({ platforms: { darwin: { 'tab.newTerminal': ['Ctrl+Alt+T'] } } });

for (const [index, id] of Object.keys(config.accounts).entries()) {
  test(`F${index + 1} preserves the mapped account on the selected remote workspace`, async () => {
    const launch = accountCommand(config, id);
    assert.equal(config.accounts[id].key.codePointAt(0), 0xf704 + index);
    let pressed = false;
    let now = 0;
    const sent = [];
    const runtime = (environment) => ({
      environment,
      client: { call: async (method, params) => {
        if (method === 'terminal.list') return { result: { terminals: [
          { handle: `${environment}-existing`, writable: true },
          ...(pressed && environment === 'remote' ? [{ handle: 'remote-workspace-new', writable: true }] : []),
        ] } };
        assert.equal(method, 'terminal.send');
        sent.push({ environment, ...params });
        return { result: {} };
      } },
    });
    await runFKeyLaunch({
      runtimes: [runtime(null), runtime('remote')], chord, command: launch.command, localCommand: launch.localCommand,
      press: () => { pressed = true; return true; },
      clock: { now: () => now, sleep: async (ms) => { now += ms; } },
      notify: (message) => assert.fail(message),
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].environment, 'remote');
    assert.equal(sent[0].terminal, 'remote-workspace-new');
    assert.equal(sent[0].text, `${launch.command}\r`);
    assert.equal(sent[0].enter, false);
  });
}

test('the template fills F1-F12 and the shell defines every alias a key types', () => {
  assert.deepEqual(Object.keys(config.accounts), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'C1', 'C2', 'AG1', 'AG2', 'G1']);
  const shell = readFileSync(new URL('../shell/orca.zsh', import.meta.url), 'utf8');
  const defined = shell.match(/^_orca_aliases=\(([^)]*)\)$/m)[1].split(/\s+/);
  assert.deepEqual([...defined].sort(), Object.keys(config.aliases).sort());
  for (const [id, account] of Object.entries(config.accounts)) {
    const { alias } = accountCommand(config, id);
    assert.ok(defined.includes(alias.toUpperCase()), `${id}: ${alias} is not a shell alias`);
    // A key types the alias; an alias named like the executable would call itself.
    assert.notEqual(alias, account.command ?? account.agent, `${id}: alias equals its command`);
  }
});

test('F2 on a local workspace sends only the cl2 alias, never the probing fallback', async () => {
  const launch = accountCommand(config, 'A2');
  let pressed = false;
  let now = 0;
  const sent = [];
  const runtime = (environment) => ({
    environment,
    client: { call: async (method, params) => {
      if (method === 'terminal.list') return { result: { terminals: [
        { handle: `${environment}-existing`, writable: true },
        ...(pressed && environment === null ? [{ handle: 'local-new', writable: true }] : []),
      ] } };
      sent.push({ environment, ...params });
      return { result: {} };
    } },
  });
  await runFKeyLaunch({
    runtimes: [runtime(null), runtime('remote')], chord, command: launch.command, localCommand: launch.localCommand,
    press: () => { pressed = true; return true; },
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    notify: (message) => assert.fail(message),
  });
  assert.deepEqual(sent.map(({ environment, terminal, text }) => ({ environment, terminal, text })),
    [{ environment: null, terminal: 'local-new', text: 'cl2 --chat\r' }]);
});

test('a CO2-only shell launches CO2 in the current directory without a shared launcher', () => {
  const { command } = accountCommand(config, 'CO2');
  const result = spawnSync('/bin/zsh', ['-f', '-c', `co2() { printf 'CO2:%s' "$PWD"; }; ${command}`], {
    cwd: '/private/tmp', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CO2:/private/tmp');
});

test('an unavailable account never runs another installed account', () => {
  const { command } = accountCommand(config, 'C1');
  const result = spawnSync('/bin/zsh', ['-f', '-c', `co2() { printf 'WRONG'; }; ${command}`], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.stdout, '');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /co1 is not installed on this execution host/);
});

test('a fully configured shell keeps the shared account launcher and Chat UI flag', () => {
  const result = spawnSync('/bin/zsh', ['-f', '-c', `orca_account_tab() { printf '%s ' "$@"; }; ${accountCommand(config, 'C2').command}`], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'C2 --chat ');
});

test('a lost send reply with echoed input does not launch a duplicate account', async () => {
  let sends = 0;
  await sendCommand({ call: async (method) => {
    if (method === 'terminal.send') { sends++; throw new Error('lost response'); }
    return { result: { terminals: [{ preview: 'co2' }] } };
  } }, 'remote-new', 'co2', { sleep: async () => {} }, assert.fail);
  assert.equal(sends, 1);
});

test('a non-frontmost Orca does not send any command', async () => {
  await runFKeyLaunch({
    runtimes: [{ environment: null, client: { call: async (method) => {
      assert.equal(method, 'terminal.list');
      return { result: { terminals: [] } };
    } } }], chord, command: 'co2', press: () => false,
    clock: { now: () => 0, sleep: async () => {} }, notify: assert.fail,
  });
});

test('the first remote observation has no fixed polling delay', async () => {
  let pressed = false;
  let sleeps = 0;
  const client = { call: async (method) => ({ result: method === 'terminal.list'
    ? { terminals: pressed ? [{ handle: 'owned-new', writable: true }] : [] } : {} }) };
  const result = await runFKeyLaunch({
    runtimes: [{ environment: 'remote', client }], chord, command: 'co1',
    press: () => { pressed = true; return true; },
    clock: { now: () => 0, sleep: async () => { sleeps++; } }, notify: assert.fail,
  });
  assert.equal(sleeps, 0);
  assert.equal(result.environment, 'remote');
  assert.equal(result.elapsedMs, 0);
});

test('an unreachable extra runtime backs off while the selected runtime still launches', async () => {
  let pressed = false;
  let failedLists = 0;
  const delays = [];
  await runFKeyLaunch({
    runtimes: [
      { environment: null, client: { call: async () => ({ result: { terminals: pressed
        ? [{ handle: 'owned', writable: true }] : [] } }) } },
      { environment: 'offline', client: { call: async () => { failedLists++; throw new Error('offline'); } } },
    ], chord, command: 'co1', press: () => { pressed = true; return true; },
    clock: { now: () => 0, sleep: async ms => { delays.push(ms); } }, notify: assert.fail,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(failedLists <= 3);
  assert.ok(delays.every(ms => ms >= 250));
});

test('after orca-fkey-tap pressed the chord, a fresh remote terminal gets the command without a second press', async () => {
  const launch = accountCommand(config, 'A2');
  let now = 10_000;
  const sent = [];
  const runtime = {
    environment: 'remote',
    client: { call: async (method, params) => {
      if (method === 'terminal.list') return { result: { terminals: [
        { handle: 'remote-busy', writable: true, lastOutputAt: 1_000, preview: '' },
        { handle: 'remote-new', writable: true, lastOutputAt: 9_900, preview: '% ' },
      ] } };
      sent.push(params);
      return { result: {} };
    } },
  };
  await runFKeyLaunch({
    runtimes: [runtime], chord, pressedAt: 9_800, command: launch.command, localCommand: launch.localCommand,
    press: () => assert.fail('the tap already pressed the chord'),
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    notify: (message) => assert.fail(message),
  });
  assert.deepEqual(sent.map(({ terminal, text }) => ({ terminal, text })), [{ terminal: 'remote-new', text: `${launch.command}\r` }]);
});
