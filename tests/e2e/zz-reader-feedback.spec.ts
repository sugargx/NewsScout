import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";
test.beforeAll(async({request})=>{
  test.setTimeout(300_000);
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true") throw new Error("Use isolated E2E.");
  if(Number(databaseQuery("SELECT count(*) FROM events"))===0) {
    const response=await request.post(`${api}/api/v1/admin/ingestion/run`,{timeout:270_000});
    expect(response.ok()).toBe(true);
    expect((await response.json()).succeeded).toBeGreaterThanOrEqual(4);
  }
});

test("feedback reader learns bounded related-topic preferences and supports undo",async({request})=>{
  const ids: string[]=JSON.parse(databaseQuery(`SELECT json_agg(id) FROM(
    SELECT e.id FROM events e JOIN event_editorial_features f ON f.id=e.id
    WHERE 'Agent 与工具'=ANY(f.facets)
    AND NOT EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=e.id) ORDER BY e.id LIMIT 2)s`));
  expect(ids.length).toBe(2);
  const get=(id:string)=>request.get(`${api}/api/v1/events/${id}`).then(response=>response.json());
  const before=await get(ids[1]);
  try {
    expect((await request.put(`${api}/api/v1/events/${ids[0]}/state`,{data:{saved:true}})).ok()).toBe(true);
    const positive=await get(ids[1]);
    expect(positive.recommendation.affinity).toBeGreaterThan(before.recommendation.affinity);
    await request.put(`${api}/api/v1/events/${ids[0]}/state`,{data:{notInterested:true,notInterestedReason:"topic"}});
    const negative=await get(ids[1]);
    const dismissed=await get(ids[0]);
    expect(negative.recommendation.affinity).toBeLessThan(before.recommendation.affinity);
    expect(negative.recommendation.affinity).toBeGreaterThanOrEqual(10);
    expect(dismissed.notInterested).toBe(true);
    expect(dismissed.saved).toBe(false);
    const hidden=await (await request.get(`${api}/api/v1/events?q=${encodeURIComponent(dismissed.title)}`)).json();
    expect(hidden.items.some((item:{id:string})=>item.id===ids[0])).toBe(false);
    const history=await (await request.get(`${api}/api/v1/events?notInterested=true`)).json();
    expect(history.items.some((item:{id:string})=>item.id===ids[0])).toBe(true);
    await request.put(`${api}/api/v1/events/${ids[0]}/state`,{data:{notInterested:false}});
    expect((await get(ids[1])).recommendation.affinity).toBeCloseTo(before.recommendation.affinity,2);
    expect((await request.put(`${api}/api/v1/events/${ids[0]}/state`,{data:{saved:true,notInterested:true}})).status()).toBe(400);
  } finally {databaseQuery(`DELETE FROM user_event_states WHERE event_id IN('${ids[0]}','${ids[1]}')`);}
});

test("feedback reader exposure is idempotent and new evidence resets repeat penalties",async({request})=>{
  const id=databaseQuery("SELECT e.id FROM events e WHERE NOT EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=e.id) ORDER BY e.id LIMIT 1");
  const event=await (await request.get(`${api}/api/v1/events/${id}`)).json();
  const asOf=new Date().toISOString();
  const input={items:[{eventId:id,contentVersion:event.contentVersion}]};
  try {
    expect((await (await request.post(`${api}/api/v1/events/exposures`,{data:input})).json()).recorded).toBe(1);
    expect((await (await request.post(`${api}/api/v1/events/exposures`,{data:input})).json()).recorded).toBe(0);
    const seen=await (await request.get(`${api}/api/v1/events/${id}`)).json();
    expect(seen.seen).toBe(true);
    expect(seen.recommendation.noveltyPenalty).toBeCloseTo(3,2);
    const stable=await (await request.get(`${api}/api/v1/events?asOf=${encodeURIComponent(asOf)}&q=${encodeURIComponent(event.title)}`)).json();
    expect(stable.items.find((item:{id:string})=>item.id===id).recommendation.noveltyPenalty).toBe(0);
    await request.put(`${api}/api/v1/events/${id}/state`,{data:{opened:true}});
    expect((await (await request.get(`${api}/api/v1/events/${id}`)).json()).recommendation.noveltyPenalty).toBeCloseTo(6,2);
    databaseQuery(`UPDATE events SET content_version=content_version+1 WHERE id='${id}'`);
    const updated=await (await request.get(`${api}/api/v1/events/${id}`)).json();
    expect(updated.seen).toBe(false);
    expect(updated.recommendation.noveltyPenalty).toBe(0);
    expect((await (await request.post(`${api}/api/v1/events/exposures`,{data:input})).json()).recorded).toBe(0);
  } finally {
    databaseQuery(`DELETE FROM event_exposures WHERE event_id='${id}';DELETE FROM user_event_states WHERE event_id='${id}';UPDATE events SET content_version=${event.contentVersion} WHERE id='${id}'`);
  }
});

