#!/bin/bash
set -u

CONFIG="/Library/Application Support/Mindless/guard.conf"
HOSTS="/etc/hosts"
PF_ANCHOR="com.apple/mindless"
PF_RULES="/Library/Application Support/Mindless/pf.rules"
PF_TOKEN="/Library/Application Support/Mindless/pf.token"
POLICY_BACKUPS="/Library/Application Support/Mindless/policy-backups"
MARKER="# mindless-guard"

cleanup_hosts() {
  /usr/bin/sed -i '' "/${MARKER}/d" "$HOSTS" 2>/dev/null || true
  /usr/bin/dscacheutil -flushcache 2>/dev/null || true
  /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true
}

restore_browser_policies() {
  for domain in com.brave.Browser com.google.Chrome com.microsoft.Edge; do
    state="$POLICY_BACKUPS/$domain.state"
    backup="$POLICY_BACKUPS/$domain.plist"
    plist="/Library/Preferences/$domain.plist"
    [ -f "$state" ] || continue
    if [ "$(/bin/cat "$state")" = "present" ] && [ -f "$backup" ]; then
      /bin/cp "$backup" "$plist"
    else
      /bin/rm -f "$plist"
    fi
  done
  /bin/rm -rf "$POLICY_BACKUPS"
}

cleanup_network() {
  cleanup_hosts
  /sbin/pfctl -a "$PF_ANCHOR" -F all >/dev/null 2>&1 || true
  if [ -s "$PF_TOKEN" ]; then
    /sbin/pfctl -X "$(/bin/cat "$PF_TOKEN")" >/dev/null 2>&1 || true
    /bin/rm -f "$PF_TOKEN"
  fi
  restore_browser_policies
  /bin/rm -f "$PF_RULES"
}

decode() { printf '%s' "$1" | /usr/bin/base64 -D; }

[ -f "$CONFIG" ] || exit 0
LEGACY_END=0
APP_STARTS=(); APP_ENDS=(); APPS=()
PROCESS_STARTS=(); PROCESS_ENDS=(); PROCESSES=()
SITE_STARTS=(); SITE_ENDS=(); SITES=()

while IFS= read -r line; do
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    END) LEGACY_END="$value" ;;
    APP|PROCESS|SITE)
      item_start=0
      if [[ "$value" == *:* ]]; then
        first="${value%%:*}"
        rest="${value#*:}"
        if [[ "$rest" == *:* ]]; then
          item_start="$first"
          item_end="${rest%%:*}"
          encoded="${rest#*:}"
        else
          item_end="$first"
          encoded="$rest"
        fi
      else
        item_end="$LEGACY_END"
        encoded="$value"
      fi
      [[ "$item_start" =~ ^[0-9]+$ && "$item_end" =~ ^[0-9]+$ ]] || continue
      decoded="$(decode "$encoded" 2>/dev/null || true)"
      [ -n "$decoded" ] || continue
      case "$key" in
        APP) APP_STARTS+=("$item_start"); APP_ENDS+=("$item_end"); APPS+=("$decoded") ;;
        PROCESS) PROCESS_STARTS+=("$item_start"); PROCESS_ENDS+=("$item_end"); PROCESSES+=("$decoded") ;;
        SITE) SITE_STARTS+=("$item_start"); SITE_ENDS+=("$item_end"); SITES+=("$decoded") ;;
      esac
      ;;
  esac
done < "$CONFIG"

ensure_pf() {
  if ! /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q "Status: Enabled"; then
    token="$(/sbin/pfctl -E 2>&1 | /usr/bin/awk '/Token/ {print $3; exit}')"
    [ -n "$token" ] && printf '%s' "$token" > "$PF_TOKEN"
  fi
}

