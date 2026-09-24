import { expect,test } from "@playwright/test";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { startPublicReader,projectArticle,projectBrief } from "../../services/public-reader/server.cjs";
import { loadPublicFeedback } from "../../apps/web/src/public-reader";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:8080";
let server:Server,base:string;
test.beforeAll(async({request})=>{
  test.setTimeout(120_000);
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true")throw new Error("Use the isolated E2E runner.");
  const events=await(await request.get(`${api}/api/v1/events?hours=0&limit=1`)).json();
  if(!events.items.length) {
    const refresh=await request.post(`${api}/api/v1/sources/20000000-0000-0000-0000-000000000001/refresh`,{timeout:90_000});
    expect(refresh.ok(),await refresh.text()).toBe(true);
    expect((await refresh.json()).succeeded).toBe(1);
  }
  server=await startPublicReader({apiOrigin:api,distRoot:resolve("apps\\web\\dist"),port:0});
  const address=server.address();
  if(!address||typeof address==="string")throw new Error("Public server did not bind a TCP port.");
  base=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{if(server){await new Promise<void>((done,error)=>{server.close(cause=>cause?error(cause):done());server.closeAllConnections();});}});

test("public reader boundary projects only public content and denies owner controls and source files",async({request})=>{
  const real=await(await request.get(`${api}/api/v1/events?hours=0&limit=1`)).json();
  const event=real.items[0];
  expect(event).toBeTruthy();
  const projected=projectArticle({...event,saved:true,personalReason:"PRIVATE_SENTINEL",accountLogin:"PRIVATE_SENTINEL",
    summaryError:"PRIVATE_SENTINEL",extra:{token:"PRIVATE_SENTINEL"},recommendation:{...event.recommendation,explanation:"PRIVATE_SENTINEL",affinity:99}});
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_SENTINEL");
  expect(projected.contentVersion).toBe(event.contentVersion);
  const nested=projectArticle({...event,coverage:{
    key:"projection-check",topic:"Projection check",relation:"same_named_topic",method:"deterministic-name-v1",windowHours:168,
    materialCount:1,newsMaterialCount:1,editorialSourceCount:1,officialSourceCount:0,communityMaterialCount:0,popularityBoost:0,
    ownerNotes:"PRIVATE_SENTINEL",
    members:[{...event,eventId:event.id,relationship:"lead",materialKind:"editorial",matchesFilters:true,hidden:true,
      releaseTarget:"Projection host",releaseVersion:"v1.0.0",
      personalReason:"PRIVATE_SENTINEL",evidence:event.evidence.map((source:object)=>({...source,privateToken:"PRIVATE_SENTINEL"}))}],
  }});
  expect(JSON.stringify(nested)).not.toContain("PRIVATE_SENTINEL");
  expect(nested.coverage.members[0].eventId).toBe(event.id);
  expect(nested.coverage.members[0].contentVersion).toBe(event.contentVersion);
  expect(nested.coverage.members[0]).not.toHaveProperty("hidden");
  expect(nested.coverage.members[0].releaseVersion).toBe("v1.0.0");
  expect(nested.coverage.members[0].releaseTarget).toBe("Projection host");
  for(const field of ["saved","read","later","notInterested","seen","opened","personalRelevance","personalReason","score","recommendation","summaryError","summaryNextAttemptAt"])expect(projected).not.toHaveProperty(field);
  const listResponse=await request.get(`${base}/beta/api/events?hours=0&limit=1`);
  expect(listResponse.ok(),await listResponse.text()).toBe(true);
  const data=await listResponse.json();
  expect(data.items.length).toBe(1);
  expect(data.items[0].evidence.length).toBeGreaterThan(0);
  expect(Number.isInteger(data.items[0].contentVersion)).toBe(true);
  const detail=await request.get(`${base}/beta/api/events/${data.items[0].id}`);
  expect(detail.ok()).toBe(true);
  const detailJson=await detail.json();
  expect(detailJson).not.toHaveProperty("saved");
  expect(detailJson.contentVersion).toBe(data.items[0].contentVersion);
  const brief=await(await request.get(`${base}/beta/api/brief`)).json();
  expect(brief.items.every((item:{contentVersion?:number})=>Number.isInteger(item.contentVersion))).toBe(true);
  for(const path of ["/api/v1/processing","/api/v1/model-providers","/api/v1/me/interests","/api/v1/shares",
    "/api/v1/events?saved=true","/settings","/sources","/share","/.env","/src/main.tsx","/@fs/D:/Code/ScoutNews/.env","/assets/missing.js.map"]) {
    expect((await request.get(base+path)).status(),path).toBe(404);
  }
  for(const path of ["/api/v1/processing/settings","/api/v1/events/exposures",`/beta/api/events/${event.id}/state`,
    `/api/v1/events/${event.id}/reading-context`,`/beta/api/events/${event.id}/reading-context`]) {
    expect((await request.post(base+path,{data:{saved:true}})).status(),path).toBe(405);
  }
  for(const query of ["saved=true","notInterested=true","sort=private","limit=1000","limit=2&limit=3","includeEngineering=yes","q="+encodeURIComponent("\u0000")]) {
    expect((await request.get(`${base}/beta/api/events?${query}`)).status(),query).toBe(400);
  }
  expect((await request.get(`${base}/beta/api/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`)).status()).toBe(404);
  const html=await request.get(base+"/");
  expect(html.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(await html.text()).toContain('dataset.publicReader="true"');
});

test("public reader beta offers genuine reading and browser-isolated feedback in both themes",async({page,browser},info)=>{
  test.setTimeout(120_000);
  const pageErrors:string[]=[];page.on("pageerror",error=>pageErrors.push(error.message));
  const privateRequests:string[]=[];page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/v1/"))privateRequests.push(request.url());});
  await page.setViewportSize({width:1440,height:1050});
  await page.goto(base+"/?tab=radar");
  await expect(page.getByRole("heading",{name:"新闻雷达",level:1,exact:true})).toBeVisible();
  const historicalResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/beta/api/events"
    &&new URL(response.url()).searchParams.get("hours")==="0");
  await page.getByText("更多筛选 · 时间与排序",{exact:true}).click();
  await page.getByLabel("时间范围",{exact:true}).selectOption("0");
  const historyLoaded=await historicalResponse;
  expect(historyLoaded.ok(),await historyLoaded.text()).toBe(true);
  const candidate=page.locator("[data-public-event]").filter({has:page.getByRole("button",{name:/^收藏：/})}).first();
  await expect(candidate).toBeVisible();
  const first=page.locator(`[data-public-event="${await candidate.getAttribute("data-public-event")}"]`);
  await expect(first).toBeVisible();
  await expect(first.getByText("已打开",{exact:true})).toHaveCount(0);
  const title=await first.getByRole("heading").innerText();
  await first.getByRole("button",{name:/^收藏：/}).click();
  await expect(first.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-pressed","true");
  await page.getByRole("navigation",{name:"公开阅读视图",exact:true}).getByRole("button",{name:/^收藏/}).click();
  await page.reload();
  await expect(page.getByRole("region",{name:"本浏览器收藏",exact:true}).getByRole("heading",{name:title,exact:true})).toBeVisible();
  const other=await browser.newContext();
  try {
    const second=await other.newPage();await second.goto(base+"/?tab=saved");
    await expect(second.getByText("先收藏一篇值得再读的文章。",{exact:true})).toBeVisible();
  } finally {await other.close();}
  await page.getByRole("region",{name:"本浏览器收藏",exact:true}).getByRole("button",{name:title,exact:true}).click();
  await expect(page.getByRole("complementary",{name:"公开文章阅读区",exact:true}).getByRole("heading",{name:title,exact:true,level:2})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("newsscout-public-feedback-v1")??"{}").opened?.length??0)).toBe(1);
  for(const theme of ["light","dark"]) {
    await page.setViewportSize({width:1440,height:1050});
    await expect(page.getByRole("button",{name:"切换明暗主题",exact:true})).toBeVisible();
    if((await page.locator("html").getAttribute("data-theme"))!==theme)await page.getByRole("button",{name:"切换明暗主题",exact:true}).click();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1050});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:info.outputPath(`public-reader-${theme}-${width}.png`),fullPage:true});
    }
  }
  await page.getByRole("button",{name:"返回列表",exact:false}).click();
  await expect(page.getByRole("region",{name:"本浏览器收藏",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"打开导航",exact:true}).click();
  await page.getByRole("navigation",{name:"公开阅读视图",exact:true}).getByRole("button",{name:"新闻雷达",exact:true}).click();
  await page.getByText("更多筛选 · 时间与排序",{exact:true}).click();
  await page.getByLabel("时间范围",{exact:true}).selectOption("0");
  await page.getByRole("tab",{name:"主题地图",exact:true}).click();
  const graph=page.getByRole("group",{name:"关键词主题共现图",exact:true});
  await expect(graph).toBeVisible();
  const selected=page.waitForResponse(response=>new URL(response.url()).pathname==="/beta/api/events"&&!!new URL(response.url()).searchParams.get("facet"));
  await graph.getByRole("button",{name:/查看匹配文章/}).first().click();
  const filtered=await selected;
  const facet=new URL(filtered.url()).searchParams.get("facet");
  const data=await filtered.json();
  expect(data.items.length).toBeGreaterThan(0);
  expect(data.items.every((item:{facets:string[];coverage?:{members:{matchesFilters:boolean}[]}})=>item.coverage
    ?item.coverage.members.some(member=>member.matchesFilters):item.facets.includes(facet!))).toBe(true);
  await expect(page.locator(".ns-topic-article").first()).toBeVisible();
  expect(privateRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("public reader expanded views match genuine T1 queues, weekly sections and saved editions",async({request})=>{
  async function json(url:string) {
    const response=await request.get(url);
    expect(response.ok(),await response.text()).toBe(true);
    return response.json();
  }
  const originalSources=await json(`${api}/api/v1/sources`);
  const directory=await json(`${base}/beta/api/reading/sources`);
  expect(directory.items).toEqual(originalSources.items
    .filter((source:{tier:string;contentType:string})=>source.tier==="T1"&&source.contentType==="blog")
    .map((source:{id:string;name:string})=>({id:source.id,name:source.name})));
  const asOf=new Date().toISOString();
  const scopes:{hours:string;scope:string;source?:string}[]=[{hours:"720",scope:"technical"},{hours:"0",scope:"all"}];
  if(directory.items.length)scopes.push({hours:"0",scope:"technical",source:directory.items[0].id});
  for(const scope of scopes) {
    const parameters=new URLSearchParams({...scope,asOf,limit:"3",offset:"0"});
    const upstream=new URLSearchParams({...scope,asOf,limit:"3",offset:"0",tier:"T1",kind:"blog",sort:"newest"});
    upstream.delete("scope");
    if(scope.scope==="technical")upstream.set("technical","true");
    const expected=await json(`${api}/api/v1/events?${upstream}`);
    const actual=await json(`${base}/beta/api/reading?${parameters}`);
    expect(actual).toEqual({items:expected.items.map(projectArticle),nextOffset:expected.nextOffset,asOf});
  }
  const weekly=await json(`${api}/api/v1/weekly`);
  const {generatedAt,windowStart,windowEnd,...expectedWeekly}=projectBrief(weekly);
  const {generatedAt:sharedAt,windowStart:sharedStart,windowEnd:sharedEnd,...sharedWeekly}=await json(`${base}/beta/api/weekly`);
  expect(sharedWeekly).toEqual(expectedWeekly);
  for(const [original,shared] of [[generatedAt,sharedAt],[windowStart,sharedStart],[windowEnd,sharedEnd]])
    expect(Math.abs(Date.parse(original)-Date.parse(shared))).toBeLessThanOrEqual(20_000);
  const originals=await json(`${api}/api/v1/briefs`);
  const saved=await json(`${base}/beta/api/briefs`);
  expect(saved.items).toEqual(originals.items.map((item:{localDate:string;generatedAt:string;itemCount:number})=>({
    localDate:item.localDate,generatedAt:item.generatedAt,itemCount:item.itemCount,
  })));
  if(saved.items.length) {
    const date=saved.items[0].localDate;
    const archived=await json(`${api}/api/v1/briefs/${date}`);
    const shared=await json(`${base}/beta/api/briefs/${date}`);
    expect(shared).toEqual(projectBrief(archived));
    expect(shared.isSnapshot).toBe(true);
  }
  for(const route of ["/reading","/weekly","/saved"])expect((await request.get(base+route)).status()).toBe(200);
});

for(const scenario of ["recommended","topic","tier","search"])test(`public Radar matches genuine owner order and graph scope: ${scenario}`,async({request},info)=>{
  test.setTimeout(120_000);
  const timings:{url:string;milliseconds:number}[]=[];
  async function json(url:string) {
    const started=Date.now();
    const response=await request.get(url,{timeout:30_000});
    timings.push({url,milliseconds:Date.now()-started});
    expect(response.ok(),await response.text()).toBe(true);
    return response.json();
  }
  try {
  const asOf=new Date().toISOString();
  const initial=await json(`${api}/api/v1/events?hours=0&limit=40&coverage=true&sort=recommended&asOf=${encodeURIComponent(asOf)}`);
  expect(initial.items.length).toBeGreaterThan(0);
  const article=initial.items.find((item:{coverage?:unknown})=>!item.coverage)??initial.items[0];
  const scope:Record<string,string>=scenario==="recommended"?{sort:"recommended",hours:"0"}
    :scenario==="topic"?{sort:"newest",hours:"0",topic:article.primaryTopic}
    :scenario==="tier"?{sort:"score",hours:"720",tier:"T1"}
    :{sort:"recommended",hours:"0",q:article.title.slice(0,24),includeEngineering:"true"};
    const query=new URLSearchParams({...scope,asOf,limit:"40",offset:"0"});
    const expected=await json(`${api}/api/v1/events?${query}&coverage=true`);
    const actual=await json(`${base}/beta/api/events?${query}`);
    expect(actual.items).toEqual(expected.items.map(projectArticle));
    expect(actual.nextOffset).toBe(expected.nextOffset);
    query.delete("sort");query.delete("limit");query.delete("offset");
    const graph=await json(`${api}/api/v1/explore?${query}`);
    expect(await json(`${base}/beta/api/explore?${query}`)).toEqual({
      sampleSize:graph.sampleSize,limit:graph.limit,meaning:graph.meaning,
      nodes:graph.nodes.map(({id,count}:{id:string;count:number})=>({id,count})),
      edges:graph.edges.map(({source,target,count}:{source:string;target:string;count:number})=>({source,target,count})),
    });
  } finally {await info.attach("radar-api-timings",{body:JSON.stringify(timings,null,2),contentType:"application/json"});}
});

test("public reading context projects only bounded source content and safe original links",()=>{
  const readingContext={
    version:1,kind:"podcast",origin:"feed",status:"available",sourceUrl:"https://example.com/episode",
    body:"A genuine source note.",truncated:false,durationSeconds:3600,transcriptUrl:"https://127.0.0.1/private",
    chapters:[{startSeconds:0,title:"Introduction",url:"https://example.com/episode#t=0",token:"PRIVATE_SENTINEL"}],
    comments:[],commentsStatus:"not_applicable",fetchedAt:"2026-09-11T00:00:00Z",internalError:"PRIVATE_SENTINEL",
  };
  const evidence={id:"evidence",sourceName:"Podcast",sourceTier:"T1.5",title:"Episode",url:"https://example.com/episode",excerpt:"Note",readingContext};
  const article={id:"11111111-1111-4111-8111-111111111111",title:"Episode",evidence:[evidence]};
  const result=projectArticle(article);
  expect(result.evidence[0].readingContext.body).toBe(readingContext.body);
  expect(result.evidence[0].readingContext.transcriptUrl).toBeNull();
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  expect(()=>projectArticle({...article,evidence:[{...evidence,readingContext:{...readingContext,body:"x".repeat(16001)}}]})).toThrow();
  expect(()=>projectArticle({...article,evidence:[{...evidence,readingContext:{...readingContext,comments:[{id:"c",body:"Text",score:"invalid"}]}}]})).toThrow();
});

test("public reading history upgrades legacy browser feedback without inventing opens",()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  let stored=JSON.stringify({saved:{},dismissed:[]});
  try {
    Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>stored}});
    expect(loadPublicFeedback()).toEqual({value:{saved:{},dismissed:[],opened:[],reasons:{}},error:null});
    stored=JSON.stringify({saved:{},dismissed:[],opened:["not-an-article-id"]});
    expect(loadPublicFeedback().error).not.toBeNull();
  } finally {
    if(original)Object.defineProperty(globalThis,"localStorage",original);
    else Reflect.deleteProperty(globalThis,"localStorage");
  }
});
