// Runs on a paired Orca desktop client with its source on stdin:
//   GHOST_MODE=apply|dry GHOST_TAB_IDS=<id>,<id> node --input-type=module
// Each id is a tab the host already closed. The client mirrors server tabs as
// `web-terminal-<id>`, but Orca 1.4.255 keeps that mirror (and its finished-agent sidebar row)
// when the close came from another device, the CLI or automation. This removes exactly those
// mirrors through Orca's own `closeTab(..., { remoteCloseOwnedByHost: true })`, which tears the
// tab down locally without sending another close to the server. A mirror that is still attached
// (non-null ptyId) is never touched. Prints one JSON object.
import { execFileSync } from 'node:child_process';

const apply = process.env.GHOST_MODE === 'apply';
const ids = (process.env.GHOST_TAB_IDS || '').split(',').filter((id) => /^[0-9a-f-]{36}$/.test(id));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mainLine = execFileSync('ps', ['-ax', '-o', 'pid=,command='])
  .toString()
  .split('\n')
  .find((line) => line.trim().endsWith(' /Applications/Orca.app/Contents/MacOS/Orca'));
if (!mainLine) {
  console.log(JSON.stringify({ orca: 'not-running' }));
  process.exit(0);
}

// The renderer-side step: find the store by shape (chunk names change per build), then close.
const rendererStep = `(async (ids, apply) => {
  const hrefs = [...document.querySelectorAll('link[rel=modulepreload],script[type=module]')]
    .map((node) => node.href || node.src)
    .filter((href) => /\\/assets\\/store-[A-Za-z0-9_-]+\\.js$/.test(href));
  let store = null;
  for (const href of hrefs) {
    const mod = await import(href);
    store = Object.values(mod).find((value) => {
      const state = value && typeof value.getState === 'function' ? value.getState() : null;
      return state && typeof state.closeTab === 'function' && state.tabsByWorktree && state.retainedAgentsByPaneKey;
    });
    if (store) break;
  }
  if (!store) return { error: 'orca store not found; checked ' + hrefs.join(' ') };
  const tabOf = (id) => Object.values(store.getState().tabsByWorktree).flat().find((tab) => tab.id === id);
  const results = {};
  for (const raw of ids) {
    const id = 'web-terminal-' + raw;
    const tab = tabOf(id);
    if (!tab) { results[raw] = 'absent'; continue; }
    if (tab.ptyId) { results[raw] = 'attached'; continue; }
    if (!apply) { results[raw] = 'would-close'; continue; }
    store.getState().closeTab(id, { remoteCloseOwnedByHost: true });
    const prefix = id + ':';
    for (const key of Object.keys(store.getState().retainedAgentsByPaneKey)) {
      if (key.startsWith(prefix)) store.getState().dismissRetainedAgent(key);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const left = tabOf(id) || Object.keys(store.getState().retainedAgentsByPaneKey).some((key) => key.startsWith(prefix));
    results[raw] = left ? 'close-failed' : 'closed';
  }
  return { results };
})`;

const mainStep = `(async () => {
  const { webContents } = process.mainModule.require('electron');
  const wc = webContents.getAllWebContents().find((w) => /\\/renderer\\/index\\.html/.test(w.getURL()));
  if (!wc) return { error: 'orca main window not found' };
  return await wc.executeJavaScript(${JSON.stringify(rendererStep)} + '(' + ${JSON.stringify(JSON.stringify(ids))} + ', ' + ${apply} + ')');
})()`;

if (ids.length === 0) {
  console.log(JSON.stringify({ results: {} }));
  process.exit(0);
}
process.kill(Number(mainLine.trim().split(/\s+/)[0]), 'SIGUSR1');
let wsUrl = '';
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
    // SIGUSR1 went to Orca's main pid, whose inspector target is Electron's browser process.
    wsUrl = targets.find((t) => t.type === 'node' && /^electron\//.test(t.title || ''))?.webSocketDebuggerUrl || '';
  } catch {}
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) {
  console.log(JSON.stringify({ error: 'Orca inspector did not open on 127.0.0.1:9229' }));
  process.exit(1);
}
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const call = (id, expression) => new Promise((resolve) => {
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id === id) resolve(data);
  });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, includeCommandLineAPI: true, returnByValue: true } }));
});
let out;
try {
  const reply = await call(1, mainStep);
  const failure = reply.result?.exceptionDetails;
  out = failure ? { error: failure.exception?.description ?? failure.text } : reply.result?.result?.value;
} finally {
  // Never leave Orca's debug port open.
  ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'try { process.mainModule.require("inspector").close() } catch {}' } }));
  await sleep(150);
  ws.close();
}
console.log(JSON.stringify(out ?? { error: 'empty reply' }));
process.exit(out?.error ? 1 : 0);
