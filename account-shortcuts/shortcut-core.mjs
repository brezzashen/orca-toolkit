// Snapshot, press, and deliver once using injected Orca runtimes.
// Snapshot retries are independent from one-shot command delivery.
export const SNAPSHOT_RETRIES = 3;
export const SERVICE_DEADLINE_MS = 30_000;
export const DELIVERY_CHECK_DELAYS_MS = [100, 250, 500, 1_000];
export const FRESH_WINDOW_MS = 5_000;
export const FRESH_PREVIEW_MAX = 2_000;
export async function terminalHandles(client) {
    try {
        return (await client.call('terminal.list', {
            includeVisualLayouts: false
        })).result.terminals;
    } catch  {
        return null;
    }
}
export async function snapshotRuntime(runtime, clock, attempts) {
    let handles = null;
    for(let attempt = 0; attempt < attempts; attempt++){
        handles = await terminalHandles(runtime.client);
        if (handles) break;
    }
    return {
        known: handles ? new Set(handles.map((terminal)=>terminal.handle)) : null,
        settledAt: clock.now()
    };
}
export function isFreshTerminal(terminal, pressAt) {
    return Boolean(terminal.writable) && !terminal.agentIdentity && typeof terminal.lastOutputAt === 'number' && terminal.lastOutputAt >= pressAt - FRESH_WINDOW_MS && (terminal.preview ?? '').length <= FRESH_PREVIEW_MAX;
}
function safeNotify(notify, command) {
    try {
        notify('Orca could not confirm this launch. Inspect the new terminal before retrying; no input was resent.');
    } catch  {}
}
async function wasDelivered(client, handle, command) {
    try {
        const response = await client.call('terminal.list', {
            handles: [
                handle
            ]
        });
        const terminal = response?.result?.terminals?.[0];
        if (!terminal) return false;
        return Boolean(terminal.agentIdentity) || String(terminal.preview ?? '').includes(command);
    } catch  {
        return false;
    }
}
export async function sendCommand(client, handle, command, clock, notify) {
    try {
        // Orca's enter:true holds the Enter key for a fixed ~500 ms (measured 2026-10-28); a fresh
        // shell prompt runs a raw carriage return at once, so the command carries its own.
        await client.call('terminal.send', { terminal: handle, text: `${command}\r`, enter: false });
    } catch (error) {
        // A raw shell write has no durable replay ID. A lost reply must never append it again.
        for (const delay of DELIVERY_CHECK_DELAYS_MS) {
            await clock.sleep(delay);
            if (await wasDelivered(client, handle, command)) return;
        }
        safeNotify(notify, command);
        throw error;
    }
}
export async function runFKeyLaunch(options) {
    const { runtimes, chord, command, press, clock, notify } = options;
    const claims = options.claims ?? { has: () => false, claim: () => true };
    const startedAt = clock.now();
    if (runtimes.length === 0) {
        throw new Error('No Orca runtime available to launch into.');
    }
    // orca-fkey-tap already pressed the chord at pressedAt; new terminals are found by freshness alone.
    const pressedAt = options.pressedAt;
    const baselines = pressedAt == null
        ? runtimes.map((runtime)=>snapshotRuntime(runtime, clock, runtime.environment ? SNAPSHOT_RETRIES : 1))
        : runtimes.map(()=>Promise.resolve({ known: null, settledAt: clock.now(), assumed: true }));
    await baselines[0];
    if (pressedAt == null && !press(chord)) {
        await Promise.all(baselines);
        return;
    }
    const pressAt = pressedAt ?? clock.now();
    const deadline = pressAt + SERVICE_DEADLINE_MS;
    const winner = await new Promise((resolve, reject)=>{
        let settled = false;
        let pending = runtimes.length;
        const finish = ()=>{
            pending -= 1;
            if (pending === 0 && !settled) resolve(null);
        };
        const win = (runtime, handle)=>{
            if (settled || !claims.claim(runtime.environment, handle)) return false;
            settled = true;
            resolve({
                runtime,
                handle
            });
            return true;
        };
        runtimes.forEach((runtime, index)=>{
            const intervalMs = runtime.environment ? 80 : 15;
            (async ()=>{
                const baseline = await baselines[index];
                const useFreshRule = baseline.known === null || baseline.settledAt > pressAt;
                let firstPoll = true;
                let failures = baseline.known === null && !baseline.assumed ? 1 : 0;
                while(!settled && clock.now() < deadline){
                    const delay = failures ? Math.min(250 * 2 ** (failures - 1), 1_000) : firstPoll ? 0 : intervalMs;
                    if (delay) await clock.sleep(delay);
                    firstPoll = false;
                    if (settled) return;
                    const current = await terminalHandles(runtime.client);
                    if (!current) { failures += 1; continue; }
                    failures = 0;
                    const available = current.filter(terminal => !claims.has(runtime.environment, terminal.handle));
                    const strict = baseline.known ? available.filter((terminal)=>terminal.writable && !baseline.known.has(terminal.handle)) : [];
                    if (strict.length > 1) continue;
                    if (strict.length === 1 && win(runtime, strict[0].handle)) {
                        return;
                    }
                    if (useFreshRule) {
                        const fresh = available.filter((terminal)=>isFreshTerminal(terminal, pressAt));
                        if (fresh.length === 1 && win(runtime, fresh[0].handle)) {
                            return;
                        }
                    }
                }
                finish();
            })().catch(reject);
        });
    });
    if (!winner) {
        safeNotify(notify, command);
        throw new Error(`Orca opened no terminal within ${SERVICE_DEADLINE_MS / 1_000} s of ${chord.label}; is Orca frontmost with a workspace selected?`);
    }
    const foundAt = clock.now();
    // Remote hosts may lack the shared launcher; only they need the probing fallback.
    const text = winner.runtime.environment == null && options.localCommand ? options.localCommand : command;
    await sendCommand(winner.runtime.client, winner.handle, text, clock, notify);
    return {
        environment: winner.runtime.environment,
        terminal: winner.handle,
        transport: winner.runtime.transport ?? 'official',
        elapsedMs: clock.now() - startedAt,
        prepareMs: pressAt - startedAt,
        discoverMs: foundAt - pressAt,
        sendMs: clock.now() - foundAt,
    };
}
