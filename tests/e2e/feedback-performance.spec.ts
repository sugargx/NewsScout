import { expect, test, type Page } from "@playwright/test";
import type { Brief, Event, EventState } from "../../apps/web/src/types";

const titles=[
  "开源模型发布：更小体积与更长上下文","研究团队公开可靠性评测方法","开发工具更新：让调试过程可复现",
  "模型服务新增批量处理能力","研究复现：长文档检索的真实边界","新产品把引用带回每一个结论",
  "工程团队分享迁移过程与经验","本周值得关注的开放数据集","回看：上周发布的推理研究",
  "回看：一份仍有参考价值的实践","回看：阅读原始报告的方法","更多更新：社区发布兼容性说明",
];
const id=(index:number)=>`b1000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`;

function fixture(index:number):Event {
  const publishedAt=index<8?"2026-09-15T01:00:00Z":"2026-09-11T01:00:00Z";
  return {
    id:id(index),contentVersion:1,title:`Original publisher title ${index+1}`,displayTitle:titles[index],
    primaryTopic:index<8?"模型与研究":"工程实践",topics:index<8?["模型与研究"]:["工程实践"],eventType:"blog",
    summary:"这项更新公开了适用条件与验证材料。读者可以对照原始报告，了解变化的范围。",
    summaryPoints:["公开适用条件与验证材料，便于独立判断变化。","保留原始报告和限制说明，不把结论外推。","第三条完整摘要只在主动阅读时显示。"],
    summaryMaterialLimit:null,summaryLimitations:[],importance:"说明了具体变化及适用范围。",
    editorial:{policyVersion:"article-value-v1",contentKind:"research",valueScore:80,reason:"fixture",briefEligible:true},
    firstSeenAt:publishedAt,updatedAt:publishedAt,publishedAt,freshnessAt:publishedAt,publicationPrecision:"time",
    evidence:[{id:`source-${index}`,sourceName:"原始发布者",sourceTier:"T1",title:`Source original ${index+1}`,url:"https://example.com/research",
      isOfficial:true,publishedAt,excerpt:"来源保留的简短摘录。",technicalBasis:"原始研究栏目",
      readingContext:{version:1,kind:"article",origin:"publisher_page",status:"available",sourceUrl:"https://example.com/research",
        body:"已收录的原始研究正文，包含方法与观察，不自动访问来源。",truncated:false,durationSeconds:null,chapters:[],transcriptUrl:null,
        comments:[],commentsStatus:"not_applicable",fetchedAt:publishedAt}}],
    score:{sourceQuality:1,corroboration:1,freshness:1,relevance:1,novelty:1,engagement:1,editorialBoost:0,total:6,explanation:"fixture"},
    personalRelevance:0,personalReason:"fixture",saved:false,read:false,later:false,notInterested:false,seen:false,opened:false,
    recommendation:{score:1,freshness:1,affinity:1,noveltyPenalty:0,facets:[],sourceConfirmed:true,explanation:"fixture"},
    summaryKind:"copilot",summaryModel:null,summarizedAt:publishedAt,summaryEvidenceIds:[`source-${index}`],summaryStatus:"completed",
  };
}

function edition(items:Event[]):Brief {
  return {
    localDate:"2026-09-15",generatedAt:"2026-09-15T02:00:00Z",estimatedMinutes:8,isSnapshot:false,
    selectionNote:"fixture",windowStart:"2026-09-08T00:00:00Z",windowEnd:"2026-09-15T02:00:00Z",items,
    sections:[
      {key:"essential",kind:"essential",title:"核心事件",description:"先看今天的重要变化",eventIds:items.slice(0,8).map(item=>item.id)},
      {key:"catch-up",kind:"catch_up",title:"值得补读",description:"较早发布，仍值得阅读",eventIds:items.slice(8,11).map(item=>item.id)},
      {key:"more",kind:"more",title:"更多更新",description:"有余力时继续浏览",eventIds:items.slice(11).map(item=>item.id)},
    ],
  };
}

