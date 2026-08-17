#!/usr/bin/env bash
# Public-repo leak scanner. Fails (exit 1) if anything developer-specific is found.
#
# Patterns here are GENERIC ONLY. Specific strings belong in .private-denylist,
# which is gitignored — a committed denylist would leak what it protects.
#
# Every pattern must require the SHAPE of a real value. A bare `/home/` also
# matches documentation that describes the pattern, so a following path segment
# is required.
#
# Scope: this scans files that are actual candidates for committing — tracked
# files plus untracked-but-not-ignored files (`git ls-files --cached --others
# --exclude-standard`), which inherits .gitignore automatically. Scratch
# directories like .superpowers/ and .claude/ are gitignored precisely because
# they hold real names and paths; scanning them anyway would make this gate
# fail on content that can never be committed, which trains people to bypass
# it. When ROOT is not inside a git work tree (e.g. a test fixture in a temp
# dir), there is nothing for git to know about, so this falls back to a plain
# directory walk — and says so out loud, since a silent fallback is exactly
# the kind of thing this repo's rules forbid.
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

# --- Build the file list: what would actually be committed. ---------------

FILES=()

GIT_CHECK_OUTPUT=$(git -C "$ROOT" rev-parse --is-inside-work-tree 2>&1)
GIT_CHECK_STATUS=$?

if [ "$GIT_CHECK_STATUS" -eq 0 ] && [ "$GIT_CHECK_OUTPUT" = "true" ]; then
  while IFS= read -r -d '' rel; do
    [ "$(basename -- "$rel")" = "bun.lock" ] && continue
    FILES+=("$ROOT/$rel")
  done < <(git -C "$ROOT" ls-files -z --cached --others --exclude-standard)
else
  echo "check-private: '$ROOT' is not a git work tree (git said: $GIT_CHECK_OUTPUT); falling back to a full directory walk" >&2
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$ROOT" \
    \( -name .git -o -name node_modules -o -name dist \) -prune -o \
    -type f \! -name 'bun.lock' \! -name '.private-denylist' -print0)
fi

# --- Scan the file list for each pattern. ----------------------------------

scan() {
  local pattern="$1" label="$2"
  local hits grep_status

  if [ "${#FILES[@]}" -eq 0 ]; then
    return 0
  fi

  hits=$(grep -InE --binary-files=without-match -- "$pattern" "${FILES[@]}")
  grep_status=$?

  case "$grep_status" in
    0)
      printf '%s\n' "FAIL [$label]" "$hits" ""
      STATUS=1
      ;;
    1)
      : # no match — fine
      ;;
    *)
      echo "check-private: grep failed (exit $grep_status) scanning pattern [$label] '$pattern' — treating as a hard failure, not a clean scan" >&2
      exit 2
      ;;
  esac
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
