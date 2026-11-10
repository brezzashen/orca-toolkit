import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('./launch.ts', import.meta.url), 'utf8'));
const config = JSON.parse(readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
const argsByAgent = { codex: '--dangerously-bypass-approvals-and-sandbox', claude: '--dangerously-skip-permissions', grok: '--yolo', antigravity: '--dangerously-skip-permissions' };

// Service runs see `before` terminals on every runtime until the chord is pressed; then `grower`
// lists one new terminal. A runtime listed in `down` fails before the press and recovers after.
type Service = { environments: string[]; grower: string | null; down?: string[]; slowSnapshot?: string[]; slowPoll?: string[]; notFrontmost?: boolean };
// viewRefusal makes session.tabs.setTabProps reject with that RPC error code.
type Options = { viewRefusal?: string };

async function launch(alias: string, mode: 'current' | 'chat' | 'new' | 'service', service?: Service, options: Options = {}) {
  const calls: { method: string; params: any; environment: string | null }[] = [];
  const spawns: { shell: string; args: string[]; options: any }[] = [];
  const scripts: string[] = [];
  let reaps = 0;
  const context = createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    process: {
      argv: ['node', 'launch.ts', alias, ...(mode === 'chat' ? ['--chat'] : mode === 'new' ? ['--new-tab'] : [])],
      env: mode === 'service' ? { SHELL: '/bin/zsh' } : { ORCA_TERMINAL_HANDLE: 'caller', SHELL: '/bin/zsh' },
    },
  });
  class RuntimeClient {
    environment: string | null;
    constructor(_path?: unknown, _timeout?: unknown, _local?: unknown, environment: string | null = null) {
      this.environment = environment;
    }
    async call(method: string, params: any) {
      calls.push({ method, params, environment: this.environment });
      if (method === 'terminal.list') {
        const beforePress = !scripts.length;
        if (beforePress && service?.down?.includes(this.environment!)) throw new Error('runtime unreachable');
        if (beforePress && service?.slowSnapshot?.includes(this.environment!)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (!beforePress && service?.slowPoll?.includes(this.environment!)) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        const terminals = [{ handle: `old-${this.environment}`, writable: true }];
        if (!beforePress && this.environment === service?.grower) terminals.push({ handle: 'opened', writable: true });
        return { result: { terminals } };
      }
      if (method === 'terminal.send') return { result: {} };
      if (method === 'settings.get') return { result: { settings: { experimentalNativeChat: true, agentDefaultArgs: argsByAgent } } };
      if (method === 'terminal.show') return { result: { terminal: { worktreeId: 'workspace', tabId: 'caller-tab' } } };
      if (method === 'worktree.show') return { result: { worktree: { hostId: 'local' } } };
      if (method === 'session.tabs.createTerminal') return { result: { tab: { terminal: 'created' } } };
      if (method === 'session.tabs.setTabProps' && options.viewRefusal) {
        throw Object.assign(new Error('Tab color, pin, and view mode edits are unavailable while a desktop window owns the layout'), { code: options.viewRefusal });
      }
      if (method === 'session.tabs.setTabProps' || method === 'terminal.focus') return { result: {} };
      throw new Error(`Unexpected RPC: ${method}`);
    }
  }
  const modules: Record<string, Record<string, any>> = {
    'node:module': { createRequire: () => () => ({ RuntimeClient }) },
    'node:child_process': {
      execFileSync: (file: string, args: string[]) => {
        assert.equal(file, '/usr/bin/osascript');
        scripts.push(args.join(' '));
        return service?.notFrontmost ? 'not-frontmost\n' : '';
      },
      spawnSync: (shell: string, args: string[], options: any) => {
        spawns.push({ shell, args, options });
        return { status: 0 };
      },
    },
    'node:dns': { setDefaultResultOrder: () => {} },
    'node:fs': {
      readFileSync: (path: unknown) => {
        if (String(path).endsWith('keybindings.json')) return JSON.stringify({ platforms: { darwin: { 'tab.newTerminal': ['Ctrl+Alt+T'] } } });
        if (String(path).endsWith('orca-environments.json')) return JSON.stringify({ environments: (service?.environments ?? []).map((id) => ({ id })) });
        return JSON.stringify(config);
      },
    },
    'node:os': { homedir: () => '/test-home' },
    './runner-reaper.ts': { reapIdleAutomatorRunners: () => { reaps += 1; return []; } },
    'node:crypto': { randomUUID: () => 'test-mutation' },
  };
  const entry = new SourceTextModule(source, {
    context,
    initializeImportMeta: (meta) => { meta.url = new URL('./launch.ts', import.meta.url).href; },
  });
  await entry.link(async (name) => {
    const exports = modules[name];
    assert.ok(exports, `Unexpected import: ${name}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await entry.evaluate();
  return { calls, spawns, scripts, reaps };
}

for (const alias of Object.keys(config.aliases)) {
  for (const mode of ['current', 'chat', 'new'] as const) {
    test(`${alias}: ${mode} preserves account, arguments and terminal ownership`, async () => {
      const { calls, spawns, reaps } = await launch(alias, mode);
      assert.equal(reaps, 0);
      const account = config.accounts[config.aliases[alias]];
      const expected = `${account.switchCommand} && ${account.command ?? account.agent}${account.agent === 'codex' ? ' --no-daemon' : ''} ${argsByAgent[account.agent as keyof typeof argsByAgent]}`;
      const creations = calls.filter(({ method }) => method === 'session.tabs.createTerminal');
      const focuses = calls.filter(({ method }) => method === 'terminal.focus');
      if (mode === 'new') {
        assert.equal(spawns.length, 0);
        assert.equal(creations.length, 1);
        assert.equal(creations[0].params.command, expected);
        assert.equal(creations[0].params.activate, true);
        assert.equal(creations[0].params.select, true);
        // 'host' left a remote-controlling desktop on its old tab.
        assert.equal(creations[0].params.navigation, 'all');
        // Antigravity slots open in the terminal view; every other template account in the Chat UI.
        assert.equal(creations[0].params.viewMode, account.viewMode);
        assert.equal(focuses.length, 1);
        assert.equal(focuses[0].params.terminal, 'created');
      } else {
        assert.equal(creations.length, 0);
        assert.equal(focuses.length, 0);
        assert.equal(spawns.length, 1);
        assert.equal(spawns[0].args[0], '-ic');
        assert.equal(spawns[0].args[1], expected);
        assert.equal(spawns[0].options.stdio, 'inherit');
        const views = calls.filter(({ method }) => method === 'session.tabs.setTabProps');
        assert.equal(views.length, mode === 'chat' ? 1 : 0);
        if (views.length) assert.equal(views[0].params.tabId, 'caller-tab');
      }
      assert.equal(calls.filter(({ method }) => method.includes('close')).length, 0);
    });
  }
}

test('chat still starts the account in the terminal view when the desktop owns the layout', async () => {
  const { calls, spawns } = await launch('CL1', 'chat', undefined, { viewRefusal: 'capability_unsupported' });
  assert.equal(calls.filter(({ method }) => method === 'session.tabs.setTabProps').length, 1);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args[0], '-ic');
});

test('chat surfaces any other view edit failure', async () => {
  await assert.rejects(launch('CL1', 'chat', undefined, { viewRefusal: 'runtime_unavailable' }), /desktop window owns the layout/);
});

test('three concurrent Codex launches each request an embedded server', async () => {
  const results = await Promise.all(['CO1', 'CO2', 'CO1'].map((alias) => launch(alias, 'chat')));
  for (const { spawns } of results) assert.match(spawns[0].args[1], /codex --no-daemon /);
});

// Services once read Orca's persisted focus, which could still name the workspace the user had
// left, and created remote tabs by RPC that a paired desktop never listed (2026-10-17).
for (const [name, grower] of [['local', null], ['remote', 'remote-env']] as const) {
  test(`Service opens a terminal with Orca's binding and starts the account in the ${name} one it grew`, async () => {
    const { calls, spawns, scripts, reaps } = await launch('CL2', 'service', { environments: ['remote-env'], grower });
    // Each Service run leaves an idle Automator runner behind; the launcher reaps the older ones.
    assert.equal(reaps, 1);
    assert.equal(scripts.length, 1);
    // Ctrl+Alt+T: virtual key 17 with the Control and Option event flags, posted only when Orca is frontmost.
    assert.match(scripts[0], /^-l JavaScript -e /);
    assert.match(scripts[0], /bundleIdentifier\.js !== 'com\.stablyai\.orca'/);
    assert.match(scripts[0], / 17 786432$/);
    assert.equal(spawns.length, 0);
    assert.equal(calls.filter(({ method }) => method.startsWith('session.tabs.')).length, 0);
    const sends = calls.filter(({ method }) => method === 'terminal.send');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].environment, grower);
    // The params object comes from the launcher's vm realm, so compare its JSON form.
    assert.equal(JSON.stringify(sends[0].params), JSON.stringify({ terminal: 'opened', text: 'orca_account_tab A2 --chat', enter: true }));
  });
}

