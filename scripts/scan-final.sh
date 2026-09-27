#!/bin/bash
cd /Users/santiagojerald/soc-analyst || exit 1

echo "=== A. [REDACTED] placeholders in COMMITTED files (working tree) ==="
hits=$(git grep -I -l -F '[REDACTED]' -- 2>/dev/null)
if [ -n "$hits" ]; then
  echo "$hits" | sed 's/^/      /'
else
  echo "      none in the working tree"
fi

echo
echo "=== B. [REDACTED] in ANY historical commit (the earlier run printed nothing) ==="
found=0
for c in $(git rev-list --all); do
  out=$(git grep -I -l -F '[REDACTED]' "$c" -- 2>/dev/null | sed "s/^$c://")
  if [ -n "$out" ]; then
    echo "      commit ${c:0:8}:"
    echo "$out" | sort -u | sed 's/^/          /'
    found=1
  fi
done
[ "$found" = "0" ] && echo "      none in any commit - good"

echo
echo "=== C. is skills-lock.json something the public should see? ==="
git ls-files --error-unmatch skills-lock.json >/dev/null 2>&1 \
  && echo "      TRACKED" || echo "      not tracked"
head -c 200 skills-lock.json 2>/dev/null | tr -d '\n' | cut -c1-160 | sed 's/^/      /'
echo

echo
echo "=== D. untracked/ignored runtime data that must stay out ==="
for p in .env data/enriched.jsonl soc-analyst.db mastra.db backup reports; do
  if [ -e "$p" ]; then
    st=$(git check-ignore -q "$p" && echo "ignored" || echo "!! NOT IGNORED !!")
    printf "      %-22s exists, %s\n" "$p" "$st"
  fi
done

echo
echo "=== E. the .env.example that IS committed: any real value in it? ==="
if git grep -I -q -E '(AIza[0-9A-Za-z_-]{35}|=.{20,})' -- .env.example 2>/dev/null; then
  echo "      .env.example contains something long - inspect before publishing"
  grep -nE '[A-Za-z0-9_-]{24,}' .env.example | sed -E 's/=.*/=<redacted>/' | sed 's/^/      /'
else
  echo "      clean - placeholders only"
fi
