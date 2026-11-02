#!/usr/bin/env node
// Bridge Antigravity CLI (agy / ag1) transcripts and hook events into Orca's native Chat UI.
//
// Why this exists:
// Orca 1.4.224's terminal-backed Chat UI (`viewMode: "chat"`) only enables transcript streaming
// for providers in `['claude', 'openclaude', 'codex', 'grok', 'omp', 'opencode', 'opencode2']`.
// Antigravity writes live step logs to:
//   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
// (and a compact version to `transcript.jsonl`).
//
// This bridge:
// 1. Incrementally converts Antigravity's `transcript_full.jsonl` (with fallback to
//    `transcript.jsonl`) into a Claude-compatible JSONL transcript at:
//      ~/.claude/projects/<encoded $HOME>-antigravity-orca-bridge/<conversationId>.jsonl
//    mapping Antigravity tool calls (`run_command`, `view_file`, `replace_file_content`,
//    `multi_replace_file_content`, `write_to_file`, `grep_search`, `find_by_name`, `list_dir`,
//    `read_url_content`, `search_web`, `ask_question`) to Orca's rich tool card schemas (`Bash`,
//    `Read`, `Edit`, `MultiEdit`, `Write`, `Grep`, `Glob`, `WebFetch`, `WebSearch`,
//    `AskUserQuestion`) so inline diffs, clickable file links, and command cards render natively.
// 2. Forwards normalized lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
//    `PostToolUse`, `Stop`) to Orca's local hook server (`/hook/claude`) with the converted
//    `transcript_path`, preserving Antigravity's `fullyIdle=false` and post-Stop bookkeeping
//    guards.
// 3. Spawns a lightweight background file watcher during active turns so intermediate planner
//    responses and tool outputs stream into Orca's Chat UI between hook invocations.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HOME = os.homedir();
const BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');
const BRIDGE_PROJECT_DIR = path.join(
  HOME,
  '.claude',
  'projects',
  // Claude Code names a project directory after its path with every non-alphanumeric character as '-'.
  `${HOME.replace(/[^A-Za-z0-9]/g, '-')}-antigravity-orca-bridge`,
);
const STATE_DIR = path.join(HOME, '.orca', 'agent-hooks', 'antigravity-state');
const HOOK_SH_PATH = path.join(HOME, '.orca', 'agent-hooks', 'antigravity-hook.sh');
const MAX_FIELD_CHARS = 48_000;

const EXPECTED_HOOK_SH = `#!/bin/sh
# Antigravity -> Orca Chat UI hook bridge.
# Invoked by ~/.gemini/config/hooks.json on PreInvocation, PostInvocation, Stop, PreToolUse, PostToolUse.

NODE_BIN=""
for candidate in "$HOME/.local/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(command -v node 2>/dev/null)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -n "$NODE_BIN" ] && [ -f "$HOME/.orca/agent-hooks/antigravity-chat-sync.mjs" ]; then
  if "$NODE_BIN" "$HOME/.orca/agent-hooks/antigravity-chat-sync.mjs"; then
    exit 0
  fi
fi

case "\${ORCA_ANTIGRAVITY_EVENT:-}" in
  Stop) printf '{"decision":""}\\n' ;;
  PreToolUse) printf '{"decision":"ask"}\\n' ;;
  *) printf '{}\\n' ;;
esac
{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :
exit 0
`;

function ensureDirs() {
  fs.mkdirSync(BRIDGE_PROJECT_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

const ORCA_TOOLKIT_REPO_DIR = process.env.ORCA_TOOLKIT_DIR || path.join(HOME, 'orca-toolkit');
const GEMINI_HOOKS_PATH = path.join(HOME, '.gemini', 'config', 'hooks.json');
const CHAT_SYNC_MJS_PATH = path.join(HOME, '.orca', 'agent-hooks', 'antigravity-chat-sync.mjs');
const CHAT_IMAGE_MJS_PATH = path.join(HOME, '.orca', 'agent-hooks', 'orca-chat-image.mjs');
const CHAT_IMAGE_BIN_PATH = path.join(HOME, '.local', 'bin', 'orca-chat-image');
const LAUNCH_AGENT_PLIST_PATH = path.join(
  HOME,
  'Library',
  'LaunchAgents',
  'local.orca-toolkit.antigravity-patch.plist',
);

const EXPECTED_LAUNCH_AGENT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.orca-toolkit.antigravity-patch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>for n in "$HOME/.local/bin/node" "/opt/homebrew/bin/node" "/usr/local/bin/node"; do if [ -x "$n" ]; then exec "$n" "$HOME/.orca/agent-hooks/antigravity-chat-sync.mjs" --patch-orca >/dev/null 2>&amp;1; fi; done</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>15</integer>
</dict>
</plist>
`;

function buildAntigravityHookCommand(eventName) {
  const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const scriptSq = sq(HOOK_SH_PATH);
  const eventSq = sq(eventName);
  const drain = '{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :';
  const fallback =
    eventName === 'PreToolUse'
      ? `printf '%s\\n' ${sq('{"decision":"ask"}')}; ${drain}`
      : drain;
  const inner = `if [ -f ${scriptSq} ] && [ -r ${scriptSq} ] && [ -x ${scriptSq} ]; then ORCA_ANTIGRAVITY_EVENT=${eventSq} /bin/sh ${scriptSq}; else ${fallback}; fi`;
  return `/bin/sh -c ${sq(inner)}`;
}

function ensureGeminiHooksJson() {
  try {
    fs.mkdirSync(path.dirname(GEMINI_HOOKS_PATH), { recursive: true });
    let parsed = {};
    let raw = '';
    if (fs.existsSync(GEMINI_HOOKS_PATH)) {
      raw = fs.readFileSync(GEMINI_HOOKS_PATH, 'utf8');
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsed = obj;
        }
      } catch {
        parsed = {};
      }
    }
    const existingStatus =
      parsed['orca-status'] && typeof parsed['orca-status'] === 'object'
        ? parsed['orca-status']
        : {};
    const expectedStatus = {
      ...existingStatus,
      PreInvocation: [
        {
          type: 'command',
          command: buildAntigravityHookCommand('PreInvocation'),
          timeout: 10,
        },
      ],
      PostInvocation: [
        {
          type: 'command',
          command: buildAntigravityHookCommand('PostInvocation'),
          timeout: 10,
        },
      ],
      Stop: [
        {
          type: 'command',
          command: buildAntigravityHookCommand('Stop'),
          timeout: 10,
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: buildAntigravityHookCommand('PreToolUse'),
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: buildAntigravityHookCommand('PostToolUse'),
              timeout: 10,
            },
          ],
        },
      ],
    };
    const nextConfig = {
      ...parsed,
      'orca-status': expectedStatus,
    };
    const nextSerialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
    if (raw !== nextSerialized) {
      fs.writeFileSync(GEMINI_HOOKS_PATH, nextSerialized, 'utf8');
    }
  } catch {}
}

function ensureSymlinkToRepo(livePath, repoRelativePath) {
  try {
    const repoTarget = path.join(ORCA_TOOLKIT_REPO_DIR, repoRelativePath);
    if (!fs.existsSync(repoTarget)) return;
    try {
      fs.chmodSync(repoTarget, 0o755);
    } catch {}
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    let currentLink = '';
    try {
      currentLink = fs.readlinkSync(livePath);
    } catch {}
    if (currentLink !== repoTarget) {
      try {
        fs.unlinkSync(livePath);
      } catch {}
      fs.symlinkSync(repoTarget, livePath);
    }
  } catch {}
}

export function ensureHookScriptInstalled() {
  ensureDirs();
  ensureSymlinkToRepo(CHAT_SYNC_MJS_PATH, path.join('agent-hooks', 'antigravity-chat-sync.mjs'));
  ensureSymlinkToRepo(CHAT_IMAGE_MJS_PATH, path.join('agent-hooks', 'orca-chat-image.mjs'));

  try {
    const current = fs.existsSync(HOOK_SH_PATH) ? fs.readFileSync(HOOK_SH_PATH, 'utf8') : '';
    if (current !== EXPECTED_HOOK_SH) {
      try {
        execFileSync('chflags', ['nouchg', HOOK_SH_PATH], { stdio: 'ignore' });
      } catch {}
      fs.writeFileSync(HOOK_SH_PATH, EXPECTED_HOOK_SH, { mode: 0o755 });
      fs.chmodSync(HOOK_SH_PATH, 0o755);
    }
    try {
      execFileSync('chflags', ['uchg', HOOK_SH_PATH], { stdio: 'ignore' });
    } catch {}
  } catch {
    // Ignore if HOOK_SH_PATH is already locked (uchg) and points to antigravity-chat-sync.mjs.
  }

  ensureGeminiHooksJson();

  try {
    if (fs.existsSync(CHAT_IMAGE_MJS_PATH)) {
      try {
        fs.chmodSync(CHAT_IMAGE_MJS_PATH, 0o755);
      } catch {}
      fs.mkdirSync(path.dirname(CHAT_IMAGE_BIN_PATH), { recursive: true });
      let currentTarget = '';
      try {
        currentTarget = fs.readlinkSync(CHAT_IMAGE_BIN_PATH);
      } catch {}
      if (currentTarget !== CHAT_IMAGE_MJS_PATH) {
        try {
          fs.unlinkSync(CHAT_IMAGE_BIN_PATH);
        } catch {}
        fs.symlinkSync(CHAT_IMAGE_MJS_PATH, CHAT_IMAGE_BIN_PATH);
      }
    }
  } catch {}

  try {
    if (process.platform === 'darwin') {
      fs.mkdirSync(path.dirname(LAUNCH_AGENT_PLIST_PATH), { recursive: true });
      const currentPlist = fs.existsSync(LAUNCH_AGENT_PLIST_PATH)
        ? fs.readFileSync(LAUNCH_AGENT_PLIST_PATH, 'utf8')
        : '';
      if (currentPlist !== EXPECTED_LAUNCH_AGENT_PLIST) {
        fs.writeFileSync(LAUNCH_AGENT_PLIST_PATH, EXPECTED_LAUNCH_AGENT_PLIST, 'utf8');
        try {
          execFileSync('launchctl', ['load', '-w', LAUNCH_AGENT_PLIST_PATH], {
            stdio: 'ignore',
            timeout: 1500,
          });
        } catch {}
      }
    }
  } catch {}
}

function capText(text, maxChars = MAX_FIELD_CHARS) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars for Chat UI]`;
}

function extractUserRequest(raw) {
  if (typeof raw !== 'string') return '';
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const text = match ? match[1] : raw;
  return text.trim();
}

function cleanToolOutput(raw) {
  if (typeof raw !== 'string') return '';
  return capText(
    raw
      .replace(/^Created At:\s*[^\r\n]+\r?\nCompleted At:\s*[^\r\n]+\r?\n\r?\n/, '')
      .trim(),
  );
}

function decodeCompactArgValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}

function normalizeToolArgs(rawArgs, isCompactFallback = false) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  if (!isCompactFallback) return rawArgs;
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = decodeCompactArgValue(v);
  }
  return out;
}

function toFiniteNumber(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && /^\d+$/.test(val.trim())) return Number(val.trim());
  return undefined;
}

function mapAntigravityToolCall(tc, isCompactFallback = false) {
  const name = typeof tc?.name === 'string' ? tc.name : 'tool';
  const args = normalizeToolArgs(tc?.args, isCompactFallback);
  switch (name) {
    case 'run_command':
      return {
        name: 'Bash',
        input: {
          command: capText(String(args.CommandLine ?? args.command ?? '')),
          ...(args.toolSummary || args.toolAction
            ? { description: String(args.toolSummary || args.toolAction) }
            : {}),
        },
      };
    case 'view_file': {
      const start = toFiniteNumber(args.StartLine);
      const end = toFiniteNumber(args.EndLine);
      return {
        name: 'Read',
        input: {
          file_path: String(args.AbsolutePath ?? args.path ?? ''),
          ...(start !== undefined ? { offset: start } : {}),
          ...(start !== undefined && end !== undefined && end >= start
            ? { limit: end - start + 1 }
            : {}),
        },
      };
    }
    case 'replace_file_content':
      return {
        name: 'Edit',
        input: {
          file_path: String(args.TargetFile ?? args.path ?? ''),
          old_string: capText(String(args.TargetContent ?? '')),
          new_string: capText(String(args.ReplacementContent ?? '')),
        },
      };
    case 'multi_replace_file_content':
      return {
        name: 'MultiEdit',
        input: {
          file_path: String(args.TargetFile ?? args.path ?? ''),
          edits: Array.isArray(args.ReplacementChunks)
            ? args.ReplacementChunks.map((chunk) => ({
                old_string: capText(String(chunk?.TargetContent ?? '')),
                new_string: capText(String(chunk?.ReplacementContent ?? '')),
              }))
            : [],
        },
      };
    case 'write_to_file':
      return {
        name: 'Write',
        input: {
          file_path: String(args.TargetFile ?? args.path ?? ''),
          content: capText(String(args.CodeContent ?? '')),
        },
      };
    case 'grep_search':
      return {
        name: 'Grep',
        input: {
          pattern: String(args.Query ?? args.query ?? ''),
          ...(args.SearchPath ? { path: String(args.SearchPath) } : {}),
        },
      };
    case 'find_by_name':
      return {
        name: 'Glob',
        input: {
          pattern: String(args.Pattern ?? '*'),
          ...(args.SearchDirectory ? { path: String(args.SearchDirectory) } : {}),
        },
      };
    case 'list_dir':
      return {
        name: 'Glob',
        input: {
          pattern: '*',
          ...(args.DirectoryPath ? { path: String(args.DirectoryPath) } : {}),
        },
      };
    case 'read_url_content':
      return {
        name: 'WebFetch',
        input: {
          url: String(args.Url ?? args.url ?? ''),
        },
      };
    case 'search_web':
      return {
        name: 'WebSearch',
        input: {
          query: String(args.query ?? args.Query ?? ''),
        },
      };
    case 'ask_question':
      return {
        name: 'AskUserQuestion',
        input: {
          questions: Array.isArray(args.questions) ? args.questions : [],
        },
      };
    default:
      return {
        name,
        input: args,
      };
  }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial line at EOF while agy is actively writing.
    }
  }
  return out;
}

function extractPreservedCustomTitleLines(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('"type":"custom-title"') || l.includes('"type": "custom-title"'));
  } catch {
    return [];
  }
}

function acquireSyncLock(lockPath, waitMs = 250) {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid), 'utf8');
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 3000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export function syncTranscript(conversationId, explicitSourcePath, options = {}) {
  if (!conversationId) return null;
  ensureDirs();
  const validExplicit =
    typeof explicitSourcePath === 'string' &&
    explicitSourcePath.length > 0 &&
    !explicitSourcePath.startsWith('--') &&
    fs.existsSync(explicitSourcePath)
      ? explicitSourcePath
      : null;
  const logsDir = validExplicit
    ? path.dirname(validExplicit)
    : path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs');
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');
  const compactPath = validExplicit || path.join(logsDir, 'transcript.jsonl');
  const useFull = fs.existsSync(fullPath);
  const sourcePath = useFull ? fullPath : compactPath;
  const isCompactFallback = !useFull;

  const targetPath = path.join(BRIDGE_PROJECT_DIR, `${conversationId}.jsonl`);
  const cursorPath = path.join(STATE_DIR, `${conversationId}.cursor.json`);
  const lockPath = path.join(STATE_DIR, `${conversationId}.sync.lock`);

  if (!acquireSyncLock(lockPath, options.fromWatcher ? 0 : 250)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
      return {
        targetPath,
        lastUserPrompt: parsed.lastUserPrompt || '',
        lastAssistantMessage: parsed.lastAssistantMessage || '',
        stepCount: parsed.processedSteps || 0,
      };
    } catch {
      return {
        targetPath,
        lastUserPrompt: '',
        lastAssistantMessage: '',
        stepCount: 0,
      };
    }
  }

  try {
    if (!fs.existsSync(sourcePath)) {
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, '', 'utf8');
      }
      return {
        targetPath,
        lastUserPrompt: '',
        lastAssistantMessage: '',
        stepCount: 0,
      };
    }

    const steps = readJsonLines(sourcePath);

    let cursor = {
      processedSteps: 0,
      pendingCallIds: [],
      lastUuid: null,
      lastUserPrompt: '',
      lastAssistantMessage: '',
      lastStepState: 'idle',
      sourceKind: useFull ? 'full' : 'compact',
    };

  let needRebuild = Boolean(options.reset);
  if (!needRebuild && fs.existsSync(cursorPath) && fs.existsSync(targetPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
      if (
        typeof parsed?.processedSteps === 'number' &&
        parsed.processedSteps <= steps.length &&
        Array.isArray(parsed.pendingCallIds) &&
        parsed.sourceKind === cursor.sourceKind
      ) {
        cursor = parsed;
      } else {
        needRebuild = true;
      }
    } catch {
      needRebuild = true;
    }
  } else {
    needRebuild = true;
  }

  let preservedTitleLines = [];
  if (needRebuild) {
    preservedTitleLines = extractPreservedCustomTitleLines(targetPath);
    fs.writeFileSync(targetPath, '', 'utf8');
  }

  const newLines = [];
  for (let i = cursor.processedSteps; i < steps.length; i++) {
    const step = steps[i];
    const stepIndex = typeof step.step_index === 'number' ? step.step_index : i;
    const timestamp = step.created_at || new Date().toISOString();
    const uuid = `${conversationId}-step-${stepIndex}`;

    if (step.type === 'USER_INPUT') {
      const text = extractUserRequest(step.content);
      if (!text) continue;
      cursor.lastUserPrompt = text;
      cursor.pendingCallIds = [];
      cursor.lastStepState = 'working';
      const record = {
        type: 'user',
        uuid,
        ...(cursor.lastUuid ? { parentUuid: cursor.lastUuid } : {}),
        timestamp,
        sessionId: conversationId,
        message: {
          role: 'user',
          content: text,
        },
      };
      cursor.lastUuid = uuid;
      newLines.push(JSON.stringify(record));
    } else if (step.type === 'PLANNER_RESPONSE') {
      const contentBlocks = [];
      const text = typeof step.content === 'string' ? step.content.trim() : '';
      if (text) {
        contentBlocks.push({ type: 'text', text });
        cursor.lastAssistantMessage = text;
      }
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      toolCalls.forEach((tc, idx) => {
        const callId = `${conversationId}-call-${stepIndex}-${idx}`;
        cursor.pendingCallIds.push(callId);
        const mapped = mapAntigravityToolCall(tc, isCompactFallback);
        contentBlocks.push({
          type: 'tool_use',
          id: callId,
          name: mapped.name,
          input: mapped.input,
        });
      });
      if (contentBlocks.length === 0) continue;
      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      cursor.lastStepState = toolCalls.length > 0 ? 'working' : 'end_turn';
      const record = {
        type: 'assistant',
        uuid,
        ...(cursor.lastUuid ? { parentUuid: cursor.lastUuid } : {}),
        timestamp,
        sessionId: conversationId,
        message: {
          id: `msg-${uuid}`,
          role: 'assistant',
          stop_reason: stopReason,
          content: contentBlocks,
        },
      };
      cursor.lastUuid = uuid;
      newLines.push(JSON.stringify(record));
    } else if (step.type === 'GENERIC') {
      const callId =
        cursor.pendingCallIds.shift() || `${conversationId}-call-${stepIndex}-0`;
      const output = cleanToolOutput(step.content);
      const isError =
        step.status === 'ERROR' ||
        step.status === 'FAILED' ||
        /^Encountered error in tool execution:/m.test(output);
      cursor.lastStepState = 'working';
      const record = {
        type: 'user',
        uuid,
        ...(cursor.lastUuid ? { parentUuid: cursor.lastUuid } : {}),
        timestamp,
        sessionId: conversationId,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: callId,
              content: output || '(completed)',
              is_error: isError,
            },
          ],
        },
      };
      cursor.lastUuid = uuid;
      newLines.push(JSON.stringify(record));
    } else if (step.type === 'ERROR_MESSAGE') {
      const errText = typeof step.content === 'string' ? step.content.trim() : '';
      if (!errText) continue;
      cursor.lastStepState = 'end_turn';
      const record = {
        type: 'assistant',
        uuid,
        ...(cursor.lastUuid ? { parentUuid: cursor.lastUuid } : {}),
        timestamp,
        sessionId: conversationId,
        message: {
          id: `msg-${uuid}`,
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: `Error: ${errText}` }],
        },
      };
      cursor.lastUuid = uuid;
      newLines.push(JSON.stringify(record));
    }
  }

  if (preservedTitleLines.length > 0) {
    newLines.push(...preservedTitleLines);
  }

  cursor.processedSteps = steps.length;
  if (newLines.length > 0) {
    fs.appendFileSync(targetPath, `${newLines.join('\n')}\n`, 'utf8');
  }
  fs.writeFileSync(cursorPath, JSON.stringify(cursor), 'utf8');
  return {
    targetPath,
    lastUserPrompt: cursor.lastUserPrompt,
    lastAssistantMessage: cursor.lastAssistantMessage,
    lastStepState: cursor.lastStepState || 'idle',
    stepCount: cursor.processedSteps,
  };
  } finally { try { fs.unlinkSync(lockPath); } catch {} }
}

