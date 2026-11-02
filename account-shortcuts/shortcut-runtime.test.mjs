import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShortcutRuntime } from './shortcut-runtime.mjs';

function fixture({ remote = true, compatible = true, failure } = {}) {
  const requests = [];
  const envelope = { orchestrationRequestId: 'durable-request-1' };
  let closes = 0;
  class ClientError extends Error {
    constructor(code, message, data) { super(message); Object.assign(this, { code, data }); }
  }
  class RemoteError extends ClientError {}
  class RuntimeClient {
    constructor() {
      this.remote = remote ? { credential: { deviceToken: 'test-only' } } : null;
      this.remoteCompat = {
        checked: false,
        async send(args) {
          const request = args.transport.sendWebSocketRequest;
          if (this.checked) return request(args.connection, args.method, args.params, args.timeoutMs, args.envelope);
          return args.transport.sendWebSocketRequestWithStatusPreflight(
            args.connection, args.method, args.params, args.timeoutMs,
            () => {
              if (!compatible) throw new Error('incompatible runtime');
              this.checked = true;
            }, args.envelope,
          );
        },
      };
    }
    call(method, params) {
      return this.remoteCompat.send({ connection: this.remote, method, params, timeoutMs: 4_000, envelope });
    }
  }
  class SharedControl {
    constructor(connection, options) {
      requests.push({ kind: 'connect', connection, options });
    }
    async request(method, params, timeoutMs, passedEnvelope) {
      requests.push({ kind: 'request', method, params, timeoutMs, envelope: passedEnvelope });
      if (failure && method !== 'status.get') throw failure;
      return { ok: true, result: {} };
    }
    close() { closes++; }
    pauseStandingRetry() { requests.push({ kind: 'pause-retry' }); }
  }
  return {
    sdk: { RuntimeClient, RemoteRuntimeSharedControlConnection: SharedControl,
      RuntimeClientError: ClientError, RemoteRuntimeClientError: RemoteError,
      AGENT_LAUNCH_RUNTIME_CAPABILITY: 'agent-launch' },
    requests, envelope, closes: () => closes, RemoteError, ClientError,
  };
}

test('one control socket serves snapshot, polling and send with the official compatibility gate', async () => {
  const f = fixture();
  const runtime = createShortcutRuntime('remote', f.sdk);
  await runtime.client.call('terminal.list', { includeVisualLayouts: false });
  await runtime.client.call('terminal.list', { includeVisualLayouts: false });
  await runtime.client.call('terminal.send', { terminal: 'new', text: 'co1', enter: true });
  assert.equal(runtime.transport, 'shared-control');
  assert.equal(f.requests.filter(r => r.kind === 'connect').length, 1);
  assert.deepEqual(f.requests.filter(r => r.kind === 'request').map(r => r.method),
    ['status.get', 'terminal.list', 'terminal.list', 'terminal.send']);
  assert.deepEqual(f.requests[0].options.clientCapabilities, ['agent-launch']);
  const send = f.requests.at(-1);
  assert.equal(send.timeoutMs, 4_000);
  assert.equal(send.envelope, f.envelope);
  assert.deepEqual(send.params, { terminal: 'new', text: 'co1', enter: true });
  runtime.close();
  assert.equal(f.closes(), 1);
});

test('incompatible runtimes are rejected before any terminal request', async () => {
  const f = fixture({ compatible: false });
  const runtime = createShortcutRuntime('remote', f.sdk);
  await assert.rejects(runtime.client.call('terminal.send', {}), /incompatible runtime/);
  assert.deepEqual(f.requests.filter(r => r.kind === 'request').map(r => r.method), ['status.get']);
  runtime.close();
});

test('transport errors retain their code and data without replaying a mutation', async () => {
  const initial = fixture();
  const error = new initial.RemoteError('runtime_timeout', 'lost reply', { stage: 'response' });
  const f = fixture({ failure: error });
  f.sdk.RemoteRuntimeClientError = initial.RemoteError;
  const runtime = createShortcutRuntime('remote', f.sdk);
  await assert.rejects(runtime.client.call('terminal.send', {}), e =>
    e instanceof f.ClientError && e.code === 'runtime_timeout' && e.data === error.data);
  assert.equal(f.requests.filter(r => r.method === 'terminal.send').length, 1);
  assert.equal(f.requests.filter(r => r.kind === 'pause-retry').length, 1);
  runtime.close();
});

test('local sockets keep their original RuntimeClient transport', () => {
  const f = fixture({ remote: false });
  const runtime = createShortcutRuntime(null, f.sdk);
  assert.equal(runtime.transport, 'official');
  assert.deepEqual(f.requests, []);
  runtime.close();
});

test('older Orca versions without shared control keep the official fallback', () => {
  const f = fixture();
  delete f.sdk.RemoteRuntimeSharedControlConnection;
  const runtime = createShortcutRuntime('remote', f.sdk);
  assert.equal(runtime.transport, 'official');
  assert.deepEqual(f.requests, []);
  runtime.close();
});