async function stubFeedback(page:Page) {
  let items=titles.map((_,index)=>fixture(index));
  const stateWrites:{id:string;value:EventState}[]=[],unexpectedWrites:string[]=[];
  await page.route(/\/api\//,async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    const send=(json:unknown,status=200)=>route.fulfill({status,json});
    if(request.method()==="POST"&&path.endsWith("/events/exposures"))return send({recorded:0,skipped:0});
    if(request.method()==="PUT"&&/\/events\/[^/]+\/state$/.test(path)) {
      const eventId=path.split("/").at(-2)!,value=request.postDataJSON() as EventState;
      stateWrites.push({id:eventId,value});
      items=items.map(item=>item.id===eventId?{...item,...value}:item);
      return send(items.find(item=>item.id===eventId));
    }
    if(request.method()!=="GET"){unexpectedWrites.push(path);return send({error:"Unexpected write"},405);}
    if(path.endsWith("/runtime"))return send({mode:"postgres",timeZone:"Asia/Shanghai",version:"fixture"});
    if(path.endsWith("/me/interests"))return send({items:[{id:"topic",label:"模型与研究",enabled:true,weight:1,group:"test",context:""}]});
    if(path.endsWith("/sources"))return send({items:[{id:"publisher",name:"原始发布者",tier:"T1",contentType:"blog"}]});
    if(path.endsWith("/briefs"))return send({items:[]});
    if(/\/briefs\/(?:latest|today)$/.test(path)||path.endsWith("/brief"))return send(edition(items));
    if(path.endsWith("/events"))return send({items,nextOffset:null});
    const event=items.find(item=>path.endsWith("/events/"+item.id));
    if(event)return send(event);
    return send({items:[]});
  });
  return {stateWrites,unexpectedWrites};
}

test.use({serviceWorkers:"block"});
test.beforeEach(async({page})=>{
  const base=process.env.SCOUTNEWS_E2E_BASE_URL;
  if(!base||process.env.SCOUTNEWS_E2E_MOCK_ONLY!=="true")throw new Error("Run feedback performance checks in local mock-only mode.");
  if(!["127.0.0.1","localhost","[::1]"].includes(new URL(base).hostname))throw new Error("Mock-only UI checks require a local frontend.");
  await page.route(/\/api\//,route=>route.abort("blockedbyclient"));
});

test("feedback bookmark acknowledges immediately, shares pending state and retries safely",async({page},info)=>{
  const state=await stubFeedback(page);
  await page.setViewportSize({width:1440,height:1000});
  let release!:()=>void,fail=true,requests=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/events/${id(0)}/state`,async route=>{
    const input=route.request().postDataJSON() as EventState;
    if(input.saved===undefined)return route.fallback();
    requests++;
    if(fail){await gate;return route.fulfill({status:503,json:{error:"受控测试：收藏暂时无法同步。"}});}
    return route.fallback();
  });
  try {
    await page.goto("/");
    const card=page.locator(`.ns-edition-list [data-event-id="${id(0)}"]`);
    const original=(await card.locator(".ns-event-actions").boundingBox())!;
    const started=Date.now();
    await card.getByRole("button",{name:/^收藏：/}).evaluate(button=>{button.click();button.click();});
    const pendingButton=card.getByRole("button",{name:/^取消收藏：/});
    await expect(pendingButton).toHaveAttribute("aria-pressed","true");
    await expect(pendingButton).toHaveAttribute("aria-busy","true");
    const optimisticMs=Date.now()-started;
    expect(optimisticMs).toBeLessThan(1000);
    await expect(pendingButton).toHaveCSS("cursor","default");
    const pending=(await card.locator(".ns-event-actions").boundingBox())!;
    expect(pending.width).toBeCloseTo(original.width,0);
    expect(pending.height).toBeCloseTo(original.height,0);
    await card.getByRole("button",{name:titles[0],exact:true}).click();
    const pane=page.getByRole("article",{name:"文章就地阅读",exact:true});
    await expect(pane.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-busy","true");
    await pane.getByRole("button",{name:/^取消收藏：/}).evaluate(button=>button.click());
    await expect.poll(()=>requests).toBe(1);
    await page.waitForTimeout(1200);
    expect(await page.evaluate(()=>({root:getComputedStyle(document.documentElement).cursor,body:getComputedStyle(document.body).cursor}))).toEqual({root:"auto",body:"auto"});
    await page.screenshot({path:info.outputPath("bookmark-pending-1440.png")});
    release();
    await expect(card.getByRole("alert")).toContainText("阅读状态保存失败");
    for(const surface of [card,pane])await expect(surface.getByRole("button",{name:/^收藏：/})).toHaveAttribute("aria-pressed","false");
    fail=false;
    await card.getByRole("button",{name:/重试/}).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(pane.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-busy","false");
    await expect(pane.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-pressed","true");
    expect(requests).toBe(2);
    expect(state.stateWrites.filter(write=>write.value.saved===true)).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
    await info.attach("bookmark-timing",{body:JSON.stringify({optimisticMs,delayedAcknowledgementMs:1200}),contentType:"application/json"});
  } finally {release();}
});

test("feedback bookmark pending stays local on mobile",async({page},info)=>{
  const state=await stubFeedback(page);
  await page.setViewportSize({width:390,height:844});
  let release!:()=>void,requests=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/events/${id(0)}/state`,async route=>{
    if((route.request().postDataJSON() as EventState).saved===undefined)return route.fallback();
    requests++;
    await gate;
    return route.fallback();
  });
  try {
    await page.goto("/");
    const card=page.locator(`.ns-edition-list [data-event-id="${id(0)}"]`);
    await card.getByRole("button",{name:/^收藏：/}).evaluate(button=>{button.click();button.click();});
    const pending=card.getByRole("button",{name:/^取消收藏：/});
    await expect(pending).toHaveAttribute("aria-busy","true");
    await expect(pending).toHaveCSS("cursor","default");
    await page.waitForTimeout(1200);
    expect(requests).toBe(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath("bookmark-pending-390.png")});
    release();
    await expect(card.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-busy","false");
    expect(state.stateWrites.filter(write=>write.value.saved===true)).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();}
});

