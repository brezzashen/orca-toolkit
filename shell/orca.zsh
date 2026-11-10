# >>> orca account shortcut aliases >>>
# Type these in an Orca terminal to run the per-account agent in that same terminal.
# Typed launches preserve the current tab and focus, including on the Orca phone client.
# Append --new-tab to explicitly open and focus another tab without closing the caller.
# Aliases come from account-shortcuts/accounts.json. The template fills F1-F12:
#   CL1-CL7 -> Claude Code A1-A7 (F1-F7)      CO1, CO2 -> Codex C1, C2 (F8, F9)
#   AG1, AG2 -> Antigravity (F10, F11)        GO1 -> Grok (F12)
# Edit _orca_aliases below when you add or remove accounts there. An alias must never equal its
# account's `command` (ag1 runs agy): the launcher's shell would call the alias again.
#   ccp <profile> / cxp <profile> select a Claude Code / Codex profile in this shell:
#   "default" uses ~/.claude or ~/.codex, any other name ~/.claude-profiles/<name> or ~/.codex-profiles/<name>.
ccp() {
  if [[ -z "$1" || "$1" == default ]]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$HOME/.claude-profiles/$1"; fi
}
cxp() {
  if [[ -z "$1" || "$1" == default ]]; then unset CODEX_HOME; else export CODEX_HOME="$HOME/.codex-profiles/$1"; fi
}
orca_account_tab() {
  if [[ -x "$HOME/.local/bin/orca-account-launch" ]]; then
    "$HOME/.local/bin/orca-account-launch" "$@"
  else
    "$HOME/.local/bin/node" "$HOME/.orca/account-shortcuts/launch.ts" "$@"
  fi
}
_orca_aliases=(CL1 CL2 CL3 CL4 CL5 CL6 CL7 CO1 CO2 AG1 AG2 GO1)
for _orca_alias in $_orca_aliases; do
  eval "${_orca_alias}() { orca_account_tab ${_orca_alias} \"\$@\"; }"
  eval "${_orca_alias:l}() { orca_account_tab ${_orca_alias} \"\$@\"; }"
done
unset _orca_alias
# <<< orca account shortcut aliases <<<

# >>> orca remote clipboard >>>
# Orca serves this Mac's terminals to other Macs over its websocket runtime, not SSH, so
# TUIs such as Codex see no SSH_TTY and copy into this Mac's clipboard instead of the
# viewer's. SSH_TTY makes them emit OSC 52, which the displaying Orca writes locally.
if [[ "$TERM_PROGRAM" == Orca && -z "$SSH_TTY" && -n "$TTY" ]]; then
  export SSH_TTY="$TTY"
fi
# <<< orca remote clipboard <<<

# >>> orca fast pane close >>>
# Orca's terminal daemon stops a closed pane with SIGTERM and only sends SIGKILL after a 2 s
# grace. Interactive zsh ignores SIGTERM, so every close waited the whole grace (~2.5 s).
# Exiting on SIGTERM lets the daemon see the shell gone on its next process-table scan.
if [[ "$TERM_PROGRAM" == Orca && -o interactive ]]; then
  TRAPTERM() { exit 143 }
fi
# <<< orca fast pane close <<<

# >>> orca reopen resume >>>
# Cmd+Shift+T (Orca tab.reopenClosed) brings back a closed tab's cwd and title but starts a bare
# shell. On the first prompt, `resume-home reopen` names the agent session that last held that
# title in a closed pane, and the shell resumes it under its owning account.
orca_reopen_tab() {
  local cmd
  if [[ -x "$HOME/.local/bin/orca-account-launch" ]]; then
    cmd=$("$HOME/.local/bin/orca-account-launch" --restore-latest 2>/dev/null)
  else
    cmd=$("$HOME/.local/bin/resume-home" reopen --latest 2>/dev/null)
  fi
  [[ -n $cmd ]] || return 0
  print -r -- "reopen: $cmd"
  print -s -- "$cmd"
  eval "$cmd"
}
if [[ "$TERM_PROGRAM" == Orca && -o interactive && -z "$ZSH_EXECUTION_STRING" && -n "$ORCA_TERMINAL_HANDLE" ]]; then
  _orca_reopen_resume() {
    add-zsh-hook -d precmd _orca_reopen_resume
    unfunction _orca_reopen_resume
    local cmd
    cmd=$("$HOME/.local/bin/resume-home" reopen 2>/dev/null)
    [[ -n $cmd ]] || return 0
    print -r -- "reopen: $cmd"
    print -s -- "$cmd"
    eval "$cmd"
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd _orca_reopen_resume
fi
# <<< orca reopen resume <<<

