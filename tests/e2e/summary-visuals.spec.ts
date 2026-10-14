import { expect, test, type Page } from "@playwright/test";
import type { Event, SummaryVisual } from "../../apps/web/src/types";
import { literalVisualClause, summaryLineCount, validSummaryVisual, wrapVisualText } from "../../apps/web/src/summary-visual";
import { projectBrief } from "../../services/public-reader/server.cjs";

const id = "c4100000-0000-4000-8000-000000000001";
const sourceId = "c4100000-0000-4000-8000-000000000002";
const timestamp = "2026-10-14T01:00:00Z";
const points = [
  "据发布方说明，快速版本支持文本输入，不支持图像输入；它面向小规模交互任务。演示仅覆盖给出的样例，不能据此推断所有场景的效果，也不能省略输入条件来比较两个版本。",
  "据发布方说明，完整版本支持图像输入，结果仍须验证；它面向需要同时理解文字与图像的任务。报告提供了实验步骤，但没有覆盖全部数据分布，也没有给出跨平台的统一成本结论。",
  "报告指出，实验只使用公开测试集，未覆盖私人数据；读者应在自己的场景中复现。不同设置下的观察应分别理解，不把单项表现归纳为通用排名，也不把发布方自述当作独立核验。",
];
const visual: SummaryVisual = {version:1,kind:"comparison",items:[
  {label:"快速版本",detail:"据发布方说明，快速版本支持文本输入，不支持图像输入",point:1},
  {label:"完整版本",detail:"据发布方说明，完整版本支持图像输入，结果仍须验证",point:2},
  {label:"实验",detail:"实验只使用公开测试集，未覆盖私人数据",point:3},
]};
function article(): Event {
  return {
    id,contentVersion:1,title:"Two experimental versions and their limits",displayTitle:"两个实验版本：理解能力与适用边界",
    summary:points.join("\n"),summaryPoints:points,summaryVisual:visual,summaryFormatVersion:4,summaryKind:"copilot",
    summaryModel:"fixture-model",summaryStatus:"completed",summaryEvidenceIds:[sourceId],summarizedAt:timestamp,
    importance:"通过对照输入条件和实验范围理解两个版本，而不是把结果看作通用保证。",
    primaryTopic:"模型与多模态",topics:["模型与多模态"],eventType:"blog",
    firstSeenAt:timestamp,updatedAt:timestamp,publishedAt:timestamp,freshnessAt:timestamp,publicationPrecision:"time",
    evidence:[{id:sourceId,sourceName:"测试发布者",sourceTier:"T1",title:"Experimental report",url:"https://example.com/report",
      isOfficial:true,publishedAt:timestamp,excerpt:"公开实验说明。",
      readingContext:{version:1,kind:"article",origin:"publisher_page",status:"available",sourceUrl:"https://example.com/report",
        body:"保留的原始实验说明，与摘要分开阅读。",truncated:false,durationSeconds:null,chapters:[],
        transcriptUrl:null,comments:[],commentsStatus:"not_applicable",fetchedAt:timestamp}}],
    score:{sourceQuality:85,corroboration:0,freshness:90,relevance:0,novelty:0,engagement:0,editorialBoost:0,total:80,explanation:"fixture"},
    saved:false,read:false,later:false,notInterested:false,seen:false,opened:false,personalReason:"fixture",personalRelevance:0,
  };
}
async function stub(page:Page,options:{publicMode?:boolean;points?:string[];visual?:unknown;format?:number;status?:Event["summaryStatus"]}={}) {
  const item = {...article(),summaryPoints:options.points??points,summaryVisual:"visual" in options?options.visual:visual,
    summaryFormatVersion:options.format??4,summaryStatus:options.status??"completed"};
  item.summary = item.summaryPoints.join("\n");
  const unexpected:string[] = [],requests:string[] = [];
  page.on("request",request=>requests.push(request.url()));
  await page.route(/\/(?:api|beta\/api)\//,route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    const send=(json:unknown)=>route.fulfill({json});
    if(request.method()==="POST"&&path.endsWith("/events/exposures")&&!options.publicMode)return send({recorded:0});
    if(request.method()==="PUT"&&path.endsWith("/state")&&!options.publicMode)return send({...item,opened:true});
    if(request.method()!=="GET") {unexpected.push(`${request.method()} ${path}`);return route.fulfill({status:405});}
    if(path.endsWith("/runtime"))return send({mode:"postgres",timeZone:"Asia/Shanghai",version:"fixture"});
    if(path.endsWith("/me/interests"))return send({items:[]});
    if(path.endsWith("/sources"))return send({items:[]});
    if(path.endsWith("/events/"+id))return send(item);
    if(path.endsWith("/events"))return send({items:[item],nextOffset:null});
    if(/\/(?:briefs\/(?:latest|today)|brief)$/.test(path))return send({
      localDate:"2026-10-14",generatedAt:timestamp,windowStart:"2026-10-07T01:00:00Z",windowEnd:timestamp,
      estimatedMinutes:1,isSnapshot:true,items:[item],note:"fixture",
      sections:[{key:"essential",kind:"essential",title:"今日重点",description:"fixture",eventIds:[id]}],
    });
    return send({items:[]});
  });
  if(options.publicMode)await page.addInitScript(()=>{
    const mark=()=>{if(document.documentElement){document.documentElement.dataset.publicReader="true";observer.disconnect();}};
    const observer=new MutationObserver(mark);observer.observe(document,{childList:true,subtree:true});mark();
  });
  return {requests,unexpected};
}
async function openArticle(page:Page,publicMode=false) {
  await page.goto("/");
  const row=page.locator(publicMode?"[data-public-event]":"[data-event-id]").first();
  await row.locator("h3 button").click();
  const pane=page.getByRole(publicMode?"complementary":"article",{name:publicMode?"公开文章阅读区":"文章就地阅读",exact:true});
  await expect(pane.getByRole("heading",{name:"两个实验版本：理解能力与适用边界",exact:true})).toBeVisible();
  return pane;
}

