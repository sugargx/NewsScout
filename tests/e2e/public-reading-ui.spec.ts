import { expect, test, type Page } from "@playwright/test";
import { hasPublicOpened, loadPublicFeedback, publicView, recordPublicOpen, type PublicArticle, type PublicBrief, type PublicFeedback } from "../../apps/web/src/public-reader";
import type { CoverageMember } from "../../apps/web/src/types";
import { interestSignature, loadPublicInterests, publicInterestKey, publicInterestTopics, savePublicInterests } from "../../apps/web/src/public-interests";

const id=(index:number)=>`c2000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`;
const sources=[
  {id:"d2000000-0000-4000-8000-000000000001",name:"研究来源 A"},
  {id:"d2000000-0000-4000-8000-000000000002",name:"研究来源 B"},
];
function article(index:number):PublicArticle {
  return {
    id:id(index),contentVersion:1,title:`Original research ${index+1}`,displayTitle:`可靠性研究 ${String(index+1).padStart(2,"0")}`,
    primaryTopic:index<20?"模型与研究":"工程实践",topics:[index<20?"模型与研究":"工程实践"],facets:[],
    eventType:"blog",summaryKind:"copilot",summaryModel:null,summarizedAt:"2026-09-16T02:00:00Z",
    summary:"保留真实适用条件，结合原始报告理解技术变化。",summaryPoints:["第一条可追溯的研究要点。","第二条方法与适用条件。","第三条详细说明只在主动阅读后展示。"],
    summaryMaterialLimit:null,summaryLimitations:[],importance:"帮助理解具体的研究方法与适用范围。",
    publishedAt:"2026-09-16T01:00:00Z",freshnessAt:"2026-09-16T01:00:00Z",publicationPrecision:"time",
    evidence:[{id:`evidence-${index}`,sourceName:sources[index%2].name,sourceTier:"T1",title:`Original research ${index+1}`,
      url:"https://example.com/research",isOfficial:true,publishedAt:"2026-09-16T01:00:00Z",excerpt:"已收录的来源摘要。",
      readingContext:{version:1,kind:"article",origin:"publisher_page",status:"available",sourceUrl:"https://example.com/research",
        body:"这是已经收录的原始研究正文，包含方法、实验过程和适用条件。不是在打开时重新抓取。",
        truncated:false,durationSeconds:null,chapters:[],transcriptUrl:null,comments:[],commentsStatus:"not_applicable",fetchedAt:"2026-09-16T02:00:00Z"}}],
  };
}
function edition(items:PublicArticle[]):PublicBrief {
  return {localDate:"2026-09-16",generatedAt:"2026-09-16T02:00:00Z",isSnapshot:false,note:"公开阅读",
    windowStart:"2026-09-09T02:00:00Z",windowEnd:"2026-09-16T02:00:00Z",estimatedMinutes:8,items,
    sections:[
      {key:"models",kind:"topic",title:"模型与研究",description:"本周值得回顾的研究进展",eventIds:items.slice(0,2).map(item=>item.id)},
      {key:"practice",kind:"topic",title:"工程实践",description:"仍有参考价值的实践",eventIds:items.slice(2).map(item=>item.id)},
    ]};
}
function archivedArticle(index:number):PublicArticle {
  const {displayTitle,contentVersion,...legacy}=article(index);
  return {...legacy,title:`七月保存的原始标题 ${index+1}`,summary:"七月当时保存的摘要，没有被当前版本改写。",
    summaryPoints:["七月保留的原始研究结论。","七月保留的适用条件。"],publishedAt:"2026-07-16T01:00:00Z",freshnessAt:"2026-07-16T01:00:00Z",
    summarizedAt:"2026-07-16T02:00:00Z",evidence:legacy.evidence.map(source=>({...source,publishedAt:"2026-07-16T01:00:00Z"}))};
}
function archivedMember(index:number):CoverageMember {
  const value=archivedArticle(index);
  return {eventId:value.id,title:value.title,eventType:value.eventType,publishedAt:value.publishedAt??null,
    publicationPrecision:"time",summaryKind:value.summaryKind,summary:value.summary,summaryPoints:value.summaryPoints,
    summaryMaterialLimit:null,summaryLimitations:[],summaryModel:null,summarizedAt:value.summarizedAt,
    evidence:value.evidence.map(source=>({...source,url:source.url??"https://example.com/research"})),relationship:"archived_material",materialKind:"editorial",matchesFilters:true};
}
async function fixture(page:Page,options:{theme?:string;feedback?:PublicFeedback;manyTopics?:boolean;interestFixtures?:boolean}={}) {
  if(options.theme)await page.emulateMedia({colorScheme:options.theme==="dark"?"dark":"light"});
  const articles=Array.from({length:45},(_,index)=>article(index));
  if(options.interestFixtures)for(const [index,item] of articles.entries()) {
    item.primaryTopic=index<25?"Agent 与工具":"心理与认知";item.topics=[item.primaryTopic];item.facets=item.topics;
  }
  function ranked(url:URL) {
    const weights=new Map((url.searchParams.get("interests")??"").split(",").filter(Boolean).map(value=>{
      const [id,weight]=value.split(":");return [publicInterestTopics.find(topic=>topic.id===id)?.label,Number(weight)];
    }));
    const selected=articles.filter(item=>!url.searchParams.get("facet")||item.topics.includes(url.searchParams.get("facet")!));
    return ["newest","score"].includes(url.searchParams.get("sort")??"")?selected:
      selected.sort((a,b)=>(weights.get(b.primaryTopic)??35)-(weights.get(a.primaryTopic)??35));
  }
  const company={...article(46),displayTitle:"公司近况，不是技术研究"};
  const old={...article(48),displayTitle:"六月的技术长文",publishedAt:"2026-06-16T01:00:00Z"};
  const all=[...articles,company,old];
  const reads:URL[]=[],forbidden:string[]=[],errors:string[]=[];
  const weekly=edition([article(0),article(1),article(20),article(21)]);
  if(options.manyTopics) {
    weekly.items=Array.from({length:8},(_,index)=>article(index));
    weekly.sections=["评测与安全","记忆与检索","工程与开源","Agent 与工具","模型与多模态","芯片与硬件","AI 编程","治理与政策"]
      .map((title,index)=>({key:`topic-${index}`,kind:"topic",title,description:"本周值得回顾的进展",eventIds:[id(index)]}));
  }
  const legacy={...edition([archivedArticle(0),archivedArticle(1)]),localDate:"2026-07-16",generatedAt:"2026-07-16T02:00:00Z",isSnapshot:true,sections:undefined};
  const grouped=archivedArticle(0);
  grouped.coverage={key:"saved-bundle",topic:"七月保存的独立材料",relation:"archived_materials",method:"legacy-snapshot-preserved-v1",
    windowHours:168,materialCount:2,newsMaterialCount:2,editorialSourceCount:2,officialSourceCount:0,communityMaterialCount:0,popularityBoost:0,
    members:[archivedMember(0),archivedMember(1)]};
  const groupedArchive={...legacy,localDate:"2026-07-17",generatedAt:"2026-07-17T02:00:00Z",items:[grouped]};
  await page.addInitScript(({feedback})=>{
    if(feedback)localStorage.setItem("newsscout-public-feedback-v1",JSON.stringify(feedback));
    const mark=()=>{if(document.documentElement){document.documentElement.dataset.publicReader="true";observer.disconnect();}};
    const observer=new MutationObserver(mark);observer.observe(document,{childList:true,subtree:true});mark();
  },options);
  page.on("pageerror",error=>errors.push(error.message));
  await page.route(/\/(?:api|beta\/api)\//,async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(request.method()!=="GET"||!path.startsWith("/beta/api/")) {
      forbidden.push(`${request.method()} ${path}`);return route.fulfill({status:405,json:{error:"Not a public read"}});
    }
    reads.push(url);
    if(path==="/beta/api/reading/sources")return route.fulfill({json:{items:sources}});
    if(path==="/beta/api/reading") {
      const source=url.searchParams.get("source"),scope=url.searchParams.get("scope"),hours=url.searchParams.get("hours");
      const offset=Number(url.searchParams.get("offset")??0),limit=Number(url.searchParams.get("limit")??40);
      const selected=all.filter(item=>(!source||item.evidence[0].sourceName===sources.find(value=>value.id===source)?.name)
        &&(scope==="all"||item.id!==company.id)&&(hours==="0"||item.id!==old.id));
      return route.fulfill({json:{items:selected.slice(offset,offset+limit),nextOffset:offset+limit<selected.length?offset+limit:null,asOf:url.searchParams.get("asOf")}});
    }
    if(path==="/beta/api/briefs")return route.fulfill({json:{items:[
      {localDate:groupedArchive.localDate,generatedAt:groupedArchive.generatedAt,itemCount:1},
      {localDate:legacy.localDate,generatedAt:legacy.generatedAt,itemCount:2},
    ]}});
    if(path==="/beta/api/brief")return route.fulfill({json:edition((options.interestFixtures?ranked(url):articles).slice(0,4))});
    if(path==="/beta/api/briefs/2026-07-16")return route.fulfill({json:legacy});
    if(path==="/beta/api/briefs/2026-07-17")return route.fulfill({json:groupedArchive});
    if(path==="/beta/api/weekly")return route.fulfill({json:weekly});
    if(path==="/beta/api/events") {
      if(!options.interestFixtures)return route.fulfill({json:{items:articles.slice(0,4),nextOffset:null}});
      const selected=ranked(url),offset=Number(url.searchParams.get("offset")??0),limit=Number(url.searchParams.get("limit")??40);
      return route.fulfill({json:{items:selected.slice(offset,offset+limit),nextOffset:offset+limit<selected.length?offset+limit:null}});
    }
    if(path==="/beta/api/explore"&&options.interestFixtures)return route.fulfill({json:{
      sampleSize:45,limit:100,meaning:"Fixture topic co-occurrence",nodes:[{id:"Agent 与工具",count:25},{id:"心理与认知",count:20}],edges:[],
    }});
    const value=all.find(item=>path==="/beta/api/events/"+item.id);
    if(value) {
      const current={...value,contentVersion:2,summary:"当前已收录的详情，内容已经比七月完整。",
        summaryPoints:["当前已收录的详情，内容已经比七月完整。",...(value.summaryPoints??[]).slice(1)]};
      if(value.id===id(0))current.coverage={...grouped.coverage,members:[archivedMember(0),archivedMember(1),archivedMember(2)],materialCount:3};
      return route.fulfill({json:current});
    }
    return route.fulfill({status:404,json:{error:"没有这个已保存版本或公开内容"}});
  });
  return {reads,forbidden,errors,articles,legacy,groupedArchive};
}
function queue(page:Page){return page.getByRole("region",{name:"T1 顺序阅读队列",exact:true});}
function detail(page:Page){return page.getByRole("complementary",{name:"公开文章阅读区",exact:true});}
function interestsDialog(page:Page){return page.getByRole("dialog",{name:"兴趣主题",exact:true});}
async function editInterests(page:Page,topic="心理与认知",weight="100") {
  await page.getByRole("button",{name:/^兴趣主题/}).click();
  await interestsDialog(page).getByRole("checkbox",{name:topic,exact:true}).check();
  await interestsDialog(page).getByLabel(`${topic}关注程度`,{exact:true}).selectOption(weight);
  await interestsDialog(page).getByRole("button",{name:"保存并应用",exact:true}).click();
  await expect(interestsDialog(page)).toHaveCount(0);
}

