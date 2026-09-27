# DECISIONS

Autonomous work log. One line per decision with the reason, written as it was
made. Not a summary — read `git log` for what changed.

---

## D1 — Campaign auto-close threshold: 24 hours

`closeIdleCampaigns()` closes any `open` campaign whose `lastSeen` is older than
`CAMPAIGN_IDLE_CLOSE_MS` (default 24h, env-overridable). Called at the top of
`scripts/correlate.ts`, before correlation.

Why 24h: long enough that a periodic scanner hitting once a day keeps one
campaign open instead of opening a new one daily, and short enough that a
resolved incident stops counting as active the next day. Below ~6h a slow
scanner's own cadence would fragment it; above ~48h a dead incident looks live
for two days, which is the exact problem auto-closing exists to solve.

**Consequence worth knowing:** a closed campaign can never be rejoined —
`findMatchingCampaign` matches `status = 'open'` only. A source that returns
after the window gets a *new* campaign rather than reviving the old one. Chose
immutable history over silent revival: an incident report that changes its
event list after the fact is harder to trust than two sequential reports.

## D2 — Auto-close test asserts an exact end state, not "everything closed"

`scripts/test-auto-close.ts` runs three separate processes: correlate with the
default threshold, correlate again with the threshold collapsed to 1ms, then a
fresh process reads the store back. End state is **1 closed + 1 open**.

Worth recording because the first version asserted *every* campaign was closed
and failed. The implementation was right and the test was wrong: pass 2
reprocesses the same event, the original campaign is closed, so correlation
cannot match it and correctly opens a fresh one. See D1.

The read-back probe must live inside the repo — `tsx` picks module type from
the nearest `package.json`, so a probe in a temp dir is treated as CJS and
top-level await is a syntax error. That failure was silent (stderr swallowed by
a `?? "[]"` fallback, surfacing as an empty store), so the test now asserts the
probe actually printed before parsing it.

## D3 — Ponytail is unavailable in this environment

`/ponytail-review` is an OpenCode slash command. OpenCode is not installed on
this machine (no binary, no global npm package), and the plugin declared in
`opencode.json` (`@dietrichgebert/ponytail`, published as 4.10.0) is not
installed locally. The command cannot be invoked from this session.

Did the cleanup that the manual pass would have done — removed three
debug-only files (`probe.mjs`, `echo.mjs`, `scripts/probe-mcp-raw.ts`) that
were diagnostics for the MCP protocol bug and referenced nowhere.

**This is not equivalent to running the real review.** A manual read is my own
judgement, not the plugin's guarantee. Recorded here so the absence of a
ponytail pass is not mistaken for a pass.

## D4 — verify-honeypot.ts now asserts and exits non-zero

It previously ended in `process.exit(0)` unconditionally. With no honeypot
running it printed `ECONNREFUSED`, crashed, and the shell still saw exit 0 --
so a completely dead honeypot read as a passing verification. It is the same
bug class as the pipeline's silent success, one layer over.

It now asserts the security invariant directly: payload marker files are never
created, sessions are recorded, and the `wget` payload is captured verbatim.
Exits 1 on any failure. This is the script that backs the PRD's central claim,
so it should not be able to lie about that claim.

Two assertions failed on first run and both were the script's fault, not the
honeypot's: it checked the log before the honeypot finished flushing the last
session (now polls for up to 3s), and the event count was asserted before the
wget session had closed.

## D5 — tailEvents detected rotation by content, not size or inode

Wrote tests for log rotation and found the existing guard (`size < offset`)
misses the common case. A same-path rewrite keeps the inode, and a
logrotate-style replacement is often *larger* than the old file, so the size
check is false and the tail resumes mid-line and silently drops events. Tried
tracking the inode; that does not work either, because `writeFileSync` to an
existing path reuses the inode -- and real rotation via rename gives a new one,
so neither check covers both.

Now compares the last 64 characters against the current file contents. A
JSONL log is append-only, so those characters must still be there; if they are
not, the file was replaced and the tail restarts from zero. Catches every
rotation shape rather than the one the size check happened to cover.

## D6 — tail offset was counting bytes while slicing a string

`stat.size` is bytes; `String.prototype.slice` takes characters. They agree only
while the log is pure ASCII. One captured command containing a multi-byte
character (an attacker typing a non-ASCII password is the obvious case) shifts
the two apart, and every line after it is sliced mid-codepoint and lost.

Now indexes with `text.length` throughout, so offset and slice use the same
unit. Found while writing the rotation test; the unicode case is now covered by
a test that fails against the old code.

## D7 — get_campaign_detail rejects empty ids instead of reporting "not found"

The input schema accepted `campaignId: ""`, which fell through to a lookup and
returned `{"found": false}`. A client could not distinguish "no such campaign"
from "you sent me garbage" -- the same silent-failure shape as the pipeline bug,
smaller but the same.

Schema now requires a non-empty trimmed id, so malformed input is a validation
error and a genuine miss stays a clean `{"found": false}`.

## D8 — `npm run setup` instead of a postinstall web build

A fresh clone served **404 "landing page not built"** at /: `web/` has its own
dependencies and the root `npm install` does not build it. The first thing
anyone saw after cloning was a broken-looking server.

Rejected postinstall: a nested `npm install` plus a Vite build on every root
install makes the common case slow and fails outright offline. An explicit
`npm run setup` (15s, idempotent) is honest about the cost and works offline
once cached. / also now serves a styled page explaining the build step instead
of a bare 404.

Cold-clone verified end to end: clone -> install -> setup -> dashboard, 17s
total, all routes 200, traversal still 404.

## D9 — Closing a campaign now refreshes its report

Found while generating the closed-campaign example: after auto-close every
report still said `Status: open`. `needsReport()` is false for an
already-generated report, and closing happens before the correlate loop that
would force a refresh, so the markdown was the last place still showing a dead
incident as live.

correlate now force-refreshes reports for exactly the campaigns it closed. The
auto-close test asserts a report contains `**Status:** closed` after the fact.

## D10 — Report summary grammar for a single event

"1 SSH session ... **were** recorded". The verb agreed with "session" but the
clause was plural. Now `1 SSH session was recorded` / `N SSH sessions were
recorded`. Found only because the example report I generated happened to be a
one-event campaign -- a shape the seed data does not normally produce.

Added `tests/report.test.ts` and confirmed it is not a vacuous pass: reverting
the wording fails 2 of its 6 assertions.

## D11 — Correlation is idempotent (checked, not changed)

Worried that re-running `npm run correlate` would duplicate every campaign.
It does not: three consecutive runs on the same input hold at 15 campaigns.
No change needed, recorded so the question is not re-opened.

MCP adversarial check (`scripts/test-mcp-robustness.ts`, 11 assertions) found
nothing else: SQL-ish ids are parameterized and return `found: false` rather
than executing; wrong-typed, missing, and absurd `limit` values all produce
clean tool errors; the server survives every case and still lists all 3 tools.