test.beforeEach(async({page})=>{
  const base=process.env.SCOUTNEWS_E2E_BASE_URL;
  if(!base||!["127.0.0.1","localhost","[::1]"].includes(new URL(base).hostname))
    throw new Error("Summary visual tests require a local, API-mocked frontend.");
  await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
});

test("summary visual contract rejects unsupported claims and active content",()=>{
  expect(validSummaryVisual(visual,points)).toBe(true);
  for(const invalid of [
    {...visual,version:2},{...visual,kind:"bar_chart"},{...visual,svg:"<svg onload='alert(1)'/>"},
    {...visual,items:visual.items.slice(0,1)},
    {...visual,items:visual.items.map((item,index)=>index?item:{...item,point:0})},
    {...visual,items:visual.items.map((item,index)=>index?item:{...item,detail:"性能提升100倍"})},
    {...visual,items:visual.items.map((item,index)=>index?item:{...item,url:"javascript:alert(1)"})},
    {...visual,items:[visual.items[0],visual.items[0]]},
  ])expect(validSummaryVisual(invalid,points)).toBe(false);
  const text="中文WW与长版本名称🧪保持完整";
  const wrapped=wrapVisualText(text,40,value=>Array.from(value).length*10);
  expect(wrapped.join("")).toBe(text);
  expect(wrapped.every(line=>Array.from(line).length<=4)).toBe(true);
  for(const [point,span] of [
    ["模型不支持图像输入。","支持图像输入"],["成本为100美元。","成本为100"],
    ["The model does not support images.","support images"],["方案提供有限支持。","方案提供"],
  ])expect(literalVisualClause(point,span)).toBe(false);
});

