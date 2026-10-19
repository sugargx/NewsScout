import { expect, test } from "@playwright/test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";

let directory: string;
let host: Server;
let upstream: Server;
let external: Server;
let base: string;
let externalUrl: string;
const themeBootstrap = `
      (() => {
        const param = new URLSearchParams(window.location.search).get("clawpilotTheme");
        const theme =
          param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.setAttribute("data-theme", theme);
      })();
    `;
const browserRequests: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
const forwarded: IncomingHttpHeaders[] = [];
const externalRequests: IncomingHttpHeaders[] = [];

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener.");
  return `http://127.0.0.1:${address.port}`;
}

test.beforeAll(async () => {
  const { createCloudServer } = await import("../../services/cloud-host/dist/app.js");
  directory = await mkdtemp(join(tmpdir(), "newsscout-origin-test-"));
  const site = join(directory, "site");
  await mkdir(site);
  // Mirrors the real document: the theme must be applied before first paint.
  await writeFile(join(site, "index.html"), `<!doctype html><html><head><script>${themeBootstrap}</script></head><body>Origin contract fixture</body></html>`);
  upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain the controlled fixture body. */ }
    forwarded.push(request.headers);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"recorded":0,"skipped":0}');
  });
  const apiUrl = await listen(upstream);
  host = await createCloudServer({
    site, apiUrl,
    proxyToken: "controlled-origin-fixture-proxy-token",
    tracer: trace.getTracer("origin-contract"),
    exports: { async save() { throw new Error("This fixture must not archive data."); } },
  });
  host.prependListener("request", request => {
    browserRequests.push({ method: request.method, url: request.url, headers: request.headers });
  });
  base = await listen(host);
  external = createServer((request, response) => {
    externalRequests.push(request.headers);
    response.end("External destination fixture");
  });
  externalUrl = await listen(external);
});

test.afterAll(async () => {
  for (const server of [host, upstream, external]) {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (directory) await rm(directory, { recursive: true });
});

test("first-paint theme setup runs under the unchanged script-src policy",async({page})=>{
  const errors:string[]=[];
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  page.on("pageerror",error=>errors.push(error.message));
  await page.emulateMedia({colorScheme:"dark"});
  const response=await page.goto(base+"/");
  const policy=String(response?.headers()["content-security-policy"]);
  const scriptSrc=policy.split(";").map(part=>part.trim()).find(part=>part.startsWith("script-src"))??"";
  expect(scriptSrc).toMatch(/^script-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/);
  // Scripts stay hash-pinned; only the pre-existing style directive allows inline.
  expect(scriptSrc).not.toContain("unsafe-inline");
  // The document must already be dark before React runs; a blocked script would leave it unset.
  expect(await page.evaluate(()=>document.documentElement.dataset.theme)).toBe("dark");
  await page.emulateMedia({colorScheme:"light"});
  await page.goto(base+"/radar");
  expect(await page.evaluate(()=>document.documentElement.dataset.theme)).toBe("light");
  expect(errors.filter(text=>/content security policy/i.test(text))).toEqual([]);
});
test("private browser POSTs retain Origin and CSRF without disclosing the page URL", async ({ page, context }) => {
  await context.addCookies([{ name: "AppServiceAuthSession", value: "controlled-cookie", url: base }]);
  const documentUrl = base + "/radar?private=controlled-referrer-sentinel";
  await page.goto(documentUrl);
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/events/exposures", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "controlled-csrf" },
      body: JSON.stringify({ items: [] }),
    });
    return response.status;
  });
  expect(status).toBe(200);
  const received = browserRequests.find(request => request.method === "POST" && request.url === "/api/v1/events/exposures");
  expect(received?.headers.origin).toBe(base);
  expect(received?.headers.referer).toBeUndefined();
  expect(received?.headers.cookie).toContain("AppServiceAuthSession=controlled-cookie");
  expect(forwarded.at(-1)?.["x-csrf-token"]).toBe("controlled-csrf");
  expect(forwarded.at(-1)?.origin).toBe(base);
  expect(forwarded.at(-1)?.cookie).toBeUndefined();
});

test("private page URLs are not sent as referrers to external destinations", async ({ page }) => {
  await page.goto(base + "/radar?private=must-not-leave-this-origin");
  await page.evaluate(url => { window.location.assign(url); }, externalUrl);
  await page.waitForURL(externalUrl + "/");
  expect(externalRequests.length).toBeGreaterThan(0);
  expect(externalRequests.at(-1)?.referer).toBeUndefined();
});
