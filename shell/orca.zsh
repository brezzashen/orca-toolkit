# >>> orca account shortcut aliases >>>
# Type these in an Orca terminal to run the per-account agent in that same terminal.
# Typed launches preserve the current tab and focus, including on the Orca phone client.
# Append --new-tab to explicitly open and focus another tab without closing the caller.
# Aliases come from account-shortcuts/accounts.json (CL1, CL2, CO1, CO2, GO1 in the template);
# edit _orca_aliases below when you add accounts there.
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
_orca_aliases=(CL1 CL2 CO1 CO2 GO1)
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

