import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";
import type { Event } from "../../apps/web/src/types";
import { projectArticle } from "../../services/public-reader/server.cjs";
import { publicDate } from "../../apps/web/src/public-reader";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:18080";
const original = "https://x.com/karpathy/status/2083749667410727319";

test("X registered original previews preserve real dates, identity, passivity and limited coverage", async ({ request }) => {
  test.setTimeout(180_000);
  databaseQuery("SELECT 1");
  const created = await request.post(`${api}/api/v1/sources`, { data: {
    name: "X original preview E2E", endpoint: "https://x.com/karpathy",
    adapter: "x_public_preview", contentType: "blog", tier: "T2", scheduleMinutes: 1440,
    originalPostUrls: [original],
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const source = await created.json();
  expect(source.id).toMatch(/^[0-9a-f-]{36}$/);
  const endpoint = `${api}/api/v1/sources/${source.id}/x-posts`;
  expect((await request.get(`${api}/api/v1/sources/ffffffff-ffff-4fff-8fff-ffffffffffff/x-posts`)).status()).toBe(404);
  const fingerprint = () => databaseQuery("SELECT md5(jsonb_build_object('fetches',(SELECT count(*) FROM fetch_runs),'attempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))::text)");
  const before = fingerprint();
  expect((await (await request.get(endpoint)).json()).urls).toEqual([original]);
  expect(fingerprint()).toBe(before);
  const invalid = await request.put(endpoint, { data: { urls: ["https://x.com/dotey/status/2083749667410727319"] } });
  expect(invalid.status()).toBe(400);
  expect((await request.put(endpoint, { data: { urls: [] } })).status()).toBe(400);
  expect((await request.put(endpoint, { data: { urls: Array.from({ length: 21 }, () => original) } })).status()).toBe(400);
  expect((await (await request.get(endpoint)).json()).urls).toEqual([original]);
  const registered = await request.put(endpoint, { data: { urls: [original, `${original}?s=20&t=share`] } });
  expect(registered.ok(), await registered.text()).toBe(true);
  expect((await registered.json()).urls).toEqual([original]);
  expect(fingerprint()).toBe(before);
  expect((await request.put(endpoint, { headers: { Origin: "https://untrusted.example" }, data: { urls: [original] } })).status()).toBe(403);
  const refresh = await request.post(`${api}/api/v1/sources/${source.id}/refresh`, { timeout: 100_000 });
  expect(refresh.ok(), await refresh.text()).toBe(true);
  const report = await refresh.json();
  expect(report.failed, JSON.stringify(report)).toBe(0);
  expect(report.ingested).toBe(1);
  const { items }: { items: Event[] } = await (await request.get(`${api}/api/v1/events?source=${source.id}&hours=0&limit=20`)).json();
  expect(items).toHaveLength(1);
  expect(items[0].publicationPrecision).toBe("day");
  expect(items[0].publishedAt).toMatch(/^2026-08-02T/);
  expect(items[0].evidence[0].readingContext == null).toBe(true);
  const detail: Event = await (await request.get(`${api}/api/v1/events/${items[0].id}`)).json();
  expect(detail.evidence[0].url).toBe(original);
  expect(detail.evidence[0].readingContext).toMatchObject({ kind: "post", status: "partial", truncated: true, sourceUrl: original, comments: [] });
  expect(detail.evidence[0].readingContext?.body.length).toBeGreaterThan(50);
  const publicArticle = projectArticle({ ...detail, privateRegistry: "OWNER_REGISTRY_SENTINEL" });
  expect(publicArticle.publicationPrecision).toBe("day");
  expect(publicDate(publicArticle.publishedAt,publicArticle.publicationPrecision)).toBe("2026/8/2");
  expect(publicArticle.evidence[0].readingContext).toMatchObject({ kind: "post", truncated: true, sourceUrl: original });
  expect(JSON.stringify(publicArticle)).not.toContain("OWNER_REGISTRY_SENTINEL");
  expect((await (await request.get(`${api}/api/v1/events?source=${source.id}&hours=72&limit=20`)).json()).items).toEqual([]);
  const again = await request.post(`${api}/api/v1/sources/${source.id}/refresh`, { timeout: 100_000 });
  expect(again.ok(), await again.text()).toBe(true);
  expect((await again.json()).ingested).toBe(0);
  const repeated: Event = await (await request.get(`${api}/api/v1/events/${items[0].id}`)).json();
  expect(repeated.contentVersion).toBe(detail.contentVersion);
  const coverage = await (await request.get(`${api}/api/v1/sources/coverage`)).json();
  expect(coverage.items.find((item: { id: string }) => item.id === "x")).toMatchObject({ status: "partial", sourceCount: 1, coverage: "registered_posts_only" });
  databaseQuery(`UPDATE sources SET cache_meta=cache_meta||jsonb_build_object('xProviderRetryAfter',now()+interval '1 hour') WHERE id='${source.id}'`);
  const cooldown = databaseQuery(`SELECT cache_meta->>'xProviderRetryAfter' FROM sources WHERE id='${source.id}'`);
  expect((await request.put(endpoint, { data: { urls: [original] } })).ok()).toBe(true);
  expect(databaseQuery(`SELECT cache_meta->>'xProviderRetryAfter' FROM sources WHERE id='${source.id}'`)).toBe(cooldown);
  const blocked = await request.post(`${api}/api/v1/sources/${source.id}/refresh`);
  expect(blocked.ok(), await blocked.text()).toBe(true);
  expect(await blocked.json()).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, ingested: 0, updated: 0 });
  const retained: Event = await (await request.get(`${api}/api/v1/events/${items[0].id}`)).json();
  expect(retained.contentVersion).toBe(detail.contentVersion);
  expect(retained.evidence[0].readingContext?.body).toBe(detail.evidence[0].readingContext?.body);
});
