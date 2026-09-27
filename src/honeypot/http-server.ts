/**
 * Low-interaction HTTP honeypot.
 *
 * SECURITY (PRD section 10): this process NEVER acts on an attacker's input.
 * There is no child_process, no shell, no exec, no eval, and no filesystem or
 * network path driven by request data anywhere in this file. Requests are
 * recorded as strings and answered from a static table. The guarantee is
 * enforced by construction and does not depend on any runtime judgement.
 *
 * What it is for: automated internet-wide scanning overwhelmingly targets
 * HTTP, so an SSH-only honeypot misses most of the background traffic. The
 * interesting signal is a scanner probing for admin panels, config files,
 * traversal, or known-vulnerable paths -- that is what gets recorded and
 * classified.
 *
 * Binds to loopback by default. Set HTTP_HONEYPOT_BIND=0.0.0.0 to expose it.
 *
 * Run: npm run honeypot:http
 */
import { randomUUID } from "node:crypto";
import { appendEvent } from "./event-log";
import { ConnectionLimiter } from "./connection-limiter";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttackEvent } from "../mastra/schemas";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH =
  process.env.HONEYPOT_LOG ?? resolve(HERE, "../../data/events.jsonl");

/** Static replies. Keyed by first path segment; nothing here shells out. */
const TYPES_HINT = "text/html; charset=utf-8";

const PAGES: Record<string, { status: number; type: string; body: string }> = {
  "": {
    status: 200,
    type: "text/html",
    body:
      "<!doctype html><html><head><title>Ubuntu 22.04.3 LTS</title></head>" +
      "<body><h1>Welcome to nginx!</h1><p>If you see this page, the web server is working.</p></body></html>",
  },
  admin: {
    status: 401,
    type: "text/html",
    body:
      "<!doctype html><html><head><title>401 Authorization Required</title></head>" +
      "<body><h1>401 Authorization Required</h1></body></html>",
  },
  phpmyadmin: {
    status: 302,
    type: "text/html",
    body: "",
  },
  ".env": { status: 200, type: "text/plain", body: "APP_KEY=\nDB_PASSWORD=\n" },
  ".git/config": {
    status: 200,
    type: "text/plain",
    body: "[core]\n\trepositoryformatversion = 0\n",
  },
  "wp-login.php": {
    status: 200,
    type: "text/html",
    body:
      "<!doctype html><html><head><title>Log In</title></head><body>" +
      "<form method='post' action='/wp-login.php'><input name='log'><input name='pwd' type='password'></form></body></html>",
  },
};

/** Paths that mean a human or a targeted tool, not a blind scanner. */
const INTERESTING = [
  "admin", "phpmyadmin", "wp-login", ".env", ".git", "config", "shell",
  "backdoor", "cgi-bin", "passwd", "shadow", "id_rsa", "credentials",
  "api", "login", "actuator", "console", "manager", "dashboard", "setup",
  "install", "test", "debug", "info", "server-status", "wp-content",
];

function classifyPath(path: string): {
  suspicious: boolean;
  probes: string[];
} {
  const lower = path.toLowerCase();
  const probes = INTERESTING.filter((p) => lower.includes(p));
  return { suspicious: probes.length > 0, probes };
}

function replyFor(path: string) {
  const first = path.replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
  return (
    PAGES[first] ?? {
      status: 404,
      type: "text/html",
      body: "<!doctype html><html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>",
    }
  );
}

export function startHttpHoneypot() {
  const port = Number(process.env.HTTP_HONEYPOT_PORT ?? 8080);
  const bind = process.env.HTTP_HONEYPOT_BIND ?? "127.0.0.1";
  const started = Date.now();

  const record = (req: IncomingMessage, status: number, probes: string[]) => {
    const url = req.url ?? "/";
    const { suspicious } = classifyPath(url);
    const event: AttackEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sourceIp: normalizeIp(req.socket.remoteAddress),
      sourcePort: req.socket.remotePort ?? 0,
      service: "http",
      // HTTP has no credentials, but a scanner often sends them anyway --
      // Basic auth and form logins are the most common probe.
      usernameTried: decodeBasicUser(req.headers.authorization),
      passwordTried: undefined,
      commandsAttempted: [req.method ?? "GET", url],
      sessionDurationMs: Date.now() - started,
      raw: {
        method: req.method,
        url,
        status,
        probes,
        headers: {
          "user-agent": req.headers["user-agent"],
          referer: req.headers.referer,
        },
      },
    };
    // Rotating append — see src/honeypot/event-log.ts. Never throws.
    appendEvent(LOG_PATH, event);
    // Quiet by default: internet background traffic is high-volume.
    if (suspicious || process.env.HONEYPOT_VERBOSE) {
      console.log(
        `[honeypot:http] ${event.sourceIp} ${req.method} ${url} -> ${status}` +
          (probes.length ? ` (${probes.join(",")})` : ""),
      );
    }
  };

  const limiter = new ConnectionLimiter();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const ip = normalizeIp(req.socket.remoteAddress);
    const { probes } = classifyPath(url);
    const { status, type, body } = replyFor(url);

    // Cap concurrency so a flood cannot exhaust the box. Refuse the new
    // request rather than dropping an established one.
    if (!limiter.acquire(ip)) {
      res.writeHead(503, { "content-type": TYPES_HINT }).end();
      return;
    }

    // A redirect target for the phpmyadmin probe, so a scanner following
    // redirects lands back here rather than leaving the honeypot.
    if (status === 302) {
      res.writeHead(302, { location: "/phpmyadmin/" }).end();
    } else {
      res.writeHead(status, { "content-type": type }).end(body);
    }

    // Record after responding so a slow client cannot delay the reply, and
    // release the slot when the response is done.
    res.on("finish", () => {
      limiter.release(ip);
      setImmediate(() => record(req, status, probes));
    });
  });

  // A honeypot faces malformed traffic constantly. A bad request must not
  // take down capture for every other scanner.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(port, bind, () => {
    console.log(
      `[honeypot:http] listening on ${bind}:${port} (logs -> ${LOG_PATH})`,
    );
  });

  process.on("uncaughtException", (err) => {
    console.error(`[honeypot:http] uncaught (ignored): ${err.message}`);
  });

  return server;
}

/** "Basic dXNlcjpwYXNz" -> "user" (never logs the password). */
function decodeBasicUser(header?: string): string | undefined {
  if (!header?.toLowerCase().startsWith("basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const user = decoded.split(":")[0];
    return user || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Node reports IPv4 clients on a dual-stack listener as IPv4-mapped IPv6
 * ("::ffff:203.0.113.5"). Left as-is, every IPv4 source IP fails geo/ASN
 * lookup downstream and correlates as an unrelated "unknown" campaign.
 * Unwrap to the plain IPv4 address.
 */
function normalizeIp(addr: string | undefined): string {
  if (!addr) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return mapped?.[1] ?? addr;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHttpHoneypot();
}
