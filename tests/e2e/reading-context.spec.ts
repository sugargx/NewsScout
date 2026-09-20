import {expect,test} from "@playwright/test";
import type {Event,Source} from "../../apps/web/src/types";
import {databaseQuery} from "./db";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:18080";

test.beforeAll(async({request})=>{
  test.setTimeout(180_000);
  if(databaseQuery("SELECT count(*) FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id JOIN sources s ON s.id=ci.source_id WHERE ee.is_official AND s.content_type='blog'")==="0") {
    const response=await request.post(`${api}/api/v1/sources/20000000-0000-0000-0000-000000000001/refresh`,{timeout:150_000});
    expect(response.ok(),await response.text()).toBe(true);
    expect((await response.json()).succeeded).toBe(1);
  }
});

test("reading context retains genuine rich podcast notes and detail GET stays read-only",async({request})=>{
  test.setTimeout(150_000);
  const {items:sources}:{items:Source[]}=await(await request.get(`${api}/api/v1/sources`)).json();
  const source=sources.find(item=>item.name==="AI + a16z · 节目 RSS");
  if(!source)throw new Error("The original AI + a16z subscription is required.");
  expect(source.id).toMatch(/^[0-9a-f-]{36}$/);
  const refreshed=await request.post(`${api}/api/v1/sources/${source.id}/refresh`,{timeout:120_000});
  expect(refreshed.ok(),await refreshed.text()).toBe(true);
  expect((await refreshed.json()).succeeded).toBe(1);
  const list=await request.get(`${api}/api/v1/events?source=${source.id}&hours=0&limit=20`);
  const {items}:{items:Event[]}=await list.json();
  expect(items.length).toBeGreaterThan(0);
  expect(items.every(item=>item.evidence.every(evidence=>evidence.readingContext==null))).toBe(true);
  const id=databaseQuery(`SELECT ee.event_id FROM content_items ci
    JOIN event_evidence ee ON ee.content_item_id=ci.id WHERE ci.source_id='${source.id}'
    AND length(ci.metadata->'readingContext'->>'body')>length(ci.metadata->>'feedSummary')
    ORDER BY length(ci.metadata->'readingContext'->>'body') DESC,ee.event_id LIMIT 1`);
  expect(id,"The real publisher feed should preserve more than its former short excerpt.").toMatch(/^[0-9a-f-]{36}$/);
  const fingerprint=()=>databaseQuery(`SELECT md5(jsonb_build_object(
    'context',(SELECT jsonb_agg(ci.metadata ORDER BY ci.id) FROM content_items ci WHERE ci.source_id='${source.id}'),
    'fetches',(SELECT count(*) FROM fetch_runs),
    'modelAttempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))::text)`);
  const before=fingerprint();
  const response=await request.get(`${api}/api/v1/events/${id}`);
  expect(response.ok(),await response.text()).toBe(true);
  const event:Event=await response.json();
  const evidence=event.evidence.find(item=>item.readingContext?.kind==="podcast");
  expect(evidence).toBeTruthy();
  expect(evidence!.readingContext!.body.length).toBeGreaterThan(evidence!.excerpt.length);
  expect([...evidence!.readingContext!.body].length).toBeLessThanOrEqual(16000);
  expect(evidence!.readingContext!.origin).toBe("feed");
  expect(evidence!.readingContext!.durationSeconds).toBeGreaterThan(0);
  expect(evidence!.readingContext!.comments).toEqual([]);
  await request.get(`${api}/api/v1/events/${id}`);
  expect(fingerprint()).toBe(before);

  // Emulate a pre-context record while retaining the publisher's HTTP validators.
  databaseQuery(`UPDATE content_items SET metadata=metadata-'readingContext'-'readingContextHash'-'readingContextMaterialHash'
    WHERE id=(SELECT content_item_id FROM event_evidence WHERE event_id='${id}' LIMIT 1);
    UPDATE sources SET cache_meta=cache_meta-'readingContextVersion' WHERE id='${source.id}'`);
  const upgraded=await request.post(`${api}/api/v1/sources/${source.id}/refresh`,{timeout:120_000});
  expect(upgraded.ok(),await upgraded.text()).toBe(true);
  expect((await upgraded.json()).succeeded).toBe(1);
  expect(databaseQuery(`SELECT cache_meta->>'readingContextVersion' FROM sources WHERE id='${source.id}'`)).toBe("2");
  const restored:Event=await(await request.get(`${api}/api/v1/events/${id}`)).json();
  expect(restored.evidence.find(item=>item.readingContext?.kind==="podcast")?.readingContext?.body).toBe(evidence!.readingContext!.body);
});

test("reading context owner action respects source backoff and does not requeue or fabricate success",async({request})=>{
  const id=databaseQuery(`SELECT ee.event_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
    JOIN sources s ON s.id=ci.source_id WHERE ee.is_official AND s.content_type='blog'
    AND s.lifecycle_status IN ('stable','observing') ORDER BY ee.event_id LIMIT 1`);
  expect(id,"A real official blog event must have been collected by the reader suite.").toMatch(/^[0-9a-f-]{36}$/);
  const caches=databaseQuery(`SELECT jsonb_agg(jsonb_build_object('id',s.id,'cache',s.cache_meta)) FROM sources s
    WHERE s.id IN(SELECT ci.source_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id='${id}')`);
  const fingerprint=()=>databaseQuery(`SELECT md5(jsonb_build_object(
    'event',(SELECT to_jsonb(e) FROM events e WHERE e.id='${id}'),
    'material',(SELECT jsonb_agg(ci.metadata ORDER BY ci.id) FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id='${id}'),
    'attempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))::text)`);
  try {
    databaseQuery(`UPDATE sources SET cache_meta=cache_meta||jsonb_build_object('enrichmentRetryAfter',now()+interval '1 hour','browserRetryAfter',now()+interval '1 hour')
      WHERE id IN(SELECT ci.source_id FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id='${id}')`);
    const before=fingerprint();
    const response=await request.post(`${api}/api/v1/events/${id}/reading-context`);
    expect(response.ok(),await response.text()).toBe(true);
    const report=await response.json();
    expect(report.attempted).toBeGreaterThan(0);
    expect(report.attempted).toBeLessThanOrEqual(3);
    expect(report.failed).toBe(report.attempted);
    expect(report.succeeded).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.errors.join(" ")).toContain("退避");
    expect(fingerprint()).toBe(before);
    expect((await request.post(`${api}/api/v1/events/${id}/reading-context`,{headers:{Origin:"https://untrusted.example"}})).status()).toBe(403);
    expect(fingerprint()).toBe(before);
  } finally {
    databaseQuery(`UPDATE sources s SET cache_meta=x.cache FROM jsonb_to_recordset('${caches.replaceAll("'","''")}'::jsonb) AS x(id uuid,cache jsonb) WHERE s.id=x.id`);
  }
});
