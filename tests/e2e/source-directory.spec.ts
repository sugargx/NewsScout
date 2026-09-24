import {expect,test} from "@playwright/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {databaseQuery} from "./db";
import {watchStatus} from "../../apps/web/src/source-watchlist";
import type {Source,SourceWatch} from "../../apps/web/src/types";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:18080";
const directory: {id:string;originUrl:string;entries:{id:string;subscription?:{endpoint:string}|null}[]}=
  JSON.parse(readFileSync(join(process.cwd(),"services","api","src","source-directory-2026-09-10.json"),"utf8"));
test.beforeAll(()=>{
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true")throw new Error("Use the isolated E2E runner.");
});

test("source directory imports every entry, reuses original feeds and preserves edits across restart",async({request})=>{
  expect(databaseQuery("SELECT count(*) FROM _sqlx_migrations WHERE version=20 AND success")).toBe("1");
  expect(databaseQuery("SELECT position('feedback AS MATERIALIZED' in pg_get_functiondef('reader_recommendations_core(text,timestamptz)'::regprocedure))::text")).not.toBe("0");
  const response=await request.get(`${api}/api/v1/source-watchlist`);
  expect(response.ok(),await response.text()).toBe(true);
  const {items}:{items:SourceWatch[]}=await response.json();
  expect(items.filter(item=>item.originUrl===directory.originUrl).map(item=>item.id).sort())
    .toEqual(directory.entries.map(entry=>entry.id).sort());
  expect(directory.entries).toHaveLength(88);
  expect(items.filter(item=>item.id==="x-karpathy")).toHaveLength(1);
  expect(items.find(item=>item.id==="x-karpathy")?.status).toBe("needs_authorization");
  expect(items.find(item=>item.id==="x-tibo")?.status).toBe("needs_confirmation");
  const endpoints=[...new Set(directory.entries.flatMap(entry=>entry.subscription?[entry.subscription.endpoint]:[]))];
  const {items:sources}:{items:Source[]}=await(await request.get(`${api}/api/v1/sources`)).json();
  for(const endpoint of endpoints)expect(sources.filter(source=>source.endpoint===endpoint)).toHaveLength(1);
  for(const entry of directory.entries) {
    const watch=items.find(item=>item.id===entry.id)!;
    expect(watch.originBlock).toBeTruthy();
    const linked=entry.subscription?sources.find(source=>source.endpoint===entry.subscription!.endpoint):undefined;
    if(entry.subscription?.endpoint==="https://feed.xyzfm.space/r8t44lmvu99m") {
      expect(watch.sourceId).toBeNull();
      expect(watch.status).toBe("reference_only");
      expect(watch.note).toContain("AI 翻译");
      expect(linked?.lifecycleStatus).toBe("paused");
    }else expect(watch.sourceId??null).toBe(linked?.id??null);
  }
  expect(databaseQuery(`SELECT entry_count FROM source_directory_imports WHERE id='${directory.id}'`)).toBe("88");
  // Bind failure happens after migrations/import but before workers start; this exercises real repeat startup.
  const original=databaseQuery("SELECT note FROM source_watchlist WHERE id='x-karpathy'");
  try {
    databaseQuery("UPDATE source_watchlist SET note='E2E owner edit: preserve this note' WHERE id='x-karpathy'");
    const fingerprint=()=>databaseQuery(`SELECT md5(jsonb_build_object(
      'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sources s),
      'watchlist',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM source_watchlist w),
      'imports',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM source_directory_imports i))::text)`);
    const before=fingerprint();
    const result=spawnSync(join(process.cwd(),"services","api","target","debug","scoutnews-api.exe"),[],{
      cwd:process.cwd(),encoding:"utf8",timeout:25_000,
      env:{...process.env,DATABASE_URL:process.env.SCOUTNEWS_E2E_DATABASE_URL,SCOUTNEWS_BIND:"127.0.0.1:18080",
        SCOUTNEWS_DISABLE_COPILOT_RESTORE:"true",SCOUTNEWS_DEMO_MODE:"false",SCOUTNEWS_PUBLIC_ONLY:"false"},
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/10048|Address already in use|地址|套接字/);
    expect(fingerprint()).toBe(before);
  } finally {
    databaseQuery(`UPDATE source_watchlist SET note='${original.replaceAll("'","''")}' WHERE id='x-karpathy'`);
  }
});

test("source directory watch filters use real collection health and persist independently",async({page,request},info)=>{
  const {items}:{items:SourceWatch[]}=await(await request.get(`${api}/api/v1/source-watchlist`)).json();
  const {items:sources}:{items:Source[]}=await(await request.get(`${api}/api/v1/sources`)).json();
  const rows=items.map(item=>({item,status:watchStatus(item,sources.find(source=>source.id===item.sourceId))}));
  await page.goto("/sources?tab=watchlist&tier=T1");
  const region=page.getByRole("region",{name:"待接入名单",exact:true});
  const ids=()=>region.locator("[data-watch-id]").evaluateAll(elements=>elements.map(element=>element.getAttribute("data-watch-id")).sort());
  for(const platform of ["x","blog","podcast","weibo","reddit","bilibili","collection","community"]) {
    await page.getByLabel("关注平台",{exact:true}).selectOption(platform);
    await expect.poll(ids).toEqual(items.filter(item=>item.platform===platform).map(item=>item.id).sort());
  }
  await page.getByLabel("关注平台",{exact:true}).selectOption("x");
  await page.getByLabel("关注接入状态",{exact:true}).selectOption("needs_authorization");
  await page.getByLabel("搜索关注名单",{exact:true}).fill("karpathy");
  await expect.poll(ids).toEqual(["x-karpathy"]);
  await page.reload();
  await expect(page.getByLabel("关注平台",{exact:true})).toHaveValue("x");
  await expect(page.getByLabel("关注接入状态",{exact:true})).toHaveValue("needs_authorization");
  await expect.poll(ids).toEqual(["x-karpathy"]);
  await page.getByRole("tab",{name:/^已接入来源/}).click();
  await expect(page.getByLabel("来源等级",{exact:true})).toHaveValue("T1");
  await page.getByRole("tab",{name:/^关注名单/}).click();
  await expect.poll(ids).toEqual(["x-karpathy"]);
  await page.getByRole("button",{name:"清除关注筛选",exact:true}).click();
  await page.getByLabel("关注接入状态",{exact:true}).selectOption("registered");
  await expect.poll(ids).toEqual(rows.filter(row=>row.status==="registered").map(row=>row.item.id).sort());
  await page.getByRole("button",{name:"清除关注筛选",exact:true}).click();
  await page.getByLabel("关注平台",{exact:true}).selectOption("bilibili");
  await expect.poll(ids).toEqual(items.filter(item=>item.platform==="bilibili").map(item=>item.id).sort());
  await expect(region.locator("[data-watch-id]").filter({hasText:"微信公众号"})).toHaveCount(0);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`following-${width}.png`)});
  }
});

