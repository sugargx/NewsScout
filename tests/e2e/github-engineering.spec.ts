import { expect, test } from "@playwright/test";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";

test("GitHub Engineering is a default official source beside AI and ML", async ({ request, page }) => {
  const response = await request.get(`${api}/api/v1/sources`);
  expect(response.ok()).toBe(true);
  const { items } = await response.json();
  const engineering = items.filter((source: { endpoint: string }) =>
    source.endpoint === "https://github.blog/engineering/feed/");
  expect(engineering).toHaveLength(1);
  expect(engineering[0]).toMatchObject({
    name: "GitHub Blog · Engineering",
    adapter: "rss",
    tier: "T1",
    lifecycleStatus: "observing",
  });
  expect(items.filter((source: { endpoint: string }) =>
    source.endpoint === "https://github.blog/ai-and-ml/feed/")).toHaveLength(1);

  await page.goto("/sources");
  await page.getByLabel("搜索来源", { exact: true }).fill("GitHub Blog");
  await expect(page.getByRole("region", { name: "GitHub Blog · Engineering", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "GitHub Blog · AI & ML", exact: true })).toBeVisible();
});