function loadEndpointEnv(env) {
  const endpointFile = env.ORCA_AGENT_HOOK_ENDPOINT;
  const out = { ...env };
  if (endpointFile && fs.existsSync(endpointFile)) {
    try {
      const content = fs.readFileSync(endpointFile, 'utf8');
      for (const line of content.split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/.exec(line);
        if (!m) continue;
        let val = m[2].trim();
        if (
          (val.startsWith("'") && val.endsWith("'")) ||
          (val.startsWith('"') && val.endsWith('"'))
        ) {
          val = val.slice(1, -1);
        }
        out[m[1]] = val;
      }
    } catch {
      // Keep process env fallback.
    }
  }
  return out;
}

function rendererAntigravityIconSync(storeFiles, catalogFiles, fallbackAgSrc, tabActionFiles) {
  return (async () => {
    try {
      let chatLinkStyleEl = document.getElementById('orca-chat-link-style');
      if (!chatLinkStyleEl) {
        chatLinkStyleEl = document.createElement('style');
        chatLinkStyleEl.id = 'orca-chat-link-style';
        document.head.appendChild(chatLinkStyleEl);
      }
      const chatLinkCss = [
        ':root, .native-chat-appearance {',
        '  --orca-chat-link-color: #2563eb;',
        '  --orca-chat-link-hover-color: #1d4ed8;',
        '}',
        '.dark, .dark .native-chat-appearance, .native-chat-appearance[style*="color-scheme: dark"], .native-chat-appearance[style*="color-scheme:dark"] {',
        '  --orca-chat-link-color: #60a5fa;',
        '  --orca-chat-link-hover-color: #93c5fd;',
        '}',
        '.native-chat-appearance[style*="color-scheme: light"], .native-chat-appearance[style*="color-scheme:light"] {',
        '  --orca-chat-link-color: #2563eb;',
        '  --orca-chat-link-hover-color: #1d4ed8;',
        '}',
        '.native-chat-markdown a,',
        '[data-native-chat-message-tone="faint"] .native-chat-markdown a,',
        '[data-native-chat-root] .native-chat-message-text a,',
        '.native-chat-markdown a :is(strong, b, em, i, code, span),',
        '[data-native-chat-message-tone="faint"] .native-chat-markdown a :is(strong, b, em, i, code, span),',
        '[data-native-chat-root] .native-chat-message-text a :is(strong, b, em, i, code, span) {',
        '  color: var(--orca-chat-link-color) !important;',
        '  -webkit-text-decoration-color: color-mix(in srgb, var(--orca-chat-link-color) 65%, transparent) !important;',
        '  text-decoration-color: color-mix(in srgb, var(--orca-chat-link-color) 65%, transparent) !important;',
        '}',
        '.native-chat-markdown a code,',
        '[data-native-chat-message-tone="faint"] .native-chat-markdown a code,',
        '[data-native-chat-root] .native-chat-message-text a code {',
        '  border-color: color-mix(in srgb, var(--orca-chat-link-color) 32%, transparent) !important;',
        '  background: color-mix(in srgb, var(--orca-chat-link-color) 10%, var(--chat-inline-code-surface)) !important;',
        '}',
        '.native-chat-markdown a:hover,',
        '[data-native-chat-message-tone="faint"] .native-chat-markdown a:hover,',
        '[data-native-chat-root] .native-chat-message-text a:hover,',
        '.native-chat-markdown a:hover :is(strong, b, em, i, code, span),',
        '[data-native-chat-message-tone="faint"] .native-chat-markdown a:hover :is(strong, b, em, i, code, span),',
        '[data-native-chat-root] .native-chat-message-text a:hover :is(strong, b, em, i, code, span) {',
        '  color: var(--orca-chat-link-hover-color) !important;',
        '  -webkit-text-decoration-color: var(--orca-chat-link-hover-color) !important;',
        '  text-decoration-color: var(--orca-chat-link-hover-color) !important;',
        '}',
      ].join('\n');
      if (chatLinkStyleEl.textContent !== chatLinkCss) {
        chatLinkStyleEl.textContent = chatLinkCss;
      }

      const tabActionCandidates = Array.isArray(tabActionFiles)
        ? tabActionFiles
        : tabActionFiles
          ? [tabActionFiles]
          : [];
      for (const taf of tabActionCandidates) {
        if (!taf) continue;
        try {
          const mod = await import('./assets/' + taf);
          const closeStore = Object.values(mod).find(
            (v) =>
              v &&
              typeof v.getState === 'function' &&
              typeof v.setState === 'function' &&
              'runningTerminalCloseConfirm' in (v.getState() || {}),
          );
          if (closeStore && !closeStore.getState().__orcaFastClosePatched) {
            const mergeConfirm = (a, bReq) => ({
              ...a,
              onConfirm: () => {
                a.onConfirm();
                bReq.onConfirm();
              },
              onCancel: () => {
                a.onCancel?.();
                bReq.onCancel?.();
              },
            });
            const queue = [];
            const popNext = () => {
              const next = queue.shift() ?? null;
              closeStore.setState({ runningTerminalCloseConfirm: next });
              return next !== null;
            };
            closeStore.setState({
              __orcaFastClosePatched: true,
              requestRunningTerminalCloseConfirm: (req) => {
                const cur = closeStore.getState().runningTerminalCloseConfirm;
                if (cur?.terminalTabId === req.terminalTabId) {
                  closeStore.setState({ runningTerminalCloseConfirm: mergeConfirm(cur, req) });
                  return;
                }
                const idx = queue.findIndex((item) => item.terminalTabId === req.terminalTabId);
                if (idx === -1) {
                  if (cur) queue.push(req);
                  else closeStore.setState({ runningTerminalCloseConfirm: req });
                } else {
                  queue[idx] = mergeConfirm(queue[idx], req);
                }
              },
              confirmRunningTerminalClose: () => {
                const cur = closeStore.getState().runningTerminalCloseConfirm;
                if (!cur) return;
                popNext();
                cur.onConfirm();
              },
              confirmAllRunningTerminalCloses: () => {
                const all = [closeStore.getState().runningTerminalCloseConfirm, ...queue.splice(0)];
                closeStore.setState({ runningTerminalCloseConfirm: null });
                for (const item of all) item?.onConfirm();
              },
              dismissRunningTerminalClose: () => {
                const cur = closeStore.getState().runningTerminalCloseConfirm;
                if (!cur) return;
                popNext();
                cur.onCancel?.();
              },
            });
            break;
          }
        } catch {}
      }

      const storeCandidates = Array.isArray(storeFiles) ? storeFiles : [storeFiles];
      const catalogCandidates = Array.isArray(catalogFiles) ? catalogFiles : [catalogFiles];

      let store = null;
      let storeMod = null;
      for (const sf of storeCandidates) {
        if (!sf) continue;
        try {
          const mod = await import('./assets/' + sf);
          const candidates = Object.values(mod).filter(
            (v) => v && typeof v.getState === 'function' && typeof v.subscribe === 'function',
          );
          const found =
            candidates.find((v) => {
              try {
                const st = v.getState();
                return Boolean(
                  st &&
                    typeof st === 'object' &&
                    ('agentStatusByPaneKey' in st || 'tabsByWorktree' in st),
                );
              } catch {
                return false;
              }
            }) || null;
          if (found) {
            store = found;
            storeMod = mod;
            break;
          }
        } catch {}
      }

      let agSrc = typeof fallbackAgSrc === 'string' && fallbackAgSrc ? fallbackAgSrc : null;
      for (const cf of catalogCandidates) {
        if (!cf) continue;
        try {
          const mod = await import('./assets/' + cf);
          for (const v of Object.values(mod)) {
            if (typeof v === 'function') {
              try {
                const el = v({ agent: 'antigravity', size: 12 });
                const claudeEl = v({ agent: 'claude', size: 12 });
                const claudeSrc = claudeEl && claudeEl.props ? claudeEl.props.src : undefined;
                if (
                  el &&
                  el.props &&
                  typeof el.props.src === 'string' &&
                  el.props.src !== claudeSrc
                ) {
                  agSrc = el.props.src;
                  break;
                }
              } catch {}
            }
          }
          if (agSrc && agSrc !== fallbackAgSrc) break;
        } catch {}
      }

      if (!store) {
        return JSON.stringify({ ok: false, reason: 'missing store' });
      }

      // Resolve draft image attachment helpers from store module (pred-first so minified alias changes on Orca upgrade never match the wrong export)
      const findStoreFn = (alias, pred) => {
        if (!storeMod) return null;
        if (typeof storeMod[alias] === 'function') {
          try {
            if (!pred || pred(storeMod[alias].toString(), storeMod[alias])) {
              return storeMod[alias];
            }
          } catch {}
        }
        for (const v of Object.values(storeMod)) {
          if (typeof v === 'function') {
            try {
              if (pred && pred(v.toString(), v)) return v;
            } catch {}
          }
        }
        return null;
      };

      const appendImageAttachments = findStoreFn(
        'xx',
        (s, f) =>
          f.length >= 2 && s.includes('images:') && s.includes('.map(') && s.includes('fromUser'),
      );
      // Orca 1.4.227: u_(scopeKey, chip) strips previewUrl and appends to the pending-chip map.
      const beginPendingImageAttachment = findStoreFn(
        'mx',
        (s, f) => f.length === 2 && /\{previewUrl:\w+,\.\.\.\w+\}=\w+/.test(s),
      );
      const resolvePendingImageAttachment = findStoreFn(
        '_x',
        (s, f) =>
          f.length >= 3 &&
          s.includes('connectionId') &&
          s.includes('images:[{id:') &&
          s.includes('fromUser'),
      );
      // Orca 1.4.227: d_(scopeKey, chipId) finds the pending chip by id and filters it out.
      const dropPendingImageAttachment = findStoreFn(
        'yx',
        (s, f) =>
          f.length === 2 &&
          /\.find\(\w+=>\w+\.id===\w+\)/.test(s) &&
          s.includes('.filter('),
      );
      const resolveWorktreeRuntimeEnvironmentId = findStoreFn(
        'r_',
        (s) => s.includes('runtimeEnvironmentId') && s.includes('worktreesByRepo'),
      );
      const resolveTabWorktreeId = findStoreFn(
        't_',
        (s) => s.includes('tabsByWorktree') && s.includes('.some('),
      );

      window.__orcaRemoteChatImageCache = window.__orcaRemoteChatImageCache || new Map();

      const toFigmaDesktopUrl = (rawUrl) => {
        try {
          if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
          const u = new URL(rawUrl.trim());
          if (u.protocol === 'figma:') return u.toString();
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
          const host = u.hostname.toLowerCase();
          if (host !== 'figma.com' && host !== 'www.figma.com') return null;
          const openInBrowser = u.searchParams.get('openInBrowser');
          if (openInBrowser && openInBrowser !== '0' && openInBrowser !== 'false') return null;
          const cleanPath = u.pathname.replace(/^\/+/, '');
          if (!cleanPath || cleanPath.startsWith('file/employee/consent/confirm')) return null;
          const segs = cleanPath.split('/').filter(Boolean);
          const first = segs[0] || '';
          const filePrefixes = new Set([
            'design',
            'file',
            'board',
            'slides',
            'proto',
            'site',
            'buzz',
            'rev',
            'make',
            'weave',
            'spec',
            'deck',
            'presenter',
            'export',
          ]);
          const directPrefixes = new Set([
            'files',
            'make-local',
            'community',
            'c',
            'my_plugins',
            'idle_timeout',
            'ip_account_restriction',
            'user',
            'org',
            'team',
            'jam',
          ]);
          let ok = false;
          if (first.startsWith('@') && first.length > 1 && first.length <= 16) ok = true;
          else if (directPrefixes.has(first)) ok = true;
          else if (filePrefixes.has(first)) {
            if (segs.length === 1) ok = first === 'make';
            else if (segs[1] === 'new') ok = true;
            else if (segs.length >= 4 && segs[2] === 'image') ok = false;
            else ok = Boolean(segs[1]);
          }
          if (!ok) return null;
          return `figma://${cleanPath}${u.search || ''}${u.hash || ''}`;
        } catch {
          return null;
        }
      };
      window.__orcaToFigmaDesktopUrl = toFigmaDesktopUrl;

      try {
        if (window.api?.shell && !window.api.shell.__orcaFigmaUrlPatched) {
          const origOpenUrl = window.api.shell.openUrl?.bind(window.api.shell);
          if (origOpenUrl) {
            window.api.shell.openUrl = (url) => origOpenUrl(toFigmaDesktopUrl(url) || url);
            window.api.shell.__orcaFigmaUrlPatched = true;
          }
        }
      } catch {}

      try {
        const st0 = store.getState();
        if (
          typeof st0.createBrowserTab === 'function' &&
          !st0.createBrowserTab.__orcaFigmaUrlWrapped
        ) {
          const origCreateBrowserTab = st0.createBrowserTab;
          const wrappedCreateBrowserTab = (worktreeId, url, opts) => {
            const figmaUrl = toFigmaDesktopUrl(url);
            if (figmaUrl && window.api?.shell?.openUrl) {
              void window.api.shell.openUrl(figmaUrl);
              return null;
            }
            return origCreateBrowserTab(worktreeId, url, opts);
          };
          wrappedCreateBrowserTab.__orcaFigmaUrlWrapped = true;
          store.setState({ createBrowserTab: wrappedCreateBrowserTab });
        }
      } catch {}

      // Wrap window.api.fs / window.api.ui on web clients where window.api is mutable
      try {
        if (window.api && window.api.fs && !window.api.fs.__orcaRemoteChatPatched) {
          const origReadFile = window.api.fs.readFile?.bind(window.api.fs);
          const origPathExists = window.api.fs.pathExists?.bind(window.api.fs);
          try {
            window.api.fs.readFile = async (args) => {
              const fp = args && args.filePath;
              if (fp && window.__orcaRemoteChatImageCache.has(fp)) {
                const c = window.__orcaRemoteChatImageCache.get(fp);
                return {
                  content: c.base64,
                  isBinary: true,
                  isImage: true,
                  mimeType: c.mimeType || 'image/png',
                };
              }
              if (
                fp &&
                (fp.includes('/agent-session-attachments/') ||
                  fp.includes('/native-chat-pastes/') ||
                  /orca-paste-.*\.(png|jpe?g|gif|webp)$/i.test(fp))
              ) {
                try {
                  const res = await fetch(
                    './orca-chat-upload?path=' + encodeURIComponent(fp),
                  );
                  if (res.ok) {
                    const data = await res.json();
                    if (data && data.ok && data.content) {
                      window.__orcaRemoteChatImageCache.set(fp, {
                        base64: data.content,
                        mimeType: data.mimeType || 'image/png',
                      });
                      return {
                        content: data.content,
                        isBinary: true,
                        isImage: true,
                        mimeType: data.mimeType || 'image/png',
                      };
                    }
                  }
                } catch {}
              }
              return origReadFile ? origReadFile(args) : Promise.reject(new Error('No readFile'));
            };
            window.api.fs.pathExists = async (args) => {
              const fp = args && args.filePath;
              if (
                fp &&
                (window.__orcaRemoteChatImageCache.has(fp) ||
                  fp.includes('/agent-session-attachments/') ||
                  /orca-paste-.*\.(png|jpe?g|gif|webp)$/i.test(fp))
              ) {
                return true;
              }
              return origPathExists ? origPathExists(args) : false;
            };
            window.api.fs.__orcaRemoteChatPatched = true;
          } catch {}
        }
        if (window.api && window.api.ui && !window.api.ui.__orcaRemoteChatPatched) {
          const origRestore = window.api.ui.restoreNativeChatPastes?.bind(window.api.ui);
          try {
            window.api.ui.restoreNativeChatPastes = async (paths) => {
              const base = origRestore ? await origRestore(paths).catch(() => []) : [];
              const byPath = new Map((base || []).map((x) => [x.path, x]));
              return (Array.isArray(paths) ? paths : []).map((p) => {
                const existing = byPath.get(p);
                if (existing && existing.kept && existing.exists) return existing;
                if (
                  window.__orcaRemoteChatImageCache.has(p) ||
                  p.includes('/agent-session-attachments/') ||
                  /orca-paste-.*\.(png|jpe?g|gif|webp)$/i.test(p)
                ) {
                  return { path: p, kept: true, exists: true };
                }
                return existing || { path: p, kept: false, exists: false };
              });
            };
            window.api.ui.__orcaRemoteChatPatched = true;
          } catch {}
        }
      } catch {}

      const inspectComposerElement = (startEl) => {
        let box =
          startEl && startEl.closest
            ? startEl.closest('.native-chat-message-text[role="textbox"]')
            : null;
        if (!box) {
          const allBoxes = Array.from(
            document.querySelectorAll('.native-chat-message-text[role="textbox"]'),
          );
          box =
            allBoxes.find((b) => startEl && b.parentElement && b.closest('.bg-chat-canvas')?.contains(startEl)) ||
            allBoxes.find((b) => b.offsetParent !== null) ||
            allBoxes[0] ||
            null;
        }
        if (!box) return null;
        let el = box;
        let fk = null;
        while (el && !fk) {
          fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
          if (!fk) el = el.parentElement;
        }
        let cur = fk && el ? el[fk] : null;
        const info = {
          textboxEl: box,
          composerRootEl: box.closest('.bg-chat-canvas') || box.parentElement,
          draftScopeKey: null,
          terminalTabId: null,
          paneKey: null,
          targetPtyId: null,
          runtimeEnvironmentId: null,
          connectionId: null,
          loProps: null,
          qmProps: null,
        };
        for (let i = 0; i < 25 && cur; i++, cur = cur.return) {
          const p = cur.memoizedProps;
          if (!p || typeof p !== 'object') continue;
          if (!info.targetPtyId && typeof p.targetPtyId === 'string') {
            info.targetPtyId = p.targetPtyId;
          }
          if (!info.draftScopeKey && typeof p.scopeKey === 'string') {
            info.draftScopeKey = p.scopeKey;
          }
          if (typeof p.draftScopeKey === 'string' && typeof p.onSend === 'function') {
            info.draftScopeKey = p.draftScopeKey;
            info.loProps = p;
            if (p.attachmentEnvironmentId) {
              info.runtimeEnvironmentId = p.attachmentEnvironmentId;
            }
          }
          if (typeof p.terminalTabId === 'string' && typeof p.paneKey === 'string') {
            info.terminalTabId = p.terminalTabId;
            info.paneKey = p.paneKey;
            if (typeof p.targetPtyId === 'string') info.targetPtyId = p.targetPtyId;
            if (!info.draftScopeKey && typeof p.draftScopeKey === 'string') {
              info.draftScopeKey = p.draftScopeKey;
            }
            if (p.structuredTransport && p.structuredTransport.runtimeEnvironmentId) {
              info.runtimeEnvironmentId = p.structuredTransport.runtimeEnvironmentId;
            }
            info.qmProps = p;
          }
        }
        try {
          const st = store.getState();
          let wtId =
            info.terminalTabId && resolveTabWorktreeId
              ? resolveTabWorktreeId(st, info.terminalTabId)
              : null;
          if (!wtId && info.terminalTabId && st.tabsByWorktree) {
            for (const [candidateWtId, tabs] of Object.entries(st.tabsByWorktree)) {
              if (
                Array.isArray(tabs) &&
                tabs.some((t) => t && t.id === info.terminalTabId)
              ) {
                wtId = candidateWtId;
                break;
              }
            }
          }
          if (!wtId) wtId = st.activeWorktreeId || null;
          if (!info.runtimeEnvironmentId && wtId && resolveWorktreeRuntimeEnvironmentId) {
            info.runtimeEnvironmentId = resolveWorktreeRuntimeEnvironmentId(st, wtId) || null;
          }
          if (!info.runtimeEnvironmentId && wtId && st.worktreesByRepo) {
            for (const wts of Object.values(st.worktreesByRepo)) {
              const foundWt = Array.isArray(wts)
                ? wts.find((w) => w && w.id === wtId)
                : null;
              if (foundWt && foundWt.runtimeEnvironmentId) {
                info.runtimeEnvironmentId = foundWt.runtimeEnvironmentId;
                break;
              }
            }
          }
          if (!info.runtimeEnvironmentId && st.settings?.activeRuntimeEnvironmentId) {
            info.runtimeEnvironmentId = st.settings.activeRuntimeEnvironmentId;
          }
        } catch {}
        // Paired-runtime PTYs are `runtime:<envId>:...` or `remote:<envId>@@<terminalHandle>`
        // (terminal-backed Chat UI on an SSH-paired Mac); both must upload to that runtime.
        // The PTY owner wins over the store fallbacks and survives a store lookup failure.
        const ptyEnvMatch =
          typeof info.targetPtyId === 'string'
            ? /^(?:runtime|remote):([^:@]+)/.exec(info.targetPtyId)
            : null;
        if (ptyEnvMatch) info.runtimeEnvironmentId = ptyEnvMatch[1];
        const isWebClient =
          window.location.pathname.endsWith('/web-index.html') ||
          window.location.protocol === 'http:' ||
          window.location.protocol === 'https:';
        const isRemotePty =
          typeof info.targetPtyId === 'string' && /^(?:runtime|remote):/.test(info.targetPtyId);
        info.isRemoteOrWeb = Boolean(
          isWebClient || isRemotePty || info.runtimeEnvironmentId || !window.api?.fs?.getPathForFile,
        );
        return info;
      };

      // Remote Chat UI image log: console lines with this prefix are appended by the main process
      // to ~/Library/Logs/orca-remote-chat-image.log.
      const logRemoteImage = (step, detail = {}) => {
        try {
          console.info('[orca-remote-chat-image] ' + step + ' ' + JSON.stringify(detail));
        } catch {}
      };
      const summarizeComposer = (info) =>
        info
          ? {
              scope: info.draftScopeKey,
              pty: info.targetPtyId,
              env: info.runtimeEnvironmentId,
              attachEnv: info.loProps?.attachmentEnvironmentId || null,
              remote: Boolean(info.isRemoteOrWeb),
            }
          : null;

      const blobToPngBase64 = async (blob) => {
        const mime = (blob && blob.type) || 'image/png';
        if (mime === 'image/png') {
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          const step = 0x8000;
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
          }
          return { base64: btoa(binary), mimeType: 'image/png' };
        }
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth || img.width || 1;
              canvas.height = img.naturalHeight || img.height || 1;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              const dataUrl = canvas.toDataURL('image/png');
              URL.revokeObjectURL(url);
              const idx = dataUrl.indexOf(',');
              resolve({
                base64: idx !== -1 ? dataUrl.slice(idx + 1) : dataUrl,
                mimeType: 'image/png',
              });
            } catch (e) {
              URL.revokeObjectURL(url);
              reject(e);
            }
          };
          img.onerror = (e) => {
            URL.revokeObjectURL(url);
            reject(e);
          };
          img.src = url;
        });
      };

      const uploadBase64ViaHttp = async (base64, fileName, mimeType = 'image/png') => {
        const uploadId =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : 'up-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        const chunkSize = 384 * 1024; // < 512KB so nginx 1MB client_max_body_size never returns 413
        if (base64.length <= chunkSize) {
          const res = await fetch('./orca-chat-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contentBase64: base64,
              fileName: fileName || 'pasted-image.png',
              mimeType,
            }),
          });
          if (!res.ok) throw new Error('HTTP upload failed: ' + res.status);
          const data = await res.json();
          if (!data || !data.ok || !data.path) {
            throw new Error((data && data.error) || 'Upload returned no path');
          }
          return data.path;
        }
        let lastData = null;
        for (let offset = 0; offset < base64.length; offset += chunkSize) {
          const slice = base64.slice(offset, offset + chunkSize);
          const isLast = offset + chunkSize >= base64.length;
          const res = await fetch('./orca-chat-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uploadId,
              offset,
              chunkBase64: slice,
              commit: isLast,
              fileName: fileName || 'pasted-image.png',
              mimeType,
            }),
          });
          if (!res.ok) throw new Error('HTTP chunk upload failed: ' + res.status);
          lastData = await res.json();
        }
        if (!lastData || !lastData.ok || !lastData.path) {
          throw new Error((lastData && lastData.error) || 'Chunked upload returned no path');
        }
        return lastData.path;
      };

      const uploadAndAttachBlobs = async (blobsWithNames, composerInfo) => {
        if (!composerInfo || !composerInfo.draftScopeKey || !appendImageAttachments) {
          return [];
        }
        const scopeKey = composerInfo.draftScopeKey;
        const attachedPaths = [];
        logRemoteImage('upload-start', {
          composer: summarizeComposer(composerInfo),
          count: blobsWithNames.length,
        });
        for (const item of blobsWithNames) {
          const blob = item.blob;
          const fileName = item.name || 'pasted-image.png';
          const chipId =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : 'img-' + Date.now() + '-' + Math.random().toString(16).slice(2);
          if (beginPendingImageAttachment) {
            try {
              beginPendingImageAttachment(scopeKey, {
                id: chipId,
                path: '',
                pending: true,
                pendingName: fileName,
              });
            } catch {}
          }
          try {
            let base64 = item.base64 || '';
            let mimeType = item.mimeType || 'image/png';
            if (!base64 && blob) {
              const converted = await blobToPngBase64(blob);
              base64 = converted.base64;
              mimeType = converted.mimeType;
            }
            let remotePath = null;
            const isHttpWeb =
              window.location.protocol === 'http:' || window.location.protocol === 'https:';
            if (isHttpWeb && base64) {
              try {
                remotePath = await uploadBase64ViaHttp(base64, fileName, mimeType);
              } catch {}
            }
            if (!remotePath && window.api?.ui?.saveClipboardImageAsTempFile) {
              remotePath = await window.api.ui.saveClipboardImageAsTempFile({
                ...(composerInfo.runtimeEnvironmentId
                  ? { runtimeEnvironmentId: composerInfo.runtimeEnvironmentId }
                  : { forNativeChatDraft: true }),
                ...(composerInfo.connectionId ? { connectionId: composerInfo.connectionId } : {}),
                ...(base64 ? { __orcaImageBase64: base64, __orcaFileName: fileName } : {}),
              });
            }
            if (!remotePath && base64) {
              remotePath = await uploadBase64ViaHttp(base64, fileName, mimeType);
            }
            if (!remotePath) {
              throw new Error('Could not save or upload image');
            }
            if (base64) {
              window.__orcaRemoteChatImageCache.set(remotePath, {
                base64,
                mimeType,
              });
            }
            // resolvePending returns false when no pending chip exists (e.g. a mismatched helper),
            // so fall back to appending the attachment directly instead of dropping it silently.
            const resolved =
              resolvePendingImageAttachment && beginPendingImageAttachment
                ? resolvePendingImageAttachment(
                    scopeKey,
                    chipId,
                    remotePath,
                    composerInfo.connectionId || null,
                  )
                : false;
            logRemoteImage('upload-saved', { scope: scopeKey, path: remotePath, resolved });
            if (resolved !== true) {
              appendImageAttachments(
                scopeKey,
                [
                  {
                    id: chipId,
                    path: remotePath,
                    ...(composerInfo.connectionId
                      ? { connectionId: composerInfo.connectionId }
                      : {}),
                  },
                ],
                { fromUser: true },
              );
            }
            attachedPaths.push(remotePath);
          } catch (err) {
            if (dropPendingImageAttachment) {
              try {
                dropPendingImageAttachment(scopeKey, chipId);
              } catch {}
            }
            logRemoteImage('upload-failed', {
              scope: scopeKey,
              error: String((err && err.stack) || err),
            });
          }
        }
        try {
          composerInfo.textboxEl?.focus();
        } catch {}
        return attachedPaths;
      };

      // Expose global helper so HTTP server / CLI / external calls can attach or send directly in Chat UI
      window.__orcaAttachImageToChat = async (payload = {}) => {
        const allBoxes = Array.from(
          document.querySelectorAll('.native-chat-message-text[role="textbox"]'),
        );
        let targetInfo = null;
        for (const b of allBoxes) {
          const info = inspectComposerElement(b);
          if (!info) continue;
          if (payload.scopeKey && info.draftScopeKey === payload.scopeKey) {
            targetInfo = info;
            break;
          }
          if (payload.tabId && info.terminalTabId === payload.tabId) {
            targetInfo = info;
            break;
          }
          if (!targetInfo && b.offsetParent !== null) {
            targetInfo = info;
          }
        }
        if (!targetInfo && allBoxes[0]) {
          targetInfo = inspectComposerElement(allBoxes[0]);
        }
        if (!targetInfo || !targetInfo.draftScopeKey) {
          return { ok: false, reason: 'no-active-chat-composer' };
        }
        if (payload.path && payload.base64) {
          window.__orcaRemoteChatImageCache.set(payload.path, {
            base64: payload.base64,
            mimeType: payload.mimeType || 'image/png',
          });
        }
        let attachedPath = payload.path || null;
        const needsRemoteForward =
          Boolean(targetInfo.runtimeEnvironmentId) &&
          window.location.protocol === 'file:' &&
          Boolean(payload.base64) &&
          !payload.alreadyOnTargetRuntime;
        if (needsRemoteForward) {
          const res = await uploadAndAttachBlobs(
            [
              {
                base64: payload.base64,
                mimeType: payload.mimeType || 'image/png',
                name: payload.fileName || 'remote-upload.png',
              },
            ],
            targetInfo,
          );
          attachedPath = res[0] || attachedPath;
        } else if (attachedPath && appendImageAttachments) {
          const id =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : 'img-' + Date.now() + '-' + Math.random().toString(16).slice(2);
          appendImageAttachments(
            targetInfo.draftScopeKey,
            [{ id, path: attachedPath }],
            { fromUser: true },
          );
        } else if (payload.base64) {
          const res = await uploadAndAttachBlobs(
            [
              {
                base64: payload.base64,
                mimeType: payload.mimeType || 'image/png',
                name: payload.fileName || 'remote-upload.png',
              },
            ],
            targetInfo,
          );
          attachedPath = res[0] || null;
        }
        if (typeof payload.prompt === 'string' && payload.prompt.length > 0) {
          try {
            const ref = targetInfo.loProps?.textareaRef?.current;
            if (ref) {
              ref.value = payload.prompt;
              targetInfo.loProps?.onDraftChange?.(payload.prompt, ref);
            }
          } catch {}
        }
        if (payload.send) {
          await new Promise((r) => setTimeout(r, 120));
          const refreshed = inspectComposerElement(targetInfo.textboxEl);
          if (refreshed?.loProps?.onSend) {
            refreshed.loProps.onSend();
          }
        }
        return {
          ok: Boolean(attachedPath),
          path: attachedPath,
          scopeKey: targetInfo.draftScopeKey,
          tabId: targetInfo.terminalTabId,
        };
      };

      // Install capture listeners for paste, drop, and Attach (+) button in Chat UI
      if (window.__orcaRemoteChatPasteListener) {
        window.removeEventListener('paste', window.__orcaRemoteChatPasteListener, true);
      }
      if (window.__orcaRemoteChatDragOverListener) {
        window.removeEventListener('dragover', window.__orcaRemoteChatDragOverListener, true);
      }
      if (window.__orcaRemoteChatDropListener) {
        window.removeEventListener('drop', window.__orcaRemoteChatDropListener, true);
      }
      if (window.__orcaRemoteChatClickListener) {
        window.removeEventListener('click', window.__orcaRemoteChatClickListener, true);
      }

      window.__orcaRemoteChatPasteListener = (event) => {
        const target = event.target instanceof Element ? event.target : document.activeElement;
        const textbox = target?.closest?.('.native-chat-message-text[role="textbox"]');
        if (!textbox) return;
        const info = inspectComposerElement(textbox);
        logRemoteImage('dom-paste', { composer: summarizeComposer(info) });
        if (!info || !info.isRemoteOrWeb) return;

        const cd = event.clipboardData;
        const imageBlobs = [];
        if (cd && cd.items) {
          for (const item of Array.from(cd.items)) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const f = item.getAsFile();
              if (f) imageBlobs.push({ blob: f, name: f.name || 'pasted-image.png' });
            }
          }
        }
        if (imageBlobs.length === 0 && cd && cd.files) {
          for (const f of Array.from(cd.files)) {
            if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '')) {
              imageBlobs.push({ blob: f, name: f.name || 'pasted-image.png' });
            }
          }
        }
        const plainText = cd ? cd.getData('text/plain') : '';
        if (imageBlobs.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          uploadAndAttachBlobs(imageBlobs, info);
          return;
        }
        // In Electron Desktop, system clipboard image may have empty DataTransfer.items and empty text/plain
        if (
          plainText === '' &&
          (!cd || !cd.files || cd.files.length === 0) &&
          window.location.protocol === 'file:' &&
          window.api?.ui?.saveClipboardImageAsTempFile
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          uploadAndAttachBlobs([{ blob: null, name: 'pasted-image.png' }], info);
        }
      };

      window.__orcaRemoteChatDragOverListener = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const inChatCanvas = target.closest('.bg-chat-canvas') || target.closest('[data-native-chat-drop-overlay]');
        if (!inChatCanvas) return;
        const info = inspectComposerElement(target);
        if (!info || !info.isRemoteOrWeb) return;
        if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      };

      window.__orcaRemoteChatDropListener = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const info = inspectComposerElement(target);
        logRemoteImage('drop', {
          composer: summarizeComposer(info),
          files: (event.dataTransfer?.files || []).length,
        });
        if (!info || !info.isRemoteOrWeb) return;
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length === 0) return;
        const imageFiles = files.filter(
          (f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || ''),
        );
        if (imageFiles.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        try {
          document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        } catch {}
        uploadAndAttachBlobs(
          imageFiles.map((f) => ({ blob: f, name: f.name || 'dropped-image.png' })),
          info,
        );
      };

      window.__orcaRemoteChatClickListener = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const anchor = target?.closest?.('a[href]');
        if (anchor && event.button === 0 && !event.altKey) {
          const figmaUrl = toFigmaDesktopUrl(anchor.href || anchor.getAttribute('href') || '');
          if (figmaUrl && window.api?.shell?.openUrl) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            void window.api.shell.openUrl(figmaUrl);
            return;
          }
        }
        const btn = target?.closest?.('button[type="button"]');
        if (!btn) return;
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        // Only the composer's "Attach file" button; chip buttons such as "Remove attachment"
        // also contain "attach" and must keep their native behavior.
        const isAttachButton =
          /^attach\b/.test(label) || label === '附件' || label.startsWith('添加附件');
        if (!isAttachButton) return;
        const info = inspectComposerElement(btn);
        logRemoteImage('attach-click', { label, composer: summarizeComposer(info) });
        if (!info || !info.isRemoteOrWeb) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        let picker = document.getElementById('orca-remote-chat-file-picker');
        if (!picker) {
          picker = document.createElement('input');
          picker.id = 'orca-remote-chat-file-picker';
          picker.type = 'file';
          picker.accept = 'image/*';
          picker.multiple = true;
          picker.style.display = 'none';
          document.body.appendChild(picker);
        }
        picker.value = '';
        picker.onchange = () => {
          const picked = Array.from(picker.files || []);
          if (picked.length > 0) {
            uploadAndAttachBlobs(
              picked.map((f) => ({ blob: f, name: f.name || 'attached-image.png' })),
              info,
            );
          }
        };
        picker.click();
      };

      // Orca's Cmd+V path (composer.pasteFromClipboard) never fires a DOM paste event and shows
      // "Local attachments are not available for remote sessions." for terminal-backed Chat UI on a
      // paired runtime once clipboardHasImage() is true. window.api is frozen, so the main-process
      // `clipboard:hasImage` wrapper calls this claim first and reports no image when it uploads.
      window.__orcaClaimRemoteImagePaste = () => {
        const textbox = document.activeElement?.closest?.(
          '.native-chat-message-text[role="textbox"]',
        );
        if (!textbox) {
          logRemoteImage('claim-skip', { reason: 'focus-not-in-composer' });
          return false;
        }
        const info = inspectComposerElement(textbox);
        // Agent-session composers carry attachmentEnvironmentId and upload natively.
        if (!info || !info.runtimeEnvironmentId || info.loProps?.attachmentEnvironmentId) {
          logRemoteImage('claim-skip', {
            reason: !info ? 'no-composer' : !info.runtimeEnvironmentId ? 'local' : 'agent-session',
            composer: summarizeComposer(info),
          });
          return false;
        }
        logRemoteImage('claim', { composer: summarizeComposer(info) });
        uploadAndAttachBlobs([{ blob: null, name: 'pasted-image.png' }], info);
        return true;
      };

      // Record when Orca still shows its native remote-attachment block, with the composer it targets.
      if (window.__orcaRemoteImageNoticeObserver) {
        window.__orcaRemoteImageNoticeObserver.disconnect();
      }
      window.__orcaRemoteImageNoticeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && node.childElementCount > 12) continue;
            const text = node.textContent || '';
            if (!text.includes('Local attachments are not available')) continue;
            // Attribute the notice to the nearest composer that encloses it, not the first visible one.
            let el = node.nodeType === 1 ? node : node.parentElement;
            let box = null;
            while (el && !box) {
              box = el.querySelector?.('.native-chat-message-text[role="textbox"]') || null;
              el = el.parentElement;
            }
            logRemoteImage('native-blocked-notice', {
              composer: box ? summarizeComposer(inspectComposerElement(box)) : null,
              focus: Boolean(
                document.activeElement?.closest?.('.native-chat-message-text[role="textbox"]'),
              ),
            });
            return;
          }
        }
      });
      window.__orcaRemoteImageNoticeObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });

      window.addEventListener('paste', window.__orcaRemoteChatPasteListener, true);
      window.addEventListener('dragover', window.__orcaRemoteChatDragOverListener, true);
      window.addEventListener('drop', window.__orcaRemoteChatDropListener, true);
      window.addEventListener('click', window.__orcaRemoteChatClickListener, true);

      // In web-index.html, poll external push queue so curl / phone / remote script uploads with ?attach=1 appear immediately
      if (
        (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
        !window.__orcaRemoteChatPollTimer
      ) {
        let lastSeq = 0;
        window.__orcaRemoteChatPollTimer = setInterval(async () => {
          try {
            const res = await fetch('./orca-chat-upload?poll=1&since=' + lastSeq);
            if (!res.ok) return;
            const data = await res.json();
            if (data && Array.isArray(data.events)) {
              for (const ev of data.events) {
                if (ev.seq > lastSeq) lastSeq = ev.seq;
                await window.__orcaAttachImageToChat(ev);
              }
            }
          } catch {}
        }, 1200);
      }

      if (!agSrc) {
        return JSON.stringify({ ok: true, remoteChatImageHook: true, reason: 'no agSrc' });
      }

      const isAgEntry = (entry) => {
        if (!entry) return false;
        if (entry.agentType === 'antigravity' || entry.__agOriginalAgent === 'antigravity') {
          return true;
        }
        const ps = entry.providerSession;
        const tp = (ps && ps.transcriptPath) || '';
        if (tp.includes('antigravity-orca-bridge')) return true;
        const sid = (ps && ps.id) || '';
        return typeof sid === 'string' && sid.startsWith('ag-boot-');
      };

      const addTabIdVariants = (set, rawId) => {
        if (!rawId || typeof rawId !== 'string') return;
        set.add(rawId);
        if (rawId.startsWith('web-terminal-')) {
          set.add(rawId.slice('web-terminal-'.length));
        } else {
          set.add('web-terminal-' + rawId);
        }
      };

      const deleteTabIdVariants = (set, rawId) => {
        if (!rawId || typeof rawId !== 'string') return;
        set.delete(rawId);
        if (rawId.startsWith('web-terminal-')) {
          set.delete(rawId.slice('web-terminal-'.length));
        } else {
          set.delete('web-terminal-' + rawId);
        }
      };

      const addPaneKeyVariants = (set, rawKey) => {
        if (!rawKey || typeof rawKey !== 'string') return;
        set.add(rawKey);
        if (rawKey.startsWith('web-terminal-')) {
          set.add(rawKey.slice('web-terminal-'.length));
        } else {
          set.add('web-terminal-' + rawKey);
        }
      };

      const deletePaneKeyVariants = (set, rawKey) => {
        if (!rawKey || typeof rawKey !== 'string') return;
        set.delete(rawKey);
        if (rawKey.startsWith('web-terminal-')) {
          set.delete(rawKey.slice('web-terminal-'.length));
        } else {
          set.delete('web-terminal-' + rawKey);
        }
      };

      const isAgTabObject = (tabObj) => {
        if (!tabObj || typeof tabObj !== 'object') return false;
        if (tabObj.launchAgent === 'antigravity') return true;
        const vaultSid = tabObj.aiVaultTitle && tabObj.aiVaultTitle.sessionId;
        return typeof vaultSid === 'string' && vaultSid.startsWith('ag-boot-');
      };

      window.__agAutoChatTabs = window.__agAutoChatTabs || new Set();
      window.__agKnownPaneKeys = window.__agKnownPaneKeys || new Set();
      window.__agKnownTabIds = window.__agKnownTabIds || new Set();

      let styleEl = document.getElementById('orca-antigravity-icon-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'orca-antigravity-icon-style';
        document.head.appendChild(styleEl);
      }

      let lastCssKey = '';
      const updateStyleSheet = (agTabIds) => {
        const tabIdsArr = Array.from(agTabIds).sort();
        const cssKey = tabIdsArr.join(',');
        if (cssKey === lastCssKey && styleEl.textContent) return;
        lastCssKey = cssKey;
        const tabSelectors = tabIdsArr.map(
          (id) => '[data-tab-id="' + id + '"] [data-agent-icon]',
        );
        const baseSelectors = ['[data-ag-icon="true"]', ...tabSelectors].join(',\n');
        const childSelectors = [
          '[data-ag-icon="true"] > svg',
          '[data-ag-icon="true"] > img',
          ...tabIdsArr.flatMap((id) => [
            '[data-tab-id="' + id + '"] [data-agent-icon] > svg',
            '[data-tab-id="' + id + '"] [data-agent-icon] > img',
          ]),
        ].join(',\n');

        styleEl.textContent =
          baseSelectors +
          ' {\n' +
          '  background-image: url("' +
          agSrc +
          '") !important;\n' +
          '  background-size: contain !important;\n' +
          '  background-repeat: no-repeat !important;\n' +
          '  background-position: center !important;\n' +
          '  border-radius: 2px !important;\n' +
          '  min-width: 12px;\n' +
          '  min-height: 12px;\n' +
          '}\n' +
          '.compact-agent-row [data-ag-icon="true"] {\n' +
          '  min-width: 11px;\n' +
          '  min-height: 11px;\n' +
          '}\n' +
          childSelectors +
          ' {\n' +
          '  opacity: 0 !important;\n' +
          '}\n';
      };

      let isSyncing = false;
      const syncAgIcons = () => {
        if (isSyncing) {
          return {
            agTabIds: Array.from(window.__agKnownTabIds || []),
            agPaneKeys: Array.from(window.__agKnownPaneKeys || []),
            patchedTabs: 0,
            patchedRows: 0,
          };
        }
        isSyncing = true;
        try {
          const state = store.getState();
          const agPaneKeys = new Set(window.__agKnownPaneKeys);
          const agTabIds = new Set(window.__agKnownTabIds);
          const confirmedAgPaneKeys = new Set();
          const confirmedAgTabIds = new Set();
          const bridgeTabIds = new Set();
          const tabsByIdMap = new Map();

          if (state.tabsById && typeof state.tabsById === 'object') {
            for (const [id, tabObj] of Object.entries(state.tabsById)) {
              if (!tabObj) continue;
              tabsByIdMap.set(id, tabObj);
              if (isAgTabObject(tabObj)) {
                addTabIdVariants(agTabIds, id);
                addTabIdVariants(confirmedAgTabIds, id);
                addTabIdVariants(window.__agKnownTabIds, id);
              }
            }
          }
          for (const tabs of Object.values(state.tabsByWorktree || {})) {
            if (!Array.isArray(tabs)) continue;
            for (const tabObj of tabs) {
              if (!tabObj || !tabObj.id) continue;
              tabsByIdMap.set(tabObj.id, tabObj);
              if (isAgTabObject(tabObj)) {
                addTabIdVariants(agTabIds, tabObj.id);
                addTabIdVariants(confirmedAgTabIds, tabObj.id);
                addTabIdVariants(window.__agKnownTabIds, tabObj.id);
              }
            }
          }
          for (const uTabs of Object.values(state.unifiedTabsByWorktree || {})) {
            if (!Array.isArray(uTabs)) continue;
            for (const uTab of uTabs) {
              const tabObj = (uTab && uTab.ptyTab) || uTab;
              if (!tabObj || !tabObj.id) continue;
              tabsByIdMap.set(tabObj.id, tabObj);
              if (isAgTabObject(tabObj) || isAgTabObject(uTab)) {
                addTabIdVariants(agTabIds, tabObj.id);
                addTabIdVariants(confirmedAgTabIds, tabObj.id);
                addTabIdVariants(window.__agKnownTabIds, tabObj.id);
              }
            }
          }

          for (const [k, v] of Object.entries(state.agentStatusByPaneKey || {})) {
            const tId = (v && v.tabId) || k.split(':')[0];
            const tp = (v && v.providerSession && v.providerSession.transcriptPath) || '';
            if (isAgEntry(v)) {
              addPaneKeyVariants(agPaneKeys, k);
              addPaneKeyVariants(confirmedAgPaneKeys, k);
              addPaneKeyVariants(window.__agKnownPaneKeys, k);
              addTabIdVariants(agTabIds, tId);
              addTabIdVariants(confirmedAgTabIds, tId);
              addTabIdVariants(window.__agKnownTabIds, tId);
              if (tp.includes('antigravity-orca-bridge')) {
                addTabIdVariants(bridgeTabIds, tId);
              }
            } else if (tp && !tp.includes('antigravity-orca-bridge')) {
              deletePaneKeyVariants(agPaneKeys, k);
              deletePaneKeyVariants(window.__agKnownPaneKeys, k);
              if (!confirmedAgTabIds.has(tId)) {
                deleteTabIdVariants(agTabIds, tId);
                deleteTabIdVariants(window.__agKnownTabIds, tId);
              }
            }
          }
          for (const [k, v] of Object.entries(state.retainedAgentsByPaneKey || {})) {
            const entry = v && v.entry ? v.entry : v;
            const tId = (entry && entry.tabId) || k.split(':')[0];
            const tp =
              (entry && entry.providerSession && entry.providerSession.transcriptPath) || '';
            if (isAgEntry(v) || isAgEntry(entry)) {
              addPaneKeyVariants(agPaneKeys, k);
              addPaneKeyVariants(confirmedAgPaneKeys, k);
              addPaneKeyVariants(window.__agKnownPaneKeys, k);
              addTabIdVariants(agTabIds, tId);
              addTabIdVariants(confirmedAgTabIds, tId);
              addTabIdVariants(window.__agKnownTabIds, tId);
              if (tp.includes('antigravity-orca-bridge')) {
                addTabIdVariants(bridgeTabIds, tId);
              }
            } else if (tp && !tp.includes('antigravity-orca-bridge')) {
              deletePaneKeyVariants(agPaneKeys, k);
              deletePaneKeyVariants(window.__agKnownPaneKeys, k);
              if (!confirmedAgTabIds.has(tId)) {
                deleteTabIdVariants(agTabIds, tId);
                deleteTabIdVariants(window.__agKnownTabIds, tId);
              }
            }
          }

          const fgMap = state.paneForegroundAgentByPaneKey || {};
          for (const [k, fg] of Object.entries(fgMap)) {
            if (!fg) continue;
            const tId = k.split(':')[0];
            const isConfirmedAg = confirmedAgPaneKeys.has(k) || confirmedAgTabIds.has(tId);
            if (
              fg.agent === 'antigravity' ||
              fg.__agOriginalAgent === 'antigravity' ||
              isConfirmedAg
            ) {
              addPaneKeyVariants(agPaneKeys, k);
              addPaneKeyVariants(window.__agKnownPaneKeys, k);
              addTabIdVariants(agTabIds, tId);
              addTabIdVariants(window.__agKnownTabIds, tId);
              if (
                (fg.agent === 'antigravity' ||
                  (fg.agent === 'claude' && fg.__agOriginalAgent !== 'antigravity')) &&
                typeof state.setPaneForegroundAgent === 'function'
              ) {
                state.setPaneForegroundAgent(k, {
                  ...fg,
                  agent: 'claude',
                  __agOriginalAgent: 'antigravity',
                });
              }
            } else if (fg.agent && fg.agent !== 'claude' && !isConfirmedAg) {
              deletePaneKeyVariants(agPaneKeys, k);
              deletePaneKeyVariants(window.__agKnownPaneKeys, k);
              deleteTabIdVariants(agTabIds, tId);
              deleteTabIdVariants(window.__agKnownTabIds, tId);
            }
          }

          updateStyleSheet(agTabIds);

          let patchedTabs = 0;
          let patchedRows = 0;

          const hasAnyStaleAgDom = Boolean(document.querySelector('[data-ag-icon="true"]'));
          if (agTabIds.size === 0 && agPaneKeys.size === 0 && !hasAnyStaleAgDom) {
            return {
              agTabIds: [],
              agPaneKeys: [],
              patchedTabs: 0,
              patchedRows: 0,
            };
          }

          for (const tabEl of document.querySelectorAll('[data-tab-id]')) {
            const tabId = tabEl.getAttribute('data-tab-id');
            const isAgTab = agTabIds.has(tabId);
            if (!isAgTab && !hasAnyStaleAgDom) continue;
            const iconSpan = tabEl.querySelector('[data-agent-icon]');
            if (!iconSpan) continue;
            if (isAgTab) {
              if (iconSpan.getAttribute('data-agent-icon') !== 'antigravity') {
                iconSpan.setAttribute('data-agent-icon', 'antigravity');
              }
              if (iconSpan.getAttribute('data-ag-icon') !== 'true') {
                iconSpan.setAttribute('data-ag-icon', 'true');
              }
              for (const textSpan of tabEl.querySelectorAll('span')) {
                if (textSpan.childElementCount === 0) {
                  const txt = textSpan.textContent || '';
                  if (txt === 'Claude' || txt.startsWith('Claude ag-boot-')) {
                    textSpan.textContent = 'Antigravity';
                  }
                }
              }
              patchedTabs++;
            } else if (iconSpan.getAttribute('data-ag-icon') === 'true') {
              iconSpan.removeAttribute('data-ag-icon');
            }
          }

          let cachedFiberKey = window.__orcaCachedReactFiberKey || '';
          for (const rowEl of document.querySelectorAll(
            '.compact-agent-row, .agent-disclosure-row',
          )) {
            if (!cachedFiberKey || !(cachedFiberKey in rowEl)) {
              cachedFiberKey = Object.keys(rowEl).find((k) => k.startsWith('__reactFiber$')) || '';
              if (cachedFiberKey) window.__orcaCachedReactFiberKey = cachedFiberKey;
            }
            const f = cachedFiberKey ? rowEl[cachedFiberKey] : null;
            const mp = f && f.return && f.return.memoizedProps ? f.return.memoizedProps : null;
            const agentProp = (mp && (mp.agent || mp.row)) || mp;
            const paneKey =
              (agentProp && agentProp.paneKey) ||
              (f && f.return && f.return.return ? f.return.return.key : null);
            const rowTabId =
              (agentProp && agentProp.tab && agentProp.tab.id) ||
              (paneKey ? String(paneKey).split(':')[0] : null);
            const isAg = Boolean(
              (paneKey && agPaneKeys.has(paneKey)) ||
                (rowTabId && agTabIds.has(rowTabId)) ||
                isAgEntry(agentProp && agentProp.entry),
            );
            if (!isAg && !hasAnyStaleAgDom) continue;
            const iconSpans = Array.from(rowEl.querySelectorAll('span[title]'));
            const iconSpan = iconSpans.find((s) => {
              const t = s.getAttribute('title') || '';
              return (
                (t === 'Claude' ||
                  t === 'Antigravity' ||
                  t.startsWith('Claude ·') ||
                  t.startsWith('Claude -') ||
                  t.startsWith('Antigravity ·') ||
                  t.startsWith('Antigravity -')) &&
                Boolean(s.querySelector('svg, img'))
              );
            });
            if (!iconSpan) continue;
            if (isAg) {
              const curTitle = iconSpan.getAttribute('title') || '';
              const nextTitle = curTitle.startsWith('Claude')
                ? 'Antigravity' + curTitle.slice('Claude'.length)
                : 'Antigravity';
              if (curTitle !== nextTitle) {
                iconSpan.setAttribute('title', nextTitle);
              }
              if (iconSpan.getAttribute('data-ag-icon') !== 'true') {
                iconSpan.setAttribute('data-ag-icon', 'true');
              }
              for (const textSpan of rowEl.querySelectorAll('span')) {
                const spanTitle = textSpan.getAttribute('title') || '';
                if (spanTitle.endsWith(' - Claude')) {
                  textSpan.setAttribute(
                    'title',
                    spanTitle.slice(0, -' - Claude'.length) + ' - Antigravity',
                  );
                }
                if (textSpan.childElementCount === 0) {
                  const txt = textSpan.textContent || '';
                  if (txt === ' - Claude') {
                    textSpan.textContent = ' - Antigravity';
                  } else if (txt === 'Claude' || txt.startsWith('Claude ag-boot-')) {
                    textSpan.textContent = 'Antigravity';
                  }
                }
              }
              patchedRows++;
            } else if (iconSpan.getAttribute('data-ag-icon') === 'true') {
              iconSpan.removeAttribute('data-ag-icon');
            }
          }
          return {
            agTabIds: Array.from(agTabIds),
            agPaneKeys: Array.from(agPaneKeys),
            patchedTabs,
            patchedRows,
          };
        } finally {
          isSyncing = false;
        }
      };

      const curState = store.getState();
      if (
        typeof curState.setPaneForegroundAgent === 'function' &&
        !curState.setPaneForegroundAgent.__agWrapped
      ) {
        const origSetFg = curState.setPaneForegroundAgent;
        const wrappedSetFg = (paneKey, fg) => {
          const isKnownAgPane = Boolean(
            paneKey && window.__agKnownPaneKeys && window.__agKnownPaneKeys.has(paneKey),
          );
          if (
            fg &&
            (fg.agent === 'antigravity' ||
              fg.__agOriginalAgent === 'antigravity' ||
              (fg.agent === 'claude' && isKnownAgPane))
          ) {
            const tId = String(paneKey || '').split(':')[0];
            addPaneKeyVariants(window.__agKnownPaneKeys, paneKey);
            addTabIdVariants(window.__agKnownTabIds, tId);
            return origSetFg(paneKey, {
              ...fg,
              agent: 'claude',
              __agOriginalAgent: 'antigravity',
            });
          }
          return origSetFg(paneKey, fg);
        };
        wrappedSetFg.__agWrapped = true;
        try {
          store.setState({ setPaneForegroundAgent: wrappedSetFg });
        } catch {}
      }

      window.__orcaSwitchAgTabToChat = (tabId, paneKey, viewMode = 'chat') => {
        try {
          const st = store.getState();
          const resolvedTabId = tabId || (paneKey ? String(paneKey).split(':')[0] : '');
          if (paneKey) {
            addPaneKeyVariants(window.__agKnownPaneKeys, paneKey);
          }
          if (resolvedTabId) {
            addTabIdVariants(window.__agKnownTabIds, resolvedTabId);
          }
          if (paneKey && typeof st.setPaneForegroundAgent === 'function') {
            const existingFg = st.paneForegroundAgentByPaneKey?.[paneKey];
            st.setPaneForegroundAgent(paneKey, {
              ...(existingFg || { agentEvidence: 'process-read', shellForeground: false }),
              agent: 'claude',
              __agOriginalAgent: 'antigravity',
            });
          }
          if (resolvedTabId && typeof st.setTabViewMode === 'function') {
            st.setTabViewMode(resolvedTabId, viewMode || 'chat');
            window.__agAutoChatTabs.add(resolvedTabId);
          }
          const synced = syncAgIcons();
          return { ok: true, tabId: resolvedTabId, paneKey, viewMode, synced };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      };

      if (window.__agIconObserver) window.__agIconObserver.disconnect();
      if (window.__agStoreUnsub) window.__agStoreUnsub();
      const initial = syncAgIcons();
      let scheduled = false;
      const scheduleSync = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          syncAgIcons();
        }, 16);
      };
      const obs = new MutationObserver(scheduleSync);
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-agent-icon', 'title'],
      });
      window.__agIconObserver = obs;
      window.__agStoreUnsub = store.subscribe(() => {
        syncAgIcons();
        scheduleSync();
      });
      window.__agIconSyncInstalled = true;
      return JSON.stringify({ ok: true, remoteChatImageHook: true, initial });
    } catch (err) {
      return JSON.stringify({ ok: false, error: String(err) });
    }
  })();
}

