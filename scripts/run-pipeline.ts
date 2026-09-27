/**
 * End-to-end: honeypot events -> normalizer -> triage -> enriched.jsonl.
 * Uses the real Gemini classifier.
 *
 * Exits non-zero if nothing could be enriched: reporting success while writing
 * zero events is worse than failing, because a caller cannot tell the
 * difference between "no attacks" and "the API key is missing".
 *
 * Usage: npx tsx scripts/run-pipeline.ts
 */
import "dotenv/config";
import { appendFileSync, mkdirSync } from "node:fs";
import { readEvents } from "../src/mastra/normalizer";
import { triageEvent } from "../src/mastra/triage";

const OUT = "data/enriched.jsonl";

/** Turn a provider error into one actionable line. */
function hintFor(msg: string): string | null {
  if (/could not find api key|api key not found|no api key/i.test(msg)) {
    return "No Gemini API key found. Get a free key at https://aistudio.google.com/apikey (starts with AIza), add it to .env as GOOGLE_GENERATIVE_AI_API_KEY, or run `npm run seed` to demo without an LLM.";
  }
  if (/exceeded your current quota|quota exceeded/i.test(msg)) {
    return "Gemini quota exhausted. The free tier allows ~20 requests/day — wait for the reset, or run `npm run seed` to demo without an LLM.";
  }
  if (/model .* not found|is not accessible|not supported/i.test(msg)) {
    return "The configured model is unavailable for this key. Check the model id in src/mastra/agents/agent.ts.";
  }
  if (/ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(msg)) {
    return "Could not reach the Gemini API. Check your network, or run `npm run seed` to demo offline.";
  }
  return null;
}

const events = await readEvents();

if (events.length === 0) {
  console.log(
    "No events in data/events.jsonl — start the honeypot and connect first.",
  );
  process.exit(0);
}

mkdirSync("data", { recursive: true });
console.log(`Triaging ${events.length} event(s) with the live classifier...\n`);

let ok = 0;
let failed = 0;
const firstError = { message: "" };

for (const e of events) {
  try {
    const enriched = await triageEvent(e);
    appendFileSync(OUT, JSON.stringify(enriched) + "\n");
    ok++;
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
    if (!firstError.message) firstError.message = msg;
    failed++;
    const hardQuota =
      /exceeded your current quota|quota exceeded.*limit: \d+/i.test(msg);
    if (!hardQuota && /429|rate|quota|resource|overloaded/i.test(msg)) {
      console.warn(`  rate limited on ${e.id}, retrying in 4s...`);
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const retry = await triageEvent(e);
        appendFileSync(OUT, JSON.stringify(retry) + "\n");
        ok++;
        failed--;
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

console.log(`\nEnriched ${ok}/${events.length} event(s) -> ${OUT}`);

if (ok === 0) {
  console.error("\nPIPELINE FAILED: no events were enriched.");
  const hint = hintFor(firstError.message);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// Partial success still exits non-zero so CI notices, but says what worked.
if (failed > 0) {
  console.error(
    `\nWARNING: ${failed} event(s) failed. Re-run to retry just those.`,
  );
  process.exit(1);
}
