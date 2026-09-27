/**
 * ask_soc_agent over a real MCP connection.
 *
 * This tool was broken and nothing caught it. The agent declared `new
 * Memory({ options })` with no storage, which does not fail at construction --
 * it throws on the FIRST call, so every question returned "Memory requires a
 * storage provider to function". The wire test only listed the tool, never
 * invoked it.
 *
 * Needs a real Gemini key in .env, so it is NOT part of test:all (which must
 * run with no key and no cost). Run it deliberately:
 *
 *   npx tsx scripts/test-ask-soc-agent.ts
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error(
    "ask_soc-agent test needs a Gemini key in .env (GOOGLE_GENERATIVE_AI_API_KEY).\n" +
      "It is excluded from test:all for that reason. Skipping.",
  );
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "ask-agent-"));
// Seed a store with one campaign so the answer has something to ground in.
const dbUrl = `file:${join(work, "ask.db")}`;

const seed = join(REPO_ROOT, ".ask-seed.ts");
writeFileSync(
  seed,
  `import { correlate, initStore, closeStore } from "./src/mastra/store";
const at = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const base = {
  sourceIp: "203.0.113.77", sourcePort: 40000, service: "ssh" as const,
  usernameTried: "root", passwordTried: "toor", sessionDurationMs: 100, raw: {},
  classification: "credential_stuffing" as const, severity: 5, reasoning: "default creds",
};
await initStore();
// correlate() takes ONE event per call, not a batch.
await correlate({ ...base, id: "ask-evt-1", timestamp: at(5), commandsAttempted: ["uname -a"] });
const c = await correlate({ ...base, id: "ask-evt-2", timestamp: at(4), commandsAttempted: ["id"] });
console.log("SEEDED:" + c.id);
closeStore();`,
);
const seeded = spawnSync("npx", ["tsx", ".ask-seed.ts"], {
  cwd: REPO_ROOT,
  env: { ...process.env, TURSO_DATABASE_URL: dbUrl } as Record<string, string>,
  encoding: "utf8",
});
const seedId = seeded.stdout.split("\n").find((l) => l.startsWith("SEEDED:"))?.slice(7);
rmSync(seed, { force: true });
check("store seeded for the question", Boolean(seedId), seedId ?? seeded.stderr.slice(0, 120));

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mastra/mcp-server.ts"],
  cwd: REPO_ROOT,
  // Explicit env: without it the child gets a stripped environment and the
  // model reports a missing API key even though the parent has one.
  env: { ...process.env, TURSO_DATABASE_URL: dbUrl } as Record<string, string>,
  stderr: "ignore",
});
const client = new Client({ name: "ask-test", version: "1.0.0" });
await client.connect(transport);
check("server connected", true);

const res = (await client.callTool({
  name: "ask_soc_agent",
  // The parameter is `message`, not `question` — verified against the schema.
  arguments: {
    message: "What is the highest severity campaign, and which source IP is it from?",
  },
})) as { isError?: boolean; content?: Array<{ text?: string }> };

const answer = (res.content ?? []).map((c) => c.text ?? "").join("\n");

// The specific regression: Memory with no storage threw here, and the tool
// reported isError with "Memory requires a storage provider".
check("ask_soc_agent does not error", res.isError !== true,
  res.isError ? answer.slice(0, 140) : "");
check("memory storage is configured", !/storage provider/i.test(answer),
  /storage provider/i.test(answer) ? "agent threw on Memory" : "");
check("returns a non-empty answer", answer.length > 40, `${answer.length} chars`);
check("answer is grounded in the seeded data", answer.includes("203.0.113.77"),
  answer.includes("203.0.113.77") ? "cites the real source IP" : answer.slice(0, 160));

console.log(`\n--- answer ---\n${answer.slice(0, 500)}\n`);

await client.close();
rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "ASK SOC AGENT TEST: PASS" : `ASK SOC AGENT TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
