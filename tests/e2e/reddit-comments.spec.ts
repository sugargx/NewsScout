import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";
import type { Event, Source } from "../../apps/web/src/types";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:18080";

test("reddit comments respect source policy, retain post content, and never fabricate success", async ({ request }) => {
  test.setTimeout(180_000);
  const { items: sources }: { items: Source[] } = await (await request.get(`${api}/api/v1/sources`)).json();
  const source = sources.find(item => item.endpoint === "https://www.reddit.com/r/LocalLLaMA/.rss");
  if (!source) throw new Error("The original Reddit listing subscription is required.");
  const refreshed = await request.post(`${api}/api/v1/sources/${source.id}/refresh`, { timeout: 90_000 });
  expect(refreshed.ok(), await refreshed.text()).toBe(true);
  expect((await refreshed.json()).succeeded).toBe(1);
  const { items }: { items: Event[] } = await (await request.get(`${api}/api/v1/events?source=${source.id}&hours=0&limit=1`)).json();
  expect(items).toHaveLength(1);
  const id = items[0].id;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const original: Event = await (await request.get(`${api}/api/v1/events/${id}`)).json();
  expect(original.evidence[0].readingContext?.kind).toBe("post");
  const fingerprint = () => databaseQuery(`SELECT md5(jsonb_build_object(
    'event',(SELECT to_jsonb(e) FROM events e WHERE id='${id}'),
    'material',(SELECT jsonb_agg(ci.metadata ORDER BY ci.id) FROM content_items ci JOIN event_evidence ee ON ee.content_item_id=ci.id WHERE ee.event_id='${id}'),
    'modelAttempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))::text)`);
  const before = fingerprint();
  const response = await request.post(`${api}/api/v1/events/${id}/reading-context`, { timeout: 65_000 });
  expect(response.ok(), await response.text()).toBe(true);
  const report = await response.json();
  expect(report.attempted).toBe(1);
  expect(report.failed).toBe(1);
  expect(report.succeeded).toBe(0);
  expect(report.updated).toBe(0);
  expect(report.errors.join(" ")).toContain("robots policy");
  expect(fingerprint()).toBe(before);
  const after: Event = await (await request.get(`${api}/api/v1/events/${id}`)).json();
  expect(after.evidence[0].readingContext).toEqual(original.evidence[0].readingContext);
  expect(after.evidence[0].readingContext?.comments).toEqual([]);
  const retry = await request.post(`${api}/api/v1/events/${id}/reading-context`);
  expect(retry.ok(), await retry.text()).toBe(true);
  expect((await retry.json()).errors.join(" ")).toContain("退避");
  expect(fingerprint()).toBe(before);
});