test("feedback dismissal and undo wait for persistence and suppress duplicates",async({page},info)=>{
  const state=await stubFeedback(page);
  await page.setViewportSize({width:1440,height:1000});
  let release!:()=>void,releaseUndo!:()=>void,fail=true,requests=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const undoGate=new Promise<void>(resolve=>{releaseUndo=resolve;});
  await page.route(`**/api/v1/events/${id(0)}/state`,async route=>{
    const input=route.request().postDataJSON() as EventState;
    if(input.notInterested===undefined)return route.fallback();
    requests++;
    if(input.notInterested===false){await undoGate;return route.fallback();}
    if(fail){await gate;return route.fulfill({status:503,json:{error:"受控测试：偏好暂时无法保存。"}});}
    return route.fallback();
  });
  try {
    await page.goto("/radar");
    const rows=page.locator(".ns-reader-list [data-event-id]"),row=rows.first();
    await expect(rows).toHaveCount(12);
    const before=await rows.evaluateAll(elements=>elements.map(element=>element.getAttribute("data-event-id")));
    await row.getByRole("button",{name:/^不感兴趣：/}).evaluate(button=>{button.click();button.click();});
    await expect(row.getByRole("button",{name:/^撤销不感兴趣：/})).toHaveAttribute("aria-busy","true");
    await expect(rows).toHaveCount(12);
    await rows.nth(1).getByRole("button",{name:/^收藏：/}).click();
    await expect(rows.nth(1).getByRole("button",{name:/^取消收藏：/})).toBeEnabled();
    release();
    await expect(row.getByRole("alert")).toContainText("阅读状态保存失败");
    expect(await rows.evaluateAll(elements=>elements.map(element=>element.getAttribute("data-event-id")))).toEqual(before);
    fail=false;
    await row.getByRole("button",{name:/重试/}).click();
    await expect(rows).toHaveCount(11);
    const feedback=page.locator(".ns-feedback-undo");
    await expect(feedback).toBeVisible();
    expect(requests).toBe(2);
    await feedback.getByRole("button",{name:"撤销不感兴趣",exact:true}).evaluate(button=>{button.click();button.click();});
    const undo=feedback.getByRole("button",{name:"撤销中",exact:true});
    await expect(undo).toHaveAttribute("aria-busy","true");
    await expect(undo).toHaveCSS("cursor","default");
    await page.waitForTimeout(1200);
    expect(requests).toBe(3);
    await page.screenshot({path:info.outputPath("dismissal-undo-pending-1440.png")});
    releaseUndo();
    await expect(rows).toHaveCount(12);
    await expect(feedback).toHaveCount(0);
    expect(state.stateWrites.filter(write=>write.value.notInterested===true)).toHaveLength(1);
    expect(state.stateWrites.filter(write=>write.value.notInterested===false)).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();releaseUndo();}
});

test("feedback pane undo synchronizes the banner without a shared-mutation shape crash",async({page})=>{
  const state=await stubFeedback(page);
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  let release!:()=>void,undoRequests=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/events/${id(0)}/state`,async route=>{
    const input=route.request().postDataJSON() as EventState;
    if(input.notInterested!==false)return route.fallback();
    undoRequests++;
    await gate;
    return route.fallback();
  });
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.goto("/");
    const cards=page.locator(".ns-edition-list article[data-event-id]");
    await cards.first().locator(".ns-reader-row-title button").click();
    const pane=page.getByRole("article",{name:"文章就地阅读",exact:true});
    await pane.getByRole("button",{name:/^不感兴趣：/}).click();
    const banner=page.locator(".ns-feedback-undo");
    await expect(cards).toHaveCount(11);
    await expect(banner).toBeVisible();
    await pane.getByRole("button",{name:/^撤销不感兴趣：/}).click();
    await expect(pane.getByRole("button",{name:/^不感兴趣：/})).toHaveAttribute("aria-busy","true");
    const undo=banner.getByRole("button",{name:"撤销中",exact:true});
    await expect(undo).toHaveAttribute("aria-busy","true");
    await undo.evaluate(button=>button.click());
    expect(undoRequests).toBe(1);
    expect(errors).toEqual([]);
    release();
    await expect(cards).toHaveCount(12);
    await expect(banner).toHaveCount(0);
    expect(state.stateWrites.filter(write=>write.value.notInterested===false)).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();}
});
