/**
 * Proves the pipeline reports failure honestly (the bug where it printed a
 * wall of errors, wrote zero enriched events, and exited 0).
 *
 * Runs the real pipeline in a child process with the API key removed from the
 * environment, then asserts on the exit code and the guidance it prints.
 *
 * Usage: npx tsx scripts/test-pipeline-failure.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const work = mkdtempSync(join(tmpdir(), "pipeline-fail-"));
mkdirSync(join(work, "data"), { recursive: true });
// One synthetic honeypot event so the pipeline has work to attempt.
writeFileSync(
  join(work, "data/events.jsonl"),
  JSON.stringify({
    id: "evt-test-1",
    timestamp: new Date().toISOString(),
    sourceIp: "198.51.100.5",
    sourcePort: 51000,
    service: "ssh",
    usernameTried: "root",
    passwordTried: "toor",
    commandsAttempted: ["whoami"],
    sessionDurationMs: 400,
    raw: {},
  }) + "\n",
);

// Strip the key so the provider cannot authenticate.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k !== "GOOGLE_GENERATIVE_AI_API_KEY" && k !== "GOOGLE_API_KEY") env[k] = v;
}
// Force .env to be ignored so the developer's real key cannot leak in.
env.DOTENV_CONFIG_PATH = join(work, "nonexistent.env");

const child = spawn("npx", ["tsx", join(REPO_ROOT, "scripts/run-pipeline.ts")], {
  // Run the real script from the repo, but with the working directory pointed
  // at the temp fixture so it reads our event file and writes its output there.
  cwd: work,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (out += d.toString()));

const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));

const enrichedPath = join(work, "data/enriched.jsonl");
const enriched = existsSync(enrichedPath)
  ? readFileSync(enrichedPath, "utf8").trim()
  : "";

console.log("--- pipeline output ---");
console.log(out.trim().split("\n").slice(-8).join("\n"));
console.log("--- exit code:", code, "---\n");

check("exits non-zero when nothing is enriched", code !== 0, `exit ${code}`);
check("writes no enriched events", enriched === "");
check("says it failed", /PIPELINE FAILED/i.test(out));
check(
  "prints actionable guidance",
  /aistudio\.google\.com\/apikey|npm run seed/i.test(out),
);

rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? "\nPIPELINE FAILURE TEST: PASS" : `\nPIPELINE FAILURE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
