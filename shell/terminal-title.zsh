# Keep Ghostty's tab title useful while Codex is running over SSH + tmux.
#
# ~/.tmux.conf forwards pane_title (#T) to the outer terminal.  Codex does
# not currently set that title itself, so wrap the real binary and give the
# active pane a stable name derived from the tmux session.
# Orca panes also need a separate Codex server to retain their hook environment.

if (( $+commands[codex] )); then
  typeset -g _CODEX_TITLE_BIN="${commands[codex]}"
elif [[ -x /opt/homebrew/bin/codex ]]; then
  typeset -g _CODEX_TITLE_BIN="/opt/homebrew/bin/codex"
fi

if (( $+commands[tmux] )); then
  typeset -g _CODEX_TITLE_TMUX_BIN="${commands[tmux]}"
elif [[ -x /opt/homebrew/bin/tmux ]]; then
  typeset -g _CODEX_TITLE_TMUX_BIN="/opt/homebrew/bin/tmux"
fi

run_codex_with_global_terminal_title_notification() {
  local codex_bin="$1"
  local terminal_device_path="${CODEX_TERMINAL_DEVICE:-}"
  shift

  if [[ -z "$terminal_device_path" ]]; then
    if ! terminal_device_path="$(tty 2>/dev/null)"; then
      terminal_device_path="/dev/tty"
    fi
  fi

  local -x CODEX_TERMINAL_DEVICE="$terminal_device_path"
  local codex_arg
  local use_orca_isolation=0
  if [[ -n "${ORCA_PANE_KEY:-}" && "${ORCA_CODEX_ISOLATE:-1}" != 0 ]]; then
    use_orca_isolation=1
    for codex_arg in "$@"; do
      case "$codex_arg" in
        agents|queue|--no-daemon|--remote|--remote=*) use_orca_isolation=0 ;;
      esac
    done
    if (( use_orca_isolation )); then
      case "$("$codex_bin" --help 2>/dev/null </dev/null)" in
        *--no-daemon*) set -- --no-daemon "$@" ;;
      esac
    fi
  fi
  # Keep notification settings in config.toml for every launch mode.
  PATH="${codex_bin:h}:$PATH" "$codex_bin" \
    "$@"
}

codex() {
  local codex_bin="${_CODEX_TITLE_BIN:-}"
  local tmux_bin="${_CODEX_TITLE_TMUX_BIN:-}"
  local old_title=""
  local session_name=""
  local exit_status=0

  if [[ -z "$codex_bin" || ! -x "$codex_bin" ]]; then
    print -u2 "codex: executable not found"
    return 127
  fi

  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" && -x "$tmux_bin" ]]; then
    old_title="$("$tmux_bin" display-message -p -t "$TMUX_PANE" '#T' 2>/dev/null)"
    session_name="$("$tmux_bin" display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)"

    if [[ -n "$session_name" ]]; then
      "$tmux_bin" select-pane -t "$TMUX_PANE" -T "Codex · ${session_name}" 2>/dev/null
    fi

    run_codex_with_global_terminal_title_notification "$codex_bin" "$@"
    exit_status=$?

    if [[ -n "$session_name" ]]; then
      "$tmux_bin" select-pane -t "$TMUX_PANE" -T "$old_title" 2>/dev/null
    fi
    return $exit_status
  fi

  run_codex_with_global_terminal_title_notification "$codex_bin" "$@"
}
