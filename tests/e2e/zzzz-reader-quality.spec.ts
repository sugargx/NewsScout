import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";
import { summaryPresentation } from "../../apps/web/src/summary-presentation";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:8080";
const literal=(value:unknown)=>value===null?"NULL":`'${(typeof value==="object"?JSON.stringify(value):String(value)).replaceAll("'","''")}'`;
const source=(suffix:string)=>`20000000-0000-0000-0000-${suffix.padStart(12,"0")}`;

test.beforeAll(async({request})=>{
  test.setTimeout(240_000);
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true")throw new Error("Use isolated E2E.");
  for(const suffix of ["1","118","306","307"]) {
    const response=await request.post(`${api}/api/v1/sources/${source(suffix)}/refresh`,{timeout:60000});
    expect(response.ok()).toBe(true);
    const report=await response.json();
    expect(report.failed,JSON.stringify(report)).toBe(0);
    expect(report.succeeded).toBe(1);
  }
});

test("reader quality separates adaptive summary points from material limitations",async({request,page})=>{
  const old=summaryPresentation({summary:"一篇系统综述梳理了259项有关AI创作的工作，讨论重点是让模型从“会生成”走向“能交付”。文章关注的核心是生成结果在真实使用场景中的整体一致性与可用性。由于仅提供标题和片段，综述采用的方法、分类框架及具体结论尚无法确认。"});
  expect(old.points).toHaveLength(2);
  expect(old.materialLimit).toContain("仅提供标题和片段");
  expect(old.limitations).toEqual([]);
  const id=databaseQuery("SELECT id FROM events WHERE length(summary)>60 ORDER BY id LIMIT 1");
  const original=JSON.parse(databaseQuery(`SELECT row_to_json(e) FROM events e WHERE id='${id}'`));
  try {
    databaseQuery(`UPDATE events SET summary_kind='copilot',summary_format_version=3,
      summary_points=jsonb_build_array(left(summary,60),substring(summary,61,180)),
      summary_material_limit='目前仅收录来源摘录，未读取原文全文。',summary_limitations='[]',
      summary_model='gpt-5.6-terra',summary_reasoning_effort='low',summarized_at=now() WHERE id='${id}'`);
    const event=await(await request.get(`${api}/api/v1/events/${id}`)).json();
    expect(event.summaryPoints).toHaveLength(2);
    expect(event.summaryFormatVersion).toBe(3);
    expect(event.summaryStatus).toBe("completed");
    await page.goto(`/events/${id}`);
    await expect(page.getByRole("list",{name:"摘要要点"}).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("complementary",{name:"采集材料范围"})).toHaveCount(0);
    expect(event.summaryMaterialLimit).toContain("目前仅收录来源摘录");
    const shareResponse=await request.post(`${api}/api/v1/shares`,{data:{kind:"event",eventId:id}});
    expect(shareResponse.ok()).toBe(true);
    const share=await shareResponse.json();
    expect(share.document.items[0].summary).toContain("- ");
    expect(share.document.items[0].summary).toContain("\n\n材料范围");
    databaseQuery(`UPDATE events SET summary_format_version=2 WHERE id='${id}'`);
    const upgrading=await(await request.get(`${api}/api/v1/events/${id}`)).json();
    expect(upgrading.summaryStatus).toBe("pending");
    expect(upgrading.summaryPoints).toEqual(event.summaryPoints);
    expect(databaseQuery(`SELECT format_version FROM summary_jobs WHERE event_id='${id}'`)).toBe("3");
    await request.delete(`${api}/api/v1/shares/${share.id}`);
  } finally {
    const fields=["summary_kind","summary_format_version","summary_points","summary_material_limit","summary_limitations","summary_model","summary_reasoning_effort","summarized_at"];
    databaseQuery(`UPDATE events SET ${fields.map(key=>`${key}=${literal(original[key])}`).join(",")} WHERE id='${id}';DELETE FROM user_event_states WHERE event_id='${id}'`);
  }
});

