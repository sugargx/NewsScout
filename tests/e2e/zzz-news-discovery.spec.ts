import {expect,test} from "@playwright/test";
import {readFileSync} from "node:fs";
import {databaseQuery} from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";
test("direct reader and daily share use real publishers and export a local share image",async({request,page},info)=>{
  test.setTimeout(300_000);
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true")throw new Error("Use isolated E2E.");
  const {items:sources}=await (await request.get(`${api}/api/v1/sources`)).json();
  expect(sources.some((source:{adapter:string})=>source.adapter==="aihot_public")).toBe(false);
  for(const suffix of ["201","301","304"]) {
    const id=`20000000-0000-0000-0000-000000000${suffix}`;
    const response=await request.post(`${api}/api/v1/sources/${id}/refresh`,{timeout:90_000});
    expect(response.ok(),await response.text()).toBe(true);
    expect((await response.json()).succeeded).toBe(1);
    expect(Number(databaseQuery(`SELECT count(*) FROM content_items WHERE source_id='${id}'`))).toBeGreaterThan(0);
  }
  for(const endpoint of ["https://aihot.virxact.com/api/v1/items","https://aihot.news/rss","https://barretlee.github.io/agent-pulse/signals/"]) {
    const rejected=await request.post(`${api}/api/v1/sources`,{data:{name:"Rejected aggregate",endpoint,adapter:"rss",contentType:"blog",tier:"T2",scheduleMinutes:180}});
    expect(rejected.status()).toBe(400);
  }
  const watchlist=await (await request.get(`${api}/api/v1/source-watchlist`)).json();
  expect(watchlist.items.find((item:{id:string})=>item.id==="x-karpathy").status).toBe("needs_authorization");
  expect(watchlist.items.find((item:{id:string})=>item.id==="x-tibo").status).toBe("needs_confirmation");
  await page.goto("/sources");
  await page.getByLabel("来源等级",{exact:true}).selectOption("T1");
  await page.getByLabel("搜索来源",{exact:true}).fill("新智元");
  await expect(page.getByText("没有匹配的来源。可清除搜索或筛选条件。",{exact:true})).toBeVisible();
  await page.getByLabel("来源等级",{exact:true}).selectOption("T2");
  await expect(page.getByRole("region",{name:"新智元 · 官网 RSS",exact:true})).toBeVisible();
  const t1=await (await request.get(`${api}/api/v1/events?tier=T1&kind=blog&hours=720&sort=newest&limit=100`)).json();
  expect(t1.items.length).toBeGreaterThan(0);
  expect(t1.items.every((event:{evidence:{sourceTier:string}[]})=>event.evidence.some(source=>source.sourceTier==="T1"))).toBe(true);
  const crossed=await (await request.get(`${api}/api/v1/events?tier=T1&source=20000000-0000-0000-0000-000000000304`)).json();
  expect(crossed.items).toEqual([]);
  const event=t1.items[0];
  expect(event.evidence.every((item:{aggregation?:unknown})=>!item.aggregation)).toBe(true);

  // Replay legacy provenance using real publisher material, then roll back all fixture changes.
  const migration=readFileSync("services\\api\\migrations\\0013_direct_publisher_sources.sql","utf8");
  const snapshot=JSON.stringify(event).replaceAll("'","''");
  databaseQuery(`BEGIN;
    CREATE TEMP TABLE original_material AS SELECT ci.* FROM content_items ci JOIN event_evidence ee ON ee.content_item_id=ci.id WHERE ee.event_id='${event.id}' LIMIT 1;
    CREATE TEMP TABLE original_event AS SELECT * FROM events WHERE id='${event.id}';
    INSERT INTO sources(id,name,endpoint,content_type,adapter_type,tier) VALUES
      ('20000000-0000-0000-0000-000000000202','AIHOT legacy provenance fixture','https://aihot.virxact.com/api/v1/items','blog','aihot_public','T2');
    INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,published_at,content_hash,metadata)
      SELECT ('90000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'20000000-0000-0000-0000-000000000202',
      content_type,original_url,canonical_url,title,published_at,n::text,metadata||'{"aggregation":{"name":"AIHOT","url":"https://aihot.news/","originalSource":"legacy fixture"}}'
      FROM original_material CROSS JOIN generate_series(1,3)n;
    INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at)
      SELECT ('91000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at
      FROM original_event CROSS JOIN generate_series(1,3)n;
    INSERT INTO event_evidence(event_id,content_item_id)
      SELECT ('91000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,('90000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3)n;
    INSERT INTO event_evidence(event_id,content_item_id,is_official) SELECT '91000000-0000-0000-0000-000000000003',id,true FROM original_material;
    INSERT INTO user_event_states(user_id,event_id,saved_at) VALUES('local','91000000-0000-0000-0000-000000000002',now());
    INSERT INTO admin_audits(id,actor,action,target_type,target_id,reason) VALUES
      ('92000000-0000-0000-0000-000000000001','local','summarize_attempt','event','91000000-0000-0000-0000-000000000001','Actual historical attempt fixture');
    INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version) VALUES
      ('93000000-0000-0000-0000-000000000001','2000-01-01','published',now(),now(),'legacy-isolation');
    INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
      VALUES('93000000-0000-0000-0000-000000000001','${event.id}',1,'main','original publisher archive','${snapshot}'::jsonb);
    ${migration}
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM events WHERE id='91000000-0000-0000-0000-000000000001') THEN RAISE EXCEPTION 'aggregate-only event not removed'; END IF;
      IF NOT EXISTS(SELECT 1 FROM events e JOIN user_event_states s ON s.event_id=e.id WHERE e.id='91000000-0000-0000-0000-000000000002' AND e.status='withdrawn' AND s.saved_at IS NOT NULL AND e.summary='') THEN RAISE EXCEPTION 'saved state lost'; END IF;
      IF NOT EXISTS(SELECT 1 FROM events WHERE id='91000000-0000-0000-0000-000000000003' AND summary_kind='feed' AND content_version=1) THEN RAISE EXCEPTION 'mixed event not regenerated'; END IF;
      IF NOT EXISTS(SELECT 1 FROM summary_jobs WHERE event_id='91000000-0000-0000-0000-000000000003' AND status='pending' AND content_version=1) THEN RAISE EXCEPTION 'mixed summary not queued'; END IF;
      IF (SELECT count(*) FROM event_evidence WHERE event_id='91000000-0000-0000-0000-000000000003')<>1 THEN RAISE EXCEPTION 'direct evidence lost'; END IF;
      IF NOT EXISTS(SELECT 1 FROM admin_audits WHERE id='92000000-0000-0000-0000-000000000001' AND action='summarize_attempt') THEN RAISE EXCEPTION 'attempt accounting lost'; END IF;
      IF NOT EXISTS(SELECT 1 FROM daily_brief_items WHERE brief_id='93000000-0000-0000-0000-000000000001' AND snapshot='${snapshot}'::jsonb) THEN RAISE EXCEPTION 'archive rewritten'; END IF;
    END $$; ROLLBACK;`);

  await page.goto("/reading");
  await page.getByLabel("阅读内容",{exact:true}).selectOption("all");
  await page.getByRole("complementary",{name:"选择文章开始深读"}).getByRole("button",{name:"从第 1 篇开始",exact:true}).click();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toBeVisible();
  await expect.poll(async()=>databaseQuery(`SELECT (opened_at IS NOT NULL)::int FROM user_event_states WHERE user_id='local' AND event_id='${event.id}'`)).toBe("1");
  const opened=await (await request.get(`${api}/api/v1/events?tier=T1&opened=true&limit=100`)).json();
  expect(opened.items.some((item:{id:string})=>item.id===event.id)).toBe(true);
  if(t1.items.length>1) {
    await page.getByRole("button",{name:"下一篇",exact:true}).click();
    await expect(page.getByRole("article",{name:"文章就地阅读"}).getByRole("heading",{name:t1.items[1].displayTitle?.trim()||t1.items[1].title,exact:true})).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/reading\\?reader=${t1.items[1].id}$`));
  }
  await page.goto("/shares");
  await expect(page).toHaveURL(/\/share$/);
  await expect(page.getByRole("heading",{name:"今日分享",level:1})).toBeVisible();
  // A single story copies as plain text; sharing no longer creates server-side drafts.
  const drafts=databaseQuery("SELECT count(*) FROM reader_shares");
  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  await page.goto(`/events/${event.id}`);
  await page.getByRole("button",{name:"复制分享文字",exact:true}).click();
  await expect(page.getByRole("button",{name:"已复制分享文字",exact:true})).toBeVisible();
  const copied=(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,"\n");
  expect(copied.split("\n")[0]).toBe(event.displayTitle?.trim()||event.title);
  expect(copied).toMatch(/\n原文：https?:\/\/\S+$/);
  expect(databaseQuery("SELECT count(*) FROM reader_shares")).toBe(drafts);

  // Only completion provenance is synthetic; all titles and text remain real fetched publisher material.
  // Mistral publishes irregularly, so the fresher real Chinese publishers keep the 7-day window non-empty.
  databaseQuery(`UPDATE events SET summary_kind='copilot',summary_format_version=2 WHERE id IN(
    SELECT ee.event_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
    WHERE ci.source_id IN('20000000-0000-0000-0000-000000000201','20000000-0000-0000-0000-000000000301','20000000-0000-0000-0000-000000000304')
      AND ci.published_at>=now()-interval '7 days' AND ci.published_at<=now())`);
  const week=await (await request.get(`${api}/api/v1/weekly`)).json();expect(week.items.length).toBeGreaterThan(0);
  // The legacy share API keeps creating private drafts for existing integrations.
  for(const kind of ["week","brief"]) {
    const response=await request.post(`${api}/api/v1/shares`,{data:{kind,date:"latest"}});
    expect(response.ok(),await response.text()).toBe(true);
    expect((await response.json()).document.kind).toBe(kind);
  }
  const brief=await (await request.get(`${api}/api/v1/briefs/latest`)).json();
  const visible=brief.items.filter((item:{notInterested?:boolean})=>!item.notInterested);
  expect(visible.length).toBeGreaterThan(0);
  // 补读 (catch-up) items are offered separately and never picked by default.
  const earlier=new Set((brief.sections??[]).filter((section:{kind:string})=>section.kind==="catch_up").flatMap((section:{eventIds:string[]})=>section.eventIds));
  const count=Math.min(10,visible.filter((item:{id:string})=>!earlier.has(item.id)).length);
  expect(count).toBeGreaterThan(0);
  // Only today's current edition is called "今日"; an earlier or still-held one is named by its date.
  const [,month,dayOfMonth]=String(brief.localDate).split("-").map(Number);
  const day=!brief.refreshPending&&brief.localDate===new Date(Date.now()+8*3_600_000).toISOString().slice(0,10)?"今日":`${month}月${dayOfMonth}日`;
  await page.goto("/share");
  await expect(page.getByText(`已选 ${count} / 最多 15 条`,{exact:true})).toBeVisible();
  const preview=page.getByRole("img",{name:`分享图预览：${day}值得分享的 ${count} 条新闻`,exact:true});
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(1080);
  const [download]=await Promise.all([page.waitForEvent("download"),page.getByRole("button",{name:"下载分享图",exact:true}).click()]);
  expect(download.suggestedFilename()).toBe(`NewsScout-今日分享-${brief.localDate}.png`);
  const image=readFileSync((await download.path())!);
  expect(image.subarray(1,4).toString()).toBe("PNG");
  expect(image.readUInt32BE(16)).toBe(1080);
  expect(image.readUInt32BE(20)).toBeGreaterThan(1000);
  await page.getByRole("button",{name:"复制文字版",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"文字版已复制"})).toBeVisible();
  const text=(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,"\n");
  expect(text).toContain(`${day}值得分享的 ${count} 条新闻`);
  expect(text.match(/^原文：https?:\/\/\S+$/gm)?.length).toBe(count);
  expect(databaseQuery("SELECT count(*) FROM reader_shares")).toBe(String(Number(drafts)+2));
  for(const theme of ["light","dark"]) for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1100});
    await page.goto(`/share?clawpilotTheme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
    await expect(page.getByRole("img",{name:/^分享图预览：/})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`daily-share-${theme}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1100});
  await page.goto("/weekly");
  await page.getByRole("navigation",{name:"本周主题导航",exact:true}).getByRole("button",{name:"全部主题",exact:true}).click();
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(page.getByRole("button",{name:/分享卡片/})).toHaveCount(0);
});
