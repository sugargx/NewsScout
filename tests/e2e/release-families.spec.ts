import {expect,test,type APIRequestContext,type Page} from "@playwright/test";
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
  'interests',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM interest_profiles t),
  'summaryAttempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))`);

test.beforeEach(()=>{
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true"||api!=="http://127.0.0.1:18080")
    throw new Error("Release-family coverage requires the isolated live launcher.");
  databaseQuery("SELECT 1");
});

async function events(request:APIRequestContext,parameters:Record<string,string>) {
  const response=await request.get(`${api}/api/v1/events?${new URLSearchParams(parameters)}`);
  expect(response.ok(),await response.text()).toBe(true);
  return await response.json() as {items:Event[];nextOffset:number|null;returnedEventCount:number};
}

async function publicReader() {
  const server=await startPublicReader({apiOrigin:api,distRoot:resolve("apps","web","dist"),port:0});
  const address=server.address();
  if(!address||typeof address==="string")throw new Error("Public reader did not bind a loopback port.");
  return {server,origin:`http://127.0.0.1:${address.port}`};
}

async function closeReader(server:Awaited<ReturnType<typeof publicReader>>["server"],page:Page) {
  await page.goto("about:blank");
  await new Promise<void>((done,reject)=>{
    server.close((error?:Error)=>error?reject(error):done());
    server.closeAllConnections();
  });
}