function mainProcessAntigravityIconInstaller(rendererFnSource) {
  const { app, BrowserWindow, ipcMain, clipboard, nativeImage, shell } =
    process.mainModule.require('electron');
  const fs = process.mainModule.require('fs');
  const path = process.mainModule.require('path');
  const http = process.mainModule.require('http');
  const crypto = process.mainModule.require('crypto');

  try {
    const recoveryPath = path.join(app.getPath('home'), '.orca', 'agent-hooks', 'remote-chat-recovery.cjs');
    if (fs.existsSync(recoveryPath)) {
      process.mainModule.require(recoveryPath).installRemoteChatRecovery();
    }
  } catch (error) {
    console.warn('[orca-remote-chat-recovery] Installation failed:', String(error));
  }

  const toFigmaDesktopUrl = (rawUrl) => {
    try {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
      const u = new URL(rawUrl.trim());
      if (u.protocol === 'figma:') return u.toString();
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      const host = u.hostname.toLowerCase();
      if (host !== 'figma.com' && host !== 'www.figma.com') return null;
      const openInBrowser = u.searchParams.get('openInBrowser');
      if (openInBrowser && openInBrowser !== '0' && openInBrowser !== 'false') return null;
      const cleanPath = u.pathname.replace(/^\/+/, '');
      if (!cleanPath || cleanPath.startsWith('file/employee/consent/confirm')) return null;
      const segs = cleanPath.split('/').filter(Boolean);
      const first = segs[0] || '';
      const filePrefixes = new Set([
        'design',
        'file',
        'board',
        'slides',
        'proto',
        'site',
        'buzz',
        'rev',
        'make',
        'weave',
        'spec',
        'deck',
        'presenter',
        'export',
      ]);
      const directPrefixes = new Set([
        'files',
        'make-local',
        'community',
        'c',
        'my_plugins',
        'idle_timeout',
        'ip_account_restriction',
        'user',
        'org',
        'team',
        'jam',
      ]);
      let ok = false;
      if (first.startsWith('@') && first.length > 1 && first.length <= 16) {
        ok = true;
      } else if (directPrefixes.has(first)) {
        ok = true;
      } else if (filePrefixes.has(first)) {
        if (segs.length === 1) ok = first === 'make';
        else if (segs[1] === 'new') ok = true;
        else if (segs.length >= 4 && segs[2] === 'image') ok = false;
        else ok = Boolean(segs[1]);
      }
      if (!ok) return null;
      if (!fs.existsSync('/Applications/Figma.app')) return null;
      return `figma://${cleanPath}${u.search || ''}${u.hash || ''}`;
    } catch {
      return null;
    }
  };

  if (shell && typeof shell.openExternal === 'function') {
    const origOpenExternal = global.__orcaOrigShellOpenExternal || shell.openExternal.bind(shell);
    global.__orcaOrigShellOpenExternal = origOpenExternal;
    shell.openExternal = (targetUrl, options) => {
      const figmaUrl = toFigmaDesktopUrl(targetUrl);
      if (figmaUrl) {
        return origOpenExternal(figmaUrl, options);
      }
      return origOpenExternal(targetUrl, options);
    };
  }

  const userDataDir = app.getPath('userData');
  const tempDir = app.getPath('temp');
  const attachDir = path.join(userDataDir, 'agent-session-attachments');
  const nativePastesDir = path.join(userDataDir, 'native-chat-pastes');
  try {
    fs.mkdirSync(attachDir, { recursive: true });
    fs.mkdirSync(nativePastesDir, { recursive: true });
    const tempAttachLink = path.join(tempDir, 'agent-session-attachments');
    if (!fs.existsSync(tempAttachLink)) {
      fs.symlinkSync('.', tempAttachLink);
    }
  } catch {}

  global.__orcaRemoteChatImageCache = global.__orcaRemoteChatImageCache || new Map();
  global.__orcaRemoteChatUploadChunks = global.__orcaRemoteChatUploadChunks || new Map();
  global.__orcaRemoteChatPushEvents = global.__orcaRemoteChatPushEvents || [];
  global.__orcaRemoteChatPushSeq = global.__orcaRemoteChatPushSeq || 0;

  const remoteImageLogPath = path.join(
    app.getPath('home'),
    'Library',
    'Logs',
    'orca-remote-chat-image.log',
  );
  const logRemoteImage = (step, detail = {}) => {
    try {
      try {
        if (fs.statSync(remoteImageLogPath).size > 1024 * 1024) {
          fs.renameSync(remoteImageLogPath, `${remoteImageLogPath}.1`);
        }
      } catch {}
      const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
      fs.appendFileSync(remoteImageLogPath, `${new Date().toISOString()} ${step} ${text}\n`);
    } catch {}
  };
  global.__orcaLogRemoteImage = logRemoteImage;

  const cacheImageEntry = (filePath, base64, mimeType = 'image/png') => {
    if (!filePath || !base64) return;
    global.__orcaRemoteChatImageCache.set(filePath, {
      base64,
      mimeType,
      createdAt: Date.now(),
    });
    while (global.__orcaRemoteChatImageCache.size > 64) {
      const oldestKey = global.__orcaRemoteChatImageCache.keys().next().value;
      if (!oldestKey) break;
      global.__orcaRemoteChatImageCache.delete(oldestKey);
    }
  };

  const saveChatImageBuffer = (rawBuffer, opts = {}) => {
    let pngBuf = rawBuffer;
    try {
      const img = nativeImage.createFromBuffer(rawBuffer);
      if (!img.isEmpty()) {
        pngBuf = img.toPNG();
      }
    } catch {}
    const fileName = `orca-paste-${Date.now()}-${crypto.randomUUID()}.png`;
    const destPath = path.join(attachDir, fileName);
    const nativePastePath = path.join(nativePastesDir, fileName);
    fs.writeFileSync(destPath, pngBuf);
    try {
      fs.writeFileSync(nativePastePath, pngBuf);
    } catch {}
    const base64 = pngBuf.toString('base64');
    cacheImageEntry(destPath, base64, 'image/png');
    cacheImageEntry(nativePastePath, base64, 'image/png');
    return {
      ok: true,
      path: destPath,
      nativePastePath,
      fileName,
      size: pngBuf.byteLength,
      mimeType: 'image/png',
      base64,
      ...(opts.originalName ? { originalName: opts.originalName } : {}),
    };
  };

  // Wrap ipcMain handlers so remote & local Chat UI image pastes/drops/previews always succeed
  const handlers = ipcMain && ipcMain._invokeHandlers;
  if (handlers && typeof handlers.get === 'function') {
    const origShellOpenUrl = global.__orcaOrigShellOpenUrl || handlers.get('shell:openUrl');
    if (origShellOpenUrl && shell && typeof shell.openExternal === 'function') {
      global.__orcaOrigShellOpenUrl = origShellOpenUrl;
      handlers.set('shell:openUrl', async (event, rawUrl) => {
        const figmaUrl = toFigmaDesktopUrl(rawUrl);
        if (figmaUrl) {
          return (global.__orcaOrigShellOpenExternal || shell.openExternal.bind(shell))(figmaUrl);
        }
        return origShellOpenUrl(event, rawUrl);
      });
    }

    const origSaveTemp =
      global.__orcaOrigSaveClipboardImage || handlers.get('clipboard:saveImageAsTempFile');
    if (origSaveTemp) {
      global.__orcaOrigSaveClipboardImage = origSaveTemp;
      handlers.set('clipboard:saveImageAsTempFile', async (event, arg = {}) => {
        try {
          const result = await saveImageAsTempFileImpl(event, arg);
          logRemoteImage('main-save', {
            env: arg?.runtimeEnvironmentId || null,
            connectionId: arg?.connectionId || null,
            agentSession: Boolean(arg?.agentSessionAttachment),
            base64: Boolean(arg?.__orcaImageBase64),
            path: result || null,
          });
          return result;
        } catch (err) {
          logRemoteImage('main-save-failed', {
            env: arg?.runtimeEnvironmentId || null,
            error: String((err && err.stack) || err),
          });
          throw err;
        }
      });
      async function saveImageAsTempFileImpl(event, arg = {}) {
        let pngBuf = null;
        if (arg && typeof arg.__orcaImageBase64 === 'string' && arg.__orcaImageBase64.length > 0) {
          const rawBuf = Buffer.from(arg.__orcaImageBase64, 'base64');
          try {
            const img = nativeImage.createFromBuffer(rawBuf);
            pngBuf = !img.isEmpty() ? img.toPNG() : rawBuf;
            if (arg.runtimeEnvironmentId || arg.connectionId) {
              clipboard.writeImage(img.isEmpty() ? nativeImage.createFromBuffer(pngBuf) : img);
            }
          } catch {
            pngBuf = rawBuf;
          }
          if (!arg.runtimeEnvironmentId && !arg.connectionId) {
            const saved = saveChatImageBuffer(pngBuf, { originalName: arg.__orcaFileName });
            return saved.path;
          }
        } else {
          try {
            const clipImg = clipboard.readImage();
            if (!clipImg.isEmpty()) {
              pngBuf = clipImg.toPNG();
            }
          } catch {}
        }

        const cleanArg = { ...(arg || {}) };
        delete cleanArg.__orcaImageBase64;
        delete cleanArg.__orcaFileName;
        const savedPath = await origSaveTemp(event, cleanArg);
        if (savedPath && pngBuf) {
          const b64 = pngBuf.toString('base64');
          cacheImageEntry(savedPath, b64, 'image/png');
          try {
            if (fs.existsSync(savedPath) && !savedPath.includes('/agent-session-attachments/')) {
              const mirrored = path.join(attachDir, path.basename(savedPath));
              fs.copyFileSync(savedPath, mirrored);
              cacheImageEntry(mirrored, b64, 'image/png');
              return mirrored;
            }
          } catch {}
          if (
            typeof savedPath === 'string' &&
            savedPath.startsWith('/') &&
            !savedPath.includes('/agent-session-attachments/')
          ) {
            const normalizedRemote = path.posix.join(
              path.posix.dirname(savedPath),
              'agent-session-attachments',
              path.posix.basename(savedPath),
            );
            cacheImageEntry(normalizedRemote, b64, 'image/png');
            return normalizedRemote;
          }
        }
        return savedPath;
      }
    }

    const origHasImage = global.__orcaOrigHasImage || handlers.get('clipboard:hasImage');
    if (origHasImage) {
      global.__orcaOrigHasImage = origHasImage;
      handlers.set('clipboard:hasImage', async (event, ...rest) => {
        const has = await origHasImage(event, ...rest);
        if (has !== true || !event?.sender) return has;
        try {
          const claimed = await event.sender.executeJavaScript(
            'typeof window.__orcaClaimRemoteImagePaste === "function" && window.__orcaClaimRemoteImagePaste()',
          );
          logRemoteImage('main-has-image', { claimed: claimed === true });
          if (claimed === true) return false;
        } catch (err) {
          logRemoteImage('main-has-image-failed', { error: String((err && err.stack) || err) });
        }
        return has;
      });
    }

    const origRestorePastes =
      global.__orcaOrigRestorePastes || handlers.get('clipboard:restoreNativeChatPastes');
    if (origRestorePastes) {
      global.__orcaOrigRestorePastes = origRestorePastes;
      handlers.set('clipboard:restoreNativeChatPastes', async (event, paths) => {
        const base = await origRestorePastes(event, paths).catch(() => []);
        const byPath = new Map((base || []).map((x) => [x.path, x]));
        return (Array.isArray(paths) ? paths : []).map((p) => {
          const existing = byPath.get(p);
          if (existing && existing.kept && existing.exists) return existing;
          if (
            global.__orcaRemoteChatImageCache.has(p) ||
            (typeof p === 'string' &&
              (p.includes('/agent-session-attachments/') ||
                /orca-paste-.*\.(png|jpe?g|gif|webp)$/i.test(p) ||
                fs.existsSync(p)))
          ) {
            return { path: p, kept: true, exists: true };
          }
          return existing || { path: p, kept: false, exists: false };
        });
      });
    }

    const origPathExists = global.__orcaOrigPathExists || handlers.get('fs:pathExists');
    if (origPathExists) {
      global.__orcaOrigPathExists = origPathExists;
      handlers.set('fs:pathExists', async (event, arg = {}) => {
        const fp = arg && arg.filePath;
        if (
          fp &&
          (global.__orcaRemoteChatImageCache.has(fp) ||
            fp.includes('/agent-session-attachments/') ||
            /orca-paste-.*\.(png|jpe?g|gif|webp)$/i.test(fp))
        ) {
          return true;
        }
        return origPathExists(event, arg);
      });
    }

    const origReadFile = global.__orcaOrigReadFile || handlers.get('fs:readFile');
    if (origReadFile) {
      global.__orcaOrigReadFile = origReadFile;
      handlers.set('fs:readFile', async (event, arg = {}) => {
        const fp = arg && arg.filePath;
        if (fp && global.__orcaRemoteChatImageCache.has(fp)) {
          const cached = global.__orcaRemoteChatImageCache.get(fp);
          return {
            content: cached.base64,
            isBinary: true,
            isImage: true,
            mimeType: cached.mimeType || 'image/png',
          };
        }
        try {
          return await origReadFile(event, arg);
        } catch (err) {
          if (fp && fs.existsSync(fp) && /\.(png|jpe?g|gif|webp|bmp)$/i.test(fp)) {
            const buf = fs.readFileSync(fp);
            const b64 = buf.toString('base64');
            cacheImageEntry(fp, b64, 'image/png');
            return {
              content: b64,
              isBinary: true,
              isImage: true,
              mimeType: 'image/png',
            };
          }
          throw err;
        }
      });
    }

    try {
      if (!global.__orcaMainStateBox) {
        const inspector = process.mainModule.require('inspector');
        const session = new inspector.Session();
        session.connect();
        try {
          const post = (method, params) => {
            let res;
            session.post(method, params, (err, r) => {
              if (!err) res = r;
            });
            return res;
          };
          const origRelayStatus =
            global.__orcaOrigGetRelayStatus || handlers.get('mobile:getRelayStatus');
          if (origRelayStatus) {
            global.__orcaOrigGetRelayStatus = origRelayStatus;
            const evalRes = post('Runtime.evaluate', {
              expression: 'global.__orcaOrigGetRelayStatus',
            });
            const objId = evalRes?.result?.objectId;
            const props1 = objId && post('Runtime.getProperties', { objectId: objId });
            const scopesId = props1?.internalProperties?.find(
              (p) => p.name === '[[Scopes]]',
            )?.value?.objectId;
            const scopes = scopesId && post('Runtime.getProperties', { objectId: scopesId });
            for (const s of scopes?.result || []) {
              const sp =
                s.value?.objectId && post('Runtime.getProperties', { objectId: s.value.objectId });
              const tId = sp?.result?.find((x) => x.name === 't')?.value?.objectId;
              const tp = tId && post('Runtime.getProperties', { objectId: tId });
              const fnId = tp?.result?.find((x) => x.name === 'getRelayStatus')?.value?.objectId;
              const fp = fnId && post('Runtime.getProperties', { objectId: fnId });
              const gScopesId = fp?.internalProperties?.find(
                (p) => p.name === '[[Scopes]]',
              )?.value?.objectId;
              const gScopes = gScopesId && post('Runtime.getProperties', { objectId: gScopesId });
              for (const gs of gScopes?.result || []) {
                const gsp =
                  gs.value?.objectId &&
                  post('Runtime.getProperties', { objectId: gs.value.objectId });
                const dollarId = gsp?.result?.find((x) => x.name === '$')?.value?.objectId;
                if (dollarId) {
                  post('Runtime.callFunctionOn', {
                    objectId: dollarId,
                    functionDeclaration: 'function() { global.__orcaMainStateBox = this; }',
                  });
                  break;
                }
              }
            }
          }
        } finally {
          try {
            session.disconnect();
          } catch {}
        }
      }
      const ensureRelayAlive = () => {
        const st = global.__orcaMainStateBox;
        if (!st) return;
        const hasOpenWindow = BrowserWindow.getAllWindows().some((w) => w && !w.isDestroyed());
        if (!hasOpenWindow) return;
        if (st.isQuitting) st.isQuitting = false;
        const s = st.desktopRelayService;
        if (s && st.runtimeRpc && !st.runtimeRpc.mobileRelayPairingProvider) {
          st.runtimeRpc.setMobileRelayPairingProvider({
            createPairingRelay: (t) => s.createPairingRelay(t),
            onDeviceRevokeQueued: (t) => s.onDeviceRevokeQueued(t),
            onDemandStateChanged: () => s.demandStateChanged(),
            getEndpoints: (t, n) => s.getEndpoints(t, n),
            provisionRelay: (t, n) => s.provisionRelay(t, n),
          });
          s.start();
        }
      };
      ensureRelayAlive();
      const origGetPairingQR = global.__orcaOrigGetPairingQR || handlers.get('mobile:getPairingQR');
      if (origGetPairingQR) {
        global.__orcaOrigGetPairingQR = origGetPairingQR;
        handlers.set('mobile:getPairingQR', async (event, arg) => {
          ensureRelayAlive();
          return origGetPairingQR(event, arg);
        });
      }
      const origGetRelayStatus =
        global.__orcaOrigGetRelayStatus || handlers.get('mobile:getRelayStatus');
      if (origGetRelayStatus) {
        global.__orcaOrigGetRelayStatus = origGetRelayStatus;
        handlers.set('mobile:getRelayStatus', async (event, arg) => {
          ensureRelayAlive();
          return origGetRelayStatus(event, arg);
        });
      }

      const KNOWN_SHELL_NAMES = new Set([
        '',
        'bash',
        'zsh',
        'sh',
        'fish',
        'cmd',
        'cmd.exe',
        'powershell',
        'powershell.exe',
        'pwsh',
        'pwsh.exe',
        'nu',
        'ksh',
        'mksh',
        'dash',
        'ash',
        'tcsh',
        'csh',
        'elvish',
        'xonsh',
      ]);
      const isKnownShellName = (raw) => {
        if (typeof raw !== 'string') return false;
        const t = raw
          .trim()
          .replace(/^["']|["']$/g, '')
          .replace(/^-/, '')
          .toLowerCase();
        const n = t.split(/[\\/]/).pop() ?? t;
        const r = n.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
        return KNOWN_SHELL_NAMES.has(t) || KNOWN_SHELL_NAMES.has(n) || KNOWN_SHELL_NAMES.has(r);
      };

      const origInspectProcess =
        global.__orcaOrigInspectProcess || handlers.get('pty:inspectProcess');
      const origGetForegroundProcess =
        global.__orcaOrigGetForegroundProcess || handlers.get('pty:getForegroundProcess');
      const origHasPty = global.__orcaOrigHasPty || handlers.get('pty:hasPty');
      if (origGetForegroundProcess) global.__orcaOrigGetForegroundProcess = origGetForegroundProcess;
      if (origHasPty) global.__orcaOrigHasPty = origHasPty;

      const buildFastInspectPayload = (ptyId, rawFg, ptyEntry, opts) => {
        const fg = typeof rawFg === 'string' && rawFg.trim() ? rawFg.trim() : null;
        const hasChildProcesses =
          (fg !== null && !isKnownShellName(fg)) || Boolean(ptyEntry?.foregroundAgent);
        return {
          foregroundProcess: fg,
          hasChildProcesses,
          childProcessEvidence: hasChildProcesses ? 'children' : 'no-children',
          foregroundProcessEvidence: {
            authorityGeneration: 'fast-inspect',
            observationEpoch: 1,
            capturedAgeMs: 0,
            ptyId: String(ptyId),
            ptyIncarnationId: String(
              opts?.expectedIncarnationId || ptyEntry?.incarnationId || 'fast-incarnation',
            ),
            verdict: 'live',
            processName: hasChildProcesses ? fg || ptyEntry?.foregroundAgent || null : null,
            shellOwnsEveryTtyProcessGroup: !hasChildProcesses,
          },
        };
      };

      if (origInspectProcess && origGetForegroundProcess) {
        global.__orcaOrigInspectProcess = origInspectProcess;
        handlers.set('pty:inspectProcess', async (event, arg = {}) => {
          if (arg && arg.scanChildProcesses === true && typeof arg.id === 'string' && arg.id) {
            try {
              const ptyEntry = global.__orcaMainStateBox?.runtime?.ptysById?.get?.(arg.id);
              if (
                typeof arg.expectedIncarnationId === 'string' &&
                arg.expectedIncarnationId &&
                ptyEntry?.incarnationId &&
                arg.expectedIncarnationId !== ptyEntry.incarnationId
              ) {
                return {
                  foregroundProcess: null,
                  hasChildProcesses: false,
                  verdict: 'unverifiable',
                  reason: 'terminal_gone',
                };
              }
              const rawFg = await origGetForegroundProcess(event, { id: arg.id });
              if (typeof rawFg === 'string' && rawFg.trim()) {
                return buildFastInspectPayload(arg.id, rawFg, ptyEntry, arg);
              }
              if (origHasPty && (await origHasPty(event, { id: arg.id })) !== true) {
                return {
                  foregroundProcess: null,
                  hasChildProcesses: false,
                  verdict: 'unverifiable',
                  reason: 'terminal_gone',
                };
              }
              return buildFastInspectPayload(arg.id, rawFg, ptyEntry, arg);
            } catch {}
          }
          return origInspectProcess(event, arg);
        });
      }

      const pc = global.__orcaMainStateBox?.runtime?.ptyController;
      if (
        pc &&
        typeof pc.inspectProcess === 'function' &&
        typeof pc.getForegroundProcess === 'function'
      ) {
        const origPcInspect = global.__orcaOrigPcInspectProcess || pc.inspectProcess.bind(pc);
        global.__orcaOrigPcInspectProcess = origPcInspect;
        pc.inspectProcess = async (ptyId, opts) => {
          if (opts && opts.scanChildProcesses === true && typeof ptyId === 'string' && ptyId) {
            try {
              const ptyEntry = global.__orcaMainStateBox?.runtime?.ptysById?.get?.(ptyId);
              if (
                typeof opts.expectedIncarnationId === 'string' &&
                opts.expectedIncarnationId &&
                ptyEntry?.incarnationId &&
                opts.expectedIncarnationId !== ptyEntry.incarnationId
              ) {
                return {
                  foregroundProcess: null,
                  hasChildProcesses: false,
                  verdict: 'unverifiable',
                  reason: 'terminal_gone',
                };
              }
              const rawFg = await pc.getForegroundProcess(ptyId);
              if (typeof rawFg === 'string' && rawFg.trim()) {
                return buildFastInspectPayload(ptyId, rawFg, ptyEntry, opts);
              }
              if (typeof pc.hasPty === 'function' && (await pc.hasPty(ptyId)) === false) {
                return {
                  foregroundProcess: null,
                  hasChildProcesses: false,
                  verdict: 'unverifiable',
                  reason: 'terminal_gone',
                };
              }
              return buildFastInspectPayload(ptyId, rawFg, ptyEntry, opts);
            } catch {}
          }
          return opts === undefined ? origPcInspect(ptyId) : origPcInspect(ptyId, opts);
        };
      }
    } catch {}
  }

  const rendererDir = path.join(process.resourcesPath, 'app.asar', 'out', 'renderer');
  const assetsDir = path.join(rendererDir, 'assets');
  let storeFiles = ['store-eN3DDiDV.js', 'store-D2j_JLHO.js'];
  let catalogFiles = ['agent-catalog-DCa9-p5b.js', 'agent-catalog-D55dFvJj.js'];
  let tabActionFiles = ['terminal-tab-actions-YZCbgp-q.js'];
  let fallbackAgSrc =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAABYlBMVEVHcEw5iPw2i/IziPztaDo3ifeJwGA6iPhkhug3ifjtVEg6ivgujO00h/8wivRztHQ0iftrgdLrhy41ifA0iPs+mMJNrp7rWEgwifjgryrcVmJ4wXDiUlmPeMCGxWK3w0FhprPZVmJato0pktxVjflCqKqjbqeLxWKQeL/opSZBp6z1Uj3Xuy01ifwwiPg1h/87if8wh/wvivRCiv4vi+8zktxNjPsvjek1ltEwj+Q5nMTwV0BDpK9Rg+hZifJ5e8tMq6C7ZHk+h/k2h/nOW2lXsJBAn7mGdrx1vG9dgd1Jh/SebZ3lU07meDlitoKuZo1kfszdWlOgvlBWk69wgttBhe/Ia14/iOTaZ01Cj87gpSxzfbOHdqeVcaxMh9O7uz90loxwiKFah77GelWfrVdToKGSe4uud2+kcIXlky6Sm22+qENyp37Mh0iHq2pfpo6tmVeuh2LSszGJhonJlkKWi3VeO12PAAAALXRSTlMARBro/o/8f/1lxVMt8q79vAf6/cv6i23YVBo4QcePmg6TzuC5S3QaM6re4bufpM1dAAADxklEQVRYhZ2X+T9iURTAXz2VVIQYxowxY4wxM7wShWwVSrIvlchStopR+P/n3O0t3tqcH933/d5zzj339sFxBjE40dOz3dbxwegbI/z09AEE221tsf9STJyC4IEIYh2t83+aTVEAht+t8l+aRPC4TVJoNYfBi4tms3b6+voIhjw2fG1JcAFRq9WwoJxv2wdB7GMrBcgE5e18Pr8fy7ZSxPgBRKVSe35+fmyUy2VsiMU+WU8A85UKCBpIcAKCbDZrOYURkkDlqfpcbSDDyUl+HxmspjB84HQ6nyCq1epbo3F3d0INVlNwyniIO2RYW0OGbkv8kNOZTnd1ddXr9cvLt5e3WzDEicHanRjGfB3zl5cvL7e39/fxeBwMFmvA/E79LwQIrmSGtX0rwzSUTqd3dtYBv7k5PLyCOEOGXWywUEP3MObXAUcCMBSvzs62qMFKDV0if4ji+rpYLIJhaxcbzPlxzK+uLi5ubBz2AS8z7MbXzGepX+L7+gqFAjLsIcM5TsL8Un9T8oVSqbS3t7dSTFGDqYDxCwtzc8DnmCGVOscGs4MckvjC3OzsbC6XWyqVNsFAFLs/zFog7Y/w+RwyLG1Khs9mLZDx8/PRaDSHFZugoAZjvlvOR6Mzvb29x8fHS0s4CWRInf80FIwp+RlqOMaGoxWkMG5Cv5Kfnp5KJpMJ0QCKlHETfsl5wKeQIJkARYYYQGHEj0j8DOGxAAyZDBja25HAqAlj8v0RHgqFiAAZlrHhyGXUAjUPIYiG5XZQGDWhT1F/iPKCMCk3tOs/rXbF/qGQz+9wu12dvDAZDCbCCSRACpuuwE3nj/C8h/3dFhCCwWA4HIlEkMGhK+iU56/4zI0F4Qwx6AogAbw/4t3KJRsxkBzsOrxXxqvOSm5wa9EQDjpAwHeqV11YgAyR7zqCUfEAfFrLAZZCJKJ9kHapgZoHZReLiHi01jmX2AC/doYu0aBdwyi7QSG9LvvENmiterUnQB50GsLaNTjEG6A/6zwzaBXJTlA9AlLYBGYYUa15WAJJfZ7jBphBvcsAK0BvzHB4BWRACtUKK4A34jnOzwzv9/GzBPQvOw67QA3vNvIyPmDMw2ERQTCsPMkA8NPoDdObISl8NAdFCh46gkZHyMImCEQh/7aX8gPmPLxbzCBl20l+RKwUwIpACrFfbsZr31JVeAVqoJfGy34E9F/bd+GhBgEPg53xGs+YXriYAU0NT/PXeUW0w8EM3Zyr9f3lOTg4fqq1+lm4icDHEd7kBmiFF58mz9n40IDL2r8yqiQCvN/+D+aPcPZ+RgT3AAAAAElFTkSuQmCC';
  try {
    const files = fs.readdirSync(assetsDir);
    const foundStores = files.filter(
      (f) =>
        (/^store-.*\.js$/.test(f) && !f.startsWith('store-patch-')) ||
        (/^client-.*\.js$/.test(f) &&
          !f.startsWith('client-creation-') &&
          !f.startsWith('client-environment-')),
    );
    const foundCatalogs = files.filter((f) =>
      /^(?:agent-catalog|windows-pty-compatibility)-.*\.js$/.test(f),
    );
    const foundTabActions = files.filter((f) => /^terminal-tab-actions-.*\.js$/.test(f));
    if (foundStores.length > 0) storeFiles = foundStores;
    if (foundCatalogs.length > 0) catalogFiles = foundCatalogs;
    if (foundTabActions.length > 0) tabActionFiles = foundTabActions;
    for (const cf of foundCatalogs) {
      try {
        const src = fs.readFileSync(path.join(assetsDir, cf), 'utf8');
        const m = /antigravity:\s*[`'"](data:image\/[^`'"]+)[`'"]/.exec(src);
        if (m && m[1]) {
          fallbackAgSrc = m[1];
          break;
        }
      } catch {}
    }
  } catch {}

  const rendererCode =
    '(' +
    rendererFnSource +
    ')(' +
    JSON.stringify(storeFiles) +
    ', ' +
    JSON.stringify(catalogFiles) +
    ', ' +
    JSON.stringify(fallbackAgSrc) +
    ', ' +
    JSON.stringify(tabActionFiles) +
    ')';
  global.__orcaLatestRendererHookCode = rendererCode;

  const dispatchAttachToChatWindows = async (payload) => {
    global.__orcaRemoteChatPushSeq = (global.__orcaRemoteChatPushSeq || 0) + 1;
    const ev = {
      ...payload,
      seq: global.__orcaRemoteChatPushSeq,
      createdAt: Date.now(),
    };
    global.__orcaRemoteChatPushEvents.push(ev);
    while (global.__orcaRemoteChatPushEvents.length > 32) {
      global.__orcaRemoteChatPushEvents.shift();
    }
    const callCode =
      'window.__orcaAttachImageToChat ? window.__orcaAttachImageToChat(' +
      JSON.stringify(payload) +
      ') : { ok: false, reason: "hook-not-loaded" }';
    const results = [];
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      try {
        await win.webContents.executeJavaScript(global.__orcaLatestRendererHookCode).catch(() => {});
        const r = await win.webContents.executeJavaScript(callCode);
        results.push(r);
      } catch (e) {
        results.push({ ok: false, error: String(e) });
      }
    }
    return results;
  };
  global.__orcaDispatchAttachToChatWindows = dispatchAttachToChatWindows;

  // Hook http.Server.prototype.emit to serve /orca-chat-upload and inject hook into /web-index.html on :6768
  const origEmit = process.mainModule.require('events').EventEmitter.prototype.emit;
  global.__orcaOrigHttpServerEmit = origEmit;
  http.Server.prototype.__orcaRemoteChatHttpHooked = true;
  http.Server.prototype.emit = function (event, req, res, ...rest) {
    if (event === 'request' && req && res && typeof req.url === 'string') {
      try {
        const parsedUrl = new URL(req.url, 'http://127.0.0.1');
        const pathname = parsedUrl.pathname;

        if (pathname.endsWith('/orca-remote-chat-image-hook.js') && req.method === 'GET') {
          const body = global.__orcaLatestRendererHookCode || '';
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(body);
          return true;
        }

        if (pathname.endsWith('/orca-ag-switch-chat')) {
          const tabId = parsedUrl.searchParams.get('tabId') || '';
          const paneKey = parsedUrl.searchParams.get('paneKey') || '';
          const viewMode = parsedUrl.searchParams.get('viewMode') || 'chat';
          Promise.all(
            BrowserWindow.getAllWindows().map(async (win) => {
              if (!win || win.isDestroyed()) return null;
              try {
                await win.webContents
                  .executeJavaScript(global.__orcaLatestRendererHookCode || rendererCode)
                  .catch(() => {});
                return await win.webContents.executeJavaScript(
                  'window.__orcaSwitchAgTabToChat ? window.__orcaSwitchAgTabToChat(' +
                    JSON.stringify(tabId) +
                    ', ' +
                    JSON.stringify(paneKey) +
                    ', ' +
                    JSON.stringify(viewMode) +
                    ') : { ok: false, reason: "missing-helper" }',
                );
              } catch (e) {
                return { ok: false, error: String(e) };
              }
            }),
          ).then((results) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, results }));
          });
          return true;
        }

        const acceptHeader = String(req.headers?.accept || '');
        const uaHeader = String(req.headers?.['user-agent'] || '');
        const isBrowserHtmlRequest =
          pathname.endsWith('/web-index.html') ||
          ((pathname === '/' || pathname === '/index.html') &&
            acceptHeader.includes('text/html') &&
            !/CFNetwork|Squirrel/i.test(uaHeader));

        if (req.method === 'GET' && isBrowserHtmlRequest) {
          try {
            const webIndexPath = path.join(rendererDir, 'web-index.html');
            const html = fs.readFileSync(webIndexPath, 'utf8');
            const injected = html.includes('orca-remote-chat-image-hook.js')
              ? html
              : html.replace(
                  '</body>',
                  '<script type="module" src="./orca-remote-chat-image-hook.js"></script></body>',
                );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(injected);
            return true;
          } catch {}
        }

          if (pathname.endsWith('/orca-chat-upload')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader(
              'Access-Control-Allow-Headers',
              'Content-Type, X-File-Name, X-Attach-Chat, X-Send-Chat, X-Chat-Prompt',
            );
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.end();
              return true;
            }
            if (req.method === 'GET') {
              const queryPath = parsedUrl.searchParams.get('path');
              if (queryPath) {
                if (global.__orcaRemoteChatImageCache.has(queryPath)) {
                  const c = global.__orcaRemoteChatImageCache.get(queryPath);
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(
                    JSON.stringify({
                      ok: true,
                      isBinary: true,
                      isImage: true,
                      content: c.base64,
                      mimeType: c.mimeType || 'image/png',
                    }),
                  );
                  return true;
                }
                if (
                  (queryPath.startsWith(attachDir) ||
                    queryPath.startsWith(nativePastesDir) ||
                    /orca-paste-.*\.(png|jpe?g|gif|webp)$/i.test(path.basename(queryPath))) &&
                  fs.existsSync(queryPath)
                ) {
                  const buf = fs.readFileSync(queryPath);
                  const b64 = buf.toString('base64');
                  cacheImageEntry(queryPath, b64, 'image/png');
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(
                    JSON.stringify({
                      ok: true,
                      isBinary: true,
                      isImage: true,
                      content: b64,
                      mimeType: 'image/png',
                    }),
                  );
                  return true;
                }
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: false, error: 'Image not found' }));
                return true;
              }
              if (parsedUrl.searchParams.get('poll') === '1') {
                const since = Number(parsedUrl.searchParams.get('since') || 0);
                const events = (global.__orcaRemoteChatPushEvents || []).filter(
                  (e) => e.seq > since,
                );
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: true, events }));
                return true;
              }
              // Serve browser uploader UI
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Orca Chat UI 远端传图</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f1115; color: #e5e7eb; margin: 0; padding: 24px; display: flex; justify-content: center; }
  .card { width: 100%; max-width: 520px; background: #181b22; border: 1px solid #2a2f3a; border-radius: 14px; padding: 20px; box-sizing: border-box; }
  h2 { margin: 0 0 12px; font-size: 18px; }
  .drop { border: 2px dashed #3b4252; border-radius: 10px; padding: 28px 16px; text-align: center; cursor: pointer; transition: border-color .15s; margin-bottom: 14px; }
  .drop:hover, .drop.active { border-color: #60a5fa; background: #1e2430; }
  input[type="text"] { width: 100%; box-sizing: border-box; background: #0f1115; border: 1px solid #2a2f3a; color: #e5e7eb; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
  .btns { display: flex; gap: 10px; }
  button { flex: 1; padding: 10px 14px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 14px; }
  .btn-attach { background: #2563eb; color: #fff; }
  .btn-send { background: #10b981; color: #fff; }
  pre { background: #0f1115; padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 12px; color: #9ca3af; white-space: pre-wrap; word-break: break-all; }
  img.preview { max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 10px; display: none; }
</style>
</head>
<body>
<div class="card">
  <h2>Orca Chat UI 远端直传图片</h2>
  <div class="drop" id="dropZone" onclick="document.getElementById('fileInput').click()">
    <div>直接粘贴图片 (Cmd+V / Ctrl+V)、拖拽图片到此，或点击选择图片</div>
    <img id="previewImg" class="preview" />
  </div>
  <input type="file" id="fileInput" accept="image/*" style="display:none" />
  <input type="text" id="promptInput" placeholder="可选：附带文字提示词（直接发送时一并提交）" />
  <div class="btns">
    <button class="btn-attach" onclick="submitUpload(false)">传入 Chat UI 输入框</button>
    <button class="btn-send" onclick="submitUpload(true)">传入并立即发送</button>
  </div>
  <pre id="statusBox">准备就绪</pre>
</div>
<script>
let currentBlob = null;
let currentName = 'remote-image.png';
function setFile(f) {
  if (!f) return;
  currentBlob = f;
  currentName = f.name || 'remote-image.png';
  const url = URL.createObjectURL(f);
  const img = document.getElementById('previewImg');
  img.src = url;
  img.style.display = 'inline-block';
  document.getElementById('statusBox').textContent = '已选择: ' + currentName + ' (' + Math.round(f.size / 1024) + ' KB)';
}
document.getElementById('fileInput').onchange = (e) => setFile(e.target.files[0]);
window.addEventListener('paste', (e) => {
  for (const item of Array.from(e.clipboardData?.items || [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      setFile(item.getAsFile());
      break;
    }
  }
});
const dz = document.getElementById('dropZone');
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('active'); };
dz.ondragleave = () => dz.classList.remove('active');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('active'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); };

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}

async function submitUpload(sendNow) {
  const st = document.getElementById('statusBox');
  if (!currentBlob) { st.textContent = '请先粘贴或选择一张图片'; return; }
  st.textContent = '正在上传并注入 Chat UI...';
  try {
    const b64 = await blobToBase64(currentBlob);
    const prompt = document.getElementById('promptInput').value.trim();
    const uploadId = 'web-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const chunkSize = 384 * 1024;
    let lastRes = null;
    for (let offset = 0; offset < b64.length; offset += chunkSize) {
      const isLast = offset + chunkSize >= b64.length;
      const r = await fetch('./orca-chat-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          offset,
          chunkBase64: b64.slice(offset, offset + chunkSize),
          commit: isLast,
          fileName: currentName,
          attach: isLast ? true : false,
          send: isLast ? sendNow : false,
          prompt: isLast ? prompt : ''
        })
      });
      lastRes = await r.json();
    }
    st.textContent = JSON.stringify(lastRes, null, 2);
  } catch (err) {
    st.textContent = '上传失败: ' + err.message;
  }
}
</script>
</body>
</html>`);
              return true;
            }
            if (req.method === 'POST') {
              const chunks = [];
              let total = 0;
              req.on('data', (c) => {
                total += c.length;
                if (total <= 64 * 1024 * 1024) chunks.push(c);
              });
              req.on('end', async () => {
                try {
                  const rawBody = Buffer.concat(chunks);
                  const ct = (req.headers['content-type'] || '').toLowerCase();
                  let saved = null;
                  let attach =
                    parsedUrl.searchParams.get('attach') === '1' ||
                    parsedUrl.searchParams.get('attach') === 'true' ||
                    req.headers['x-attach-chat'] === '1';
                  let send =
                    parsedUrl.searchParams.get('send') === '1' ||
                    parsedUrl.searchParams.get('send') === 'true' ||
                    req.headers['x-send-chat'] === '1';
                  let prompt =
                    parsedUrl.searchParams.get('prompt') || req.headers['x-chat-prompt'] || '';
                  let scopeKey = parsedUrl.searchParams.get('scopeKey') || '';
                  let tabId = parsedUrl.searchParams.get('tabId') || '';

                  if (ct.includes('application/json')) {
                    const bodyObj = JSON.parse(rawBody.toString('utf8'));
                    if (bodyObj.attach !== undefined) attach = Boolean(bodyObj.attach);
                    if (bodyObj.send !== undefined) send = Boolean(bodyObj.send);
                    if (bodyObj.prompt) prompt = String(bodyObj.prompt);
                    if (bodyObj.scopeKey) scopeKey = String(bodyObj.scopeKey);
                    if (bodyObj.tabId) tabId = String(bodyObj.tabId);

                    if (bodyObj.uploadId && typeof bodyObj.chunkBase64 === 'string') {
                      let state = global.__orcaRemoteChatUploadChunks.get(bodyObj.uploadId);
                      if (!state || bodyObj.offset === 0) {
                        state = { parts: [], createdAt: Date.now() };
                        global.__orcaRemoteChatUploadChunks.set(bodyObj.uploadId, state);
                      }
                      state.parts.push(bodyObj.chunkBase64);
                      if (!bodyObj.commit) {
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json; charset=utf-8');
                        res.end(
                          JSON.stringify({
                            ok: true,
                            partial: true,
                            uploadId: bodyObj.uploadId,
                            chunks: state.parts.length,
                          }),
                        );
                        return;
                      }
                      const fullB64 = state.parts.join('');
                      global.__orcaRemoteChatUploadChunks.delete(bodyObj.uploadId);
                      saved = saveChatImageBuffer(Buffer.from(fullB64, 'base64'), {
                        originalName: bodyObj.fileName,
                      });
                    } else if (typeof bodyObj.contentBase64 === 'string') {
                      const cleanB64 = bodyObj.contentBase64.replace(
                        /^data:[^;]+;base64,/i,
                        '',
                      );
                      saved = saveChatImageBuffer(Buffer.from(cleanB64, 'base64'), {
                        originalName: bodyObj.fileName,
                      });
                    } else {
                      throw new Error('Missing contentBase64 or chunkBase64');
                    }
                  } else {
                    saved = saveChatImageBuffer(rawBody, {
                      originalName:
                        parsedUrl.searchParams.get('name') || req.headers['x-file-name'] || '',
                    });
                  }

                  let chatDispatch = null;
                  if (saved && (attach || send)) {
                    chatDispatch = await global.__orcaDispatchAttachToChatWindows({
                      path: saved.path,
                      base64: saved.base64,
                      mimeType: saved.mimeType,
                      fileName: saved.fileName,
                      send: Boolean(send),
                      prompt: prompt || '',
                      ...(scopeKey ? { scopeKey } : {}),
                      ...(tabId ? { tabId } : {}),
                    });
                  }

                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(
                    JSON.stringify({
                      ok: true,
                      path: saved.path,
                      fileName: saved.fileName,
                      size: saved.size,
                      mimeType: saved.mimeType,
                      attached: Boolean(attach || send),
                      sent: Boolean(send),
                      ...(chatDispatch ? { chatDispatch } : {}),
                    }),
                  );
                } catch (err) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
                }
              });
              return true;
            }
          }
        } catch {}
      }
      return origEmit.apply(this, [event, req, res, ...rest]);
    };

  const attachToWindow = (win) => {
    if (!win || win.isDestroyed()) return;
    const run = () => {
      if (!win.isDestroyed()) {
        win.webContents
          .executeJavaScript(global.__orcaLatestRendererHookCode || rendererCode)
          .catch(() => {});
      }
    };
    run();
    if (!win.__agDidFinishLoadHooked) {
      win.__agDidFinishLoadHooked = true;
      win.webContents.on('did-finish-load', run);
    }
    if (!win.__orcaRemoteImageConsoleHooked) {
      win.__orcaRemoteImageConsoleHooked = true;
      // Electron 43 passes one event object; older releases pass (event, level, message).
      win.webContents.on('console-message', (event, _level, legacyMessage) => {
        const message = typeof event?.message === 'string' ? event.message : legacyMessage;
        if (typeof message !== 'string') return;
        const m = /^\[orca-remote-chat-image\] (\S+) ?(.*)$/s.exec(message);
        if (m) global.__orcaLogRemoteImage?.(`renderer-${m[1]}`, m[2]);
      });
    }
  };

  for (const win of BrowserWindow.getAllWindows()) {
    attachToWindow(win);
  }
  if (!global.__agBrowserWindowCreatedHooked) {
    global.__agBrowserWindowCreatedHooked = true;
    app.on('browser-window-created', (_event, win) => {
      attachToWindow(win);
    });
  }

  const wins = BrowserWindow.getAllWindows();
  return wins[0]
    ? wins[0].webContents.executeJavaScript(global.__orcaLatestRendererHookCode || rendererCode)
    : Promise.resolve(JSON.stringify({ ok: true, windows: 0 }));
}

const ORCA_MAIN_BINARY = '/Applications/Orca.app/Contents/MacOS/Orca';
const MIN_ORCA_UPTIME_FOR_SIGUSR1_SECONDS = 15;

function parsePsElapsedSeconds(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
  if (!m) return 0;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  const seconds = Number(m[4] || 0);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function isOrcaNodeEvalHelperCommand(cmd) {
  return /\s(?:-e|--eval|--print|-p)(?:\s|$)/.test(cmd);
}

function findOrcaMainProcess() {
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,etime=,command='], {
      encoding: 'utf8',
      timeout: 1500,
      maxBuffer: 16 * 1024 * 1024,
    });
    let fallbackCandidate = null;
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(?:([0-9]+(?:-[0-9]+)?(?::[0-9]+)+)\s+)?(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const elapsedSeconds = parsePsElapsedSeconds(m[2] || '');
      const cmd = m[3].trim();
      if (cmd === ORCA_MAIN_BINARY) {
        return { pid, elapsedSeconds };
      }
      if (
        cmd.startsWith(`${ORCA_MAIN_BINARY} `) &&
        !cmd.includes('--type=') &&
        !cmd.includes('out/cli/') &&
        !cmd.includes('out/daemon/') &&
        !isOrcaNodeEvalHelperCommand(cmd) &&
        !fallbackCandidate
      ) {
        fallbackCandidate = { pid, elapsedSeconds };
      }
    }
    return fallbackCandidate || { pid: 0, elapsedSeconds: 0 };
  } catch {
    return { pid: 0, elapsedSeconds: 0 };
  }
}

function findOrcaMainPid() {
  return findOrcaMainProcess().pid;
}

function fetchInspectorWsUrl() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: 9229, path: '/json', timeout: 400 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const targets = JSON.parse(body);
            resolve(targets?.[0]?.webSocketDebuggerUrl || '');
          } catch {
            resolve('');
          }
        });
      },
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

export async function ensureOrcaAntigravityIconHook({ force = false } = {}) {
  ensureDirs();
  ensureHookScriptInstalled();
  const { pid, elapsedSeconds } = findOrcaMainProcess();
  if (!pid) return false;

  const selfPath = new URL(import.meta.url).pathname;
  let scriptMtime = 0;
  try {
    scriptMtime = Math.floor(fs.statSync(selfPath).mtimeMs);
  } catch {}
  let asarMtime = 0;
  try {
    asarMtime = Math.floor(
      fs.statSync('/Applications/Orca.app/Contents/Resources/app.asar').mtimeMs,
    );
  } catch {}
  const expectedMarker = `${pid}:${scriptMtime}:${asarMtime}`;

  const markerFile = path.join(STATE_DIR, 'patched-orca-main.pid');
  if (!force && fs.existsSync(markerFile)) {
    try {
      const savedMarker = fs.readFileSync(markerFile, 'utf8').trim();
      if (savedMarker === expectedMarker) return true;
    } catch {}
  }

  let wsUrl = await fetchInspectorWsUrl();
  if (!wsUrl && elapsedSeconds >= MIN_ORCA_UPTIME_FOR_SIGUSR1_SECONDS) {
    // Never signal Orca during early startup (<15s): SIGUSR1 before Node installs its
    // inspector handler can terminate the process. Once Orca is mature, signal at most
    // once per PID and leave the inspector open so subsequent runs connect without signals.
    const signalMarkerFile = path.join(STATE_DIR, 'signaled-orca-main.pid');
    let alreadySignaledPid = 0;
    try {
      alreadySignaledPid = Number(fs.readFileSync(signalMarkerFile, 'utf8').trim());
    } catch {}
    if (alreadySignaledPid !== pid) {
      try {
        fs.writeFileSync(signalMarkerFile, String(pid), 'utf8');
      } catch {}
      try {
        process.kill(pid, 'SIGUSR1');
      } catch {
        return false;
      }
      for (let i = 0; i < 6 && !wsUrl; i++) {
        await new Promise((r) => setTimeout(r, 120));
        wsUrl = await fetchInspectorWsUrl();
      }
    }
  }
  if (!wsUrl) return false;

  const expr =
    '(' +
    mainProcessAntigravityIconInstaller.toString() +
    ')(' +
    JSON.stringify(rendererAntigravityIconSync.toString()) +
    ')';

  const patched = await new Promise((resolve) => {
    let settled = false;
    let ws;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(false), 2500);
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => { if (process.pid !== ${pid}) throw new Error('Inspector belongs to another process'); return ${expr}; })()`,
              includeCommandLineAPI: true,
              awaitPromise: true,
            },
          }),
        );
      };
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.id === 1) {
            const ok = Boolean(!data.error && !data.result?.exceptionDetails);
            finish(ok);
          }
        } catch {}
      };
      ws.onerror = () => {
        finish(false);
      };
      ws.onclose = () => finish(false);
    } catch {
      finish(false);
    }
  });

  if (patched) {
    try {
      fs.writeFileSync(markerFile, expectedMarker, 'utf8');
    } catch {}
    try {
      const syncProfileHooksBin = path.join(HOME, '.local', 'bin', 'orca-sync-profile-hooks');
      if (fs.existsSync(syncProfileHooksBin)) {
        execFileSync(syncProfileHooksBin, [], { stdio: 'ignore', timeout: 3000 });
      }
    } catch {}
  }
  return patched;
}

