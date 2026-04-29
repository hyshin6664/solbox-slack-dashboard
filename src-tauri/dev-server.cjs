// Dev static server for tauri dev — serves src/ at http://localhost:1430
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', 'src');
const TYPES = { js:'text/javascript', html:'text/html', css:'text/css', json:'application/json', png:'image/png', svg:'image/svg+xml', ico:'image/x-icon' };
http.createServer((req, res) => {
  let url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '') url = '/index.html';
  const filePath = path.join(ROOT, url);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404 ' + url); }
    const ext = filePath.split('.').pop();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(1430, () => console.log('[dev-server] http://localhost:1430 serving ' + ROOT));
