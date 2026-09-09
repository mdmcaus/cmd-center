#* cmdc: an interactive start/stop/restart menu for cmd-center.
#
# Source this from your shell profile (bash or zsh), then run `cmdc`:
#   source /Users/michael/repo/cmd-center/cmdc.sh
#
# Behaviour:
#   - if the server is NOT running, the menu offers only: start
#   - if the server IS running, the menu offers: stop, restart
# Move with the arrow keys (or j/k), press Enter to choose, q or Esc to cancel.
#
# Config (optional environment overrides):
#   CMDC_DIR   path to the cmd-center project (default: this file's directory)
#   CMDC_PORT  port the server listens on     (default: 3200)

# Resolve the directory this file lives in, so CMDC_DIR defaults correctly whether
# sourced from bash or zsh.
if [ -n "${BASH_SOURCE:-}" ]; then
  _CMDC_DEFAULT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [ -n "${ZSH_VERSION:-}" ]; then
  _CMDC_DEFAULT_DIR="$(cd "$(dirname "${(%):-%N}")" && pwd)"
else
  _CMDC_DEFAULT_DIR="/Users/michael/repo/cmd-center"
fi

# Arrow-key menu. Prints the prompt, lets the user pick one option, and sets
# CMDC_CHOICE to the selected option. Returns non-zero if cancelled.
_cmdc_menu() {
  local prompt=$1
  shift
  local options=("$@")
  local n=${#options[@]}
  local selected=0 key rest i first=1

  printf '\033[?25l' # hide cursor
  printf '%s\n' "$prompt"
  while true; do
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf '\033[%dA' "$n" # move cursor back up over the option lines
    fi
    for ((i = 0; i < n; i++)); do
      printf '\033[2K' # clear the line
      if [ "$i" -eq "$selected" ]; then
        printf '  \033[7m %s \033[0m\n' "${options[$i]}" # reverse-video highlight
      else
        printf '    %s \n' "${options[$i]}"
      fi
    done

    # Read one key. Enter arrives as an empty string.
    IFS= read -rsn1 key || key=q
    if [ "$key" = $'\033' ]; then
      # Escape: could be a lone Esc (cancel) or an arrow sequence like [A / [B.
      IFS= read -rsn2 -t 0.1 rest
      if [ -z "$rest" ]; then
        selected=-1
        break
      fi
      key=$rest
    fi
    case "$key" in
      '[A' | 'k') selected=$(((selected - 1 + n) % n)) ;;
      '[B' | 'j') selected=$(((selected + 1) % n)) ;;
      '') break ;;      # Enter
      q | Q) selected=-1; break ;;
    esac
  done
  printf '\033[?25h' # restore cursor

  if [ "$selected" -lt 0 ]; then
    return 1
  fi
  CMDC_CHOICE=${options[$selected]}
  return 0
}

cmdc() {
  local dir=${CMDC_DIR:-$_CMDC_DEFAULT_DIR}
  local port=${CMDC_PORT:-3200}

  if [ ! -f "$dir/Makefile" ]; then
    printf 'cmdc: no Makefile found in %s (set CMDC_DIR)\n' "$dir" >&2
    return 1
  fi

  # Start from a clean screen so the menu is the only thing shown.
  command clear 2>/dev/null || printf '\033[2J\033[H'

  # The listening port is the source of truth for whether it is running.
  local pid
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)

  local options
  if [ -n "$pid" ]; then
    printf 'cmd-center is running (PID %s) -> http://127.0.0.1:%s\n' "$pid" "$port"
    options=(stop restart)
  else
    printf 'cmd-center is not running\n'
    options=(start)
  fi

  if ! _cmdc_menu 'Use arrow keys, Enter to select (q to cancel):' "${options[@]}"; then
    printf 'cancelled\n'
    return 1
  fi

  printf '\n'
  ( cd "$dir" && make "$CMDC_CHOICE" )
}
