import {expect, test, type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import type {Event} from "../../apps/web/src/types";
import {startPublicReader} from "../../services/public-reader/server.cjs";
import {databaseQuery} from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "";
const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
const title = "从教师指导到自主探索：两种学习方式如何共同改进模型训练";
const body = "这是一份合成的去重测试材料，并非真实研究报道。本文讨论两种训练方法之间的互补关系：一种依靠教师提供示例与反馈，另一种通过自主探索积累可迁移的经验。作者逐项比较了训练数据的组织方式、推理时的学习过程和评估任务，强调应区分记住答案与学会解决问题。结尾说明实验条件与适用范围，并保留原始资料链接，供读者独立核查论述。";
const preserved = () => databaseQuery(`SELECT json_build_object(
  'snapshots',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM daily_brief_items t),
  'settings',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM app_settings t),
  'attempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))`);
type EventPage = {items: Event[]; nextOffset: number | null; returnedEventCount: number};
const members = (event: Event) => event.coverage?.members.map(member => member.eventId) ?? [event.id];

test.beforeEach(() => {
  if (process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE !== "true" || api !== "http://127.0.0.1:18080")
    throw new Error("Radar quality requires the isolated live launcher.");
});

function seed() {
  const tag = `radar-quality-${randomUUID()}`;
  const sourceIds = [randomUUID(), randomUUID()];
  const publisherIds = [randomUUID(), randomUUID()];
  const definitions = [
    {key: "original", title, hours: 3, type: "blog", source: 0, url: "https://first.example/2026/10/505443", body},
    {key: "copy", title: title.replace("：", "——"), hours: 1, type: "blog", source: 1, url: "https://second.example/2026/10/120702", body},
    {key: "build-a", title: "trunk/59939c003f6b3eb8add709e5897f7bfbe3e9f4d8: Align XPU test decorators (#186089)", hours: 0.3, type: "release", source: 0, url: "https://github.com/pytorch/pytorch/releases/tag/trunk%2F59939c003f6b3eb8add709e5897f7bfbe3e9f4d8", body: "Internal XPU test record for pull request 186089."},
    {key: "build-b", title: "ciflow/xpu/202109: Drop nightly auto-bumps", hours: 0.5, type: "release", source: 0, url: "https://github.com/pytorch/pytorch/releases/tag/ciflow%2Fxpu%2F202109", body: "Internal build automation change."},
    {key: "version", title: "PyTorch 2.9.0", hours: 4, type: "release", source: 0, url: "https://github.com/pytorch/pytorch/releases/tag/v2.9.0", body: "A user-facing release with installation and migration instructions."},
    {key: "different-a", title: "Weekly AI research and engineering update", hours: 5, type: "blog", source: 0, url: "https://first.example/research", body: "A research review of dataset annotation, experiment design and model training. The authors describe reproducibility conditions and limitations of the measurement protocol."},
    {key: "different-b", title: "Weekly AI research and engineering update", hours: 6, type: "blog", source: 1, url: "https://second.example/network", body: "A review of datacenter networking, storage reliability and hardware scheduling. It concerns a separate infrastructure deployment and does not report a model training experiment."},
    {key: "middle", title: "A separate inference tracing announcement", hours: 2, type: "blog", source: 0, url: "https://first.example/tracing", body: "An independent launch with a new tracing interface and a documented local walkthrough."},
    {key: "short-a", title: "A major assistant update will be announced today", hours: 7, type: "blog", source: 0, url: "https://first.example/short", body: "Read more."},
    {key: "short-b", title: "A major assistant update will be announced today", hours: 7.1, type: "blog", source: 1, url: "https://second.example/short", body: "Material unavailable."},
  ];
  const fixtures = definitions.map(item => ({...item, id: randomUUID(), content: randomUUID()}));
  databaseQuery(`BEGIN;
    INSERT INTO publishers(id,name,entity_type) VALUES
      (${literal(publisherIds[0])},'质量测试来源甲','publication'),(${literal(publisherIds[1])},'质量测试来源乙','publication');
    INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
    VALUES ${sourceIds.map((id, index) => `(${literal(id)},${literal(publisherIds[index])},${literal(index ? "质量测试来源乙" : "质量测试来源甲")},
      ${literal(`https://${tag}.example/${index}`)},'blog','rss','T2','stable',now())`).join(",")};
    INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at,
      summary_kind,summary_format_version,summary_points,summary_model,content_version)
    VALUES ${fixtures.map(item => `(${literal(item.id)},${literal(item.title)},${literal(`${tag} ${item.key}: 独立保留该来源的摘要。`)},
      'Isolated fixture','AI Infra',${literal(item.type)},now()-interval '${item.hours} hours',now()-interval '${item.hours} hours',
      ${literal(item.key.startsWith("build") ? "feed" : "copilot")},4,'["比较教师反馈与自主探索的作用，并说明实验条件。"]','isolated-fixture',1)`).join(",")};
    INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,published_at,content_hash,metadata)
    VALUES ${fixtures.map(item => `(${literal(item.content)},${literal(sourceIds[item.source])},${literal(item.type)},
      ${literal(item.url)},${literal(item.url)},${literal(item.title)},now()-interval '${item.hours} hours',${literal(item.content)},
      ${literal(JSON.stringify({feedSummary: item.key === "original" || item.key === "copy" ? "A short source preview." : item.body,
        readingContext: {version: 1, kind: item.type === "release" ? "release" : "article", origin: "publisher_page", status: "available",
          sourceUrl: item.url, body: item.body, truncated: false, durationSeconds: null, chapters: [], transcriptUrl: null,
          comments: [], commentsStatus: "not_applicable", fetchedAt: null}, sourceMetadata: {datePrecision: "time"}}))}::jsonb)`).join(",")};
    INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES
      ${fixtures.map(item => `(${literal(item.id)},${literal(item.content)},${item.type === "release"})`).join(",")};
    COMMIT;`);
  const ids = fixtures.map(item => literal(item.id)).join(",");
  const sources = sourceIds.map(literal).join(",");
  return {tag, fixtures, sourceIds, cleanup: () => databaseQuery(`
    DELETE FROM user_event_states WHERE event_id IN(${ids});
    DELETE FROM event_evidence WHERE event_id IN(${ids});
    DELETE FROM events WHERE id IN(${ids});
    DELETE FROM content_items WHERE source_id IN(${sources});
    DELETE FROM sources WHERE id IN(${sources});
    DELETE FROM publishers WHERE id IN(${publisherIds.map(literal).join(",")});`)};
}

async function events(request: APIRequestContext, parameters: Record<string, string>, origin = api, path = "/api/v1/events") {
  const response = await request.get(`${origin}${path}?${new URLSearchParams(parameters)}`);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as EventPage;
}

async function detail(request: APIRequestContext, id: string) {
  const response = await request.get(`${api}/api/v1/events/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as Event;
}

test("radar quality folds original copies, isolates builds and keeps member state on desktop and mobile", async ({request, page}, info) => {
  test.setTimeout(240_000);
  const before = preserved(), fixture = seed();
  const byKey = new Map(fixture.fixtures.map(item => [item.key, item]));
  const original = byKey.get("original")!, copy = byKey.get("copy")!, build = byKey.get("build-a")!, middle = byKey.get("middle")!;
  const query = {q: fixture.tag, hours: "0", sort: "newest", limit: "100", asOf: new Date().toISOString()};
  try {
    const raw = await events(request, {...query, includeEngineering: "true"});
    expect(raw.items).toHaveLength(10);
    const grouped = await events(request, {...query, coverage: "true"});
    expect(grouped.items).toHaveLength(7);
    expect(grouped.returnedEventCount).toBe(8);
    expect(grouped.items.flatMap(members)).not.toContain(build.id);
    const article = grouped.items.find(event => event.coverage?.relation === "same_article")!;
    expect(article.id).toBe(original.id);
    expect(members(article).sort()).toEqual([original.id, copy.id].sort());
    expect(article.coverage!.popularityBoost).toBe(0);
    expect(article.summary).toBe(raw.items.find(event => event.id === original.id)!.summary);
    expect(article.recommendation?.score).toBe(raw.items.find(event => event.id === original.id)!.recommendation?.score);
    expect(grouped.items.findIndex(event => event.id === middle.id)).toBeLessThan(grouped.items.findIndex(event => event.id === original.id));
    const engineering = await events(request, {...query, coverage: "true", includeEngineering: "true"});
    expect(engineering.items).toHaveLength(8);
    const development = engineering.items.find(event => event.coverage?.relation === "development_activity")!;
    expect(development.coverage!.topic).toContain("pytorch/pytorch");
    expect(development.coverage!.popularityBoost).toBe(0);
    expect(engineering.items.some(event => event.id === byKey.get("version")!.id)).toBe(true);
    expect((await detail(request, build.id)).summaryStatus).toBe("manual_only");
    const singleSource = await events(request, {...query, coverage: "true", source: fixture.sourceIds[1]});
    expect(singleSource.items.find(event => event.id === copy.id)?.coverage).toBeUndefined();
    for (const id of [original.id, copy.id])
      expect(members(await detail(request, id)).sort()).toEqual([original.id, copy.id].sort());
    const paged: string[] = [];
    for (let offset = 0; offset < grouped.items.length; offset++) {
      const result = await events(request, {...query, coverage: "true", limit: "1", offset: String(offset)});
      paged.push(result.items[0].id);
    }
    expect(paged).toEqual(grouped.items.map(event => event.id));
    expect((await request.put(`${api}/api/v1/events/${copy.id}/state`, {data: {saved: true}})).ok()).toBe(true);
    const saved = await events(request, {...query, coverage: "true", saved: "true"});
    expect(saved.items.map(event => event.id)).toEqual([copy.id]);
    expect(saved.items[0].coverage).toBeUndefined();
    expect((await detail(request, original.id)).saved).toBe(false);

    await page.goto(`/radar?q=${encodeURIComponent(fixture.tag)}&hours=0&sort=newest`);
    await expect(page.locator("article[data-event-id]")).toHaveCount(7);
    const row = page.locator(`article[data-event-id="${original.id}"]`);
    const reader = page.getByRole("article", {name: "文章就地阅读", exact: true});
    await expect(row.getByRole("button", {name: title, exact: true})).toBeVisible();
    await expect(row.locator(".cp-coverage > summary")).toContainText("2 个来源 · 同稿折叠");
    await expect(row.locator(".ns-article-source")).toContainText("等 2 个来源");
    await row.locator(".cp-coverage > summary").click();
    await expect(row.locator("[data-coverage-member]")).toHaveCount(2);
    for (const width of [1440, 390]) {
      await page.setViewportSize({width, height: 1000});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({path: info.outputPath(`synthetic-radar-quality-${width}.png`), fullPage: true});
    }
    await row.getByRole("button", {name: title, exact: true}).first().click();
    await expect(reader).toBeVisible();
    await expect(reader.getByRole("heading", {name: title, exact: true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path: info.outputPath("synthetic-copy-reader-390.png"), fullPage: true});
    await reader.getByRole("button", {name: "返回列表", exact: true}).click();
    await expect(reader).toBeHidden();
    await expect(row.getByRole("button", {name: title, exact: true}).first()).toBeVisible();
    await page.setViewportSize({width: 1440, height: 1000});
    await row.getByRole("button", {name: title, exact: true}).first().click();
    await expect(reader).toBeVisible();
    await reader.getByRole("button", {name: `不感兴趣：${title}`, exact: true}).click();
    await expect(row.locator(`[data-coverage-member="${original.id}"]`)).toHaveCount(0);
    await expect(row.locator(`[data-coverage-member="${copy.id}"]`)).toBeVisible();
    await expect(row.locator(".ns-opened-mark")).toHaveCount(0);
    await row.getByRole("button", {name: title, exact: true}).first().click();
    await expect(reader.getByRole("heading", {name: copy.title, exact: true})).toBeVisible();
    await page.screenshot({path: info.outputPath("synthetic-copy-reader-1440.png"), fullPage: true});
    expect((await detail(request, original.id)).notInterested).toBe(true);
    expect((await detail(request, copy.id)).notInterested).toBe(false);
    const publicServer = await startPublicReader({apiOrigin: api, distRoot: resolve("apps", "web", "dist"), port: 0});
    try {
      const address = publicServer.address();
      if (!address || typeof address === "string") throw new Error("Public reader failed to bind");
      const publicResult = await events(request, {...query, limit: "40", interests: "engineering:50"},
        `http://127.0.0.1:${address.port}`, "/beta/api/events");
      const publicCopy = publicResult.items.find(event => event.coverage?.relation === "same_article")!;
      expect(members(publicCopy).sort()).toEqual([original.id, copy.id].sort());
      expect(publicResult.items.flatMap(members)).not.toContain(build.id);
      expect(publicCopy.saved).toBeFalsy();
    } finally {
      await new Promise<void>((done, reject) => {
        publicServer.close((error?: Error) => error ? reject(error) : done());
        publicServer.closeAllConnections();
      });
    }
    await page.goto(`/radar?q=${encodeURIComponent(fixture.tag)}&hours=0&sort=newest&includeEngineering=true`);
    const buildRow = page.locator(`article[data-event-id="${development.id}"]`);
    await expect(buildRow.getByRole("heading", {name: /pytorch\/pytorch.*开发动态/})).toBeVisible();
    await buildRow.locator(".cp-coverage > summary").click();
    await expect(buildRow.locator("[data-coverage-member]")).toHaveCount(2);
    await page.setViewportSize({width: 390, height: 1000});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path: info.outputPath("synthetic-development-opt-in-390.png"), fullPage: true});
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { fixture.cleanup(); expect(preserved()).toBe(before); }
  }
});
