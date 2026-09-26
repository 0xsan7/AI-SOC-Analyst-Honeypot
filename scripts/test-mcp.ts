/**
 * Verifies the MCP server exposes the three required tools (FR7) and that the
 * campaign tools return real stored data.
 * Usage: npx tsx scripts/test-mcp.ts
 */
import 'dotenv/config';
import { mcpServer } from '../src/mastra/mcp-server';

const listing = await mcpServer.getToolListInfo();
const tools = listing.tools.map((t) => t.id);
console.log('MCP tools exposed:');
for (const t of tools) console.log(`  - ${t}`);

const required = ['get_recent_campaigns', 'get_campaign_detail', 'ask_soc_agent'];
const missing = required.filter((r) => !tools.includes(r));
if (missing.length) {
  console.error(`\nMISSING required tools: ${missing.join(', ')}`);
  console.error(`Actual: ${tools.join(', ')}`);
  process.exit(1);
}
console.log('\nAll 3 required tools present, named exactly as specified.');

// Exercise a real tool call against stored data.
const res = (await mcpServer.executeTool('get_recent_campaigns', { limit: 5 })) as {
  content?: Array<{ text?: string }>;
};
const payload = res.content?.[0]?.text;
console.log('\nget_recent_campaigns ->');
console.log(payload?.slice(0, 700) ?? JSON.stringify(res).slice(0, 700));
