/**
 * Low-interaction SSH honeypot.
 *
 * SECURITY (PRD FR2 / section 10): this process NEVER executes an attacker's
 * command. There is no child_process, no shell, no exec anywhere in this file.
 * Every command an attacker types is recorded as a string and answered from the
 * static FAKE_OUTPUT table below. That guarantee is enforced by construction —
 * no code path connects attacker input to a real process, and it does not depend
 * on any LLM, prompt, or runtime judgement.
 *
 * The only local files this reads are the honeypot's own host keys under
 * honeypot/keys, at startup. Attacker-controlled input never reaches them.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendEvent } from "./event-log";
import { ConnectionLimiter } from "./connection-limiter";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import type { AuthContext, ClientInfo, Connection, Session } from "ssh2";
import type { AttackEvent } from "../mastra/schemas";

// ssh2 is CommonJS: named ESM imports throw at runtime, so destructure the default.
const { Server } = ssh2;

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_DIR = resolve(HERE, "../../honeypot/keys");
const LOG_PATH =
  process.env.HONEYPOT_LOG ?? resolve(HERE, "../../data/events.jsonl");

/** Static canned replies. Nothing here shells out. */
const BANNER =
  "Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-generic x86_64)";
const FAKE_OUTPUT: Record<string, string> = {
  ls: "Desktop  Documents  Downloads  Music  Pictures  Public  Templates  Videos",
  pwd: "/home/ubuntu",
  whoami: "ubuntu",
  id: "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),27(sudo)",
  uname: "Linux victim 5.15.0-generic #113-Ubuntu SMP x86_64 GNU/Linux",
  cat: "cat: /etc/passwd: Permission denied",
  wget: "wget: missing destination URL",
  curl: "curl: try 'curl --help' for more information",
  sudo: "ubuntu is not in the sudoers file.  This incident will be reported.",
  history: "",
};

function replyFor(cmd: string): string {
  const verb = cmd.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return FAKE_OUTPUT[verb] ?? `-bash: ${verb}: command not found`;
}

function log(event: AttackEvent) {
  // Rotating append: a public listener records an event per connection, and
  // an unbounded log fills the disk on a small VPS -- which takes down the
  // pipeline, the database, and the SSH session used to fix it.
  appendEvent(LOG_PATH, event);
}

export function startHoneypot(
  port = Number(process.env.HONEYPOT_PORT ?? 2222),
) {
  // Default to loopback. Set HONEYPOT_BIND=0.0.0.0 deliberately when deploying
  // to a VPS you own — never expose this to a network you don't control.
  const bind = process.env.HONEYPOT_BIND ?? '127.0.0.1';

  // ssh2 wants key material, not a filesystem path, unless hostHash is set.
  const hostKeys = [
    resolve(KEY_DIR, "host_rsa"),
    resolve(KEY_DIR, "host_ed25519"),
  ].map((p) => readFileSync(p, "utf8"));

  const limiter = new ConnectionLimiter();

  const server = new Server(
    { hostKeys },
    (client: Connection, info: ClientInfo) => {
      const startedAt = Date.now();
      const sourceIp = info.ip;

      // Cap concurrency. Refuse the NEW connection rather than killing a live
      // one: a scanner retries, whereas dropping an established session throws
      // away the capture we actually want.
      if (!limiter.acquire(sourceIp)) {
        console.log(`[honeypot] refusing ${sourceIp} (at capacity)`);
        try { client.end(); } catch { /* already closed */ }
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        limiter.release(sourceIp);
      };
      const commands: string[] = [];
      const sessionId = randomUUID();
      let username: string | null = null;
      let password: string | null = null;
      let closed = false;

      // One event per session, written once on close. Recording on every
      // lifecycle event instead produced N duplicates of the same connection,
      // which the pipeline would miscount as N separate attacks.
      const record = () => {
        if (closed) return;
        closed = true;
        log({
          id: sessionId,
          timestamp: new Date().toISOString(),
          sourceIp,
          sourcePort: info.port,
          service: "ssh",
          usernameTried: username,
          passwordTried: password,
          commandsAttempted: commands,
          sessionDurationMs: Date.now() - startedAt,
          raw: { clientVersion: info.header?.identRaw ?? null },
        });
      };

      // FR1: a connection that never authenticates is still an event — `close`
      // always fires, so the single record() there covers it.
      client.on("error", (err: Error) => {
        console.warn(`[honeypot] ${sourceIp} error: ${err.message}`);
      });

      client.on("authentication", (ctx: AuthContext) => {
        username = ctx.username;

        if (ctx.method === "password") {
          password =
            (ctx as AuthContext & { password?: string }).password ?? null;
          // Accept ANY credential. There is no real account to protect, and
          // accepting is what lets us capture post-auth command traffic — the
          // highest-value signal. FR2 is unaffected: commands are still only
          // recorded and answered from FAKE_OUTPUT, never executed.
          ctx.accept();
          return;
        }

        // "none" and "publickey" must be REJECTED. Accepting "none" makes the
        // client conclude it is already authenticated, so it never sends the
        // password at all — which is how passwordTried ends up null.
        ctx.reject(["password"], false);
      });

      client.on("session", (accept) => {
        const session = accept();

        // Attackers virtually always request a PTY; accept it so we get a shell.
        session.on("pty", (ptyAccept) => ptyAccept());
        session.on("env", (envAccept) => envAccept());
        session.on("window-change", (wcAccept) => wcAccept());

        // The shell channel arrives on its own event. `accept` above is a
        // one-shot function — calling it twice yields undefined.
        const handleShell = (shell: Session) => {
          shell.write(`${BANNER}\nubuntu@victim:~$ `);
          shell.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString("utf8").split("\n")) {
              const cmd = line.replace(/[\r\n]/g, "").trim();
              if (!cmd) continue;
              commands.push(cmd);
              shell.write(`${replyFor(cmd)}\nubuntu@victim:~$ `);
            }
          });
          const finish = () => {
            record();
            // `session` is a Session wrapper with no end(); the shell channel has it.
            try {
              shell.end();
            } catch {
              /* already closed */
            }
            try {
              client.end();
            } catch {
              /* already closed */
            }
          };
          shell.on("end", finish);
          shell.on("close", finish);
        };

        session.on("shell", (shellAccept) => handleShell(shellAccept()));
        // Non-interactive `ssh host "cmd"` — record it, answer statically.
        session.on("exec", (execAccept, _reject, info) => {
          const cmd = info?.command ?? "";
          if (cmd) commands.push(cmd);
          const ch = execAccept();
          ch.write(`${replyFor(cmd)}\n`);
          ch.exit(0);
          ch.end();
        });
      });

      client.on("close", () => {
        record();
        release();
      });
    },
  );

  server.listen(port, bind, () => {
    console.log(
      `[honeypot] listening on ${bind}:${port} (logs -> ${LOG_PATH})`,
    );
  });

  // A honeypot is a public listener: a crash in one connection handler must
  // never take down capture for every other connection.
  process.on("uncaughtException", (err) => {
    console.error(`[honeypot] uncaught (ignored): ${err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[honeypot] unhandled rejection (ignored): ${reason}`);
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHoneypot();
}
