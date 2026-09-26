/**
 * The SOC analyst agent (G3). Memory-backed, and exposed over MCP as
 * `ask_soc_agent` (FR7). It answers strictly from stored campaign data via
 * tools, so answers stay grounded in real observations.
 */
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCampaign, getCampaignEvents, listCampaigns } from "../store";

export const SOC_MODEL = "google/gemini-3.5-flash";

export const listCampaignsTool = createTool({
  id: "get_recent_campaigns",
  description:
    "List recent attack campaigns, newest first, with severity and event counts.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.object({
    campaigns: z.array(
      z.object({
        id: z.string(),
        firstSeen: z.string(),
        lastSeen: z.string(),
        sourceIps: z.array(z.string()),
        eventCount: z.number(),
        maxSeverity: z.number(),
        status: z.string(),
      }),
    ),
  }),
  execute: async ({ limit }) => {
    const campaigns = await listCampaigns(limit);
    return {
      campaigns: campaigns.map((c) => ({
        id: c.id,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        sourceIps: c.sourceIps,
        eventCount: c.eventIds.length,
        maxSeverity: c.maxSeverity,
        status: c.status,
      })),
    };
  },
});

export const getCampaignDetailTool = createTool({
  id: "get_campaign_detail",
  description: "Get one campaign plus every enriched event that belongs to it.",
  inputSchema: z.object({ campaignId: z.string() }),
  outputSchema: z.object({
    found: z.boolean(),
    campaign: z
      .object({
        id: z.string(),
        firstSeen: z.string(),
        lastSeen: z.string(),
        sourceIps: z.array(z.string()),
        maxSeverity: z.number(),
        status: z.string(),
      })
      .optional(),
    events: z
      .array(
        z.object({
          timestamp: z.string(),
          sourceIp: z.string(),
          usernameTried: z.string().nullable().optional(),
          passwordTried: z.string().nullable().optional(),
          commandsAttempted: z.array(z.string()).optional(),
          classification: z.string(),
          severity: z.number(),
          reasoning: z.string(),
          geo: z.record(z.string(), z.string()).optional(),
        }),
      )
      .optional(),
  }),
  execute: async ({ campaignId }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) return { found: false };
    const events = await getCampaignEvents(campaign.id);
    return {
      found: true,
      campaign: {
        id: campaign.id,
        firstSeen: campaign.firstSeen,
        lastSeen: campaign.lastSeen,
        sourceIps: campaign.sourceIps,
        maxSeverity: campaign.maxSeverity,
        status: campaign.status,
      },
      events: events.map((e) => ({
        timestamp: e.timestamp,
        sourceIp: e.sourceIp,
        usernameTried: e.usernameTried ?? null,
        passwordTried: e.passwordTried ?? null,
        commandsAttempted: e.commandsAttempted ?? [],
        classification: e.classification,
        severity: e.severity,
        reasoning: e.reasoning,
        geo: e.geo as Record<string, string> | undefined,
      })),
    };
  },
});

export const socAgent = new Agent({
  id: "soc-analyst-agent",
  name: "SOC Analyst",
  description:
    "Answers questions about honeypot campaigns, attackers, and observed activity, grounded in stored triage data.",
  instructions: `You are a SOC analyst assistant for a defensive honeypot.

Answer only from the tools available to you — never invent campaign IDs, IPs, or
statistics. If the tools return nothing, say plainly that no data was found.

When asked about an incident:
- State the campaign's source IPs, severity, and event count.
- Name the credentials and commands actually attempted.
- Explain what the activity means in plain language for a non-specialist.
- If severity is 4 or 5, say the campaign crossed the escalation threshold.

Be concise and factual. Do not speculate about attacker identity or intent beyond
what the recorded commands support.`,
  model: SOC_MODEL,
  memory: new Memory({
    options: {
      // Terse titles; the model otherwise spends reasoning tokens on them.
      generateTitle: true,
    },
  }),
  tools: { listCampaignsTool, getCampaignDetailTool },
});