test("visitor interests persist separately, validate stored data and reject cross-tab overwrites",()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  let stored:string|null=null;
  try {
    Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{
      getItem:(key:string)=>key===publicInterestKey?stored:null,
      setItem:(key:string,value:string)=>{expect(key).toBe(publicInterestKey);stored=value;},
    }});
    const saved=savePublicInterests([{id:"psychology",weight:100},{id:"agents",weight:50}],null);
    expect(interestSignature(loadPublicInterests().value)).toBe("agents:50,psychology:100");
    expect(()=>savePublicInterests([],null)).toThrow("另一页面");
    expect(stored).toBe(saved.raw);
    for(const raw of ["", "{broken",JSON.stringify({version:2,topics:[]}),JSON.stringify({version:1,topics:[{id:"unknown",weight:80}]}),
      JSON.stringify({version:1,topics:[{id:"agents",weight:25}]}),JSON.stringify({version:1,topics:[{id:"agents",weight:80},{id:"agents",weight:100}]})]) {
      stored=raw;expect(loadPublicInterests().error).not.toBeNull();expect(stored).toBe(raw);
      expect(()=>savePublicInterests([],raw)).toThrow();
    }
  } finally {
    if(descriptor)Object.defineProperty(globalThis,"localStorage",descriptor);else Reflect.deleteProperty(globalThis,"localStorage");
  }
});

