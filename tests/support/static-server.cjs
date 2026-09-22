const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const target = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!target.startsWith(root + path.sep) || !types[path.extname(target)]) { res.writeHead(403).end(); return; }
  fs.readFile(target, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(target)], "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(4175, "127.0.0.1");
