import {expect,test,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {startPublicReader} from "../../services/public-reader/server.cjs";
import type {Event} from "../../apps/web/src/types";
import {databaseQuery} from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL??"";
const literal=(value:unknown)=>`'${String(value).replaceAll("'","''")}'`;
const preserved=()=>databaseQuery(`SELECT json_build_object(
  'snapshots',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM daily_brief_items t),
  'settings',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM app_settings t),
  'attempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))`);

test.beforeEach(()=>{
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true"||api!=="http://127.0.0.1:18080")
    throw new Error("Radar grouping requires the isolated live launcher.");
  databaseQuery("SELECT 1");
});

function seed() {
  const tag=`radar-fixture-${randomUUID()}`;
  const company=randomUUID(),author=randomUUID(),officialSource=randomUUID(),authorSource=randomUUID();
  const definitions=[
    {key:"launch",title:"Introducing Claude Haiku 5.5",url:"https://www.anthropic.com/claude-haiku-5-5",hours:23,type:"blog",official:true},
    {key:"analysis",title:"Claude Haiku 5.5",url:"https://simonwillison.net/2026/Oct/7/claude-haiku-5-5/",hours:3,type:"blog",official:false},
    {key:"python",title:"python-1.21.0",url:"https://github.com/microsoft/agent-framework/releases/tag/python-1.21.0",hours:1,type:"release",official:true,notes:"Python tool-result guidance (#8784)."},
    {key:"dotnet",title:"dotnet-1.24.0",url:"https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0",hours:22,type:"release",official:true,notes:".NET session state corrections (#9012, #9140)."},
    {key:"other-version",title:"Claude Haiku 4.5",url:"https://writer.example/claude-haiku-4-5",hours:4,type:"blog",official:false},
    {key:"use-case",title:"Using Claude Haiku 5.5 for financial services",url:"https://writer.example/financial-services",hours:5,type:"blog",official:false},
    {key:"comparison",title:"Claude Haiku 5.5 vs GPT-6 Luna",url:"https://writer.example/comparison",hours:6,type:"blog",official:false},
    {key:"fork",title:"dotnet-1.24.0",url:"https://github.com/another-owner/agent-framework/releases/tag/dotnet-1.24.0",hours:7,type:"release",official:true,notes:"Independent fork change (#9500)."},
    {key:"previous-python",title:"python-1.20.0",url:"https://github.com/microsoft/agent-framework/releases/tag/python-1.20.0",hours:27,type:"release",official:true,notes:"Previous Python change (#8600)."},
  ];
  const fixtures=definitions.map(item=>({...item,id:randomUUID(),content:randomUUID(),
    source:item.official?officialSource:authorSource}));
  databaseQuery(`BEGIN;
    INSERT INTO publishers(id,name,entity_type) VALUES
      (${literal(company)},${literal(`${tag} official`)},'company'),
      (${literal(author)},${literal(`${tag} author`)},'author');
    INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
    VALUES (${literal(officialSource)},${literal(company)},${literal(`${tag} official`)},
        ${literal(`https://${tag}.example/official`)},'blog','rss','T1','stable',now()),
      (${literal(authorSource)},${literal(author)},${literal(`${tag} author`)},
        ${literal(`https://${tag}.example/author`)},'blog','rss','T2','stable',now());
    INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,
      first_seen_at,updated_at,summary_kind,summary_format_version,summary_points,summary_model,content_version)
    VALUES ${fixtures.map(item=>`(${literal(item.id)},${literal(item.title)},
      ${literal(`Isolated grouping fixture, not newly collected news. ${tag}`)},
      'Isolated fixture','模型与多模态',${literal(item.type)},now()-interval '${item.hours} hours',
      now()-interval '${item.hours} hours','copilot',3,'["Isolated fixture summary."]','isolated-fixture',1)`).join(",")};
    INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,published_at,content_hash,metadata)
    VALUES ${fixtures.map(item=>`(${literal(item.content)},${literal(item.source)},${literal(item.type)},
      ${literal(item.url)},${literal(item.url)},${literal(item.title)},now()-interval '${item.hours} hours',
      ${literal(item.content)},${literal(JSON.stringify({
        feedSummary:item.notes??"Isolated original material about the named model version; not generated news.",
        sourceMetadata:{datePrecision:item.key==="launch"?"day":"time"},
      }))}::jsonb)`).join(",")};
    INSERT INTO event_evidence(event_id,content_item_id,is_official)
      VALUES ${fixtures.map(item=>`(${literal(item.id)},${literal(item.content)},true)`).join(",")};
    COMMIT;`);
  const ids=fixtures.map(item=>literal(item.id)).join(",");
  return {tag,fixtures,officialSource,authorSource,cleanup:()=>{
    databaseQuery(`DELETE FROM user_event_states WHERE event_id IN(${ids});
      DELETE FROM event_evidence WHERE event_id IN(${ids});
      DELETE FROM events WHERE id IN(${ids});
      DELETE FROM content_items WHERE source_id IN(${literal(officialSource)},${literal(authorSource)});
      DELETE FROM sources WHERE id IN(${literal(officialSource)},${literal(authorSource)});
      DELETE FROM publishers WHERE id IN(${literal(company)},${literal(author)});`);
  }};
}

type EventPage={items:Event[];nextOffset:number|null;returnedEventCount:number};

async function events(request:APIRequestContext,parameters:Record<string,string>,origin=api,path="/api/v1/events") {
  const response=await request.get(`${origin}${path}?${new URLSearchParams(parameters)}`);
  expect(response.ok(),await response.text()).toBe(true);
  return await response.json() as EventPage;
}

async function detail(request:APIRequestContext,id:string) {
  const response=await request.get(`${api}/api/v1/events/${id}`);
  expect(response.ok(),await response.text()).toBe(true);
  return await response.json() as Event;
}

const members=(event:Event)=>event.coverage?.members.map(member=>member.eventId)??[event.id];

test.use({actionTimeout:15_000});

test("radar grouping joins launch commentary and language releases across database, filters and detail",async({request,page},info)=>{
  test.setTimeout(240_000);
  const before=preserved(),fixture=seed();
  const byKey=new Map(fixture.fixtures.map(item=>[item.key,item]));
  const launch=byKey.get("launch")!,analysis=byKey.get("analysis")!,python=byKey.get("python")!,dotnet=byKey.get("dotnet")!;
  const parameters={q:fixture.tag,hours:"0",sort:"newest",asOf:new Date().toISOString(),limit:"100",includeEngineering:"true"};
  try {
    const originals=await events(request,parameters);
    expect(originals.items).toHaveLength(9);
    const grouped=await events(request,{...parameters,coverage:"true"});
    expect(grouped.items).toHaveLength(7);
    expect(grouped.returnedEventCount).toBe(9);
    expect(grouped.items.flatMap(members).sort()).toEqual(originals.items.map(item=>item.id).sort());
    const announcement=grouped.items.find(item=>members(item).includes(launch.id))!;
    const releases=grouped.items.find(item=>members(item).includes(python.id))!;
    expect(announcement.coverage?.method).toBe("official-announcement-v1");
    expect(announcement.coverage?.topic).toBe("Introducing Claude Haiku 5.5");
    expect(members(announcement).sort()).toEqual([launch.id,analysis.id].sort());
    expect(announcement.coverage?.officialSourceCount).toBe(1);
    expect(announcement.coverage?.editorialSourceCount).toBe(1);
    expect(releases.coverage?.method).toBe("project-release-window-v1");
    expect(releases.coverage?.topic).toBe("agent-framework 多语言更新：Python 1.21.0 / .NET 1.24.0");
    expect(members(releases).sort()).toEqual([python.id,dotnet.id].sort());
    expect(releases.coverage?.officialSourceCount).toBe(1);
    expect(releases.coverage?.popularityBoost).toBe(0);
    for(const result of grouped.items.filter(item=>item.coverage)) {
      for(const member of result.coverage!.members) {
        const original=originals.items.find(item=>item.id===member.eventId)!;
        expect(member.title).toBe(original.title);
        expect(member.summary).toBe(original.summary);
        expect(member.publishedAt).toBe(original.publishedAt);
        expect(member.publicationPrecision).toBe(original.publicationPrecision);
        expect(member.evidence.map(item=>item.id)).toEqual(original.evidence.map(item=>item.id));
      }
    }
    const paged:string[]=[];
    for(let offset=0;;offset++) {
      const result=await events(request,{...parameters,coverage:"true",limit:"1",offset:String(offset)});
      paged.push(...result.items.map(item=>item.id));
      if(result.nextOffset===null)break;
      expect(result.nextOffset).toBe(offset+1);
      expect(offset).toBeLessThan(9);
    }
    expect(paged).toEqual(grouped.items.map(item=>item.id));
    const recommended=await events(request,{...parameters,coverage:"true",sort:"recommended"});
    expect(recommended.items.filter(item=>item.coverage).map(item=>item.coverage!.key).sort())
      .toEqual(grouped.items.filter(item=>item.coverage).map(item=>item.coverage!.key).sort());
    const authorOnly=await events(request,{...parameters,coverage:"true",source:fixture.authorSource});
    expect(authorOnly.items.every(item=>!item.coverage)).toBe(true);
    const pythonOnly=await events(request,{...parameters,coverage:"true",q:"python-1.21.0"});
    expect(pythonOnly.items).toHaveLength(1);
    expect(pythonOnly.items[0].coverage).toBeUndefined();
    for(const [id,expected] of [[launch.id,[launch.id,analysis.id]],[analysis.id,[launch.id,analysis.id]],
      [python.id,[python.id,dotnet.id]],[dotnet.id,[python.id,dotnet.id]]] as const) {
      const result=await detail(request,id);
      expect(members(result).sort()).toEqual([...expected].sort());
      expect(result.coverage!.members.find(member=>member.eventId===id)?.matchesFilters).toBe(true);
    }

    await page.goto(`/radar?q=${encodeURIComponent(fixture.tag)}&hours=0&sort=newest&includeEngineering=true`);
    await expect(page.locator("article[data-event-id]")).toHaveCount(7);
    const announcementRow=page.locator(`article[data-event-id="${announcement.id}"]`);
    const releaseRow=page.locator(`article[data-event-id="${releases.id}"]`);
    await expect(announcementRow.getByRole("heading",{name:announcement.coverage!.topic,exact:true})).toBeVisible();
    await announcementRow.locator(".cp-coverage > summary").click();
    await expect(announcementRow.locator("[data-coverage-member]")).toHaveCount(2);
    await releaseRow.locator(".cp-coverage > summary").click();
    await expect(releaseRow.getByRole("heading",{name:"Python · 1.21.0",exact:true})).toBeVisible();
    await expect(releaseRow.getByRole("heading",{name:".NET · 1.24.0",exact:true})).toBeVisible();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1100});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:info.outputPath(`synthetic-radar-groups-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1100});
    await announcementRow.locator(`[data-coverage-member="${analysis.id}"]`).getByRole("button",{name:analysis.title,exact:true}).click();
    const reader=page.getByRole("article",{name:"文章就地阅读",exact:true});
    await expect(reader.getByRole("heading",{name:analysis.title,exact:true})).toBeVisible();
    await expect(reader.getByText("已打开",{exact:true})).toBeVisible();
    await reader.getByRole("button",{name:`不感兴趣：${analysis.title}`,exact:true}).click();
    await expect(announcementRow.locator(`[data-coverage-member="${analysis.id}"]`)).toHaveCount(0);
    await expect(announcementRow).toBeVisible();
    await expect(announcementRow.locator(`[data-coverage-member="${launch.id}"]`)).toBeVisible();
    await expect.poll(async()=>(await detail(request,analysis.id)).notInterested).toBe(true);
    const hiddenDetail=await detail(request,launch.id);
    expect(hiddenDetail.coverage).toBeUndefined();

    const server=await startPublicReader({apiOrigin:api,distRoot:resolve("apps","web","dist"),port:0});
    try {
      const address=server.address();
      if(!address||typeof address==="string")throw new Error("Public reader failed to bind.");
      const publicPage=await events(request,{...parameters,limit:"40",interests:"agents:100"},`http://127.0.0.1:${address.port}`,"/beta/api/events");
      expect(publicPage.items.flatMap(members).sort()).toEqual(originals.items.map(item=>item.id).sort());
      expect(publicPage.items.filter(item=>item.coverage).map(item=>item.coverage!.method).sort())
        .toEqual(["official-announcement-v1","project-release-window-v1"]);
    } finally {
      await new Promise<void>((done,reject)=>{
        server.close((error?:Error)=>error?reject(error):done());
        server.closeAllConnections();
      });
    }
    await reader.getByRole("button",{name:`撤销不感兴趣：${analysis.title}`,exact:true}).click();
    await expect(announcementRow.locator(`[data-coverage-member="${analysis.id}"]`)).toBeVisible();
    await expect.poll(async()=>(await detail(request,analysis.id)).notInterested).toBe(false);
  } finally {
    try {
      if(!page.isClosed())await page.goto("about:blank");
    } finally {
      fixture.cleanup();
      expect(preserved()).toBe(before);
    }
  }
});