test("feedback reader uses source age for freshness and ranks before pagination",async({request})=>{
  const id=databaseQuery("SELECT id FROM events ORDER BY id LIMIT 1");
  const contents:{id:string;published_at:string|null}[]=JSON.parse(databaseQuery(`SELECT json_agg(s) FROM(
    SELECT id,published_at FROM content_items WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id='${id}'))s`));
  const literal=(value:string|null)=>value===null?"NULL":`'${value.replaceAll("'","''")}'`;
  try {
    const original=await (await request.get(`${api}/api/v1/events/${id}`)).json();
    const kind=original.editorial.contentKind;
    const halfLife=["research","analysis","tutorial"].includes(kind)?96:kind==="release"?48:30;
    const scores:number[]=[];
    for(const [hours,freshness] of [[0,100],[halfLife,50],[halfLife*2,25],[2400,0]]) {
      databaseQuery(`UPDATE content_items SET published_at=now()-interval '${hours} hours' WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id='${id}')`);
      const event=await (await request.get(`${api}/api/v1/events/${id}`)).json();
      expect(event.recommendation.freshness).toBeCloseTo(freshness,1);
      scores.push(event.recommendation.score);
    }
    expect(scores[0]-scores[1]).toBeCloseTo(7.5,1);
    databaseQuery(`UPDATE content_items SET published_at=NULL WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id='${id}')`);
    expect((await (await request.get(`${api}/api/v1/events/${id}`)).json()).recommendation.freshness).toBe(0);
    const anchor=encodeURIComponent(new Date().toISOString());
    const first=await (await request.get(`${api}/api/v1/events?sort=recommended&limit=20&asOf=${anchor}`)).json();
    const second=await (await request.get(`${api}/api/v1/events?sort=recommended&limit=20&offset=20&asOf=${anchor}`)).json();
    const items=[...first.items,...second.items];
    expect(items.length).toBe(40);
    for(let index=1;index<items.length;index++) expect(items[index-1].recommendation.score).toBeGreaterThanOrEqual(items[index].recommendation.score);
  } finally {
    for(const item of contents) databaseQuery(`UPDATE content_items SET published_at=${literal(item.published_at)} WHERE id=${literal(item.id)}`);
  }
});

