/**
 * Development-only static server so the app can run at http://127.0.0.1:<port>.
 * Node builtins only, loopback only, never required at runtime and never referenced
 * by any browser module. Usage: node scripts/dev-server.js [port]  (default 8137)
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_REAL = fs.realpathSync(ROOT);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const portArgument = process.argv[2];
const port = portArgument === undefined ? 8137 : Number(portArgument);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port ${JSON.stringify(portArgument)} — pass an integer 1-65535 or omit it`);
  process.exit(1);
}

function sendText(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function handleRequest(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "method not allowed\n");
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    sendText(response, 400, "bad request\n");
    return;
  }
  if (pathname.includes("\0")) {
    sendText(response, 400, "bad request\n");
    return;
  }
  // path.normalize on an absolute path clamps ".." at the root, so the join below
  // cannot climb out of the project; the realpath check also stops symlink escapes.
  const normalized = path.normalize(pathname);
  const candidate = path.join(ROOT, normalized);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) {
    sendText(response, 403, "forbidden\n");
    return;
  }
  let filePath = candidate;
  try {
    let stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stats = await fs.promises.stat(filePath);
    }
    const real = await fs.promises.realpath(filePath);
    if (real !== ROOT_REAL && !real.startsWith(ROOT_REAL + path.sep)) {
      sendText(response, 403, "forbidden\n");
      return;
    }
  } catch {
    sendText(response, 404, "not found\n");
    return;
  }
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": type,
    // Dev server: edits must show up on the next refresh, never from a stale cache.
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    try {
      sendText(response, 500, "internal error\n");
    } catch {
      response.destroy();
    }
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`port ${port} is already in use — try: node scripts/dev-server.js ${port + 1}`);
  } else {
    console.error(`dev server failed: ${error.message}`);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`doc-reviewer dev server: http://127.0.0.1:${port}/`);
});