test("component release groups preserve filters, pagination, versions and independent feedback",async({page,request},info)=>{
  test.setTimeout(240_000);
  const before=preserved(),tag=`release-fixture-${randomUUID()}`,source=randomUUID();
  const definitions=[
    ["Mem0 OpenClaw Plugin (v1.2.0)","openclaw-v1.2.0","Config: keyFingerprint deduplicates installs. #7325 Telemetry: Correct events. (#7323, #7324, #7358)"],
    ["Mem0 OpenCode Plugin (v0.4.0)","opencode-v0.4.0","Telemetry: Change source tag. #7322 Config: keyFingerprint deduplicates installs. #7325"],
    ["Mem0 Pi Agent Plugin (v0.3.1)","pi-agent-v0.3.1","Telemetry: Correct event delivery. (#7323, #7324, #7358)"],
    ["Mem0 DeepSeek Plugin (v0.3.1)","deepseek-plugin-v0.3.1","Telemetry: Correct event delivery. (#7323, #7324, #7358)"],
    ["Mem0 Node CLI (v0.2.14)","cli-node-v0.2.14","Client: Forward surface-identity headers. #7326"],
    ["Mem0 Python CLI (v0.2.13)","cli-v0.2.13","Client: Forward surface-identity headers. #7326"],
    ["Mem0 Node SDK (v3.2.0)","ts-v3.2.0","Client: Carry X-Mem0-Source and X-Mem0-Client. #7326"],
    ["Mem0 Python SDK (v2.1.0)","v2.1.0","Client: Carry surface-identity headers. #7326"],
    ["Vercel AI SDK Provider (v3.0.3)","vercel-ai-v3.0.3","Client: Inherit surface-identity headers. #7326"],
  ];
  const fixtures=definitions.map(([title,release,excerpt],index)=>({
    id:randomUUID(),content:randomUUID(),title,index,excerpt,
    url:`https://github.com/mem0ai/mem0/releases/tag/${release}`,
  }));
  const ids=fixtures.map(item=>literal(item.id)).join(",");
  try {
    databaseQuery(`BEGIN;
      INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
        SELECT ${literal(source)},publisher_id,${literal(tag)},${literal(`https://${tag}.example/feed`)},
          'release','rss','T1','stable',now() FROM sources WHERE id='20000000-0000-0000-0000-000000000110';
      INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at,
        summary_kind,summary_format_version,summary_points,summary_model,content_version)
      VALUES ${fixtures.map(item=>`(${literal(item.id)},${literal(item.title)},
        ${literal(`隔离分组样本，并非新采集新闻。${tag}`)},'隔离样本','记忆与检索','release',
        now()-interval '4 hours',now()-interval '4 hours','copilot',3,
        '["隔离分组样本，并非真实摘要。"]','isolated-fixture',1)`).join(",")};
      INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,published_at,content_hash,metadata)
      VALUES ${fixtures.map(item=>`(${literal(item.content)},${literal(source)},'release',${literal(item.url)},
        ${literal(item.url)},${literal(item.title)},now()-interval '4 hours'-interval '${item.index} minutes',
        ${literal(item.content)},${literal(JSON.stringify({feedSummary:item.excerpt}))}::jsonb)`).join(",")};
      INSERT INTO event_evidence(event_id,content_item_id,is_official)
        VALUES ${fixtures.map(item=>`(${literal(item.id)},${literal(item.content)},true)`).join(",")};
      COMMIT;`);
    const parameters={q:tag,source,hours:"24",sort:"newest",asOf:new Date().toISOString(),limit:"40"};
    const original=await events(request,parameters);
    const grouped=await events(request,{...parameters,coverage:"true"});
    expect(original.items).toHaveLength(9);
    expect(grouped.items).toHaveLength(3);
    expect(grouped.items.map(item=>item.coverage?.topic)).toEqual([
      "Mem0 插件更新：安装统计","Mem0 插件更新：遥测","Mem0 客户端更新：调用来源标识",
    ]);
    const byId=new Map(original.items.map(item=>[item.id,item]));
    const represented:string[]=[];
    for(const item of grouped.items) {
      const bundle=item.coverage!;
      expect(bundle.method).toBe("release-family-v2");
      expect(bundle.officialSourceCount).toBe(1);
      expect(bundle.popularityBoost).toBe(0);
      expect(bundle.windowHours).toBe(24);
      for(const member of bundle.members) {
        represented.push(member.eventId);
        expect(member.matchesFilters).toBe(true);
        expect(member.summary).toBe(byId.get(member.eventId)!.summary);
        expect(member.publishedAt).toBe(byId.get(member.eventId)!.publishedAt);
        expect(member.title).toBe(byId.get(member.eventId)!.title);
      }
    }
    expect(represented.sort()).toEqual(original.items.map(item=>item.id).sort());
    expect(grouped.items[2].coverage!.members.map(member=>member.releaseTarget).sort()).toEqual([
      "Node CLI","Node SDK","Python CLI","Python SDK","Vercel AI SDK Provider",
    ]);
    const first=await events(request,{...parameters,coverage:"true",limit:"2"});
    const second=await events(request,{...parameters,coverage:"true",limit:"2",offset:"2"});
    expect([...first.items,...second.items].map(item=>item.id)).toEqual(grouped.items.map(item=>item.id));
    const filtered=await events(request,{...parameters,q:"Mem0 Node CLI",coverage:"true"});
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].coverage).toBeUndefined();

    const client=grouped.items[2],member=client.coverage!.members[0];
    await page.goto(`/radar?q=${encodeURIComponent(tag)}&hours=24&sort=newest`);
    const row=page.locator(`article[data-event-id="${client.id}"]`);
    await expect(row.getByRole("heading",{level:2,name:client.coverage!.topic,exact:true})).toBeVisible();
    await row.locator(".cp-release-family > summary").click();
    await expect(row.locator("[data-coverage-member]")).toHaveCount(5);
    await row.locator(`[data-coverage-member="${member.eventId}"]`).getByRole("button",{name:"查看详情",exact:true}).click();
    const preview=page.getByRole("article",{name:"文章就地阅读",exact:true});
    await expect(preview.getByRole("heading",{level:2,name:member.title,exact:true})).toBeVisible();
    await preview.getByRole("button",{name:`不感兴趣：${member.title}`,exact:true}).click();
    await expect(row.locator("[data-coverage-member]")).toHaveCount(4);
    await preview.getByRole("button",{name:`撤销不感兴趣：${member.title}`,exact:true}).click();
    await expect(row.locator("[data-coverage-member]")).toHaveCount(5);
    await preview.getByRole("button",{name:"关闭阅读面板",exact:true}).click();
    await page.screenshot({path:info.outputPath("synthetic-component-groups-private-1440.png"),fullPage:true});

    const {server,origin}=await publicReader();
    try {
      const publicResponse=await request.get(`${origin}/beta/api/events?${new URLSearchParams({
        q:tag,hours:"24",sort:"newest",limit:"40",asOf:parameters.asOf,interests:"memory:100",
      })}`);
      expect(publicResponse.ok(),await publicResponse.text()).toBe(true);
      const publicItems:Event[]=(await publicResponse.json()).items;
      expect(publicItems.map(item=>item.coverage?.topic)).toEqual(grouped.items.map(item=>item.coverage?.topic));
      await page.goto(`${origin}/?tab=radar&q=${encodeURIComponent(tag)}&hours=24&sort=newest`);
      const publicRow=page.locator(`[data-public-event="${client.id}"]`);
      await expect(publicRow).toBeVisible();
      await publicRow.locator(".cp-release-family > summary").click();
      await publicRow.locator(`[data-coverage-member="${member.eventId}"]`).getByRole("button",{name:"查看详情",exact:true}).click();
      const reader=page.getByRole("complementary",{name:"公开文章阅读区",exact:true});
      await expect(reader.getByRole("heading",{level:2,name:member.title,exact:true})).toBeVisible();
      await reader.getByRole("button",{name:"不感兴趣",exact:true}).click();
      await expect(publicRow.locator("[data-coverage-member]")).toHaveCount(4);
      await page.getByRole("button",{name:"撤销不感兴趣",exact:true}).click();
      await expect(publicRow.locator("[data-coverage-member]")).toHaveCount(5);
      const owner=await(await request.get(`${api}/api/v1/events/${member.eventId}`)).json();
      expect(owner.notInterested).toBe(false);
    } finally {
      await closeReader(server,page);
    }
  } finally {
    await page.goto("about:blank");
    databaseQuery(`DELETE FROM user_event_states WHERE event_id IN(${ids});
      DELETE FROM event_evidence WHERE event_id IN(${ids});
      DELETE FROM events WHERE id IN(${ids});
      DELETE FROM content_items WHERE source_id=${literal(source)};
      DELETE FROM sources WHERE id=${literal(source)};`);
    expect(preserved()).toBe(before);
  }
});

test("component release groups retained-corpus screenshots preserve real release notes",async({page,request},info)=>{
  test.setTimeout(240_000);
  test.skip(process.env.SCOUTNEWS_E2E_CORPUS_BACKUP!=="true","A retained-corpus backup is required.");
  const before=preserved();
  const result=await events(request,{
    source:"20000000-0000-0000-0000-000000000110",hours:"0",sort:"newest",
    coverage:"true",limit:"100",asOf:new Date().toISOString(),
  });
  const client=result.items.find(item=>item.coverage?.members.some(member=>
    member.releaseTarget==="Node CLI"&&member.releaseVersion==="v0.2.14"));
  expect(client,"The retained September 18 releases must be present.").toBeDefined();
  expect(client!.coverage!.members).toHaveLength(5);
  expect(client!.coverage!.topic).toBe("Mem0 客户端更新：调用来源标识");
  const {server,origin}=await publicReader();
  try {
    await page.goto(`${origin}/?tab=radar&q=Mem0&hours=72&sort=newest`);
    await expect(page.getByRole("heading",{name:"Mem0 客户端更新：调用来源标识",exact:true})).toBeVisible();
    for(const view of ["紧凑列表","摘要卡片"]) {
      await page.getByRole("tab",{name:view,exact:true}).click();
      const row=page.locator(`[data-public-event="${client!.id}"]`);
      await expect(row).toBeVisible();
      const disclosure=row.locator(".cp-release-family");
      if(!await disclosure.evaluate(element=>element.hasAttribute("open")))await disclosure.locator(":scope > summary").click();
      await expect(disclosure.locator("[data-coverage-member]")).toHaveCount(5);
      for(const width of [1440,1024,768,390]) {
        await page.setViewportSize({width,height:1050});
        await row.scrollIntoViewIfNeeded();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
        await page.screenshot({path:info.outputPath(`retained-components-${view==="紧凑列表"?"compact":"cards"}-${width}.png`),fullPage:true});
        if(width===390) {
          const lastAction=disclosure.locator("[data-coverage-member]").last()
            .getByRole("button",{name:"查看详情",exact:true});
          await lastAction.click({trial:true});
        }
      }
    }
  } finally {
    await closeReader(server,page);
    expect(preserved()).toBe(before);
  }
});
