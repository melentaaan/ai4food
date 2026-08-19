/** A static host for the single-file app. No dependency, no configuration. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [, , port, root] = process.argv;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(Number(port), '127.0.0.1');
