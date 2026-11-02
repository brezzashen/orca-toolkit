#!/usr/bin/env bun
/**
 * Sets a Claude Code or Codex session title using the shared acceptance-title format.
 * Codex uses app-server thread/name/set and verifies thread/read via codex.ts.
 *
 * `set "<title>"` accepts either form; `watch "<expected result>"` builds the monitor form.
 * `set`/`watch` (run by the model through Bash) writes the title to three places:
 *   1. the Orca tab title (`orca terminal rename`) — visible at once;
 *   2. a `custom-title` record in the session transcript — /resume reads it, and the running
 *      session adopts it on its next metadata re-read (undocumented, seen on 2.1.291);
 *   3. a pending file that the `hook` mode turns into the live Claude Code title.
 * `hook` (run by the UserPromptSubmit hook) reads stdin, consumes the pending file of that
 * session and prints `hookSpecificOutput.sessionTitle` — the documented path, which guarantees
 * the title on the next prompt if the transcript re-read ever stops working.
 *
 * If `hook` prints anything but valid hook JSON, every prompt in every session of the profile
 * gets a hook error. Keep it silent and exit 0 on all failures.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_CHARS = 10;
const ARROW = "→";
const WATCH_PREFIX = "监控";
const WATCH_MARK = "◉";

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const pendingDir = join(configDir, "state", "session-title");
const pendingPath = (sessionId: string) => join(pendingDir, `${sessionId}.txt`);

function findTranscript(sessionId: string): string | undefined {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function reject(title: string, problems: string[]): never {
  console.error(`title rejected: "${title}"\n- ${problems.join("\n- ")}`);
  process.exit(2);
}

function clean(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s*([→◉])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function commonProblems(title: string): string[] {
  const problems: string[] = [];
  if ([...title].length > MAX_CHARS) problems.push(`is ${[...title].length} chars, limit is ${MAX_CHARS}`);
  if (/pasted|content id|<\/?\w+>/i.test(title)) problems.push("contains prompt residue (Pasted / content id / tags)");
  return problems;
}

function validateWatch(result: string): string {
  const title = `${WATCH_PREFIX}${WATCH_MARK}${result}`;
  const problems = commonProblems(title);
  if (!result) problems.push(`expected result (right of ${WATCH_MARK}) is empty`);
  if (result.includes(ARROW) || result.includes(WATCH_MARK)) problems.push(`monitor result must not contain "${ARROW}" or "${WATCH_MARK}"`);
  if (problems.length) reject(title, problems);
  return title;
}

function validate(raw: string): string {
  const title = clean(raw);
  if (title.includes(WATCH_MARK)) {
    const [prefix, ...result] = title.split(WATCH_MARK);
    if (prefix !== WATCH_PREFIX) reject(title, [`monitor form must start with "${WATCH_PREFIX}${WATCH_MARK}"`]);
    return validateWatch(result.join(WATCH_MARK));
  }
  const problems = commonProblems(title);
  if (!title.includes(ARROW)) problems.push(`must contain "${ARROW}" between acceptance item and expected result`);
  const parts = title.split(ARROW).map((part) => part.trim());
  if (parts.length !== 2) problems.push("edit form must contain exactly one arrow");
  const [item, result] = parts;
  if (!item) problems.push("acceptance item (left of →) is empty");
  if (!result) problems.push("expected result (right of →) is empty");
  if (item === WATCH_PREFIX) problems.push(`monitoring uses the "${WATCH_PREFIX}${WATCH_MARK}<result>" form; run \`watch "<result>"\``);
  if (problems.length) reject(title, problems);
  return `${item}${ARROW}${result}`;
}

async function set(title: string): Promise<void> {
  if (process.env.CODEX_THREAD_ID && !process.env.CLAUDE_CODE_SESSION_ID) {
    const { setCodexTitle } = await import("./codex");
    await setCodexTitle(process.env.CODEX_THREAD_ID, title);
    renameOrca(title);
    console.log(`title: ${title}`);
    return;
  }
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    console.error("No session ID: run from Claude Code or Codex (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID)");
    process.exit(1);
  }

  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(pendingPath(sessionId), title);
  console.log("hook fallback: queued for the next prompt");

  const transcript = findTranscript(sessionId);
  if (transcript) {
    appendFileSync(transcript, `${JSON.stringify({ type: "custom-title", customTitle: title, sessionId })}\n`);
    console.log(`resume list: written to ${transcript}`);
  } else {
    console.log("resume list: transcript not found, skipped");
  }

  renameOrca(title);
  console.log(`title: ${title}`);
}

function renameOrca(title: string): void {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (handle) {
    const bin = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : join(process.env.ORCA_CLI_BIN_DIR || "/Applications/Orca.app/Contents/Resources/bin", "orca"));
    const run = spawnSync(bin, ["terminal", "rename", "--terminal", handle, "--title", title], { encoding: "utf8", timeout: 5000 });
    console.log(run.status === 0 ? "orca tab: renamed" : `orca tab: rename failed (${(run.stderr || run.error?.message || "").trim()})`);
  } else {
    console.log("orca tab: not an Orca pane, skipped");
  }
}

function hook(): void {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}") as { session_id?: string };
    if (!input.session_id) return;
    const path = pendingPath(input.session_id);
    if (!existsSync(path)) return;
    const title = readFileSync(path, "utf8").trim();
    rmSync(path, { force: true });
    if (!title) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } }));
  } catch {
    // A broken pending file must never block the user's prompt.
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "set") await set(validate(rest.join(" ")));
else if (mode === "watch") await set(validateWatch(clean(rest.join(" "))));
else if (mode === "hook") hook();
else {
  console.error('usage: title.ts set "<acceptance item>→<expected result>" | title.ts watch "<expected result>" | title.ts hook');
  process.exit(1);
}
