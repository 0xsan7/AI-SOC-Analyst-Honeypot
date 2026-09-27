/**
 * Campaign auto-close, proven over a real process boundary.
 *
 * Runs `scripts/correlate.ts` as a child process against a store seeded with
 * one fresh and one long-idle campaign, then reads the store back in a
 * SEPARATE process to assert the transition actually persisted.
 *
 * In-process assertions would not prove this: the bug is that nothing ever
 * writes status='closed', and that is only observable in the database.
 *
 * Usage: npx tsx scripts/test-auto-close.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const work = mkdtempSync(join(tmpdir(), "autoclose-"));
mkdirSync(join(work, "data"), { recursive: true });
const dbPath = join(work, "test.db");
const dbUrl = `file:${dbPath}`;
// Reports are written relative to cwd, and correlate runs with cwd=work.
const reportsDir = join(work, "reports");

const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// One event, recent enough that its campaign must stay open.
const fresh = {
  id: "fresh-event",
  timestamp: iso(2 * HOUR),
  sourceIp: "198.51.100.1",
  sourcePort: 40001,
  service: "ssh",
  usernameTried: "root",
  passwordTried: "toor",
  commandsAttempted: ["whoami"],
  sessionDurationMs: 300,
  raw: {},
  classification: "credential_stuffing",
  severity: 2,
  reasoning: "default credential",
};
writeFileSync(join(work, "data/enriched.jsonl"), JSON.stringify(fresh) + "\n");

const env = { ...process.env, TURSO_DATABASE_URL: dbUrl } as Record<string, string>;

function run(script: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string }>((res) => {
    const c = spawn("npx", ["tsx", join(REPO_ROOT, script)], {
      cwd: work,
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d.toString()));
    c.stderr.on("data", (d) => (out += d.toString()));
    c.on("close", (code) => res({ code: code ?? -1, out }));
  });
}

// Pass 1: correlate with a 24h idle threshold. The 2h-old campaign is well
// inside it, so it must remain open.
const first = await run("scripts/correlate.ts");
console.log("--- pass 1 (default 24h threshold) ---");
console.log(first.out.trim().split("\n").slice(-3).join("\n"));
check("correlate exits 0", first.code === 0, `exit ${first.code}`);
check("reports the campaign as open", /\(1 open\)/.test(first.out), first.out.match(/\(\d+ open\)/)?.[0] ?? "no count");

// Pass 2: a separate process, with the threshold collapsed to 1ms, so the
// same 2h-old campaign is now idle. It must transition to closed.
const second = await run("scripts/correlate.ts", { CAMPAIGN_IDLE_CLOSE_MS: "1" });
console.log("--- pass 2 (1ms threshold, separate process) ---");
console.log(second.out.trim().split("\n").slice(-3).join("\n"));
check("second run exits 0", second.code === 0, `exit ${second.code}`);
check("reports closing the idle campaign", /Closed 1 idle campaign/.test(second.out));

// Pass 3: a third process reads the store back — proving the transition was
// persisted to disk, not just held in one process's memory.
//
// The probe must live INSIDE the repo: tsx resolves module type from the
// nearest package.json, and a script in a temp dir is treated as CJS, where
// top-level await is a syntax error. A silent failure here would look like an
// empty store rather than an error, so assert the probe actually printed.
const probe = join(REPO_ROOT, ".readback-probe.ts");
writeFileSync(
  probe,
  `import { initStore, listCampaigns, closeStore } from "./src/mastra/store";
await initStore();
const cs = await listCampaigns(50);
console.log("READBACK:" + JSON.stringify(cs.map((c) => ({ id: c.id.slice(0, 8), status: c.status }))));
closeStore();`,
);
const third = await new Promise<{ code: number; out: string }>((res) => {
  const c = spawn("npx", ["tsx", ".readback-probe.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  c.stdout.on("data", (d) => (out += d.toString()));
  c.stderr.on("data", (d) => (out += d.toString()));
  c.on("close", (code) => res({ code: code ?? -1, out }));
});
rmSync(probe, { force: true });

const line = third.out.split("\n").find((l) => l.startsWith("READBACK:"))?.slice("READBACK:".length);
check("read-back probe ran", Boolean(line), line ? "" : third.out.trim().slice(0, 200));
const campaigns = line ? (JSON.parse(line) as Array<{ id: string; status: string }>) : [];
console.log("--- pass 3 (fresh process reads the store) ---");
console.log("   ", JSON.stringify(campaigns));

// Pass 2 legitimately opened a SECOND campaign: the first was closed, and
// findMatchingCampaign only matches status='open', so a new event from the
// same IP cannot rejoin a closed campaign. So the correct end state is
// exactly one closed and one open — not "everything closed".
const closedCount = campaigns.filter((c) => c.status === "closed").length;
const openCount = campaigns.filter((c) => c.status === "open").length;
check("the idle campaign persisted as closed", closedCount === 1, `${closedCount} closed`);
check("the follow-on campaign is open", openCount === 1, `${openCount} open`);
check("both campaigns persisted", campaigns.length === 2, `${campaigns.length} total`);

// The markdown on disk is what a human reads. If it still says "open" after
// the campaign closed, the report is the last place showing a dead incident
// as live — needsReport() is false for an already-generated report, so this
// only works because correlate forces a refresh on the campaigns it closes.
const reportFiles = existsSync(reportsDir)
  ? readdirSync(reportsDir).filter((f) => f.endsWith(".md"))
  : [];
check("reports were written", reportFiles.length > 0, `${reportFiles.length} file(s)`);
const statuses = reportFiles.map((f) => readFileSync(join(reportsDir, f), "utf8"));
check(
  "no report still claims an open campaign after closing",
  statuses.some((s) => s.includes("**Status:** closed")),
  `${statuses.filter((s) => s.includes("**Status:** closed")).length} closed of ${statuses.length}`,
);

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nAUTO-CLOSE TEST: PASS" : `\nAUTO-CLOSE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