test("reader quality keeps the daily edition fixed and shares that exact selection",async({page,request})=>{
  const originals:Record<string,unknown>[]=JSON.parse(databaseQuery(`SELECT json_agg(e) FROM(
    SELECT id,summary_kind,summary_format_version,summary_points,summary_material_limit,summary_limitations FROM events
    WHERE length(summary)>60 AND event_type='blog' ORDER BY id LIMIT 10)e`));
  expect(originals.length).toBe(10);
  const ids=originals.map(event=>literal(event.id)).join(",");
  const contents:{id:string;published_at:string|null}[]=JSON.parse(databaseQuery(`SELECT json_agg(ci) FROM(
    SELECT id,published_at FROM content_items WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id IN(${ids})))ci`));
  try {
    databaseQuery(`UPDATE content_items SET published_at=now()-interval '2 hours' WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id IN(${ids}));
      UPDATE events SET summary_kind='copilot',summary_format_version=3,summary_points=jsonb_build_array(left(summary,160)),
        summary_material_limit=NULL,summary_limitations='[]' WHERE id IN(${ids})`);
    let briefRequests=0;
    page.on("request",request=>{if(request.url().endsWith("/api/v1/briefs/latest"))briefRequests++;});
    await page.goto("/");
    const cards=page.locator("article[data-event-id]");
    await expect(cards.first()).toBeVisible();
    const snapshot=()=>cards.evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute("data-event-id"),points:node.querySelector(".ns-summary-points")?.textContent})));
    const before=await snapshot();
    expect(before.length).toBeGreaterThanOrEqual(3);
    const catchUp=await page.locator('.ns-edition-section[data-section="catch_up"] article[data-event-id]').count();
    const changed=before[0].id!;
    const title=await cards.first().getByRole("heading").innerText();
    databaseQuery(`UPDATE events SET summary_format_version=2 WHERE id='${changed}'`);
    await page.evaluate(()=>{window.dispatchEvent(new Event("online"));document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new Event("focus"));});
    await page.waitForTimeout(800);
    // The daily edition is fixed: no background refetch and no manual update control.
    expect(briefRequests).toBe(1);
    await expect(page.getByRole("button",{name:"应用更新",exact:true})).toHaveCount(0);
    expect(await snapshot()).toEqual(before);
    await cards.first().getByRole("button",{name:/^收藏：/}).click();
    await expect(cards.first().getByRole("button",{name:/^取消收藏：/})).toBeVisible();
    expect(await cards.evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-event-id")))).toEqual(before.map(item=>item.id));
    // Sharing reuses the edition already on screen: same items, same order, no extra request.
    await page.getByRole("link",{name:"生成今日分享图"}).click();
    await expect(page.getByRole("heading",{name:"今日分享",level:1})).toBeVisible();
    await page.getByRole("group",{name:"分享排序"}).getByRole("button",{name:"精选顺序",exact:true}).click();
    const options=page.locator(".ns-share-options strong");
    await expect(options).toHaveCount(before.length);
    await expect(options.first()).toHaveText(title);
    // 补读 items stay selectable but are never part of the default pick.
    await expect(page.getByRole("img",{name:new RegExp(`^分享图预览：(?:今日|\\d{1,2}月\\d{1,2}日)值得分享的 ${Math.min(10,before.length-catchUp)} 条新闻$`)})).toBeVisible();
    expect(briefRequests).toBe(1);
    await page.goBack();
    await expect(cards).toHaveCount(before.length);
    expect(briefRequests).toBe(1);
    expect((await snapshot()).map(item=>item.id)).toEqual(before.map(item=>item.id));
    const dismissed=cards.last();
    const dismissedId=await dismissed.getAttribute("data-event-id");
    const orderBeforeDismiss=await cards.evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-event-id")));
    await dismissed.getByRole("button",{name:/^不感兴趣：/}).click();
    await expect(cards).toHaveCount(before.length-1);
    expect(await cards.evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-event-id")))).toEqual(orderBeforeDismiss.filter(id=>id!==dismissedId));
    const current=await(await request.get(`${api}/api/v1/events/${changed}`)).json();
    const conflict=await request.post(`${api}/api/v1/shares`,{data:{kind:"brief",selection:[{eventId:changed,contentVersion:current.contentVersion-1,summarizedAt:current.summarizedAt}]}});
    expect(conflict.status()).toBe(409);
  } finally {
    for(const item of contents)databaseQuery(`UPDATE content_items SET published_at=${literal(item.published_at)} WHERE id='${item.id}'`);
    for(const item of originals)databaseQuery(`UPDATE events SET ${Object.entries(item).filter(([key])=>key!=="id").map(([key,value])=>`${key}=${literal(value)}`).join(",")} WHERE id=${literal(item.id)}`);
    databaseQuery(`DELETE FROM event_exposures WHERE event_id IN(${ids});DELETE FROM user_event_states WHERE event_id IN(${ids})`);
  }
});

