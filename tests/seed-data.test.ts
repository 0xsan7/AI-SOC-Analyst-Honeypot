/**
 * Seed-data acceptance: does `npm run seed` actually exercise the shapes the
 * project claims to cover?
 *
 * This exists because the unit tests were right and the README was wrong.
 * `tests/correlation.test.ts` covers a single-event campaign by calling
 * `correlate()` directly, so the suite was green while nobody had checked
 * whether the demo data produced one. That is precisely the failure mode
 * CONTRIBUTING.md warns about: a test that does not call the thing it is
 * named for is not a test of it. So this runs the actual seed script and
 * the actual correlation loop, and asserts on what a user really gets.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SeededEvent = { timestamp: string };
type SeededCampaign = {
  eventIds: string[];
  maxSeverity: number;
  sourceIps: string[];
};

let dir: string;
let seedOutPath = "";
let events: SeededEvent[] = [];
let campaigns: SeededCampaign[] = [];
/** Non-null when the seed script itself failed, asserted on in a test. */
let seedError: string | null = null;

/**
 * Parse the seeded file and run the same loop scripts/correlate.ts runs.
 *
 * Called exactly ONCE for the whole file. The store persists across calls, so
 * correlating twice re-ingests every event into the campaigns that already
 * contain them — which is how the first draft of this test saw campaigns of
 * 12 and 2 instead of 6 and 1, and failed for the wrong reason.
 */
async function correlateSeeded() {
  const { correlate, initStore, listCampaigns } = await import(
    "../src/mastra/store"
  );
  const { EnrichedEventSchema } = await import("../src/mastra/schemas");
  await initStore();

  const parsed = readFileSync(seedOutPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l: string) => EnrichedEventSchema.parse(JSON.parse(l)));

  // Chronological order, as the real script does. Ingestion order must not
  // decide grouping — an out-of-order file once split one attacker across
  // several campaigns.
  parsed.sort((a: { timestamp: string }, b: { timestamp: string }) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  for (const e of parsed) await correlate(e);

  const stored = (await listCampaigns()) as unknown as SeededCampaign[];
  return { events: parsed, campaigns: stored };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "scram-seed-"));
  // The store memoizes its LibSQL client and reads this at module load, so the
  // environment must be set before the dynamic import inside correlateSeeded.
  process.env.TURSO_DATABASE_URL = `file:${join(dir, "seed.db")}`;

  // Run the REAL seed script rather than reimplementing its logic. A test
  // that reconstructs the seed proves nothing about the seed.
  // stdio:"pipe" plus an explicit status check: execFileSync already throws on
  // a non-zero exit, but a beforeAll that throws marks every test *skipped*,
  // and a skipped suite reads as a pass in a coverage report. Recording the
  // failure and asserting on it in a test makes it red instead.
  try {
    // Seed into THIS suite's own directory. The seed script writes a shared
    // repo-relative path by default, and two suites doing that in parallel
    // corrupted each other's file — one truncated it while the other was
    // reading, producing a stray "}" line and a JSON parse error.
    const outPath = join(dir, "enriched.jsonl");
    execFileSync("npx", ["tsx", "scripts/seed-enriched.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, SEED_OUT_PATH: outPath },
      stdio: "pipe",
    });
    seedOutPath = outPath;
    seedError = null;
  } catch (err) {
    seedError = String((err as { stderr?: Buffer }).stderr ?? err);
  }

  vi.resetModules();
  if (seedError === null) {
    const result = await correlateSeeded();
    events = result.events;
    campaigns = result.campaigns;
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TURSO_DATABASE_URL;
});

describe("npm run seed", () => {
  it("runs the seed script successfully", () => {
    // Without this, a broken seed script fails in beforeAll and every test
    // below is reported as *skipped*, which reads as a pass. This makes it red.
    expect(seedError, `seed script failed:\n${seedError ?? ""}`).toBeNull();
  });

  it("seeds the advertised 20 events", () => {
    expect(events).toHaveLength(20);
  });

  it("produces single-event campaigns", () => {
    // The claim this test exists to check. It is true, and true by
    // construction: only the headline attacker repeats an IP inside the
    // 30-minute window, so every other seeded event stands alone.
    const sizes = campaigns.map((c) => c.eventIds.length);
    const singles = sizes.filter((n) => n === 1).length;
    expect(
      singles,
      `no single-event campaigns; campaign sizes were [${sizes.join(",")}]`,
    ).toBeGreaterThan(0);
  });

  it("collapses the six-session headline attack into one campaign", () => {
    // The demo's whole point: six sessions from one IP inside the window must
    // become ONE campaign, not six.
    const sizes = campaigns.map((c) => c.eventIds.length);
    const headline = campaigns.find((c) => c.eventIds.length === 6);
    expect(
      headline,
      `no 6-event campaign; sizes were [${sizes.join(",")}]`,
    ).toBeDefined();
    expect(headline!.maxSeverity).toBe(5);
    expect(headline!.sourceIps).toEqual(["198.51.100.23"]);
  });

  it("accounts for every seeded event exactly once", () => {
    // Catches correlation dropping or double-counting events, which a
    // per-campaign size check would never notice.
    const total = campaigns.reduce((n, c) => n + c.eventIds.length, 0);
    expect(total).toBe(20);
  });

  it("splits the headline IP when it returns after the window", () => {
    // The same IP comes back 75 minutes later. That gap exceeds the 30-minute
    // window, so it must NOT merge into the headline campaign.
    const sameIp = campaigns.filter((c) =>
      c.sourceIps.includes("198.51.100.23"),
    );
    expect(sameIp.length).toBeGreaterThan(1);
  });
});
