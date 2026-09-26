/**
 * End-to-end: honeypot events -> normalizer -> triage -> enriched.jsonl.
 * Uses the real Gemini classifier.
 * Usage: node --experimental-strip-types scripts/run-pipeline.ts
 */
import "dotenv/config";
import { appendFileSync, mkdirSync } from "node:fs";
import { readEvents } from "../src/mastra/normalizer";
import { triageEvent } from "../src/mastra/triage";

const OUT = "data/enriched.jsonl";
const events = await readEvents();

if (events.length === 0) {
  console.log(
    "No events in data/events.jsonl — start the honeypot and connect first.",
  );
  process.exit(0);
}

mkdirSync("data", { recursive: true });
console.log(`Triaging ${events.length} event(s) with the live classifier...\n`);

for (const e of events) {
  try {
    const enriched = await triageEvent(e);
    appendFileSync(OUT, JSON.stringify(enriched) + "\n");
    console.log(
      `[${enriched.severity}] ${enriched.classification.padEnd(24)} ${enriched.sourceIp} ` +
        `user=${enriched.usernameTried} pass=${enriched.passwordTried} ` +
        `cmds=${enriched.commandsAttempted?.length ?? 0} ` +
        `geo=${enriched.geo?.country ?? "-"}`,
    );
    if (enriched.enrichmentWarnings?.length) {
      console.log(`      warnings: ${enriched.enrichmentWarnings.join("; ")}`);
    }
  } catch (err) {
    // One bad event must not abort the batch. Retry only transient rate limits —
    // Gemini's free tier also has a hard daily cap, which retrying won't fix.
    const msg = (err as Error).message ?? "";
    const hardQuota =
      /exceeded your current quota|quota exceeded.*limit: \d+/i.test(msg);
    if (!hardQuota && /429|rate|quota|resource|overloaded/i.test(msg)) {
      console.warn(`  rate limited on ${e.id}, retrying in 4s...`);
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const retry = await triageEvent(e);
        appendFileSync(OUT, JSON.stringify(retry) + "\n");
        console.log(
          `  recovered ${e.id}: [${retry.severity}] ${retry.classification}`,
        );
        continue;
      } catch (err2) {
        console.error(
          `  FAILED ${e.id} after retry: ${(err2 as Error).message}`,
        );
        continue;
      }
    }
    console.error(`  FAILED ${e.id}: ${msg}`);
  }
}
console.log(`\nWrote enriched events to ${OUT}`);
