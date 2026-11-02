import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "session-title-test-"));
const server = join(dir, "codex");
const log = join(dir, "rpc.jsonl");
writeFileSync(server, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
let name;
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.TEST_RPC_LOG, line + '\\n');
  if (!request.id) return;
  if (request.method === 'thread/name/set') {
    if (process.env.TEST_RPC_ERROR) {
      console.log(JSON.stringify({id:request.id,error:{message:'rename refused'}}));
      return;
    }
    name = request.params.name;
  }
  const result = request.method === 'thread/read' ? {thread:{name}} : {};
  console.log(JSON.stringify({id:request.id,result}));
});
`, { mode: 0o755 });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], extra: Record<string, string> = {}, input?: string) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "title.ts"), ...args], {
    env: {
      ...process.env,
      CODEX_THREAD_ID: "fixture-thread",
      CLAUDE_CODE_SESSION_ID: "",
      ORCA_TERMINAL_HANDLE: "",
      CODEX_APP_SERVER_BIN: server,
      TEST_RPC_LOG: log,
      ...extra,
    },
    stdin: input === undefined ? undefined : Buffer.from(input),
  });
}

test("Codex replaces an existing title and verifies it through RPC", () => {
  const result = run(["set", "标题 → 自动命名"]);
  expect(result.exitCode).toBe(0);
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(requests.map((request) => request.method)).toEqual([
    "initialize", "initialized", "thread/name/set", "thread/read",
  ]);
  expect(requests[2].params).toEqual({ threadId: "fixture-thread", name: "标题→自动命名" });
  expect(result.stdout.toString()).toContain("renamed and verified");
});

test("monitor mode constructs the shared monitor format", () => {
  const result = run(["watch", "CI全绿"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("title: 监控◉CI全绿");
});

for (const title of ["标题命名", "标题→12345678", "标题→结果→丢失", "监控→CI全绿", "其他◉CI全绿", "标题→"]) {
  test(`rejects invalid title ${title}`, () => {
    const result = run(["set", title]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("title rejected");
  });
}

test("RPC rejection fails visibly instead of reporting success", () => {
  const result = run(["set", "标题→自动命名"], { TEST_RPC_ERROR: "1" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("rename refused");
  expect(result.stdout.toString()).not.toContain("renamed and verified");
});

test("Claude routing preserves transcript and next-prompt hook behavior", () => {
  const config = join(dir, "claude");
  const project = join(config, "projects", "fixture");
  mkdirSync(project, { recursive: true });
  const transcript = join(project, "claude-fixture.jsonl");
  writeFileSync(transcript, "");
  const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "claude-fixture" };
  expect(run(["set", "标题→自动命名"], env).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(transcript, "utf8")).customTitle).toBe("标题→自动命名");
  const payload = JSON.stringify({ session_id: "claude-fixture" });
  const hook = run(["hook"], env, payload);
  expect(hook.exitCode).toBe(0);
  expect(JSON.parse(hook.stdout.toString()).hookSpecificOutput.sessionTitle).toBe("标题→自动命名");
  expect(run(["hook"], env, payload).stdout.toString()).toBe("");
});
