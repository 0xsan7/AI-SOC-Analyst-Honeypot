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

/**
 * Shown at / when web/ has not been built. A raw 404 body ("landing page not
 * built") looks like a broken server rather than a missing build step, and a
 * stranger hitting it has no reason to guess what to run. Black/grey to match
 * the rest of the site.
 */
const LANDING_FALLBACK = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SOC Analyst — landing page not built</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0a0a0a; color:#e5e5e5;
         font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:34rem; padding:2.5rem; }
  h1 { font-size:1.25rem; font-weight:600; margin:0 0 .75rem; letter-spacing:-.01em; }
  p  { color:#a3a3a3; line-height:1.6; margin:0 0 1.25rem; }
  code { background:#171717; border:1px solid #262626; border-radius:6px;
         padding:.2rem .45rem; font-family:ui-monospace,"JetBrains Mono",monospace; font-size:.875rem; }
  pre { background:#171717; border:1px solid #262626; border-radius:8px;
        padding:1rem; overflow-x:auto; margin:0 0 1.25rem;
        font-family:ui-monospace,"JetBrains Mono",monospace; font-size:.875rem; color:#e5e5e5; }
  a { color:#e5e5e5; }
  .muted { color:#737373; font-size:.875rem; margin-top:2rem; }
</style></head>
<body><main>
  <h1>The landing page has not been built</h1>
  <p>The SOC console is already running — <a href="/dashboard">open it</a>.</p>
  <p>To build this page:</p>
  <pre>cd web
npm install
npm run build</pre>
  <p>Or run <code>npm run setup</code> from the repo root to do keys and the
     frontend build in one step.</p>
  <p class="muted">AI SOC Analyst</p>
</main></body></html>`;

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  // Routes: / -> landing page, /dashboard -> console, /dashboard/* -> its assets.
  if (path === '/' || path === '/index.html') {
    const html = safeJoin(WEB_DIST, 'index.html');
    if (html && existsSync(html)) {
      try {
        const body = await readFile(html);
        return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(body);
      } catch {
        /* fall through to the notice below */
      }
    }
    // Not built yet. 200 with an explanation beats a 404 that reads like a
    // broken server -- and the console is still one click away.
    return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(LANDING_FALLBACK);
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
