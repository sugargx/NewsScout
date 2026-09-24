import {expect,test,type APIRequestContext} from "@playwright/test";
import type {Event} from "../../apps/web/src/types";
import {databaseQuery} from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:8080";
type Page={items:Event[];nextOffset:number|null;returnedEventCount:number;returnedMaterialCount:number;grouping:string};

async function pages(request:APIRequestContext,params:URLSearchParams) {
  const results:Page[]=[];
  let offset=0;
  do {
    params.set("offset",String(offset));
    const response=await request.get(`${api}/api/v1/events?${params}`);
    expect(response.ok(),await response.text()).toBe(true);
    const page:Page=await response.json();results.push(page);
    if(page.nextOffset===null)return results;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset=page.nextOffset;
  } while(results.length<100);
  throw new Error("Unexpectedly unbounded event pagination");
}

test("coverage bundles preserve real material identities and filter before stable pagination",async({request,page},info)=>{
  test.setTimeout(300_000);
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true"||!process.env.SCOUTNEWS_E2E_API_URL)throw new Error("Use isolated live E2E.");
  databaseQuery("SELECT 1");
  // Existing public original-publisher feed; no intercepted routes or invented news.
  const source="20000000-0000-0000-0000-000000000304";
  const refreshed=await request.post(`${api}/api/v1/sources/${source}/refresh`,{timeout:90_000});
  expect(refreshed.ok()).toBe(true);
  expect((await refreshed.json()).succeeded).toBe(1);
  const archiveBefore=databaseQuery("SELECT COALESCE(jsonb_agg(snapshot ORDER BY brief_id,rank)::text,'[]') FROM daily_brief_items");
  const auditsBefore=databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'");
  const asOf=new Date().toISOString();
  const rawParams=new URLSearchParams({source,tier:"T2",hours:"0",sort:"newest",asOf,limit:"100"});
  const originals=(await pages(request,rawParams)).flatMap(result=>result.items);
  expect(originals.length).toBeGreaterThan(0);
  const byId=new Map(originals.map(event=>[event.id,event]));
  const params=new URLSearchParams({source,tier:"T2",hours:"0",sort:"newest",asOf,coverage:"true",limit:"3"});
  const grouped=await pages(request,params);
  const repeated=await pages(request,params);
  expect(repeated.map(result=>result.items.map(event=>event.id))).toEqual(grouped.map(result=>result.items.map(event=>event.id)));
  const ids:string[]=[];
  for(const result of grouped) {
    expect(result.grouping).toBe("proven-event-v1");
    expect(result.returnedEventCount).toBe(result.items.reduce((sum,event)=>sum+(event.coverage?.members.length??1),0));
    expect(result.returnedMaterialCount).toBe(result.items.reduce((sum,event)=>sum+(event.coverage?.materialCount??event.evidence.length),0));
    for(const event of result.items) {
      const original=byId.get(event.id)!;
      expect(event.summary).toBe(original.summary);
      expect(event.contentVersion).toBe(original.contentVersion);
      expect(event.evidence.map(e=>e.id)).toEqual(original.evidence.map(e=>e.id));
      expect(event.freshnessAt).toBe(original.freshnessAt);
      if(!event.coverage){ids.push(event.id);continue;}
      expect(event.coverage.popularityBoost).toBe(0); // one publisher, regardless of material count
      for(const member of event.coverage.members) {
        ids.push(member.eventId);
        expect(member.matchesFilters).toBe(true);
        expect(member.evidence.some(e=>e.sourceTier==="T2")).toBe(true);
        expect(member.summary).toBe(byId.get(member.eventId)!.summary);
        expect(member.publishedAt).toBe(byId.get(member.eventId)!.publishedAt);
        expect(member.publicationPrecision).toBe(byId.get(member.eventId)!.publicationPrecision);
        expect(member.evidence.map(e=>e.id).sort()).toEqual(byId.get(member.eventId)!.evidence.map(e=>e.id).sort());
      }
    }
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(originals.map(event=>event.id).sort());
  const impossible=await request.get(`${api}/api/v1/events?coverage=true&tier=T1&source=${source}`);
  expect((await impossible.json()).items).toEqual([]);
  const none=await request.get(`${api}/api/v1/events?coverage=true&q=nonexistent-${crypto.randomUUID()}`);
  expect((await none.json()).items).toEqual([]);
  expect(databaseQuery("SELECT COALESCE(jsonb_agg(snapshot ORDER BY brief_id,rank)::text,'[]') FROM daily_brief_items")).toBe(archiveBefore);
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe(auditsBefore);

  // Verify the live UI uses server grouping without a second client-side merge.
  const initialResponse=page.waitForResponse(response=>response.url().includes("/api/v1/events?")&&response.url().includes("coverage=true"));
  await page.goto("/radar");
  const initial=await initialResponse;
  const current:Page=await initial.json();
  await expect(page.locator("article[data-event-id]")).toHaveCount(current.items.length);
  const bundled=current.items.find(event=>event.coverage);
  if(bundled) {
    const row=page.locator(`article[data-event-id="${bundled.id}"]`);
    const disclosure=row.locator(".cp-coverage");
    await disclosure.locator(":scope > summary").click();
    await expect(disclosure.locator(":scope > summary")).not.toContainText("关系未确认");
    for(const member of bundled.coverage!.members)
      await expect(disclosure.locator(`[data-coverage-member="${member.eventId}"]`)).toBeVisible();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1100});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:info.outputPath(`coverage-${width}.png`),fullPage:true});
    }
    const related=bundled.coverage!.members.find(member=>member.eventId!==bundled.id)!;
    await disclosure.locator(`[data-coverage-member="${related.eventId}"]`).getByRole("button",{name:"查看详情",exact:true}).click();
    const preview=page.getByRole("article",{name:"文章就地阅读"});
    await expect(preview.getByRole("heading",{name:related.title,exact:true})).toBeVisible();
    await preview.getByRole("button",{name:`不感兴趣：${related.title}`,exact:true}).click();
    await expect(disclosure.locator(`[data-coverage-member="${related.eventId}"]`)).toHaveCount(0);
    await expect(disclosure).toContainText("已隐藏 1 个不感兴趣的条目");
    await preview.getByRole("button",{name:`撤销不感兴趣：${related.title}`,exact:true}).click();
    await expect(disclosure.locator(`[data-coverage-member="${related.eventId}"]`)).toBeVisible();
    expect(await page.locator("article[data-event-id]").evaluateAll(nodes=>nodes.map(n=>n.getAttribute("data-event-id")))).toEqual(current.items.map(event=>event.id));
  }
  await page.goto("about:blank");
});