test('Service ignores a runtime that could not list terminals before the keypress', async () => {
  const { calls } = await launch('CO1', 'service', { environments: ['down-env', 'remote-env'], grower: 'remote-env', down: ['down-env'] });
  const sends = calls.filter(({ method }) => method === 'terminal.send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].environment, 'remote-env');
  assert.equal(sends[0].params.text, 'orca_account_tab C1 --chat');
});

test('Service exits cleanly without polling or erroring when focus left Orca before the keypress', async () => {
  const { calls, scripts } = await launch('CL1', 'service', { environments: ['remote-env'], grower: null, notFrontmost: true });
  assert.equal(scripts.length, 1);
  assert.equal(calls.filter(({ method }) => method === 'terminal.list').length, 2);
  assert.equal(calls.filter(({ method }) => method === 'terminal.send').length, 0);
});

test('Service does not wait for a slow remote runtime poll when local already opened the terminal', async () => {
  const started = Date.now();
  const { calls } = await launch('CL1', 'service', { environments: ['slow-remote'], grower: null, slowPoll: ['slow-remote'] });
  const elapsed = Date.now() - started;
  const sends = calls.filter(({ method }) => method === 'terminal.send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].environment, null);
  assert.ok(elapsed < 200, `Expected local detection under 200 ms, took ${elapsed} ms`);
});

test('Service does not delay keypress or local detection on a slow remote initial snapshot', async () => {
  const started = Date.now();
  const { calls } = await launch('CL1', 'service', { environments: ['slow-remote'], grower: null, slowSnapshot: ['slow-remote'] });
  const elapsed = Date.now() - started;
  const sends = calls.filter(({ method }) => method === 'terminal.send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].environment, null);
  assert.ok(elapsed < 100, `Expected local detection under 100 ms despite slow remote snapshot, took ${elapsed} ms`);
});
