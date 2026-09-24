import { expect, test } from "@playwright/test";

const apiUrl = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";
const gatewayUrl = process.env.SCOUTNEWS_E2E_GATEWAY_URL ?? "http://127.0.0.1:8787";

test("real official feeds become persisted events and are readable in the UI", async ({ page, request }) => {
  test.setTimeout(300_000);
  const health = await request.get(`${apiUrl}/health`);
  expect(health.ok()).toBeTruthy();

  const run = await request.post(`${apiUrl}/api/v1/admin/ingestion/run`, { timeout: 270_000 });
  expect(run.ok()).toBeTruthy();
  const result = await run.json() as { attempted: number; succeeded: number; failed: number; ingested: number };
  expect(result.attempted).toBeGreaterThanOrEqual(4);
  expect(result.succeeded).toBe(result.attempted);
  expect(result.failed).toBe(0);
  expect(result.ingested).toBeGreaterThan(0);

  const apiEvents = await request.get(`${apiUrl}/api/v1/events`);
  const payload = await apiEvents.json() as { items: Array<{ id: string; title: string; evidence: Array<{ url: string; sourceName: string }> }> };
  expect(payload.items.length).toBeGreaterThan(0);
  const event = payload.items.find(item => item.evidence.some(evidence => /openai\.com|deepmind\.google|github\.com|rust-lang\.org/.test(evidence.url)));
  expect(event, "at least one event must come from a live official feed").toBeTruthy();

  await page.goto("/radar");
  await expect(page.getByRole("heading", { name: event!.title })).toBeVisible();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: event!.title }) });
  await card.getByRole("button", { name: /^阅读：/ }).click();
  const reader=page.getByRole("article",{name:"文章就地阅读",exact:true});
  await expect(reader).toContainText(event!.evidence[0].sourceName);
  const original = reader.getByRole("link", { name: /查看原始来源/ }).first();
  await expect(original).toHaveAttribute("href", /^https:/);
});

test("saved state persists through PostgreSQL and appears in the saved view", async ({ page, request }) => {
  const response = await request.get(`${apiUrl}/api/v1/events`);
  const { items } = await response.json() as { items: Array<{ id: string; title: string; saved: boolean }> };
  expect(items.length).toBeGreaterThan(0);
  const event = items[0];
  const save = await request.put(`${apiUrl}/api/v1/events/${event.id}/state`, { data: { saved: true } });
  expect(save.ok()).toBeTruthy();

  await page.goto("/saved");
  await expect(page.getByRole("heading", { name: event.title })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: event.title })).toBeVisible();
});

test("Copilot gateway rejects calls that bypass the internal secret", async ({ request }) => {
  const response = await request.post(`${gatewayUrl}/v1/providers/copilot/probe`, {
    headers: { Authorization: "Bearer intentionally-invalid" },
  });
  expect(response.status()).toBe(401);
});