export async function postOrcaClaudeHook(env, claudePayload) {
  await ensureOrcaAntigravityIconHook().catch(() => false);
  const resolvedEnv = loadEndpointEnv(env);
  const port = Number(resolvedEnv.ORCA_AGENT_HOOK_PORT);
  const token = resolvedEnv.ORCA_AGENT_HOOK_TOKEN;
  const paneKey = resolvedEnv.ORCA_PANE_KEY;
  if (!port || !token || !paneKey) {
    return false;
  }

  try {
    const endpointFile =
      resolvedEnv.ORCA_AGENT_HOOK_ENDPOINT ||
      path.join(HOME, 'Library', 'Application Support', 'orca', 'agent-hooks', 'endpoint.env');
    const lastStatusPath = path.join(path.dirname(endpointFile), 'last-status.json');
    if (fs.existsSync(lastStatusPath)) {
      const statusJson = JSON.parse(fs.readFileSync(lastStatusPath, 'utf8'));
      const existing = statusJson?.entries?.[paneKey];
      if (
        existing &&
        (existing.source === 'antigravity' || existing.payload?.agentType === 'antigravity') &&
        existing.payload?.state !== 'done'
      ) {
        const retireForm = new URLSearchParams({
          paneKey,
          tabId: resolvedEnv.ORCA_TAB_ID || existing.tabId || paneKey.split(':')[0] || '',
          launchToken: resolvedEnv.ORCA_AGENT_LAUNCH_TOKEN || '',
          worktreeId: resolvedEnv.ORCA_WORKTREE_ID || existing.worktreeId || '',
          env: resolvedEnv.ORCA_AGENT_HOOK_ENV || 'production',
          version: resolvedEnv.ORCA_AGENT_HOOK_VERSION || '1',
          hook_event_name: 'Stop',
          payload: JSON.stringify({ hook_event_name: 'Stop', fullyIdle: true }),
        }).toString();
        await new Promise((r) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path: '/hook/antigravity',
              method: 'POST',
              timeout: 800,
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(retireForm),
                'X-Orca-Agent-Hook-Token': token,
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => r(true));
            },
          );
          req.on('error', () => r(false));
          req.on('timeout', () => {
            req.destroy();
            r(false);
          });
          req.write(retireForm);
          req.end();
        });
      }
    }
  } catch {}

  return new Promise((resolve) => {
    const body = JSON.stringify(claudePayload);
    const metaRaw = [
      paneKey,
      resolvedEnv.ORCA_TAB_ID || '',
      resolvedEnv.ORCA_AGENT_LAUNCH_TOKEN || '',
      resolvedEnv.ORCA_WORKTREE_ID || '',
      resolvedEnv.ORCA_AGENT_HOOK_ENV || 'production',
      resolvedEnv.ORCA_AGENT_HOOK_VERSION || '1',
    ].join('\x1f');
    const metaB64 = Buffer.from(metaRaw, 'utf8').toString('base64');

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/hook/claude',
        method: 'POST',
        timeout: 1500,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Orca-Agent-Hook-Token': token,
          'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
          'X-Orca-Agent-Hook-Meta': metaB64,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 204 || res.statusCode === 200));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

function normalizeOptionalPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('--') ? p : undefined;
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureBackgroundWatcher(conversationId, sourceTranscriptPath, parentPid = 0) {
  ensureDirs();
  const cleanSourcePath = normalizeOptionalPath(sourceTranscriptPath);
  const pidFile = path.join(STATE_DIR, `${conversationId}.watcher.pid`);
  if (fs.existsSync(pidFile)) {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (isPidAlive(pid)) {
        return;
      }
    } catch {
      // Watcher is no longer alive.
    }
  }
  const argsList = [
    new URL(import.meta.url).pathname,
    '--watch',
    conversationId,
    ...(cleanSourcePath ? [cleanSourcePath] : []),
    ...(parentPid > 1 ? [`--ppid=${parentPid}`] : []),
  ];
  const child = spawn(process.execPath, argsList, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

async function runWatcher(conversationId, sourceTranscriptPath, parentPid = 0) {
  ensureDirs();
  const cleanSourcePath = normalizeOptionalPath(sourceTranscriptPath);
  const pidFile = path.join(STATE_DIR, `${conversationId}.watcher.pid`);
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  const stopFlagFile = path.join(STATE_DIR, `${conversationId}.stopped`);
  if (process.env.ORCA_PANE_KEY) {
    try {
      fs.writeFileSync(
        path.join(STATE_DIR, `${conversationId}.pane`),
        process.env.ORCA_PANE_KEY,
        'utf8',
      );
    } catch {}
  }

  let lastMtimeMs = 0;
  let idleTicks = 0;
  const maxIdleTicks = 14400; // 60 minutes at 250ms

  const initial = syncTranscript(conversationId, cleanSourcePath);
  let lastStepCount = initial?.stepCount || 0;
  let lastSynced = initial;
  let pendingStop = initial?.lastStepState === 'end_turn';

  const cleanupAndExit = () => {
    try {
      if (fs.existsSync(pidFile)) {
        const recorded = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (recorded === process.pid) fs.unlinkSync(pidFile);
      }
    } catch {}
    process.exit(0);
  };

  const tick = () => {
    const logsDir = cleanSourcePath
      ? path.dirname(cleanSourcePath)
      : path.join(BRAIN_DIR, conversationId, '.system_generated', 'logs');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    const watchPath = fs.existsSync(fullPath) ? fullPath : compactPath;
    try {
      if (fs.existsSync(watchPath)) {
        const stat = fs.statSync(watchPath);
        if (stat.mtimeMs > lastMtimeMs) {
          lastMtimeMs = stat.mtimeMs;
          idleTicks = 0;
          const synced = syncTranscript(conversationId, watchPath);
          if (synced && synced.stepCount > lastStepCount) {
            lastStepCount = synced.stepCount;
            lastSynced = synced;
            if (synced.lastStepState === 'working') {
              pendingStop = false;
              try {
                fs.unlinkSync(stopFlagFile);
              } catch {}
              postOrcaClaudeHook(process.env, {
                hook_event_name: 'PostToolUse',
                session_id: conversationId,
                transcript_path: synced.targetPath,
                tool_name: 'Bash',
                tool_input: {},
              }).catch(() => {});
            } else if (synced.lastStepState === 'end_turn') {
              pendingStop = true;
            }
          }
          return;
        }
      }
    } catch {
      // Ignore transient stat errors.
    }
    idleTicks += 1;
    if (pendingStop && idleTicks >= 3) {
      pendingStop = false;
      postOrcaClaudeHook(process.env, {
        hook_event_name: 'Stop',
        session_id: conversationId,
        transcript_path: lastSynced?.targetPath,
        ...(lastSynced?.lastAssistantMessage
          ? { last_assistant_message: lastSynced.lastAssistantMessage }
          : {}),
      }).catch(() => {});
    }
    if (parentPid > 1 && !isPidAlive(parentPid) && idleTicks > 8) {
      cleanupAndExit();
    } else if (parentPid <= 1 && fs.existsSync(stopFlagFile) && idleTicks > 240) {
      cleanupAndExit();
    } else if (idleTicks >= maxIdleTicks) {
      cleanupAndExit();
    }
  };

  process.on('SIGTERM', cleanupAndExit);
  process.on('SIGINT', cleanupAndExit);

  setInterval(tick, 250);
}

function ensurePaneWatcher(parentPid, startMs) {
  if (!process.env.ORCA_PANE_KEY) return;
  ensureDirs();
  const paneSlug = process.env.ORCA_PANE_KEY.replace(/[^A-Za-z0-9_-]/g, '-').slice(-36);
  const pidFile = path.join(STATE_DIR, `pane-${paneSlug}.watcher.pid`);
  if (fs.existsSync(pidFile)) {
    try {
      const oldPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (oldPid > 0 && oldPid !== process.pid) {
        process.kill(oldPid, 'SIGTERM');
      }
    } catch {}
  }
  const child = spawn(
    process.execPath,
    [
      new URL(import.meta.url).pathname,
      '--watch-pane',
      String(parentPid || 0),
      String(startMs || Date.now()),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  child.unref();
}

async function runPaneWatcher(parentPid, startMs) {
  const paneKey = process.env.ORCA_PANE_KEY || '';
  if (!paneKey) return;
  ensureDirs();
  const paneSlug = paneKey.replace(/[^A-Za-z0-9_-]/g, '-').slice(-36);
  const pidFile = path.join(STATE_DIR, `pane-${paneSlug}.watcher.pid`);
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');

  const cleanupAndExit = () => {
    try {
      if (fs.existsSync(pidFile)) {
        const recorded = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (recorded === process.pid) fs.unlinkSync(pidFile);
      }
    } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', cleanupAndExit);
  process.on('SIGINT', cleanupAndExit);

  let ticks = 0;
  const maxDiscoveryTicks = 10800; // 60 minutes at 333ms
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const timer = setInterval(async () => {
    ticks += 1;
    if (parentPid > 1 && !isPidAlive(parentPid) && ticks > 10) {
      clearInterval(timer);
      cleanupAndExit();
      return;
    }
    if (ticks >= maxDiscoveryTicks) {
      clearInterval(timer);
      cleanupAndExit();
      return;
    }

    try {
      if (!fs.existsSync(BRAIN_DIR)) return;
      const entries = fs.readdirSync(BRAIN_DIR);
      let bestId = '';
      let bestPath = '';
      let bestMtime = 0;

      for (const name of entries) {
        if (!uuidRe.test(name)) continue;
        const logsDir = path.join(BRAIN_DIR, name, '.system_generated', 'logs');
        const fullPath = path.join(logsDir, 'transcript_full.jsonl');
        const compactPath = path.join(logsDir, 'transcript.jsonl');
        const candidatePath = fs.existsSync(fullPath)
          ? fullPath
          : fs.existsSync(compactPath)
            ? compactPath
            : '';
        if (!candidatePath) continue;
        const stat = fs.statSync(candidatePath);
        if (stat.mtimeMs < startMs - 2500) continue;

        const paneClaimFile = path.join(STATE_DIR, `${name}.pane`);
        if (fs.existsSync(paneClaimFile)) {
          const claimedBy = fs.readFileSync(paneClaimFile, 'utf8').trim();
          if (claimedBy && claimedBy !== paneKey) continue;
        }

        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestId = name;
          bestPath = candidatePath;
        }
      }

      if (bestId) {
        clearInterval(timer);
        fs.writeFileSync(path.join(STATE_DIR, `${bestId}.pane`), paneKey, 'utf8');
        const synced = syncTranscript(bestId, bestPath);
        await postOrcaClaudeHook(process.env, {
          hook_event_name:
            synced?.lastStepState === 'working' ? 'UserPromptSubmit' : 'SessionStart',
          source: 'startup',
          session_id: bestId,
          transcript_path: synced?.targetPath,
          ...(synced?.lastStepState === 'working'
            ? { prompt: synced?.lastUserPrompt || 'Antigravity turn' }
            : {}),
        });
        await runWatcher(bestId, bestPath, parentPid);
      }
    } catch {
      // Ignore transient errors during discovery.
    }
  }, 333);
}

async function switchCurrentTabToChat(viewMode = 'chat') {
  const resolvedEnv = loadEndpointEnv(process.env);
  const handle = resolvedEnv.ORCA_TERMINAL_HANDLE;
  let tabId = resolvedEnv.ORCA_TAB_ID || '';
  let paneKey = resolvedEnv.ORCA_PANE_KEY || '';
  let worktreeId = resolvedEnv.ORCA_WORKTREE_ID || '';

  try {
    if (handle && (!tabId || !worktreeId)) {
      const { RuntimeClient } = require(
        '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js',
      );
      const client = new RuntimeClient(undefined, 5000, null, null);
      const termRes = await client.call('terminal.show', { terminal: handle });
      const terminal = termRes?.result?.terminal;
      if (terminal?.tabId) tabId = terminal.tabId;
      if (terminal?.worktreeId) worktreeId = terminal.worktreeId;
      if (!paneKey && terminal?.tabId && terminal?.leafId) {
        paneKey = `${terminal.tabId}:${terminal.leafId}`;
      }
    }
  } catch {}

  if (!tabId && paneKey) {
    tabId = paneKey.split(':')[0] || '';
  }

  let switchedRenderer = false;
  const port = Number(resolvedEnv.ORCA_AGENT_HOOK_PORT) || 6768;
  if (tabId || paneKey) {
    const qs = new URLSearchParams({
      ...(tabId ? { tabId } : {}),
      ...(paneKey ? { paneKey } : {}),
      viewMode,
    }).toString();
    switchedRenderer = await new Promise((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: `/orca-ag-switch-chat?${qs}`,
          timeout: 1200,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode === 200));
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  try {
    if (worktreeId && tabId) {
      const { RuntimeClient } = require(
        '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js',
      );
      const client = new RuntimeClient(undefined, 5000, null, null);
      await client.call('session.tabs.setTabProps', {
        worktree: `id:${worktreeId}`,
        tabId,
        viewMode,
      });
      return true;
    }
  } catch {}

  return switchedRenderer;
}

async function bootstrapSession(options = {}) {
  ensureHookScriptInstalled();
  const explicitSessionId =
    options.sessionId ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    '';
  let sessionId = explicitSessionId;
  if (!sessionId) {
    const paneSuffix = (process.env.ORCA_PANE_KEY || '')
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(-24);
    sessionId = `ag-boot-${paneSuffix || randomUUID().slice(0, 8)}`;
  }
  const synced = syncTranscript(sessionId);
  await postOrcaClaudeHook(process.env, {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: sessionId,
    transcript_path: synced?.targetPath,
  });
  if (explicitSessionId) {
    ensureBackgroundWatcher(explicitSessionId, undefined, process.ppid);
  } else {
    ensurePaneWatcher(process.ppid, Date.now());
  }
  if (options.switchChat) {
    await switchCurrentTabToChat('chat');
  }
  return { sessionId, transcriptPath: synced?.targetPath };
}

async function readStdinWithTimeout(timeoutMs = 1500) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', finish);
      process.stdin.removeListener('error', finish);
      try {
        process.stdin.pause();
      } catch {}
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    };
    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
    process.stdin.resume();
  });
}

