#!/bin/bash
# Triage the scan hits WITHOUT printing any secret value.
cd /Users/santiagojerald/soc-analyst || exit 1

echo "=== 1. ngrok-pattern hits: which lockfile key names contain them? ==="
# The pattern (2|3)[0-9A-Za-z_-]{46} matches integrity hashes. List the KEY
# names only, never the values.
for f in package-lock.json skills-lock.json web/package-lock.json; do
  [ -f "$f" ] || { echo "  $f: not in working tree"; continue; }
  echo "  --- $f ---"
  grep -oE '"[^"]*(ngrok|integrity|resolved|token)[^"]*"[[:space:]]*:' "$f" 2>/dev/null \
    | sed 's/[[:space:]]*:$//' | sort | uniq -c | sort -rn | head -5 | sed 's/^/      /'
  # Does any hit sit on a line mentioning ngrok specifically?
  n=$(grep -c -i 'ngrok' "$f" 2>/dev/null)
  echo "      lines mentioning 'ngrok': ${n:-0}"
done

echo
echo "=== 2. do those lockfiles reference an @ngrok package at all? ==="
grep -ohE '"node_modules/[^"]*ngrok[^"]*"' package-lock.json web/package-lock.json skills-lock.json 2>/dev/null \
  | sort -u | sed 's/^/      /' || echo "      none - the match is incidental"

echo
echo "=== 3. the 64-hex hits in skills-lock.json: key names only ==="
grep -oE '"[^"]{1,40}"[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"' skills-lock.json 2>/dev/null \
  | sed -E 's/[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"/ : <64-hex>/' | sort -u | head -5 | sed 's/^/      /' \
  || echo "      none"

echo
echo "=== 4. sanity: does the REAL .env key appear anywhere in history? ==="
# Compare a hash of the live key against history, without printing it.
LIVE=$(grep -hoE 'AIza[0-9A-Za-z_-]{35}' .env 2>/dev/null | head -1)
if [ -z "$LIVE" ]; then
  echo "      no AIza key in .env to compare against"
else
  echo "      .env has a key; testing whether that exact string is in any commit..."
  for c in $(git rev-list --all); do
    if git grep -I -q -F "$LIVE" "$c" -- 2>/dev/null; then
      echo "      LEAK: found in commit $c"
      exit 1
    fi
  done
  echo "      CLEAN - the live .env key appears in ZERO commits"
fi

echo
echo "=== 5. tracked files that should never be public ==="
git ls-files | grep -iE '(^data/|enriched[.]jsonl|events[.]jsonl|[.]db|reports/|^backup/|host.*key)' \
  | sed 's/^/      /' || echo "      none tracked - good"
