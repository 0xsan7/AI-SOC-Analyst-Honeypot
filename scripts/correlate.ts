/**
 * Correlate stored enriched events into campaigns and auto-generate reports.
 * Reads data/enriched.jsonl, so it costs zero LLM calls and can be re-run
 * freely on the free tier.
 * Usage: npx tsx scripts/correlate.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { correlate, initStore, listCampaigns } from "../src/mastra/store";
import { generateReportIfNeeded } from "../src/mastra/report";
import { EnrichedEventSchema } from "../src/mastra/schemas";

await initStore();

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
  const c = await correlate(e);
  // Refresh an existing report as the campaign grows, not just on first cross.
  const already = (await listCampaigns(100)).some((x) => x.id === c.id && x.eventIds.includes(e.id));
  const path = await generateReportIfNeeded(c, already);
  console.log(
    `  ${e.sourceIp} sev${e.severity} ${e.classification.padEnd(24)} -> campaign ${c.id.slice(0, 8)} ` +
      `(${c.eventIds.length} events, max sev ${c.maxSeverity})` +
      (path ? `  REPORT: ${path}` : ""),
  );
}

console.log(`\n${(await listCampaigns()).length} campaign(s) stored.`);
