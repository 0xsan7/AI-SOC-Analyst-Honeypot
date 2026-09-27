/**
 * HTTP honeypot, proven over a real socket.
 *
 * Spawns src/honeypot/http-server.ts as a child process, hits it with real
 * requests, then asserts on the events it actually wrote. Same standard as
 * the SSH and MCP tests: an in-process call would not prove the listener
 * records, serves, or survives hostile input.
 *
 * Usage: npx tsx scripts/test-http-honeypot.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const work = mkdtempSync(join(tmpdir(), "http-hp-"));
const log = join(work, "events.jsonl");
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

const child: ChildProcess = spawn(
  "npx",
  ["tsx", join(REPO_ROOT, "src/honeypot/http-server.ts")],
  {
    cwd: work,
    env: {
      ...process.env,
      HTTP_HONEYPOT_PORT: String(PORT),
      HTTP_HONEYPOT_BIND: "127.0.0.1",
      HONEYPOT_LOG: log,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let stderr = "";
let stdout = "";
child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));

// Never leave the child holding the port: an orphaned honeypot makes the next
// run test the WRONG process (see assertPortFree below).
//
// `npx` spawns a grandchild node process, so killing the child alone leaves
// the real server listening. detached puts the child in its own process group,
// and a negative pid signals the whole group.
const cleanup = () => {
  try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { /* group already gone */ }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* already gone */ }
};
process.on("exit", cleanup);
process.on("uncaughtException", (e) => { console.error(e); cleanup(); process.exit(1); });

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.status) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Fail loudly if something else already owns the port.
 *
 * Without this the test silently tests the WRONG PROCESS: a stale honeypot
 * from an earlier run keeps the port, the spawned child fails to bind, and
 * every assertion below passes against a server this test does not control --
 * with no log file written. That is worse than a failure, because it looks
 * like a pass.
 */
async function assertPortFree(): Promise<boolean> {
  try {
    await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
    return false; // something answered
  } catch {
    return true; // connection refused: the port is ours to take
  }
}

const portWasFree = await assertPortFree();
check("test port is free before starting", portWasFree,
  portWasFree ? "" : `something is already listening on ${PORT} — kill it (lsof -ti:${PORT} | xargs kill) and re-run`);
if (!portWasFree) {
  cleanup();
  process.exit(1);
}
const up = await waitForServer();
check("http honeypot started", up, up ? "" : stderr.slice(0, 200));
// Confirm it is OUR process answering, not something inherited on the port.
check("the honeypot we spawned is the one serving", stdout.includes("listening"),
  stdout.includes("listening") ? "" : `child stdout: ${stdout.slice(0, 200) || "(empty)"}`);
if (!up) {
  cleanup();
  process.exit(1);
}

// --- 1. Serves a plausible decoy site, and the wrong status for probes -----
const root = await fetch(`${BASE}/`);
check("root serves a decoy nginx page", root.status === 200 && (await root.text()).includes("nginx"));

const admin = await fetch(`${BASE}/admin`);
check("/admin returns 401 like a real admin panel", admin.status === 401);

const env = await fetch(`${BASE}/.env`);
check("/.env returns decoy credentials", env.status === 200 && (await env.text()).includes("APP_KEY"));

const missing = await fetch(`${BASE}/totally-unknown-path`);
check("unknown path returns 404", missing.status === 404);

// --- 2. Redirect stays inside the honeypot -------------------------------
const redir = await fetch(`${BASE}/phpmyadmin`, { redirect: "manual" });
check("/phpmyadmin redirects within the honeypot", redir.status === 302 &&
  (redir.headers.get("location") ?? "").startsWith("/"));

// --- 3. Captures credentials sent in the Authorization header -------------
const auth = await fetch(`${BASE}/admin`, {
  headers: { authorization: `Basic ${Buffer.from("root:hunter2").toString("base64")}` },
});
check("basic-auth attempt still answered", auth.status === 401);

