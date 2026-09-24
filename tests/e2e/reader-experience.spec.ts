import { expect, test, type Page } from "@playwright/test";
import { formatSourceDuration, formatSourceTimestamp, hasDetailSourceContent, sourceReadingModel } from "../../apps/web/src/components/SourceReading";
import type { Event, ReadingContext } from "../../apps/web/src/types";

const api=process.env.SCOUTNEWS_E2E_API_URL!;
const fixtureId="a1000000-0000-4000-8000-000000000001";
const sourceTail="SOURCE_CONTEXT_FINAL_PORTION";
const capturedArticleBody=`已收录正文 ${"甲".repeat(6_010-"已收录正文 ".length-sourceTail.length)}${sourceTail}`;

function readerFixture(withCapturedContext=false):Event {
  const context:ReadingContext|undefined=withCapturedContext?{
    version:1,kind:"article",origin:"publisher_page",status:"available",sourceUrl:"https://example.com/captured-article",
    body:capturedArticleBody,truncated:false,durationSeconds:null,chapters:[],transcriptUrl:null,
    comments:[],commentsStatus:"not_applicable",fetchedAt:"2026-09-11T00:00:00.000Z",
  }:undefined;
  return {
    id:fixtureId,contentVersion:1,title:"受控测试：渐进式阅读详情",summary:"这是受控测试的完整摘要，用于验证列表预览与详情展示之间的层级。",
    importance:"high",primaryTopic:"测试",topics:["测试"],eventType:"blog",firstSeenAt:"2026-09-11T00:00:00.000Z",
    updatedAt:"2026-09-11T00:00:00.000Z",publishedAt:"2026-09-11T00:00:00.000Z",freshnessAt:"2026-09-11T00:00:00.000Z",
    publicationPrecision:"time",collectedAt:"2026-09-11T00:00:00.000Z",summaryFormatVersion:1,
    summaryPoints:[
      "第一条受控摘要要点说明变化和背景。",
      "第二条受控摘要要点解释影响范围。",
      "第三条受控摘要要点说明实施条件。",
      "第四条受控摘要要点列出后续观察方向。",
      "第五条受控摘要要点说明风险边界。",
      "第六条受控摘要要点补充读者行动建议。",
    ],summaryMaterialLimit:null,summaryLimitations:[],
    evidence:[{id:"e1000000-0000-4000-8000-000000000001",sourceName:"受控发布者",sourceTier:"T1",title:"受控测试来源",
      url:"https://example.com/captured-article",isOfficial:true,publishedAt:"2026-09-11T00:00:00.000Z",
      publicationPrecision:"time",excerpt:"这是来源保留的简短摘录。",readingContext:context}],
    score:{sourceQuality:1,corroboration:1,freshness:1,relevance:1,novelty:1,engagement:1,editorialBoost:0,total:6,explanation:"fixture"},
    personalRelevance:0,personalReason:"fixture",saved:false,read:false,later:false,notInterested:false,seen:false,opened:false,
    recommendation:null,summaryKind:"copilot",summaryModel:null,summarizedAt:"2026-09-11T00:00:00.000Z",
    summaryEvidenceIds:["e1000000-0000-4000-8000-000000000001"],summaryStatus:"completed",
  };
}

test.beforeAll(async ({request}) => {
  if (process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE !== "true") throw new Error("Use the isolated E2E runner.");
  test.setTimeout(180_000);
  const api=process.env.SCOUTNEWS_E2E_API_URL!;
  const existing=await(await request.get(`${api}/api/v1/events?tier=T1&hours=720&limit=1`)).json();
  if(!existing.items.length) {
    const response=await request.post(`${api}/api/v1/sources/20000000-0000-0000-0000-000000000001/refresh`,{timeout:150_000});
    expect(response.ok(),await response.text()).toBe(true);
    expect((await response.json()).succeeded).toBe(1);
  }
});

