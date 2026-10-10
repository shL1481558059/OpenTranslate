const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

require('./sync-ui-vendor');

const root = path.join(__dirname, '../desktop/ui');
const port = Number(process.env.OPENTRANSLATE_DEV_PORT || 1420);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

const server = http.createServer((request, response) => {
  const url = decodeURIComponent((request.url || '/').split('?')[0]);
  const relative = url === '/' ? 'translate.html' : url.replace(/^\/+/, '');
  const file = path.normalize(path.join(root, relative));
  if (!file.startsWith(root)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[dev-ui] http://127.0.0.1:${port}`);
});