test("visitor interests change current selection and full Radar batches, not archive or T1 ordering",async({page,browser})=>{
  const state=await fixture(page,{interestFixtures:true});
  await page.goto("/");
  await editInterests(page);
  await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(25));
  const first=state.reads.filter(url=>url.pathname==="/beta/api/brief").at(-1)!;
  expect(first.searchParams.get("interests")).toBe("psychology:100");
  expect(first.searchParams.get("asOf")).toMatch(/Z$/);
  await page.reload();
  await expect(page.getByRole("button",{name:"兴趣主题（已选 1 项）",exact:true})).toBeVisible();
  await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(25));
  await page.goto("/radar");
  await expect(page.locator(".ns-beta-feed [data-public-event]")).toHaveCount(40);
  const radar=state.reads.filter(url=>url.pathname==="/beta/api/events").at(-1)!;
  await page.getByRole("button",{name:"加载更多",exact:true}).click();
  await expect(page.locator(".ns-beta-feed [data-public-event]")).toHaveCount(45);
  const next=state.reads.filter(url=>url.pathname==="/beta/api/events").at(-1)!;
  expect(next.searchParams.get("offset")).toBe("40");
  expect(next.searchParams.get("interests")).toBe("psychology:100");
  expect(next.searchParams.get("asOf")).toBe(radar.searchParams.get("asOf"));
  await page.goto("/?edition=2026-07-16");
  await expect(page.locator(".ns-beta-feed")).toContainText("七月保存的原始标题");
  await page.goto("/reading");
  await expect(queue(page).locator("[data-public-event]").first()).toHaveAttribute("data-public-event",id(0));
  expect(state.reads.filter(url=>url.pathname.startsWith("/beta/api/briefs")||url.pathname.startsWith("/beta/api/reading")).every(url=>!url.searchParams.has("interests"))).toBe(true);
  const context=await browser.newContext({baseURL:process.env.SCOUTNEWS_E2E_BASE_URL,serviceWorkers:"block"});
  try {
    const colleague=await context.newPage(),other=await fixture(colleague,{interestFixtures:true});
    await colleague.goto("/");
    await expect(colleague.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(0));
    expect(other.reads.every(url=>!url.searchParams.has("interests"))).toBe(true);
    expect(await colleague.evaluate(key=>localStorage.getItem(key),publicInterestKey)).toBeNull();
  } finally {await context.close();}
  expect(state.forbidden).toEqual([]);expect(state.errors).toEqual([]);
});

test("visitor interests cancel, clear and modal Escape preserve the underlying reader",async({page})=>{
  const state=await fixture(page,{interestFixtures:true});
  await page.goto("/radar");await editInterests(page);
  await page.locator(".ns-beta-feed [data-public-event]").first().locator("h3 button").click();
  await expect(detail(page)).toBeVisible();
  const active=page.url(),stored=await page.evaluate(key=>localStorage.getItem(key),publicInterestKey);
  await page.getByRole("button",{name:/^兴趣主题/}).click();
  await interestsDialog(page).getByRole("checkbox",{name:"AI 编程",exact:true}).check();
  await page.keyboard.press("Escape");
  await expect(interestsDialog(page)).toHaveCount(0);
  await expect(detail(page)).toBeVisible();expect(page.url()).toBe(active);
  expect(await page.evaluate(key=>localStorage.getItem(key),publicInterestKey)).toBe(stored);
  await expect(page.getByRole("button",{name:/^兴趣主题/})).toBeFocused();
  await page.getByRole("button",{name:/^兴趣主题/}).click();
  await interestsDialog(page).getByRole("button",{name:"清空选择",exact:true}).click();
  await interestsDialog(page).getByRole("button",{name:"保存并应用",exact:true}).click();
  await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(0));
  expect(state.reads.filter(url=>url.pathname==="/beta/api/events").at(-1)?.searchParams.has("interests")).toBe(false);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("newsscout-public-feedback-v1")!).opened.length)).toBe(1);
  expect(state.errors).toEqual([]);
});

