// Serve a fixture folder on 127.0.0.1 at a free port (sitemap {{ORIGIN}} filled in), for tests and the sample
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml', '.jpg': 'image/jpeg', '.png': 'image/png' };

export function serve(dir) {
  const root = dir.endsWith(sep) ? dir : dir + sep;
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = join(root, path);
      if (!file.startsWith(root)) return res.writeHead(403).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) return res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
      let body = readFileSync(file);
      if (extname(file) === '.xml') body = body.toString().replaceAll('{{ORIGIN}}', origin());
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    });
    const origin = () => `http://127.0.0.1:${server.address().port}`;
    server.listen(0, '127.0.0.1', () => done({ server, origin: origin() }));
  });
}
