# PRD: AI SOC Analyst — Agentic Honeypot Triage System

**Owner:** [you]
**Status:** Built; see `TESTING.md` for the verification standard
**Target:** Autonomous build via coding agent (OpenCode), 2-day sprint

> **Verification standard (added 2026-09-27, after a lesson paid for).**
> A criterion below is satisfied only when it has been *executed end to end with
> real inputs*. A tool appearing in a list, a handler existing, or a test that
> never calls the thing it names does not count — those prove the code parses
> and registers, which is strictly weaker than "it works".
>
> This is not academic. `ask_soc_agent` was broken on every call and the suite
> was green, because the MCP test listed the tool and never invoked it. Before
> trusting any new test, break the code it guards and confirm it goes red.

## 1. Summary

Build a self-hosted system that runs low-interaction honeypots, feeds every attacker interaction through a multi-agent triage pipeline (built on Mastra), and produces structured, human-readable incident reports with severity scoring, IOC enrichment, and campaign correlation across time. The system ships with a live observability dashboard (Mastra Studio) and exposes its triage agent as an MCP server so it's usable from any MCP-compatible client. This is a defensive-security tool: it observes traffic directed at infrastructure the operator owns. It does not scan, probe, or interact with third-party systems.

## 2. Goals

- G1: At least one working honeypot service (SSH, minimum) logging structured events.
- G2: A Mastra workflow classifying each event (noise / recon / active attack) and enriching it with threat-intel context.
- G3: A Mastra agent with persistent memory correlating events across time into "campaigns."
- G4: Auto-generated readable incident reports (markdown) per campaign, escalating with severity.
- G5: The triage agent exposed as an MCP server (list campaigns, get campaign detail, free-text Q&A).
- G6: A live dashboard (Mastra Studio or custom) showing traces, event volume, top attacker sources.
- G7: A polished README with architecture diagram, setup instructions, demo GIF/screenshot.

## 3. Non-goals

- No active blocking or retaliation — logging/analysis only.
- No scanning or interacting with systems the operator doesn't own.
- No high-interaction honeypots (full fake OS/filesystem) — low-interaction only.
- No multi-tenant auth — single-operator tool.
- Not optimizing for massive scale — optimize for correctness and demo quality.

## 4. Architecture

Honeypot service(s) -> Event ingestion/normalizer -> Mastra Triage Workflow (classify -> enrich) -> Correlation Agent + Memory (groups into campaigns) -> Report Generator -> [Markdown reports] + [Mastra Studio dashboard] + [MCP server exposure]

Components:

1. **Honeypot layer**: low-interaction SSH honeypot (Node `ssh2` in server mode or similar). Logs credentials tried, commands attempted (never executed), source IP, timestamp, session duration as structured JSON.
2. **Ingestion/normalizer**: tails honeypot events, converts to normalized AttackEvent schema, feeds into the Mastra workflow.
3. **Triage Workflow** (Mastra `createWorkflow`): `classifyEvent` step (LLM-graded: noise/recon/credential_stuffing/active_exploit_attempt + severity 1-5), `enrichEvent` step (geolocation via free API like ip-api.com, ASN/org lookup, optional AbuseIPDB if key configured — must degrade gracefully with no key). Persists to LibSQLStore.
4. **Correlation Agent**: Mastra Agent with Memory (semantic recall + observational memory). Checks if a new enriched event matches a recent campaign; appends or opens new one. Exposed as tool-callable for ad hoc Q&A.
5. **Report Generator**: workflow step triggered when a campaign crosses a severity/volume threshold. Generates markdown report: summary, timeline, IOCs, severity, plain-language explanation.
6. **Dashboard**: Mastra Studio (localhost:4111) for traces/evals/metrics. Optional custom HTML view for a cleaner demo screenshot.
7. **MCP exposure**: wrap the Correlation Agent as an MCP server with tools `get_recent_campaigns`, `get_campaign_detail(id)`, `ask_soc_agent(question)`.

## 5. Tech Stack

Node.js + TypeScript, Mastra (`@mastra/core`, `@mastra/memory`, `@mastra/libsql`), LibSQL for storage, custom SSH honeypot (`ssh2` package), Google Gemini as the LLM provider (free tier — use `gemini-2.0-flash` or similar), ponytail plugin active throughout for lean code, deployable to any VPS or run locally for demo purposes.

## 6. Data Model

- **AttackEvent**: id, timestamp, sourceIp, service (ssh/http), usernameTried?, passwordTried?, commandsAttempted?, sessionDurationMs, raw.
- **EnrichedEvent** extends AttackEvent: classification, severity (1-5), geo?, asn?, reputationScore?.
- **Campaign**: id, firstSeen, lastSeen, sourceIps[], eventIds[], maxSeverity, status (open/closed), summary?.

## 7. Functional Requirements

- FR1: Honeypot logs every connection attempt, even with no auth attempt.
- FR2: No real command execution ever permitted in the honeypot, hardcoded, not left to LLM judgment.
- FR3: Every AttackEvent passes through classification before persisting as EnrichedEvent.
- FR4: Enrichment degrades gracefully (skip lookup, log warning) if an optional API key is missing — never crash the pipeline.
- FR5: Correlation Agent persists campaign state across restarts via LibSQL, not memory-only.
- FR6: A report auto-generates the first time a campaign reaches severity >= 4 or >= 5 events.
- FR7: MCP server exposes at least 3 tools: list campaigns, get campaign detail, free-text Q&A.
- FR8: Dashboard shows at minimum: total events, events/hour, top 5 source IPs, open campaigns list.
- FR9: All secrets loaded from .env, never hardcoded; .env.example documents every variable.

## 8. Milestones

- **Day 1**: Scaffold project, build SSH honeypot logging raw connections, build ingestion/normalizer, build triage workflow (classify+enrich) with graceful degradation, verify end-to-end.
- **Day 2**: Build Correlation Agent with memory and verify campaign grouping, build Report Generator with threshold trigger, wrap agent as MCP server, stand up Mastra Studio (+ optional custom dashboard), write README with diagram/screenshots/demo, run `/ponytail-review` and `/ponytail-audit` before finishing.

## 9. Acceptance Criteria

- Connecting to the honeypot produces a classified, enriched event within seconds.
- Multiple connections from the same source IP in a short window produce one campaign, not several.
- A synthetic high-severity scenario triggers an auto-generated report.
- `ask_soc_agent` via MCP returns a coherent answer grounded in real stored data.
- Mastra Studio shows live traces for a triage run.
- README lets a stranger clone and run it in under 10 minutes.

## 10. Security & Ethics Constraints (non-negotiable)

- Honeypot only listens/logs, never grants real shell access or executes attacker commands.
- Only analyzes traffic hitting infrastructure the operator controls — no active scanning of third parties.
- Threat-intel API usage stays within free-tier/ToS limits.
- Scrub any real scraped credentials from public README/demo examples.

## 11. Deliverables

Public GitHub repo with full source, `.env.example`, setup instructions, README with architecture diagram and demo GIF/screenshots, at least one example generated report in `examples/`, optional `/ponytail-gain` output as a "built lean" badge.

## 12. Dev Guardrails

Keep ponytail active in `full` mode throughout; run `/ponytail-review` after each milestone. Prefer Mastra's built-in primitives over hand-rolled equivalents. Every external API call must degrade gracefully if its key is missing. Write tests for classification/enrichment using mocked LLM responses, not live API calls.