test("visitor interests retain unsaved choices on storage failure and require explicit corruption reset",async({page})=>{
  await fixture(page,{interestFixtures:true});await page.goto("/radar");
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==="newsscout-public-interests-v1")throw new DOMException("Test quota","QuotaExceededError");original.call(this,key,value);};
    window.addEventListener("restore-interest-storage",()=>{Storage.prototype.setItem=original;},{once:true});
  });
  await page.getByRole("button",{name:/^兴趣主题/}).click();
  await interestsDialog(page).getByRole("checkbox",{name:"心理与认知",exact:true}).check();
  await interestsDialog(page).locator(".ns-interest-content").evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await interestsDialog(page).getByRole("button",{name:"保存并应用",exact:true}).click();
  await expect(interestsDialog(page).getByRole("alert")).toContainText("此次选择尚未生效");
  await expect.poll(()=>interestsDialog(page).getByRole("alert").evaluate(element=>{
    const box=element.getBoundingClientRect(),panel=element.closest(".ns-interest-content")!.getBoundingClientRect();
    return box.top>=panel.top&&box.bottom<=panel.bottom;
  })).toBe(true);
  await expect(interestsDialog(page).getByRole("checkbox",{name:"心理与认知",exact:true})).toBeChecked();
  expect(await page.evaluate(key=>localStorage.getItem(key),publicInterestKey)).toBeNull();
  await page.evaluate(()=>window.dispatchEvent(new Event("restore-interest-storage")));
  await interestsDialog(page).getByRole("button",{name:"保存并应用",exact:true}).click();
  await expect(interestsDialog(page)).toHaveCount(0);
  await page.evaluate(key=>localStorage.setItem(key,"{broken-interest-record"),publicInterestKey);
  await page.reload();
  await expect(page.getByRole("complementary",{name:"兴趣设置提示"})).toContainText("原有数据未覆盖");
  await page.getByRole("button",{name:/^兴趣主题/}).click();
  await expect(interestsDialog(page).getByRole("button",{name:"保存并应用",exact:true})).toBeDisabled();
  await interestsDialog(page).getByRole("button",{name:"重置兴趣记录",exact:true}).click();
  expect(await page.evaluate(key=>localStorage.getItem(key),publicInterestKey)).toBe("{broken-interest-record");
  await interestsDialog(page).getByRole("button",{name:"确认重置兴趣",exact:true}).click();
  await expect(interestsDialog(page)).toHaveCount(0);
  expect(await page.evaluate(key=>localStorage.getItem(key),publicInterestKey)).toBeNull();
});

test("visitor interests from another tab are applied explicitly and cannot silently overwrite a draft",async({page})=>{
  await fixture(page,{interestFixtures:true});await page.goto("/radar");
  const other=await page.context().newPage();
  await fixture(other,{interestFixtures:true});await other.goto("/radar");
  await page.getByRole("button",{name:/^兴趣主题/}).click();
  await interestsDialog(page).getByRole("checkbox",{name:"AI 编程",exact:true}).check();
  await editInterests(other);
  await expect(page.locator(".ns-interest-notice")).toContainText("仍保留当前阅读顺序");
  await interestsDialog(page).getByRole("button",{name:"保存并应用",exact:true}).click();
  await expect(interestsDialog(page).getByRole("alert")).toContainText("另一页面已更新兴趣");
  await expect(interestsDialog(page).getByRole("checkbox",{name:"AI 编程",exact:true})).toBeChecked();
  await interestsDialog(page).getByRole("button",{name:"取消",exact:true}).click();
  await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(0));
  await page.getByRole("button",{name:"应用其他页面的设置",exact:true}).click();
  await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(25));
  await other.close();
});

test("visitor interests never merge an old in-flight page into a new profile even at the same cutoff",async({page})=>{
  await page.clock.setFixedTime(new Date("2026-09-17T04:00:00.000Z"));
  const state=await fixture(page,{interestFixtures:true});
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const pending:Promise<void>[]=[];
  await page.route(/\/beta\/api\/events\?/,route=>{
    const query=new URL(route.request().url()).searchParams;
    if(query.get("offset")!=="40"||query.has("interests"))return route.fallback();
    entered();
    const held=gate.then(()=>route.fulfill({json:{items:state.articles.slice(40),nextOffset:null}}));
    pending.push(held);return held;
  });
  try {
    await page.goto("/radar");
    await expect(page.locator(".ns-beta-feed [data-public-event]")).toHaveCount(40);
    await page.getByRole("button",{name:"加载更多",exact:true}).click();await started;
    await editInterests(page);
    await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toHaveAttribute("data-public-event",id(25));
    release();await Promise.all(pending);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(null))));
    await expect(page.locator(".ns-beta-feed [data-public-event]")).toHaveCount(40);
    expect(state.reads.filter(url=>url.pathname==="/beta/api/events").at(-1)?.searchParams.get("interests")).toBe("psychology:100");
    expect(new Set(state.reads.filter(url=>url.pathname==="/beta/api/events").map(url=>url.searchParams.get("asOf"))).size).toBe(1);
  } finally {release();await Promise.all(pending);}
});

test("visitor interests scope topic samples and results to the same frozen profile",async({page})=>{
  const state=await fixture(page,{interestFixtures:true});
  await page.goto("/radar?view=topics");await editInterests(page);
  await expect(page.locator(".ns-topic-article").first()).toContainText("可靠性研究 26");
  await page.locator('[data-topic-id="心理与认知"]').click();
  await expect(page.locator(".ns-topic-article")).toHaveCount(20);
  const graph=state.reads.filter(url=>url.pathname==="/beta/api/explore"&&url.searchParams.has("interests")).at(-1)!;
  const results=state.reads.filter(url=>url.pathname==="/beta/api/events"&&url.searchParams.get("facet")==="心理与认知").at(-1)!;
  expect(results.searchParams.get("interests")).toBe("psychology:100");
  expect(results.searchParams.get("asOf")).toBe(graph.searchParams.get("asOf"));
  await page.locator(".ns-topic-article").first().click();
  await expect(detail(page)).toBeVisible();
  expect(state.reads.filter(url=>/\/events\/[^/]+$/.test(url.pathname)).at(-1)?.searchParams.get("interests")).toBe("psychology:100");
  expect(state.forbidden).toEqual([]);expect(state.errors).toEqual([]);
});

