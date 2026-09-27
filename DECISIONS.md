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

## D16 — Hardened for public deployment (DEPLOY.md)

Asked how to actually run this publicly. Two gaps made "deploy it" premature,
so both are fixed rather than documented around:

**Unbounded log.** A public SSH listener records an event per connection, so
append-only `events.jsonl` fills the disk — which on a small VPS kills the
pipeline, the database, and the SSH session you would use to fix it, all at
once. `src/honeypot/event-log.ts` rotates at 50 MB keeping 5 generations
(~250 MB ceiling). Rotation is a rename, which the normalizer's content anchor
detects, so a rotated log is re-read rather than silently skipped.

**No connection cap.** Each concurrent connection costs a socket and crypto
state. `ConnectionLimiter` allows 64 concurrent / 8 per IP and refuses the NEW
connection rather than killing a live one: a scanner retries, whereas dropping
an established session discards the capture we want.

The rotation test caught a real bug in the rotation code: `readdirSync` was
passed the log FILE path, so it threw ENOTDIR, the error was swallowed as [],
and pruning never ran — 200 writes produced 27 files instead of 4. Total bytes
looked plausible, so a disk-usage check would not have caught it. Only the
file-COUNT assertion did. 47 unit tests now (36 -> 47).

**Backup via VACUUM INTO, not `cp`.** The store is LibSQL in WAL mode, so
copying it live can be inconsistent. `npm run backup` does an online
`VACUUM INTO`. Verified by reading 43 campaigns back out of the copy. My first
attempt documented a `sqlite3` CLI one-liner that would not have worked — the
CLI is not installed and the DB is not plain sqlite.

## D17 — ask_soc_agent was silently broken (found 2026-09-27)

`ask_soc_agent` could not answer a single question. The agent declared
`new Memory({ options })` with no `storage`, which this Mastra version requires.
It does not fail at construction -- it throws on the FIRST call, so every
question returned "Memory requires a storage provider to function". The wire
test only listed the tool and never invoked it, so the suite stayed green.

Fixed with `LibSQLStore` (the store Mastra itself constructs, not
`MemoryLibSQL`, which is a different type). The campaign store and agent
memory now share `DB_URL`/`DB_AUTH_TOKEN` from `store.ts`, so one TURSO_*
config covers both.

Two things worth keeping from this:

- The parameter is `message`, not `question`. I assumed `question` first and
  the tool returned a validation error naming the real field.
- `StdioClientTransport` must be given an explicit `env`. Without it the child
  gets a stripped environment and the model reports a missing API key even
  though the parent process has one -- which looks exactly like a broken key.

`npm run test:ask` covers it over a real MCP connection. It is NOT in
test:all because it needs a live Gemini key. Verified the test catches the
bug: re-introducing the missing storage line makes 3 assertions fail.

## D19 — zod `.trim()` after `.min(1)` does not reject whitespace

Writing the mocked tests surfaced a real bug in the `campaignId` schema. The
line was `z.string().min(1, "...").trim()`. In zod, `.trim()` is a TRANSFORM,
applied after validation -- so `"   "` passed the length check (three
characters), then got trimmed to `""`. The intent was to reject empty and
whitespace-only ids as malformed requests, and it rejected neither.

Fixed to `z.string().trim().min(1, "...")`.

The MCP robustness test passed before and after, because it asserted the
*response* was an error, and the trimmed-to-empty value happened to produce an
error downstream. Only asserting on the schema itself caught it. This is the
same class of bug as the ones in D17/D18: the test was checking a weaker
property than the one claimed.

## D20 — Mocked guards for the two live-API tests

`test:ask` and `test:studio` need a Gemini key and a running Studio, so a
regression in either could land silently. Added:

- `tests/ask-soc-agent.test.ts` -- the real agent, Memory, LibSQL storage and
  tools, with only the model mocked via `createMockModel` from
  `@mastra/core/test-utils/llm-mock`. 5 tests, no key, no network.
- `tests/observability.test.ts` -- a real Mastra instance with real
  observability and a real workflow, no LLM. 4 tests, no key.

Both were verified against deliberately broken code, because a guard that
cannot fail is worse than no guard. Findings while building them, all recorded
as comments in the tests:

- A store with no `observabilityStrategy` makes `MastraStorageExporter` throw
  during init; every run then "succeeds" and every `listTraces()` is empty.
  Bare `LibSQLStore` is not enough -- `getStore("observability")` wraps it in
  an `ObservabilityLibSQL` adapter that does have one. `DuckDBStore` matches
  production (`src/mastra/index.ts`) and is what these tests use.
- Spans take ~4s to flush. A fixed 2s sleep reads as "observability is broken"
  when it is only late, so the test polls a bounded window.
