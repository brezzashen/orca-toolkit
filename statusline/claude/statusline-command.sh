#!/usr/bin/env bash
input=$(cat)

# Persist the session's plan quota so the token dashboard can read it without polling the usage endpoint.
if jq -e '.rate_limits.five_hour or .rate_limits.seven_day' >/dev/null 2>&1 <<<"$input"; then
  rl_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  rl_tmp="$rl_dir/.rate-limits.json.$$"
  jq -c --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{capturedAt: $at, rate_limits: .rate_limits}' <<<"$input" >"$rl_tmp" 2>/dev/null \
    && mv -f "$rl_tmp" "$rl_dir/rate-limits.json" || rm -f "$rl_tmp"
fi

reset=$'\033[0m'; bold=$'\033[1m'; dim=$'\033[2m'
cyan=$'\033[36m'; yellow=$'\033[33m'; green=$'\033[32m'; red=$'\033[31m'; orange=$'\033[38;5;208m'

model=$(jq -r '.model.display_name // "?"' <<<"$input")
dir=$(jq -r '.workspace.current_dir // "?"' <<<"$input")
dirname=${dir##*/}

# Every gauge shows what is left; the plan quota matches the token dashboard.
read -r ctx_pct five_left five_reset seven_left seven_reset cost <<<"$(jq -r '[
  (.context_window.used_percentage // 0 | round),
  (100 - (.rate_limits.five_hour.used_percentage // 0) | round),
  (.rate_limits.five_hour.resets_at // 0),
  (100 - (.rate_limits.seven_day.used_percentage // 0) | round),
  (.rate_limits.seven_day.resets_at // 0),
  (.cost.total_cost_usd // 0)
] | @tsv' <<<"$input")"

# Every session redraws this line often; caching the git reading for 10 s per directory keeps
# many sessions from scanning the same large worktree several times a second.
git_cache="${TMPDIR:-/tmp}/statusline-git-$(printf '%s' "$dir" | shasum | cut -c1-16)"
if [ -f "$git_cache" ] && [ $(( $(date +%s) - $(stat -f %m "$git_cache") )) -lt 10 ]; then
  IFS=$'\t' read -r branch dirty <"$git_cache"
else
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
  dirty=""
  if [ -n "$branch" ] && [ -n "$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ]; then dirty="*"; fi
  printf '%s\t%s\n' "$branch" "$dirty" >"$git_cache.$$" && mv -f "$git_cache.$$" "$git_cache"
fi
git_info=""
[ -n "$branch" ] && git_info="  ${yellow}git:(${branch}${dirty})${reset}"

pct_color() { # used percent
  if [ "$1" -lt 50 ]; then printf '%s' "$green"
  elif [ "$1" -lt 80 ]; then printf '%s' "$yellow"
  else printf '%s' "$red"; fi
}

mkbar() { # pct width [color_pct]
  local pct=$1 width=$2 color_pct=${3:-$1} filled bar="" i
  filled=$(( pct * width / 100 ))
  [ "$filled" -gt "$width" ] && filled=$width
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=filled; i<width; i++)); do bar+="░"; done
  printf '%s%s%s' "$(pct_color "$color_pct")" "$bar" "$reset"
}

fmt_reset() { # epoch
  local diff=$(( $1 - $(date +%s) ))
  if [ "$diff" -le 0 ]; then printf 'resetting…'
  elif [ "$diff" -ge 86400 ]; then printf '%dd %dh' $(( diff / 86400 )) $(( (diff % 86400) / 3600 ))
  elif [ "$diff" -ge 3600 ]; then printf '%dh %dm' $(( diff / 3600 )) $(( (diff % 3600) / 60 ))
  else printf '%dm' $(( diff / 60 )); fi
}

cost_str=$(printf '$%.2f' "$cost")

# Every account's weekly quota (Claude cc*, then Codex co*, then AG1) comes from
# `limit-resume route --json`, shared by all sessions
# through one cache file and refreshed in the background at most once a minute, so a render never
# waits on the token dashboard.
acct_cache="${TMPDIR:-/tmp}/statusline-accounts.json"
acct_lock="$acct_cache.lock"
if [ ! -f "$acct_cache" ] || [ $(( $(date +%s) - $(stat -f %m "$acct_cache") )) -ge 60 ]; then
  # A lock older than two minutes belongs to a refresh that died.
  [ -d "$acct_lock" ] && [ $(( $(date +%s) - $(stat -f %m "$acct_lock") )) -ge 120 ] && rmdir "$acct_lock" 2>/dev/null
  if mkdir "$acct_lock" 2>/dev/null; then
    ( "$HOME/.local/bin/limit-resume" route --json >"$acct_cache.$$" 2>/dev/null && [ -s "$acct_cache.$$" ] \
        && mv -f "$acct_cache.$$" "$acct_cache" || rm -f "$acct_cache.$$"; rmdir "$acct_lock" ) >/dev/null 2>&1 &
  fi
fi
my_home=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
my_home=${my_home%/}
acct_line=""; my_alias=""
if [ -s "$acct_cache" ]; then
  # alias, weekly percent left (100 once its reset passed), time to reset, stale flag, current flag
  while IFS=$'\t' read -r alias left until stale mine; do
    [ "$mine" = 1 ] && my_alias=$alias
    if [ "$stale" = 1 ]; then color=$dim
    else color=$(pct_color $(( 100 - left ))); fi
    entry="${color}${alias} ${left}%${reset}${dim}·${until}${reset}"
    [ "$mine" = 1 ] && entry="${bold}[${reset}${entry}${bold}]${reset}"
    acct_line+="${acct_line:+  }${entry}"
  done < <(jq -r --arg me "$my_home" --argjson now "$(date +%s)000" '
    [.ranked[], .skipped[]] | map(select(.alias != null)) | sort_by([({claude: 0, codex: 1, ag1: 2}[.agent] // 3), .alias])[]
    | (.quota.weeklyResetMs // 0) as $r
    | (if $r > 0 and $r <= $now then 100 else (.quota.weeklyLeft // 0 | round) end) as $left
    | (($r - $now) / 1000 | floor) as $d
    | (if $r <= $now then "reset" elif $d >= 86400 then "\($d / 86400 | floor)d" else "\($d / 3600 | floor)h" end) as $until
    | (if $r > $now and (.quota.observedMs // 0) < $now - 900000 then 1 else 0 end) as $stale
    | [.alias, $left, $until, $stale, (if .home == $me then 1 else 0 end)] | @tsv' "$acct_cache" 2>/dev/null)
fi

echo "${bold}${green}${my_alias:-?}${reset} ${bold}${cyan}[${model}]${reset} | ${bold}${dirname}${reset}${git_info}  ${dim}${cost_str}${reset}"
echo "Context $(mkbar $(( 100 - ctx_pct )) 10 "$ctx_pct") $(( 100 - ctx_pct ))% left | Usage $(mkbar "$five_left" 5 $(( 100 - five_left ))) ${five_left}% left ${dim}(resets in $(fmt_reset "$five_reset"))${reset} | Weekly $(mkbar "$seven_left" 5 $(( 100 - seven_left ))) ${seven_left}% left ${dim}(resets in $(fmt_reset "$seven_reset"))${reset}"
[ -n "$acct_line" ] && echo "Weekly left  ${acct_line}"
