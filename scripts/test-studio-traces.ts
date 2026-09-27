/**
 * PRD acceptance criterion: "Mastra Studio shows live traces for a triage
 * run."
 *
 * Requires `npm run dev` already running on 4111 and a Gemini key in .env.
 *   npx tsx scripts/test-studio-traces.ts
 *
 * Traces land in Studio's in-process DuckDB observability store, so the
 * workflow must be executed THROUGH Studio's API. An earlier version of this
 * script called triageEvent() in a separate process, which produced no
 * visible trace -- the exporter wrote into a different store.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:4111";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const up = await fetch(`${STUDIO}/`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
check("Mastra Studio is reachable", up !== null, up ? STUDIO : "not running — start `npm run dev`");
if (!up) process.exit(1);

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error("This test needs a Gemini key in .env. Excluded from test:all for that reason.");
  process.exit(0);
}

// Record the baseline so the assertion cannot pass on a pre-existing trace.
const before = await (await fetch(`${STUDIO}/api/observability/traces?page=0&perPage=1`)).json();
const baseline = before?.pagination?.total ?? 0;

const runId = randomUUID();
const created = await fetch(
  `${STUDIO}/api/workflows/triageWorkflow/create-run?runId=${runId}`,
  { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
);
check("workflow run created", created.ok, `HTTP ${created.status}`);

const marker = `trace-probe-${randomUUID().slice(0, 8)}`;
console.log(`running triage through Studio (marker ${marker})...`);
const started = await fetch(`${STUDIO}/api/workflows/triageWorkflow/start?runId=${runId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    event: {
      id: marker,
      timestamp: new Date().toISOString(),
      sourceIp: "198.51.100.99",
      sourcePort: 44444,
      service: "ssh",
      usernameTried: "root",
      passwordTried: "hunter2",
      commandsAttempted: ["uname -a", "id"],
      sessionDurationMs: 900,
      raw: {},
    },
  }),
});
check("workflow started", started.ok, (await started.text()).slice(0, 80));

// The run is async, so poll rather than sleeping a fixed amount.
let total = baseline;
let seen = false;
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const j = await (
    await fetch(`${STUDIO}/api/observability/traces?page=0&perPage=10`)
  ).json();
  total = j?.pagination?.total ?? 0;
  const spans = j?.spans ?? [];
  if (total > baseline && spans.some((s: { name?: string }) => /triage/i.test(s.name ?? ""))) {
    seen = true;
    console.log(
      `  trace appeared after ~${(i + 1) * 2.5}s: ${spans[0].name} (traceId ${String(spans[0].traceId).slice(0, 8)})`,
    );
    break;
  }
}

check("a new trace was recorded", total > baseline, `${baseline} -> ${total} spans`);
check("the trace is the triage workflow", seen, seen ? "workflow_run span present" : "no triage span");

console.log(failures === 0 ? "\nSTUDIO TRACE TEST: PASS" : `\nSTUDIO TRACE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
