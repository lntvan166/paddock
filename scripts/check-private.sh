#!/usr/bin/env bash
# Public-repo leak scanner. Fails (exit 1) if anything developer-specific is found.
#
# Patterns here are GENERIC ONLY. Specific strings belong in .private-denylist,
# which is gitignored — a committed denylist would leak what it protects.
#
# Every pattern must require the SHAPE of a real value. A bare `/home/` also
# matches documentation that describes the pattern, so a following path segment
# is required.
set -uo pipefail

ROOT="${1:-.}"
STATUS=0

GENERIC=(
  '(/home|/Users)/[A-Za-z0-9._-]+'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  '\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b'
  '\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b'
  'BEGIN [A-Z ]*PRIVATE KEY'
  '\beyJ[A-Za-z0-9_-]{20,}'
)

scan() {
  local pattern="$1" label="$2"
  local hits
  hits=$(grep -rInE --binary-files=without-match \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
    --exclude='bun.lock' --exclude='.private-denylist' \
    -- "$pattern" "$ROOT" 2>/dev/null) || return 0
  if [ -n "$hits" ]; then
    printf '%s\n' "FAIL [$label]" "$hits" ""
    STATUS=1
  fi
}

for p in "${GENERIC[@]}"; do scan "$p" "generic"; done

DENY="$ROOT/.private-denylist"
if [ -f "$DENY" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    scan "$line" "denylist"
  done < "$DENY"
fi

if [ "$STATUS" -ne 0 ]; then
  echo "check-private: leaks found. Fix the CONTENT — do not add the string to a denylist." >&2
else
  echo "check-private: clean"
fi
exit "$STATUS"
