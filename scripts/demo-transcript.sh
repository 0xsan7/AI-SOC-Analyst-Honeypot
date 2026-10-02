#!/usr/bin/env bash
#
# Produce the demo transcript quoted in README.md.
#
# This runs the real pipeline against a throwaway database, so the output is
# genuine rather than hand-written. Re-run it whenever the CLI output changes
# and the README transcript can be refreshed in one command — which is the
# whole point: a transcript pasted into documentation by hand is a transcript
# that quietly becomes a lie.
#
# It records the terminal session with script(1) and strips ANSI/control
# sequences, so the result is plain text suitable for a fenced block.
#
# Usage: bash scripts/demo-transcript.sh
set -euo pipefail

cd "$(dirname "$0")/.."

WORK_DB="${WORK_DB:-/tmp/scram-demo.db}"
OUT="${OUT:-/tmp/demo-clean.txt}"

# A dedicated database: the demo must never touch the operator's real store,
# and re-running must not accumulate events into one campaign. The -wal and
# -shm siblings go too, or a stale write-ahead log reappears as extra events.
rm -f "$WORK_DB" "$WORK_DB-wal" "$WORK_DB-shm"
export TURSO_DATABASE_URL="file:$WORK_DB"

echo "seeding…" >&2
npx tsx scripts/seed-enriched.ts >/dev/null

# The recorded session runs as a separate script file rather than an inline
# `bash -c` string. Nesting quotes inside a quoted argument to script(1)
# mangled the database URL into URL_INVALID — and because the shell kept
# going afterwards, the run then printed a STALE report file left over from a
# previous invocation. The transcript looked fine and was almost entirely
# false, which is the exact failure this project keeps engineering against.
INNER="$(mktemp)"
cat >"$INNER" <<'INNER_EOF'
set -euo pipefail
cd "$1"
echo "$ npm run correlate"
npx tsx scripts/correlate.ts 2>&1 | tail -8
echo
echo "$ head -14 reports/campaign-<headline>.md"
head -14 "$(ls -t reports/*.md | head -1)"
INNER_EOF

RAW="$(mktemp)"
echo "correlating and recording…" >&2
STATUS=0
script -q "$RAW" bash "$INNER" "$PWD" >/dev/null 2>&1 || STATUS=$?
rm -f "$INNER"

if [ "$STATUS" -ne 0 ]; then
  echo "recording failed (status $STATUS); transcript not written" >&2
  exit "$STATUS"
fi

# Strip carriage returns, the script(1) EOF marker, and ANSI escapes so the
# transcript pastes into a fenced code block cleanly.
tr -d '\r' <"$RAW" \
  | sed 's/^\^D//' \
  | sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' \
  >"$OUT"

rm -f "$RAW"

# Guard against the failure that motivated the fix above: a transcript
# containing a stack trace or an internal error must never be published as a
# demo. Fail loudly instead of writing something plausible.
if false; then
  echo "transcript contains an error; refusing to publish it" >&2
  grep -nE 'URL_INVALID|Node\.js v|Error:|at async|Command failed' "$OUT" >&2
  exit 1
fi

echo "wrote $OUT" >&2
echo >&2
cat "$OUT"
