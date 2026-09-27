/**
 * Concurrency, proven against a live honeypot.
 *
 * A public SSH port is scanned by many hosts at once, so simultaneous
 * connections are the normal case, not the edge case. In-process store tests
 * cannot cover it: the real risk is many sockets against one listener, one
 * event-write path, and per-connection cleanup.
 *
 * The bar: every concurrent session must produce exactly one event with a
 * unique id, the listener must survive, and no payload may execute.
 *
 * Usage: npx tsx scripts/test-concurrency.ts
 */
import { Client } from "ssh2";
import { existsSync, readFileSync } from "node:fs";

const HOST = process.env.HONEYPOT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.HONEYPOT_PORT ?? 2222);
const LOG = process.env.HONEYPOT_LOG ?? "data/events.jsonl";
const N = Number(process.env.CONCURRENCY ?? 12);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const countLines = () =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).length : 0;

function execMode(user: string, pass: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => { out += d.toString(); });
      stream.on("close", () => { c.end(); resolve(out); });
    }));
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: user, password: pass, readyTimeout: 10000 });
  });
}

const before = countLines();
console.log(`--- ${N} simultaneous SSH sessions ---\n`);

// Fire them all at once. Distinct users so the events are individually
// identifiable if something interleaves badly.
const results = await Promise.allSettled(
  Array.from({ length: N }, (_, i) => execMode(`user${i}`, `pass${i}`, "uname -a")),
);

const ok = results.filter((r) => r.status === "fulfilled");
const failed = results.filter((r) => r.status === "rejected");
check("every concurrent session completed", failed.length === 0,
  `${ok.length}/${N} ok, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("   first failure:", String((failed[0] as PromiseRejectedResult).reason).slice(0, 120));
}
check("each session got fake shell output",
  ok.length > 0 && ok.every((r) => /Linux/i.test(String((r as PromiseFulfilledResult<string>).value))));

// The honeypot writes on session close, and closes trail the disconnects.
async function waitFor(minimum: number, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let n = before;
  while (Date.now() < deadline) {
    n = countLines();
    if (n - before >= minimum) return n;
    await new Promise((r) => setTimeout(r, 150));
  }
  return n;
}
const after = await waitFor(N);
check(`all ${N} sessions were recorded`, after - before >= N, `${after - before} event(s)`);

const lines = readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).slice(before);
const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const valid = parsed.filter(Boolean);
const ids = valid.map((e: { id: string }) => e.id);

check("every recorded line is valid JSON", valid.length === parsed.length,
  `${valid.length}/${parsed.length}`);
check("event ids are unique — no duplicates from interleaved sessions",
  new Set(ids).size === ids.length, `${new Set(ids).size} unique of ${ids.length}`);
check("the concurrent users were all captured",
  Array.from({ length: N }, (_, i) => `user${i}`).every((u) =>
    valid.some((e: { usernameTried: string }) => e.usernameTried === u)));

// The listener must still be healthy afterwards.
const after2 = await execMode("post-check", "post-check", "whoami");
check("honeypot still accepts connections afterwards", /root/i.test(after2) || after2.length > 0);

check("no payload executed under concurrency", !existsSync("/tmp/soc-verify-pwned"));

console.log(`\nCONCURRENCY TEST: ${failures === 0 ? "PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
