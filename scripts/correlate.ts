/**
 * Correlate stored enriched events into campaigns and auto-generate reports.
 * Reads data/enriched.jsonl, so it costs zero LLM calls and can be re-run
 * freely on the free tier.
 * Usage: npx tsx scripts/correlate.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  closeIdleCampaigns,
  correlate,
  findMatchingCampaign,
  getCampaign,
  initStore,
  listCampaigns,
} from "../src/mastra/store";
import { generateReportIfNeeded } from "../src/mastra/report";
import { EnrichedEventSchema } from "../src/mastra/schemas";

await initStore();

// Retire campaigns that have gone quiet before correlating, so an incident
// that ended days ago stops counting as active.
const closed = await closeIdleCampaigns();
if (closed.length > 0) {
  console.log(`Closed ${closed.length} idle campaign(s).`);
  // Refresh their reports so the file on disk stops saying "open". Without
  // this the markdown is the last place still showing an incident as active:
  // needsReport() is false for an already-generated report, and closing
  // happens before the loop that would otherwise force a refresh.
  for (const id of closed) {
    const c = await getCampaign(id);
    if (c) await generateReportIfNeeded(c, true);
  }
}

let events: ReturnType<typeof EnrichedEventSchema.parse>[] = [];
try {
  events = readFileSync("data/enriched.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => EnrichedEventSchema.parse(JSON.parse(l)));
} catch {
  console.log("No data/enriched.jsonl — run `npm run pipeline` first.");
  process.exit(0);
}

// Correlate chronologically. Ingestion order must not decide grouping — an
// out-of-order file previously split one attacker across several campaigns.
events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

console.log(`Correlating ${events.length} enriched event(s)...\n`);
for (const e of events) {
  // Was this event going to JOIN an existing campaign, or open a new one?
  //
  // This must be asked BEFORE correlate(), because correlate() has already
  // appended the event id to the campaign's eventIds by the time it returns.
  // Asking afterwards made the answer "already present" on every iteration,
  // including a campaign's very first event, which set force=true throughout
  // and bypassed FR6 entirely: the seeded run wrote 15 reports for the 4
  // campaigns that actually meet the threshold.
  //
  // force here means "this campaign was already open, so refresh its report
  // as it grows" -- not "generate a report regardless of severity".
  const existing = await findMatchingCampaign(e);
  const c = await correlate(e);
  const path = await generateReportIfNeeded(c, existing !== null);
  console.log(
    `  ${e.sourceIp} sev${e.severity} ${e.classification.padEnd(24)} -> campaign ${c.id.slice(0, 8)} ` +
      `(${c.eventIds.length} events, max sev ${c.maxSeverity})` +
      (path ? `  REPORT: ${path}` : ""),
  );
}

console.log(
  `\n${(await listCampaigns()).length} campaign(s) stored ` +
    `(${(await listCampaigns(200)).filter((c) => c.status === "open").length} open).`,
);
