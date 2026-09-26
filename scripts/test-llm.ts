// Real provider smoke test — Step 2. Run: node --experimental-strip-types scripts/test-llm.ts
import 'dotenv/config';
import { Agent } from '@mastra/core/agent';

const agent = new Agent({
  id: 'llm-smoke-test',
  name: 'LLM Smoke Test',
  instructions: 'Reply with exactly one short sentence confirming you are a SOC analyst assistant. No other text.',
  model: 'google/gemini-3.5-flash',
});

const res = await agent.generate('Which log levels exist? One short sentence answer only.');
console.log('PROVIDER TEST OK');
console.log('text:', res.text);
console.log('usage:', JSON.stringify(res.usage ?? {}, null, 2));