function recordOpenedRequests(page: Page) {
  const opened: string[] = [];
  page.on("request", request => {
    const match = request.url().match(/\/api\/v1\/events\/([^/]+)\/state$/);
    if (!match || request.method() !== "PUT") return;
    try {
      if (JSON.parse(request.postData() ?? "{}").opened === true) opened.push(decodeURIComponent(match[1]));
    } catch {
      // Invalid state payloads are not opened-state requests.
    }
  });
  return opened;
}

test("reader records an opened state only after an explicit selection and restores focus with Escape or Back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const opened = recordOpenedRequests(page);
  await page.goto("/radar");
  const row = page.locator("article[data-event-id]:has(h2 button)").first();
  await row.waitFor();
  expect(opened).toEqual([]);

  const eventId = await row.getAttribute("data-event-id");
  const title = await row.getByRole("heading", { level: 2 }).innerText();
  const opener = row.getByRole("button", { name: title, exact: true });
  await opener.focus();
  const request = page.waitForRequest(candidate => candidate.method() === "PUT"
    && candidate.url().endsWith(`/api/v1/events/${eventId}/state`)
    && JSON.parse(candidate.postData() ?? "{}").opened === true);
  await opener.click();
  await request;
  await expect(page.getByRole("article", { name: "文章就地阅读", exact: true })).toBeVisible();
  expect(opened).toEqual([eventId]);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("article", { name: "文章就地阅读", exact: true })).toHaveCount(0);
  await expect(opener).toBeFocused();

  const secondRequest = page.waitForRequest(candidate => candidate.method() === "PUT"
    && candidate.url().endsWith(`/api/v1/events/${eventId}/state`)
    && JSON.parse(candidate.postData() ?? "{}").opened === true);
  await opener.click();
  await secondRequest;
  await page.goBack();
  await expect(page.getByRole("article", { name: "文章就地阅读", exact: true })).toHaveCount(0);
});

test("reader is a mobile modal with an inert background and trapped keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/radar?view=cards");
  const card = page.locator("article[data-event-id]:has(h2 button)").first();
  await card.waitFor();
  const title = await card.getByRole("heading", { level: 2 }).innerText();
  await card.getByRole("button", { name: title, exact: true }).click();
  const reader = page.getByRole("article", { name: "文章就地阅读", exact: true });
  await expect(reader).toBeVisible();
  expect(await page.locator(".ns-preview-slot").evaluate(element => getComputedStyle(element).position)).toBe("fixed");
  expect(await page.locator("aside").evaluate(element => (element as HTMLElement).inert)).toBe(true);
  const close = reader.getByRole("button", { name: "返回列表", exact: true });
  await reader.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".ns-preview"))).toBe(true);
  await page.setViewportSize({width:1440,height:1000});
  await expect.poll(()=>page.locator("aside").evaluate(element=>(element as HTMLElement).inert)).toBe(false);
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.locator("aside").evaluate(element=>(element as HTMLElement).inert)).toBe(true);
  await expect(page.locator("main")).not.toContainText("Copilot 中文摘要");
  await expect(page.locator("main")).not.toContainText("低推理");
  await expect(page.locator("[aria-label='采集材料范围']")).toHaveCount(0);
  await close.click();
});

test("engineering filter joins frozen radar queries and coverage headings stay concise", async ({ page }) => {
  await page.goto("/radar");
  await page.locator("article[data-event-id]").first().waitFor();
  await page.getByText("更多筛选 · 时间与排序",{exact:true}).click();
  const response = page.waitForResponse(response => response.url().includes("/api/v1/events?") && new URL(response.url()).searchParams.get("includeEngineering") === "true");
  await page.getByLabel("包含开发构建", { exact: true }).check();
  await response;
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.getByLabel("包含开发构建", { exact: true })).not.toBeChecked();

  const coverage = page.locator(".cp-coverage").first();
  if (await coverage.count()) {
    await coverage.locator(":scope > summary").click();
    await expect(coverage.locator(":scope > summary")).not.toContainText("展开 / 收起");
    await expect(coverage.locator(":scope > summary")).not.toContainText("同名关联");
    await expect(coverage.locator("[data-coverage-member]").first()).toContainText(/.+/);
  }
  await page.getByRole("tab",{name:"主题地图",exact:true}).click();
  const graphResponse=page.waitForResponse(response=>response.url().includes("/explore")
    &&new URL(response.url()).searchParams.get("includeEngineering")==="true");
  await page.getByLabel("包含开发构建",{exact:true}).check();
  await graphResponse;
  const graph=page.getByRole("group",{name:"关键词主题共现图",exact:true});
  const facetResponse=page.waitForResponse(response=>response.url().includes("/api/v1/events?")
    &&new URL(response.url()).searchParams.has("facet")
    &&new URL(response.url()).searchParams.get("includeEngineering")==="true");
  await graph.getByRole("button",{name:/查看匹配文章/}).first().click();
  await facetResponse;
});

