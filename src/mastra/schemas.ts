import { z } from "zod";

/** Raw honeypot observation, before classification. */
export const AttackEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  sourceIp: z.string(),
  sourcePort: z.number().optional(),
  service: z.enum(["ssh", "http"]),
  usernameTried: z.string().nullable().optional(),
  passwordTried: z.string().nullable().optional(),
  commandsAttempted: z.array(z.string()).optional(),
  sessionDurationMs: z.number(),
  raw: z.record(z.string(), z.unknown()),
});
export type AttackEvent = z.infer<typeof AttackEventSchema>;

export const CLASSIFICATIONS = [
  "noise",
  "recon",
  "credential_stuffing",
  "active_exploit_attempt",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** AttackEvent + LLM verdict + threat-intel context. */
export const EnrichedEventSchema = AttackEventSchema.extend({
  classification: z.enum(CLASSIFICATIONS),
  severity: z.number().int().min(1).max(5),
  reasoning: z.string(),
  geo: z
    .object({
      country: z.string().optional(),
      city: z.string().optional(),
      asnOrg: z.string().optional(),
    })
    .optional(),
  reputationScore: z.number().optional(),
  enrichmentWarnings: z.array(z.string()).optional(),
});
export type EnrichedEvent = z.infer<typeof EnrichedEventSchema>;

export const CampaignSchema = z.object({
  id: z.string(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  sourceIps: z.array(z.string()),
  eventIds: z.array(z.string()),
  maxSeverity: z.number().int().min(1).max(5),
  status: z.enum(["open", "closed"]),
  summary: z.string().optional(),
});
export type Campaign = z.infer<typeof CampaignSchema>;