test("feedback reader defaults to dense recommendations and offers truthful topic relationships",async({page,request})=>{
  await page.goto("/radar");
  await page.getByRole("article").first().waitFor();
  await expect(page.getByRole("tab",{name:"列表",exact:true})).toHaveAttribute("aria-selected","true");
  await expect(page.getByLabel("排序",{exact:true})).toHaveValue("recommended");
  expect(await page.getByRole("button",{name:/标为已读|稍后读|移出稍后读/}).count()).toBe(0);
  const first=await page.getByRole("article").first().boundingBox();
  expect(first!.height).toBeLessThan(210);
  await page.getByRole("tab",{name:"主题地图",exact:true}).click();
  await page.getByRole("group",{name:"关键词主题共现图",exact:true}).waitFor();
  const exploration=await (await request.get(`${api}/api/v1/explore?hours=168`)).json();
  expect(exploration.sampleSize).toBeLessThanOrEqual(100);
  expect(exploration.meaning).toContain("不表示因果");
  expect(exploration.nodes.length).toBeGreaterThan(0);
  await page.getByRole("group",{name:"关键词主题共现图",exact:true}).getByRole("button",{name:/查看匹配文章/}).first().click();
  await expect(page.getByRole("tab",{name:"主题地图",exact:true})).toHaveAttribute("aria-selected","true");
  await expect(page.getByRole("group",{name:"关键词主题共现图",exact:true})).toBeVisible();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toHaveCount(0);
  await page.getByRole("group",{name:"关联文章",exact:true}).getByRole("button").first().click();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toBeVisible();
  await expect(page).toHaveURL(/\/radar\?view=topics/);
  await expect(page.getByRole("group",{name:"关键词主题共现图",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"返回主题结果",exact:true}).click();
  await expect(page.getByRole("article",{name:"文章就地阅读"})).toHaveCount(0);
  const refresh=page.waitForResponse(response=>response.url().includes("/api/v1/explore?"));
  await page.getByRole("button",{name:"应用更新",exact:true}).click();
  expect((await refresh).ok()).toBe(true);
  await page.getByRole("tab",{name:"列表",exact:true}).click();
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(page.locator("#main-content")).not.toContainText(/为什么入选|确定性规则|article-value-v1|基础值=/);
  await page.setViewportSize({width:390,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test("feedback reader live selection includes labeled observation sources without rewriting archives",async({request})=>{
  const literal=(value:unknown)=>value===null?"NULL":`'${String(value).replaceAll("'","''")}'`;
  const settings=(await (await request.get(`${api}/api/v1/reader-status`)).json()).settings;
  const scheduleStamp=databaseQuery("SELECT updated_at FROM app_settings WHERE key='reader_settings'");
  const confirmedBefore=databaseQuery("SELECT count(*) FROM sources WHERE lifecycle_status='stable'");
  const events:Record<string,string|number|null>[]=JSON.parse(databaseQuery(`SELECT json_agg(s) FROM(
    SELECT e.id,e.summary_kind,e.summary_format_version,e.summary_model,e.summary_reasoning_effort FROM events e
    JOIN reader_editorial_recommendations('local',now()) r ON r.event_id=e.id
    WHERE NOT r.confirmed AND (r.editorial->>'briefEligible')::boolean
    AND NOT EXISTS(SELECT 1 FROM event_evidence ae JOIN content_items ac ON ac.id=ae.content_item_id
      JOIN sources ads ON ads.id=ac.source_id WHERE ae.event_id=e.id AND ads.adapter_type='aihot_public')
    AND EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id JOIN sources s ON s.id=ci.source_id
      WHERE ee.event_id=e.id AND s.lifecycle_status='observing' AND s.last_success_at IS NOT NULL AND s.consecutive_failures=0 AND s.adapter_type<>'github_search')
    ORDER BY e.id LIMIT 24)s`));
  expect(events.length).toBe(24);
  const ids=events.map(event=>literal(event.id)).join(",");
  const contents:{id:string;published_at:string|null}[]=JSON.parse(databaseQuery(`SELECT json_agg(s) FROM(
    SELECT id,published_at FROM content_items WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id IN(${ids})))s`));
  let date="",createdArchive=false;
  try {
    await request.put(`${api}/api/v1/reader-settings`,{data:{...settings,includeObserving:true}});
    // Simulate completion/timestamps only in the disposable DB; the source text remains real.
    databaseQuery(`UPDATE content_items SET published_at=now()-interval '2 hours' WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id IN(${ids}));
      UPDATE events SET summary_kind='copilot',summary_format_version=2,summary_model='gpt-5.6-terra',summary_reasoning_effort='low' WHERE id IN(${ids})`);
    const live=await (await request.get(`${api}/api/v1/briefs/latest`)).json();
    date=live.localDate;
    expect(live.isSnapshot).toBe(false);
    expect(live.items.length).toBeGreaterThan(0);
    expect(live.items.length).toBeLessThanOrEqual(20);
    expect(live.items.every((event:{editorial:{briefEligible:boolean}})=>event.editorial.briefEligible)).toBe(true);
    expect(live.items.some((event:{id:string;recommendation:{sourceConfirmed:boolean}})=>
      events.some(candidate=>candidate.id===event.id)&&!event.recommendation.sourceConfirmed)).toBe(true);
    await request.put(`${api}/api/v1/reader-settings`,{data:{...settings,includeObserving:false}});
    expect(databaseQuery("SELECT updated_at FROM app_settings WHERE key='reader_settings'")).toBe(scheduleStamp);
    const confirmedOnly=await (await request.get(`${api}/api/v1/briefs/latest`)).json();
    expect(confirmedOnly.isSnapshot).toBe(false);
    expect(confirmedOnly.items.every((event:{recommendation:{sourceConfirmed:boolean}})=>event.recommendation.sourceConfirmed)).toBe(true);
    await request.put(`${api}/api/v1/reader-settings`,{data:{...settings,includeObserving:true}});
    const archiveExists=Number(databaseQuery(`SELECT count(*) FROM daily_briefs WHERE local_date=${literal(date)}`))>0;
    const beforeArchive=archiveExists?await (await request.get(`${api}/api/v1/briefs/today`)).json():null;
    const saved=await (await request.post(`${api}/api/v1/briefs/today/generate`)).json();
    createdArchive=!archiveExists;
    expect(saved.items.map((event:{id:string})=>event.id)).toEqual((beforeArchive??live).items.map((event:{id:string})=>event.id));
    if(beforeArchive)expect(saved.generatedAt).toBe(beforeArchive.generatedAt);
    await request.put(`${api}/api/v1/reader-settings`,{data:{...settings,includeObserving:false}});
    const schedule=(await (await request.get(`${api}/api/v1/reader-status`)).json()).settings;
    const slot=Date.parse(`${date}T${String(schedule.hour).padStart(2,"0")}:00:00+08:00`);
    const latest=await (await request.get(`${api}/api/v1/briefs/latest`)).json();
    // Once its morning slot has passed, a saved edition is served unchanged for 24 hours.
    if(schedule.mode==="daily"&&Date.now()>=slot) {
      expect(latest.isSnapshot).toBe(true);
      expect(latest.items.map((event:{id:string})=>event.id)).toEqual(saved.items.map((event:{id:string})=>event.id));
      expect(Date.parse(latest.nextRefreshAt)).toBe(slot+86_400_000);
    } else expect(latest.isSnapshot).toBe(false);
    const archived=await (await request.get(`${api}/api/v1/briefs/today`)).json();
    expect(archived.items.map((event:{id:string})=>event.id)).toEqual(saved.items.map((event:{id:string})=>event.id));
    expect(archived.generatedAt).toBe(saved.generatedAt);
    expect(databaseQuery(`SELECT count(*) FROM sources WHERE lifecycle_status='stable'`)).toBe(confirmedBefore);
  } finally {
    if(date&&createdArchive) databaseQuery(`DELETE FROM daily_brief_items WHERE brief_id IN(SELECT id FROM daily_briefs WHERE local_date=${literal(date)});DELETE FROM daily_briefs WHERE local_date=${literal(date)}`);
    for(const item of contents) databaseQuery(`UPDATE content_items SET published_at=${literal(item.published_at)} WHERE id=${literal(item.id)}`);
    for(const item of events) databaseQuery(`UPDATE events SET ${Object.entries(item).filter(([key])=>key!=="id").map(([key,value])=>`${key}=${literal(value)}`).join(",")} WHERE id=${literal(item.id)}`);
    await request.put(`${api}/api/v1/reader-settings`,{data:settings});
  }
});