test("reader quality uses earliest same-event evidence without inventing an occurrence date",async({request})=>{
  const events:{id:string;content:string;published:string}[]=JSON.parse(databaseQuery(`SELECT json_agg(s) FROM(
    SELECT e.id,ci.id AS content,ci.published_at AS published FROM events e
    JOIN event_evidence ee ON ee.event_id=e.id JOIN content_items ci ON ci.id=ee.content_item_id
    WHERE (SELECT count(*) FROM event_evidence x WHERE x.event_id=e.id)=1
    ORDER BY e.id LIMIT 2)s`));
  expect(events).toHaveLength(2);
  try {
    databaseQuery(`UPDATE content_items SET published_at=now()-interval '72 hours' WHERE id='${events[0].content}';
      UPDATE content_items SET published_at=now() WHERE id='${events[1].content}';
      INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES('${events[0].id}','${events[1].content}',false)`);
    const item=await(await request.get(`${api}/api/v1/events/${events[0].id}`)).json();
    const halfLife=({research:96,analysis:96,tutorial:96,release:48} as Record<string,number>)[item.editorial?.contentKind]??30;
    expect(item.recommendation.freshness).toBeCloseTo(100*0.5**(72/halfLife),1);
    expect(Date.parse(item.publishedAt)-Date.parse(item.freshnessAt)).toBeGreaterThan(71*3600000);
    expect(item).not.toHaveProperty("eventOccurredAt");
    expect(item.evidence).toHaveLength(2);
    const classifier=databaseQuery(`SELECT news_technical_basis('https://openai.com/index/example','Supporting independent journalism','{"sourceMetadata":{"feedCategories":["Company"]}}') IS NULL`);
    expect(classifier).toBe("t");
  } finally {
    databaseQuery(`DELETE FROM event_evidence WHERE event_id='${events[0].id}' AND content_item_id='${events[1].content}'`);
    for(const item of events)databaseQuery(`UPDATE content_items SET published_at=${literal(item.published)} WHERE id='${item.content}'`);
  }
});

test("reader quality exposes real technical indexes and an in-place topic workspace",async({page,request},info)=>{
  const get=async(params:string)=>(await(await request.get(`${api}/api/v1/events?${params}`)).json()).items;
  for(const suffix of ["306","307"]) {
    const events=await get(`source=${source(suffix)}&tier=T1&technical=true&hours=0&limit=100`);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event:{evidence:{technicalBasis:string|null;url:string}[]})=>event.evidence.some(item=>item.technicalBasis&&item.url.startsWith("https://www.anthropic.com/")))).toBe(true);
    expect(events.some((event:{evidence:{excerpt:string}[]})=>event.evidence.some(item=>item.excerpt.length>40))).toBe(true);
  }
  const openai=await get(`source=${source("1")}&tier=T1&technical=true&hours=720&limit=100`);
  expect(openai.length).toBeGreaterThan(0);
  expect(openai.some((event:{evidence:{technicalBasis:string}[]})=>event.evidence.some(item=>item.technicalBasis==="发布者标注的技术 / 研究分类"))).toBe(true);
  await page.goto("/reading");
  await expect(page.getByLabel("阅读内容",{exact:true})).toHaveValue("technical");
  await page.getByLabel("T1 博客来源",{exact:true}).selectOption(source("307"));
  await page.getByLabel("阅读时间范围",{exact:true}).selectOption("0");
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toHaveCount(0);
  await page.getByRole("button",{name:"从第 1 篇开始",exact:true}).click();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toBeVisible();
  await expect(page.locator(".ns-preview-title")).toBeVisible();
  await page.goto("/radar?view=topics&hours=720");
  const graph=page.getByRole("group",{name:"关键词主题共现图",exact:true});
  await graph.waitFor();
  await graph.getByRole("button",{name:/查看匹配文章/}).first().click();
  const results=page.getByRole("group",{name:"关联文章",exact:true});
  await expect(results).toBeVisible();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toHaveCount(0);
  await results.getByRole("button").first().click();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toBeVisible();
  await expect(page.locator(".ns-preview-title")).toBeVisible();
  await expect(results.getByRole("button").first()).toHaveAttribute("aria-current","true");
  await expect(graph).toBeVisible();
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    if(width===390) {
      await expect(page.getByRole("dialog",{name:"文章阅读窗口"})).toBeVisible();
      await expect(graph).not.toBeVisible();
      await expect(page.getByRole("article",{name:"文章就地阅读"}).getByRole("button",{name:"下一篇",exact:true})).toBeVisible();
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`quality-topic-${width}.png`),fullPage:true});
  }
  await page.getByRole("article",{name:"文章就地阅读"}).getByRole("button",{name:"返回主题结果",exact:true}).click();
  await expect(results).toBeVisible();
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe("0");
});
