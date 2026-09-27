/**
 * Over-the-wire MCP test (G5 / FR7).
 *
 * Spawns `src/mastra/mcp-server.ts` as a REAL child process and talks to it
 * over stdio with the official MCP client SDK — the 1.x line that Claude
 * Desktop, Cursor and VS Code actually ship. This is the only kind of test
 * that proves FR7: the original in-process test called the tool handlers
 * directly, so it passed even while no MCP client could complete a
 * handshake.
 *
 * The store is isolated to a temp LibSQL file, pre-seeded with a known
 * campaign, so assertions are on real content rather than an empty result.
 *
 * Usage: npx tsx scripts/test-mcp-wire.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_TOOLS = [
  "get_recent_campaigns",
  "get_campaign_detail",
  "ask_soc_agent",
];

/** A campaign we seed the isolated store with, so results are assertable. */
const SEED = {
  id: "wire-test-campaign",
  sourceIps: ["203.0.113.9"],
  eventIds: ["wire-test-event"],
  firstSeen: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastSeen: new Date().toISOString(),
  maxSeverity: 5,
  status: "open" as const,
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Isolate the store so the test never touches the real soc-analyst.db.
const dbDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
const dbPath = join(dbDir, "test.db");
const dbUrl = `file:${dbPath}`;

// Seed the isolated store before the server reads it. initStore() resolves the
// DB from the environment, so set it before the module is imported.
process.env.TURSO_DATABASE_URL = dbUrl;
const { initStore, upsertCampaign, closeStore } = await import("../src/mastra/store");
await initStore();
await upsertCampaign(SEED);
closeStore();

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mastra/mcp-server.ts"],
  // The transport spawns from process.cwd(); anchor it to the repo root so the
  // script behaves the same however it is invoked.
  cwd: REPO_ROOT,
  env: { ...process.env, TURSO_DATABASE_URL: dbUrl } as Record<string, string>,
  stderr: "pipe",
});

// Surface the child's stderr — a silent crash is the usual cause of
// "Connection closed".
transport.stderr?.on("data", (d: Buffer) => {
  const s = d.toString().trim();
  if (s) console.error(`[server stderr] ${s}`);
});

const client = new Client({ name: "soc-analyst-wire-test", version: "1.0.0" });

try {
  // 1. Handshake — this is what failed before the version fix.
  await client.connect(transport);
  check("handshake completes", true);

  // 2. List tools and assert the exact public names FR7 requires.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`      tools: ${names.join(", ")}`);
  for (const required of REQUIRED_TOOLS) {
    check(`exposes ${required}`, names.includes(required));
  }

  // 3. Call over the wire and assert on REAL content, not just non-emptiness.
  const result = await client.callTool({
    name: "get_recent_campaigns",
    arguments: {},
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";

  let parsed: { campaigns?: Array<{ id?: string; sourceIps?: string[] }> } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave parsed empty; the checks below will fail */
  }
  const campaigns = parsed.campaigns ?? [];

  check(
    "get_recent_campaigns returns campaigns",
    campaigns.length > 0,
    `${campaigns.length} campaign(s), ${text.length} chars`,
  );
  check("returns the seeded campaign", campaigns.some((c) => c.id === SEED.id));
  check(
    "campaign carries its source IP",
    campaigns.some((c) => c.sourceIps?.includes(SEED.sourceIps[0])),
  );

  // 4. Fetch one campaign by id over the wire. The tool's input schema names
  // the parameter `campaignId`.
  const detail = await client.callTool({
    name: "get_campaign_detail",
    arguments: { campaignId: SEED.id },
  });
  const detailText = (detail.content as Array<{ text?: string }>)[0]?.text ?? "";
  // A tool that returns an error string still "succeeds" at the protocol
  // level, so assert the payload is not an error and names the campaign.
  check(
    "get_campaign_detail is not an error",
    !detailText.startsWith("Tool validation failed"),
    detailText.slice(0, 80).replace(/\n/g, " "),
  );
  check("get_campaign_detail returns the campaign", detailText.includes(SEED.id));
  console.log(`      detail: ${detailText.slice(0, 160).replace(/\n/g, " ")}`);

  await client.close();
} catch (err) {
  check("handshake completes", false, (err as Error).message);
} finally {
  rmSync(dbDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nMCP WIRE TEST: PASS" : `\nMCP WIRE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
