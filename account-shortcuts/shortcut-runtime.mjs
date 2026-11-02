// Reuse Orca's authenticated control socket without replacing its RPC safety gates.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/';

function loadSDK() {
  const sdk = require(`${root}cli/runtime-client.js`);
  try {
    return {
      ...sdk,
      ...require(`${root}shared/remote-runtime/control/remote-runtime-shared-control-connection.js`),
      ...require(`${root}shared/remote-runtime-client-error.js`),
      ...require(`${root}shared/agent-launch-runtime-capability.js`),
    };
  } catch (error) {
    // Older Orca versions retain the official one-request transport.
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return sdk;
  }
}

export function createShortcutRuntime(environment, sdk = loadSDK()) {
  const timeout = environment ? 4_000 : 30_000;
  const client = new sdk.RuntimeClient(undefined, timeout, null, environment);
  const runtime = { environment, client, transport: 'official', close() {} };
  if (!client.remote || !sdk.RemoteRuntimeSharedControlConnection || !client.remoteCompat?.send) return runtime;

  const control = new sdk.RemoteRuntimeSharedControlConnection(client.remote, {
    environmentId: environment,
    clientCapabilities: [sdk.AGENT_LAUNCH_RUNTIME_CAPABILITY].filter(Boolean),
  });
  const request = async (connection, method, params, timeoutMs, envelope) => {
    // A refreshed endpoint must never inherit another connection's credentials.
    if (connection !== client.remote) throw new Error('Orca shortcut connection changed.');
    try {
      return await control.request(method, params, timeoutMs, envelope);
    } catch (error) {
      // The bounded launcher owns retries; do not keep reconnecting an unused host.
      control.pauseStandingRetry?.();
      if (sdk.RemoteRuntimeClientError && error instanceof sdk.RemoteRuntimeClientError) {
        throw new sdk.RuntimeClientError(error.code, error.message, error.data);
      }
      throw error;
    }
  };
  const transport = {
    sendWebSocketRequest: request,
    async sendWebSocketRequestWithStatusPreflight(connection, method, params, timeoutMs, validateStatus, envelope) {
      validateStatus(await request(connection, 'status.get', undefined, timeoutMs));
      return request(connection, method, params, timeoutMs, envelope);
    },
  };
  const send = client.remoteCompat.send.bind(client.remoteCompat);
  // RuntimeClient still owns compatibility, source fencing, durable IDs and recovery errors.
  client.remoteCompat.send = (args) => send({ ...args, transport });
  runtime.transport = 'shared-control';
  runtime.close = () => control.close();
  return runtime;
}
