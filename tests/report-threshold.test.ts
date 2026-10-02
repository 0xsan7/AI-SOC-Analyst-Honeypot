/**
 * FR6 regression: a report is generated the FIRST time a campaign reaches
 * severity >= 4 or >= 5 events, and not before.
 *
 * The bug this pins: `scripts/correlate.ts` asked "was this event already in
 * the campaign?" AFTER calling `correlate()`, which appends the event id
 * before returning. The answer was therefore "yes" on every iteration,
 * including a campaign's first event, so `force` was always true and the
 * severity threshold was never consulted. The seeded run wrote 15 reports for
 * the 4 campaigns that actually qualify.
 *
 * Threshold defined by PRD FR6.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SeededEvent = { timestamp: string; severity: number };
type SeededCampaign = { id: string; eventIds: string[]; maxSeverity: number };

let dir: string;
let campaigns: SeededCampaign[] = [];
/** Campaign ids that got a report on disk, read back from reports/. */
let reportedIds = new Set<string>();
let seedError: string | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "scram-fr6-"));
  process.env.TURSO_DATABASE_URL = `file:${join(dir, "fr6.db")}`;

  // reports/ is gitignored, so clear it and read it back afterwards. The
  // assertion is about files that actually appeared on disk, not about what
  // the script claimed it did.
  rmSync("reports", { recursive: true, force: true });

  try {
    execFileSync("npx", ["tsx", "scripts/seed-enriched.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    });
    execFileSync("npx", ["tsx", "scripts/correlate.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    });
  } catch (err) {
    seedError = String((err as { stderr?: Buffer }).stderr ?? err);
    return;
  }

  const { readdirSync } = await import("node:fs");
  try {
    for (const f of readdirSync("reports")) {
      const m = /campaign-([0-9a-f-]{36})/.exec(f);
      if (m) reportedIds.add(m[1]);
    }
  } catch {
    /* no reports directory at all is itself a failure, asserted below */
  }

  vi.resetModules();
  const { listCampaigns } = await import("../src/mastra/store");
  campaigns = (await listCampaigns()) as unknown as SeededCampaign[];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TURSO_DATABASE_URL;
});

/** FR6: severity >= 4, or at least 5 events. */
function meetsThreshold(c: SeededCampaign): boolean {
  return c.maxSeverity >= 4 || c.eventIds.length >= 5;
}

describe("FR6 report threshold", () => {
  it("runs the seed and correlate scripts successfully", () => {
    expect(seedError, `scripts failed:\n${seedError ?? ""}`).toBeNull();
  });

  it("reports every campaign that meets the threshold", () => {
    const qualifying = campaigns.filter(meetsThreshold);
    expect(qualifying.length, "seed produced no qualifying campaign to test with")
      .toBeGreaterThan(0);
    for (const c of qualifying) {
      expect(
        reportedIds.has(c.id),
        `qualifying campaign ${c.id.slice(0, 8)} (sev ${c.maxSeverity}, ${c.eventIds.length} events) has no report`,
      ).toBe(true);
    }
  });

  it("writes no report for a campaign below the threshold", () => {
    // The actual regression. Before the fix this was 11 extra reports: every
    // severity-1 background ping produced a campaign-*.md.
    const below = campaigns.filter((c) => !meetsThreshold(c));
    expect(below.length, "seed produced no below-threshold campaign to test with")
      .toBeGreaterThan(0);
    const wronglyReported = below.filter((c) => reportedIds.has(c.id));
    expect(
      wronglyReported.length,
      `${wronglyReported.length} below-threshold campaign(s) got a report`,
    ).toBe(0);
  });

  it("does not write one report per event", () => {
    // The headline campaign has 6 events; it must still be one report.
    expect(reportedIds.size).toBe(
      campaigns.filter(meetsThreshold).length,
    );
  });
});
