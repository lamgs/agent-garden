/**
 * Serve apps/web/dist on 127.0.0.1 with the production Content-Security-Policy, so e2e tests
 * prove the renderer runs under it (no eval, no external fonts/scripts). Mirrors packages/server CSP.
 * Run: node scripts/preview.ts [port]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const root = resolve(import.meta.dirname, '..', 'dist');
const port = Number(process.argv[2] ?? process.env.PORT ?? 4317);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"no api in preview"}');
    return;
  }
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (url.pathname.startsWith('/data/') || extname(file)) {
      res.writeHead(404).end();
      return;
    }
    file = join(root, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port} (dist with production CSP)`);
});