- `listTraces` takes no pagination args and returns `{ pagination, spans }`,
  not `{ traces }`. Passing `page`/`perPage` throws a ZodError.

The `observability` domain assertion was initially vacuous -- removing the
domain entirely still passed, because the default-store fallback works. The
comment said otherwise, so the comment was corrected and a separate assertion
added that pins the adapter's strategy.

## D18 — Mastra Studio traces need the workflow run through Studio

Tracing is configured correctly in `src/mastra/index.ts`, but spans are written
to an in-process DuckDB observability store. Calling `triageEvent()` from a
separate script therefore produces no visible trace -- the exporter writes
into a different store. The workflow has to be started through Studio's own
API (`create-run` then `start`) for the trace to be visible there.

Real route shapes, found by reading `@mastra/server/dist/server/handlers/`:
`GET /api/observability/traces`, and the workflow run must be created with
`POST /api/workflows/<id>/create-run?runId=<uuid>` before
`POST /api/workflows/<id>/start?runId=<uuid>`. `/runs/:runId` is GET-only and
returns 404 to a POST.

`npm run test:studio` polls for the span rather than sleeping a fixed time, and
compares against a baseline count so it cannot pass on a pre-existing trace.
Excluded from test:all for the same Gemini-key reason as test:ask.

## D14 — HTTP honeypot (stretch goal, OQ3)

`src/honeypot/http-server.ts`, same no-execution guarantee: every response from
a static table, no filesystem or network path driven by request data. Emits
`service: "http"` events into the same log, so HTTP hits correlate and triage
with no special handling — the schema already allowed `http` and nothing in
the pipeline branches on service.

Design calls: the phpmyadmin redirect points back inside the honeypot so a
scanner following it does not leave; basic-auth usernames are captured but
passwords never logged; the listener stays quiet on routine 404s because
internet background traffic is high-volume (`HONEYPOT_VERBOSE` to see it).

**The test nearly passed while testing nothing.** A stale honeypot from an
earlier run still held port 8099, so the spawned child failed to bind, every
request hit the old process, and 13 assertions passed against a server the test
did not control — with no log file written. Added a pre-flight port check and
an assertion that the child's own stdout shows it listening. Worth more than
the feature: this is the third time in this project a green result was
verifying the wrong thing (see D2, D4).

Two bugs the test caught:
- `npx` spawns a grandchild node process, so `child.kill()` orphaned the real
  server and leaked the port into the next run. Now `detached: true` plus a
  negative-pid kill to take down the process group. Verified over two
  consecutive runs.
- The source scan flagged `exec(` — it was `/regex/.exec()` in normalizeIp, not
  command execution. Narrowed to patterns that cannot match a regex call.

## D15 — IPv4-mapped IPv6 addresses unwrapped

Node reports IPv4 clients on a dual-stack listener as `::ffff:203.0.113.5`.
Left as-is, every IPv4 source IP fails geo/ASN lookup and correlates as an
unrelated "unknown" campaign. Found because an end-to-end run printed
`unknown` as the source for every event. Now unwrapped, with a test asserting
no `::ffff:` reaches the log.

## D12 — Concurrency test kept out of `test:all`

`scripts/test-concurrency.ts` fires N simultaneous SSH sessions at a live
honeypot and asserts every one produces exactly one uniquely-identified event.
Deliberately NOT in test:all: it needs a running listener, and test:all must
stay runnable on a clean checkout with no server. Run with
`npm run test:concurrency` (honeypot up) or `npm run verify:honeypot`.

Passed at both 12 and 40 concurrent sessions with zero uncaught errors and no
duplicate ids, so no honeypot change was needed -- the per-connection isolation
added earlier holds under load. Recorded because "it passed" is not the same as
"it is covered by the default suite".

## D13 — Two API-contract details found by writing tests

`getCampaign()` returns `null`, not `undefined`, for a missing id. Harmless
today (the MCP tool uses `?? c`) but a test asserting `undefined` failed, which
is the point of writing it down. Also confirmed `listCampaigns()` on a fresh
install returns `[]` rather than throwing -- the first thing a real user hits.

## D11 — Correlation is idempotent (checked, not changed)

Worried that re-running `npm run correlate` would duplicate every campaign.
It does not: three consecutive runs on the same input hold at 15 campaigns.
No change needed, recorded so the question is not re-opened.

MCP adversarial check (`scripts/test-mcp-robustness.ts`, 11 assertions) found
nothing else: SQL-ish ids are parameterized and return `found: false` rather
than executing; wrong-typed, missing, and absurd `limit` values all produce
clean tool errors; the server survives every case and still lists all 3 tools.
