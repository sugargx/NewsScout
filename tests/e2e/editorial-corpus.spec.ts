import { performance } from "node:perf_hooks";
import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:18080";

test("editorial corpus improves the captured September selection without rewriting reading history", async ({ request }, info) => {
  test.skip(process.env.SCOUTNEWS_E2E_CORPUS_BACKUP !== "true", "Requires an explicitly restored isolated corpus.");
  test.setTimeout(180_000);
  const fingerprint = () => databaseQuery("SELECT md5(COALESCE(jsonb_agg(snapshot ORDER BY brief_id,rank)::text,'[]')) FROM daily_brief_items");
  const before = fingerprint();
  const started = performance.now();
  const response = await request.get(`${api}/api/v1/briefs/latest`, { timeout: 60_000 });
  expect(response.ok(), await response.text()).toBe(true);
  const brief = await response.json();
  const briefMs = Math.round(performance.now() - started);
  const excluded = new Set([
    "8312d80b-e338-4a39-a64d-31c5030485fe",
    "b37d6ec0-6b8c-4542-ace0-6a4125c35978",
    "8afe520f-a92e-45f5-8852-cf230c9ecc4d",
    "8ccd9324-ffed-42b4-9c8e-ee44e44f84bc",
  ]);
  expect(brief.items.length).toBeGreaterThan(0);
  expect(brief.items.length).toBeLessThanOrEqual(20);
  expect(brief.items.every((item: { id: string }) => !excluded.has(item.id))).toBe(true);
  expect(brief.items.every((item: { editorial: { briefEligible: boolean } }) => item.editorial.briefEligible)).toBe(true);
  const topTier = brief.items.filter((item: { evidence: { sourceTier: string }[] }) => item.evidence.some(source => source.sourceTier === "T1"));
  expect(topTier.length).toBeGreaterThan(0);
  expect(brief.sections.some((section: { kind: string }) => section.kind === "catch_up")).toBe(true);
  expect(brief.sections.flatMap((section: { eventIds: string[] }) => section.eventIds))
    .toEqual(brief.items.map((item: { id: string }) => item.id));

  const benResponse = await request.get(`${api}/api/v1/events/8ccd9324-ffed-42b4-9c8e-ee44e44f84bc`, { timeout: 60_000 });
  expect(benResponse.ok()).toBe(true);
  const ben = await benResponse.json();
  expect(ben.topics).toContain("治理与政策");
  expect(ben.topics).toEqual(ben.recommendation.facets);
  expect(ben.editorial.briefEligible).toBe(false);
  expect(ben.editorial.valueScore).toBeLessThanOrEqual(45);
  const preview=ben.evidence.find((source:{url:string})=>source.url.includes("stratechery.com")).readingContext;
  expect(preview.status).toBe("partial");
  expect(preview.accessLimit).toBe("paywall");
  expect(preview.body).toContain("Dario Amodei");
  expect(preview.body.length).toBeLessThan(600);
  expect(preview.body).not.toContain("Subscribe to Stratechery Plus");
  expect(Number(databaseQuery(`SELECT max(length(ci.metadata->'readingContext'->>'body'))
    FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
    WHERE ee.event_id='8ccd9324-ffed-42b4-9c8e-ee44e44f84bc'`))).toBeGreaterThan(600);
  const questionResponse = await request.get(`${api}/api/v1/events/8312d80b-e338-4a39-a64d-31c5030485fe`, { timeout: 60_000 });
  expect(questionResponse.ok()).toBe(true);
  const question = await questionResponse.json();
  expect(question.editorial.contentKind).toBe("question");
  expect(question.topics).not.toContain("记忆与检索");

  const weeklyStarted = performance.now();
  const weeklyResponse = await request.get(`${api}/api/v1/weekly`, { timeout: 60_000 });
  expect(weeklyResponse.ok(), await weeklyResponse.text()).toBe(true);
  const weekly = await weeklyResponse.json();
  const weeklyMs = Math.round(performance.now() - weeklyStarted);
  expect(weekly.items.length).toBeGreaterThan(0);
  expect(weekly.items.every((item: { id: string }) => !excluded.has(item.id))).toBe(true);
  expect(weekly.sections.every((section: { kind: string }) => section.kind === "topic")).toBe(true);
  expect(weekly.sections.flatMap((section: { eventIds: string[] }) => section.eventIds))
    .toEqual(weekly.items.map((item: { id: string }) => item.id));
  const archiveStarted=performance.now();
  const archiveResponse=await request.get(`${api}/api/v1/events?hours=0&coverage=true&sort=newest&limit=1`,{timeout:60_000});
  expect(archiveResponse.ok(),await archiveResponse.text()).toBe(true);
  expect((await archiveResponse.json()).items).toHaveLength(1);
  const archiveListMs=Math.round(performance.now()-archiveStarted);
  expect(fingerprint()).toBe(before);
  const report = {
    briefMs, weeklyMs, archiveListMs, archiveFingerprint: before,
    brief: brief.items.map((item: { id: string; title: string; primaryTopic: string; editorial: object; evidence: { sourceName: string; sourceTier: string }[] }) => ({
      id: item.id, title: item.title, topic: item.primaryTopic, editorial: item.editorial,
      source: item.evidence[0]?.sourceName, tier: item.evidence[0]?.sourceTier,
    })),
    sections: brief.sections, weeklySections: weekly.sections, topTierCount: topTier.length,
  };
  await info.attach("editorial-corpus-comparison", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  console.log(JSON.stringify(report));
  expect(briefMs).toBeLessThan(15_000);
  expect(weeklyMs).toBeLessThan(15_000);
  expect(archiveListMs).toBeLessThan(15_000);
});
