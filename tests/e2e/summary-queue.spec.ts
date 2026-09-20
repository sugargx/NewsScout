import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { databaseQuery } from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";

test.beforeEach(() => {
  if (process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE !== "true") throw new Error("Queue tests require isolated credentials.");
});

test("summary queue backfills real events and exposes Terra without accessing models", async ({ request }) => {
  const response = await request.get(`${api}/api/v1/processing`);
  expect(response.ok()).toBeTruthy();
  const processing = await response.json();
  expect(processing.settings).toEqual({ enabled: true, model: "gpt-5.6-terra", dailyLimit: 20 });
  expect(processing.blockedReason).toBe("isolated");
  expect(processing.feedCount).toBeGreaterThan(0);
  expect(processing.counts.pending).toBe(processing.feedCount);
  expect(processing.counts.running).toBe(0);
  expect(processing.aiCount).toBe(0);
  expect(processing.usage.used).toBe(0);
  const { items: [event] } = await (await request.get(`${api}/api/v1/events?limit=1`)).json();
  expect(event.summaryKind).toBe("feed");
  expect(event.summaryStatus).toBe("pending");
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe("0");
});

test("summary queue invalidation is versioned and retries are explicit", async ({ request }) => {
  const id = databaseQuery("SELECT event_id FROM summary_jobs ORDER BY event_id LIMIT 1");
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const version = databaseQuery(`SELECT content_version FROM events WHERE id='${id}'`);
  try {
    databaseQuery(`UPDATE summary_jobs SET status='failed',attempts=3,last_error='injected queue failure',next_attempt_at=NULL WHERE event_id='${id}'`);
    databaseQuery(`UPDATE events SET summary_kind='feed' WHERE id='${id}'`);
    expect(databaseQuery(`SELECT status FROM summary_jobs WHERE event_id='${id}'`)).toBe("failed");
    databaseQuery(`UPDATE events SET content_version=content_version+1 WHERE id='${id}'`);
    expect(databaseQuery(`SELECT status||':'||attempts FROM summary_jobs WHERE event_id='${id}'`)).toBe("pending:0");
    expect(databaseQuery(`SELECT (j.content_version=e.content_version)::int FROM summary_jobs j JOIN events e ON e.id=j.event_id WHERE e.id='${id}'`)).toBe("1");
    databaseQuery(`UPDATE summary_jobs SET status='failed',attempts=3,last_error='injected queue failure' WHERE event_id='${id}'`);
    const retry = await request.post(`${api}/api/v1/processing/retry`);
    expect(retry.ok()).toBeTruthy();
    expect((await retry.json()).queued).toBe(1);
    expect(databaseQuery(`SELECT status||':'||attempts FROM summary_jobs WHERE event_id='${id}'`)).toBe("pending:0");
  } finally {
    databaseQuery(`UPDATE events SET content_version=${Number(version)} WHERE id='${id}'`);
  }
});

test("summary queue recovers interrupted leases without calling local Copilot", async () => {
  const id = databaseQuery("SELECT event_id FROM summary_jobs ORDER BY event_id LIMIT 1");
  databaseQuery(`UPDATE summary_jobs SET status='running',attempts=1,lease_id='${randomUUID()}',lease_until=now()-interval '1 minute' WHERE event_id='${id}'`);
  await expect.poll(() => databaseQuery(`SELECT status FROM summary_jobs WHERE event_id='${id}'`), { timeout: 15000 }).toBe("pending");
  databaseQuery(`UPDATE summary_jobs SET status='running',attempts=3,lease_id='${randomUUID()}',lease_until=now()-interval '1 minute' WHERE event_id='${id}'`);
  await expect.poll(() => databaseQuery(`SELECT status FROM summary_jobs WHERE event_id='${id}'`), { timeout: 15000 }).toBe("failed");
  databaseQuery(`UPDATE summary_jobs SET status='pending',attempts=0,last_error=NULL,next_attempt_at=now() WHERE event_id='${id}'`);
  expect(databaseQuery("SELECT count(*) FROM admin_audits WHERE action='summarize_attempt'")).toBe("0");
});

test("summary queue settings persist and quota recovery uses the required expiring attempt", async ({ request }) => {
  const settings = { enabled: false, model: "gpt-5.6-terra", dailyLimit: 2 };
  expect((await request.put(`${api}/api/v1/processing/settings`, { data: { ...settings, dailyLimit: 0 } })).status()).toBe(400);
  expect((await request.put(`${api}/api/v1/processing/settings`, { data: { ...settings, dailyLimit: 5001 } })).status()).toBe(400);
  const raised = await request.put(`${api}/api/v1/processing/settings`, { data: { ...settings, dailyLimit: 5000 } });
  expect(raised.ok()).toBeTruthy();
  expect((await raised.json()).dailyLimit).toBe(5000);
  expect(JSON.parse(databaseQuery("SELECT value FROM app_settings WHERE key='summary_settings'")).dailyLimit).toBe(5000);
  expect((await request.put(`${api}/api/v1/processing/settings`, { data: { ...settings, model: "not-an-available-model" } })).status()).toBe(400);
  expect((await request.put(`${api}/api/v1/processing/settings`, { data: settings })).ok()).toBeTruthy();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    databaseQuery(`INSERT INTO admin_audits(id,actor,action,target_type,target_id,reason,created_at) VALUES
      ('${ids[0]}','e2e','summarize_attempt','event','e2e','quota accounting',now()-interval '12 hours'),
      ('${ids[1]}','e2e','summarize_attempt','event','e2e','quota accounting',now()-interval '6 hours'),
      ('${ids[2]}','e2e','summarize_attempt','event','e2e','quota accounting',now()-interval '1 hour')`);
    const processing = await (await request.get(`${api}/api/v1/processing`)).json();
    expect(processing.settings).toEqual(settings);
    expect(processing.usage.used).toBe(3);
    expect(processing.usage.limit).toBe(2);
    expect(Date.parse(processing.usage.resetsAt) - Date.now()).toBeGreaterThan(17 * 3600000);
    expect(Date.parse(processing.usage.resetsAt) - Date.now()).toBeLessThan(19 * 3600000);
    expect(JSON.parse(databaseQuery("SELECT value FROM app_settings WHERE key='summary_settings'"))).toEqual(settings);
  } finally {
    databaseQuery(`DELETE FROM admin_audits WHERE id IN (${ids.map(id => `'${id}'`).join(",")})`);
    await request.put(`${api}/api/v1/processing/settings`, { data: { ...settings, enabled: true, dailyLimit: 20 } });
  }
});