for(const [width,theme] of [[1280,"light"],[1024,"light"],[768,"light"],[390,"light"],[320,"light"],[1280,"dark"],[390,"dark"]] as const) {
  test(`visitor interests dialog fits ${width}px ${theme} with a stable footer and keyboard focus`,async({page})=>{
    await page.setViewportSize({width,height:width<=390?844:900});
    await page.emulateMedia({reducedMotion:"reduce"});
    await fixture(page,{theme,interestFixtures:true});await page.goto("/radar");
    await page.getByRole("button",{name:/^兴趣主题/}).click();
    const dialog=interestsDialog(page);
    await expect(dialog.getByRole("checkbox")).toHaveCount(13);
    await expect(dialog.getByRole("button",{name:"保存并应用",exact:true})).toBeVisible();
    await dialog.getByRole("checkbox",{name:"模型与多模态",exact:true}).check();
    await dialog.getByLabel("模型与多模态关注程度",{exact:true}).selectOption("100");
    const geometry=await dialog.evaluate(element=>{
      const box=element.getBoundingClientRect();
      const footer=element.querySelector(".ns-interest-actions")!.getBoundingClientRect();
      const title=element.querySelector(".fui-DialogTitle")!.getBoundingClientRect();
      const close=element.querySelector('[aria-label="关闭兴趣设置"]')!.getBoundingClientRect();
      const indicatorOffsets=[...element.querySelectorAll(".ns-interest-option")].map(option=>{
        const indicator=option.querySelector(".fui-Checkbox__indicator")!.getBoundingClientRect();
        const range=document.createRange();range.selectNodeContents(option.querySelector(".fui-Checkbox__label")!);
        const label=range.getBoundingClientRect();
        return Math.abs(indicator.top+indicator.height/2-label.top-label.height/2);
      });
      return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,footerBottom:footer.bottom,
        titleRight:title.right,closeLeft:close.left,headerOffset:Math.abs(title.top-close.top),
        closeWidth:close.width,closeHeight:close.height,indicatorOffsets,
        width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth};
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.bottom);
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    expect(geometry.closeLeft).toBeGreaterThanOrEqual(geometry.titleRight+12);
    expect(geometry.headerOffset).toBeLessThanOrEqual(8);
    expect(geometry.closeWidth).toBeGreaterThanOrEqual(44);expect(geometry.closeHeight).toBeGreaterThanOrEqual(44);
    expect(Math.max(...geometry.indicatorOffsets)).toBeLessThanOrEqual(3);
    await dialog.getByRole("button",{name:"保存并应用",exact:true}).focus();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button",{name:/^兴趣主题/})).toBeFocused();
  });
}

for(const theme of ["light","dark"] as const)for(const forcedColors of ["none","active"] as const) {
  test(`visitor interests use one button focus treatment for keyboard and pointer in ${theme} ${forcedColors}`,async({page})=>{
    await page.setViewportSize({width:390,height:844});
    await fixture(page,{theme,interestFixtures:true});
    await page.emulateMedia({colorScheme:theme,forcedColors,reducedMotion:"reduce"});await page.goto("/radar");
    await page.getByRole("button",{name:/^兴趣主题/}).click();
    const dialog=interestsDialog(page),save=dialog.getByRole("button",{name:"保存并应用",exact:true});
    const checkbox=dialog.getByRole("checkbox",{name:"Agent 与工具",exact:true});
    await checkbox.focus();await page.keyboard.press("Space");await expect(checkbox).toBeChecked();
    await save.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");
    await expect(save).toBeFocused();
    const focus=await save.evaluate(element=>{
      const css=getComputedStyle(element);return {visible:element.matches(":focus-visible"),outline:css.outlineStyle,width:parseFloat(css.outlineWidth),shadow:css.boxShadow};
    });
    expect(focus).toMatchObject({visible:true,outline:"solid",shadow:"none"});expect(focus.width).toBeGreaterThanOrEqual(2);
    await save.hover();await page.mouse.down();
    expect(await save.evaluate(element=>getComputedStyle(element).boxShadow)).toBe("none");
    await page.mouse.up();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button",{name:"兴趣主题（已选 1 项）",exact:true})).toBeVisible();
  });
}

test.use({serviceWorkers:"block"});
test.beforeEach(async({page})=>{
  const base=process.env.SCOUTNEWS_E2E_BASE_URL;
  if(!base||process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true"&&process.env.SCOUTNEWS_E2E_MOCK_ONLY!=="true")
    throw new Error("Use the isolated launcher or explicitly API-blocked mock-only UI checks.");
  if(!["127.0.0.1","localhost","[::1]"].includes(new URL(base).hostname))
    throw new Error("Public reading UI fixtures require a local frontend.");
  await page.route(/\/(?:api|beta\/api)\//,route=>route.abort("blockedbyclient"));
});

test("public route aliases and version-aware local opens preserve legacy browser state",()=>{
  for(const view of ["radar","reading","weekly","saved"] as const) {
    expect(publicView("/"+view,null)).toBe(view);
    expect(publicView("/",view)).toBe(view);
  }
  expect(publicView("/reading","weekly")).toBe("weekly");
  const legacy:PublicFeedback={saved:{},dismissed:[],opened:[id(0)]};
  expect(hasPublicOpened(legacy,article(0))).toBe(true);
  expect(hasPublicOpened(legacy,article(1))).toBe(false);
  const next=recordPublicOpen(legacy,{id:id(0),contentVersion:2});
  expect(next.opened).toEqual([id(0)]);
  expect(hasPublicOpened(next,{id:id(0),contentVersion:1})).toBe(true);
  expect(hasPublicOpened(next,{id:id(0),contentVersion:3})).toBe(false);
  expect(recordPublicOpen(next,{id:id(0),contentVersion:1}).openedVersions?.[id(0)]).toBe(2);
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  let stored=JSON.stringify(next);
  try {
    Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>stored}});
    expect(loadPublicFeedback().value.openedVersions).toEqual({[id(0)]:2});
    stored=JSON.stringify({...legacy,openedVersions:{[id(1)]:2}});
    expect(loadPublicFeedback().error).not.toBeNull();
  } finally {
    if(descriptor)Object.defineProperty(globalThis,"localStorage",descriptor);
    else Reflect.deleteProperty(globalThis,"localStorage");
  }
});

