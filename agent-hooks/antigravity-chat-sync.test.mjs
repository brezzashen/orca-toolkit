// Regression coverage for the 2026-10-21 SIGUSR1 startup termination.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const sourceUrl = new URL('./antigravity-chat-sync.mjs', import.meta.url);

async function harness(
  t,
  {
    endpoint = '',
    endpointAfterSignal = '',
    psOutput = '42 /Applications/Orca.app/Contents/MacOS/Orca\n',
    targetPid = 42,
    disconnect = false,
    allowSignal = false,
  } = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-safe-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const evaluations = [];
  const signals = [];
  let closed = 0;
  let currentEndpoint = endpoint;
  const context = vm.createContext({
    URL, console, setTimeout, clearTimeout,
    process: {
      argv: [],
      env: {},
      platform: 'test',
      kill: (pid, sig) => {
        if (!allowSignal) assert.fail('must never signal Orca during startup');
        signals.push({ pid, sig });
        if (endpointAfterSignal) currentEndpoint = endpointAfterSignal;
      },
    },
    WebSocket: class {
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(raw) {
        const request = JSON.parse(raw);
        evaluations.push(request.params.expression);
        if (disconnect) { queueMicrotask(() => this.onclose?.()); return; }
        // Execute the real PID guard; another inspector must never reach the installer.
        let exceptionDetails;
        try {
          vm.runInNewContext(request.params.expression, {
            process: { pid: targetPid, mainModule: { require: () => { throw new Error('installer reached'); } } },
            global: {},
          });
        } catch (error) {
          if (error.message !== 'installer reached') exceptionDetails = { text: error.message };
        }
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: { exceptionDetails } }) }));
      }
      close() { closed++; }
    },
  });
  const module = new vm.SourceTextModule(fs.readFileSync(sourceUrl, 'utf8'), {
    context, initializeImportMeta: (meta) => { meta.url = sourceUrl.href; },
  });
  await module.link(async (specifier) => {
    const actual = await import(specifier);
    let exports = { ...actual };
    if (specifier === 'node:os') exports.default = { ...actual.default, homedir: () => home };
    if (specifier === 'node:child_process') exports.execFileSync = (command) => {
      if (command === 'ps') return psOutput;
      throw new Error('external commands disabled in regression tests');
    };
    if (specifier === 'node:http') exports.default = {
      get: (_options, callback) => {
        const request = new EventEmitter();
        request.destroy = () => {};
        queueMicrotask(() => {
          const response = new EventEmitter();
          callback(response);
          response.emit('data', JSON.stringify(currentEndpoint ? [{ webSocketDebuggerUrl: currentEndpoint }] : []));
          response.emit('end');
        });
        return request;
      },
    };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return {
    run: () => module.namespace.ensureOrcaAntigravityIconHook({ force: true }),
    evaluations,
    signals,
    closed: () => closed,
    home,
  };
}

test('startup without inspector skips optional injection without sending a signal', async (t) => {
  const h = await harness(t, {
    psOutput: '42 00:05 /Applications/Orca.app/Contents/MacOS/Orca\n',
  });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.evaluations, []);
});

test('ignores Orca -e helper processes with lower PIDs and matches the real main process', async (t) => {
  const h = await harness(t, {
    endpoint: 'ws://127.0.0.1:9229/orca',
    targetPid: 71229,
    psOutput:
      '25787 05:10:00 /Applications/Orca.app/Contents/MacOS/Orca -e const { spawn } = require("node:child_process");\n' +
      '71229 03:20:15 /Applications/Orca.app/Contents/MacOS/Orca\n',
  });
  assert.equal(await h.run(), true);
  assert.equal(h.evaluations.length, 1);
  assert.ok(h.evaluations[0].includes('process.pid !== 71229'));
});

test('mature Orca main process activates inspector via SIGUSR1 at most once per PID', async (t) => {
  const h = await harness(t, {
    allowSignal: true,
    endpoint: '',
    endpointAfterSignal: 'ws://127.0.0.1:9229/orca',
    targetPid: 71229,
    psOutput: '71229 01:30 /Applications/Orca.app/Contents/MacOS/Orca\n',
  });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.signals, [{ pid: 71229, sig: 'SIGUSR1' }]);
  assert.equal(h.evaluations.length, 1);
});

test('an existing Orca inspector permits injection without closing its server', async (t) => {
  const h = await harness(t, { endpoint: 'ws://127.0.0.1:9229/orca' });
  assert.equal(await h.run(), true);
  assert.equal(h.evaluations.length, 1);
  assert.equal(h.closed(), 1);
  assert.ok(!h.evaluations[0].includes('inspector").close'));
  assert.ok(fs.existsSync(path.join(h.home, '.orca/agent-hooks/antigravity-state/patched-orca-main.pid')));
});

test('another process on port 9229 cannot receive the Orca patch', async (t) => {
  const h = await harness(t, { endpoint: 'ws://127.0.0.1:9229/other', targetPid: 99 });
  assert.equal(await h.run(), false);
  assert.equal(h.closed(), 1);
  assert.ok(!fs.existsSync(path.join(h.home, '.orca/agent-hooks/antigravity-state/patched-orca-main.pid')));
});

test('inspector disconnect settles safely and leaves no success marker', async (t) => {
  const h = await harness(t, { endpoint: 'ws://127.0.0.1:9229/orca', disconnect: true });
  assert.equal(await h.run(), false);
  assert.equal(h.closed(), 1);
});
