import {expect,test} from "@playwright/test";
import {identity,isPublicAddress,validateInput} from "../../services/source-access/browser-article.cjs";
import {databaseQuery} from "./db";
import type {Event} from "../../apps/web/src/types";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:18080";

test("browser article guards reject private addresses and keep exact article identity",()=>{
  for(const address of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.0.1","192.168.1.1","198.18.0.1","224.0.0.1",
    "::1","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1","2002:7f00:1::","3fff::1"])expect(isPublicAddress(address),address).toBe(false);
  for(const address of ["8.8.8.8","1.1.1.1","2606:4700::1111","2001:4860:4860::8888"])expect(isPublicAddress(address),address).toBe(true);
  expect(identity("https://openai.com/index/article/#section")).toBe(identity("https://openai.com/index/article"));
  expect(identity("https://openai.com/index/article")).not.toBe(identity("https://openai.com/index/other"));
  expect(()=>identity("https://user:password@openai.com/index/article")).toThrow();
  expect(()=>identity("https://openai.com:8080/index/article")).toThrow();
  expect(()=>validateInput({url:"https://openai.com/index/article",title:"Article",address:"127.0.0.1"})).toThrow();
});

test("browser article acquisition persists a real original article and GET remains passive",async({request})=>{
  test.setTimeout(300_000);
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true")throw new Error("Use the isolated E2E runner.");
  const source="20000000-0000-0000-0000-000000000001";
  const refreshed=await request.post(`${api}/api/v1/sources/${source}/refresh`,{timeout:180_000});
  expect(refreshed.ok(),await refreshed.text()).toBe(true);
  expect((await refreshed.json()).succeeded).toBe(1);
  const list=await(await request.get(`${api}/api/v1/events?source=${source}&hours=0&q=Now%20everyone%20can%20put%20data%20to%20work&limit=10`)).json();
  const selected:Event|undefined=list.items.find((item:Event)=>item.title==="Now everyone can put data to work");
  if(!selected)throw new Error("The reported original OpenAI article was not present in the actual publisher feed.");
  expect(selected.evidence.every(item=>item.readingContext==null)).toBe(true);
  let event:Event=await(await request.get(`${api}/api/v1/events/${selected.id}`)).json();
  if(!event.evidence.some(item=>item.readingContext?.origin==="publisher_page")) {
    const enriched=await request.post(`${api}/api/v1/events/${selected.id}/reading-context`,{timeout:100_000});
    expect(enriched.ok(),await enriched.text()).toBe(true);
    const report=await enriched.json();
    expect(report.failed,JSON.stringify(report)).toBe(0);
    expect(report.succeeded).toBeGreaterThan(0);
    event=await(await request.get(`${api}/api/v1/events/${selected.id}`)).json();
  }
  const evidence=event.evidence.find(item=>item.readingContext?.origin==="publisher_page");
  expect(evidence).toBeTruthy();
  expect(evidence!.readingContext!.body.length).toBeGreaterThan(1000);
  expect(evidence!.readingContext!.sourceUrl).toBe(evidence!.url);
  expect(databaseQuery(`SELECT ci.metadata->'readingContextAcquisition'->>'method' FROM event_evidence ee
    JOIN content_items ci ON ci.id=ee.content_item_id WHERE ee.event_id='${selected.id}' AND ci.source_id='${source}' LIMIT 1`)).toBe("browser");
  const fingerprint=()=>databaseQuery(`SELECT md5(jsonb_build_object('event',(SELECT to_jsonb(e) FROM events e WHERE e.id='${selected.id}'),
    'evidence',(SELECT jsonb_agg(ci.metadata ORDER BY ci.id) FROM content_items ci JOIN event_evidence ee ON ee.content_item_id=ci.id WHERE ee.event_id='${selected.id}'),
    'fetches',(SELECT count(*) FROM fetch_runs),'attempts',(SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'))::text)`);
  const before=fingerprint();
  await request.get(`${api}/api/v1/events/${selected.id}`);
  expect(fingerprint()).toBe(before);
  const repeated=await request.post(`${api}/api/v1/events/${selected.id}/reading-context`,{timeout:100_000});
  expect(repeated.ok(),await repeated.text()).toBe(true);
  const report=await repeated.json();
  expect(report.failed,JSON.stringify(report)).toBe(0);
  expect(report.updated,"An unchanged original body must not requeue its summary.").toBe(0);
  expect(fingerprint()).toBe(before);
});
