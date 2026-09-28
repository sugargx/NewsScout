import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedIdentityCredential } from "@azure/identity";
import { createCloudServer } from "./app.js";
import { createMonitor } from "./observability.js";
import { createExportArchive } from "./storage.js";
import { waitForGateway } from "./startup.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required cloud setting: ${name}`);
  return value;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
if (required("SCOUTNEWS_AUTH_MODE") !== "azure") throw new Error("The cloud host requires authenticated Azure mode.");
required("DATABASE_URL");
required("SCOUTNEWS_CSRF_SECRET");
const gatewaySecret = required("COPILOT_GATEWAY_SHARED_SECRET");
const copilotAuthMode = required("SCOUTNEWS_COPILOT_AUTH_MODE");
if (!["disabled", "github-app"].includes(copilotAuthMode)) {
  throw new Error("SCOUTNEWS_COPILOT_AUTH_MODE must be disabled or github-app.");
}
if (process.env.COPILOT_GITHUB_TOKEN?.trim()) {
  throw new Error("Legacy COPILOT_GITHUB_TOKEN injection is forbidden in the cloud host.");
}
if (copilotAuthMode === "github-app") {
  required("SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID");
  required("SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID");
  required("SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL");
} else if (process.env.SCOUTNEWS_COPILOT_GITHUB_CLIENT_ID?.trim() ||
    process.env.SCOUTNEWS_COPILOT_GITHUB_ACCOUNT_ID?.trim() ||
    process.env.SCOUTNEWS_COPILOT_OAUTH_BUNDLE_SECRET_URL?.trim()) {
  throw new Error("Managed Copilot credential settings are forbidden while Copilot is disabled.");
}
const origin = new URL(required("WEB_ORIGIN"));
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.username || origin.password) {
  throw new Error("WEB_ORIGIN must be the HTTPS application origin.");
}
const credential = new ManagedIdentityCredential(required("AZURE_CLIENT_ID"));
const monitor = createMonitor(required("APPLICATIONINSIGHTS_CONNECTION_STRING"), credential);
const archive = createExportArchive(required("SCOUTNEWS_EXPORT_STORAGE_URL"), credential);
const server = await createCloudServer({
  site: resolve(root, "apps", "web", "dist"),
  apiUrl: "http://127.0.0.1:8080",
  proxyToken: required("SCOUTNEWS_PROXY_TOKEN"),
  tracer: monitor.tracer,
  exports: archive,
});
let stopping = false;
const shutdown = new AbortController();
const children: ChildProcess[] = [];
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  shutdown.abort();
  if (server.listening) server.close();
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 10_000);
  timer.unref();
  await monitor.shutdown();
  process.exitCode = code;
}
function start(name: string, command: string, args: string[]) {
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      SCOUTNEWS_BIND: "127.0.0.1:8080",
      COPILOT_GATEWAY_BIND: "127.0.0.1",
      COPILOT_GATEWAY_PORT: "8787",
      COPILOT_GATEWAY_URL: "http://127.0.0.1:8787",
      SCOUTNEWS_BROWSER_HEADLESS: "true",
    },
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", () => {
    console.error(JSON.stringify({ category: "process_start_failed", component: name }));
    void stop(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(JSON.stringify({ category: "process_exit", component: name, code, signal }));
      void stop(1);
    }
  });
}
process.once("SIGTERM", () => void stop(0));
process.once("SIGINT", () => void stop(0));
start("gateway", process.execPath, [resolve(root, "services", "copilot-gateway", "dist", "index.js")]);
try {
  await waitForGateway({ url: "http://127.0.0.1:8787/health", secret: gatewaySecret, signal: shutdown.signal });
  if (!stopping) {
    start("api", resolve(root, "bin", process.platform === "win32" ? "scoutnews-api.exe" : "scoutnews-api"), []);
    server.listen(3000, "0.0.0.0", () => {
      console.info(JSON.stringify({ category: "host_started", port: 3000, deployment: "invited-preview" }));
    });
  }
} catch (error) {
  if (!stopping) {
    console.error(JSON.stringify({ category: "gateway_startup_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    await stop(1);
  }
}