test("visiting the T1 queue never sends opened state before selecting an article", async ({ page }) => {
  const opened = recordOpenedRequests(page);
  const queueResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/events" && url.searchParams.get("tier") === "T1";
  });
  await page.goto("/reading");
  const eventId = (await (await queueResponse).json()).items[0].id;
  const first = page.getByRole("button",{name:"从第 1 篇开始",exact:true});
  await first.waitFor();
  expect(opened).toEqual([]);
  const request = page.waitForRequest(candidate => candidate.method() === "PUT"
    && candidate.url().endsWith(`/api/v1/events/${eventId}/state`)
    && JSON.parse(candidate.postData() ?? "{}").opened === true);
  await first.click();
  await request;
  expect(opened).toEqual([eventId]);
});

test("source-reading keeps real chapter times and does not expose empty or blocked bodies", () => {
  expect(formatSourceTimestamp(30)).toBe("0:30");
  expect(formatSourceTimestamp(65)).toBe("1:05");
  expect(formatSourceTimestamp(3_661)).toBe("1:01:01");
  expect(formatSourceDuration(30)).toBe("0:30（分:秒）");
  expect(formatSourceDuration(3_661)).toBe("1:01:01（时:分:秒）");

  const blocked: ReadingContext = {
    version: 1, kind: "post", origin: "authorized_api", status: "blocked", sourceUrl: "https://www.reddit.com/r/example",
    body: "This must not be displayed.", truncated: false, durationSeconds: null, chapters: [], transcriptUrl: null,
    comments: [], commentsStatus: "requires_authorization", fetchedAt: null,
  };
  expect(sourceReadingModel({ title: "Reddit post", sourceName: "Reddit", url: null, excerpt: "", readingContext: blocked }, "post")).toMatchObject({
    body: "", hasUsableContext: false, commentsRequireAuthorization: true,
  });
  const noComments:ReadingContext={...blocked,status:"available",body:"保留的帖子正文",commentsStatus:"available"};
  expect(sourceReadingModel({ title: "Reddit post", sourceName: "Reddit", url: null, excerpt: "", readingContext: noComments }, "post")).toMatchObject({
    commentsAvailableEmpty:true,
  });
  const empty: ReadingContext = { ...blocked, kind: "podcast", status: "available", body: "", commentsStatus: "not_applicable" };
  expect(sourceReadingModel({ title: "Podcast", url: null, excerpt: "", readingContext: empty }, "podcast")).toMatchObject({
    title: "节目简介", body: "", hasUsableContext: true,
  });
  expect(sourceReadingModel({ title: "Legacy X post", url: "https://x.com/example/status/1", excerpt: "retained post body" }, "blog")).toMatchObject({
    kind: "post", title: "帖子正文", body: "retained post body", canExpand: true,
  });
  expect(sourceReadingModel({ title: "Legacy podcast", url: "https://example.com/episode", excerpt: "retained show notes" }, "podcast")).toMatchObject({
    kind: "podcast", title: "节目简介", body: "retained show notes", canExpand: true,
  });
  const captured=readerFixture(true);
  expect(sourceReadingModel(captured.evidence[0], "blog")).toMatchObject({
    title:"已收录正文",canExpand:true,isExcerpt:false,
  });
  const chapterOnly:ReadingContext={...blocked,kind:"podcast",status:"available",body:"",commentsStatus:"not_applicable",
    chapters:[{startSeconds:30,title:"开始",url:null}]};
  expect(hasDetailSourceContent([{title:"节目",readingContext:chapterOnly}],"相同摘要")).toBe(true);
  const commentsOnly:ReadingContext={...blocked,status:"available",body:"相同摘要",commentsStatus:"available",
    comments:[{id:"comment",body:"实际返回的讨论",score:null,url:null}]};
  expect(hasDetailSourceContent([{title:"帖子",readingContext:commentsOnly}],"相同摘要")).toBe(true);
});

