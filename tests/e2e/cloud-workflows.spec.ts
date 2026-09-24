import { expect, test as base, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import type { Brief, Event, IngestionResult, ReaderSession, ShareDocument, ShareLink, Source } from "../../apps/web/src/types";

const candidate = "http://127.0.0.1:15175";
const shareId = "c3100000-0000-4000-8000-000000000001";
const sourceId = "c3100000-0000-4000-8000-000000000002";
const jobId = "c3100000-0000-4000-8000-000000000003";
const timestamp = "2026-09-21T03:00:00.000Z";
const privateTitle = "PRIVATE_UNSELECTED_STORY_NOT_FOR_PUBLICATION";
const privateSummary = "PRIVATE_UNSELECTED_SUMMARY_DO_NOT_DISCLOSE";

function readerSession(account: "A" | "B" = "A"): ReaderSession {
  return {
    user: {
      id: account === "A" ? "c3100000-0000-4000-8000-00000000000a" : "c3100000-0000-4000-8000-00000000000b",
      displayName: `云端工作流测试账号 ${account}`,
    },
    capabilities: { manageReadingSettings: false },
    csrfToken: `mock-workflow-csrf-${account}`,
    telemetryConsent: false,
  };
}

function sourceFixture(name = "受控云端来源"): Source {
  return {
    id: sourceId, name, publisher: "受控原始发布者", contentType: "blog", adapter: "rss",
    endpoint: "https://publisher.example.test/feed.xml", tier: "T2", lifecycleStatus: "stable",
    topics: ["受控测试"], scheduleMinutes: 60, consecutiveFailures: 0, lastError: null,
    lastSuccessAt: timestamp,
  };
}

function publishedDocument(): ShareDocument {
  return {
    title: "旧版已公开的阅读摘选", kind: "brief", date: "2026-09-20", createdAt: timestamp,
    note: "受控摘选仅供阅读参考，请结合原始来源判断。",
    items: [{
      title: "旧版公开报道", summary: "发布者当时确认公开的摘要。", publishedAt: timestamp, summaryKind: "copilot",
      sources: [{ name: "受控原始发布者", url: "https://publisher.example.test/article", tier: "T2" }],
    }],
  };
}

const shareStories: { title: string; topics: string[] }[] = [
  { title: "城市交通数据开放计划发布", topics: ["产业与商业"] },
  { title: "开源模型发布更长上下文版本", topics: ["模型与多模态"] },
  { title: "欧盟更新数字市场执法细则", topics: ["治理与政策"] },
  { title: "Claude 新增团队协作工作区", topics: ["产业与商业"] },
  { title: "半导体出口新规进入征求意见期", topics: ["芯片与硬件"] },
  { title: "编程助手支持跨仓库重构", topics: ["AI 编程"] },
  { title: "新能源车企公布季度交付数据", topics: ["产业与商业"] },
  { title: "智能体评测基准公开任务集", topics: ["评测与安全"] },
  { title: "设计团队分享无障碍改版经验", topics: ["设计与交互"] },
  { title: "检索增强方案降低长文档成本", topics: ["记忆与检索"] },
  { title: "卫星互联网完成新一轮组网", topics: ["其他动态"] },
  { title: "多模态模型开放视频理解接口", topics: ["模型与多模态"] },
];
// 补读: published before the edition's 24-hour window; dates render in Beijing time.
const earlierStories: { title: string; topics: string[]; publishedAt: string }[] = [
  { title: "开源推理框架发布性能基准报告", topics: ["Agent 与工具"], publishedAt: "2026-09-18T03:00:00.000Z" },
  { title: "城市更新项目公布阶段性成果", topics: ["其他动态"], publishedAt: "2026-09-17T08:00:00.000Z" },
  { title: "研究团队公开蛋白质结构数据集", topics: ["其他动态"], publishedAt: "2026-09-15T20:00:00.000Z" },
];
const storyId = (index: number) => `c3100000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;

function shareBrief(): Brief {
  const event = (index: number, title: string, topics: string[], extra: Partial<Event> = {}) => ({
    id: storyId(index), contentVersion: 1, title, displayTitle: null, primaryTopic: topics[0], topics, eventType: "blog",
    summary: `${title}。这一变化影响相关团队的日常决策。`,
    summaryPoints: [`${title}，官方同时公开了适用范围。`, "读者可以对照原文确认细节。", "后续进展仍需观察。"],
    summaryMaterialLimit: null, summaryLimitations: [], importance: "", firstSeenAt: timestamp, updatedAt: timestamp,
    publishedAt: timestamp, freshnessAt: timestamp, publicationPrecision: "time",
    evidence: [{
      id: `evidence-${index}`, sourceName: `受控来源 ${index + 1} · RSS`, sourceTier: "T1", title,
      url: `https://publisher.example.test/story-${index + 1}?utm_source=newsletter&keep=1`, isOfficial: true, publishedAt: timestamp, excerpt: "",
    }],
    saved: false, read: false, later: false, notInterested: false, seen: false, opened: false, ...extra,
  }) as unknown as Event;
  const items = shareStories.map((story, index) => event(index, story.title, story.topics));
  items.splice(3, 0, event(40, privateTitle, ["模型与多模态"], { summary: privateSummary, notInterested: true }));
  const earlier = earlierStories.map((story, index) => event(50 + index, story.title, story.topics, { publishedAt: story.publishedAt, freshnessAt: story.publishedAt }));
  const ids = (list: Event[]) => list.map(item => item.id);
  return {
    localDate: "2026-09-21", generatedAt: timestamp, estimatedMinutes: 24, items: [...items, ...earlier], isSnapshot: true,
    windowStart: "2026-09-20T22:00:00.000Z", windowEnd: "2026-09-20T22:00:00.000Z", nextRefreshAt: "2026-09-21T22:00:00.000Z",
    sections: [
      { key: "essential", kind: "essential", title: "今日重点", description: "选文截止前 24 小时内价值最高的内容", eventIds: ids(items.slice(0, 5)) },
      { key: "more", kind: "more", title: "更多值得读", description: "同一时段内其余值得读的内容", eventIds: ids(items.slice(5)) },
      { key: "catch_up", kind: "catch_up", title: "值得补读", description: "过去 7 天发布、此前未入选的高价值内容", eventIds: ids(earlier) },
    ],
  };
}

