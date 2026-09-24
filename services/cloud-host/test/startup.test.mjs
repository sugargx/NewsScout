import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { waitForGateway } from "../dist/startup.js";

async function endpoint(t, handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/health`;
}

test("gateway startup waits for authenticated health before releasing the API", async t => {
  let attempts = 0;
  const url = await endpoint(t, (request, response) => {
    assert.equal(request.headers["x-scoutnews-gateway-secret"], "test-secret");
    if (++attempts < 3) { response.writeHead(503).end(); return; }
    response.end(JSON.stringify({ status: "ok", service: "copilot-gateway" }));
  });
  await waitForGateway({ url, secret: "test-secret", signal: new AbortController().signal, timeoutMs: 2000 });
  assert.equal(attempts, 3);
});

test("unavailable gateway fails explicitly instead of starting a disconnected API", async t => {
  const url = await endpoint(t, (_, response) => response.writeHead(503).end());
  await assert.rejects(waitForGateway({
    url, secret: "test-secret", signal: new AbortController().signal, timeoutMs: 180,
  }), /gateway_startup_timeout:http_503/);
});

test("a different service cannot satisfy gateway readiness", async t => {
  const url = await endpoint(t, (_, response) => response.end('{"status":"ok","service":"other"}'));
  await assert.rejects(waitForGateway({
    url, secret: "test-secret", signal: new AbortController().signal, timeoutMs: 1000,
  }), /gateway_health_response_invalid/);
});

test("shutdown interrupts gateway startup without waiting for its deadline", async t => {
  const controller = new AbortController();
  const url = await endpoint(t, () => controller.abort());
  await assert.rejects(waitForGateway({
    url, secret: "test-secret", signal: controller.signal, timeoutMs: 30_000,
  }), { name: "AbortError" });
});
