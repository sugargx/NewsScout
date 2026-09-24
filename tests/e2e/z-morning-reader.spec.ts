import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { databaseQuery } from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";
const literal = (value: unknown) => value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  if (process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE !== "true") throw new Error("Use isolated live E2E.");
  if (Number(databaseQuery("SELECT count(*) FROM events")) === 0) {
    const response = await request.post(`${api}/api/v1/admin/ingestion/run`, { timeout: 270_000 });
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).succeeded).toBeGreaterThanOrEqual(4);
  }
});

test("morning reader settings and publication clocks are explicit and persisted", async ({ request }) => {
  const status = await (await request.get(`${api}/api/v1/reader-status`)).json();
  expect(status.settings).toEqual({ mode: "daily", hour: 6, includeObserving: true, briefLimit: 20 });
  expect(status.timeZone).toBe("Asia/Shanghai");
  expect(status.lastCollectionAt).not.toBeNull();
  expect(status.latestPublishedAt).not.toBeNull();
  expect(status.morningRun).toBeNull();
  const next = new Date(Date.parse(status.nextCollectionAt) + 8 * 3600000);
  expect(next.getUTCHours()).toBe(6);
  expect((await request.put(`${api}/api/v1/reader-settings`, { data: { mode: "daily", hour: 24 } })).status()).toBe(400);
  expect((await request.put(`${api}/api/v1/reader-settings`, { data: { mode: "invalid", hour: 6 } })).status()).toBe(400);
  try {
    expect((await request.put(`${api}/api/v1/reader-settings`, { data: { mode: "interval", hour: 6 } })).ok()).toBeTruthy();
    expect(JSON.parse(databaseQuery("SELECT value FROM app_settings WHERE key='reader_settings'"))).toMatchObject({ mode: "interval", hour: 6 });
    expect((await (await request.get(`${api}/api/v1/reader-status`)).json()).nextCollectionAt).toBeNull();
  } finally {
    await request.put(`${api}/api/v1/reader-settings`, { data: status.settings });
  }
  const { items: [event] } = await (await request.get(`${api}/api/v1/events?limit=1`)).json();
  const expected = JSON.parse(databaseQuery(`SELECT json_build_object(
    'published',max(ci.published_at),'collected',max(ci.created_at)) FROM event_evidence ee
    JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id='${event.id}'`));
  expect(Date.parse(event.publishedAt)).toBe(Date.parse(expected.published));
  expect(Date.parse(event.collectedAt)).toBe(Date.parse(expected.collected));
  expect(event.evidence[0]).toHaveProperty("originalPublishedAt");
  expect(event.evidence[0]).toHaveProperty("collectedAt");
  expect(event.evidence[0]).toHaveProperty("publicationPrecision");
  const { items } = await (await request.get(`${api}/api/v1/events?sort=newest&limit=100`)).json();
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1].publishedAt ? Date.parse(items[index - 1].publishedAt) : -Infinity;
    const current = items[index].publishedAt ? Date.parse(items[index].publishedAt) : -Infinity;
    expect(previous).toBeGreaterThanOrEqual(current);
  }
});

test("morning reader upgrades retain old summaries until a replacement completes", async ({ request }) => {
  const id = databaseQuery("SELECT id FROM events WHERE summary_kind='feed' ORDER BY id LIMIT 1");
  const original = await (await request.get(`${api}/api/v1/events/${id}`)).json();
  try {
    // Only the disposable database's queue/provenance state is simulated; no model is called.
    databaseQuery(`UPDATE events SET summary_kind='copilot',summary_format_version=3,summary_model='gpt-5.6-terra',summary_reasoning_effort='low' WHERE id='${id}'`);
    expect(databaseQuery(`SELECT status FROM summary_jobs WHERE event_id='${id}'`)).toBe("completed");
    databaseQuery(`UPDATE events SET summary_format_version=1 WHERE id='${id}'`);
    const upgrading = await (await request.get(`${api}/api/v1/events/${id}`)).json();
    expect(upgrading.summary).toBe(original.summary);
    expect(upgrading.summaryKind).toBe("copilot");
    expect(upgrading.summaryStatus).toBe("pending");
    expect(upgrading.summaryFormatVersion).toBe(1);
    expect(databaseQuery(`SELECT format_version FROM summary_jobs WHERE event_id='${id}'`)).toBe("3");
  } finally {
    databaseQuery(`UPDATE events SET summary_kind='feed',summary_format_version=0,summary_model=NULL,summary_reasoning_effort=NULL WHERE id='${id}'`);
  }
});