// --- 4. Hostile input must not crash it -----------------------------------
const attacks: Array<[string, string]> = [
  ["path traversal", `${BASE}/../../../../etc/passwd`],
  ["null byte", `${BASE}/admin%00.txt`],
  ["very long path", `${BASE}/${"a".repeat(4000)}`],
  ["sql-ish", `${BASE}/?id=1'%20OR%201=1--`],
  ["unicode path", `${BASE}/%E4%B8%AD%E6%96%87/admin`],
  ["encoded traversal", `${BASE}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`],
];
for (const [label, url] of attacks) {
  try {
    const r = await fetch(url);
    check(`survives ${label}`, r.status > 0, `status ${r.status}`);
  } catch (err) {
    check(`survives ${label}`, false, (err as Error).message.slice(0, 60));
  }
}

// Raw malformed HTTP that fetch will not send.
await new Promise<void>((res) => {
  const sock = connect(PORT, "127.0.0.1", () => {
    sock.write("GARBAGE NOT HTTP AT ALL\r\n\r\n");
  });
  sock.on("data", () => {});
  sock.on("error", () => res());
  sock.on("close", () => res());
  setTimeout(() => { sock.destroy(); res(); }, 2000);
});
check("survives a non-HTTP payload on the socket", true);

// --- 5. The listener is still healthy -------------------------------------
const after = await fetch(`${BASE}/`);
check("still serving after every hostile request", after.status === 200);

// --- 6. Events were actually written, with useful fields ------------------
await new Promise((r) => setTimeout(r, 800));
check("events were written", existsSync(log),
  existsSync(log) ? `${readFileSync(log, "utf8").split("\n").filter((l) => l.trim()).length} event(s)` : `no log file at ${log}\n   child said: ${stdout.slice(0, 300)}`);

if (existsSync(log)) {
  const events = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  console.log(`   ${events.length} event(s) recorded`);

  const ids = events.map((e) => e.id);
  check("every event has a unique id", new Set(ids).size === ids.length,
    `${new Set(ids).size} unique of ${ids.length}`);
  check("every event is service=http", events.every((e) => e.service === "http"));
  check("every event has a source IP", events.every((e) => typeof e.sourceIp === "string" && e.sourceIp.length > 0));
  // IPv4 arrives as ::ffff:a.b.c.d; left mapped, every geo/ASN lookup and
  // campaign correlation for IPv4 clients would silently degrade.
  check("IPv4 clients are recorded as plain IPv4, not ::ffff: mapped",
    events.every((e) => !String(e.sourceIp).startsWith("::ffff:")) &&
    events.some((e) => e.sourceIp === "127.0.0.1"),
    [...new Set(events.map((e) => e.sourceIp))].join(","));
  check("the .env probe was recorded with its path",
    events.some((e) => e.commandsAttempted?.some((c: string) => c.includes(".env"))));
  check("the traversal probe was recorded verbatim",
    events.some((e) => e.commandsAttempted?.some((c: string) => c.includes("passwd"))),
    "proving we store what was sent, not a sanitised version");
  check("the basic-auth username was captured",
    events.some((e) => e.usernameTried === "root"));
  check("the password was never logged",
    !readFileSync(log, "utf8").includes("hunter2"));
}

// --- 7. No execution primitive anywhere in the source ---------------------
const src = readFileSync(join(REPO_ROOT, "src/honeypot/http-server.ts"), "utf8");
// Strip comments before scanning, so the header's own wording is not a hit.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
// RegExp.prototype.exec is not command execution -- normalizeIp uses
// /regex/.exec(). Only flag exec as a CALL on a non-regex receiver, and
// require the dangerous child_process imports by name.
const forbidden = [
  /from\s+["']node:child_process["']/,
  /require\(\s*["']child_process["']\s*\)/,
  /\bexecSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\bsubprocess\b/,
];
const hits = forbidden.filter((f) => f.test(code));
check("no execution primitive in the honeypot source", hits.length === 0,
  hits.map(String).join(", "));

cleanup();
console.log(failures === 0 ? "\nHTTP HONEYPOT TEST: PASS" : `\nHTTP HONEYPOT TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
