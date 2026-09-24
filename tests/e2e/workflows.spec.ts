import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eventDates, formatPublicationDate, summaryModel } from "../../apps/web/src/reader";
import { databaseQuery } from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";

test("reader timestamps never disguise an unknown source date as collection or publication", () => {
  const collectedAt = "2026-09-07T12:00:00Z";
  const dates = eventDates({ publishedAt: null, collectedAt, updatedAt: collectedAt });
  expect(dates.publication).toBe("来源未提供发布 / 更新时间");
  expect(dates.collection).toContain("采集 / 收录");
  expect(eventDates({ updatedAt: collectedAt }).publication).toContain("历史记录时间");
  expect(formatPublicationDate("2026-09-07T00:00:00Z", "day")).toBe("2026/9/7");
});

test("summary selection prefers the exact default and never silently substitutes", () => {
  const provider = { model: "gpt-5.6-terra", models: ["gpt-5.5", "gpt-5.6-terra"] };
  expect(summaryModel(provider, "")).toBe("gpt-5.6-terra");
  expect(summaryModel(provider, "gpt-5.5")).toBe("gpt-5.5");
  expect(summaryModel({ model: null, models: ["gpt-5.5"] }, "")).toBe("");
  expect(summaryModel({ model: null, models: ["gpt-5.6-terra"] }, "")).toBe("");
  expect(summaryModel(provider, "removed-model")).toBe("");
  expect(summaryModel({ model: "gpt-5.6-terra", models: [] }, "")).toBe("");
  expect(summaryModel(undefined, "")).toBe("");
});

test("feed refresh is idempotent and scoring and excerpts are real", async ({ request }) => {
  test.setTimeout(300_000);
  const before = databaseQuery("SELECT count(*) FROM content_items");
  expect(Number(before)).toBeGreaterThan(0);
  const { items: sources } = await (await request.get(`${api}/api/v1/sources`)).json();
  const source = sources.find((item: { name: string }) => item.name === "Rust Blog");
  expect(source, "the registered official Rust feed must be present").toBeTruthy();
  const refresh = await request.post(`${api}/api/v1/sources/${source.id}/refresh`, { timeout: 90_000 });
  expect(refresh.ok()).toBeTruthy();
  const result = await refresh.json();
  expect(result.failed).toBe(0);
  expect(result.succeeded).toBe(1);
  expect(result.ingested).toBeGreaterThanOrEqual(0);
  expect(Number(databaseQuery("SELECT count(*) FROM content_items"))).toBe(Number(before) + result.ingested);
  expect(databaseQuery("SELECT count(*) FROM (SELECT source_id,external_id FROM content_items WHERE external_id IS NOT NULL AND external_id<>'' GROUP BY source_id,external_id HAVING count(*)>1) d")).toBe("0");
  const response = await request.get(`${api}/api/v1/events?limit=100`);
  const { items } = await response.json();
  expect(items.length).toBeGreaterThan(0);
  expect(new Set(items.map((event: { score: { total: number } }) => event.score.total)).size).toBeGreaterThan(1);
  for (const event of items) {
    expect(event.summaryKind).toBe("feed");
    expect(event.summary).not.toMatch(/<\/?(?:p|div|script|style|a|img)\b/i);
    expect(event.score.engagement).toBe(0);
    expect(event.score.explanation.length).toBeGreaterThan(0);
  }
});

