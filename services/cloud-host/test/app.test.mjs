import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createCloudServer, preferredEncoding } from "../dist/app.js";
import { routeName } from "../dist/observability.js";
import { createExportArchive } from "../dist/storage.js";

const owner = "af3fc1c9-bef1-4dc1-8d37-448bd78b4930";
const proxyToken = "controlled-proxy-token-not-a-live-secret";
const requests = [], archives = [], logs = [];
const slowRequests = new Map();
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
let upstream, server, directory, base;
const largeBundle = Array.from({ length: 400 }, (_, index) => `export const reader${index} = "NewsScout 阅读器 ${index}";`).join("\n");
const largeJson = JSON.stringify({ items: Array.from({ length: 200 }, (_, index) => ({ id: index, title: `压缩传输 fixture ${index}` })) });
function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + path, { headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject); request.end();
  });
}
const originalInfo = console.info, originalError = console.error;
before(async () => {
  console.info = value => logs.push(value);
  console.error = value => logs.push(value);
  directory = await mkdtemp(join(tmpdir(), "newsscout-cloud-test-"));
  const site = join(directory, "site");
  await mkdir(join(site, "assets"), { recursive: true });
  await writeFile(join(site, "index.html"), '<!doctype html><html lang="zh-CN" data-public-reader="true"><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
  await writeFile(join(site, "assets", "app.js"), "export const version='fixture';");
  await writeFile(join(site, "assets", "bundle.js"), largeBundle);
  await writeFile(join(directory, "private.js"), "PRIVATE_TEST_SENTINEL");
  upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url === "/health") { res.end('{"status":"ok"}'); return; }
    res.setHeader("Content-Type", "application/json");
    assert.equal(req.headers["x-scoutnews-proxy-token"], proxyToken);
    if (!req.headers["x-ms-client-principal"]) {
      res.statusCode = 401; res.end('{"error":"authentication_required"}'); return;
    }
    const slow = slowRequests.get(req.url);
    if (slow) {
      res.once("close", () => slow.closed.resolve(res.writableFinished));
      slow.started.resolve(res);
      return;
    }
    if (req.url === "/api/v1/events?large-fixture") { res.end(largeJson); return; }
    if (req.url === "/api/v1/me/export") {
      res.end(JSON.stringify({ userId: owner, topics: ["controlled-fixture"], states: [] })); return;
    }
    res.end('{"ok":true}');
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  server = await createCloudServer({
    site, apiUrl: `http://127.0.0.1:${upstream.address().port}`, proxyToken,
    tracer: provider.getTracer("test"),
    exports: { async save(userId, data) { archives.push({ userId, data: JSON.parse(data.toString()) }); } },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await provider.shutdown();
  console.info = originalInfo; console.error = originalError;
  await rm(directory, { recursive: true });
});

test("the same app shell is used with cloud authentication, never the reduced reader", async () => {
  const response = await fetch(base + "/sources");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-deployment="azure"/);
  assert.doesNotMatch(html, /data-public-reader/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});
test("only known static assets are served, and missing bundles are not HTML", async () => {
  const asset = await fetch(base + "/assets/app.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  for (const path of ["/assets/missing.js", "/..%2fprivate.js", "/assets/%00.js"]) {
    const response = await fetch(base + path);
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /PRIVATE_TEST_SENTINEL/);
  }
});
test("API authentication is required and proxy credentials are replaced, not accepted from clients", async () => {
  const anonymous = await fetch(base + "/api/v1/events", { headers: { "X-ScoutNews-Proxy-Token": "forged" } });
  assert.equal(anonymous.status, 401);
  const response = await fetch(base + "/api/v1/events?q=private-search-sentinel", {
    headers: {
      "X-MS-CLIENT-PRINCIPAL": "controlled-platform-principal",
      "X-ScoutNews-Proxy-Token": "forged",
      Cookie: "auth-cookie-sentinel",
      Authorization: "Bearer token-sentinel",
    },
  });
  assert.equal(response.status, 200);
  const forwarded = requests.at(-1);
  assert.equal(forwarded.headers["x-ms-client-principal"], "controlled-platform-principal");
  assert.equal(forwarded.headers["x-scoutnews-proxy-token"], proxyToken);
  assert.equal(forwarded.headers.authorization, undefined);
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("operational telemetry contains route templates, not identifiers, queries or tokens", async () => {
  await provider.forceFlush();
  assert.ok(exporter.getFinishedSpans().some(span => span.attributes["http.route"] === "/api/v1/events"));
  const serialized = JSON.stringify({ logs, spans: exporter.getFinishedSpans().map(span => ({ name: span.name, attributes: span.attributes })) });
  for (const forbidden of ["private-search-sentinel", "auth-cookie-sentinel", "token-sentinel", proxyToken, "controlled-platform-principal"]) assert.ok(!serialized.includes(forbidden));
  assert.equal(routeName(`/api/v1/events/${owner}/state`), "/api/v1/events/:id/state");
  assert.equal(routeName("/api/v1/arbitrary-private-label"), "unmatched");
});
test("abandoned slow reads promptly release the upstream request", { timeout: 10000 }, async () => {
  const path = "/api/v1/events?cancelled-read-fixture";
  const slow = { started: Promise.withResolvers(), closed: Promise.withResolvers() };
  slowRequests.set(path, slow);
  const controller = new AbortController();
  let pending;
  const response = fetch(base + path, {
    headers: { "X-MS-CLIENT-PRINCIPAL": "controlled-platform-principal" }, signal: controller.signal,
  });
  const rejected = assert.rejects(response, error => error.name === "AbortError");
  try {
    pending = await slow.started.promise;
    controller.abort();
    await rejected;
    const completed = await Promise.race([
      slow.closed.promise,
      delay(1000).then(() => { throw new Error("Disconnected read is still using its upstream connection"); }),
    ]);
    assert.equal(completed, false);
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally {
    controller.abort();
    pending?.destroy();
    slowRequests.delete(path);
  }
});
test("receiving a complete GET request does not cancel its still-pending response", { timeout: 10000 }, async () => {
  const path = "/api/v1/events?complete-read-fixture";
  const slow = { started: Promise.withResolvers(), closed: Promise.withResolvers() };
  slowRequests.set(path, slow);
  let pending;
  try {
    const result = fetch(base + path, { headers: { "X-MS-CLIENT-PRINCIPAL": "controlled-platform-principal" } });
    pending = await slow.started.promise;
    await delay(30);
    assert.equal(pending.destroyed, false);
    pending.end('{"ok":true}');
    assert.deepEqual(await (await result).json(), { ok: true });
    assert.equal(await slow.closed.promise, true);
  } finally {
    pending?.destroy();
    slowRequests.delete(path);
  }
});
test("disconnect cancellation does not change already-forwarded write semantics", { timeout: 10000 }, async () => {
  const path = `/api/v1/events/${owner}/state`;
  const slow = { started: Promise.withResolvers(), closed: Promise.withResolvers() };
  slowRequests.set(path, slow);
  const controller = new AbortController();
  let pending;
  const response = fetch(base + path, {
    method: "PUT", body: '{"saved":true}',
    headers: { "X-MS-CLIENT-PRINCIPAL": "controlled-platform-principal", "X-CSRF-Token": "controlled-csrf" },
    signal: controller.signal,
  });
  const rejected = assert.rejects(response, error => error.name === "AbortError");
  try {
    pending = await slow.started.promise;
    controller.abort();
    await rejected;
    await delay(30);
    assert.equal(pending.destroyed, false);
    pending.end('{"ok":true}');
    assert.equal(await slow.closed.promise, true);
  } finally {
    controller.abort();
    pending?.destroy();
    slowRequests.delete(path);
  }
});
test("own-data exports are privately archived only after API authorization", async () => {
  const unauthorized = await fetch(base + "/api/v1/me/export", { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);
  assert.equal(archives.length, 0);
  const response = await fetch(base + "/api/v1/me/export", {
    method: "POST", body: "{}",
    headers: { "X-MS-CLIENT-PRINCIPAL": "controlled-platform-principal", "X-CSRF-Token": "controlled-csrf" },
  });
  assert.equal(response.status, 200);
  assert.equal(archives.length, 1);
  assert.equal(archives[0].userId, owner);
  assert.equal((await response.json()).userId, owner);
  assert.equal(requests.at(-1).headers["x-csrf-token"], "controlled-csrf");
  assert.match(response.headers.get("content-disposition"), /attachment/);
});
test("invalid raw paths return a bounded error instead of crashing the server", async () => {
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(base, { path: "//[", method: "GET" }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject); request.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(base + "/health")).status, 200);
});
test("blob archive rejects other hosts, account paths and invalid owner namespaces", async () => {
  const credential = { async getToken() { throw new Error("This test must not request a real token."); } };
  assert.throws(() => createExportArchive("https://example.com", credential));
  assert.throws(() => createExportArchive("https://fixture.blob.core.windows.net/other", credential));
  const archive = createExportArchive("https://fixture.blob.core.windows.net", credential);
  await assert.rejects(() => archive.save("../other-user", Buffer.from("{}")), /Invalid export owner/);
});
test("long-lived bundles are served precompressed only when the browser accepts it", async () => {
  const br = await rawGet("/assets/bundle.js", { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(br.status, 200);
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers.vary, "Accept-Encoding");
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  assert.ok(br.body.length < Buffer.byteLength(largeBundle) / 4);
  assert.equal(brotliDecompressSync(br.body).toString(), largeBundle);
  assert.match(br.headers["cache-control"], /immutable/);
  const gz = await rawGet("/assets/bundle.js", { "Accept-Encoding": "br;q=0, gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.body).toString(), largeBundle);
  const identity = await rawGet("/assets/bundle.js", { "Accept-Encoding": "identity" });
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.body.toString(), largeBundle);
  const tiny = await rawGet("/assets/app.js", { "Accept-Encoding": "br" });
  assert.equal(tiny.headers["content-encoding"], undefined);
  assert.equal(tiny.body.toString(), "export const version='fixture';");
});
test("large API JSON is compressed in transit while small or unaccepted responses stay plain", async () => {
  const principal = { "X-MS-CLIENT-PRINCIPAL": "controlled-platform-principal" };
  const large = await rawGet("/api/v1/events?large-fixture", { ...principal, "Accept-Encoding": "gzip, br" });
  assert.equal(large.status, 200);
  assert.equal(large.headers["content-encoding"], "br");
  assert.match(large.headers.vary, /Accept-Encoding/);
  assert.equal(large.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(brotliDecompressSync(large.body).toString()), JSON.parse(largeJson));
  const gz = await rawGet("/api/v1/events?large-fixture", { ...principal, "Accept-Encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString()), JSON.parse(largeJson));
  const plain = await rawGet("/api/v1/events?large-fixture", principal);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(plain.body.toString()), JSON.parse(largeJson));
  const small = await rawGet("/api/v1/events?small-fixture", { ...principal, "Accept-Encoding": "br" });
  assert.equal(small.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(small.body.toString()), { ok: true });
  const denied = await rawGet("/api/v1/events?large-fixture", { "Accept-Encoding": "br" });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers["content-encoding"], undefined);
});
test("encoding negotiation honours explicit refusals", () => {
  assert.equal(preferredEncoding("gzip, deflate, br"), "br");
  assert.equal(preferredEncoding("br;q=0, gzip;q=0.8"), "gzip");
  assert.equal(preferredEncoding("*;q=0.5"), "br");
  assert.equal(preferredEncoding("identity"), undefined);
  assert.equal(preferredEncoding("br;q=0, gzip;q=0"), undefined);
  assert.equal(preferredEncoding(undefined), undefined);
});