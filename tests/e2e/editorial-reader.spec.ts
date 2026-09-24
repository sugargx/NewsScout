import { chromium, expect, test, type Locator, type Page } from "@playwright/test";
import type { Brief, CoverageMember, Event, EventState, Topic } from "../../apps/web/src/types";
import { editionGroups, refreshOutcome } from "../../apps/web/src/editorial";
import { QueryClient } from "@tanstack/react-query";
import { updateReaderState } from "../../apps/web/src/reader";

const titles=["开源模型发布：更小体积与更长上下文","研究团队公开可靠性评测方法","开发工具更新：让调试过程可复现","模型服务新增批量处理能力","研究复现：长文档检索的真实边界","新产品把引用带回每一个结论","工程团队分享迁移过程与经验","本周值得关注的开放数据集","回看：上周发布的推理研究","回看：一份仍有参考价值的实践","回看：阅读原始报告的方法","更多更新：社区发布兼容性说明"];
const id=(index:number)=>`b1000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`;
function fixture(index:number):Event {
  const publishedAt=index<8?"2026-09-15T01:00:00Z":"2026-09-11T01:00:00Z";
  return {
    id:id(index),contentVersion:1,title:`Original publisher title ${index+1}`,displayTitle:titles[index],
    primaryTopic:index<8?"模型与研究":"工程实践",topics:index<8?["模型与研究"]:["工程实践"],eventType:"blog",
    summary:"这项更新公开了适用条件与验证材料。读者可以对照原始报告，了解变化的范围。",
    summaryPoints:["公开适用条件与验证材料，便于独立判断变化。","保留原始报告和限制说明，不把结论外推。","第三条完整摘要只在主动阅读时显示。"],
    summaryMaterialLimit:null,summaryLimitations:[],importance:"说明了具体变化及适用范围。",
    editorial:{policyVersion:"article-value-v1",contentKind:"research",valueScore:80,reason:"确定性规则 article-value-v1；非 AI 重要性判断或事实核验。类型=research；基础值=70；原始材料至少600字（加8）",briefEligible:true},
    firstSeenAt:publishedAt,updatedAt:publishedAt,publishedAt,freshnessAt:publishedAt,publicationPrecision:"time",
    evidence:[{id:`source-${index}`,sourceName:"原始发布者",sourceTier:"T1",title:`Source original ${index+1}`,url:"https://example.com/research",
      isOfficial:true,publishedAt,excerpt:"来源保留的简短摘录。",technicalBasis:"原始研究栏目",
      readingContext:{version:1,kind:"article",origin:"publisher_page",status:"available",sourceUrl:"https://example.com/research",
        body:"已收录的原始研究正文，包含方法与观察，不自动访问来源。",truncated:false,durationSeconds:null,chapters:[],transcriptUrl:null,
        comments:[],commentsStatus:"not_applicable",fetchedAt:publishedAt}}],
    score:{sourceQuality:1,corroboration:1,freshness:1,relevance:1,novelty:1,engagement:1,editorialBoost:0,total:6,explanation:"fixture"},
    personalRelevance:0,personalReason:"fixture",saved:false,read:false,later:false,notInterested:false,seen:false,opened:false,
    recommendation:{score:1,freshness:1,affinity:1,noveltyPenalty:0,facets:["不应冒充主主题"],sourceConfirmed:true,explanation:"fixture"},
    summaryKind:"copilot",summaryModel:null,summarizedAt:publishedAt,summaryEvidenceIds:[`source-${index}`],summaryStatus:"completed",
  };
}
function edition(items:Event[]):Brief {
  return {localDate:"2026-09-15",generatedAt:"2026-09-15T02:00:00Z",estimatedMinutes:8,isSnapshot:false,
    selectionNote:"article-value-v1 确定性保守选文，价值30%与基础值是内部诊断。",
    windowStart:"2026-09-08T00:00:00Z",windowEnd:"2026-09-15T02:00:00Z",items,
    sections:[
      {key:"essential",kind:"essential",title:"核心事件",description:"先看今天的重要变化",eventIds:items.slice(0,8).map(item=>item.id)},
      {key:"catch-up",kind:"catch_up",title:"值得补读",description:"较早发布，仍值得阅读",eventIds:items.slice(8,11).map(item=>item.id)},
      {key:"more",kind:"more",title:"更多更新",description:"有余力时继续浏览",eventIds:items.slice(11).map(item=>item.id)},
    ]};
}
async function stub(page:Page,publicMode=false) {
  let items=titles.map((_,index)=>fixture(index));
  let cutoff="2026-09-15T02:00:00Z";
  let latest:Partial<Brief>={};
  let manyWeeklyTopics=false;
  const stateWrites:{id:string;value:EventState}[]=[],unexpectedWrites:string[]=[],reads:string[]=[];
  const graph={sampleSize:12,limit:100,meaning:"关键词共现",nodes:[{id:"模型与研究",count:8},{id:"工程实践",count:4},{id:"评测",count:2}],
    edges:[{source:"模型与研究",target:"评测",count:2}]};
  const project=(item:Event)=>{const {score,personalReason,personalRelevance,recommendation,saved,read,later,notInterested,opened,seen,notInterestedReason,...rest}=item;return rest;};
  await page.route(/\/(?:api|beta\/api)\//,async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    const send=(json:unknown,status=200)=>route.fulfill({status,json});
    if(request.method()==="POST"&&path.endsWith("/events/exposures")) {
      if(publicMode){unexpectedWrites.push(path);return send({error:"Public exposure writes forbidden"},405);}
      return send({recorded:0,skipped:0});
    }
    if(request.method()==="PUT"&&/\/events\/[^/]+\/state$/.test(path)) {
      if(publicMode){unexpectedWrites.push(path);return send({error:"Public writes forbidden"},405);}
      const eventId=path.split("/").at(-2)!,value=request.postDataJSON() as EventState;
      stateWrites.push({id:eventId,value});items=items.map(item=>item.id===eventId?{...item,...value}:item);
      return send({...items.find(item=>item.id===eventId)??titles.map((_,index)=>fixture(index)).find(item=>item.id===eventId),...value});
    }
    if(request.method()!=="GET"){unexpectedWrites.push(path);return send({error:"Acquisition and model calls forbidden"},405);}
    reads.push(url.pathname+url.search);
    if(path.endsWith("/runtime"))return send({mode:"postgres",timeZone:"Asia/Shanghai",version:"fixture"});
    if(path.endsWith("/me/interests"))return send({items:[{id:"topic",label:"模型与研究",enabled:true,weight:1,group:"test",context:""}]});
    if(path.endsWith("/sources"))return send({items:[{id:"publisher",name:"原始发布者",tier:"T1",contentType:"blog"}]});
    if(path.endsWith("/explore"))return send(graph);
    if(publicMode&&path.endsWith("/reading"))return send({items:items.map(project),nextOffset:null});
    if(path.endsWith("/briefs"))return send({items:[{localDate:"2026-09-01",generatedAt:"2026-09-01T01:00:00Z",itemCount:2}]});
    if(path.endsWith("/briefs/2026-09-01")) {
      const legacy=items.slice(0,2).map(({displayTitle,editorial,notInterestedReason,...rest})=>rest);
      return send({...edition(legacy),localDate:"2026-09-01",isSnapshot:true,sections:undefined});
    }
    if(/\/briefs\/(?:latest|today)$/.test(path)||path.endsWith("/brief"))return send({...edition(items),windowEnd:cutoff,generatedAt:cutoff,...latest,items:publicMode?items.map(project):items});
    if(path.endsWith("/weekly"))return send({...edition(items),sections:manyWeeklyTopics
      ?["评测与安全","记忆与检索","工程与开源","Agent 与工具","模型与多模态","芯片与硬件","AI 编程","治理与政策"].map((title,index)=>({
        key:`topic-${index}`,kind:"topic",title,description:"本周这一主题下值得回顾的进展。",
        eventIds:items.slice(index,index===7?undefined:index+1).map(item=>item.id),
      })):[
      {key:"models",kind:"topic",title:"模型与研究",description:"一周的进展与变化",eventIds:items.slice(0,8).map(item=>item.id)},
      {key:"practice",kind:"topic",title:"工程实践",description:"值得保存的实践",eventIds:items.slice(8).map(item=>item.id)}]});
    if(path.endsWith("/events")) {
      const topic=url.searchParams.get("topic")||url.searchParams.get("facet");
      const selected=items.filter(item=>!topic||item.topics.includes(topic));
      return send({items:publicMode?selected.map(project):selected,nextOffset:null});
    }
    const event=items.find(item=>path.endsWith("/events/"+item.id))??titles.map((_,index)=>fixture(index)).find(item=>path.endsWith("/events/"+item.id));
    if(event)return send(publicMode?project(event):event);
    return send({items:[]});
  });
  if(publicMode)await page.addInitScript(()=>{
    const mark=()=>{if(document.documentElement){document.documentElement.dataset.publicReader="true";observer.disconnect();}};
    const observer=new MutationObserver(mark);observer.observe(document,{childList:true,subtree:true});mark();
  });
  return {stateWrites,unexpectedWrites,reads,
    setCutoff:(value:string)=>{cutoff=value;},
    latest:(value:Partial<Brief>)=>{latest=value;},
    dayOnlyPublication:()=>{items=items.map((item,index)=>index===1?{...item,publicationPrecision:"day"}:item);},
    articleValue:(importance:string,summaryKind:Event["summaryKind"]="copilot")=>{
      items=items.map(item=>({...item,importance,summaryKind}));
    },
    longReadingText:()=>{
      items=items.map(item=>({...item,
        displayTitle:"研究团队公开长文档检索与多智能体协作的评测方法：从原始数据、实现步骤到错误分析，说明不同实验条件下的表现与适用边界",
        summaryPoints:[
          "报告公开了实验设置、对照组与复现步骤，读者可以按照相同条件比较不同方法，而不是仅凭单项成绩判断效果。结果同时区分短文档与长文档、单次调用与连续任务，便于理解这些观察成立的具体范围。",
          "实现说明保留了数据处理、工具调用与错误分析中的关键细节，也列出了没有覆盖的场景。后续使用时仍需要结合自己的数据分布、调用成本与任务要求进行评估，不应把实验结论直接当成通用保证。",
          "第三条完整摘要只在主动阅读时显示。",
        ],
        importance:"这份材料不仅描述了结果，还提供原始数据、实现步骤与错误分析，便于读者独立比较不同方法。报告明确区分了实验条件与实际使用场景，并解释这些差异可能怎样影响结论。关注长文档检索、工具调用或多智能体协作的读者，可以据此判断哪些方法值得进一步复现，哪些结果仍需要补充证据。".repeat(2),
      }));
    },
    longMetadata:()=>{
      manyWeeklyTopics=true;
      items=items.map(item=>({...item,opened:true,
        evidence:item.evidence.map(source=>({...source,sourceName:"Anthropic Research · 官方研究索引"}))}));
    },
    group:(relation:"same_named_topic"|"same_event"="same_named_topic")=>{
      const member=(event:Event,matchesFilters:boolean):CoverageMember=>({
        eventId:event.id,contentVersion:event.contentVersion,title:event.title,displayTitle:event.displayTitle,eventType:event.eventType,
        publishedAt:event.publishedAt??null,publicationPrecision:"time",summaryKind:event.summaryKind,summary:event.summary,
        summaryPoints:event.summaryPoints??[],summaryMaterialLimit:null,summaryLimitations:[],summaryModel:null,summarizedAt:event.summarizedAt,
        evidence:event.evidence,relationship:event.id===id(0)?"lead":relation,materialKind:"editorial",matchesFilters,
      });
      items=[{...items[0],coverage:{key:"fixture-group",topic:"可核验的共同主题",relation,method:"deterministic-name-v1",
        windowHours:168,materialCount:3,newsMaterialCount:3,editorialSourceCount:1,officialSourceCount:0,communityMaterialCount:0,popularityBoost:0,
        members:[member(items[0],true),member(items[1],true),member(items[8],false)]}},...items.slice(2)];
    },
    change:()=>{items=[...items.slice(0,1).map(item=>({...item,contentVersion:2})),...items.slice(1),{...fixture(0),id:id(20),displayTitle:"新增的明确变化"}];}};
}