test("read later and read flags persist without clobbering saved state", async ({ request, page }) => {
  test.setTimeout(120_000);
  let { items: [event] } = await (await request.get(`${api}/api/v1/events?limit=1`)).json();
  if(!event) {
    const {items:sources}=await (await request.get(`${api}/api/v1/sources`)).json();
    const rust=sources.find((source:{name:string})=>source.name==="Rust Blog");
    const refresh=await request.post(`${api}/api/v1/sources/${rust.id}/refresh`,{timeout:90_000});
    expect((await refresh.json()).succeeded).toBe(1);
    ({items:[event]}=await (await request.get(`${api}/api/v1/events?limit=1`)).json());
  }
  let update = await request.put(`${api}/api/v1/events/${event.id}/state`, { data: { saved: true, later: true, read: true } });
  expect(update.ok()).toBeTruthy();
  update = await request.put(`${api}/api/v1/events/${event.id}/state`, { data: { read: false } });
  const state = await update.json();
  expect(state).toMatchObject({ saved: true, later: true, read: false });
  expect(databaseQuery(`SELECT (saved_at IS NOT NULL)::int || ',' || (later_at IS NOT NULL)::int || ',' || (read_at IS NOT NULL)::int FROM user_event_states WHERE event_id='${event.id}'`)).toBe("1,1,0");
  const later = await request.get(`${api}/api/v1/events?later=true&read=false`);
  expect((await later.json()).items.some((item: { id: string }) => item.id === event.id)).toBeTruthy();
  await page.goto(`/events/${event.id}`);
  await expect(page.getByRole("heading", { level: 1, name: event.title, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: /查看原始来源/ }).first()).toHaveAttribute("href", /^https:/);
});

test("score pagination does not reuse stale snapshot totals", async ({ request }) => {
  const before = await (await request.get(`${api}/api/v1/events?sort=score&limit=5`)).json();
  expect(before.items.length).toBeGreaterThan(0);
  databaseQuery("UPDATE score_snapshots SET total=100-total");
  try {
    const after = await (await request.get(`${api}/api/v1/events?sort=score&limit=5`)).json();
    expect(after.items.map((event: { id: string }) => event.id)).toEqual(before.items.map((event: { id: string }) => event.id));
    for (let index = 1; index < after.items.length; index++) {
      expect(after.items[index - 1].score.total + 0.01).toBeGreaterThanOrEqual(after.items[index].score.total);
    }
  } finally {
    databaseQuery("UPDATE score_snapshots SET total=100-total");
  }
});

test("briefs do not publish unprocessed excerpts or freeze empty snapshots", async ({ request, page }) => {
  const preview = await (await request.get(`${api}/api/v1/briefs/today`)).json();
  expect(preview.isSnapshot).toBe(false);
  expect(preview.items).toEqual([]);
  const save = await request.post(`${api}/api/v1/briefs/today/generate`, { data: {} });
  expect(save.status()).toBe(409);
  const history = await (await request.get(`${api}/api/v1/briefs`)).json();
  expect(history.items).toEqual([]);
  expect(databaseQuery("SELECT count(*) FROM daily_briefs WHERE status='published'")).toBe("0");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日精选", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "今天还没有达到标准的内容" })).toBeVisible();
  // The daily edition is published by the morning run only; readers cannot freeze one manually.
  await expect(page.getByLabel("精选日期", { exact: true }).locator("option")).toHaveText(["今日精选（最新）"]);
  await expect(page.getByRole("button", { name: /保存|应用更新/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "生成今日分享图" })).toHaveCount(0);
});

test("sources can be registered and paused, duplicate and invalid input fail explicitly", async ({ request, page }) => {
  const input = {
    name: "E2E custom source", endpoint: `https://blog.rust-lang.org/feed.xml?scoutnews_e2e=${randomUUID()}`,
    adapter: "rss", contentType: "blog", tier: "T2", scheduleMinutes: 60, topic: "Rust",
  };
  const created = await request.post(`${api}/api/v1/sources`, { data: input });
  expect(created.ok()).toBeTruthy();
  const source = await created.json();
  expect(source.lifecycleStatus).toBe("observing");
  expect(source.topics).toContain("Rust");
  const pause = await request.put(`${api}/api/v1/sources/${source.id}`, { data: { enabled: false, scheduleMinutes: 120 } });
  expect(await pause.json()).toMatchObject({ lifecycleStatus: "paused", scheduleMinutes: 120 });
  expect((await request.post(`${api}/api/v1/sources/${source.id}/refresh`)).status()).toBe(409);
  expect((await request.post(`${api}/api/v1/sources`, { data: input })).status()).toBe(409);
  expect((await request.post(`${api}/api/v1/sources`, { data: { ...input, endpoint: "http://127.0.0.1:8080/health" } })).status()).toBe(400);
  expect((await request.put(`${api}/api/v1/sources/${source.id}`, { data: { scheduleMinutes: 0 } })).status()).toBe(400);
  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: source.name })).toBeVisible();
});