apply_browser_policies() {
  current="$1"
  patterns=()
  for ((i=0; i<${#SITES[@]}; i++)); do
    [ "${SITE_STARTS[$i]}" -le "$current" ] && [ "${SITE_ENDS[$i]}" -gt "$current" ] || continue
    site="${SITES[$i]}"
    patterns+=("*://$site/*" "*://*.$site/*")
  done
  [ "${#patterns[@]}" -gt 0 ] || return
  /bin/mkdir -p "$POLICY_BACKUPS"
  for entry in "com.brave.Browser|/Applications/Brave Browser.app" "com.google.Chrome|/Applications/Google Chrome.app" "com.microsoft.Edge|/Applications/Microsoft Edge.app"; do
    domain="${entry%%|*}"
    application="${entry#*|}"
    [ -d "$application" ] || continue
    plist="/Library/Preferences/$domain.plist"
    state="$POLICY_BACKUPS/$domain.state"
    if [ ! -f "$state" ]; then
      if [ -f "$plist" ]; then
        /bin/cp "$plist" "$POLICY_BACKUPS/$domain.plist"
        printf 'present' > "$state"
      else
        printf 'absent' > "$state"
      fi
    fi
    /usr/bin/defaults write "${plist%.plist}" URLBlocklist -array "${patterns[@]}" >/dev/null 2>&1 || true
    /bin/chmod 644 "$plist" 2>/dev/null || true
  done
}

refresh_network() {
  current="$1"
  cleanup_hosts
  : > "$PF_RULES"
  active_sites=0
  site_signature=""
  for ((i=0; i<${#SITES[@]}; i++)); do
    [ "${SITE_STARTS[$i]}" -le "$current" ] && [ "${SITE_ENDS[$i]}" -gt "$current" ] || continue
    site="${SITES[$i]}"
    active_sites=1
    site_signature="$site_signature,$i"
    for host in "$site" "www.$site"; do
      while IFS= read -r ip; do
        [[ "$ip" =~ ^[0-9a-fA-F:.]+$ ]] || continue
        printf 'block drop out quick to %s\n' "$ip" >> "$PF_RULES"
        if [[ "$ip" == *:* ]]; then
          /sbin/pfctl -k ::/0 -k "$ip" >/dev/null 2>&1 || true
        else
          /sbin/pfctl -k 0.0.0.0/0 -k "$ip" >/dev/null 2>&1 || true
        fi
      done < <(/usr/bin/dscacheutil -q host -a name "$host" 2>/dev/null | /usr/bin/awk '/ip_address:|ipv6_address:/ {print $2}' | /usr/bin/sort -u)
    done
    printf '0.0.0.0 %s %s %s\n' "$site" "www.$site" "$MARKER" >> "$HOSTS"
    printf '::1 %s %s %s\n' "$site" "www.$site" "$MARKER" >> "$HOSTS"
  done
  /usr/bin/dscacheutil -flushcache 2>/dev/null || true
  /usr/bin/killall -HUP mDNSResponder 2>/dev/null || true
  if [ "$active_sites" -eq 1 ]; then
    apply_browser_policies "$current"
    ensure_pf
    /sbin/pfctl -a "$PF_ANCHOR" -f "$PF_RULES" >/dev/null 2>&1 || true
  else
    /sbin/pfctl -a "$PF_ANCHOR" -F all >/dev/null 2>&1 || true
    restore_browser_policies
  fi
  LAST_SITE_SIGNATURE="$site_signature"
}

LAST_SITE_SIGNATURE=""
refresh_network "$(/bin/date +%s)"
cycle=0
while true; do
  current="$(/bin/date +%s)"
  active=0

  for ((i=0; i<${#APPS[@]}; i++)); do
    [ "${APP_ENDS[$i]}" -gt "$current" ] || continue
    active=1
    [ "${APP_STARTS[$i]}" -le "$current" ] || continue
    executable="${APPS[$i]}"
    while IFS= read -r row; do
      pid="${row%% *}"
      command="${row#* }"
      if [ "$command" = "$executable" ] || [[ "$command" == "$executable "* ]]; then
        /bin/kill -9 "$pid" 2>/dev/null || true
      fi
    done < <(/bin/ps -axo pid=,command= | /usr/bin/sed 's/^[[:space:]]*//; s/[[:space:]][[:space:]]*/ /')
  done

  for ((i=0; i<${#PROCESSES[@]}; i++)); do
    [ "${PROCESS_ENDS[$i]}" -gt "$current" ] || continue
    active=1
    [ "${PROCESS_STARTS[$i]}" -le "$current" ] || continue
    /usr/bin/pkill -9 -x "${PROCESSES[$i]}" 2>/dev/null || true
  done

  for ((i=0; i<${#SITES[@]}; i++)); do
    if [ "${SITE_ENDS[$i]}" -gt "$current" ]; then active=1; break; fi
  done

  if [ "$active" -eq 0 ]; then break; fi
  current_site_signature=""
  for ((i=0; i<${#SITES[@]}; i++)); do
    if [ "${SITE_STARTS[$i]}" -le "$current" ] && [ "${SITE_ENDS[$i]}" -gt "$current" ]; then current_site_signature="$current_site_signature,$i"; fi
  done
  if [ "$current_site_signature" != "$LAST_SITE_SIGNATURE" ] || [ "$cycle" -ge 15 ]; then refresh_network "$current"; cycle=0; fi
  cycle=$((cycle + 1))
  /bin/sleep 1
done

cleanup_network
/bin/rm -f "$CONFIG"
exit 0
