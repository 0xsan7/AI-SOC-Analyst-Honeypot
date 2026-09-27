/**
 * ask_soc_agent, with the model mocked.
 *
 * This is the free, permanent regression guard for the bug that shipped:
 * the agent declared `new Memory({ options })` with no `storage`, which does
 * not fail at construction -- it throws on the FIRST call, so every question
 * returned "Memory requires a storage provider to function". The MCP wire
 * test only listed the tool and never invoked it, so the suite stayed green.
 *
 * The live version of this check is `npm run test:ask`. This one costs
 * nothing and needs no key, so it runs in `test:all` and cannot be skipped.
 *
 * The mock replaces the MODEL only. The agent, its Memory, its LibSQL storage
 * and its tools are the real ones -- the parts that actually broke.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";

// A per-test directory. One module-level dir would be deleted by the first
// afterEach and every later test would fail to open the database.
let work: string;
let dbFile: string;

// Imported after the env var is set so the store and agent share this file.
const { Agent } = await import("@mastra/core/agent");
const { Memory } = await import("@mastra/memory");
const { LibSQLStore } = await import("@mastra/libsql");
const { z } = await import("zod");
const { closeStore, correlate, initStore } = await import("../src/mastra/store");
const { getCampaignDetailTool, listCampaignsTool } = await import(
  "../src/mastra/agents/soc-agent"
);

/** Build an agent that mirrors soc-agent.ts, but with a mocked model. */
function buildAgent(mockText: string) {
  return new Agent({
    id: "soc-mock",
    name: "soc-mock",
    instructions: "Answer only from the campaign tools.",
    model: createMockModel({ mockText }),
    memory: new Memory({
      // Same per-test file the store uses, so the agent and the campaign data
      // really do share a database rather than two unrelated ones.
      storage: new LibSQLStore({ id: "ask-mock-memory", url: `file:${dbFile}` }),
      options: { generateTitle: true },
    }),
    tools: { listCampaignsTool, getCampaignDetailTool },
  });
}

const baseEvent = {
  sourceIp: "203.0.113.42",
  sourcePort: 40000,
  service: "ssh" as const,
  usernameTried: "root",
  passwordTried: "toor",
  sessionDurationMs: 100,
  raw: {},
  classification: "credential_stuffing" as const,
  severity: 5,
  reasoning: "default credentials",
};

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "ask-mock-"));
  dbFile = join(work, "ask.db");
  process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
});

afterEach(async () => {
  closeStore();
  rmSync(work, { recursive: true, force: true });
});

describe("ask_soc_agent with a mocked model (FR7)", () => {
  it("answers without throwing — the regression that shipped", async () => {
    // Two events from one source IP inside the window -> one campaign.
    await correlate({ ...baseEvent, id: "mock-1", timestamp: new Date().toISOString() });
    await correlate({
      ...baseEvent,
      id: "mock-2",
      timestamp: new Date().toISOString(),
      commandsAttempted: ["id"],
    });

    const agent = buildAgent("Two attempts against 203.0.113.42, severity 5.");
    const res = await agent.generate("Which IP is attacking?", { toolsets: {} });

    // Before the fix this rejected with "Memory requires a storage provider".
    expect(res.text).toContain("203.0.113.42");
  });

  it("exposes working tools that return stored campaigns", async () => {
    await correlate({ ...baseEvent, id: "mock-3", timestamp: new Date().toISOString() });

    const listed = await listCampaignsTool.execute!({ context: { limit: 5 } } as never);
    const campaigns = (listed as { campaigns: Array<{ sourceIps: string[] }> }).campaigns;

    expect(campaigns.length).toBeGreaterThan(0);
    expect(campaigns[0].sourceIps).toContain("203.0.113.42");
  });

  it("rejects a malformed campaignId instead of reporting it missing", async () => {
    // Validates the tool's REAL schema, not a copy, so this cannot drift from
    // soc-agent.ts. createTool wraps inputSchema in a Standard Schema adapter
    // with no .safeParse, so unwrap the underlying zod schema.
    const schema = getCampaignDetailTool.inputSchema as unknown as {
      "~standard": { validate: (v: unknown) => { value?: unknown; issues?: unknown[] } };
    };
    const check = (v: unknown) => !schema["~standard"].validate(v).issues;

    // Empty and whitespace-only ids are malformed requests. This is the case
    // that `min(1).trim()` got wrong: .trim() is a transform that runs AFTER
    // the length check, so "   " used to validate and then trim to "".
    expect(check({ campaignId: "   " })).toBe(false);
    expect(check({ campaignId: "" })).toBe(false);
    expect(check({ campaignId: 123 })).toBe(false);
    expect(check({ campaignId: {} })).toBe(false);
    expect(check({})).toBe(false);
    // A real id still validates.
    expect(check({ campaignId: "abc-123" })).toBe(true);
  });

  it("the mock returns a deterministic answer", async () => {
    const agent = buildAgent("deterministic");
    const a = await agent.generate("q", { toolsets: {} });
    const b = await agent.generate("q", { toolsets: {} });
    expect(a.text).toBe(b.text);
    expect(a.text).toBe("deterministic");
  });

  it("an agent with NO memory storage fails — proving the guard has teeth", async () => {
    // This is the exact shape that shipped broken. It must throw, otherwise
    // the assertion in the first test is not testing anything.
    const broken = new Agent({
      id: "soc-broken",
      name: "soc-broken",
      instructions: "x",
      model: createMockModel({ mockText: "never reached" }),
      // @ts-expect-error deliberately omitting the required storage
      memory: new Memory({ options: {} }),
      tools: { listCampaignsTool },
    });

    await expect(broken.generate("hello", { toolsets: {} })).rejects.toThrow(
      /storage provider/i,
    );
  });
});