function sharingContract() {
  let revoked = false;
  const link = (): ShareLink => ({ id: shareId, title: publishedDocument().title, date: "2026-09-20", kind: "brief", createdAt: timestamp, edited: true, published: true, revoked });
  const reply = (request: MockRequest): MockResponse | undefined => {
    if (request.path === "/api/v1/briefs/latest" && request.method === "GET") return { json: shareBrief() };
    if (request.path === "/api/v1/shares" && request.method === "GET") return { json: { items: [link()] } };
    if (request.path === `/api/v1/shares/${shareId}` && request.method === "DELETE") {
      revoked = true;
      return { json: { id: shareId, published: true, revoked: true } };
    }
    if (request.path === `/api/v1/public/shares/${shareId}` && request.method === "GET") {
      // The anonymous endpoint returns the document itself, never the private share wrapper.
      return revoked ? { status: 410, json: { error: "share_unavailable" } } : { json: publishedDocument() };
    }
    return undefined;
  };
  return { reply };
}

interface MockRequest {
  path: string;
  method: string;
  csrf: string | undefined;
  body: unknown;
  receivedAt: number;
  responseStatus?: number;
}
interface MockResponse { status?: number; json: unknown }
interface MockCloud {
  session: ReaderSession | null;
  sources: Source[];
  requests: MockRequest[];
  unexpected: string[];
  pageErrors: string[];
  reply?: (request: MockRequest) => MockResponse | undefined | Promise<MockResponse | undefined>;
}

