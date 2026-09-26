/**
 * Serves the live dashboard: copies data/enriched.jsonl next to the static
 * page and serves both over loopback.
 * Usage: npx tsx scripts/dashboard.ts
 */
import 'dotenv/config';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '../src/mastra/public');
const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);

mkdirSync(PUBLIC, { recursive: true });
if (existsSync('data/enriched.jsonl')) {
  copyFileSync('data/enriched.jsonl', join(PUBLIC, 'enriched.jsonl'));
  console.log('[dashboard] copied data/enriched.jsonl');
} else {
  console.log('[dashboard] no data/enriched.jsonl yet — run `npm run pipeline` first');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
  // Serve only from PUBLIC; reject traversal.
  const full = resolve(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'text/plain' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] http://127.0.0.1:${PORT}`);
});
