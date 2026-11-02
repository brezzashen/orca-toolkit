/** Sets and verifies the current Codex thread name through app-server JSON-RPC. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Response = { id?: number; result?: unknown; error?: { message?: string } };

export async function setCodexTitle(threadId: string, title: string): Promise<void> {
  const child = spawn(process.env.CODEX_APP_SERVER_BIN || "codex", ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failure: Error | undefined;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code) => fail(new Error(`Codex app-server exited (${code}): ${stderr.trim()}`)));
  lines.on("line", (line) => {
    let response: Response;
    try { response = JSON.parse(line); } catch { return; }
    if (response.id === undefined) return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message || "Codex RPC failed"));
    else request.resolve(response.result);
  });
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const timeout = setTimeout(() => {
    fail(new Error("Codex title update timed out after 10 seconds"));
    child.kill();
  }, 10000);
  try {
    await request("initialize", { clientInfo: { name: "session-title", version: "1.0.0" }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    await request("thread/name/set", { threadId, name: title });
    const result = await request("thread/read", { threadId, includeTurns: false }) as { thread?: { name?: string } };
    if (result.thread?.name !== title) throw new Error("Codex title read-back did not match the requested title");
    console.log(`codex thread: renamed and verified (${threadId})`);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
