import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { startPublicReader } from "../../services/public-reader/server.cjs";
import type { Event } from "../../apps/web/src/types";
import { databaseQuery } from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL??"";
const literal=(value:unknown)=>`'${String(value).replaceAll("'","''")}'`;
const execute=promisify(execFile);
const preserved=()=>databaseQuery(`SELECT json_build_object(
  'snapshots',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM daily_brief_items t),
  'interests',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM interest_profiles t),
  'settings',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM app_settings t),
  'ownerStates',(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM user_event_states t))`);

test.beforeEach(()=>{
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true"||api!=="http://127.0.0.1:18080")
    throw new Error("Visitor database coverage requires the isolated live launcher.");
  databaseQuery("SELECT 1");
});

test("visitor SQL extension preserves the original owner ranker exactly",()=>{
  const source=readFileSync(resolve("services","api","migrations","0022_editorial_article_policy.sql"),"utf8");
  const start=source.indexOf("CREATE FUNCTION reader_editorial_recommendations(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end=source.indexOf("\n$$;",start);
  expect(end).toBeGreaterThan(start);
  const legacy=source.slice(start,end+4).replace("CREATE FUNCTION reader_editorial_recommendations(","CREATE FUNCTION visitor_legacy_ranker(");
  const before=preserved();
  databaseQuery(`BEGIN;
    ${legacy}
    DO $check$ BEGIN
      IF EXISTS(
        (SELECT * FROM visitor_legacy_ranker('local',now(),false) EXCEPT ALL SELECT * FROM reader_editorial_recommendations('local',now(),false))
        UNION ALL
        (SELECT * FROM reader_editorial_recommendations('local',now(),false) EXCEPT ALL SELECT * FROM visitor_legacy_ranker('local',now(),false))
      ) THEN RAISE EXCEPTION 'Owner recommendation behavior changed'; END IF;
    END $check$;
    ROLLBACK;`);
  expect(preserved()).toBe(before);
});

async function responseJson(request:APIRequestContext,path:string) {
  const response=await request.get(api+path);
  expect(response.status(),path).toBe(200);
  return response.json();
}

test("visitor SQL ranking isolates owner state and orders the complete corpus before grouped pagination",async({request})=>{
  test.setTimeout(240_000);
  const before=preserved(),tag=`visitor-${randomUUID()}`,source=randomUUID(),publisher=randomUUID();
  const fixtures=Array.from({length:130},(_,index)=>({
    id:randomUUID(),content:randomUUID(),index,
    title:index>=128?`Agent SDK v1.2.3 ${tag}`:`Original analysis: ${index<65?"agent tools and planning":"psychology and cognition"} ${tag} ${index}`,
    kind:index>=128?"release":"blog",
    url:index>=128?`https://github.com/${tag}/sdk/releases/tag/v1.2.3`:`https://${tag}.example/article/${index}`,
  }));
  const material={feedSummary:"Retained original analysis with implementation methods, reproducible experiments, dataset measurements and detailed limitations. ".repeat(12)};
  const ids=fixtures.map(item=>literal(item.id)).join(",");
  try {
    databaseQuery(`BEGIN;
      INSERT INTO publishers(id,name,entity_type) VALUES(${literal(publisher)},${literal(tag)},'publication');
      INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
        VALUES(${literal(source)},${literal(publisher)},${literal(tag)},${literal(`https://${tag}.example/feed`)},'blog','rss','T1','stable',now());
      INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at,
        summary_kind,summary_format_version,summary_points,summary_model,summary_reasoning_effort,content_version)
      VALUES ${fixtures.map(item=>`(${literal(item.id)},${literal(item.title)},'Isolated fixture, not news.','','',
        ${literal(item.kind)},now()-interval '6 hours',now()-interval '${item.index} seconds',
        'copilot',3,'["Isolated fixture, not news."]','gpt-5.6-terra','low',1)`).join(",")};
      INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,published_at,content_hash,metadata)
      VALUES ${fixtures.map(item=>`(${literal(item.content)},${literal(source)},${literal(item.kind)},${literal(item.url)},
        ${literal(item.url)},${literal(item.title)},now()-interval '6 hours',${literal(item.content)},${literal(JSON.stringify(material))}::jsonb)`).join(",")};
      INSERT INTO event_evidence(event_id,content_item_id,is_official)
        VALUES ${fixtures.map(item=>`(${literal(item.id)},${literal(item.content)},true)`).join(",")};
      INSERT INTO user_event_states(user_id,event_id,saved_at,read_at,later_at,opened_at,last_seen_at,seen_content_version,not_interested_at,not_interested_reason)
        VALUES('local',${literal(fixtures[65].id)},now(),now(),now(),now(),now(),1,now(),'topic');
      COMMIT;`);
    const asOf=new Date().toISOString();
    const read=(interests:string,limit=100,offset=0,sort="recommended",coverage=true)=>responseJson(request,"/api/v1/events?"+
      new URLSearchParams({q:tag,interests,asOf,sort,coverage:String(coverage),hours:"720",limit:String(limit),offset:String(offset)}));
    const profiles=["agents:100,psychology:0","agents:0,psychology:100"],orders:string[][]=[];
    for(const profile of profiles) {
      const first=await read(profile),tail=await read(profile,100,100);
      const whole:Event[]=[...first.items,...tail.items];
      expect(first.readerProfileApplied).toBe(true);
      expect(whole).toHaveLength(129);
      const firstPage=await read(profile,40),secondPage=await read(profile,40,40);
      const allIds=whole.map(item=>item.id);
      expect(firstPage.items.map((item:Event)=>item.id)).toEqual(allIds.slice(0,40));
      expect(secondPage.items.map((item:Event)=>item.id)).toEqual(allIds.slice(40,80));
      expect(whole.every(item=>!item.saved&&!item.read&&!item.later&&!item.opened&&!item.seen&&!item.notInterested)).toBe(true);
      expect(whole.every(item=>item.recommendation?.affinity===50&&item.recommendation.noveltyPenalty===0)).toBe(true);
      const hidden=whole.find(item=>item.id===fixtures[65].id)!;
      expect(hidden).toBeDefined();
      const detail=await responseJson(request,`/api/v1/events/${hidden.id}?${new URLSearchParams({interests:profile})}`);
      expect(detail).toMatchObject({readerProfileApplied:true,saved:false,read:false,later:false,opened:false,seen:false,notInterested:false});
      const graph=await responseJson(request,"/api/v1/explore?"+new URLSearchParams({q:tag,interests:profile,asOf,hours:"720"}));
      const sampled=await read(profile,100,0,"recommended",false);
      const counts=new Map<string,number>();
      for(const item of sampled.items as Event[])for(const facet of new Set(item.recommendation?.facets??item.topics))
        counts.set(facet,(counts.get(facet)??0)+1);
      expect(graph).toMatchObject({readerProfileApplied:true,sampleSize:100});
      expect(graph.nodes).toEqual([...counts].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,count])=>({id,count})));
      const brief=await responseJson(request,"/api/v1/briefs/latest?"+new URLSearchParams({interests:profile,asOf}));
      expect(brief).toMatchObject({readerProfileApplied:true,isSnapshot:false});
      expect(brief.items.every((item:Event)=>!item.notInterested&&!item.saved&&!item.read)).toBe(true);
      orders.push(allIds);
    }
    expect(orders[0].indexOf(fixtures[65].id)).toBeGreaterThanOrEqual(40);
    expect(orders[1].indexOf(fixtures[65].id)).toBeLessThan(40);
    for(const sort of ["newest","score"]) {
      const a=await read(profiles[0],40,0,sort),b=await read(profiles[1],40,0,sort);
      expect(a.items.map((item:Event)=>item.id)).toEqual(b.items.map((item:Event)=>item.id));
    }
    const owner=await responseJson(request,`/api/v1/events/${fixtures[65].id}`);
    expect(owner).toMatchObject({saved:true,read:true,later:true,opened:true,seen:true,notInterested:true});
    const boost=JSON.parse(databaseQuery(`SELECT to_jsonb(b.rank_score-a.rank_score)
      FROM reader_editorial_recommendations_for_profile(NULL,${literal(asOf)},false,ARRAY[${literal(fixtures[65].id)}::uuid],
        '[{"label":"心理与认知","enabled":true,"weight":0}]') a
      JOIN reader_editorial_recommendations_for_profile(NULL,${literal(asOf)},false,ARRAY[${literal(fixtures[65].id)}::uuid],
        '[{"label":"心理与认知","enabled":true,"weight":100}]') b USING(event_id)`));
    expect(boost).toBeCloseTo(20,4);
    for(const profile of ["agents:101","agents:80,agents:100","unknown:100"])
      expect((await request.get(api+"/api/v1/events?"+new URLSearchParams({interests:profile}))).status()).toBe(400);
  } finally {
    databaseQuery(`DELETE FROM user_event_states WHERE event_id IN(${ids});
      DELETE FROM event_evidence WHERE event_id IN(${ids});
      DELETE FROM events WHERE id IN(${ids});
      DELETE FROM content_items WHERE source_id=${literal(source)};
      DELETE FROM sources WHERE id=${literal(source)};
      DELETE FROM publishers WHERE id=${literal(publisher)};`);
    expect(preserved()).toBe(before);
  }
});

test("visitor retained-corpus visual release captures the genuine isolated public reader",async()=>{
  test.setTimeout(360_000);
  test.skip(process.env.SCOUTNEWS_E2E_CORPUS_BACKUP!=="true","A retained-corpus backup is required for visual evidence.");
  const before=preserved();
  const server=await startPublicReader({apiOrigin:api,distRoot:resolve("apps","web","dist"),port:0});
  try {
    const address=server.address();
    if(!address||typeof address==="string")throw new Error("Public gateway did not bind a loopback port.");
    const output=resolve("tmp","ui-reviews",`visitor-interests-candidate-${randomUUID()}`);
    const result=await execute(process.execPath,[resolve("scripts","capture-ui-review.cjs"),"--base-url",
      `http://127.0.0.1:${address.port}`,"--scope","interests","--output",output],{cwd:resolve("."),timeout:330_000});
    console.log(result.stdout.trim());
  } finally {
    await new Promise<void>((done,fail)=>{server.close((error?:Error)=>error?fail(error):done());server.closeAllConnections();});
    expect(preserved()).toBe(before);
  }
});
