/**
 * Malformed-input probe for the MCP server (FR7 robustness).
 *
 * A standard client should get a clean tool error for bad input — never a
 * crashed process, never a silent empty success. Spawns the real server and
 * throws hostile arguments at it over stdio.
 *
 * Usage: npx tsx scripts/test-mcp-robustness.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const work = mkdtempSync(join(tmpdir(), "mcp-robust-"));
const env = { ...process.env, TURSO_DATABASE_URL: `file:${join(work, "test.db")}` } as Record<string, string>;

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", join(REPO_ROOT, "src/mastra/mcp-server.ts")],
  cwd: REPO_ROOT,
  env,
  stderr: "ignore",
});
const client = new Client({ name: "robustness-probe", version: "1.0.0" });

await client.connect(transport);
check("server connects", true);

// Each case must produce a well-formed tool response, not a protocol error
// and certainly not a dead process.
async function hostile(label: string, tool: string, args: unknown) {
  try {
    const res = (await client.callTool({ name: tool, arguments: args as Record<string, unknown> })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (res.content ?? []).map((c) => c.text ?? "").join(" ");
    check(
      label,
      typeof res.isError === "boolean" && text.length > 0,
      res.isError ? `clean tool error: ${text.slice(0, 70)}` : text.slice(0, 70),
    );
  } catch (err) {
    check(label, false, `threw: ${(err as Error).message.slice(0, 90)}`);
  }
}

await hostile("unknown campaign id returns a clean error", "get_campaign_detail", {
  campaignId: "does-not-exist",
});
await hostile("empty campaign id is rejected as malformed, not reported missing", "get_campaign_detail", {
  campaignId: "",
});
await hostile("whitespace-only id is rejected", "get_campaign_detail", { campaignId: "   " });
await hostile("non-string campaign id rejected", "get_campaign_detail", { campaignId: 12345 });
await hostile("missing campaignId rejected", "get_campaign_detail", {});
await hostile("sql-ish campaign id does not crash", "get_campaign_detail", {
  campaignId: "'; DROP TABLE campaigns; --",
});
await hostile("limit as a string does not crash", "get_recent_campaigns", { limit: "lots" });
await hostile("negative limit does not crash", "get_recent_campaigns", { limit: -1 });
await hostile("huge limit does not crash", "get_recent_campaigns", { limit: 999999 });

// The server must still be alive and correct after all of that.
const alive = (await client.listTools()) as { tools: Array<{ name: string }> };
check("server survived every hostile call", alive.tools.length === 3, `${alive.tools.length} tools`);

// A brand-new install has no campaigns at all. That is the first thing a
// real user hits, and it must be an empty list -- not an error, and not a
// crash on an undefined field.
const empty = (await client.callTool({ name: "get_recent_campaigns", arguments: {} })) as {
  isError?: boolean;
  content?: Array<{ text?: string }>;
};
const emptyText = (empty.content ?? []).map((c) => c.text ?? "").join("");
check("an empty store returns an empty list, not an error",
  empty.isError !== true && /"campaigns"\s*:\s*\[\]/.test(emptyText),
  emptyText.slice(0, 60));

await client.close();
rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nMCP ROBUSTNESS TEST: PASS" : `\nMCP ROBUSTNESS TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