test("public visual projection preserves evidence and strips non-contract fields",()=>{
  const item=article();
  const payload={localDate:"2026-10-14",items:[{...item,summaryVisual:{...visual,privateNotes:"PRIVATE",
    items:visual.items.map(entry=>({...entry,privateToken:"PRIVATE"}))},
    coverage:{key:"fixture",members:[{eventId:id,contentVersion:1,title:item.title,evidence:item.evidence,
      summaryPoints:points,summaryVisual:{...visual,privateNotes:"PRIVATE"}}]}}]};
  const projected=projectBrief(payload);
  expect(projected.items[0].summaryVisual).toEqual(visual);
  expect(projected.items[0].coverage.members[0].summaryVisual).toEqual(visual);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  payload.items[0].summaryVisual.items[0].detail="没有证据的数字999";
  expect(()=>projectBrief(payload)).toThrow(/summary visual/);
});

for(const publicMode of [false,true])for(const width of [1440,1280,1024,768,390])for(const theme of ["light","dark"] as const) {
  test(`summary visual reading ${publicMode?"public":"private"} ${width} ${theme}`,async({page},info)=>{
    const state=await stub(page,{publicMode}),errors:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.setViewportSize({width,height:width===390?844:1000});
    await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    const pane=await openArticle(page,publicMode),figure=pane.getByRole("figure",{name:"摘要辅助图解"});
    await expect(figure).toBeVisible();
    await expect(figure.getByRole("img",{name:/摘要图解：并列对照/})).toBeVisible();
    await expect(figure.getByText("AI 生成",{exact:true})).toBeVisible();
    await expect(pane.getByRole("list",{name:"摘要要点"}).locator(":scope > li")).toHaveCount(3);
    const geometry=await figure.locator("svg").evaluate(svg=>{
      const root=svg as SVGSVGElement;
      return [...root.querySelectorAll("g")].flatMap(group=>{
        const bounds=group.querySelector("rect")!.getBBox();
        return [...group.querySelectorAll("tspan,text.ns-summary-visual-reference")].map(text=>{
          const box=(text as SVGGraphicsElement).getBBox();
          return box.x>=bounds.x+8&&box.x+box.width<=bounds.x+bounds.width-8
            &&box.y>=bounds.y&&box.y+box.height<=bounds.y+bounds.height;
        });
      });
    });
    expect(geometry.length).toBeGreaterThan(5);
    expect(geometry.every(Boolean)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
    await page.screenshot({path:info.outputPath("summary-visual.png"),fullPage:false});
    await figure.getByText("查看图解依据与来源",{exact:true}).click();
    await expect(figure.getByRole("list",{name:"图解文字依据"})).toBeVisible();
    await expect(figure.getByRole("link",{name:"测试发布者",exact:true})).toHaveAttribute("href","https://example.com/report");
    await figure.getByRole("list",{name:"图解文字依据"}).scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath("summary-visual-evidence.png"),fullPage:false});
    await figure.getByRole("button",{name:"跳到完整要点",exact:true}).click();
    const complete=pane.getByRole("list",{name:"摘要要点"});
    await expect(complete).toBeFocused();
    await expect(complete.locator(":scope > li").first()).toBeInViewport();
    await page.screenshot({path:info.outputPath("summary-complete-points.png"),fullPage:false});
    await pane.getByRole("tab",{name:"已收录原文 / 来源内容",exact:true}).click();
    await expect(figure).toHaveCount(0);
    await expect(pane.getByText("保留的原始实验说明，与摘要分开阅读。",{exact:true})).toBeVisible();
    await pane.getByRole("tab",{name:"要点",exact:true}).click();
    await expect(figure).toBeVisible();
    expect(state.unexpected).toEqual([]);
    expect(state.requests.filter(url=>new URL(url).hostname==="example.com")).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for(const publicMode of [false,true])test(`summary overview keyboard ${publicMode?"public":"private"}`,async({page},info)=>{
  await stub(page,{publicMode,visual:{...visual,kind:"overview"}});
  await page.setViewportSize({width:390,height:844});
  const pane=await openArticle(page,publicMode),figure=pane.getByRole("figure",{name:"摘要辅助图解"});
  await expect(figure.getByRole("img",{name:/摘要图解：内容结构/})).toBeVisible();
  await figure.getByRole("button",{name:"跳到完整要点",exact:true}).focus();
  await page.keyboard.press("Tab");
  const disclosure=figure.getByText("查看图解依据与来源",{exact:true});
  await expect(disclosure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(figure.getByRole("list",{name:"图解文字依据"})).toBeVisible();
  await page.screenshot({path:info.outputPath("summary-overview-keyboard.png"),fullPage:false});
  await page.keyboard.press("Enter");
  await expect(figure.getByRole("list",{name:"图解文字依据"})).not.toBeVisible();
  await figure.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("summary-overview.png"),fullPage:false});
});

for(const count of [5,6])test(`summary visual uses the exact ${count}-line boundary`,async({page})=>{
  const short=["第一条信息充分。","第二条条件明确。","第三条边界清晰。","第四条可以复现。","第五条需要验证。","第六条注明来源。"];
  const small:SummaryVisual={version:1,kind:"overview",items:[
    {label:"第一条",detail:"第一条信息充分",point:1},{label:"第二条",detail:"第二条条件明确",point:2},
  ]};
  await stub(page,{points:short.slice(0,count),visual:small});
  await page.setViewportSize({width:1440,height:1000});
  const pane=await openArticle(page);
  const lines=await pane.getByRole("list",{name:"摘要要点"}).evaluate(summaryLineCount);
  expect(lines).toBe(count);
  await expect(pane.getByRole("figure",{name:"摘要辅助图解"})).toHaveCount(count>5?1:0);
});

test("summary visual responds to wrapping after viewport changes",async({page})=>{
  const wrapped=[
    "方案甲使用公开数据完成检索，并在规定条件下验证输出；这些观察不代表所有任务都可复现，实际使用仍须检查原始数据、输入条件和输出证据。",
    "方案乙先检查引用再生成文本，并在规定条件下验证输出；这些观察不代表所有任务都可复现，实际使用仍须检查原始数据、输入条件和输出证据。",
  ];
  await stub(page,{points:wrapped,visual:{version:1,kind:"comparison",items:[
    {label:"方案甲",detail:"方案甲使用公开数据完成检索",point:1},
    {label:"方案乙",detail:"方案乙先检查引用再生成文本",point:2},
  ]}});
  await page.setViewportSize({width:1920,height:1000});
  const pane=await openArticle(page),list=pane.getByRole("list",{name:"摘要要点"});
  expect(await list.evaluate(summaryLineCount)).toBeLessThanOrEqual(5);
  await expect(pane.getByRole("figure",{name:"摘要辅助图解"})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>list.evaluate(summaryLineCount)).toBeGreaterThan(5);
  await expect(pane.getByRole("figure",{name:"摘要辅助图解"})).toBeVisible();
});

for(const publicMode of [false,true])for(const variant of [
  {name:"legacy",visual:undefined,format:3,status:"completed" as const,message:"这篇摘要尚无辅助图解"},
  {name:"pending",visual:undefined,format:3,status:"pending" as const,message:"辅助图解待随摘要更新"},
  {name:"failed",visual:undefined,format:3,status:"failed" as const,message:"辅助图解暂未生成"},
  {name:"not applicable",visual:null,format:4,status:"completed" as const,message:"这篇材料未提取出适合图解的独立信息"},
  {name:"invalid",visual:{...visual,items:[{...visual.items[0],detail:"虚构结果999"},visual.items[1]]},
    format:4,status:"completed" as const,message:"图解数据与摘要不匹配"},
])test(`summary visual explicitly handles ${variant.name} ${publicMode?"public":"private"}`,async({page},info)=>{
  await stub(page,{...variant,publicMode});
  await page.setViewportSize({width:390,height:844});
  const pane=await openArticle(page,publicMode);
  await expect(pane.getByRole("figure",{name:"摘要辅助图解"})).toHaveCount(0);
  await expect(pane.getByRole("status").filter({hasText:variant.message})).toBeVisible();
  await expect(pane.getByRole("list",{name:"摘要要点"}).locator(":scope > li")).toHaveCount(3);
  await page.screenshot({path:info.outputPath("summary-visual-status.png"),fullPage:false});
});
