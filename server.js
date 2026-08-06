// Dev server for the Petpooja API tester.
//
// Serves the static pages and proxies API calls. The proxy exists because the
// browser cannot call api.petpooja.com directly (no CORS headers on their side),
// and because the Orders API is a GET *with a body* — which fetch() refuses to
// send, so requests go out through node:https instead.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;

// Only these hosts may be reached through the proxy, so this stays a Petpooja
// tester rather than an open relay listening on localhost.
const ALLOWED_HOSTS = new Set(["api.petpooja.com", "inventory.petpooja.com"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function forward({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const started = Date.now();

    const outHeaders = { ...headers };
    if (body) outHeaders["Content-Length"] = Buffer.byteLength(body);

    const upstream = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method,
        headers: outHeaders,
      },
      (upRes) => {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () =>
          resolve({
            status: upRes.statusCode,
            statusText: upRes.statusMessage,
            headers: upRes.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            ms: Date.now() - started,
          })
        );
      }
    );

    upstream.on("error", reject);
    upstream.setTimeout(60000, () => upstream.destroy(new Error("Upstream timed out after 60s")));
    if (body) upstream.write(body);
    upstream.end();
  });
}

async function handleProxy(req, res) {
  let spec;
  try {
    spec = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Request body was not valid JSON" });
  }

  let host;
  try {
    host = new URL(spec.url).hostname;
  } catch {
    return sendJson(res, 400, { error: "Missing or malformed target url" });
  }

  if (!ALLOWED_HOSTS.has(host)) {
    return sendJson(res, 403, {
      error: `Host "${host}" is not allowed. Permitted: ${[...ALLOWED_HOSTS].join(", ")}`,
    });
  }

  try {
    const result = await forward({
      url: spec.url,
      method: spec.method || "GET",
      headers: spec.headers || {},
      body: spec.body || null,
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

function handleStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/output") rel = "/output.html";
  if (rel === "/dashboard") rel = "/dashboard.html";

  // Resolve first, then confirm the result is still inside ROOT, so encoded
  // traversal (%2e%2e) can't escape the project directory.
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      // Always revalidate, so editing the .jsx and refreshing actually shows it.
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    if (req.url.split("?")[0] === "/proxy") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
      return handleProxy(req, res);
    }
    handleStatic(req, res);
  })
  .listen(PORT, () => {
    console.log(`Petpooja tester running:`);
    console.log(`  dashboard     http://localhost:${PORT}/dashboard`);
    console.log(`  curl builder  http://localhost:${PORT}/`);
    console.log(`  live output   http://localhost:${PORT}/output`);
  });
