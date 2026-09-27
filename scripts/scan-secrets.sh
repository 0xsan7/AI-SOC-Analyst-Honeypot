#!/bin/bash
# Pre-publication secret scan. Reports pattern type + file path ONLY.
# Never prints a matched value.
#
# Scans the repository containing THIS script, not a hardcoded path. An
# earlier version did `cd /Users/santiagojerald/soc-analyst`, which meant a
# copy of the script run anywhere else silently scanned the original repo --
# so a test run against a repo with a planted key reported "clean" while the
# key sat in the working copy unflagged. Always verify by planting a match.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

echo "=== history size ==="
echo "commits: $(git rev-list --all --count)"
echo "oldest:  $(git log --reverse --format='%ad' --date=short | head -1)"
echo "newest:  $(git log -1 --format='%ad' --date=short)"
echo "distinct paths ever: $(git rev-list --objects --all | awk '{print $2}' | sort -u | wc -l | tr -d ' ')"

echo
echo "=== .env ever committed? ==="
git rev-list --objects --all | awk '{print $2}' | sort -u | grep -iE '(^|/)[.]env($|\.)' || echo "  NEVER committed - good"

echo
echo "=== secret-ish filenames ever in history ==="
git rev-list --objects --all | awk '{print $2}' | sort -u \
  | grep -iE '[.]pem$|[.]key$|id_rsa|credential|secret|[.]p12$|[.]pfx$|service[.]json|[.]npmrc|netrc' \
  || echo "  none"

echo
echo "=== high-risk value patterns across ALL history ==="
# Collect the matching PATHS (not values) so the exit status can distinguish a
# real finding from the triaged lockfile-hash noise.
FOUND_PATHS=""
scan() {
  local label="$1" pattern="$2"
  local hits
  hits=$(git grep -I -l -E "$pattern" $(git rev-list --all) -- \
          2>/dev/null | sed 's/^[0-9a-f]*://' | sort -u)
  if [ -n "$hits" ]; then
    echo "  [$label] FOUND in:"
    echo "$hits" | sed 's/^/      /'
    FOUND_PATHS="$FOUND_PATHS
$hits"
  else
    echo "  [$label] clean"
  fi
}

# Brace quantifiers are written with SINGLE braces. Verified by planting a
# real-looking key in history and confirming this catches it: a doubled
# {{35}} reaches git grep literally, matches nothing, and the script reports
# "clean" -- a false negative in a security tool, which is worse than no
# tool. If you edit a pattern here, plant a match and check that it fires.
scan "Google/Gemini API key"   'AIza[0-9A-Za-z_-]{35}'
scan "AWS access key id"        'AKIA[0-9A-Z]{16}'
scan "GitHub token"             'gh[pousr]_[0-9A-Za-z]{36}'
scan "Slack token"              'xox[abprs]-[0-9A-Za-z-]{10,}'
scan "Private key block"        'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
scan "ngrok authtoken"          '(2|3)[0-9A-Za-z_-]{46}'
scan "OpenCode service token"   '"token"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]{20,}"'
scan "Generic long bearer"      '[Bb]earer[[:space:]]+[A-Za-z0-9_-]{30,}'

echo
echo "=== AbusiveIPDB key in history? ==="
git grep -I -l -E '[a-f0-9]{64}' $(git rev-list --all) -- 2>/dev/null \
  | sed 's/^[0-9a-f]*://' | sort -u | sed 's/^/      /' || echo "  none"

echo
echo "=== [REDACTED] placeholders left in committed source? ==="
git grep -I -l -F '[REDACTED]' $(git rev-list --all) -- 2>/dev/null \
  | sed 's/^[0-9a-f]*://' | sort -u | sed 's/^/      /' || echo "  none"

echo
# The ngrok shape and the 64-hex shape both match lockfile integrity hashes,
# which are base64/hex by construction. Triaged: zero lines in any lockfile
# mention ngrok, no @ngrok package is a dependency, and the 64-hex match is
# skills-lock.json's computedHash. These two are reported as known-benign so
# CI stays meaningful -- any OTHER hit is a real finding and fails the run.
real_hits=$(printf '%s\n' "$FOUND_PATHS" | grep -vE '(^|/)(package-lock|skills-lock)\.json$' || true)
if [ -z "$real_hits" ]; then
  echo "RESULT: no credential found in any commit."
  echo "        (lockfile integrity-hash matches are known-benign and excluded)"
  exit 0
fi

echo "RESULT: POSSIBLE CREDENTIAL FOUND. Do not publish until triaged:"
echo "$real_hits" | sed 's/^/        /'
echo "        Run scripts/scan-triage.sh to inspect without printing values."
exit 1
