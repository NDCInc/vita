const {createReadStream, readFileSync} = require("node:fs");
const {stat} = require("node:fs/promises");
const {createServer} = require("node:http");
const path = require("node:path");

const port = Number(process.env.VITA_QA_PORT || 4393);
const site = path.resolve(process.env.VITA_QA_DIST || path.join(__dirname, "..", "dist"));
const infrastructure = readFileSync(path.join(__dirname, "..", "infra", "site.yaml"), "utf8");
const contentSecurityPolicy = infrastructure.match(/ContentSecurityPolicy: >-\r?\n((?: {14}[^\r\n]+\r?\n)+)/)?.[1]
  .split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
if (!contentSecurityPolicy) throw new Error("CloudFront policy not found in infra/site.yaml");

const types = new Map(Object.entries({
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
}));

createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self), payment=()");
  try {
    if (!["GET", "HEAD"].includes(request.method)) throw new Error();
    const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
    const filename = path.resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!filename.startsWith(site + path.sep) || !(await stat(filename)).isFile()) throw new Error();
    response.setHeader("Content-Type", types.get(path.extname(filename)) || "application/octet-stream");
    if (request.method === "HEAD") response.end();
    else createReadStream(filename).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Vita QA with CloudFront CSP on http://127.0.0.1:${port}/`));
