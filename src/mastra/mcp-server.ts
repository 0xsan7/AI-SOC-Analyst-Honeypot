/**
 * MCP exposure (G5 / FR7). Exposes three tools:
 *   get_recent_campaigns, get_campaign_detail, ask_soc_agent
 *
 * Run: npm run mcp
 */
import { MCPServer } from "@mastra/mcp";
import {
  getCampaignDetailTool,
  listCampaignsTool,
  socAgent,
} from "./agents/soc-agent";
import { initStore } from "./store";

await initStore();

// Mastra's MCP server uses the registry KEY as the exposed tool name (the
// tool's own `id` is ignored), so these keys are the public MCP tool names
// required by FR7.
export const mcpServer = new MCPServer({
  id: 'soc-analyst-mcp',
  name: 'AI SOC Analyst',
  version: '1.0.0',
  description:
    'Query honeypot campaigns, attacker IOCs, and triage verdicts from a defensive SSH honeypot.',
  instructions: `Use get_recent_campaigns to list detected attack campaigns,
get_campaign_detail to inspect one campaign and its events, and
ask_soc_agent for free-text questions answered from stored triage data.`,
  tools: {
    get_recent_campaigns: listCampaignsTool,
    get_campaign_detail: getCampaignDetailTool,
  },
  // Mastra auto-prefixes agent tools with `ask_`, so key this `soc_agent` to
  // land on exactly `ask_soc_agent` rather than `ask_ask_soc_agent`.
  agents: { soc_agent: socAgent },
});

// `node --experimental-strip-types src/mastra/mcp-server.ts`
if (process.argv[1]?.includes("mcp-server")) {
  await mcpServer.startStdio();
}
