/**
 * Triage tests. Every classifier is mocked — no live LLM or geo calls
 * (PRD section 12). Enrichment is exercised through a stubbed fetch so
 * graceful degradation (FR4) can be asserted deterministically.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { enrich, lookupReputation } from "../src/mastra/enrich";
import { triageEvent, type Classifier } from "../src/mastra/triage";
import {
  AttackEventSchema,
  EnrichedEventSchema,
  type AttackEvent,
} from "../src/mastra/schemas";

const EVENT: AttackEvent = AttackEventSchema.parse({
  id: "evt-1",
  timestamp: "2026-09-27T00:00:00.000Z",
  sourceIp: "203.0.113.7",
  service: "ssh",
  usernameTried: "root",
  passwordTried: "admin123",
  commandsAttempted: ["whoami", "cat /etc/shadow"],
  sessionDurationMs: 4200,
  raw: {},
});

const reconClassifier: Classifier = async () => ({
  classification: "recon",
  severity: 3,
  reasoning: "Enumerating system files after a default-credential login.",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("triageEvent", () => {
  it("classifies and enriches an event (FR3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: "success",
          country: "Russia",
          city: "Moscow",
          isp: "Example ISP",
          as: "AS64500",
        }),
      })),
    );

    const result = await triageEvent(EVENT, reconClassifier);

    expect(result.classification).toBe("recon");
    expect(result.severity).toBe(3);
    expect(result.geo?.country).toBe("Russia");
    // The original event fields must survive the pipeline.
    expect(result.sourceIp).toBe("203.0.113.7");
    expect(result.commandsAttempted).toEqual(["whoami", "cat /etc/shadow"]);
    expect(EnrichedEventSchema.safeParse(result).success).toBe(true);
  });

  it("uses the injected classifier, not a live model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ status: "success" }),
      })),
    );
    const spy = vi.fn(reconClassifier);
    await triageEvent(EVENT, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].sourceIp).toBe("203.0.113.7");
  });
});

describe("graceful degradation (FR4)", () => {
  it("survives a total enrichment failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await triageEvent(EVENT, reconClassifier);
    expect(result.classification).toBe("recon");
    expect(result.geo).toBeUndefined();
    expect(result.enrichmentWarnings?.length).toBeGreaterThan(0);
  });

  it("skips AbuseIPDB with a warning when no key is set", async () => {
    const prev = process.env.ABUSEIPDB_API_KEY;
    delete process.env.ABUSEIPDB_API_KEY;
    const res = await lookupReputation("198.51.100.1");
    expect(res.reputationScore).toBeUndefined();
    expect(res.warnings.join(" ")).toMatch(/ABUSEIPDB_API_KEY/);
    if (prev) process.env.ABUSEIPDB_API_KEY = prev;
  });

  it('skips geo lookup for private IPs', async () => {
    const { warnings, geo } = await enrich('127.0.0.1');
    expect(geo).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/private IP/);
  });
});

describe('rate limit handling (Step 5)', () => {
  it('surfaces the underlying step error instead of a bare status', async () => {
    const boom: Classifier = async () => {
      throw new Error('AI_APICallError: Quota exceeded for metric: generate_content_free_tier_requests, limit: 20');
    };
    await expect(triageEvent(EVENT, boom)).rejects.toThrow(/quota/i);
  });
});
