#!/usr/bin/env bash
# Statusline for profiles on a host where Orca installs its own reporter.
# Orca's claude-statusline.sh only POSTs the payload to the Orca pane and prints
# nothing, so it is fed first and the visible bars come from statusline-command.sh.
input=$(cat)
orca="$HOME/.orca/agent-hooks/claude-statusline.sh"
if [ -x "$orca" ]; then printf '%s' "$input" | /bin/sh "$orca" >/dev/null 2>&1 || :; fi
printf '%s' "$input" | bash "$HOME/.claude/statusline-command.sh"
