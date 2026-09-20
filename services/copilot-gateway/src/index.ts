import { serve } from "@hono/node-server";
import { CopilotClient } from "@github/copilot-sdk";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const app = new Hono();
const clients = new Map<string, CopilotClient>();
const runtimeDirectory = await mkdtemp(join(tmpdir(), "scoutnews-copilot-"));
let generating = false;
let connectingLocal = false;
let localAccount: string | undefined;
const localClientKey = "local-login";

function clientKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

app.use("/v1/*", bodyLimit({ maxSize: 120_000, onError: (context) => context.json({ error: "request exceeds 120KB" }, 413) }));

app.use("/v1/*", async (context, next) => {
  const expected = process.env.COPILOT_GATEWAY_SHARED_SECRET;
  const actual = context.req.header("x-scoutnews-gateway-secret") ?? "";
  if (!expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    return context.json({ error: "invalid gateway secret" }, 401);
  }
  await next();
});

function tokenFromHeader(header?: string): string | null {
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function clientFor(token: string): CopilotClient {
  const key = clientKey(token);
  let client = clients.get(key);
  if (!client) {
    const baseDirectory = join(runtimeDirectory, key);
    mkdirSync(baseDirectory, { recursive: true });
    client = new CopilotClient({
      gitHubToken: token, useLoggedInUser: false, mode: "empty",
      baseDirectory, workingDirectory: runtimeDirectory,
    });
    clients.set(key, client);
  }
  return client;
}

function localLoginEnabled(): boolean {
  return process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE?.toLowerCase() !== "true";
}

async function stopClient(key: string) {
  const client = clients.get(key);
  clients.delete(key);
  if (key === localClientKey) localAccount = undefined;
  if (client) {
    const errors = await client.stop();
    if (errors.length) {
      await client.forceStop();
      throw new AggregateError(errors, "Copilot client did not stop cleanly");
    }
  }
}

async function availableModels(client: CopilotClient) {
  const models = await client.listModels();
  return models.filter(model => model.id !== "auto" && model.policy?.state !== "disabled")
    .map(model => ({ id: model.id, name: model.name }));
}

app.get("/health", (context) => context.json({ status: "ok", service: "copilot-gateway" }));

app.post("/v1/providers/copilot/local/probe", async (context) => {
  if (!localLoginEnabled()) return context.json({ error: "local login is disabled in this isolated environment" }, 403);
  if (generating || connectingLocal) return context.json({ error: "Copilot is busy; retry after the current operation" }, 409);
  connectingLocal = true;
  try {
    await stopClient(localClientKey);
    const client = new CopilotClient({
      mode: "empty", useLoggedInUser: true,
      // Keep authentication in its existing CLI home; only our UUID sessions are deleted.
      baseDirectory: process.env.COPILOT_HOME || join(homedir(), ".copilot"),
      workingDirectory: runtimeDirectory,
      env: { ...process.env, COPILOT_GITHUB_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
    });
    clients.set(localClientKey, client);
    await client.start();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated || !auth.login || !["user", "gh-cli"].includes(auth.authType ?? "")) {
      await stopClient(localClientKey);
      return context.json({ error: "没有可用的本地 GitHub/Copilot 登录，请先完成本机登录后重试" }, 401);
    }
    const models = await availableModels(client);
    if (!models.length) {
      await stopClient(localClientKey);
      return context.json({ error: "本地账户没有可用的 Copilot 模型" }, 403);
    }
    localAccount = auth.login;
    return context.json({ provider: "github-copilot", eligible: true, authMode: "local",
      authType: auth.authType, login: auth.login, models });
  } catch (error) {
    console.error("Local Copilot connection failed", error instanceof Error ? error.name : "unknown error");
    try { await stopClient(localClientKey); }
    catch (cleanupError) { console.error("Local client cleanup failed", cleanupError instanceof Error ? cleanupError.name : "unknown error"); }
    return context.json({ error: "无法连接本地 Copilot，请确认本机登录、订阅和网络后重试" }, 502);
  } finally { connectingLocal = false; }
});

app.delete("/v1/providers/copilot/local/client", async (context) => {
  if (generating || connectingLocal) return context.json({ error: "Copilot is busy; retry afterwards" }, 409);
  connectingLocal = true;
  try {
    await stopClient(localClientKey);
    return context.json({ status: "disconnected", localLoginPreserved: true });
  } finally { connectingLocal = false; }
});

app.post("/v1/providers/copilot/probe", async (context) => {
  const token = tokenFromHeader(context.req.header("authorization"));
  if (!token) return context.json({ error: "missing GitHub user token" }, 401);
  try {
    const client = clientFor(token);
    await client.start();
    const models = await availableModels(client);
    return context.json({ provider: "github-copilot", eligible: models.length > 0, models, authMode: "oauth" });
  } catch (error) {
    return context.json({ provider: "github-copilot", eligible: false, error: error instanceof Error ? error.message.replaceAll(token, "[redacted]").slice(0, 500) : "capability probe failed" }, 403);
  }
});

app.delete("/v1/providers/copilot/client", async (context) => {
  const token = tokenFromHeader(context.req.header("authorization"));
  if (!token) return context.json({ error: "missing GitHub user token" }, 401);
  if (generating) return context.json({ error: "a summary is still running; retry disconnect afterwards" }, 409);
  const key = clientKey(token);
  await stopClient(key);
  return context.json({ status: "disconnected" });
});

const generateSchema = z.object({
  model: z.string().min(1).max(200), system: z.string().min(1).max(12000),
  prompt: z.string().min(1).max(80000), sessionId: z.string().regex(/^scoutnews-[a-f0-9-]{36}$/),
}).strict();

async function generate(context: Context, identity: { mode: "local" } | { mode: "oauth"; token: string }) {
  let body: unknown;
  try { body = await context.req.json(); }
  catch (error) {
    if (error instanceof SyntaxError) return context.json({ error: "invalid JSON body" }, 400);
    throw error;
  }
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: parsed.error.flatten() }, 400);
  if (generating || connectingLocal) return context.json({ error: "Copilot is busy; retry afterwards" }, 429);
  if (identity.mode === "local" && (!localLoginEnabled() || !localAccount || !clients.has(localClientKey))) {
    return context.json({ error: "请先重新连接本地 Copilot 账户" }, 412);
  }
  const client = identity.mode === "local" ? clients.get(localClientKey) : clientFor(identity.token);
  if (!client) return context.json({ error: "Copilot client is disconnected" }, 412);
  generating = true;
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
  try {
    await client.start();
    const selected = (await client.listModels()).find(model => model.id === parsed.data.model && model.id !== "auto" && model.policy?.state !== "disabled");
    if (!selected) {
      return context.json({ error: "所选模型当前不可用；不会自动切换模型" }, 400);
    }
    const reasoningEffort: "low" | undefined = selected.capabilities.supports.reasoningEffort ? "low" : undefined;
    if (reasoningEffort && !selected.supportedReasoningEfforts?.includes(reasoningEffort)) {
      return context.json({ error: "所选模型未提供 low reasoning 支持；不会自动提高推理强度" }, 400);
    }
    if (identity.mode === "local") {
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated || auth.login !== localAccount) {
        return context.json({ error: "本地账户登录已变化，请重新连接" }, 412);
      }
    }
    session = await client.createSession({
      sessionId: parsed.data.sessionId, model: parsed.data.model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(identity.mode === "oauth" ? { gitHubToken: identity.token } : {}),
      systemMessage: { mode: "replace", content: parsed.data.system },
      availableTools: [], workingDirectory: runtimeDirectory, enableConfigDiscovery: false,
      enableFileHooks: false, enableSkills: false, enableSessionStore: false,
      enableHostGitOperations: false, memory: { enabled: false },
      infiniteSessions: { enabled: false },
      onPermissionRequest: async () => ({ kind: "denied-no-approval-rule-and-could-not-request-from-user" }),
      hooks: { onPreToolUse: async () => ({ permissionDecision: "deny", permissionDecisionReason: "News summarization has no tool permissions." }) },
    });
    const response = await session.sendAndWait({ prompt: parsed.data.prompt }, 90_000);
    if (!response?.data.content?.trim()) throw new Error("Copilot returned an empty summary");
    return context.json({ content: response.data.content, provider: "github-copilot", model: parsed.data.model, reasoningEffort: reasoningEffort ?? null });
  } catch (error) {
    if (session) {
      try { await session.abort(); }
      catch (abortError) { console.error("Could not abort summary session", abortError instanceof Error ? abortError.name : "unknown error"); }
    }
    const message = identity.mode === "local" ? "本地 Copilot 生成失败或超时，请检查连接和模型用量后重试"
      : error instanceof Error ? error.message.replaceAll(identity.token, "[redacted]").slice(0, 500) : "generation failed";
    console.error("Copilot generation failed", error instanceof Error ? error.name : "unknown error");
    return context.json({ error: message }, 502);
  } finally {
    if (session) {
      try { await session.disconnect(); await client.deleteSession(parsed.data.sessionId); }
      catch (cleanupError) { console.error("Could not clean up summary session", cleanupError instanceof Error ? cleanupError.name : "unknown error"); }
    }
    generating = false;
  }
}

app.post("/v1/generate", async (context) => {
  const token = tokenFromHeader(context.req.header("authorization"));
  if (!token) return context.json({ error: "missing GitHub user token" }, 401);
  return generate(context, { mode: "oauth", token });
});
app.post("/v1/generate/local", (context) => generate(context, { mode: "local" }));

const hostname = process.env.COPILOT_GATEWAY_BIND ?? "127.0.0.1";
const port = Number(process.env.COPILOT_GATEWAY_PORT ?? 8787);
const server = serve({ fetch: app.fetch, hostname, port }, ({ address, port: activePort }) => {
  console.log("Copilot gateway listening on http://" + address + ":" + activePort);
});

async function shutdown() {
  server.close();
  const results = await Promise.allSettled([...clients.keys()].map(stopClient));
  for (const result of results) if (result.status === "rejected") console.error("Copilot client shutdown failed");
  await rm(runtimeDirectory, { recursive: true, force: true });
}
process.once("SIGINT", () => { void shutdown().catch(error => { console.error("Gateway shutdown failed", error); process.exitCode = 1; }); });
process.once("SIGTERM", () => { void shutdown().catch(error => { console.error("Gateway shutdown failed", error); process.exitCode = 1; }); });