test.use({serviceWorkers:"block"});
test.beforeEach(async({page})=>{
  const base=process.env.SCOUTNEWS_E2E_BASE_URL;
  const isolated=process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE==="true";
  const mockOnly=process.env.SCOUTNEWS_E2E_MOCK_ONLY==="true";
  if(!base||!isolated&&!mockOnly)
    throw new Error("Use the isolated E2E launcher, or explicitly opt into API-blocked mock-only UI checks.");
  if(mockOnly&&!["127.0.0.1","localhost","[::1]"].includes(new URL(base).hostname))
    throw new Error("Mock-only UI checks require a local frontend.");
  await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
});

for (const publicMode of [false, true]) for (const width of [1440, 1024, 768, 390]) {
  test(`CoDesign reading contract ${publicMode ? "public" : "owner"} ${width}`, async ({page}, info) => {
    const state = await stub(page, publicMode);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({colorScheme:"light", reducedMotion:"reduce"});
    await page.setViewportSize({width, height: width === 390 ? 844 : 1000});
    await page.goto("/");
    await expect(page.getByRole("heading", {name:"今日精选", exact:true})).toBeVisible();
    const cardSelector = publicMode ? ".ns-beta-feed [data-public-event]" : ".ns-edition-list [data-event-id]";
    const cards = page.locator(cardSelector);
    await expect(cards).toHaveCount(12);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cp-accent").trim())).toBe("#275d52");
    if (width > 768) {
      expect((await page.locator(".ns-reader-sidebar").boundingBox())?.width).toBe(176);
    } else {
      await expect(page.getByRole("button", {name:"打开导航", exact:true})).toBeVisible();
      await expect(page.locator(".ns-reader-sidebar")).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath("selection.png"), fullPage:false});
    const opener = cards.nth(2).locator("h3 button");
    await opener.scrollIntoViewIfNeeded();
    const beforeScroll = await page.evaluate(() => window.scrollY);
    await opener.click();
    const pane = page.getByRole(publicMode ? "complementary" : "article", {name:publicMode ? "公开文章阅读区" : "文章就地阅读", exact:true});
    await expect(pane.getByRole("heading", {name:titles[2], exact:true})).toBeVisible();
    const bounds = await pane.boundingBox();
    expect(bounds?.y).toBe(0);
    expect(bounds?.height).toBe(width === 390 ? 844 : 1000);
    if (width <= 1024) {
      await expect(page.getByRole("dialog", {name:"文章阅读窗口", exact:true})).toBeVisible();
      await page.keyboard.press("Tab");
      expect(await pane.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await pane.evaluate(element => element.contains(document.activeElement))).toBe(true);
    } else {
      expect(bounds!.width).toBeGreaterThanOrEqual(440);
      expect(bounds!.width).toBeLessThanOrEqual(720);
    }
    await page.screenshot({path:info.outputPath("reader.png"), fullPage:false});
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(Math.abs(await page.evaluate(() => window.scrollY) - beforeScroll)).toBeLessThanOrEqual(2);
    await page.getByRole("button", {name:/^最近 24 小时的新内容/}).click();
    await expect(page.getByRole("heading", {name:"新闻雷达", exact:true})).toBeVisible();
    const tasks = page.getByRole("group", {name:"雷达浏览任务", exact:true});
    await expect(tasks.getByRole("button", {name:/最近 24 小时/})).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => {
      const url = new URL(state.reads.filter(value => /\/events\?/.test(value)).at(-1)!, "http://localhost");
      return [url.searchParams.get("hours"), url.searchParams.get("sort")];
    }).toEqual(["24", "newest"]);
    const filters = page.locator('[data-ui="radar-filters"]');
    await filters.getByLabel("主题筛选").selectOption("模型与研究");
    await tasks.getByRole("button", {name:/值得阅读/}).click();
    await expect(filters.getByLabel("主题筛选")).toHaveValue("模型与研究");
    await page.getByText("更多筛选 · 时间与排序",{exact:true}).click();
    await expect(page.getByLabel("时间范围",{exact:true})).toHaveValue("72");
    await expect(page.getByLabel("排序", {exact:true})).toHaveValue("recommended");
    await expect(page.locator(publicMode ? ".ns-beta-feed [data-public-event]" : ".ns-reader-list [data-event-id]")).toHaveCount(8);
    await page.screenshot({path:info.outputPath("radar.png"), fullPage:false});
    await page.getByRole("tab", {name:"主题地图", exact:true}).click();
    await expect(page.getByRole("heading", {name:/^主题共现地图 · \d+ 个主题$/})).toBeAttached();
    await expect(page.getByRole("group", {name:"关联文章", exact:true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath("topics.png"), fullPage:false});
    await page.goto(publicMode ? "/?tab=weekly" : "/weekly");
    await expect(page.getByRole("heading", {name:"选择一个主题开始回顾", exact:true})).toBeVisible();
    await page.getByRole("navigation", {name:"本周主题导航", exact:true}).getByRole("button", {name:/模型与研究/}).click();
    await expect(page.locator(cardSelector)).toHaveCount(8);
    await page.screenshot({path:info.outputPath("weekly.png"), fullPage:false});
    await page.goto(publicMode ? "/?tab=reading" : "/reading");
    await expect(page.getByRole("heading", {name:titles[0], exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("deep-reading.png"), fullPage:false});
    await page.getByRole("button", {name:"从第 1 篇开始", exact:true}).click();
    await expect(page.getByRole(publicMode ? "complementary" : "article", {name:publicMode ? "公开文章阅读区" : "文章就地阅读", exact:true})).toBeVisible();
    expect(state.unexpectedWrites).toEqual([]);
    if (publicMode) expect(state.stateWrites).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const publicMode of [false, true]) test(`CoDesign mobile navigation ${publicMode ? "public" : "owner"}`, async ({page}) => {
  await stub(page, publicMode);
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/");
  await expect(page.getByRole("heading", {name:"今日精选", exact:true})).toBeVisible();
  const toggle = page.getByRole("button", {name:"打开导航", exact:true});
  await toggle.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  const nav = drawer.getByRole("navigation", {name:publicMode ? "公开阅读视图" : "主导航", exact:true});
  await expect(nav.getByRole(publicMode ? "button" : "link")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await nav.getByRole(publicMode ? "button" : "link", {name:"每周回顾", exact:true}).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", {name:"每周回顾", exact:true})).toBeVisible();
});

for(const width of [1440,390])test(`CoDesign public utility interests returns focus ${width}`,async({page})=>{
  const state=await stub(page,true);
  await page.setViewportSize({width,height:900});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/");
  await expect(page.getByRole("heading",{name:"今日精选",exact:true})).toBeVisible();
  if(width<=1024)await page.getByRole("button",{name:"打开导航",exact:true}).click();
  const utility=page.locator(width<=1024?".ns-reader-mobile-nav":".ns-reader-sidebar");
  const opener=utility.getByRole("button",{name:"兴趣设置",exact:true});
  await opener.click();
  const dialog=page.getByRole("dialog",{name:"兴趣主题",exact:true});
  await expect(dialog).toBeVisible();
  if(width<=1024)await expect(utility).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(width<=1024?page.getByRole("button",{name:"兴趣主题",exact:true}):opener).toBeFocused();
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.stateWrites).toEqual([]);
});

test("section annotations preserve order, membership and legacy editions without making classifications",()=>{
  const items=titles.map((_,index)=>fixture(index)),data=edition(items);
  expect(editionGroups(items,data.sections).flatMap(group=>group.items.map(item=>item.id))).toEqual(items.map(item=>item.id));
  expect(editionGroups(items,[])).toEqual([{key:"legacy-0",items,section:undefined}]);
  expect(editionGroups([...items,items[0]],data.sections).flatMap(group=>group.items)).toHaveLength(items.length);
  expect(refreshOutcome(items,items.map(item=>({...item,saved:true,opened:true})))).toContain("没有新增内容");
  expect(refreshOutcome(items,[...items].reverse())).toContain("仅推荐顺序发生变化");
  expect(refreshOutcome(items,items.map((item,index)=>index?item:{...item,displayTitle:"中文标题完成",summarizedAt:"2026-09-15T03:00:00Z"}))).toContain("新增 0 条 · 更新 1 条");
  expect(refreshOutcome(items,items.slice(1))).not.toContain("仅推荐顺序");
});

test("topic feedback patches paged and legacy caches without touching public state",()=>{
  const client=new QueryClient(),item=fixture(0),page={items:[item],nextOffset:null};
  client.setQueryData(["topic-events","legacy"],page);
  client.setQueryData(["topic-events","paged"],{pages:[page],pageParams:[0]});
  client.setQueryData(["public-topic-events"],{pages:[page],pageParams:[0]});
  updateReaderState(client,{...item,opened:true,saved:true});
  expect(client.getQueryData(["topic-events","legacy"])).toEqual({items:[{...item,opened:true,saved:true}],nextOffset:null});
  expect(client.getQueryData(["topic-events","paged"])).toEqual({pages:[{items:[{...item,opened:true,saved:true}],nextOffset:null}],pageParams:[0]});
  expect(client.getQueryData(["public-topic-events"])).toEqual({pages:[page],pageParams:[0]});
  client.clear();
});

for(const theme of ["light","dark"])for(const width of [1440,390]) {
  test(`content-first brief geometry and reading focus ${theme} ${width}`,async({page},info)=>{
    const state=await stub(page);
    await page.setViewportSize({width,height:width===390?844:1000});
    await page.goto("/");
    await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
    const cards=page.locator(".ns-edition-list article[data-event-id]");
    await expect(cards).toHaveCount(12);
    const titles=cards.locator(".ns-reader-row-title button");
    const boxes=await titles.evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
    await expect(page.getByRole("button",{name:/^最近 24 小时的新内容/})).toBeVisible();
    expect(boxes[0].bottom).toBeLessThanOrEqual(width===390?744:800);
    expect(boxes.filter(box=>box.top>=0&&box.bottom<=(width===390?844:900)).length).toBeGreaterThanOrEqual(width===390?1:2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    expect(await cards.evaluateAll(elements=>elements.map(element=>element.getAttribute("data-event-id")))).toEqual(titlesForIds());
    await expect(page.locator('[data-section="catch_up"] [data-event-id]')).toHaveCount(3);
    await expect(page.locator('[data-section="catch_up"]')).toContainText("2026/9/11");
    await expect(page.getByRole("button",{name:"采集最新新闻",exact:true})).toHaveCount(0);
    await expect(cards.first()).not.toContainText("不应冒充主主题");
    expect(state.stateWrites).toEqual([]);
    await page.screenshot({path:info.outputPath(`brief-${theme}-${width}.png`),fullPage:false});
    const first=titles.first();
    await first.click();
    const reader=page.getByRole("article",{name:"文章就地阅读",exact:true});
    await expect(reader).toBeVisible();
    await expect(reader).toContainText("原始标题：Original publisher title 1");
    await expect(reader).toContainText("第三条完整摘要");
    if(width===390) {
      await expect(page.getByRole("dialog",{name:"文章阅读窗口"})).toBeVisible();
      await reader.focus();await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(()=>!!document.activeElement?.closest(".ns-preview"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
    await expect(first).toBeFocused();
    expect(state.unexpectedWrites).toEqual([]);
  });
}
function titlesForIds(){return titles.map((_,index)=>id(index));}

for(const publicMode of [false,true])for(const width of [1280,1440,1920,2560,390]) {
  test(`${publicMode?"public":"owner"} reading text uses the available column ${width}`,async({page},info)=>{
    const state=await stub(page,publicMode);state.longReadingText();
    await page.setViewportSize({width,height:900});
    await page.goto("/radar");
    const row=page.locator("article.ns-reader-row").first();
    await expect(row).toBeVisible();
    const geometry=await row.evaluate(element=>{
      const rect=element.getBoundingClientRect(),content=element.querySelector(".ns-reader-row-content")!.getBoundingClientRect();
      const preview=element.querySelector<HTMLElement>(".ns-reader-row-preview")!,actions=element.querySelector(".ns-reader-row-actions")!.getBoundingClientRect();
      const width=(selector:string)=>element.querySelector(selector)!.getBoundingClientRect().width;
      return {rowLeft:rect.left,rowRight:rect.right,rowBottom:rect.bottom,contentWidth:content.width,contentTop:content.top,contentRight:content.right,contentBottom:content.bottom,
        titleWidth:width(".ns-reader-row-title"),previewWidth:preview.getBoundingClientRect().width,previewScroll:preview.scrollWidth,previewClient:preview.clientWidth,
        metaWidth:width(".ns-reader-story-meta"),actionsX:actions.x,actionsY:actions.y,actionsRight:actions.right,actionsBottom:actions.bottom};
    });
    expect(geometry.titleWidth).toBeCloseTo(geometry.contentWidth,0);
    expect(geometry.previewWidth).toBeCloseTo(geometry.contentWidth,0);
    expect(geometry.metaWidth).toBeCloseTo(geometry.contentWidth,0);
    expect(geometry.previewScroll).toBeLessThanOrEqual(geometry.previewClient);
    expect(geometry.actionsRight).toBeLessThanOrEqual(geometry.rowRight+.5);
    expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.rowBottom);
    if(width>768) {
      expect(geometry.actionsX).toBeGreaterThanOrEqual(geometry.contentRight+17);
      expect(geometry.actionsY).toBeCloseTo(geometry.contentTop,0);
      expect(geometry.rowRight-geometry.actionsRight).toBeLessThan(1);
    } else {
      expect(geometry.contentWidth).toBeCloseTo(geometry.rowRight-geometry.rowLeft,0);
      expect(geometry.actionsY).toBeGreaterThanOrEqual(geometry.contentBottom);
      expect(geometry.actionsRight).toBeCloseTo(geometry.rowRight,0);
    }
    await expect(row).not.toContainText("第三条完整摘要");
    await page.screenshot({path:info.outputPath(`row-column-${publicMode?"public":"owner"}-${width}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(state.stateWrites).toEqual([]);expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const publicMode of [false,true])for(const theme of ["light","dark"])for(const width of [1440,390]) {
  test(`${publicMode?"public":"owner"} form controls keep one focus treatment ${theme} ${width}`,async({page},info)=>{
    const state=await stub(page,publicMode);
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.setViewportSize({width,height:900});
    await page.goto("/");
    const edition=page.getByLabel(publicMode?"晨报版本":"精选日期",{exact:true});
    const ring=(locator=edition)=>locator.evaluate(element=>{const style=getComputedStyle(element);return {style:style.outlineStyle,width:style.outlineWidth,offset:style.outlineOffset,color:style.outlineColor};});
    // WCAG 1.4.11: the ring must reach 3:1 against the colour showing through its offset gap.
    const contrast=(locator:Locator)=>locator.evaluate(element=>{
      const parse=(value:string)=>{const [r,g,b,a=1]=value.match(/[\d.]+/g)!.map(Number);return {r,g,b,a};};
      const layers:{r:number;g:number;b:number;a:number}[]=[];
      for(let node=element.parentElement;node;node=node.parentElement){const color=parse(getComputedStyle(node).backgroundColor);if(color.a>0)layers.push(color);if(color.a>=1)break;}
      const base=layers.reverse().reduce((under,over)=>({r:over.r*over.a+under.r*(1-over.a),g:over.g*over.a+under.g*(1-over.a),b:over.b*over.a+under.b*(1-over.a),a:1}),{r:255,g:255,b:255,a:1});
      const luminance=({r,g,b}:{r:number;g:number;b:number})=>{const [R,G,B]=[r,g,b].map(value=>{const c=value/255;return c<=.03928?c/12.92:((c+.055)/1.055)**2.4;});return .2126*R+.7152*G+.0722*B;};
      const outline=parse(getComputedStyle(element).outlineColor);
      const [ring,behind]=[luminance(outline),luminance(base)];
      return {alpha:outline.a,ratio:(Math.max(ring,behind)+.05)/(Math.min(ring,behind)+.05)};
    });
    await expect(edition).toBeVisible();
    expect(await edition.evaluate(element=>element.tagName==="SELECT"&&!element.closest(".fui-Select"))).toBe(true);
    await edition.focus();await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(edition).toBeFocused();
    expect(await edition.evaluate(element=>element.matches(":focus-visible"))).toBe(true);
    const focus=await ring();
    expect(focus).toMatchObject({style:"solid",width:"3px",offset:"2px"});
    expect(focus.color).not.toBe("rgba(0, 0, 0, 0)");
    const visibleAgainst=async(locator:Locator)=>{const edge=await contrast(locator);
      expect(edge.alpha).toBe(1);expect(edge.ratio,`focus ring contrast ${edge.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);};
    await visibleAgainst(edition);
    await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect(edition).toHaveValue("2026-09-01");
    await expect(page.locator(publicMode?"[data-public-event]":".ns-edition-list article[data-event-id]")).toHaveCount(2);
    await page.screenshot({path:info.outputPath(`edition-focus-${publicMode?"public":"owner"}-${theme}-${width}.png`)});
    const title=page.locator(publicMode?".ns-reader-story-title>button":".ns-reader-row-title>button").first();
    await title.focus();
    expect(await ring(title)).toEqual(focus);
    await visibleAgainst(title);
    await page.goto("/radar");
    const search=page.locator(".ns-filter-search input");
    await search.click();
    expect(await search.evaluate(element=>getComputedStyle(element).outlineStyle)).toBe("none");
    expect(await ring(page.locator(".ns-filter-search"))).toEqual(focus);
    await visibleAgainst(page.locator(".ns-filter-search"));
    expect(state.stateWrites).toEqual([]);expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const publicMode of [false,true]) {
  test(`${publicMode?"public":"owner"} grouped rows do not reserve an empty action column`,async({page})=>{
    const state=await stub(page,publicMode);state.group("same_event");
    await page.setViewportSize({width:1920,height:900});
    await page.goto("/radar");
    const row=page.locator("article.ns-reader-row").first();
    await expect(row).toBeVisible();
    await expect(row.locator(".ns-reader-row-actions")).toHaveCount(0);
    const dimensions=await row.evaluate(element=>({width:element.clientWidth,
      contentWidth:element.querySelector(".ns-reader-row-content")!.getBoundingClientRect().width,
      titleWidth:element.querySelector(".ns-reader-row-title")!.getBoundingClientRect().width}));
    expect(dimensions.contentWidth).toBeCloseTo(dimensions.width,0);
    expect(dimensions.titleWidth).toBeCloseTo(dimensions.width,0);
    expect(state.stateWrites).toEqual([]);expect(state.unexpectedWrites).toEqual([]);
  });

  test(`${publicMode?"public":"owner"} select focus remains visible in forced colors`,async({page})=>{
    await stub(page,publicMode);
    await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
    await page.goto("/");
    const edition=page.getByLabel(publicMode?"晨报版本":"精选日期",{exact:true});
    await edition.focus();await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(edition).toBeFocused();
    const focus=await edition.evaluate(element=>{const style=getComputedStyle(element);
      return {style:style.outlineStyle,width:parseFloat(style.outlineWidth),color:style.outlineColor,background:style.backgroundColor};});
    expect(focus.style).toBe("solid");expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.color).not.toBe(focus.background);expect(focus.color).not.toBe("rgba(0, 0, 0, 0)");
  });
}

test("wide card pending and error feedback stays inside its surface",async({page},info)=>{
  await stub(page);
  await page.setViewportSize({width:1440,height:1000});
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/events/${id(0)}/state`,async route=>{
    await gate;await route.fulfill({status:503,json:{error:"阅读状态暂时无法保存，请稍后重试。"}});
  });
  try {
    await page.goto("/");
    const cards=page.locator(".ns-edition-list article[data-event-id]"),first=cards.first();
    await first.getByRole("button",{name:/^收藏：/}).click();
    await expect(first.locator(".ns-event-actions")).toHaveAttribute("aria-busy","true");
    await expect(first.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-pressed","true");
    await expect(first.getByText("正在保存…",{exact:true})).toHaveCount(0);
    const assertContained=async()=>{
      const card=(await first.boundingBox())!,feedback=(await first.locator(".ns-event-actions").boundingBox())!;
      expect(feedback.y+feedback.height).toBeLessThanOrEqual(card.y+card.height);
      expect((await cards.nth(1).boundingBox())!.y).toBeGreaterThanOrEqual(card.y+card.height);
    };
    await assertContained();
    release();
    await expect(first.getByRole("alert")).toContainText("阅读状态保存失败");
    await assertContained();
    await page.screenshot({path:info.outputPath("owner-card-error-1440.png")});
  } finally {release();}
});

for(const width of [768,390]) {
  test(`owner navigation keeps reading and tools reachable ${width}`,async({page},info)=>{
    const state=await stub(page);
    await page.setViewportSize({width,height:900});
    await page.goto("/");
    await expect(page.getByRole("heading",{name:"今日精选",exact:true})).toBeVisible();
    const navigation=page.getByRole("button",{name:"打开导航",exact:true});
    await navigation.click();
    const drawer=page.getByRole("dialog");
    await expect(drawer.getByRole("navigation",{name:"主导航",exact:true}).getByRole("link")).toHaveCount(5);
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().endTime!==Infinity).map(animation=>animation.finished.catch(()=>undefined))));
    const links=drawer.getByRole("navigation",{name:"工具",exact:true}).getByRole("link");
    await expect(links).toHaveCount(4);
    await expect(drawer.getByRole("link",{name:"兴趣权重",exact:true})).toHaveAttribute("href","/topics");
    await expect(drawer.getByRole("link",{name:"设置",exact:true})).toHaveAttribute("href","/settings");
    for(const link of await links.all()) {
      const box=(await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x+box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({path:info.outputPath(`owner-navigation-${width}.png`)});
    await links.first().focus();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(navigation).toBeFocused();
    expect(state.unexpectedWrites).toEqual([]);
  });
}
for(const width of [1280,390]) {
  test(`owner and public rows use the same design contract ${width}`,async({browser})=>{
    const shapes:unknown[]=[];
    for(const publicMode of [false,true]) {
      const context=await browser.newContext({viewport:{width,height:900}});
      try {
        const page=await context.newPage();
        await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
        await stub(page,publicMode);
        await page.goto(process.env.SCOUTNEWS_E2E_BASE_URL!+"/radar");
        const row=page.locator("article.ns-reader-row").first();
        await expect(row).toBeVisible();
        shapes.push(await row.evaluate(element=>{
          const title=element.querySelector(".ns-reader-row-title")!,button=element.querySelector(".ns-read-button")!,preview=element.querySelector(".ns-reader-row-preview")!;
          const style=getComputedStyle(element),heading=getComputedStyle(title),control=getComputedStyle(button),copy=getComputedStyle(preview);
          return {radius:style.borderRadius,padding:style.padding,columns:style.gridTemplateColumns.split(" ").length,
            titleFont:heading.fontFamily,titleSize:heading.fontSize,titleLine:heading.lineHeight,titleWeight:heading.fontWeight,
            previewSize:copy.fontSize,previewLine:copy.lineHeight,buttonRadius:control.borderRadius,buttonHeight:button.getBoundingClientRect().height};
        }));
      } finally {await context.close();}
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[0]).toMatchObject({radius:"0px",buttonRadius:"6px",titleWeight:"600"});
  });
}

test("the daily edition stays fixed without manual updates; archives without editorial fields stay faithful",async({page})=>{
  const state=await stub(page);
  await page.goto("/");
  await expect(page.locator("article[data-event-id]")).toHaveCount(12);
  await expect(page.getByText("每天定时生成当天精选，生成后全天固定，按价值从高到低排列。",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:/应用更新|保存今日简报|分享卡片/})).toHaveCount(0);
  await expect(page.getByText("版本与分享",{exact:true})).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/article-value-v1|editorial-significance|确定性|基础值/);
  await expect(page.getByRole("link",{name:"生成今日分享图",exact:true})).toHaveAttribute("href","/share");
  const before=state.reads.filter(path=>path.endsWith("/briefs/latest")).length;
  state.change();
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  expect(state.reads.filter(path=>path.endsWith("/briefs/latest")).length).toBe(before);
  await expect(page.locator("article[data-event-id]")).toHaveCount(12);
  const edition=page.getByLabel("精选日期",{exact:true});
  await expect(edition.locator("option")).toHaveText(["今日精选（最新）","2026-09-01 · 2 条"]);
  await edition.selectOption("2026-09-01");
  await expect(page.getByRole("heading",{name:"往期精选",exact:true})).toBeVisible();
  await expect(page.locator('.ns-edition-list [data-event-id]')).toHaveCount(2);
  await expect(page.locator('.ns-edition-list')).toContainText("Original publisher title 1");
  await expect(page.locator('[data-section="essential"],[data-section="catch_up"]')).toHaveCount(0);
  await expect(page.getByRole("link",{name:"生成今日分享图",exact:true})).toHaveCount(0);
  expect(state.unexpectedWrites).toEqual([]);
});

for(const width of [1440,390])test(`edition cutoff and next refresh stay fixed and respect source precision ${width}`,async({page},info)=>{
  const state=await stub(page);
  state.dayOnlyPublication();
  state.latest({isSnapshot:true,nextRefreshAt:"2026-09-15T22:00:00Z"});
  await page.setViewportSize({width,height:width===390?844:1000});
  await page.emulateMedia({colorScheme:"light",reducedMotion:"reduce"});
  await page.goto("/");
  const cutoff=page.getByLabel("本版选文截止",{exact:true});
  await expect(cutoff).toHaveAttribute("datetime","2026-09-15T02:00:00Z");
  await expect(cutoff).toHaveText("选文截至 9月15日 10:00");
  await expect(page.getByLabel("下次更新",{exact:true})).toHaveText("下次更新 9月16日 06:00");
  // Meta parts wrap as whole units, so no line starts with a separator.
  expect(await page.locator(".ns-batch-meta .ns-meta-part").evaluateAll(parts=>parts.map(part=>part.textContent))).toEqual(
    ["9月15日版\u00a0·","12 篇\u00a0·",expect.stringMatching(/^约 \d+ 分钟\u00a0·$/),"选文截至 9月15日 10:00\u00a0·","下次更新 9月16日 06:00"]);
  await expect(page.getByText(/尚未生成|正在生成/)).toHaveCount(0);
  const cards=page.locator(".ns-edition-list article[data-event-id]");
  await expect(cards.first().locator("time")).toHaveText("2026/9/15 09:00:00");
  await expect(cards.nth(1).locator("time")).toHaveText("2026/9/15");
  await expect(cards.first().locator("time")).toHaveAttribute("datetime","2026-09-15T01:00:00Z");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`freshness-cutoff-${width}.png`),fullPage:false});
  const before=state.reads.filter(path=>path.endsWith("/briefs/latest")).length;
  state.setCutoff("2026-09-15T03:00:00Z");
  state.change();
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  expect(state.reads.filter(path=>path.endsWith("/briefs/latest")).length).toBe(before);
  await expect(cutoff).toHaveAttribute("datetime","2026-09-15T02:00:00Z");
  await expect(cards).toHaveCount(12);
  await page.getByLabel("精选日期",{exact:true}).selectOption("2026-09-01");
  await expect(page.getByLabel("本版选文截止",{exact:true})).toHaveAttribute("datetime","2026-09-15T02:00:00Z");
  await expect(page.getByLabel("下次更新",{exact:true})).toHaveCount(0);
  await expect(page.locator(".ns-edition-list")).toContainText("Original publisher title 1");
  expect(state.unexpectedWrites).toEqual([]);
});

test("a pending morning edition keeps the previous one readable and switches over by itself",async({page})=>{
  await page.clock.install({time:new Date("2026-09-15T22:03:00Z")});
  const state=await stub(page);
  state.latest({isSnapshot:true,refreshPending:true,nextRefreshAt:null});
  await page.goto("/");
  const cards=page.locator(".ns-edition-list article[data-event-id]");
  await expect(cards).toHaveCount(12);
  await expect(page.getByRole("status").filter({hasText:"今日精选正在生成，先为你展示上一期"})).toBeVisible();
  state.change();
  state.latest({localDate:"2026-09-16",isSnapshot:true,refreshPending:false,nextRefreshAt:"2026-09-16T22:00:00Z"});
  await page.clock.fastForward("01:05");
  await expect(page.getByRole("status").filter({hasText:"今日精选已更新为 9月16日版。"})).toBeVisible();
  await expect(cards).toHaveCount(13);
  await expect(page.getByRole("status").filter({hasText:"今日精选正在生成"})).toHaveCount(0);
  await expect(page.getByLabel("下次更新",{exact:true})).toHaveText("下次更新 9月17日 06:00");
  expect(state.unexpectedWrites).toEqual([]);
});

test("Radar keeps primary filters compact, preserves them between views and exposes a real refresh outcome",async({page},info)=>{
  const state=await stub(page);
  await page.setViewportSize({width:390,height:844});
  await page.goto("/radar");
  const first=page.locator("article[data-event-id] h2 button").first();
  await expect(first).toBeVisible();
  expect((await first.boundingBox())!.y).toBeLessThanOrEqual(700);
  await page.screenshot({path:info.outputPath("radar-mobile.png")});
  await page.getByLabel("来源筛选",{exact:true}).selectOption("T1");
  await page.getByRole("tab",{name:"主题地图",exact:true}).click();
  await expect(page.getByLabel("来源筛选",{exact:true})).toHaveValue("T1");
  await page.getByRole("tab",{name:"列表",exact:true}).click();
  await expect(page.getByLabel("来源筛选",{exact:true})).toHaveValue("T1");
  await expect(page.getByLabel("当前筛选")).toContainText("T1");
  await expect(page).toHaveURL(/tier=T1/);
  await page.getByRole("button",{name:"应用更新",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"没有新增内容"})).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});

test("mobile Radar and weekly keep long publisher labels and a large outline below the content threshold",async({page})=>{
  const state=await stub(page);state.longMetadata();
  await page.setViewportSize({width:390,height:844});
  for(const route of ["/radar","/weekly"]) {
    await page.goto(route);
    if(route==="/weekly")await page.getByRole("navigation",{name:"本周主题导航",exact:true}).getByRole("button",{name:/评测与安全/}).click();
    const title=page.locator("article[data-event-id] .ns-reader-row-title button").first();
    await expect(title).toBeVisible();
    expect((await title.boundingBox())!.y).toBeLessThanOrEqual(744);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator("article[data-event-id]").first().locator(".ns-article-source"))
      .toHaveAttribute("title","Anthropic Research · 官方研究索引");
  }
  await expect(page.getByRole("navigation",{name:"本周主题导航"}).getByRole("button")).toHaveCount(9);
  expect(state.stateWrites).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("dismissal is immediate, reason optional, undo restores the same frozen position",async({page})=>{
  const state=await stub(page);
  await page.goto("/");
  const first=page.locator(`[data-event-id="${id(0)}"]`);
  await first.getByRole("button",{name:/^不感兴趣：/}).click();
  await expect(first).toHaveCount(0);
  const feedback=page.getByRole("complementary",{name:"不感兴趣反馈",exact:true});
  await expect(feedback).toBeVisible();
  expect(state.stateWrites[0].value).toEqual({notInterested:true,notInterestedReason:null});
  await feedback.getByText("补充理由（可选）",{exact:true}).click();
  await feedback.getByRole("button",{name:"内容太旧",exact:true}).click();
  await expect(feedback.getByRole("button",{name:"内容太旧",exact:true})).toHaveAttribute("aria-pressed","true");
  expect(state.stateWrites.at(-1)?.value.notInterestedReason).toBe("old");
  await feedback.getByRole("button",{name:"撤销不感兴趣",exact:true}).click();
  await expect(page.locator(".ns-edition-list article[data-event-id]").first()).toHaveAttribute("data-event-id",id(0));
  expect(state.stateWrites.every(write=>write.value.read===undefined&&write.value.later===undefined)).toBe(true);
  expect(state.unexpectedWrites).toEqual([]);
});

test("weekly has a theme outline and full summary only after selection; deep reading never auto-opens",async({page})=>{
  const state=await stub(page);
  await page.goto("/weekly");
  await expect(page.getByRole("navigation",{name:"本周主题导航"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"选择一个主题开始回顾",exact:true})).toBeVisible();
  await expect(page.locator(".ns-edition-list article[data-event-id]")).toHaveCount(0);
  await page.getByRole("navigation",{name:"本周主题导航"}).getByRole("button",{name:"全部主题",exact:true}).click();
  await expect(page.locator('[data-section="topic"]')).toHaveCount(2);
  await expect(page.locator(".ns-edition-list article[data-event-id]")).toHaveCount(12);
  expect(state.stateWrites).toEqual([]);
  await page.locator("article[data-event-id] .ns-reader-row-title button").first().click();
  await expect(page.getByRole("article",{name:"文章就地阅读",exact:true})).toContainText("第三条完整摘要");
  await page.keyboard.press("Escape");
  state.stateWrites.length=0;
  await page.goto("/reading");
  await expect(page.getByRole("heading",{level:1,name:"深度阅读"})).toBeVisible();
  await expect(page.getByLabel("阅读时间范围",{exact:true})).toHaveValue("720");
  await expect(page.locator(".ns-reader-start")).toContainText(titles[0]);
  await expect(page.locator(".ns-library-item")).toHaveCount(11);
  await expect(page.locator(".ns-library-list")).not.toContainText("原始研究栏目");
  expect(state.stateWrites).toEqual([]);
});

test("topic map starts unfiltered, selects no article, and shows only direct shared-keyword edges",async({page},info)=>{
  const state=await stub(page);
  await page.goto("/radar?view=topics");
  const results=page.getByRole("complementary",{name:"主题文章列表",exact:true});
  await expect(results.locator(".ns-topic-article")).toHaveCount(12);
  await expect(page.locator('[data-topic-id][aria-pressed="true"]')).toHaveCount(0);
  expect(state.stateWrites).toEqual([]);
  await page.locator('[data-topic-id="工程实践"]').click();
  await expect(results.locator(".ns-topic-article")).toHaveCount(4);
  await expect(page.locator("[data-edge-source]")).toHaveCount(0);
  await page.screenshot({path:info.outputPath("focused-topic-map.png")});
  const article=results.locator(".ns-topic-article").first();
  await article.click();
  await expect(page.getByRole("article",{name:"文章就地阅读",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"返回主题结果",exact:true}).click();
  await expect(article).toBeFocused();
  await expect(results.locator(".ns-topic-article")).toHaveCount(4);
  expect(state.unexpectedWrites).toEqual([]);
});

test("topic bundles keep matching materials closed under filters and restore a material opener",async({page})=>{
  const state=await stub(page);state.group();
  await page.goto("/radar?view=topics");
  await page.locator('[data-topic-id="模型与研究"]').click();
  const results=page.getByRole("complementary",{name:"主题文章列表",exact:true});
  const bundle=results.locator('[data-coverage-key="fixture-group"]');
  await expect(bundle).toBeVisible();
  expect(state.reads.some(path=>path.includes("/events?")&&path.includes("coverage=true")&&path.includes("facet="))).toBe(true);
  await bundle.locator("summary").click();
  await expect(bundle.locator("[data-coverage-member]")).toHaveCount(2);
  await expect(bundle).not.toContainText(titles[8]);
  expect(state.stateWrites).toEqual([]);
  const opener=bundle.locator(`[data-coverage-member="${id(1)}"] h3 button`);
  await opener.click();
  const reader=page.getByRole("article",{name:"文章就地阅读",exact:true});
  await expect(reader).toBeVisible();
  await reader.locator(".cp-coverage > summary").click();
  await expect(reader.locator("[data-coverage-member]")).toHaveCount(2);
  await expect(reader).not.toContainText(titles[8]);
  await page.getByRole("navigation",{name:"切换匹配文章",exact:true}).getByRole("button",{name:"上一篇",exact:true}).click();
  await expect(reader.getByRole("heading",{level:2,name:titles[0],exact:true})).toBeVisible();
  await page.getByRole("button",{name:"返回主题结果",exact:true}).click();
  await expect(opener).toBeFocused();
  await expect(bundle).toHaveAttribute("open","");
  expect(state.unexpectedWrites).toEqual([]);
});

test("public topic bundles never display material outside the selected filter",async({page})=>{
  const state=await stub(page,true);state.group();
  await page.goto("/?tab=radar&view=topics");
  const bundle=page.locator('.ns-topic-article-list [data-coverage-key="fixture-group"]');
  await expect(bundle).toBeVisible();
  await expect(page.getByRole("heading",{level:1,name:"新闻雷达",exact:true})).toBeVisible();
  await expect(page.getByRole("tab",{name:"主题地图",exact:true})).toHaveAttribute("aria-selected","true");
  expect(state.reads.some(path=>path.includes("/events?")&&path.includes("facet="))).toBe(false);
  await page.locator('[data-topic-id="模型与研究"]').click();
  await expect.poll(()=>state.reads.some(path=>path.includes("/events?")&&path.includes("facet="))).toBe(true);
  await expect(page.getByRole("heading",{level:1,name:"新闻雷达",exact:true})).toBeVisible();
  await bundle.locator("summary").click();
  await expect(bundle.locator("[data-coverage-member]")).toHaveCount(2);
  await expect(bundle).not.toContainText(titles[8]);
  await bundle.locator(`[data-coverage-member="${id(1)}"] h3 button`).click();
  const reader=page.getByRole("complementary",{name:"公开文章阅读区",exact:true});
  await expect(reader).toBeVisible();
  await reader.locator(".cp-coverage > summary").click();
  await expect(reader.locator("[data-coverage-member]")).toHaveCount(2);
  await expect(reader).not.toContainText(titles[8]);
  expect(state.stateWrites).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

for(const publicMode of [false,true])for(const width of [1280,1024,768,390]) {
  test(`Radar feature parity ${publicMode?"public":"owner"} ${width}`,async({page},info)=>{
    const state=await stub(page,publicMode),errors:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.emulateMedia({colorScheme:"light",reducedMotion:"reduce"});
    await page.setViewportSize({width,height:width===390?844:900});
    await page.goto("/radar");
    const modes=page.getByRole("tablist",{name:"新闻排列方式",exact:true});
    await expect(modes.getByRole("tab")).toHaveCount(2);
    for(const [index,label] of ["列表","主题地图"].entries())await expect(modes.getByRole("tab").nth(index)).toHaveAccessibleName(label);
    await expect(page.locator(".ns-reader-row")).toHaveCount(12);
    await expect(page.getByLabel("主题筛选",{exact:true})).toBeVisible();
    await expect(page.getByLabel("来源筛选",{exact:true})).toBeVisible();
    await expect(page.getByLabel("搜索事件",{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath(`radar-${publicMode?"public":"owner"}-compact-${width}.png`)});
    await modes.getByRole("tab",{name:"主题地图",exact:true}).click();
    await expect(page.locator(".ns-topic-article")).toHaveCount(12);
    await expect(page.locator(".ns-topic-sample")).toContainText("12");
    await expect(page.locator('[data-topic-id][aria-pressed=true]')).toHaveCount(0);
    await page.locator('[data-topic-id="工程实践"]').click();
    const results=page.getByRole("complementary",{name:"主题文章列表",exact:true});
    await expect(results.locator(".ns-topic-article")).toHaveCount(4);
    await expect(results.getByRole("heading",{name:"工程实践",exact:true})).toBeVisible();
    await expect(results).not.toContainText(titles[0]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`radar-${publicMode?"public":"owner"}-topics-${width}.png`)});
    expect(state.stateWrites).toEqual([]);
    const opener=results.locator(".ns-topic-article").nth(2);
    await opener.click();
    const reader=publicMode?page.getByRole("complementary",{name:"公开文章阅读区",exact:true}):page.getByRole("article",{name:"文章就地阅读",exact:true});
    await expect(reader).toBeVisible();
    await expect(reader).toContainText(titles[10]);
    await reader.getByRole("tab",{name:"已收录原文 / 来源内容",exact:true}).click();
    await expect(reader).toContainText("已收录的原始研究正文");
    await expect(reader.getByRole("alert")).toHaveCount(0);
    if(width<=1024) {
      await expect(page.getByRole("dialog",{name:"文章阅读窗口",exact:true})).toBeVisible();
      await reader.focus();await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(()=>!!document.activeElement?.closest(".ns-preview"))).toBe(true);
      expect(await page.evaluate(()=>!!document.elementFromPoint(innerWidth/2,innerHeight-4)?.closest('[aria-modal="true"]'))).toBe(true);
    } else {
      await expect(page.getByRole("group",{name:"关键词主题共现图",exact:true})).toBeVisible();
    }
    await page.screenshot({path:info.outputPath(`radar-${publicMode?"public":"owner"}-reading-${width}.png`)});
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(results.locator(".ns-topic-article")).toHaveCount(4);
    await results.getByRole("button",{name:"清除主题",exact:true}).click();
    await expect(results.locator(".ns-topic-article")).toHaveCount(12);
    expect(state.unexpectedWrites).toEqual([]);
    if(publicMode){expect(state.stateWrites).toEqual([]);expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);}
    expect(errors).toEqual([]);
  });
}

for(const publicMode of [false,true])test(`Radar filters and frozen ordering ${publicMode?"public":"owner"}`,async({page})=>{
  const state=await stub(page,publicMode);
  await page.goto("/radar?view=list");
  await expect(page.locator(".ns-reader-row")).toHaveCount(12);
  const requests=()=>state.reads.map(path=>new URL(path,"http://localhost")).filter(url=>url.pathname.endsWith("/events"));
  const first=requests()[0],asOf=first.searchParams.get("asOf");
  expect(asOf).toMatch(/^\d{4}-\d\d-\d\dT.*\.\d{3}Z$/);
  expect(first.searchParams.get("limit")).toBe("40");
  expect(first.searchParams.get("sort")).toBe("recommended");
  await page.getByLabel("主题筛选",{exact:true}).selectOption("工程实践");
  await expect(page.locator(".ns-reader-row")).toHaveCount(4);
  await page.getByText("更多筛选 · 时间与排序",{exact:true}).click();
  await page.getByLabel("排序",{exact:true}).selectOption("newest");
  await page.getByLabel("来源筛选",{exact:true}).selectOption("T1");
  await page.getByLabel("时间范围",{exact:true}).selectOption("0");
  await page.getByLabel("包含开发构建",{exact:true}).check();
  await page.getByLabel("搜索事件",{exact:true}).fill("实践");
  await expect.poll(()=>requests().at(-1)?.searchParams.get("q")).toBe("实践");
  const last=requests().at(-1)!.searchParams;
  expect(Object.fromEntries(last)).toMatchObject({topic:"工程实践",tier:"T1",sort:"newest",hours:"0",q:"实践",includeEngineering:"true",asOf});
  await page.getByRole("tab",{name:"主题地图",exact:true}).click();
  await expect(page.locator(".ns-topic-article")).toHaveCount(4);
  expect(Object.fromEntries(requests().at(-1)!.searchParams)).toMatchObject({topic:"工程实践",sort:"newest",limit:"24",asOf});
  await expect(page.locator(".ns-topic-results-status")).toContainText("最新优先");
  await page.getByRole("button",{name:"应用更新",exact:true}).click();
  await expect.poll(()=>requests().at(-1)?.searchParams.get("asOf")).not.toBe(asOf);
  expect(state.unexpectedWrites).toEqual([]);
  if(publicMode)expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
});

test("public topic pagination uses the same cutoff and cannot append a delayed page to a new scope",async({page})=>{
  const state=await stub(page,true),rows=Array.from({length:60},(_,index)=>({...fixture(index%12),id:id(index),displayTitle:`分页材料 ${index+1}`}));
  const reads:URL[]=[];
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(/\/beta\/api\/events\?/,async route=>{
    const url=new URL(route.request().url()),offset=Number(url.searchParams.get("offset")),limit=Number(url.searchParams.get("limit"));
    reads.push(url);
    const facet=url.searchParams.get("facet"),selected=rows.filter(item=>!facet||item.topics.includes(facet));
    if(limit===24&&offset===24&&!facet)await gate;
    await route.fulfill({json:{items:selected.slice(offset,offset+limit),nextOffset:offset+limit<selected.length?offset+limit:null}});
  });
  try {
    await page.goto("/radar?view=topics");
    await expect(page.locator(".ns-topic-article")).toHaveCount(24);
    const asOf=reads[0].searchParams.get("asOf");
    await page.getByRole("button",{name:"加载更多匹配文章",exact:true}).click();
    await expect.poll(()=>reads.some(url=>url.searchParams.get("offset")==="24")).toBe(true);
    await page.locator('[data-topic-id="工程实践"]').click();
    await expect(page.locator(".ns-topic-article")).toHaveCount(20);
    release();
    await expect(page.locator(".ns-topic-results")).not.toContainText("分页材料 25");
    await expect(page.locator(".ns-topic-article")).toHaveCount(20);
    expect(reads.every(url=>url.searchParams.get("asOf")===asOf)).toBe(true);
    await page.getByRole("button",{name:"清除主题",exact:true}).click();
    await page.getByRole("button",{name:"加载更多匹配文章",exact:true}).click();
    await expect(page.locator(".ns-topic-article")).toHaveCount(48);
    await page.getByRole("button",{name:"加载更多匹配文章",exact:true}).click();
    await expect(page.locator(".ns-topic-article")).toHaveCount(60);
    await expect(page.getByRole("button",{name:"加载更多匹配文章",exact:true})).toHaveCount(0);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();}
});

for(const publicMode of [false,true])for(const scenario of ["loading","error","empty"])test(`topic workspace ${scenario} ${publicMode?"public":"owner"}`,async({page})=>{
  const state=await stub(page,publicMode);
  await page.setViewportSize({width:390,height:844});
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let failed=true;
  await page.route(/\/(?:api\/v1|beta\/api)\/explore\?/,async route=>{
    if(scenario==="loading"){await gate;return route.fallback();}
    if(scenario==="error"&&failed)return route.fulfill({status:503,json:{error:"主题服务暂时不可用"}});
    if(scenario==="empty")return route.fulfill({json:{sampleSize:0,limit:100,meaning:"关键词共现",nodes:[],edges:[]}});
    return route.fallback();
  });
  try {
    await page.goto("/radar?view=topics");
    if(scenario==="loading") {
      await expect(page.locator('[data-reader-skeleton="map"]')).toBeVisible();
      await expect(page.getByRole("status").filter({hasText:"正在读取主题地图"})).toBeVisible();
      release();
      await expect(page.getByRole("group",{name:"关键词主题共现图",exact:true})).toBeVisible();
    } else if(scenario==="error") {
      const error=page.getByRole("alert").filter({hasText:"主题探索加载失败"});
      await expect(error).toBeVisible();
      failed=false;await error.getByRole("button",{name:"重试",exact:true}).click();
      await expect(page.getByRole("group",{name:"关键词主题共现图",exact:true})).toBeVisible();
      await expect(error).toHaveCount(0);
    } else {
      await expect(page.getByRole("heading",{name:"这个范围还没有主题",exact:true})).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();}
});

for(const theme of ["light","dark"])test(`public reader keeps editorial density and feedback browser-local ${theme}`,async({page},info)=>{
  const state=await stub(page,true);
  await page.setViewportSize({width:390,height:844});
  await page.goto("/");
  await expect(page.getByRole("heading",{name:"今日精选",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"打开导航",exact:true}).click();
  const drawer=page.getByRole("dialog");
  await expect(drawer.getByRole("button",{name:"切换明暗主题",exact:true})).toBeVisible();
  if(await page.locator("html").getAttribute("data-theme")!==theme)
    await drawer.getByRole("button",{name:"切换明暗主题",exact:true}).click();
  else await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
  const cards=page.locator("[data-public-event]");
  await expect(cards).toHaveCount(12);
  const boxes=await cards.locator("h3 button").evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
  expect(boxes[0].bottom).toBeLessThanOrEqual(744);
  expect(boxes.filter(box=>box.bottom<=844).length).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`public-${theme}-390.png`)});
  await page.getByRole("button",{name:"更新内容",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"没有新增内容"})).toBeVisible();
  await cards.first().getByRole("button",{name:"不感兴趣",exact:true}).click();
  const feedback=page.getByRole("complementary",{name:"本浏览器反馈",exact:true});
  await feedback.getByText("补充理由（可选）",{exact:true}).click();
  await feedback.getByRole("button",{name:"信息价值低",exact:true}).click();
  expect(await page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem("newsscout-public-feedback-v1")!).reasons))).toContain("low_value");
  await feedback.getByRole("button",{name:"撤销不感兴趣",exact:true}).click();
  const opener=cards.first().locator("h3 button");
  await opener.click();
  await expect(page.getByRole("complementary",{name:"公开文章阅读区",exact:true})).toContainText("Original publisher title 1");
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(state.stateWrites).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
});

async function holdResponses(page:Page,pattern:RegExp) {
  let release:()=>void,finished:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const completed=new Promise<void>(resolve=>{finished=resolve;});
  await page.route(pattern,async route=>{
    await gate;
    await route.fallback();
    finished();
  });
  return {release:()=>release(),completed};
}

for(const theme of ["light","dark"])for(const width of [1920,390]) {
  test(`reader polish loading preserves real page structure ${theme} ${width}`,async({page},info)=>{
    const state=await stub(page);
    await page.setViewportSize({width,height:width===390?844:1080});
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    for(const entry of [
      {name:"brief",path:"/",pattern:/\/api\/v1\/briefs\/latest(?:\?|$)/,variant:"rows",loaded:".ns-edition-list [data-event-id]"},
      {name:"radar",path:"/radar",pattern:/\/api\/v1\/events(?:\?|$)/,variant:"rows",loaded:"article[data-event-id]"},
      {name:"reading",path:"/reading",pattern:/\/api\/v1\/events(?:\?|$)/,variant:"queue",loaded:".ns-library-item"},
      {name:"weekly",path:"/weekly",pattern:/\/api\/v1\/weekly(?:\?|$)/,variant:"cards",loaded:".ns-edition-list [data-event-id]"},
    ]) {
      const hold=await holdResponses(page,entry.pattern);
      try {
        await page.goto(`${entry.path}?clawpilotTheme=${theme}`);
        await expect(page.locator(`[data-reader-skeleton="${entry.variant}"]`)).toBeVisible();
        await expect(page.getByRole("status").filter({hasText:/正在读取/})).toBeVisible();
        await expect(page.locator("#main-content")).not.toContainText(/已加载 0|已打开 0|0 篇/);
        await expect(page.locator("[data-event-id]")).toHaveCount(0);
        const shape=page.locator(".ns-skeleton-item").first();
        const box=await shape.boundingBox();
        expect(box!.width).toBeGreaterThan(240);
        expect(box!.height).toBeGreaterThan(100);
        expect(await shape.locator(".ns-skeleton-line").first().evaluate(element=>getComputedStyle(element).animationName)).toBe("none");
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        expect(state.stateWrites).toEqual([]);
        await page.screenshot({path:info.outputPath(`loading-${entry.name}-${theme}-${width}.png`)});
        hold.release();await hold.completed;
        if(entry.name==="weekly")await page.getByRole("navigation",{name:"本周主题导航"}).getByRole("button",{name:"全部主题",exact:true}).click();
        if(entry.name==="reading")await expect(page.locator(".ns-reader-start")).toContainText(titles[0]);
        await expect(page.locator(entry.loaded)).toHaveCount(entry.name==="reading"?11:12);
        await expect(page.locator("[data-reader-skeleton]")).toHaveCount(0);
      } finally {hold.release();}
      await page.unroute(entry.pattern);
    }
    expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const publicMode of [false,true]) {
  test(`reader polish fixes the wide reader to the viewport without heading offsets ${publicMode?"public":"owner"}`,async({page},info)=>{
    const state=await stub(page,publicMode);
    const items=titles.map((_,index)=>fixture(index)),data=edition(items);
    data.sections![0].description="说明文字可能在窄列里换行；分组标题应该属于双栏共同的标题行，而不应该只把左边的第一张新闻卡片向下挤。".repeat(2);
    await page.route(publicMode?/\/beta\/api\/brief$/:/\/api\/v1\/briefs\/latest$/,route=>route.fulfill({json:data}));
    await page.setViewportSize({width:1920,height:1080});
    await page.goto("/?clawpilotTheme=light");
    const card=page.locator(publicMode?"[data-public-event]":"article[data-event-id]").first();
    await card.getByRole("button",{name:titles[0],exact:true}).click();
    const pane=page.getByRole(publicMode?"complementary":"article",{name:publicMode?"公开文章阅读区":"文章就地阅读",exact:true});
    await expect(pane).toContainText("第三条完整摘要");
    for(const width of [1920,1280,2560]) {
      await page.setViewportSize({width,height:1080});
      await page.evaluate(()=>scrollTo(0,0));
      const boxes=[await card.boundingBox(),await pane.boundingBox(),await page.locator(".ns-reader-sidebar").boundingBox()];
      expect(boxes[1]!.y).toBe(0);
      expect(boxes[1]!.height).toBe(1080);
      expect(boxes[0]!.x+boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x);
      expect(boxes[2]!.x).toBe(0);
      expect(boxes[2]!.width).toBe(176);
      expect(boxes[0]!.width).toBeGreaterThan(280);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`aligned-${publicMode?"public":"owner"}-${width}.png`)});
    }
    await page.setViewportSize({width:1920,height:1080});
    await page.evaluate(()=>scrollTo(0,500));
    await expect.poll(async()=>(await pane.boundingBox())!.y).toBe(0);
    await page.keyboard.press("Escape");
    await expect(card.getByRole("button",{name:titles[0],exact:true})).toBeFocused();
    expect(state.unexpectedWrites).toEqual([]);
    if(publicMode) {
      expect(state.stateWrites).toEqual([]);
      expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
      await expect(page.locator(".ns-reader-sidebar")).not.toContainText(/管理与分享|来源与采集|摘要队列/);
      await expect(page.locator(".ns-reader-sidebar").getByRole("link",{name:"设置",exact:true})).toHaveCount(0);
    }
  });

  test(`reader polish uses article value, not selection diagnostics ${publicMode?"public":"owner"}`,async({page})=>{
    const state=await stub(page,publicMode);
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    const valueSelector=publicMode?".ns-reading-value":".ns-reader-row-value";
    for(const path of publicMode?["/","/?tab=radar"]:["/","/radar","/radar?view=cards","/weekly"]) {
      await page.goto(path);
      if(path==="/weekly")await page.getByRole("navigation",{name:"本周主题导航"}).getByRole("button",{name:"全部主题",exact:true}).click();
      const card=page.locator(publicMode?"[data-public-event]":"article[data-event-id]").first();
      await expect(card).toBeVisible();
      const value=card.locator(valueSelector);
      if(publicMode) {
        await value.locator("summary").click();
        await expect(value.locator("p")).toHaveText(fixture(0).importance);
      } else await expect(value).toHaveText(fixture(0).importance);
      await card.getByRole("button",{name:titles[0],exact:true}).click();
      await expect(page.locator(publicMode?".ns-reading-value-expanded p":".ns-preview-deck")).toHaveText(fixture(0).importance);
      await expect(page.locator("#main-content")).not.toContainText(/为什么入选|确定性规则|article-value-v1|基础值|加8|入选与分类依据|原始研究栏目/);
      await page.keyboard.press("Escape");
    }
    state.articleValue("");
    await page.goto("/");
    await expect(page.locator(publicMode?"[data-public-event]":"article[data-event-id]")).toHaveCount(12);
    await expect(page.locator(valueSelector)).toHaveCount(0);
    state.articleValue("只有来源摘录，未生成文章解读。","feed");
    await page.reload();
    await expect(page.locator(publicMode?"[data-public-event]":"article[data-event-id]")).toHaveCount(12);
    await expect(page.locator(valueSelector)).toHaveCount(0);
    expect(state.unexpectedWrites).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`reader polish delayed details retain preview and ignore an abandoned response ${publicMode?"public":"owner"}`,async({page},info)=>{
    const state=await stub(page,publicMode);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto("/");
    const first=page.locator(publicMode?"[data-public-event]":"article[data-event-id]").first();
    const hold=await holdResponses(page,new RegExp(`/events/${id(0)}$`));
    try {
      await first.getByRole("button",{name:titles[0],exact:true}).click();
      const pane=page.getByRole(publicMode?"complementary":"article",{name:publicMode?"公开文章阅读区":"文章就地阅读",exact:true});
      await expect(pane.locator('[data-reader-skeleton="detail"]')).toBeVisible();
      await expect(pane.getByRole("heading",{name:titles[0],exact:true})).toBeVisible();
      await expect(pane).toContainText("公开适用条件与验证材料");
      expect(state.stateWrites).toEqual([]);
      if(publicMode)expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("newsscout-public-feedback-v1")??"{}").opened??[])).toEqual([]);
      await page.screenshot({path:info.outputPath(`detail-loading-${publicMode?"public":"owner"}.png`)});
      await pane.getByRole("button",{name:"下一篇",exact:true}).click();
      await expect(pane.getByRole("heading",{name:titles[1],exact:true})).toBeVisible();
      await expect(pane.locator("[data-reader-skeleton]")).toHaveCount(0);
      hold.release();await hold.completed;
      await expect(pane.getByRole("heading",{name:titles[1],exact:true})).toBeVisible();
      if(publicMode) {
        await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("newsscout-public-feedback-v1")??"{}").opened??[])).toEqual([id(1)]);
        expect(state.stateWrites).toEqual([]);
      } else expect(state.stateWrites.map(write=>write.id)).toEqual([id(1)]);
      await page.keyboard.press("Escape");
      await expect(first.getByRole("button",{name:titles[0],exact:true})).toBeFocused();
    } finally {hold.release();}
    expect(state.unexpectedWrites).toEqual([]);
  });
}

test("reader polish public loading keeps its full shell without invented counts or private requests",async({page},info)=>{
  const state=await stub(page,true);
  await page.setViewportSize({width:1920,height:1080});
  const hold=await holdResponses(page,/\/beta\/api\/brief$/);
  try {
    await page.goto("/?clawpilotTheme=dark");
    await expect(page.locator('[data-reader-skeleton="cards"]')).toBeVisible();
    await expect(page.locator(".ns-reader-shell")).toHaveCSS("min-height","1080px");
    await expect(page.getByRole("navigation",{name:"公开阅读视图"})).toBeVisible();
    await expect(page.locator("#main-content")).not.toContainText(/0 条|已加载 0/);
    await expect(page.locator(".ns-beta .ns-beta-section-title .ns-loading-status")).toContainText("正在读取");
    await page.screenshot({path:info.outputPath("public-loading-wide-dark.png")});
    hold.release();await hold.completed;
    await expect(page.locator("[data-public-event]")).toHaveCount(12);
    await expect(page.locator("[data-reader-skeleton]")).toHaveCount(0);
    expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
    expect(state.stateWrites).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {hold.release();}
});

test("reader polish failed loading leaves an honest retry, not an empty count or perpetual skeleton",async({page})=>{
  const state=await stub(page);
  let fail=true;
  await page.route(/\/api\/v1\/events(?:\?|$)/,route=>fail?route.fulfill({status:503,json:{error:"新闻服务暂时不可用"}}):route.fallback());
  await page.goto("/radar");
  const error=page.getByRole("alert").filter({hasText:"新闻列表加载失败"});
  await expect(error).toBeVisible();
  await expect(page.locator("[data-reader-skeleton]")).toHaveCount(0);
  await expect(page.locator("#main-content")).not.toContainText("已加载 0");
  fail=false;
  await error.getByRole("button",{name:/重试/}).click();
  await expect(page.locator("article[data-event-id]")).toHaveCount(12);
  await expect(error).toHaveCount(0);
  expect(state.stateWrites).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

for(const publicMode of [false,true])test(`reader polish keeps the shell while route code loads ${publicMode?"public":"owner"}`,async({page})=>{
  const state=await stub(page,publicMode);
  const hold=await holdResponses(page,publicMode?/\/(?:assets\/PublicReader-[^/]+\.js|src\/pages\/PublicReader\.tsx)(?:\?|$)/:/\/(?:assets\/ReadingPage-[^/]+\.js|src\/pages\/ReadingPage\.tsx)(?:\?|$)/);
  try {
    await page.goto(publicMode?"/":"/reading",{waitUntil:"domcontentloaded"});
    await expect(page.locator(".ns-reader-shell")).toBeVisible();
    await expect(page.locator(".ns-route-loading-heading")).toBeVisible();
    await expect(page.locator(".ns-reader-loading [data-reader-skeleton]")).toBeVisible();
    await expect(page.getByRole("status").filter({hasText:/正在加载/})).toBeVisible();
    expect(state.stateWrites).toEqual([]);
    hold.release();await hold.completed;
    await expect(page.locator(publicMode?"[data-public-event]":".ns-library-item")).toHaveCount(publicMode?12:11);
    await expect(page.locator(".ns-route-loading-heading")).toHaveCount(0);
    expect(state.unexpectedWrites).toEqual([]);
    if(publicMode)expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
  } finally {hold.release();}
});

for(const publicMode of [false,true])test(`reported polish category labels are plain ${publicMode?"public":"owner"}`,async({page},info)=>{
  await stub(page,publicMode);
  await page.setViewportSize({width:2175,height:1476});
  await page.goto(publicMode?"/?tab=radar":"/radar");
  const meta=page.locator(".ns-reader-row .ns-reader-story-meta").first();
  const topic=meta.locator(".ns-reader-story-topic");
  await expect(topic).toHaveText("模型与研究");
  await expect(topic).toHaveCSS("border-top-width","0px");
  await expect(topic).toHaveCSS("outline-style","none");
  await expect(meta.locator(".fui-Badge")).toHaveCount(0);
  await expect(page.locator(".ns-reader-row").first()).toHaveCSS("border-bottom-width","1px");
  await page.screenshot({path:info.outputPath("plain-topic-labels.png")});
});

test("reported polish bookmark feedback is immediate, shared and failure-safe",async({page},info)=>{
  const state=await stub(page);
  await page.setViewportSize({width:2175,height:1476});
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
    await card.getByRole("button",{name:/^收藏：/}).evaluate(button=>{button.click();button.click();});
    await expect(card.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-pressed","true");
    await expect(card.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-busy","true");
    await expect(card.getByRole("button",{name:/^取消收藏：/})).toHaveCSS("opacity","1");
    await expect(card.locator(".ns-event-actions")).toHaveAttribute("aria-busy","true");
    await expect(card.getByText("正在保存…",{exact:true})).toHaveCount(0);
    const pending=(await card.locator(".ns-event-actions").boundingBox())!;
    await info.attach("bookmark-control-geometry",{body:JSON.stringify({original,pending}),contentType:"application/json"});
    expect(pending.width).toBeCloseTo(original.width,0);
    expect(pending.height).toBeCloseTo(original.height,0);
    await card.getByRole("button",{name:titles[0],exact:true}).click();
    const pane=page.getByRole("article",{name:"文章就地阅读",exact:true});
    await expect(pane.getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-pressed","true");
    await expect(pane.getByRole("button",{name:/^取消收藏：/})).toBeDisabled();
    await pane.getByRole("button",{name:/^取消收藏：/}).evaluate(button=>button.click());
    await expect.poll(()=>requests).toBe(1);
    await expect.poll(()=>state.stateWrites.filter(write=>write.value.opened===true).length).toBe(1);
    await page.screenshot({path:info.outputPath("bookmark-pending.png")});
    release();
    await expect(card.getByRole("alert")).toContainText("阅读状态保存失败");
    for(const surface of [card,pane])await expect(surface.getByRole("button",{name:/^收藏：/})).toHaveAttribute("aria-pressed","false");
    await expect(card).toContainText("已打开");
    await page.screenshot({path:info.outputPath("bookmark-error.png")});
    fail=false;
    await card.getByRole("button",{name:/重试/}).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(pane.getByRole("button",{name:/^取消收藏：/})).toBeEnabled();
    await expect(card).toContainText("已打开");
    await expect(pane).toContainText("已打开");
    await page.screenshot({path:info.outputPath("bookmark-saved.png")});
    expect(requests).toBe(2);
    expect(state.stateWrites.filter(write=>write.value.saved===true)).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();}
});

test("reported polish dismissal waits for persistence and retains its failed retry",async({page},info)=>{
  const state=await stub(page);
  await page.setViewportSize({width:1440,height:1000});
  let release!:()=>void,fail=true,requests=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route(`**/api/v1/events/${id(0)}/state`,async route=>{
    if((route.request().postDataJSON() as EventState).notInterested===undefined)return route.fallback();
    requests++;
    if(fail){await gate;return route.fulfill({status:503,json:{error:"受控测试：偏好暂时无法保存。"}});}
    return route.fallback();
  });
  try {
    await page.goto("/radar");
    const rows=page.locator(".ns-reader-list [data-event-id]"),row=rows.first();
    await expect(rows).toHaveCount(12);
    const before=await rows.evaluateAll(elements=>elements.map(element=>element.getAttribute("data-event-id")));
    const original=await row.locator(".ns-event-actions").boundingBox();
    await row.getByRole("button",{name:/^不感兴趣：/}).evaluate(button=>{button.click();button.click();});
    await expect(row.getByRole("button",{name:/^撤销不感兴趣：/})).toHaveAttribute("aria-pressed","true");
    await expect(rows).toHaveCount(12);
    await expect(page.locator(".ns-feedback-undo")).toHaveCount(0);
    const pending=await row.locator(".ns-event-actions").boundingBox();
    expect(pending?.width).toBe(original?.width);
    await info.attach("dismissal-control-geometry",{body:JSON.stringify({original,pending}),contentType:"application/json"});
    await rows.nth(1).getByRole("button",{name:/^收藏：/}).click();
    await expect(rows.nth(1).getByRole("button",{name:/^取消收藏：/})).toBeEnabled();
    await page.screenshot({path:info.outputPath("dismissal-pending.png")});
    release();
    await expect(row.getByRole("alert")).toContainText("阅读状态保存失败");
    await expect(row.getByRole("button",{name:/^不感兴趣：/})).toHaveAttribute("aria-pressed","false");
    expect(await rows.evaluateAll(elements=>elements.map(element=>element.getAttribute("data-event-id")))).toEqual(before);
    await page.screenshot({path:info.outputPath("dismissal-error.png")});
    fail=false;
    await row.getByRole("button",{name:/重试/}).click();
    await expect(rows).toHaveCount(11);
    await expect(page.locator(".ns-feedback-undo")).toBeVisible();
    await expect(rows.first()).toHaveAttribute("data-event-id",id(1));
    await expect(rows.first().getByRole("button",{name:/^取消收藏：/})).toHaveAttribute("aria-pressed","true");
    expect(requests).toBe(2);
    expect(state.stateWrites.filter(write=>write.value.notInterested===true)).toHaveLength(1);
    expect(state.unexpectedWrites).toEqual([]);
  } finally {release();}
});

async function checkShellScrollLocks(page:Page,publicMode:boolean,capture:(name:string)=>Promise<void>) {
  const measure=()=>page.evaluate(()=>{
    const main=document.getElementById("main-content")!.getBoundingClientRect();
    return {x:main.x,width:main.width,rootWidth:document.documentElement.getBoundingClientRect().width,overflow:getComputedStyle(document.body).overflowY};
  });
  const openNavigation=page.getByRole("button",{name:"打开导航",exact:true});
  await expect(openNavigation).toBeVisible();
  const before=await measure();
  await openNavigation.click();
  const drawer=page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).overflowY)).toBe("hidden");
  const drawerOpen=await measure();
  await capture("drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(openNavigation).toBeFocused();
  const drawerClosed=await measure();
  await page.locator(publicMode?".ns-reader-story":".ns-reader-row").first().locator("h3 button").click();
  const reader=page.getByRole("dialog",{name:"文章阅读窗口",exact:true});
  await expect(reader).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).overflowY)).toBe("hidden");
  const readerOpen=await measure();
  await capture("reader");
  await page.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  const readerClosed=await measure();
  for(const state of [drawerOpen,drawerClosed,readerOpen,readerClosed]) {
    expect(state.x).toBe(before.x);
    expect(state.width).toBe(before.width);
    expect(state.rootWidth).toBe(before.rootWidth);
  }
  expect(drawerClosed.overflow).toBe(before.overflow);
  expect(readerClosed.overflow).toBe(before.overflow);
  return {before,drawerOpen,drawerClosed,readerOpen,readerClosed};
}

for(const publicMode of [false,true])test(`reported polish classic scrollbar preserves content width ${publicMode?"public":"owner"}`,async({},info)=>{
  const browser=await chromium.launch({ignoreDefaultArgs:["--hide-scrollbars"]});
  try {
    const context=await browser.newContext({baseURL:process.env.SCOUTNEWS_E2E_BASE_URL,viewport:{width:2175,height:1800},reducedMotion:"reduce",serviceWorkers:"block"});
    const page=await context.newPage();
    await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
    const state=await stub(page,publicMode);
    const items=titles.slice(0,4).map((_,index)=>({...fixture(index),importance:"受控说明：对照原始方法与限制理解这项变化，不把来源自述当成已验证结论。".repeat(10)}));
    await page.route(publicMode?/\/beta\/api\/brief$/:/\/api\/v1\/briefs\/latest$/,route=>route.fulfill({json:edition(items)}));
    await page.goto("/");
    await expect(page.locator(publicMode?".ns-reading-invitation":".ns-edition-list")).toBeVisible();
    await page.addStyleTag({content:"::-webkit-scrollbar { width: 16px; height: 16px; }"});
    await expect(page.locator(publicMode?"[data-public-event]":".ns-edition-list article[data-event-id]")).toHaveCount(4);
    await page.evaluate(()=>document.fonts.ready);
    await page.setViewportSize({width:2175,height:480});
    const settledHeight=()=>page.evaluate(()=>new Promise<number>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const main=document.querySelector(".ns-reader-main");resolve(innerHeight===480&&(!main||getComputedStyle(main).minHeight==="480px")?Math.ceil(document.documentElement.scrollHeight):0);}))));
    await expect.poll(async()=>{const first=await settledHeight();return first>480&&first===await settledHeight();}).toBe(true);
    const height=await settledHeight();
    await page.setViewportSize({width:2175,height});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollHeight>document.documentElement.clientHeight)).toBe(false);
    const selectors=publicMode?["#main-content",".ns-selection-overview",".ns-reader-story-title",".ns-reading-invitation"]:["#main-content",".ns-page-head",".ns-batch-bar",".ns-reader-row-title"];
    const measure=()=>page.evaluate(selectors=>({overflow:document.documentElement.scrollHeight>document.documentElement.clientHeight,rects:selectors.map(selector=>{
        const box=document.querySelector(selector)!.getBoundingClientRect();return {selector,x:box.x,width:box.width};
      }),gutter:getComputedStyle(document.documentElement).scrollbarGutter}),selectors);
    const before=await measure();
    expect(before.overflow).toBe(false);
    await page.screenshot({path:info.outputPath("value-closed-classic.png")});
    if(publicMode)await page.locator(".ns-reading-value").first().locator("summary").click();
    else await page.evaluate(()=>{const growth=document.createElement("div");growth.style.height="480px";growth.dataset.fixture="growth";document.body.append(growth);});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollHeight>document.documentElement.clientHeight)).toBe(true);
    const after=await measure();
    expect(after.overflow).toBe(true);
    await info.attach("classic-scrollbar-geometry",{body:JSON.stringify({before,after}),contentType:"application/json"});
    await page.screenshot({path:info.outputPath("value-open-classic.png")});
    for(let index=0;index<before.rects.length;index++) {
      expect(after.rects[index].x,before.rects[index].selector).toBeCloseTo(before.rects[index].x,0);
      expect(after.rects[index].width,before.rects[index].selector).toBeCloseTo(before.rects[index].width,0);
    }
    expect(after.gutter).toContain("stable");
    await page.setViewportSize({width:768,height:900});
    const locks=await checkShellScrollLocks(page,publicMode,async name=>{await page.screenshot({path:info.outputPath(`classic-${name}.png`)});});
    await info.attach("classic-scroll-lock-geometry",{body:JSON.stringify(locks),contentType:"application/json"});
    expect(state.unexpectedWrites).toEqual([]);
  } finally {await browser.close();}
});

for(const publicMode of [false,true])test(`reported polish touch overlay scrollbars keep the full mobile width ${publicMode?"public":"owner"}`,async({},info)=>{
  const browser=await chromium.launch({ignoreDefaultArgs:["--hide-scrollbars"]});
  try {
    const page=await browser.newPage({baseURL:process.env.SCOUTNEWS_E2E_BASE_URL,viewport:{width:390,height:844},
      isMobile:true,hasTouch:true,reducedMotion:"reduce",serviceWorkers:"block"});
    await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
    const state=await stub(page,publicMode);
    await page.goto("/");
    await expect(page.locator(publicMode?".ns-reader-story":".ns-edition-list article[data-event-id]")).toHaveCount(12);
    expect(await page.evaluate(()=>document.documentElement.getBoundingClientRect().width)).toBe(390);
    const locks=await checkShellScrollLocks(page,publicMode,async name=>{await page.screenshot({path:info.outputPath(`touch-${name}.png`)});});
    await info.attach("touch-scroll-lock-geometry",{body:JSON.stringify(locks),contentType:"application/json"});
    expect(state.unexpectedWrites).toEqual([]);
  } finally {await browser.close();}
});

for(const width of [2175,1024,390])test(`reported polish sidebar tools use one navigation language ${width}`,async({page},info)=>{
  await stub(page);
  await page.setViewportSize({width,height:width===390?844:1476});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/shares");
  await expect(page).toHaveURL(/\/share$/);
  await expect(page.getByRole("heading",{name:"今日分享",exact:true})).toBeVisible();
  const compact=width<=768;
  if(compact)await page.getByRole("button",{name:"打开导航",exact:true}).click();
  else await expect(page.getByRole("button",{name:"打开导航",exact:true})).toBeHidden();
  const sidebar=page.locator(compact?".ns-reader-mobile-nav":".ns-reader-sidebar");
  const tools=sidebar.getByRole("navigation",{name:"工具",exact:true});
  await expect(tools.getByRole("link")).toHaveCount(4);
  const rows=sidebar.locator(".ns-reader-navigation .ns-reader-nav-item");
  const geometry=await rows.evaluateAll(elements=>elements.map(element=>{
    const box=element.getBoundingClientRect(),icon=element.querySelector(".ns-reader-nav-icon")!.getBoundingClientRect();
    return {height:box.height,iconSize:icon.width,inset:icon.x-box.x,center:Math.abs(icon.y+icon.height/2-box.y-box.height/2)};
  }));
  expect(geometry).toHaveLength(9);
  for(const row of geometry) {
    expect(row.height).toBeGreaterThanOrEqual(compact?44:40);
    expect(row.iconSize).toBeCloseTo(geometry[0].iconSize,0);
    expect(row.center).toBeLessThanOrEqual(1);
    expect(row.inset).toBeCloseTo(geometry[0].inset,0);
  }
  await info.attach("sidebar-tool-geometry",{body:JSON.stringify(geometry),contentType:"application/json"});
  await expect(tools.getByRole("link",{name:"今日分享",exact:true})).toHaveClass(/is-active/);
  await expect(tools.getByRole("link",{name:"今日分享",exact:true})).toHaveAttribute("aria-current","page");
  await expect(tools.getByRole("link",{name:"来源采集",exact:true})).toHaveAttribute("href","/sources");
  await expect(tools.getByRole("link",{name:"设置",exact:true})).toHaveAttribute("href","/settings");
  await page.screenshot({path:info.outputPath("sidebar-tools.png")});
  if(compact) {
    await tools.getByRole("link",{name:"今日分享",exact:true}).focus();
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole("button",{name:"打开导航",exact:true})).toBeFocused();
  }
  await page.goto("/share/navigation-fixture");
  await expect(page).toHaveURL(/\/share$/);
  if(compact)await page.getByRole("button",{name:"打开导航",exact:true}).click();
  await expect(tools.getByRole("link",{name:"今日分享",exact:true})).toHaveAttribute("aria-current","page");
  await tools.getByRole("link",{name:"兴趣权重",exact:true}).click();
  await expect(page).toHaveURL(/\/topics$/);
  if(compact)await page.getByRole("button",{name:"打开导航",exact:true}).click();
  await expect(tools.getByRole("link",{name:"兴趣权重",exact:true})).toHaveAttribute("aria-current","page");
});
for(const width of [2175,1024,390])test(`reported polish interest add row stays aligned through validation ${width}`,async({page},info)=>{
  await stub(page);
  const saved:Topic[][]=[];
  const existing:Topic[]=[
    {id:"agents",label:"Agent",group:"长期兴趣",context:"long_term",enabled:true,weight:80},
    {id:"work",label:"工作关注",group:"工作",context:"work",enabled:false,weight:20},
    {id:"project",label:"项目跟进",group:"当前项目",context:"current_project",enabled:true,weight:70},
  ];
  let failSave=true;
  await page.route("**/api/v1/me/interests",async route=>{
    if(route.request().method()==="PUT") {
      const data=route.request().postDataJSON() as {topics:Topic[]};
      saved.push(data.topics);
      if(failSave)return route.fulfill({status:503,json:{error:"受控测试：主题保存失败"}});
      if(data.topics.some(topic=>!["long_term","work","current_project"].includes(topic.context)))return route.fulfill({status:400,json:{error:"无效的关注场景"}});
      return route.fulfill({json:{items:data.topics}});
    }
    return route.fulfill({json:{items:existing}});
  });
  await page.setViewportSize({width,height:width===390?844:1476});
  await page.goto("/topics");
  const input=page.getByRole("textbox",{name:"新主题名称",exact:true});
  const add=page.getByRole("button",{name:"添加主题",exact:true});
  const aligned=async(stage:string)=>{
    const field=(await input.boundingBox())!,button=(await add.boundingBox())!;
    await info.attach(`topic-input-${stage}-geometry`,{body:JSON.stringify({field,button}),contentType:"application/json"});
    if(width<=768) {
      expect(button.y).toBeGreaterThanOrEqual(field.y+field.height);
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(field.height).toBeGreaterThanOrEqual(44);
    } else {
      expect(button.y).toBeCloseTo(field.y,0);
      expect(button.height).toBeCloseTo(field.height,0);
      expect(button.height).toBeGreaterThanOrEqual(38);
    }
  };
  await expect(input).toBeVisible();
  await aligned("normal");
  await page.screenshot({path:info.outputPath("topic-input-normal.png")});
  await add.click();
  await expect(page.getByText("请输入主题名称。",{exact:true})).toBeVisible();
  await aligned("empty");
  await expect(input).toHaveAttribute("aria-invalid","true");
  expect(await input.evaluate(element=>(element.getAttribute("aria-describedby")??"").split(" ").map(id=>document.getElementById(id)?.textContent).join(" "))).toContain("请输入主题名称。");
  await page.screenshot({path:info.outputPath("topic-input-error.png")});
  await input.fill("Agent");
  await add.click();
  await expect(page.getByText("该主题已经存在。",{exact:true})).toBeVisible();
  await aligned("duplicate");
  await page.screenshot({path:info.outputPath("topic-input-duplicate.png")});
  await input.fill("UI 对齐测试");
  await input.press("Enter");
  await expect(page.getByText("UI 对齐测试",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"保存权重",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("兴趣保存失败");
  expect(saved[0].at(-1)?.context).toBe("long_term");
  expect(saved[0].slice(0,existing.length)).toEqual(existing);
  await expect(page.getByText("UI 对齐测试",{exact:true})).toBeVisible();
  await aligned("save-error");
  await page.screenshot({path:info.outputPath("topic-save-error.png")});
  failSave=false;
  await page.getByRole("alert").getByRole("button",{name:/重试/}).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("权重已保存",{exact:false})).toBeVisible();
  expect(saved).toHaveLength(2);
  expect(saved[1]).toEqual(saved[0]);
  await aligned("saved");
  await page.screenshot({path:info.outputPath("topic-saved.png")});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
