/**
 * Serves the site: the built React landing page at /, the SOC console at
 * /dashboard, and data/enriched.jsonl for both. All over loopback.
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
const WEB_DIST = resolve(HERE, '../web/dist');
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
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Resolve a URL path to a file, refusing anything outside `root`. */
function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full.startsWith(root) ? full : null;
}

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  // Routes: / -> landing page, /dashboard -> console, /dashboard/* -> its assets.
  if (path === '/' || path === '/index.html') {
    const html = safeJoin(WEB_DIST, 'index.html');
    if (!html) return res.writeHead(404).end('landing page not built — run `npm run build` in web/');
    try {
      const body = await readFile(html);
      return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(body);
    } catch {
      return res.writeHead(404).end('landing page not built — run `npm run build` in web/');
    }
  }

  if (path === '/dashboard' || path === '/dashboard/') {
    const html = join(PUBLIC, 'dashboard.html');
    try {
      const body = await readFile(html);
      return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(body);
    } catch {
      return res.writeHead(404).end('not found');
    }
  }

  // Landing-page assets (hashed JS/CSS) live in web/dist/assets.
  const asset = safeJoin(WEB_DIST, path.replace(/^\/+/, ''));
  if (asset) {
    try {
      const body = await readFile(asset);
      const ext = asset.slice(asset.lastIndexOf('.'));
      return res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(body);
    } catch {
      /* fall through to the console directory */
    }
  }

  // Everything else (enriched.jsonl, dashboard assets) from PUBLIC.
  const file = safeJoin(PUBLIC, path.replace(/^\/+/, ''));
  if (!file) return res.writeHead(403).end('forbidden');
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'text/plain' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] landing   http://127.0.0.1:${PORT}/`);
  console.log(`[dashboard] console   http://127.0.0.1:${PORT}/dashboard`);
});
