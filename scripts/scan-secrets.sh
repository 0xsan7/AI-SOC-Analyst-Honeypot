#!/bin/bash
# Pre-publication secret scan. Reports pattern type + file path ONLY.
# Never prints a matched value.
cd /Users/santiagojerald/soc-analyst || exit 1

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
# Build a searchable corpus of every blob ever committed, labelled by path.
FOUND=0
scan() {
  local label="$1" pattern="$2"
  local hits
  hits=$(git grep -I -l -E "$pattern" $(git rev-list --all) -- \
          2>/dev/null | sed 's/^[0-9a-f]*://' | sort -u)
  if [ -n "$hits" ]; then
    echo "  [$label] FOUND in:"
    echo "$hits" | sed 's/^/      /'
    FOUND=1
  else
    echo "  [$label] clean"
  fi
}

scan "Google/Gemini API key"   'AIza[0-9A-Za-z_-]{35}'
scan "AWS access key id"        'AKIA[0-9A-Z]{16}'
scan "GitHub token"             'gh[pousr]_[0-9A-Za-z]{36}'
scan "Slack token"              'xox[abprs]-[0-9A-Za-z-]{10,}'
scan "Private key block"        'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
scan "ngrok authtoken"          '(2|3)[0-9A-Za-z_-]{46}'
scan "OpenCode service token"   '"token"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]{20,}'
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
if [ "$FOUND" = "0" ]; then
  echo "RESULT: no high-risk credential patterns found in any commit."
else
  echo "RESULT: review the paths above before publishing."
fi