test("public T1 filters, anchored pagination and source reading work without owner requests",async({page})=>{
  const state=await fixture(page);
  await page.goto("/reading");
  await expect(page.getByRole("heading",{level:1,name:"深度阅读",exact:true})).toBeVisible();
  await expect(page.getByRole("navigation",{name:"公开阅读视图"}).getByRole("button")).toHaveCount(5);
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await expect(detail(page)).toHaveCount(0);
  const firstRequest=state.reads.find(url=>url.pathname==="/beta/api/reading")!;
  expect(firstRequest.searchParams.get("scope")).toBe("technical");
  expect(firstRequest.searchParams.get("hours")).toBe("720");
  expect(firstRequest.searchParams.get("asOf")).toMatch(/Z$/);
  await page.getByRole("button",{name:"加载更多文章",exact:true}).click();
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(45);
  expect(state.reads.filter(url=>url.pathname==="/beta/api/reading").at(-1)?.searchParams.get("asOf")).toBe(firstRequest.searchParams.get("asOf"));
  await page.getByLabel("T1 博客来源",{exact:true}).selectOption(sources[0].id);
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(23);
  await expect(queue(page)).not.toContainText(sources[1].name);
  expect(state.reads.filter(url=>url.pathname==="/beta/api/reading").at(-1)?.searchParams.get("source")).toBe(sources[0].id);
  await page.getByLabel("阅读内容",{exact:true}).selectOption("all");
  await expect(queue(page)).toContainText("公司近况，不是技术研究");
  await expect(queue(page)).not.toContainText("六月的技术长文");
  await page.getByLabel("阅读时间范围",{exact:true}).selectOption("0");
  await expect(queue(page)).toContainText("六月的技术长文");
  await queue(page).locator("[data-public-event]").first().click();
  await expect(detail(page)).toContainText("第三条详细说明");
  await detail(page).getByRole("tab",{name:"已收录原文 / 来源内容",exact:true}).click();
  await expect(detail(page)).toContainText("这是已经收录的原始研究正文");
  expect(state.forbidden).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("unopened-only keeps the active article and restores useful focus after it leaves the list",async({page})=>{
  const state=await fixture(page);
  await page.goto("/?tab=reading");
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await page.getByLabel("只看尚未打开的文章",{exact:true}).check();
  const first=queue(page).locator(`[data-public-event="${id(0)}"]`);
  await first.click();
  await expect(detail(page)).toContainText("当前已收录的详情");
  await expect(first).toContainText("已打开");
  await expect(first).toHaveAttribute("aria-pressed","true");
  await page.keyboard.press("Escape");
  await expect(detail(page)).toHaveCount(0);
  await expect(first).toHaveCount(0);
  await expect(queue(page).locator("[data-public-event]").first()).toBeFocused();
  await page.reload();
  await expect(queue(page).locator(`[data-public-event="${id(0)}"]`)).toContainText("已打开");
  expect(state.forbidden).toEqual([]);
});

test("next article crosses pages but skips browser-opened and dismissed entries",async({page})=>{
  await fixture(page,{feedback:{saved:{},dismissed:[id(41)],opened:[id(40)]}});
  await page.goto("/reading");
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await page.getByLabel("只看尚未打开的文章",{exact:true}).check();
  await queue(page).locator(`[data-public-event="${id(39)}"]`).click();
  await expect(detail(page).getByRole("heading",{name:article(39).displayTitle!,exact:true})).toBeVisible();
  await detail(page).getByRole("button",{name:"下一篇",exact:true}).click();
  await expect(detail(page).getByRole("heading",{name:article(42).displayTitle!,exact:true})).toBeVisible();
  await expect(queue(page).locator(`[data-public-event="${id(42)}"]`)).toHaveAttribute("aria-pressed","true");
  await expect(queue(page).locator(`[data-public-event="${id(41)}"]`)).toHaveCount(0);
});

test("a delayed next page cannot open an article after the T1 source scope changes",async({page})=>{
  const state=await fixture(page);
  let release!:()=>void,entered!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const drained=new Promise<void>(resolve=>{finished=resolve;});
  await page.route("**/beta/api/reading?**",async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.get("offset")!=="40"||url.searchParams.has("source"))return route.fallback();
    entered();
    await gate;
    try {await route.fulfill({json:{items:state.articles.slice(40),nextOffset:null,asOf:url.searchParams.get("asOf")}});}
    finally {finished();}
  });
  await page.goto("/reading");
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await queue(page).locator(`[data-public-event="${id(39)}"]`).click();
  await expect(detail(page)).toContainText("第三条详细说明");
  await detail(page).getByRole("button",{name:"下一篇",exact:true}).click();
  await started;
  await page.getByLabel("T1 博客来源",{exact:true}).selectOption(sources[0].id);
  await expect(detail(page)).toHaveCount(0);
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(23);
  await queue(page).locator("[data-public-event]").first().click();
  release();await drained;
  await expect(detail(page).getByRole("heading",{name:article(0).displayTitle!,exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get("article")).toBe(id(0));
  expect(state.errors).toEqual([]);
});

test("weekly navigation uses returned sections and preserves order through in-place reading",async({page})=>{
  const state=await fixture(page);
  await page.goto("/weekly");
  const list=page.getByRole("region",{name:"公开新闻列表",exact:true});
  await expect(list.locator("[data-public-event]")).toHaveCount(4);
  expect(await list.locator("[data-public-event]").evaluateAll(elements=>elements.map(element=>element.getAttribute("data-public-event")))).toEqual([id(0),id(1),id(20),id(21)]);
  await expect(page.getByRole("navigation",{name:"本周主题导航"}).getByRole("link")).toHaveCount(2);
  const link=page.getByRole("link",{name:"工程实践 2 篇",exact:true});
  const anchor=await link.getAttribute("href");
  await link.click();
  await expect(page.locator(`[id=${JSON.stringify(anchor!.slice(1))}]`)).toBeInViewport();
  await list.locator("[data-public-event]").first().getByRole("heading").getByRole("button").click();
  await expect(detail(page)).toContainText("第三条详细说明");
  await detail(page).getByRole("button",{name:"下一篇",exact:true}).click();
  await expect(detail(page).getByRole("heading",{name:article(1).displayTitle!,exact:true})).toBeVisible();
  expect(state.reads.some(url=>url.pathname==="/beta/api/brief")).toBe(false);
  expect(state.forbidden).toEqual([]);
});

test("saved archives keep original titles and material membership while current detail is labeled",async({page})=>{
  const state=await fixture(page);
  await page.goto("/");
  await expect(page.getByLabel("晨报版本",{exact:true}).locator("option")).toHaveCount(3);
  await page.getByLabel("晨报版本",{exact:true}).selectOption("2026-07-16");
  const list=page.getByRole("region",{name:"公开新闻列表",exact:true});
  await expect(list.locator("[data-public-event]")).toHaveCount(2);
  await expect(list).toContainText("七月保存的原始标题 1");
  await expect(list).toContainText("七月保留的原始研究结论");
  await expect(page.locator("[data-edition-kind]")).toHaveCount(0);
  await list.getByRole("button",{name:"七月保存的原始标题 1",exact:true}).click();
  await expect(detail(page)).toContainText("此处展示当前已收录的文章详情");
  await expect(detail(page)).toContainText("当前已收录的详情");
  await expect(list).toContainText("七月保存的原始标题 1");
  await expect(list).not.toContainText("当前已收录的详情");
  await page.getByLabel("晨报版本",{exact:true}).selectOption("2026-07-17");
  await expect(detail(page)).toHaveCount(0);
  await list.locator(".cp-coverage > summary").click();
  await expect(list).toContainText("这是保存版本中收录的材料");
  await expect(list.locator("[data-coverage-member]")).toHaveCount(2);
  await list.locator(".cp-coverage").getByRole("button",{name:"七月保存的原始标题 1",exact:true}).click();
  await detail(page).locator(".cp-coverage > summary").click();
  await expect(detail(page).locator("[data-coverage-member]")).toHaveCount(2);
  await expect(detail(page)).not.toContainText("七月保存的原始标题 3");
  await expect(page.getByRole("button",{name:/保存今日简报|生成分享|采集/})).toHaveCount(0);
  expect(state.forbidden).toEqual([]);
});

test("public reading failures and unavailable archives stay explicit rather than showing current content",async({page})=>{
  await fixture(page);
  let failing=true;
  await page.route("**/beta/api/reading?**",route=>failing?route.fulfill({status:503,json:{error:"阅读队列暂不可用"}}):route.fallback());
  await page.goto("/reading");
  await expect(page.getByRole("alert")).toContainText("阅读队列暂不可用");
  await expect(page.getByText("这个范围暂时没有文章。",{exact:true})).toHaveCount(0);
  failing=false;
  await page.getByRole("alert").getByRole("button",{name:"重试",exact:true}).click();
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await page.goto("/?edition=2026-07-18");
  await expect(page.getByRole("alert")).toContainText("没有这个已保存版本");
  await expect(page.locator("[data-public-event]")).toHaveCount(0);
  await page.getByLabel("晨报版本",{exact:true}).selectOption("latest");
  await expect(page.locator("[data-public-event]")).toHaveCount(4);
});

test("a bounded public queue explicitly distinguishes its limit from the end of the archive",async({page})=>{
  await fixture(page);
  await page.route("**/beta/api/reading?**",route=>route.fulfill({json:{
    items:[article(0)],nextOffset:null,asOf:new URL(route.request().url()).searchParams.get("asOf"),paginationLimited:true,
  }}));
  await page.goto("/reading");
  await expect(queue(page).getByRole("note")).toContainText("本次队列已达到公开浏览上限");
  await expect(page.locator(".ns-beta-section-title")).toContainText("已到本次浏览上限");
  await expect(page.getByRole("button",{name:"加载更多文章",exact:true})).toHaveCount(0);
});

test("public T1, weekly and archive loading retain structure without invented totals",async({page},info)=>{
  await fixture(page,{theme:"dark"});
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  for(const entry of [
    {name:"reading",path:"/reading",pattern:/\/beta\/api\/reading\?/,variant:"queue",count:40},
    {name:"weekly",path:"/weekly",pattern:/\/beta\/api\/weekly$/,variant:"cards",count:4},
    {name:"archive",path:"/?edition=2026-07-16",pattern:/\/beta\/api\/briefs\/2026-07-16$/,variant:"cards",count:2},
  ]) {
    let release!:()=>void,finished!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const drained=new Promise<void>(resolve=>{finished=resolve;});
    await page.route(entry.pattern,async route=>{await gate;try {await route.fallback();} finally {finished();}});
    try {
      await page.goto(entry.path);
      await expect(page.locator(`[data-reader-skeleton="${entry.variant}"]`)).toBeVisible();
      await expect(page.getByRole("status").filter({hasText:/正在读取/})).toBeVisible();
      await expect(page.locator("#main-content")).not.toContainText(/已加载 0|已打开 0|0 篇/);
      await expect(page.locator("[data-public-event]")).toHaveCount(0);
      if(entry.name==="reading")await expect(page.getByRole("button",{name:"从第 1 篇开始",exact:true})).toHaveCount(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:info.outputPath(`public-${entry.name}-loading-dark-390.png`)});
      release();await drained;
      await expect(page.locator("[data-public-event]")).toHaveCount(entry.count);
      await expect(page.locator("[data-reader-skeleton]")).toHaveCount(0);
    } finally {release();}
    await page.unroute(entry.pattern);
  }
});

test("saved path alias and navigation preserve browser-only favorites",async({page,browser})=>{
  const state=await fixture(page,{feedback:{saved:{[id(0)]:{title:"这台浏览器收藏的文章",publisher:sources[0].name,savedAt:"2026-09-16T02:00:00Z"}},dismissed:[],opened:[]}});
  await page.goto("/saved");
  await expect(page.getByRole("region",{name:"本浏览器收藏",exact:true})).toContainText("这台浏览器收藏的文章");
  const other=await browser.newContext();
  try {
    const second=await other.newPage();await fixture(second);
    await second.goto(new URL("/saved",page.url()).href);
    await expect(second.getByText("先收藏一篇值得再读的文章。",{exact:true})).toBeVisible();
  } finally {await other.close();}
  await page.getByRole("button",{name:"深度阅读",exact:true}).click();
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await page.getByRole("button",{name:"每周回顾",exact:true}).click();
  await expect(page.getByRole("heading",{name:"每周回顾",level:1,exact:true})).toBeVisible();
  await page.getByRole("button",{name:"晨间简报",exact:true}).click();
  await expect(page.getByLabel("晨报版本",{exact:true})).toBeVisible();
  expect(state.forbidden).toEqual([]);
});

for(const theme of ["light","dark"])for(const width of [1440,390]) {
  test(`public complete reading layouts remain aligned and usable ${theme} ${width}`,async({page},info)=>{
    const state=await fixture(page,{theme,manyTopics:true});
    await page.setViewportSize({width,height:width===390?844:1000});
    await page.goto("/reading");
    await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
    await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`public-reading-${theme}-${width}.png`)});
    await queue(page).locator("[data-public-event]").first().click();
    await expect(detail(page)).toContainText("第三条详细说明");
    if(width>980) {
      const left=await queue(page).boundingBox(),right=await detail(page).boundingBox();
      expect(Math.abs(left!.y-right!.y)).toBeLessThanOrEqual(2);
    } else {await expect(queue(page)).toBeHidden();}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`public-reading-detail-${theme}-${width}.png`)});
    await page.keyboard.press("Escape");
    if(width<=980)expect(await queue(page).evaluate(element=>getComputedStyle(element).maxHeight)).toBe("none");
    await page.getByRole("button",{name:"每周回顾",exact:true}).click();
    await expect(page.getByRole("navigation",{name:"本周主题导航"}).getByRole("link")).toHaveCount(8);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`public-weekly-${theme}-${width}.png`)});
    await page.getByRole("button",{name:"晨间简报",exact:true}).click();
    await page.getByLabel("晨报版本",{exact:true}).selectOption("2026-07-16");
    await expect(page.locator("[data-public-event]")).toHaveCount(2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`public-archive-${theme}-${width}.png`)});
    expect(state.errors).toEqual([]);
    expect(state.forbidden).toEqual([]);
  });
}