async function handleHookEvent() {
  const rawStdin = await readStdinWithTimeout(1500);
  let hookPayload = {};
  if (rawStdin) {
    try {
      hookPayload = JSON.parse(rawStdin);
    } catch {
      hookPayload = {};
    }
  }

  const agEvent =
    process.env.ORCA_ANTIGRAVITY_EVENT ||
    hookPayload.hook_event_name ||
    hookPayload.hookEventName ||
    'PostInvocation';

  // Emit required stdout immediately so agy never blocks on our hook.
  if (agEvent === 'Stop') {
    process.stdout.write('{"decision":""}\n');
  } else if (agEvent === 'PreToolUse') {
    process.stdout.write('{"decision":"ask"}\n');
  } else {
    process.stdout.write('{}\n');
  }

  const sourceTranscriptPath =
    hookPayload.transcriptPath || hookPayload.transcript_path || '';
  const conversationId =
    hookPayload.conversationId ||
    hookPayload.conversation_id ||
    hookPayload.session_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    (sourceTranscriptPath
      ? path.basename(path.resolve(sourceTranscriptPath, '..', '..', '..'))
      : '');

  if (!conversationId) return;

  ensureDirs();
  const stopFlagFile = path.join(STATE_DIR, `${conversationId}.stopped`);
  const synced = syncTranscript(conversationId, sourceTranscriptPath || undefined);
  const convertedTranscriptPath = synced?.targetPath;

  const stopStillBusy =
    agEvent === 'Stop' &&
    (hookPayload.fullyIdle === false || hookPayload.fully_idle === false);

  if (agEvent === 'PreInvocation' || agEvent === 'SessionStart' || agEvent === 'PreToolUse') {
    try {
      fs.unlinkSync(stopFlagFile);
    } catch {}
    ensureBackgroundWatcher(conversationId, sourceTranscriptPath || undefined);
  } else if (agEvent !== 'Stop' && fs.existsSync(stopFlagFile)) {
    // Antigravity can emit a bookkeeping PostToolUse after a terminal Stop; ignore status transition.
    return;
  }

  let claudeEvent = null;
  if (agEvent === 'SessionStart') {
    claudeEvent = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: conversationId,
      transcript_path: convertedTranscriptPath,
    };
  } else if (agEvent === 'PreInvocation') {
    claudeEvent = {
      hook_event_name: 'UserPromptSubmit',
      session_id: conversationId,
      transcript_path: convertedTranscriptPath,
      prompt:
        hookPayload.prompt ||
        hookPayload.user_prompt ||
        synced?.lastUserPrompt ||
        'Antigravity turn',
    };
  } else if (agEvent === 'PreToolUse') {
    ensureBackgroundWatcher(conversationId, sourceTranscriptPath || undefined);
    const rawTool =
      hookPayload.toolCall && typeof hookPayload.toolCall === 'object'
        ? hookPayload.toolCall
        : {
            name: hookPayload.tool_name || hookPayload.name || 'tool',
            args: hookPayload.tool_input || hookPayload.args || {},
          };
    const mapped = mapAntigravityToolCall(rawTool, false);
    claudeEvent = {
      hook_event_name: 'PreToolUse',
      session_id: conversationId,
      transcript_path: convertedTranscriptPath,
      tool_name: mapped.name,
      tool_input: mapped.input,
    };
  } else if (agEvent === 'PostToolUse' || agEvent === 'PostInvocation' || stopStillBusy) {
    ensureBackgroundWatcher(conversationId, sourceTranscriptPath || undefined);
    const rawTool =
      hookPayload.toolCall && typeof hookPayload.toolCall === 'object'
        ? hookPayload.toolCall
        : {
            name: hookPayload.tool_name || hookPayload.name || 'Bash',
            args: hookPayload.tool_input || hookPayload.args || {},
          };
    const mapped = mapAntigravityToolCall(rawTool, false);
    claudeEvent = {
      hook_event_name: 'PostToolUse',
      session_id: conversationId,
      transcript_path: convertedTranscriptPath,
      tool_name: mapped.name,
      tool_input: mapped.input,
    };
  } else if (agEvent === 'Stop') {
    fs.writeFileSync(stopFlagFile, String(Date.now()), 'utf8');
    claudeEvent = {
      hook_event_name: 'Stop',
      session_id: conversationId,
      transcript_path: convertedTranscriptPath,
      ...(synced?.lastAssistantMessage
        ? { last_assistant_message: synced.lastAssistantMessage }
        : {}),
    };
  }

  if (claudeEvent) {
    await postOrcaClaudeHook(process.env, claudeEvent);
  }
}

