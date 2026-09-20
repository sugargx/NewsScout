import {expect,test} from "@playwright/test";
import {readFileSync} from "node:fs";
import {unzipSync,strFromU8} from "fflate";
import {databaseQuery} from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";
test("direct reader and social studio use real publishers and export a persistent local POC",async({request,page},info)=>{
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
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toBeVisible();
  await expect.poll(async()=>databaseQuery(`SELECT (opened_at IS NOT NULL)::int FROM user_event_states WHERE user_id='local' AND event_id='${event.id}'`)).toBe("1");
  const opened=await (await request.get(`${api}/api/v1/events?tier=T1&opened=true&limit=100`)).json();
  expect(opened.items.some((item:{id:string})=>item.id===event.id)).toBe(true);
  if(t1.items.length>1) {
    await page.getByRole("button",{name:"下一篇",exact:true}).click();
    await expect(page.getByRole("article",{name:"文章就地阅读"}).getByRole("heading",{name:t1.items[1].title,exact:true})).toBeVisible();
    await expect(page).toHaveURL(/\/reading$/);
  }
  await page.goto("/shares");
  await expect(page.getByRole("heading",{name:"第一份分享，从一篇好文章开始。",exact:true})).toBeVisible();
  await page.goto(`/events/${event.id}`);
  await page.getByRole("button",{name:"制作分享卡片",exact:true}).click();
  await expect(page).toHaveURL(/\/share\/[a-f0-9-]+$/);
  const shareId=page.url().split("/").at(-1)!;
  await expect(page.locator(".ns-card-canvas canvas")).toBeVisible();
  await page.getByLabel("封面标题",{exact:true}).fill("从原始来源，读懂今天的 AI");
  await page.getByRole("button",{name:"保存草稿",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"草稿已保存到本地阅读库"})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("封面标题",{exact:true})).toHaveValue("从原始来源，读懂今天的 AI");
  for(const theme of ["light","dark"]) {
    await page.goto(`/share/${shareId}?clawpilotTheme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
    await page.getByLabel("卡片主题",{exact:true}).selectOption(theme);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1100});
      await expect(page.locator(".ns-card-canvas")).toHaveAttribute("aria-busy","false");
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:info.outputPath(`social-studio-${theme}-${width}.png`),fullPage:true});
    }
  }
  await page.setViewportSize({width:1440,height:1100});
  await page.getByLabel("画面比例",{exact:true}).selectOption("square");
  await expect(page.locator(".ns-card-canvas canvas")).toHaveAttribute("height","1080");
  await page.getByLabel("画面比例",{exact:true}).selectOption("portrait");
  await expect(page.locator(".ns-card-canvas canvas")).toHaveAttribute("height","1440");
  const [download]=await Promise.all([page.waitForEvent("download"),page.getByRole("button",{name:"导出整套素材",exact:true}).click()]);
  const downloadPath=await download.path();expect(downloadPath).toBeTruthy();
  const entries=unzipSync(readFileSync(downloadPath!));
  const pngs=Object.entries(entries).filter(([name])=>name.endsWith(".png"));
  expect(pngs.length).toBeGreaterThanOrEqual(3);
  for(const [,bytes] of pngs) {
    const image=Buffer.from(bytes);expect(image.subarray(1,4).toString()).toBe("PNG");
    expect(image.readUInt32BE(16)).toBe(1080);expect(image.readUInt32BE(20)).toBe(1440);
  }
  expect(strFromU8(entries["post.txt"])).toContain("NewsScout");
  expect(strFromU8(entries["post.txt"])).toContain("从原始来源，读懂今天的 AI");
  await page.getByRole("tab",{name:"02 选文",exact:true}).click();
  await page.getByLabel("第 1 篇卡片正文",{exact:true}).fill("这段编辑草稿用于检查长文自动续页，正文不应被悄悄截断。".repeat(45));
  await expect.poll(()=>page.getByRole("button",{name:/^预览第/}).count()).toBeGreaterThan(3);
  await page.getByRole("tab",{name:"03 文案",exact:true}).click();
  await page.getByLabel("小红书发帖文案",{exact:true}).fill("我的 NewsScout 阅读笔记\n#AI资讯 #NewsScout");
  await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
  await page.getByRole("button",{name:"复制发帖文案",exact:true}).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain("我的 NewsScout 阅读笔记");
  const share=await (await request.get(`${api}/api/v1/shares/${shareId}`)).json();
  expect(share.published).toBe(false);expect(share.publicUrl).toBeNull();
  expect(Object.keys(share.document.items[0]).sort()).toEqual(["publishedAt","sources","summary","summaryKind","title"]);
  expect((await request.post(`${api}/api/v1/shares/${shareId}/publish`)).status()).toBe(412);
  await page.goto("/shares");
  await expect(page.getByRole("link",{name:"从原始来源，读懂今天的 AI",exact:true})).toBeVisible();

  // Only completion provenance is synthetic; all titles and text remain real fetched publisher material.
  databaseQuery(`UPDATE events SET summary_kind='copilot',summary_format_version=2 WHERE id IN(
    SELECT ee.event_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
    WHERE ci.source_id='20000000-0000-0000-0000-000000000301' AND ci.published_at>=now()-interval '7 days' AND ci.published_at<=now())`);
  const week=await (await request.get(`${api}/api/v1/weekly`)).json();expect(week.items.length).toBeGreaterThan(0);
  for(const kind of ["week","brief"]) {
    const response=await request.post(`${api}/api/v1/shares`,{data:{kind,date:"latest"}});
    expect(response.ok(),await response.text()).toBe(true);
    expect((await response.json()).document.kind).toBe(kind);
  }
  await page.goto("/weekly");
  await expect(page.getByRole("button",{name:"制作分享卡片",exact:true})).toBeVisible();
});
