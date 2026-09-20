import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";

test("expanded source coverage uses real adapters and explicit observation approval", async ({ request, page }) => {
  const { items: sources } = await (await request.get(`${api}/api/v1/sources`)).json();
  expect(sources.length).toBeGreaterThanOrEqual(26);
  for (const adapter of ["arxiv_atom", "huggingface_models", "github_repository", "github_search", "anthropic_news", "podcast_rss"]) {
    expect(sources.some((source: { adapter: string; lastSuccessAt: string | null }) =>
      source.adapter === adapter && source.lastSuccessAt)).toBeTruthy();
  }
  const { items: coverage } = await (await request.get(`${api}/api/v1/sources/coverage`)).json();
  expect(new Set(coverage.map((item: { id: string }) => item.id)).size).toBe(coverage.length);
  for (const id of ["psychology", "hci", "design", "open-models", "podcast-zhang"]) {
    expect(coverage.find((item: { id: string }) => item.id === id).sourceCount).toBeGreaterThan(0);
  }
  expect(coverage.find((item: { id: string }) => item.id === "x").status).toBe("blocked");
  const discovered = sources.find((source: { adapter: string }) => source.adapter === "github_search");
  expect((await request.put(`${api}/api/v1/sources/${discovered.id}`, { data: { confirmed: true } })).status()).toBe(409);
  const podcast = sources.find((source: { endpoint: string }) => source.endpoint === "https://feed.xyzfm.space/dk4yh3pkpjp3");
  expect(podcast.lifecycleStatus).toBe("observing");
  const approved = await request.put(`${api}/api/v1/sources/${podcast.id}`, { data: { confirmed: true } });
  expect(approved.ok()).toBeTruthy();
  expect((await approved.json()).lifecycleStatus).toBe("stable");
  await request.put(`${api}/api/v1/sources/${podcast.id}`, { data: { enabled: false } });
  const resumed = await request.put(`${api}/api/v1/sources/${podcast.id}`, { data: { enabled: true } });
  expect((await resumed.json()).lifecycleStatus).toBe("stable");
  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "张小珺Jùn｜商业访谈录", exact: true })).toBeVisible();
});

test("expired source cooldown is consumed after a successful refresh", async ({ request }) => {
  const { items: sources } = await (await request.get(`${api}/api/v1/sources`)).json();
  const source = sources.find((source: { name: string }) => source.name === "Rust Blog");
  databaseQuery(`UPDATE sources SET cache_meta=cache_meta || jsonb_build_object('retryAfter',now()-interval '1 second') WHERE id='${source.id}'`);
  const refreshed = await request.post(`${api}/api/v1/sources/${source.id}/refresh`, { timeout: 60000 });
  expect(refreshed.ok()).toBeTruthy();
  expect((await refreshed.json()).failed).toBe(0);
  expect(databaseQuery(`SELECT (cache_meta->>'retryAfter' IS NULL)::int FROM sources WHERE id='${source.id}'`)).toBe("1");
});