test("morning reader keeps sparse briefs strict and snapshots immutable", async ({ request }) => {
  const events: Array<Record<string, string | number | null>> = JSON.parse(databaseQuery(`SELECT json_agg(row_to_json(selected)) FROM (
    SELECT e.id,e.updated_at,e.summary,e.summary_kind,e.summary_format_version,e.summary_model,e.summary_reasoning_effort FROM events e
    WHERE EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
      JOIN sources s ON s.id=ci.source_id WHERE ee.event_id=e.id AND s.lifecycle_status='stable')
    ORDER BY e.id LIMIT 6) selected`));
  expect(events.length).toBe(6);
  const ids = events.map(event => literal(event.id)).join(",");
  const contents: Array<{ id: string; published_at: string | null }> = JSON.parse(databaseQuery(`SELECT json_agg(row_to_json(selected)) FROM (
    SELECT id,published_at FROM content_items WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id IN(${ids}))) selected`));
  const today = (await (await request.get(`${api}/api/v1/briefs/today`)).json()).localDate;
  expect(databaseQuery(`SELECT count(*) FROM daily_briefs WHERE local_date=${literal(today)}`)).toBe("0");
  try {
    databaseQuery(`UPDATE content_items SET published_at=CASE WHEN id IN(
      SELECT content_item_id FROM event_evidence WHERE event_id=${literal(events[0].id)})
      THEN now()-interval '2 hours' ELSE now()-interval '2 days' END
      WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id IN(${ids}))`);
    databaseQuery(`UPDATE events SET summary_kind='copilot',summary_format_version=2,summary_model='gpt-5.6-terra',
      summary_reasoning_effort='low',updated_at=now()-interval '2 days' WHERE id IN(${ids})`);
    const preview = await (await request.get(`${api}/api/v1/briefs/today`)).json();
    // Selection v2: the main list only takes the last 24 hours; older material may only
    // enter as at most three high-value catch-up items, so a sparse day stays short.
    expect(preview.items[0].id).toBe(events[0].id);
    expect(Date.parse(preview.windowEnd) - Date.parse(preview.windowStart)).toBe(7 * 24 * 3600000);
    expect(Date.parse(preview.windowEnd) - Date.parse(preview.primaryWindowStart)).toBe(24 * 3600000);
    const sections: Array<{ kind: string; eventIds: string[] }> = preview.sections;
    const main = sections.filter(section => section.kind !== "catch_up").flatMap(section => section.eventIds);
    const catchUp = sections.filter(section => section.kind === "catch_up").flatMap(section => section.eventIds);
    expect(main).toContain(events[0].id);
    for (const older of events.slice(1)) expect(main).not.toContain(older.id);
    expect(catchUp.length).toBeLessThanOrEqual(3);
    for (const id of catchUp) {
      const editorial = preview.items.find((item: { id: string }) => item.id === id).editorial;
      expect(editorial.significance ?? 60).toBeGreaterThanOrEqual(60);
      expect(editorial.valueScore).toBeGreaterThanOrEqual(editorial.significance === undefined ? 68 : 70);
    }
    expect(preview.items.map((item: { id: string }) => item.id)).toEqual([...main, ...catchUp]);
    const response = await request.post(`${api}/api/v1/briefs/today/generate`, { data: {} });
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    expect(saved.isSnapshot).toBe(true);
    databaseQuery(`UPDATE events SET summary=summary || ' [isolated snapshot update]' WHERE id=${literal(events[0].id)}`);
    const historical = await (await request.get(`${api}/api/v1/briefs/${today}`)).json();
    expect(historical.items[0].summary).toBe(saved.items[0].summary);
    expect(historical.items[0].publishedAt).toBe(saved.items[0].publishedAt);
  } finally {
    databaseQuery(`DELETE FROM daily_brief_items WHERE brief_id IN(SELECT id FROM daily_briefs WHERE local_date=${literal(today)});
      DELETE FROM daily_briefs WHERE local_date=${literal(today)}`);
    for (const content of contents) databaseQuery(`UPDATE content_items SET published_at=${literal(content.published_at)} WHERE id=${literal(content.id)}`);
    for (const event of events) {
      const assignments = Object.entries(event).filter(([key]) => key !== "id").map(([key, value]) => `${key}=${literal(value)}`);
      databaseQuery(`UPDATE events SET ${assignments.join(",")} WHERE id=${literal(event.id)}`);
    }
  }
});

test("morning reader calendar claims survive retries without duplicate daily runs", () => {
  test.setTimeout(180_000);
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    ".\\scripts\\rust.ps1 -CargoArgs @('test','--quiet','morning_database_contract','--','--ignored')"],
  { env: process.env, encoding: "utf8", timeout: 150_000 });
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe("0");
});

test("morning reader filters align and source excerpts expand without overwhelming cards", async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    // The retired card view URL must keep working and fall back to the list.
    await page.goto("/radar?view=cards");
    await page.getByRole("article").first().waitFor();
    await expect(page.getByRole("tab", { name: "列表", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByText("更多筛选 · 时间与排序", { exact: true }).click();
    const sort = page.getByLabel("排序", { exact: true });
    await sort.selectOption("newest");
    const clear = page.getByRole("button", { name: "清除筛选", exact: true });
    const box = await clear.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(44);
    if (width === 1440) {
      const refreshBox = await page.getByRole("button", { name: "应用更新", exact: true }).boundingBox();
      expect(Math.abs(box!.y + box!.height - refreshBox!.y - refreshBox!.height)).toBeLessThanOrEqual(2);
    }
    await clear.click();
    await expect(sort).toHaveValue("recommended");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  // Long source excerpts stay within two lines in the list; the in-place reader carries the material.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const previews = page.locator("article[data-event-id] .ns-reader-row-preview");
  await previews.first().waitFor();
  const index = await previews.evaluateAll(nodes => nodes.findIndex(node => node.scrollHeight > node.clientHeight + 1));
  expect(index, "a long source excerpt must be clamped in the list").toBeGreaterThanOrEqual(0);
  const preview = previews.nth(index);
  const lineHeight = await preview.evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
  expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 2 + 2);
  const excerpt = (await preview.textContent())!.replace(/^基于聚合摘要 · /, "").replace(/\s+/g, "");
  await preview.locator("xpath=ancestor::article[1]").getByRole("button", { name: /^阅读：/ }).click();
  const reader = page.getByRole("article", { name: "文章就地阅读", exact: true });
  await expect(reader).toBeVisible();
  await expect.poll(() => reader.evaluate(node => node.textContent!.replace(/\s+/g, ""))).toContain(excerpt.slice(0, 30));
});