function killExistingWatcher(conversationId) {
  const pidFile = path.join(STATE_DIR, `${conversationId}.watcher.pid`);
  if (!fs.existsSync(pidFile)) return;
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (pid > 0 && pid !== process.pid) {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return path.basename(process.argv[1]) === 'antigravity-chat-sync.mjs';
  }
})();

if (isMainModule) {
  const args = process.argv.slice(2);
  if (args[0] === '--watch' && args[1]) {
    const ppidArg = args.find((a) => a.startsWith('--ppid='));
    const parentPid = ppidArg ? Number(ppidArg.slice('--ppid='.length)) : 0;
    await runWatcher(args[1], normalizeOptionalPath(args[2]), parentPid);
  } else if (args[0] === '--watch-pane') {
    const parentPid = Number(args[1] || 0);
    const startMs = Number(args[2] || Date.now());
    await runPaneWatcher(parentPid, startMs);
  } else if (args[0] === '--patch-orca') {
    ensureHookScriptInstalled();
    const force = args.includes('--force');
    const ok = await ensureOrcaAntigravityIconHook({ force });
    console.log(JSON.stringify({ ok }));
    process.exit(0);
  } else if (args[0] === '--bootstrap') {
    const sessionIdArg = normalizeOptionalPath(args[1]);
    const switchChat = args.includes('--chat');
    const res = await bootstrapSession({ sessionId: sessionIdArg, switchChat });
    if (args.includes('--verbose')) {
      console.log(JSON.stringify(res));
    }
    process.exit(0);
  } else if (args[0] === '--sync' && args[1]) {
    ensureHookScriptInstalled();
    const explicitPath = normalizeOptionalPath(args[2]);
    const reset = args.includes('--reset');
    if (reset) {
      killExistingWatcher(args[1]);
    }
    const result = syncTranscript(args[1], explicitPath, { reset });
    if (args.includes('--emit')) {
      const eventType = args.includes('--working') ? 'UserPromptSubmit' : 'Stop';
      await postOrcaClaudeHook(process.env, {
        hook_event_name: eventType,
        session_id: args[1],
        transcript_path: result?.targetPath,
        ...(eventType === 'UserPromptSubmit'
          ? { prompt: result?.lastUserPrompt || 'Antigravity session' }
          : {}),
        ...(eventType === 'Stop' && result?.lastAssistantMessage
          ? { last_assistant_message: result.lastAssistantMessage }
          : {}),
      });
    }
    if (args.includes('--chat')) {
      await switchCurrentTabToChat('chat');
    }
    if (args.includes('--watch-bg')) {
      ensureBackgroundWatcher(args[1], explicitPath);
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  } else {
    await handleHookEvent();
    process.exit(0);
  }
}