for(const width of [1280,1024,768,390]) {
  test(`shared reader navigation stays discoverable and the T1 queue uses available space ${width}`,async({page})=>{
    const state=await fixture(page);
    await page.setViewportSize({width,height:width===390?844:900});
    await page.goto("/reading");
    await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
    const navigation=page.getByRole("navigation",{name:"公开阅读视图",exact:true});
    const destinations=navigation.getByRole("button");
    await expect(destinations).toHaveCount(5);
    const boxes=await destinations.evaluateAll(elements=>elements.map(element=>{
      const r=element.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
    }));
    for(const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width+1);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const main=await page.locator("#main-content").boundingBox(),list=await queue(page).boundingBox();
    expect(list!.width/main!.width).toBeGreaterThan(.85);
    await expect(page.locator(".ns-library-placeholder")).toHaveCount(0);
    if(width===1024)expect((await page.locator(".ns-reader-sidebar").boundingBox())!.width).toBeLessThanOrEqual(80);
    if(width<=860) {
      const nav=await navigation.boundingBox();
      expect(nav!.y).toBeGreaterThan((width===390?844:900)-100);
      expect(nav!.y+nav!.height).toBeLessThanOrEqual((width===390?844:900)+1);
      for(const select of await page.locator(".ns-reading-controls select").all())expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await queue(page).locator("[data-public-event]").first().click();
    await expect(detail(page)).toContainText("第三条详细说明");
    if(width>=1280) {
      const left=await queue(page).boundingBox(),right=await detail(page).boundingBox();
      expect(Math.abs(left!.y-right!.y)).toBeLessThanOrEqual(2);
      expect(right!.width).toBeGreaterThan(390);
    } else {
      await expect(queue(page)).toBeHidden();
      await expect(detail(page).locator(".ns-reader-position")).toContainText("第 1 / 40+ 篇");
      await expect(detail(page).getByRole("button",{name:"返回列表",exact:true})).toBeVisible();
    }
    expect(state.forbidden).toEqual([]);
  });
}

test("reading dependency failures have one recovery action and no misleading start prompt",async({page},info)=>{
  const state=await fixture(page,{theme:"dark"});
  await page.setViewportSize({width:390,height:844});
  let failing=true;
  await page.route(/\/beta\/api\/reading(?:\/sources|\?)/,route=>failing?route.fulfill({status:503,json:{error:"服务暂时不可用"}}):route.fallback());
  await page.goto("/reading");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("阅读队列暂时不可用");
  await expect(page.getByRole("alert").getByRole("button")).toHaveCount(1);
  await expect(page.locator(".ns-reader-start")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"更新队列",exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath("reading-combined-error-dark-390.png")});
  failing=false;
  await page.getByRole("alert").getByRole("button",{name:"重试",exact:true}).click();
  await expect(queue(page).locator("[data-public-event]")).toHaveCount(40);
  await expect(page.getByLabel("T1 博客来源",{exact:true}).locator("option")).toHaveCount(3);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.forbidden).toEqual([]);
});

test("shared detail tabs support keyboard selection and label their content panel",async({page})=>{
  await fixture(page);
  await page.goto("/reading");
  await queue(page).locator("[data-public-event]").first().click();
  await expect(detail(page)).toContainText("第三条详细说明");
  const tabs=detail(page).getByRole("tablist",{name:"详情内容",exact:true});
  const summary=tabs.getByRole("tab",{name:"要点",exact:true}),source=tabs.getByRole("tab",{name:"已收录原文 / 来源内容",exact:true});
  await summary.focus();
  await page.keyboard.press("ArrowRight");
  await expect(source).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(source).toHaveAttribute("aria-selected","true");
  const panel=detail(page).getByRole("tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby",(await source.getAttribute("id"))!);
  await expect(panel).toContainText("这是已经收录的原始研究正文");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(summary).toHaveAttribute("aria-selected","true");
  await expect(panel).toContainText("第三条详细说明");
});
