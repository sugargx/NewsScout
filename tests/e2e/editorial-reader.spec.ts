import { expect, test, type Page } from "@playwright/test";
import type { Brief, CoverageMember, Event, EventState } from "../../apps/web/src/types";
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
    if(path.endsWith("/briefs"))return send({items:[{localDate:"2026-09-01",generatedAt:"2026-09-01T01:00:00Z",itemCount:2}]});
    if(path.endsWith("/briefs/2026-09-01")) {
      const legacy=items.slice(0,2).map(({displayTitle,editorial,notInterestedReason,...rest})=>rest);
      return send({...edition(legacy),localDate:"2026-09-01",isSnapshot:true,sections:undefined});
    }
    if(/\/briefs\/(?:latest|today)$/.test(path)||path.endsWith("/brief"))return send({...edition(items),items:publicMode?items.map(project):items});
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
    const titles=cards.locator("h2 button");
    const boxes=await titles.evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
    expect(boxes[0].top).toBeLessThanOrEqual(350);
    expect(boxes.filter(box=>box.top>=0&&box.bottom<=(width===390?844:900)).length).toBeGreaterThanOrEqual(width===390?2:4);
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
    await page.goto("/radar?view=cards");
    const card=page.locator(".ns-reader-story").first();
    await expect(card).toBeVisible();
    const geometry=await card.evaluate(element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      const innerWidth=rect.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth);
      const title=element.querySelector(".ns-reader-story-title")!.getBoundingClientRect();
      const body=element.querySelector(".ns-reader-story-body")!.getBoundingClientRect();
      const actions=element.querySelector(".ns-reader-story-actions")!.getBoundingClientRect();
      return {innerWidth,titleWidth:title.width,bodyWidth:body.width,bodyRight:body.right,bodyBottom:body.bottom,
        titleBottom:title.bottom,actionsX:actions.x,actionsY:actions.y,actionsRight:actions.right,actionsBottom:actions.bottom,cardRight:rect.right,cardBottom:rect.bottom};
    });
    expect(geometry.titleWidth).toBeCloseTo(geometry.innerWidth,0);
    expect(geometry.bodyWidth).toBeCloseTo(geometry.innerWidth-(geometry.innerWidth>=1000?184:0),0);
    expect(geometry.actionsY).toBeGreaterThanOrEqual(geometry.titleBottom);
    expect(geometry.actionsRight).toBeLessThanOrEqual(geometry.cardRight);
    expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.cardBottom);
    if(geometry.innerWidth>=1000)expect(geometry.actionsX-geometry.bodyRight).toBeGreaterThanOrEqual(24);
    else expect(geometry.actionsY).toBeGreaterThanOrEqual(geometry.bodyBottom);
    await expect(card).not.toContainText("第三条完整摘要");
    expect((await card.locator(".ns-summary-compact").textContent())!.length).toBeLessThanOrEqual(240);
    await page.screenshot({path:info.outputPath(`card-column-${publicMode?"public":"owner"}-${width}.png`)});
    const value=card.locator(".ns-reading-value");
    await value.locator("summary").click();
    const expanded=await card.evaluate(element=>{
      const body=element.querySelector(".ns-reader-story-body")!.getBoundingClientRect();
      const actions=element.querySelector(".ns-reader-story-actions")!.getBoundingClientRect();
      const paragraph=element.querySelector(".ns-reading-value p")!.getBoundingClientRect();
      return {bodyWidth:body.width,bodyBottom:body.bottom,actionsY:actions.y,valueWidth:paragraph.width};
    });
    expect(expanded.bodyWidth).toBeCloseTo(geometry.innerWidth,0);
    expect(expanded.valueWidth).toBeCloseTo(geometry.innerWidth,0);
    expect(expanded.actionsY).toBeGreaterThanOrEqual(expanded.bodyBottom);
    await value.locator("summary").click();
    await expect.poll(()=>card.locator(".ns-reader-story-body").evaluate(element=>element.getBoundingClientRect().width)).toBe(geometry.bodyWidth);
    await page.getByRole("tab",{name:"紧凑列表",exact:true}).click();
    const rowValue=page.locator(".ns-reader-row .ns-reading-value").first();
    await rowValue.locator("summary").click();
    const rowMeasure=await rowValue.evaluate(element=>{
      const row=element.closest("article")!.getBoundingClientRect();
      const content=element.parentElement!.getBoundingClientRect();
      const paragraph=element.querySelector("p")!;
      return {available:content.width,valueWidth:paragraph.getBoundingClientRect().width,
        textWidth:paragraph.scrollWidth,paragraphWidth:paragraph.clientWidth,rowRight:row.right};
    });
    expect(rowMeasure.valueWidth).toBeCloseTo(rowMeasure.available,0);
    expect(rowMeasure.textWidth).toBeLessThanOrEqual(rowMeasure.paragraphWidth);
    expect(rowMeasure.rowRight).toBeLessThanOrEqual(width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:info.outputPath(`value-column-${publicMode?"public":"owner"}-${width}.png`)});
    expect(state.stateWrites).toEqual([]);expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const publicMode of [false,true])for(const theme of ["light","dark"])for(const width of [1440,390]) {
  test(`${publicMode?"public":"owner"} form controls keep one focus treatment ${theme} ${width}`,async({page},info)=>{
    const state=await stub(page,publicMode);
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.setViewportSize({width,height:900});
    await page.goto("/");
    const edition=page.getByLabel(publicMode?"晨报版本":"简报日期",{exact:true});
    const outline=()=>edition.evaluate(element=>{
      const style=getComputedStyle(element);
      return style.outlineStyle!=="none"&&parseFloat(style.outlineWidth)>0&&style.outlineColor!=="rgba(0, 0, 0, 0)";
    });
    const underline=()=>edition.evaluate(element=>getComputedStyle(element.closest(".fui-Select")!,"::after").transform);
    await edition.click();
    expect(await outline()).toBe(false);
    await expect.poll(underline).toBe("matrix(1, 0, 0, 1, 0, 0)");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(edition).toBeFocused();
    expect(await edition.evaluate(element=>element.matches(":focus-visible"))).toBe(true);
    expect(await outline()).toBe(false);
    await expect.poll(underline).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(await edition.evaluate(element=>{
      const style=getComputedStyle(element.closest(".fui-Select")!,"::after");
      return {stroke:style.borderBottomWidth,style:style.borderBottomStyle,gradient:style.backgroundImage};
    })).toEqual({stroke:"2px",style:"solid",gradient:"none"});
    await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect(edition).toHaveValue("2026-09-01");
    await expect(page.locator(".ns-reader-story")).toHaveCount(2);
    await page.screenshot({path:info.outputPath(`edition-focus-${publicMode?"public":"owner"}-${theme}-${width}.png`)});
    const title=page.locator(".ns-reader-story-title>button").first();
    await title.focus();
    await expect(title).toHaveCSS("outline-offset","4px");
    await page.goto("/radar");
    const search=page.locator(".ns-radar-primary input");
    await search.click();
    expect(await search.evaluate(element=>{
      const style=getComputedStyle(element);
      return style.outlineStyle!=="none"&&parseFloat(style.outlineWidth)>0&&style.outlineColor!=="rgba(0, 0, 0, 0)";
    })).toBe(false);
    await expect.poll(()=>search.evaluate(element=>getComputedStyle(element.closest(".fui-Input")!,"::after").transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(state.stateWrites).toEqual([]);expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const publicMode of [false,true]) {
  test(`${publicMode?"public":"owner"} grouped cards do not reserve an empty action column`,async({page})=>{
    const state=await stub(page,publicMode);state.group("same_event");
    await page.setViewportSize({width:1920,height:900});
    await page.goto("/radar?view=cards");
    const card=page.locator(".ns-reader-story").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".ns-reader-story-actions")).toHaveCount(0);
    const dimensions=await card.evaluate(element=>{
      const style=getComputedStyle(element);
      return {innerWidth:element.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
        titleWidth:element.querySelector(".ns-reader-story-title")!.getBoundingClientRect().width,
        bodyWidth:element.querySelector(".ns-reader-story-body")!.getBoundingClientRect().width};
    });
    expect(dimensions.titleWidth).toBeCloseTo(dimensions.innerWidth,0);
    expect(dimensions.bodyWidth).toBeCloseTo(dimensions.innerWidth,0);
    expect(state.stateWrites).toEqual([]);expect(state.unexpectedWrites).toEqual([]);
  });

  test(`${publicMode?"public":"owner"} select focus remains visible in forced colors`,async({page})=>{
    await stub(page,publicMode);
    await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
    await page.goto("/");
    const edition=page.getByLabel(publicMode?"晨报版本":"简报日期",{exact:true});
    await edition.focus();await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(edition).toBeFocused();
    await expect.poll(()=>edition.evaluate(element=>getComputedStyle(element.closest(".fui-Select")!,"::after").transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    const focus=await edition.evaluate(element=>{
      const style=getComputedStyle(element.closest(".fui-Select")!,"::after");
      return {stroke:style.borderBottomWidth,style:style.borderBottomStyle,color:style.borderBottomColor,background:getComputedStyle(element).backgroundColor};
    });
    expect(focus.stroke).toBe("2px");expect(focus.style).toBe("solid");expect(focus.color).not.toBe(focus.background);
    expect(focus.color).not.toBe("rgba(0, 0, 0, 0)");
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
    const cards=page.locator(".ns-reader-story"),first=cards.first();
    await first.getByRole("button",{name:/^收藏：/}).click();
    await expect(first.getByRole("status")).toContainText("正在保存");
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

for(const width of [1024,768,390]) {
  test(`owner navigation keeps reading and management reachable ${width}`,async({page},info)=>{
    const state=await stub(page);
    await page.setViewportSize({width,height:900});
    await page.goto("/");
    await expect(page.getByRole("navigation",{name:"主导航",exact:true}).getByRole("link")).toHaveCount(5);
    const trigger=page.locator(".ns-owner-management>summary");
    await trigger.click();
    const links=page.getByRole("navigation",{name:"管理导航",exact:true}).getByRole("link");
    await expect(links).toHaveCount(4);
    for(const link of await links.all()) {
      const box=(await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x+box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({path:info.outputPath(`owner-navigation-${width}.png`)});
    await links.first().focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ns-owner-management")).not.toHaveAttribute("open","");
    await expect(trigger).toBeFocused();
    expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const width of [1280,390]) {
  test(`owner and public stories use the same design contract ${width}`,async({browser})=>{
    const shapes:unknown[]=[];
    for(const publicMode of [false,true]) {
      const context=await browser.newContext({viewport:{width,height:900}});
      try {
        const page=await context.newPage();
        await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
        await stub(page,publicMode);
        await page.goto(process.env.SCOUTNEWS_E2E_BASE_URL!+"/");
        const card=page.locator(".ns-reader-story").first();
        await expect(card).toBeVisible();
        shapes.push(await card.evaluate(element=>{
          const title=element.querySelector(".ns-reader-story-title")!,button=element.querySelector(".ns-reader-button")!;
          const style=getComputedStyle(element),heading=getComputedStyle(title),control=getComputedStyle(button);
          return {radius:style.borderRadius,padding:style.padding,titleSize:heading.fontSize,titleLine:heading.lineHeight,
            buttonRadius:control.borderRadius,buttonHeight:button.getBoundingClientRect().height};
        }));
      } finally {await context.close();}
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[0]).toMatchObject({radius:"16px",buttonRadius:"10px"});
  });
}

test("manual updates report actual changes and never collect; archives without editorial fields stay faithful",async({page})=>{
  const state=await stub(page);
  await page.goto("/");
  await expect(page.locator("article[data-event-id]")).toHaveCount(12);
  await page.locator(".ns-edition-options > summary").click();
  await expect(page.locator(".ns-edition-options")).toContainText("本次阅读内容与顺序保持不变");
  await expect(page.locator(".ns-edition-options")).not.toContainText(/article-value-v1|确定性|基础值/);
  await page.locator(".ns-edition-options > summary").click();
  await page.getByRole("button",{name:"应用更新",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"没有新增内容"})).toBeVisible();
  state.change();
  await page.getByRole("button",{name:"应用更新",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"新增 1 条 · 更新 1 条"})).toBeVisible();
  await page.getByLabel("简报日期",{exact:true}).selectOption("2026-09-01");
  await expect(page.locator('.ns-edition-list [data-event-id]')).toHaveCount(2);
  await expect(page.locator('.ns-edition-list')).toContainText("Original publisher title 1");
  await expect(page.locator('[data-section="essential"],[data-section="catch_up"]')).toHaveCount(0);
  await expect(page.getByText("已保存历史版",{exact:true})).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});

test("Radar keeps primary filters compact, preserves them between views and exposes a real refresh outcome",async({page},info)=>{
  const state=await stub(page);
  await page.setViewportSize({width:390,height:844});
  await page.goto("/radar");
  const first=page.locator("article[data-event-id] h2 button").first();
  await expect(first).toBeVisible();
  expect((await first.boundingBox())!.y).toBeLessThanOrEqual(350);
  await page.screenshot({path:info.outputPath("radar-mobile.png")});
  await page.getByText("更多筛选 · 来源等级 / T1 / 排序",{exact:true}).click();
  await page.getByLabel("来源等级",{exact:true}).selectOption("T1");
  await page.getByText("更多筛选 · 来源等级 / T1 / 排序",{exact:true}).click();
  await page.getByRole("tab",{name:"摘要卡片",exact:true}).click();
  await expect(page.getByLabel("来源等级",{exact:true})).toHaveValue("T1");
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
    const title=page.locator("article[data-event-id] h2 button").first();
    await expect(title).toBeVisible();
    expect((await title.boundingBox())!.y).toBeLessThanOrEqual(350);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator("article[data-event-id]").first().locator(".ns-article-source"))
      .toHaveAttribute("title","Anthropic Research · 官方研究索引");
  }
  await expect(page.getByRole("navigation",{name:"本周主题目录"}).getByRole("link")).toHaveCount(8);
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
  await expect(page.getByRole("navigation",{name:"本周主题目录"})).toBeVisible();
  await expect(page.locator('[data-section="topic"]')).toHaveCount(2);
  await expect(page.locator(".ns-edition-list article[data-event-id]")).toHaveCount(12);
  expect(state.stateWrites).toEqual([]);
  await page.locator("article[data-event-id] h2 button").first().click();
  await expect(page.getByRole("article",{name:"文章就地阅读",exact:true})).toContainText("第三条完整摘要");
  await page.keyboard.press("Escape");
  state.stateWrites.length=0;
  await page.goto("/reading");
  await expect(page.getByRole("heading",{level:1,name:"深度阅读"})).toBeVisible();
  await expect(page.getByLabel("阅读时间范围",{exact:true})).toHaveValue("720");
  await expect(page.locator(".ns-library-item")).toHaveCount(12);
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
  await expect(page.getByRole("tab",{name:"主题关联",exact:true})).toHaveAttribute("aria-selected","true");
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
    await expect(modes.getByRole("tab")).toHaveCount(3);
    for(const [index,label] of ["紧凑列表","摘要卡片","主题关联"].entries())await expect(modes.getByRole("tab").nth(index)).toHaveAccessibleName(label);
    await expect(page.locator(".ns-reader-row")).toHaveCount(12);
    await expect(page.getByLabel("主题筛选",{exact:true})).toBeVisible();
    await expect(page.getByLabel("时间范围",{exact:true})).toBeVisible();
    await expect(page.getByLabel("搜索事件",{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath(`radar-${publicMode?"public":"owner"}-compact-${width}.png`)});
    await modes.getByRole("tab",{name:"摘要卡片",exact:true}).click();
    await expect(page.locator(".ns-reader-story")).toHaveCount(12);
    await expect(page.locator(".ns-reader-row")).toHaveCount(0);
    await page.screenshot({path:info.outputPath(`radar-${publicMode?"public":"owner"}-cards-${width}.png`)});
    await modes.getByRole("tab",{name:"主题关联",exact:true}).click();
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
    if(width<=980) {
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
  await page.getByText("更多筛选 · 来源等级 / T1 / 排序",{exact:true}).click();
  await page.getByLabel("排序",{exact:true}).selectOption("newest");
  await page.getByLabel("来源等级",{exact:true}).selectOption("T1");
  await page.getByLabel("时间范围",{exact:true}).selectOption("0");
  await page.getByLabel("包含开发构建",{exact:true}).check();
  await page.getByLabel("搜索事件",{exact:true}).fill("实践");
  await expect.poll(()=>requests().at(-1)?.searchParams.get("q")).toBe("实践");
  const last=requests().at(-1)!.searchParams;
  expect(Object.fromEntries(last)).toMatchObject({topic:"工程实践",tier:"T1",sort:"newest",hours:"0",q:"实践",includeEngineering:"true",asOf});
  await page.getByRole("tab",{name:"主题关联",exact:true}).click();
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
  await expect(page.getByRole("button",{name:"切换明暗主题",exact:true})).toBeVisible();
  if(await page.locator("html").getAttribute("data-theme")!==theme)
    await page.getByRole("button",{name:"切换明暗主题",exact:true}).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
  const cards=page.locator("[data-public-event]");
  await expect(cards).toHaveCount(12);
  const boxes=await cards.locator("h3 button").evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
  expect(boxes[0].top).toBeLessThanOrEqual(350);
  expect(boxes.filter(box=>box.bottom<=844).length).toBeGreaterThanOrEqual(2);
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
      {name:"brief",path:"/",pattern:/\/api\/v1\/briefs\/latest(?:\?|$)/,variant:"cards",loaded:".ns-edition-list [data-event-id]"},
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
        await expect(page.locator(entry.loaded)).toHaveCount(12);
        await expect(page.locator("[data-reader-skeleton]")).toHaveCount(0);
      } finally {hold.release();}
      await page.unroute(entry.pattern);
    }
    expect(state.unexpectedWrites).toEqual([]);
  });
}

for(const publicMode of [false,true]) {
  test(`reader polish aligns wide split panes without heading offsets ${publicMode?"public":"owner"}`,async({page},info)=>{
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
      expect(Math.abs(boxes[0]!.y-boxes[1]!.y)).toBeLessThanOrEqual(1);
      expect(boxes[2]!.x).toBe(0);
      expect(boxes[2]!.width).toBe(208);
      expect(boxes[0]!.width).toBeGreaterThan(280);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`aligned-${publicMode?"public":"owner"}-${width}.png`)});
    }
    await page.setViewportSize({width:1920,height:1080});
    await page.evaluate(()=>scrollTo(0,500));
    await expect.poll(async()=>(await pane.boundingBox())!.y).toBeLessThanOrEqual(21);
    await page.keyboard.press("Escape");
    await expect(card.getByRole("button",{name:titles[0],exact:true})).toBeFocused();
    expect(state.unexpectedWrites).toEqual([]);
    if(publicMode) {
      expect(state.stateWrites).toEqual([]);
      expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
      await expect(page.locator(".ns-reader-sidebar")).not.toContainText(/管理与分享|设置|来源与采集|摘要队列/);
    }
  });

  test(`reader polish uses article value, not selection diagnostics ${publicMode?"public":"owner"}`,async({page})=>{
    const state=await stub(page,publicMode);
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    for(const path of publicMode?["/","/?tab=radar"]:["/","/radar","/radar?view=cards","/weekly"]) {
      await page.goto(path);
      const card=page.locator(publicMode?"[data-public-event]":"article[data-event-id]").first();
      await expect(card).toBeVisible();
      const value=card.locator(".ns-reading-value");
      await value.locator("summary").click();
      await expect(value.locator("p")).toHaveText(fixture(0).importance);
      await card.getByRole("button",{name:titles[0],exact:true}).click();
      await expect(page.locator(".ns-reading-value-expanded p")).toHaveText(fixture(0).importance);
      await expect(page.locator("#main-content")).not.toContainText(/为什么入选|确定性规则|article-value-v1|基础值|加8|入选与分类依据|原始研究栏目/);
      await page.keyboard.press("Escape");
    }
    state.articleValue("");
    await page.goto("/");
    await expect(page.locator(publicMode?"[data-public-event]":"article[data-event-id]")).toHaveCount(12);
    await expect(page.locator(".ns-reading-value")).toHaveCount(0);
    state.articleValue("只有来源摘录，未生成文章解读。","feed");
    await page.reload();
    await expect(page.locator(publicMode?"[data-public-event]":"article[data-event-id]")).toHaveCount(12);
    await expect(page.locator(".ns-reading-value")).toHaveCount(0);
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
    await expect(page.locator(publicMode?"[data-public-event]":".ns-library-item")).toHaveCount(12);
    await expect(page.locator(".ns-route-loading-heading")).toHaveCount(0);
    expect(state.unexpectedWrites).toEqual([]);
    if(publicMode)expect(state.reads.every(path=>path.startsWith("/beta/api/"))).toBe(true);
  } finally {hold.release();}
});