test("source directory linked feed status does not confuse registration with collection",()=>{
  const watch:SourceWatch={id:"watch",name:"Test author",platform:"blog",handle:null,profileUrl:null,
    note:"Test fixture",sourceId:"linked",status:"feed_linked"};
  const source:Source={id:"linked",name:"Test feed",publisher:"Test author",contentType:"blog",adapter:"rss",
    endpoint:"https://example.com/feed",tier:"T1.5",topics:[],scheduleMinutes:360,
    lifecycleStatus:"observing",consecutiveFailures:0,lastSuccessAt:null,lastError:null};
  expect(watchStatus(watch)).toBe("source_loading");
  expect(watchStatus(watch,source)).toBe("registered");
  expect(watchStatus(watch,{...source,lastSuccessAt:"2026-09-10T00:00:00Z"})).toBe("active");
  expect(watchStatus(watch,{...source,consecutiveFailures:1})).toBe("fetch_error");
  expect(watchStatus(watch,{...source,lifecycleStatus:"paused"})).toBe("paused");
  expect(watchStatus({...watch,sourceId:null})).toBe("needs_endpoint");
});

test("source directory large podcasts retain their adapter through the actual worker",async({request})=>{
  test.setTimeout(180_000);
  const {items:sources}:{items:Source[]}=await(await request.get(`${api}/api/v1/sources`)).json();
  const source=sources.find(item=>item.endpoint==="https://api.substack.com/feed/podcast/1084089.rss")!;
  expect(source.adapter).toBe("podcast_rss");
  const response=await request.post(`${api}/api/v1/sources/${source.id}/refresh`,{timeout:150_000});
  expect(response.ok(),await response.text()).toBe(true);
  const result=await response.json();
  expect(result.failed,JSON.stringify(result.errors)).toBe(0);
  expect(result.succeeded).toBe(1);
  expect(result.ingested).toBeGreaterThan(0);
  expect(result.ingested).toBeLessThanOrEqual(200);
});