test("unconnected Copilot never consumes a quota or replaces source excerpts", async ({ request }) => {
  const { items: [event] } = await (await request.get(`${api}/api/v1/events?limit=1`)).json();
  const before = databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'");
  const response = await request.post(`${api}/api/v1/events/${event.id}/summarize`, { data: { model: "not-an-authorized-model" } });
  expect([400, 412]).toContain(response.status());
  const after = await (await request.get(`${api}/api/v1/events/${event.id}`)).json();
  expect(after.summary).toBe(event.summary);
  expect(after.summaryKind).toBe("feed");
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe(before);
});

test("invalid pagination and hostile browser origins do not mutate data", async ({ request }) => {
  expect((await request.get(`${api}/api/v1/events?limit=-1`)).status()).toBe(400);
  expect((await request.post(`${api}/api/v1/admin/ingestion/run`, { headers: { origin: "https://untrusted.example" } })).status()).toBe(403);
});

test("gateway rejects malformed generation requests before touching Copilot", async ({ request }) => {
  const secret = process.env.COPILOT_GATEWAY_SHARED_SECRET;
  if (!secret) throw new Error("The isolated launcher must configure the gateway secret.");
  const gateway = process.env.SCOUTNEWS_E2E_GATEWAY_URL ?? "http://127.0.0.1:8787";
  const headers = { "x-scoutnews-gateway-secret": secret, authorization: "Bearer invalid-e2e-token-no-network" };
  const invalid = await request.post(`${gateway}/v1/generate`, { headers, data: { model: "", prompt: "" } });
  expect(invalid.status()).toBe(400);
  const malformed = await request.post(`${gateway}/v1/generate`, { headers: { ...headers, "content-type": "application/json" }, data: "{" });
  expect(malformed.status()).toBe(400);
  const oversized = await request.post(`${gateway}/v1/generate`, { headers, data: { prompt: "x".repeat(125_000) } });
  expect(oversized.status()).toBe(413);
});

test("local Copilot is isolated and disconnect preference persists without OAuth", async ({ request, page }) => {
  const gateway = process.env.SCOUTNEWS_E2E_GATEWAY_URL;
  const secret = process.env.COPILOT_GATEWAY_SHARED_SECRET;
  if (!gateway || !secret || process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE !== "true") {
    throw new Error("Run only through the isolated E2E launcher; never access personal login.");
  }
  const before = databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'");
  expect((await request.post(`${api}/api/v1/model-providers/github-copilot/local`)).status()).toBe(412);
  expect((await request.post(`${gateway}/v1/providers/copilot/local/probe`)).status()).toBe(401);
  const headers = { "x-scoutnews-gateway-secret": secret };
  expect((await request.post(`${gateway}/v1/providers/copilot/local/probe`, { headers })).status()).toBe(403);
  expect((await request.post(`${gateway}/v1/generate/local`, { headers, data: {
    model: "gpt-5.6-terra", system: "Do not run.", prompt: "Do not run.", sessionId: `scoutnews-${randomUUID()}`,
  } })).status()).toBe(412);
  const status = await (await request.get(`${api}/api/v1/model-providers`)).json();
  expect(status.items[0]).toMatchObject({ connected: false, authMode: null, model: null, models: [] });
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe(before);
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "连接本机 GitHub/Copilot" })).toBeDisabled();
  await expect(page.getByText("隔离测试模式：不会读取本机凭据或调用真实模型。", { exact: true })).toBeVisible();
  const disconnected = await request.delete(`${api}/api/v1/model-providers/github-copilot`);
  expect(disconnected.ok()).toBeTruthy();
  expect(databaseQuery("SELECT value FROM app_settings WHERE key='copilot_auth_mode'")).toBe("disconnected");
});
