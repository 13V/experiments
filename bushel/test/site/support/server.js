'use strict';
/**
 * The static file server the browser tests and the screenshot pass run against. site/ is a
 * no-build directory of plain files, so serving it is the whole build step: no bundler, no
 * transform, nothing that could make what the test sees differ from what a visitor gets.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', 'site');
const DEFAULT_PORT = 4174;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serve(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + rel); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
}

const server = http.createServer(serve);
if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  server.listen(port, '127.0.0.1', () => console.log(`serving site/ on http://127.0.0.1:${port}`));
}
module.exports = { serve, DEFAULT_PORT, ROOT };