test("brief cards remain compact, omit item sharing, and reserve a meaningful detail loading pane", async ({ page }) => {
  const event=readerFixture(true);
  const opened=recordOpenedRequests(page);
  let releaseDetail!:()=>void;
  const detailPending=new Promise<void>(resolve=>{releaseDetail=resolve;});
  await page.route("**/api/v1/briefs/latest",route=>route.fulfill({json:{
    localDate:"2026-09-11",generatedAt:"2026-09-11T00:00:00.000Z",estimatedMinutes:1,items:[event],isSnapshot:false,
    windowStart:"2026-09-11T00:00:00.000Z",windowEnd:"2026-09-12T00:00:00.000Z",
  }}));
  await page.route(`**/api/v1/events/${event.id}`,async route=>{await detailPending;await route.fulfill({json:event});});
  await page.route(`**/api/v1/events/${event.id}/state`,route=>route.fulfill({json:{...event,opened:true}}));
  try {
    await page.goto("/");
    const card=page.locator(`article[data-event-id="${event.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator(".ns-summary-points")).toHaveCount(0);
    await expect(card.locator(".ns-reader-row-preview")).toHaveCount(1);
    expect((await card.locator(".ns-reader-row-preview").innerText()).length).toBeLessThanOrEqual(240);
    await expect(card.getByText("分享卡片",{exact:true})).toHaveCount(0);
    await card.getByRole("heading").getByRole("button").click();
    const reader=page.getByRole("article",{name:"文章就地阅读",exact:true});
    const loading=reader.getByLabel("正在读取详情", {exact:true});
    await expect(loading.getByRole("heading",{name:event.title,exact:true})).toBeVisible();
    expect((await loading.boundingBox())!.height).toBeGreaterThanOrEqual(400);
    expect(opened).toEqual([]);
    releaseDetail();
    await expect(reader.locator(".ns-summary-points li")).toHaveCount(event.summaryPoints!.length);
    await expect.poll(()=>opened).toEqual([event.id]);
  } finally {
    releaseDetail?.();
    await page.unroute("**/api/v1/briefs/latest");
    await page.unroute(`**/api/v1/events/${event.id}`);
    await page.unroute(`**/api/v1/events/${event.id}/state`);
  }
});

test("detail exposes captured source content with bounded expansion and truthful labels", async ({ page }) => {
  const event=readerFixture(true);
  await page.route(`**/api/v1/events/${event.id}`,route=>route.fulfill({json:event}));
  await page.route(`**/api/v1/events/${event.id}/state`,route=>route.fulfill({json:{...event,opened:true}}));
  await page.goto(`/events/${event.id}`);
  const sourceTab=page.getByRole("tab",{name:"已收录原文 / 来源内容",exact:true});
  await expect(sourceTab).toBeVisible();
  await sourceTab.click();
  await expect(page.locator(".ns-source-reading")).toBeVisible();
  await expect(page.getByRole("heading",{name:"已收录正文",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"显示更多",exact:true}).click();
  await expect(page.locator(".ns-source-text")).toContainText(sourceTail);
  await expect(page.getByText("原文节选（节选）",{exact:true})).toHaveCount(0);
  await expect(page.getByText("材料范围",{exact:true})).toHaveCount(0);
  await page.unroute(`**/api/v1/events/${event.id}`);
  await page.unroute(`**/api/v1/events/${event.id}/state`);
});
