#!/bin/sh
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
  exec "$NODE_BIN" "$HOME/.orca/agent-hooks/antigravity-chat-sync.mjs"
fi

case "${ORCA_ANTIGRAVITY_EVENT:-}" in
  Stop) printf '{"decision":""}\n' ;;
  PreToolUse) printf '{"decision":"ask"}\n' ;;
  *) printf '{}\n' ;;
esac
{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :
exit 0
