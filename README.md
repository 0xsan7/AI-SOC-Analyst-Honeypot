<div align="center">

# 🪤 AI SOC Analyst

**An agentic honeypot triage pipeline.** Attackers hit a low-interaction SSH honeypot; a Mastra workflow grades every session, enriches it with threat intel, and writes analyst-readable reports.

[![Gemini](https://img.shields.io/badge/LLM-Google%20Gemini-4285F4?style=flat-square&logo=googlegemini&logoColor=white)](https://ai.google.dev/gemini-api)
[![Mastra](https://img.shields.io/badge/framework-Mastra-8A2BE2?style=flat-square)](https://mastra.ai)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](LICENSE)

</div>

---

## What it does

A public SSH port gets scanned constantly. Most of it is noise; some of it is a real operator working their way toward a foothold. Telling those apart by hand is the boring part.

This project automates the boring part:

- **Honeypot** — a low-interaction SSH server that accepts any credential and answers from a static table. It records what was tried, never runs it.
- **Triage** — a Mastra workflow classifies each session (`noise` / `recon` / `credential_stuffing` / `active_exploit_attempt`) with an LLM-graded severity 1–5.
- **Enrichment** — geolocation and ASN via `ip-api.com`, optional AbuseIPDB reputation. Every lookup degrades gracefully: a missing key or a dead network produces a warning, never a crash.
- **Correlation** — events from the same source IP inside a 30-minute window collapse into one campaign, persisted in LibSQL so they survive restarts.
- **Reports** — markdown incident reports auto-generated the first time a campaign crosses severity 4 or 5 events, and refreshed as it grows.
- **MCP server** — exposes `get_recent_campaigns`, `get_campaign_detail`, and `ask_soc_agent` to any MCP client.
- **Dashboard** — live view of event volume, top sources, and open campaigns.

## Architecture

```
   attacker
      │  ssh -p 2222
      ▼
┌──────────────────────┐
│  SSH honeypot :2222  │   accepts any credential
│  (ssh2, no exec)     │   static canned replies only
└──────────┬───────────┘
           │  data/events.jsonl
           ▼
┌──────────────────────┐
│  Normalizer          │   JSONL → validated AttackEvent
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  Mastra triage workflow                 │
│                                          │
│  classify ──► Gemini grades severity     │
│      │                                   │
│      ▼                                   │
│  enrich   ──► ip-api.com / AbuseIPDB     │
│             (degrades gracefully)        │
└──────────┬───────────────────────────────┘
           │  data/enriched.jsonl
           ▼
┌──────────────────────┐
│  Correlation agent   │   same IP within 30 min -> one campaign
│  (LibSQL, persists)  │   report at severity>=4 or >=5 events
└──────────┬───────────┘
           ▼
      reports/*.md
           │
           ├──► dashboard (npm run dashboard)
           └──► MCP server (npm run mcp)
                 get_recent_campaigns
                 get_campaign_detail
                 ask_soc_agent
```

## Quick start

Requires **Node 22.13+**.

```bash
git clone https://github.com/0xsan7/Honeypot.git
cd Honeypot
npm install
cp .env.example .env      # add your GOOGLE_GENERATIVE_AI_API_KEY
npm run keys              # generate honeypot host keys
```

Get a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (starts with `AIza`).

Then, in two terminals:

```bash
# 1 — start the honeypot
npm run honeypot

# 2 — attack it, then triage what it caught
ssh -p 2222 root@127.0.0.1    # any password works
whoami
cat /etc/shadow

npm run pipeline
```

Output:

```
[5] active_exploit_attempt   127.0.0.1 user=root pass=admin123 cmds=4
[4] active_exploit_attempt   127.0.0.1 user=admin pass=password cmds=2
[3] credential_stuffing      127.0.0.1 user=test pass=test cmds=0
      warnings: skipped geo lookup for private IP; AbuseIPDB skipped: no key
```

**Out of Gemini quota?** Seed realistic enriched events and exercise the whole
second half of the pipeline without spending a single request:

```bash
npm run seed        # 9 synthetic enriched events
npm run correlate   # group into campaigns, generate reports
```

```
  198.51.100.23 sev5 active_exploit_attempt   -> campaign 9993a6d3 (6 events, max sev 5)
      REPORT: reports/campaign-9993a6d3-....md
```

Then view it:

```bash
npm run dashboard   # landing page at /, console at /dashboard
npm run mcp         # MCP server on stdio
```

The site has two views: a React landing page at `/` and the live SOC console at `/dashboard`.

![SOC Analyst landing page](docs/landing.png)

## Building the site

The landing page is a Vite + React + Tailwind app in `web/`, kept separate from the
Mastra backend. The console (`src/mastra/public/dashboard.html`) is dependency-free
static HTML and needs no build step.

```bash
cd web && npm install && npm run build
```

`npm run dashboard` serves the built output; if `web/dist` is missing it says so
rather than failing silently.

## Commands

| Command | What it does |
| --- | --- |
| `npm run honeypot` | Start the SSH honeypot on `:2222` |
| `npm run pipeline` | Triage every captured event through the LLM |
| `npm run correlate` | Group enriched events into campaigns, write reports |
| `npm run seed` | Seed synthetic enriched events (no LLM calls) |
| `npm run dashboard` | Live dashboard on [127.0.0.1:4173](http://127.0.0.1:4173) |
| `npm run mcp` | MCP server on stdio (3 tools) |
| `npm run probe` | Drive synthetic SSH sessions at the honeypot |
| `npm run dev` | Mastra Studio on [localhost:4111](http://localhost:4111) |
| `npm test` | Run the test suite (mocked LLM — no API calls) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run keys` | Regenerate honeypot host keys |

## MCP server

```bash
npm run mcp
```

| Tool | Purpose |
| --- | --- |
| `get_recent_campaigns` | List recent campaigns with severity and event counts |
| `get_campaign_detail` | One campaign plus every enriched event in it |
| `ask_soc_agent` | Free-text questions, answered from stored data only |

Add it to any MCP client (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "soc-analyst": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/soc-analyst"
    }
  }
}
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes | Gemini key for classification |
| `ABUSEIPDB_API_KEY` | no | Reputation scores; skipped when absent |
| `HONEYPOT_PORT` | no | Defaults to `2222` |
| `HONEYPOT_BIND` | no | Defaults to `127.0.0.1` (loopback) |
| `HONEYPOT_LOG` | no | Defaults to `data/events.jsonl` |
| `CAMPAIGN_WINDOW_MS` | no | Correlation window, defaults to 30 minutes |
| `REPORT_DIR` | no | Defaults to `reports/` |
| `DASHBOARD_PORT` | no | Defaults to `4173` |
| `TURSO_DATABASE_URL` | no | Remote LibSQL; defaults to `file:./soc-analyst.db` |

## Security model

This is a **defensive** tool. It observes traffic aimed at infrastructure the operator controls.

- **No command execution, ever.** There is no `child_process`, no shell, no `spawn` in the honeypot. Attacker commands are recorded as strings and answered from a static lookup table. This is enforced by construction — there is no code path from attacker input to a real process, and it does not depend on any LLM or runtime judgement.
- **Loopback by default.** The honeypot binds `127.0.0.1`. Set `HONEYPOT_BIND=0.0.0.0` only on infrastructure you own.
- **No scanning.** Nothing here probes or touches third-party systems.
- **Free-tier only.** Geolocation uses `ip-api.com`'s free tier with retry/backoff on 429s.
- **Credentials in examples are synthetic** (`admin123`, `password`), generated by the test probe — never scraped.

## Rate limits

Gemini's free tier allows roughly **20 classification requests per day** on `gemini-3.5-flash`. When you hit it, the pipeline logs the failure for that event and continues with the rest — nothing crashes, but that event goes unenriched until the quota resets.

If you need more throughput, set a billing-enabled key or point `CLASSIFIER_MODEL` at a different model in `src/mastra/triage.ts`.

## Testing

Tests use mocked LLM responses and stubbed network calls — the suite makes no live API calls and costs nothing:

```bash
npm test
```

## Project layout

```
src/
  honeypot/ssh-server.ts   low-interaction SSH honeypot
  mastra/
    index.ts               Mastra registration (agents, tools, workflows)
    schemas.ts             zod schemas: AttackEvent / EnrichedEvent / Campaign
    normalizer.ts          JSONL → validated events
    triage.ts              classify → enrich workflow
    enrich.ts              geo / ASN / reputation, degrades gracefully
    store.ts               LibSQL campaign store (persists across restarts)
    report.ts              markdown incident report generator
    mcp-server.ts          MCP exposure (3 tools)
    agents/soc-agent.ts    memory-backed analyst agent
    public/index.html      dashboard
scripts/
  run-pipeline.ts          honeypot events → enriched events
  correlate.ts             enriched events → campaigns + reports
  seed-enriched.ts         synthetic events for testing without an LLM
  probe-honeypot.ts        synthetic attacker sessions
  dashboard.ts             serves the dashboard
  test-mcp.ts              verifies MCP tool names
tests/                     14 tests, all mocked
reports/                   generated incident reports
```

## Roadmap

Milestones 1 and 2 are done: honeypot, triage, correlation, reports, MCP
exposure, and the dashboard. Not yet built: a live Mastra Studio traces
integration test, and campaign auto-closing after a quiet period.

See [PRD.md](PRD.md) for the full specification.

## License

Apache-2.0
