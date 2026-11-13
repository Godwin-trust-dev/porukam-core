// Статика web/dist + прокси /v1 -> Django :8000 (смоук §E, real-режим).
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const DIST = process.env.WEB_DIST ?? 'web/dist';
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:8000';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/v1')) {
    const proxied = http.request(
      BACKEND + req.url,
      { method: req.method, headers: { ...req.headers, host: '127.0.0.1:8000' } },
      (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); },
    );
    proxied.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(proxied);
    return;
  }
  let file = join(DIST, normalize(url.pathname).replace(/^\/+/, ''));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
server.listen(8080, () => console.log('serving on :8080'));