async function installCloudMock(context: BrowserContext, session: ReaderSession | null): Promise<MockCloud> {
  const mock: MockCloud = { session, sources: [sourceFixture()], requests: [], unexpected: [], pageErrors: [] };
  await context.addInitScript(() => {
    const apply = () => {
      if (!document.documentElement) return false;
      document.documentElement.dataset.deployment = "azure";
      return true;
    };
    if (!apply()) {
      const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
      observer.observe(document, { childList: true, subtree: true });
    }
  });
  const listen = (page: Page) => page.on("pageerror", error => mock.pageErrors.push(error.message));
  context.pages().forEach(listen);
  context.on("page", listen);
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== candidate || url.pathname.startsWith("/.auth/")) {
      mock.unexpected.push(`Blocked network request: ${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.includes("/api/") && !["fetch", "xhr"].includes(request.resourceType())) return route.continue();
    const entry: MockRequest = {
      path: url.pathname, method: request.method(), csrf: request.headers()["x-csrf-token"],
      body: request.postData() ? request.postDataJSON() : null, receivedAt: Date.now(),
    };
    mock.requests.push(entry);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(entry.method) && (!mock.session || entry.csrf !== mock.session.csrfToken)) {
      mock.unexpected.push(`Incorrect session CSRF token: ${entry.method} ${entry.path}`);
    }
    let response = await mock.reply?.(entry);
    if (!response && entry.path === "/api/v1/session" && entry.method === "GET") {
      response = mock.session ? { json: mock.session } : { status: 401, json: { error: "请登录后使用。" } };
    }
    if (!response && mock.session && entry.method === "GET") {
      if (entry.path === "/api/v1/runtime") response = { json: { mode: "postgres", version: "cloud-workflow-fixture", timeZone: "Asia/Shanghai" } };
      if (entry.path === "/api/v1/sources") response = { json: { items: mock.sources } };
      if (["/api/v1/sources/coverage", "/api/v1/source-watchlist", "/api/v1/me/interests", "/api/v1/shares"].includes(entry.path)) {
        response = { json: { items: [] } };
      }
    }
    if (!response) {
      mock.unexpected.push(`Unmocked API request: ${entry.method} ${entry.path}`);
      response = { status: 501, json: { error: "Unmocked cloud workflow API" } };
    }
    await route.fulfill(response);
    entry.responseStatus = response.status ?? 200;
  });
  return mock;
}

const test = base.extend<{
  mockCloud: (context: BrowserContext, session?: ReaderSession | null) => Promise<MockCloud>;
}>({
  mockCloud: async ({ baseURL }, use, info) => {
    expect(process.env.SCOUTNEWS_E2E_MOCK_ONLY, "Run this file only in mock-only mode").toBe("true");
    expect(baseURL, "Never run cloud workflow writes against the personal API or development host").toBe(candidate);
    const clients: MockCloud[] = [];
    await use(async (context, session = readerSession()) => {
      const client = await installCloudMock(context, session);
      clients.push(client);
      return client;
    });
    const path = info.outputPath("mock-api-contracts.json");
    await writeFile(path, JSON.stringify(clients.map(({ requests, unexpected, pageErrors }) => ({ requests, unexpected, pageErrors })), null, 2));
    await info.attach("mock-api-contracts", { path, contentType: "application/json" });
    expect(clients.flatMap(client => client.unexpected), "All API calls must be explicitly mocked; external network is blocked").toEqual([]);
    expect(clients.flatMap(client => client.pageErrors), "The real browser must not throw application errors").toEqual([]);
  },
});

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test("cloud daily share downloads a local image, publishes nothing and keeps legacy links revocable", async ({ page, browser, mockCloud }, info) => {
  const owner = await mockCloud(page.context()), sharing = sharingContract();
  owner.reply = sharing.reply;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: candidate });
  // The fixture edition is 2026-09-21; on that Beijing day the image and text call it "今日".
  await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
  await page.goto("/share");
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
  await expect(page.getByText("来自 9月21日版今日精选 · 共 15 条可选（其中 3 条为补读）", { exact: true })).toBeVisible();
  const preview = page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1080);
  const order = page.getByRole("group", { name: "分享排序", exact: true });
  await expect(order.getByRole("button", { name: "AI 相关优先", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("6 条 AI 相关新闻排在前面，其余保持精选顺序。补读内容始终排在最后。", { exact: true })).toBeVisible();
  const options = page.locator(".ns-share-options li");
  await expect(options).toHaveCount(15);
  await expect(options.first()).toContainText("开源模型发布更长上下文版本");
  await expect(options.first()).toContainText("AI 相关");
  await expect(page.getByText("已选 10 / 最多 15 条", { exact: true })).toBeVisible();
  await expect(page.getByText(privateTitle, { exact: false })).toHaveCount(0);
  // AI-first never lifts an older 补读 item above the 24-hour selection, and none is picked by default.
  await expect(page.getByRole("heading", { level: 3, name: "值得补读 · 较早发布", exact: true })).toBeVisible();
  await expect(options.nth(12)).toContainText("开源推理框架发布性能基准报告");
  await expect(options.nth(12)).toContainText("补读 · 9月18日发布");
  await expect(options.nth(14)).toContainText("补读 · 9月16日发布");
  const earlier = page.getByRole("checkbox", { name: /开源推理框架发布性能基准报告/ });
  await expect(earlier).not.toBeChecked();
  await screenshot(page, info, "daily-share-ai-first");

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载分享图", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("NewsScout-今日分享-2026-09-21.png");
  const png = await readFile((await download.path())!);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBeGreaterThan(3000);
  await expect(page.getByRole("status").filter({ hasText: "已下载分享图：10 条新闻，每条附原文链接。" })).toBeVisible();
  await info.attach("daily-share-download", { body: png, contentType: "image/png" });

  await order.getByRole("button", { name: "精选顺序", exact: true }).click();
  await expect(order.getByRole("button", { name: "精选顺序", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(options.first()).toContainText("城市交通数据开放计划发布");
  await page.getByRole("checkbox", { name: /城市交通数据开放计划发布/ }).uncheck();
  await expect(page.getByText("已选 9 / 最多 15 条", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 9 条新闻", exact: true })).toBeVisible();
  await earlier.check();
  await expect(page.getByText("已选 10 / 最多 15 条", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制文字版", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "文字版已复制" })).toBeVisible();
  const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  expect(text.split("\n")[0]).toBe("NewsScout · 今日值得分享的 10 条新闻（2026-09-21，含 1 条补读）");
  expect(text).toContain("1. 开源模型发布更长上下文版本");
  expect(text).toContain("10. 【补读 · 9月18日发布】开源推理框架发布性能基准报告");
  expect(text).toContain("原文：https://publisher.example.test/story-2?keep=1");
  expect(text).toContain("摘要由 AI 根据原文生成，仅供参考，请以原文为准。");
  expect(text).not.toContain("utm_source");
  expect(text).not.toContain("城市交通数据开放计划发布");
  expect(text).not.toContain(privateTitle);
  // Restoring the defaults removes the button that had focus; keyboard users land on the picker heading.
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "选择新闻", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "恢复默认", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /城市交通数据开放计划发布/ })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("group", { name: "分享排序", exact: true }).getByRole("button", { name: "精选顺序", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("已选 10 / 最多 15 条", { exact: true })).toBeVisible();
  // Picking every remaining story reaches the 15-item cap; the long image still renders.
  for (const title of ["卫星互联网完成新一轮组网", "多模态模型开放视频理解接口", ...earlierStories.map(story => story.title)]) {
    await page.getByRole("checkbox", { name: new RegExp(title) }).check();
  }
  await expect(page.getByText("已选 15 / 最多 15 条", { exact: true })).toBeVisible();
  await expect(page.getByText("已达 15 条上限，取消一条后可再选。", { exact: true })).toBeVisible();
  const fullPreview = page.getByRole("img", { name: "分享图预览：今日值得分享的 15 条新闻", exact: true });
  await expect(fullPreview).toBeVisible();
  expect(await fullPreview.evaluate(image => (image as HTMLImageElement).naturalHeight)).toBeLessThan(16000);
  await page.getByRole("checkbox", { name: /卫星互联网完成新一轮组网/ }).uncheck();
  await expect(page.getByText("已达 15 条上限，取消一条后可再选。", { exact: true })).toHaveCount(0);
  expect(owner.requests.filter(request => request.method !== "GET")).toEqual([]);

  const anonymousContext = await browser.newContext({ baseURL: candidate, serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  try {
    const anonymous = await mockCloud(anonymousContext, null);
    anonymous.reply = sharing.reply;
    const publicPage = await anonymousContext.newPage();
    await publicPage.goto(`/p/${shareId}`);
    await expect(publicPage.getByRole("heading", { level: 1, name: publishedDocument().title, exact: true })).toBeVisible();
    await expect(publicPage.getByRole("article")).toHaveCount(1);
    const original = publicPage.getByRole("link", { name: "受控原始发布者 ↗", exact: true });
    await expect(original).toHaveAttribute("href", "https://publisher.example.test/article");
    await expect(original).toHaveAttribute("rel", "noopener noreferrer");
    for (const privateValue of [readerSession().user.id, readerSession().user.displayName, readerSession().csrfToken]) {
      await expect(publicPage.getByText(privateValue, { exact: false })).toHaveCount(0);
    }

    const legacy = page.locator("details.ns-share-legacy");
    await legacy.locator("summary").click();
    await expect(legacy).toContainText("旧版分享链接仍可访问。新的分享图只在本机生成，不会创建公开链接。");
    await expect(legacy.getByRole("link", { name: "打开 ↗", exact: true })).toHaveAttribute("href", `/p/${shareId}`);
    await legacy.getByRole("button", { name: "撤回链接", exact: true }).click();
    expect(owner.requests.filter(request => request.method === "DELETE")).toHaveLength(0);
    await legacy.getByRole("button", { name: "确认撤回", exact: true }).click();
    await expect(page.locator("details.ns-share-legacy")).toHaveCount(0);
    expect(owner.requests.filter(request => request.method === "DELETE")).toEqual([
      expect.objectContaining({ path: `/api/v1/shares/${shareId}`, csrf: readerSession().csrfToken }),
    ]);
    await publicPage.reload();
    await expect(publicPage.getByRole("heading", { name: "这份分享暂不可访问", exact: true })).toBeVisible();
    await expect(publicPage.getByRole("article")).toHaveCount(0);
    await screenshot(publicPage, info, "revoked-anonymous-share-390");
    expect(anonymous.requests.every(request => request.method === "GET" && ["/api/v1/session", `/api/v1/public/shares/${shareId}`].includes(request.path))).toBe(true);
    expect(anonymous.requests.filter(request => request.path.startsWith("/api/v1/public/")).every(request => request.csrf === undefined)).toBe(true);
  } finally {
    await anonymousContext.close();
  }
});

test("cloud daily share keeps the reader's edition until they switch to the newly saved one", async ({ page, mockCloud }) => {
  const owner = await mockCloud(page.context());
  const current = shareBrief(), held = current.items.filter(item => !item.notInterested).slice(0, 6);
  const previous: Brief = {
    ...current, localDate: "2026-09-20", generatedAt: "2026-09-19T22:40:00.000Z", refreshPending: true, nextRefreshAt: null, items: held,
    sections: [{ key: "essential", kind: "essential", title: "今日重点", description: "选文截止前 24 小时内价值最高的内容", eventIds: held.map(item => item.id) }],
  };
  let calls = 0;
  owner.reply = request => request.path === "/api/v1/briefs/latest" && request.method === "GET" ? { json: calls++ ? current : previous } : undefined;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: candidate });
  await page.clock.install({ time: new Date("2026-09-21T06:20:00+08:00") });
  await page.goto("/share");
  await expect(page.getByText("来自 9月20日版今日精选 · 共 6 条可选 · 今日版正在生成，当前为上一期", { exact: true })).toBeVisible();
  // The held earlier edition is announced with the same date that is drawn in the image.
  await expect(page.getByRole("img", { name: "分享图预览：9月20日值得分享的 6 条新闻", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /城市交通数据开放计划发布/ }).uncheck();
  await expect(page.getByText("已选 5 / 最多 15 条", { exact: true })).toBeVisible();
  // A held earlier edition is named by its date, never presented as today's.
  await page.getByRole("button", { name: "复制文字版", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "文字版已复制" })).toBeVisible();
  const heldText = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  expect(heldText.split("\n")[0]).toBe("NewsScout · 9月20日值得分享的 5 条新闻（2026-09-20）");
  await page.clock.fastForward("01:05");
  const notice = page.getByRole("status").filter({ hasText: "今日精选已更新为 9月21日版。" });
  await expect(notice).toBeVisible();
  // The picks stay on the held edition, and the finished run no longer reads as still generating.
  await expect(page.getByText("来自 9月20日版今日精选 · 共 6 条可选", { exact: true })).toBeVisible();
  await expect(page.getByText("已选 5 / 最多 15 条", { exact: true })).toBeVisible();
  await notice.getByRole("button", { name: "换成新版", exact: true }).click();
  await expect(page.getByText("来自 9月21日版今日精选 · 共 15 条可选（其中 3 条为补读）", { exact: true })).toBeVisible();
  await expect(page.getByText("已选 10 / 最多 15 条", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  // The switch removed the button that had focus; keyboard users land on the picker heading.
  await expect(page.getByRole("heading", { level: 2, name: "选择新闻", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "复制文字版", exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/)[0])
    .toBe("NewsScout · 今日值得分享的 10 条新闻（2026-09-21）");
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(owner.requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("cloud daily share falls back to a focused, selected text box when copying is blocked", async ({ page, mockCloud }) => {
  const owner = await mockCloud(page.context());
  owner.reply = sharingContract().reply;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("blocked", "NotAllowedError")) } });
  });
  await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
  await page.goto("/share");
  await expect(page.getByText("已选 10 / 最多 15 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制文字版", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "浏览器未允许自动复制，请在下方文本框中手动复制。" })).toBeVisible();
  const manual = page.getByRole("textbox", { name: "分享文字版", exact: true });
  await expect(manual).toBeFocused();
  await expect(manual).toHaveValue(/^NewsScout · 今日值得分享的 10 条新闻（2026-09-21）\n/);
  const selection = await manual.evaluate(element => {
    const box = element as HTMLTextAreaElement;
    return { start: box.selectionStart, end: box.selectionEnd, length: box.value.length };
  });
  expect(selection.length).toBeGreaterThan(100);
  expect(selection).toEqual({ start: 0, end: selection.length, length: selection.length });
});

for (const status of [403, 404, 410]) {
  test(`anonymous unavailable share ${status} never renders private error details`, async ({ page, mockCloud }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mock = await mockCloud(page.context(), null);
    mock.reply = request => request.path === `/api/v1/public/shares/${shareId}` && request.method === "GET"
      ? { status, json: { error: `${privateTitle}: ${privateSummary}`, document: { ...publishedDocument(), title: privateTitle }, editor: { title: privateTitle, caption: privateSummary } } }
      : undefined;
    await page.goto(`/p/${shareId}`);
    await expect(page.getByRole("heading", { name: "这份分享暂不可访问", exact: true })).toBeVisible();
    await expect(page.getByText("链接可能已被撤回，或尚未公开发布。", { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(page.getByText(privateTitle, { exact: false })).toHaveCount(0);
    await expect(page.getByText(privateSummary, { exact: false })).toHaveCount(0);
    await expect(page.getByText(publishedDocument().title, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "使用 Microsoft 账户登录", exact: true })).toHaveCount(0);
    expect(mock.requests.every(request => request.method === "GET" && ["/api/v1/session", `/api/v1/public/shares/${shareId}`].includes(request.path))).toBe(true);
    await screenshot(page, info, `anonymous-unavailable-${status}-390`);
  });
}

const ingestionCases: { name: string; result: IngestionResult; heading: string }[] = [
  { name: "succeeded", result: { attempted: 2, succeeded: 2, failed: 0, ingested: 3, updated: 1 }, heading: "来源刷新完成" },
  { name: "partial-failure", result: { attempted: 2, succeeded: 1, failed: 1, ingested: 1, updated: 0, errors: ["受控来源抓取失败"] }, heading: "部分来源刷新失败" },
  { name: "all-sources-failed", result: { attempted: 2, succeeded: 0, failed: 2, ingested: 0, updated: 0, errors: ["受控来源抓取失败"] }, heading: "来源刷新失败" },
];

for (const outcome of ingestionCases) {
  test(`cloud collection waits for the accepted job and renders ${outcome.name} counts`, async ({ page, mockCloud }, info) => {
    const mock = await mockCloud(page.context()), completion = deferred<MockResponse>();
    let polls = 0;
    mock.reply = request => {
      if (request.path === "/api/v1/admin/ingestion/run" && request.method === "POST") {
        return { status: 202, json: { jobId, status: "pending", total: 2, completed: 0 } };
      }
      if (request.path === `/api/v1/ingestion-runs/${jobId}` && request.method === "GET") {
        polls++;
        return polls === 1 ? { json: { jobId, status: "running", total: 2, completed: 1 } } : completion.promise;
      }
      return undefined;
    };
    try {
      await page.goto("/sources");
      await page.getByRole("button", { name: "采集启用的来源", exact: true }).click();
      await expect(page.getByRole("button", { name: "正在采集来源…", exact: true })).toBeDisabled();
      await expect(page.getByText("采集正在进行，请稍候。", { exact: false })).toBeVisible();
      await expect.poll(() => polls).toBe(2);
      await expect(page.getByText(/^(来源刷新完成|部分来源刷新失败|来源刷新失败)$/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "刷新来源：受控云端来源", exact: true })).toBeDisabled();
      expect(mock.requests.filter(request => request.method === "POST")).toEqual([
        expect.objectContaining({ path: "/api/v1/admin/ingestion/run", csrf: readerSession().csrfToken, responseStatus: 202 }),
      ]);
      await screenshot(page, info, `collection-${outcome.name}-pending`);
      if (outcome.result.failed) mock.sources = [{ ...sourceFixture(), consecutiveFailures: 1, lastError: "受控来源抓取失败" }];
      completion.resolve({ json: { jobId, status: "succeeded", total: 2, completed: 2, result: outcome.result } });
      await expect(page.getByText(outcome.heading, { exact: true })).toBeVisible();
      const { attempted, succeeded, failed, ingested } = outcome.result;
      await expect(page.getByText(`尝试 ${attempted}，成功 ${succeeded}，失败 ${failed}，入库 ${ingested} 条。`, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "采集启用的来源", exact: true })).toBeEnabled();
      await expect(page.getByText("采集正在进行，请稍候。", { exact: false })).toHaveCount(0);
      if (failed) {
        await expect(page.getByRole("region", { name: "受控云端来源", exact: true }).getByText("受控来源抓取失败", { exact: true })).toBeVisible();
        await expect(page.getByText("来源刷新完成", { exact: true })).toHaveCount(0);
      }
      expect(polls).toBe(2);
      await screenshot(page, info, `collection-${outcome.name}-result`);
    } finally {
      completion.resolve({ json: { jobId, status: "failed", error: "test_cleanup" } });
    }
  });
}

for (const failure of [
  { code: "worker_interrupted", message: "采集因服务重启而中断，请重新发起。" },
  { code: "upstream_unavailable", message: "采集任务未完成，请稍后重试。" },
]) {
  test(`single-source accepted collection reports ${failure.code} without success`, async ({ page, mockCloud }, info) => {
    const mock = await mockCloud(page.context()), completion = deferred<MockResponse>();
    mock.reply = request => {
      if (request.path === `/api/v1/sources/${sourceId}/refresh` && request.method === "POST") {
        return { status: 202, json: { jobId, status: "pending", total: 1, completed: 0 } };
      }
      if (request.path === `/api/v1/ingestion-runs/${jobId}` && request.method === "GET") return completion.promise;
      return undefined;
    };
    try {
      await page.goto("/sources");
      const source = page.getByRole("region", { name: "受控云端来源", exact: true });
      const refresh = source.getByRole("button", { name: "刷新来源：受控云端来源", exact: true });
      await refresh.click();
      await expect(refresh).toBeDisabled();
      await expect(source).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => mock.requests.filter(request => request.path === `/api/v1/ingestion-runs/${jobId}`).length).toBe(1);
      await expect(source.getByText("来源刷新完成", { exact: true })).toHaveCount(0);
      completion.resolve({ json: { jobId, status: "failed", total: 1, completed: 0, result: null, error: failure.code } });
      await expect(source.getByText("受控云端来源 刷新请求失败", { exact: true })).toBeVisible();
      await expect(source.getByText(failure.message, { exact: true })).toBeVisible();
      await expect(refresh).toBeEnabled();
      await expect(source).toHaveAttribute("aria-busy", "false");
      await expect(source.getByText("来源刷新完成", { exact: true })).toHaveCount(0);
      expect(mock.requests.filter(request => request.method === "POST")).toEqual([
        expect.objectContaining({ path: `/api/v1/sources/${sourceId}/refresh`, csrf: readerSession().csrfToken, responseStatus: 202 }),
      ]);
      await screenshot(page, info, `collection-${failure.code}`);
    } finally {
      completion.resolve({ json: { jobId, status: "failed", error: "test_cleanup" } });
    }
  });
}

test("a collection that exceeds the virtual 30-minute deadline never claims completion", async ({ page, mockCloud }, info) => {
  const mock = await mockCloud(page.context());
  await page.clock.install({ time: new Date(timestamp) });
  mock.reply = request => {
    if (request.path === "/api/v1/admin/ingestion/run" && request.method === "POST") {
      return { status: 202, json: { jobId, status: "pending", total: 1, completed: 0 } };
    }
    if (request.path === `/api/v1/ingestion-runs/${jobId}` && request.method === "GET") {
      return { json: { jobId, status: "running", total: 1, completed: 0 } };
    }
    return undefined;
  };
  await page.goto("/sources");
  await page.getByRole("button", { name: "采集启用的来源", exact: true }).click();
  await expect(page.getByRole("button", { name: "正在采集来源…", exact: true })).toBeDisabled();
  await expect.poll(() => mock.requests.filter(request => request.path.startsWith("/api/v1/ingestion-runs/")).length).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward(30 * 60 * 1000 + 1501);
  await expect(page.getByText("刷新全部来源失败", { exact: true })).toBeVisible();
  await expect(page.getByText("采集仍在后台进行，尚未报告完成。请稍后回到来源页查看更新；重新发起会恢复现有任务。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "采集启用的来源", exact: true })).toBeEnabled();
  await expect(page.getByText("来源刷新完成", { exact: true })).toHaveCount(0);
  expect(mock.requests.filter(request => request.path.startsWith("/api/v1/ingestion-runs/")).length).toBeLessThanOrEqual(3);
  await screenshot(page, info, "collection-virtual-deadline");
});

for (const status of [200, 401]) {
  test(`a held old-account ${status} response cannot overwrite a replacement document`, async ({ page, mockCloud }, info) => {
    const mock = await mockCloud(page.context()), oldResponse = deferred<MockResponse>();
    const oldSource = sourceFixture("旧账号私有来源 A"), newSource = sourceFixture("新账号私有来源 B");
    let oldRequest: MockRequest | undefined, documentNavigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) documentNavigations++; });
    await page.clock.install({ time: new Date(timestamp) });
    // Keep the old transport response outside the document that an identity change now replaces.
    mock.reply = request => {
      if (request.path === "/api/v1/sources" && request.method === "GET") {
        if (!oldRequest) {
          oldRequest = request;
          return oldResponse.promise;
        }
        return { json: { items: [newSource] } };
      }
      return undefined;
    };
    try {
      await page.goto("/sources");
      await expect(page.getByText(readerSession("A").user.displayName, { exact: true })).toBeVisible();
      await expect.poll(() => oldRequest !== undefined).toBe(true);
      expect(oldRequest!.responseStatus).toBeUndefined();
      await expect(page.getByRole("heading", { name: oldSource.name, exact: true })).toHaveCount(0);
      const initialNavigations = documentNavigations;
      mock.session = readerSession("B");
      await page.clock.fastForward(30_001);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
      await expect.poll(() => documentNavigations).toBe(initialNavigations + 1);
      await expect(page.getByText(readerSession("B").user.displayName, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: newSource.name, exact: true })).toBeVisible();
      const sessionCalls = mock.requests.filter(request => request.path === "/api/v1/session").length;
      expect(sessionCalls).toBeGreaterThanOrEqual(3);
      oldResponse.resolve(status === 200 ? { json: { items: [oldSource] } } : { status, json: { error: "old_account_session_expired" } });
      await expect.poll(() => oldRequest!.responseStatus).toBe(status);
      await page.getByRole("textbox", { name: "搜索来源", exact: true }).fill(newSource.name);
      await expect(page.getByRole("status").filter({ hasText: "已应用筛选" })).toContainText("显示 1 / 1 个来源");
      await expect(page.getByRole("heading", { name: newSource.name, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: oldSource.name, exact: true })).toHaveCount(0);
      await expect(page.getByText(readerSession("A").user.displayName, { exact: true })).toHaveCount(0);
      await expect(page.getByText(readerSession("B").user.displayName, { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "使用 Microsoft 账户登录", exact: true })).toHaveCount(0);
      expect(mock.requests.filter(request => request.path === "/api/v1/session")).toHaveLength(sessionCalls);
      await screenshot(page, info, `account-restart-discards-old-${status}`);
    } finally {
      oldResponse.resolve({ status: 401, json: { error: "test_cleanup" } });
    }
  });
}

for (const width of [1440, 390]) {
  test(`successful account swap releases an open privacy dialog at ${width}px`, async ({ page, mockCloud }, info) => {
    const mock = await mockCloud(page.context());
    const newSource = sourceFixture("切换账号后的私有来源 B");
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: new Date(timestamp) });
    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: "受控云端来源", exact: true })).toBeVisible();
    if (width <= 768) await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "隐私与使用统计", exact: true, includeHidden: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "允许可选的使用统计", exact: true })).toBeVisible();
    await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
    await screenshot(page, info, `account-a-open-privacy-${width}`);

    mock.session = readerSession("B");
    mock.sources = [newSource];
    await page.clock.fastForward(30_001);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
    await expect.poll(() => mock.requests.filter(request => request.path === "/api/v1/session").length).toBeGreaterThanOrEqual(2);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(newSource.name, { exact: true })).toBeVisible();
    expect(mock.requests.filter(request => request.path === "/api/v1/session").every(request => request.responseStatus === 200)).toBe(true);
    await screenshot(page, info, `account-b-after-open-privacy-swap-${width}`);
    const lockState = await page.evaluate(() => ({
      rootAriaHidden: document.getElementById("root")?.getAttribute("aria-hidden"),
      rootInert: document.getElementById("root")?.hasAttribute("inert"),
      remainingDialogs: document.querySelectorAll('[role="dialog"]').length,
      activeElement: document.activeElement?.tagName,
      bodyOverflow: getComputedStyle(document.body).overflow,
    }));
    const lockPath = info.outputPath(`account-swap-modal-state-${width}.json`);
    await writeFile(lockPath, JSON.stringify(lockState, null, 2));
    await info.attach("account-swap-modal-state", { path: lockPath, contentType: "application/json" });

    await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
    await expect(page.getByRole("heading", { name: newSource.name, exact: true })).toBeVisible();
    const search = page.getByRole("textbox", { name: "搜索来源", exact: true });
    await search.fill(newSource.name);
    await expect(search).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "已应用筛选" })).toContainText("显示 1 / 1 个来源");
  });
}
