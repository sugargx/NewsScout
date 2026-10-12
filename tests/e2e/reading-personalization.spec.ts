import { expect, test, webkit, type Page } from "@playwright/test";
import { QueryClient } from "@tanstack/react-query";
import { acceptReadingPersonalization, createReadingClock, isReadingPersonalization, readingSurface } from "../../apps/web/src/reading-personalization";
import type { Brief, Event, ReaderSession, ReadingPersonalization, ReadingSignal } from "../../apps/web/src/types";

const timestamp = "2026-10-12T04:00:00Z";
const id = (number: number) => `d3300000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function article(number: number): Event {
  return {
    id: id(number), contentVersion: 1, title: `阅读学习测试文章 ${number}`, displayTitle: null,
    summary: "受控材料讨论编程助手的实际用途，阅读兴趣信号不等于喜欢或读完。",
    summaryPoints: ["发布者提供了实现依据。", "此处仅用于检验前台计时与个人信号边界。"],
    importance: "", primaryTopic: "AI 编程", topics: ["AI 编程"], eventType: "blog",
    firstSeenAt: timestamp, updatedAt: timestamp, publishedAt: timestamp, freshnessAt: timestamp,
    publicationPrecision: "time", collectedAt: timestamp, summaryFormatVersion: 3,
    evidence: [{ id: id(number + 100), sourceName: "受控原始来源", sourceTier: "T1", title: `来源文章 ${number}`,
      url: `https://source.example.test/article-${number}`, isOfficial: true, publishedAt: timestamp, excerpt: "有界的已收录材料。" }],
    score: { sourceQuality: 80, corroboration: 0, freshness: 90, relevance: 50, novelty: 0, engagement: 0, editorialBoost: 0, total: 70, explanation: "Fixture" },
    personalRelevance: 50, personalReason: "Fixture", saved: false, read: false, later: false,
    notInterested: false, seen: false, opened: false, recommendation: null, summaryKind: "copilot",
    summaryModel: null, summarizedAt: timestamp, summaryEvidenceIds: [id(number + 100)],
  };
}

async function mockReading(page: Page, enabled = true, cloud = true) {
  if (cloud) await page.addInitScript(() => {
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
  const articles = [article(1), article(2)];
  const records = new Map<string, ReadingSignal>();
  let generation = 200, failures = 0, settingFailures = 0;
  let hold: Promise<void> | null = null;
  let settingHold: Promise<void> | null = null;
  let settings: ReadingPersonalization = { enabled, generation: enabled ? id(generation) : null, signalCount: 0 };
  const session: ReaderSession = { user: { id: id(900), displayName: "阅读学习受控账号" },
    capabilities: { manageReadingSettings: false }, csrfToken: "reading-fixture-csrf", telemetryConsent: false };
  const requests: { path: string; method: string; body: unknown }[] = [];
  const unexpected: string[] = [], pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const brief: Brief = { localDate: "2026-10-12", generatedAt: timestamp, estimatedMinutes: 2,
    items: articles, isSnapshot: true, windowStart: "2026-10-11T04:00:00Z", windowEnd: timestamp,
    nextRefreshAt: "2026-10-13T04:00:00Z" };
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    requests.push({ path, method, body: request.postData() ? request.postDataJSON() : null });
    if (path === "/api/v1/session") return route.fulfill({ json: { ...session, readingPersonalization: { ...settings } } });
    if (path === "/api/v1/me/reading-personalization") {
      if (method !== "GET") {
        expect(request.headers()["x-csrf-token"]).toBe(session.csrfToken);
        await settingHold;
        if (settingFailures > 0) { settingFailures--; return route.fulfill({ status: 503, json: { message: "受控设置保存失败" } }); }
        const next = method === "DELETE" ? settings.enabled : request.postDataJSON().enabled;
        if (method === "DELETE" || next !== settings.enabled) {
          settings = { enabled: next, generation: id(++generation), signalCount: 0 };
          records.clear();
        }
      }
      return route.fulfill({ json: { ...settings } });
    }
    if (path === "/api/v1/events/reading-signals") {
      expect(request.headers()["x-csrf-token"]).toBe(session.csrfToken);
      const input: ReadingSignal = request.postDataJSON();
      expect(Object.keys(input).sort()).toEqual(["activeMs", "contentVersion", "eventId", "generation", "surface"]);
      expect(input.activeMs).toBeGreaterThanOrEqual(20_000);
      expect(input.activeMs).toBeLessThanOrEqual(120_000);
      if (failures > 0) { failures--; return route.fulfill({ status: 503, json: { message: "受控暂时失败" } }); }
      if (!settings.enabled || input.generation !== settings.generation) return route.fulfill({ status: 409, json: { message: "设置已变更" } });
      const recorded = !records.has(input.eventId);
      records.set(input.eventId, input);
      settings.signalCount = records.size;
      const response = { recorded, settings: { ...settings } };
      await hold;
      return route.fulfill({ json: response });
    }
    if (path === "/api/v1/events/exposures") return route.fulfill({ json: { recorded: 1, skipped: 0 } });
    if (path === "/api/v1/events") return route.fulfill({ json: { items: articles, nextOffset: null } });
    const state = articles.find(item => path === `/api/v1/events/${item.id}/state`);
    if (state) {
      Object.assign(state, request.postDataJSON());
      return route.fulfill({ json: state });
    }
    const detail = articles.find(item => path === `/api/v1/events/${item.id}`);
    if (detail) return route.fulfill({ json: detail });
    if (path === "/api/v1/briefs/latest" || path === "/api/v1/weekly") return route.fulfill({ json: brief });
    if (path === "/api/v1/runtime") return route.fulfill({ json: { mode: "postgres", version: "fixture", timeZone: "Asia/Shanghai" } });
    if (path === "/api/v1/me/interests" || path === "/api/v1/sources") return route.fulfill({ json: { items: [] } });
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 501, json: { message: "Unexpected fixture request" } });
  });
  return { requests, records, unexpected, pageErrors, articles, settings: () => settings,
    failNext: () => { failures = 1; },
    failNextSettings: () => { settingFailures = 1; },
    holdSettings: () => { let release = () => {}; settingHold = new Promise<void>(resolve => { release = resolve; }); return () => { settingHold = null; release(); }; },
    holdSignals: () => { let release = () => {}; hold = new Promise<void>(resolve => { release = resolve; }); return () => { hold = null; release(); }; } };
}

async function openArticle(page: Page, number = 1) {
  await page.locator(`article[data-event-id="${id(number)}"]`).getByRole("button", { name: `阅读学习测试文章 ${number}`, exact: true }).click();
  const pane = page.getByRole("article", { name: "文章就地阅读", exact: true });
  await expect(pane.getByRole("heading", { name: `阅读学习测试文章 ${number}`, exact: true })).toBeVisible();
  await pane.focus();
  return pane;
}

async function foreground(page: Page, visible: boolean) {
  await page.evaluate(visible => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visible ? "visible" : "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new FocusEvent(visible ? "focus" : "blur"));
  }, visible);
}

test("foreground clock excludes hidden, idle, suspended, and reversed time", () => {
  const clock = createReadingClock(0);
  clock.sample(0, true, true);
  for (let tick = 1; tick <= 10; tick++) clock.sample(tick * 1_000, true);
  expect(clock.sample(10_000, false)).toBe(10_000);
  expect(clock.sample(100_000, false)).toBe(10_000);
  clock.sample(100_000, true, true);
  for (let tick = 101; tick <= 140; tick++) clock.sample(tick * 1_000, true);
  expect(clock.sample(140_000, true)).toBe(40_000);
  expect(clock.sample(200_000, true)).toBe(40_000);
  expect(clock.sample(199_000, true)).toBe(40_000);
});

test("private settings reject invalid shapes and stale generations cannot resurrect cleared signals", () => {
  for (const value of [null, {}, { enabled: true, generation: null, signalCount: 0 },
    { enabled: true, generation: "-".repeat(36), signalCount: 0 },
    { enabled: true, generation: id(1), signalCount: -1 }]) expect(isReadingPersonalization(value)).toBe(false);
  const client = new QueryClient();
  const session: ReaderSession = { user: { id: id(9), displayName: "Fixture" }, csrfToken: "fixture",
    capabilities: { manageReadingSettings: false }, telemetryConsent: false,
    readingPersonalization: { enabled: true, generation: id(2), signalCount: 0 } };
  client.setQueryData(["session"], session);
  acceptReadingPersonalization(client, { enabled: true, generation: id(1), signalCount: 15 }, id(1));
  expect(client.getQueryData(["session"])).toEqual(session);
  client.clear();
  expect(["/radar", "/", "/reading", "/weekly", "/saved", "/topics", `/events/${id(1)}`].map(readingSurface))
    .toEqual(["radar", "brief", "reading", "weekly", "saved", "topics", "article"]);
});

for (const cloud of [true, false]) test(`learning stays off without cloud opt-in (${cloud ? "cloud" : "local/legacy"})`, async ({ page }) => {
  const mock = await mockReading(page, cloud ? false : true, cloud);
  await page.clock.install();
  await page.goto("/radar");
  await openArticle(page);
  await page.clock.runFor(35_000);
  expect(mock.requests.filter(r => r.path.endsWith("/reading-signals"))).toHaveLength(0);
  expect(mock.requests.some(r => r.path.endsWith("/state"))).toBe(true);
  expect(mock.unexpected).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});

test("quick opens and background time do not qualify; subsequent foreground reading records once", async ({ page }) => {
  const mock = await mockReading(page);
  await page.clock.install();
  await page.goto("/radar");
  await openArticle(page);
  await page.clock.runFor(5_000);
  await page.keyboard.press("Escape");
  expect(mock.records.size).toBe(0);
  await openArticle(page, 2);
  await page.clock.runFor(8_000);
  await foreground(page, false);
  await page.clock.runFor(60_000);
  expect(mock.records.size).toBe(0);
  await foreground(page, true);
  await page.clock.runFor(100);
  await expect(page.locator("html")).not.toHaveAttribute("data-session-validation", "pending");
  await page.getByRole("article", { name: "文章就地阅读" }).focus();
  await page.clock.runFor(15_000);
  await expect.poll(() => mock.records.size).toBe(1);
  expect(mock.records.get(id(2))?.surface).toBe("radar");
  expect(mock.records.has(id(1))).toBe(false);
  await page.clock.runFor(60_000);
  expect(mock.requests.filter(r => r.path.endsWith("/reading-signals"))).toHaveLength(1);
  expect(mock.pageErrors).toEqual([]);
  expect(mock.unexpected).toEqual([]);
});

test("article changes never transfer dwell and updated content gets its own version", async ({ page }) => {
  const mock = await mockReading(page);
  await page.clock.install();
  await page.goto("/radar");
  const pane = await openArticle(page);
  await page.clock.runFor(15_000);
  await pane.getByRole("button", { name: "下一篇", exact: true }).click();
  await expect(pane.getByRole("heading", { name: "阅读学习测试文章 2", exact: true })).toBeVisible();
  await pane.focus();
  await page.clock.runFor(10_000);
  expect(mock.records.size).toBe(0);
  mock.articles[1].contentVersion = 2;
  await pane.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect.poll(() => mock.requests.filter(r => r.path === `/api/v1/events/${id(2)}`).length).toBe(2);
  await pane.focus();
  await page.clock.runFor(15_000);
  expect(mock.records.size).toBe(0);
  await page.clock.runFor(8_000);
  await expect.poll(() => mock.records.size).toBe(1);
  expect(mock.records.get(id(2))?.contentVersion).toBe(2);
  expect(mock.unexpected).toEqual([]);
});

for (const width of [1440, 390]) test(`enabling learning then opening an article keeps the new reading focus at ${width}px`, async ({ page }) => {
  const mock = await mockReading(page, false);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.clock.install();
  await page.goto("/radar");
  if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "隐私与使用统计", exact: true });
  await dialog.getByRole("switch", { name: "根据我的站内阅读调整推荐" }).click();
  await expect(dialog.getByText("已开启，将从新的站内阅读逐步积累兴趣。", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  if (width === 390) await page.getByRole("button", { name: "关闭导航", exact: true }).click();
  await page.locator(`article[data-event-id="${id(1)}"]`).getByRole("button", { name: "阅读学习测试文章 1", exact: true }).click();
  const pane = page.getByRole("article", { name: "文章就地阅读", exact: true });
  await expect(pane.getByRole("button", { name: "复制分享文字", exact: true })).toBeVisible();
  await expect(pane).toBeFocused();
  await page.clock.runFor(23_000);
  await expect(pane).toBeFocused();
  await expect.poll(() => mock.records.size).toBe(1);
  expect(mock.unexpected).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});

test("signal failure is visible and explicit retry does not require another 20 seconds", async ({ page }) => {
  const mock = await mockReading(page);
  mock.failNext();
  await page.clock.install();
  await page.goto("/radar");
  await openArticle(page);
  await page.clock.runFor(22_000);
  await expect(page.getByText("阅读兴趣信号尚未保存", { exact: true })).toBeVisible();
  expect(mock.records.size).toBe(0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => mock.records.size).toBe(1);
  await expect(page.getByText("阅读兴趣信号尚未保存", { exact: true })).toHaveCount(0);
  expect(mock.requests.filter(r => r.path.endsWith("/reading-signals"))).toHaveLength(2);
});

test("clearing during an in-flight response cannot restore old learning", async ({ page }) => {
  const mock = await mockReading(page);
  const release = mock.holdSignals();
  await page.clock.install();
  await page.goto("/radar");
  await openArticle(page);
  await page.clock.runFor(22_000);
  await expect.poll(() => mock.records.size).toBe(1);
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await page.getByRole("button", { name: "清空学习记录", exact: true }).click();
  await page.getByRole("button", { name: "确认清空学习记录", exact: true }).click();
  await expect(page.getByText("学习记录已清空。", { exact: true })).toBeVisible();
  release();
  await page.clock.runFor(2_000);
  expect(mock.settings().signalCount).toBe(0);
  await expect(page.getByText(/过去30天已积累 0 篇阅读信号/)).toBeVisible();
  await expect(page.getByRole("switch", { name: "根据我的站内阅读调整推荐" })).toBeChecked();
  await page.getByRole("switch", { name: "根据我的站内阅读调整推荐" }).click();
  await page.getByRole("button", { name: "关闭并删除学习信号", exact: true }).click();
  await expect(page.getByText("已关闭，学习信号已删除。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("article", { name: "文章就地阅读" }).focus();
  await page.clock.runFor(30_000);
  expect(mock.requests.filter(r => r.path.endsWith("/reading-signals"))).toHaveLength(1);
  expect(mock.pageErrors).toEqual([]);
});

for (const [width, scheme] of [[1440, "light"], [390, "dark"]] as const) test(`disabling populated learning confirms consequences, preserves keyboard focus, and exposes failed saves at ${width}px ${scheme}`, async ({ page }, info) => {
  const mock = await mockReading(page);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.clock.install();
  await page.goto("/radar");
  await openArticle(page);
  await page.clock.runFor(22_000);
  await expect.poll(() => mock.records.size).toBe(1);
  await page.keyboard.press("Escape");
  if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "隐私与使用统计", exact: true });
  const toggle = dialog.getByRole("switch", { name: "根据我的站内阅读调整推荐" });
  await toggle.focus();
  await page.keyboard.press("Space");
  const confirmation = dialog.getByRole("group", { name: "关闭阅读学习确认", exact: true });
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toContainText("删除已积累的 1 篇阅读信号");
  expect(mock.requests.filter(r => r.path.endsWith("/reading-personalization") && r.method === "PUT")).toHaveLength(0);
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button", { name: "关闭并删除学习信号", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button", { name: "取消关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.clock.runFor(100);
  await expect(toggle).toBeFocused();
  await expect(toggle).toBeChecked();
  expect(mock.settings().signalCount).toBe(1);

  await page.keyboard.press("Space");
  await expect(confirmation).toBeFocused();
  await page.screenshot({ path: info.outputPath("reading-disable-confirmation.png"), animations: "disabled" });
  mock.failNextSettings();
  const release = mock.holdSettings();
  await page.keyboard.press("Tab");
  const confirm = confirmation.getByRole("button", { name: "关闭并删除学习信号", exact: true });
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await expect(confirm).toBeFocused();
  await page.screenshot({ path: info.outputPath("reading-disable-pending.png"), animations: "disabled" });
  release();
  await expect(dialog.getByRole("alert")).toContainText("阅读学习设置未保存");
  await expect(toggle).toBeChecked();
  expect(mock.settings().signalCount).toBe(1);
  await page.screenshot({ path: info.outputPath("reading-disable-failure.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "重试", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.clock.runFor(100);
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeFocused();
  expect(mock.settings().signalCount).toBe(0);
  expect(mock.unexpected).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});

test("public privacy copy and forced-colors learning confirmation remain readable on mobile", async ({ page }, info) => {
  const mock = await mockReading(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/privacy");
  await page.getByRole("heading", { name: "可选择的阅读兴趣学习", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reading-privacy-page-390.png"), animations: "disabled" });
  await page.goto("/radar");
  await page.emulateMedia({ forcedColors: "active" });
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await page.getByRole("switch", { name: "根据我的站内阅读调整推荐" }).focus();
  await page.keyboard.press("Space");
  const confirmation = page.getByRole("group", { name: "关闭阅读学习确认", exact: true });
  await expect(confirmation).toBeFocused();
  await page.screenshot({ path: info.outputPath("reading-confirmation-forced-colors-390.png"), animations: "disabled" });
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button", { name: "关闭并删除学习信号", exact: true })).toBeFocused();
  expect(mock.unexpected).toEqual([]);
  expect(mock.pageErrors).toEqual([]);
});

test("WebKit mobile reading qualifies without a second original-source click", async () => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL,
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const mock = await mockReading(page);
    await page.clock.install();
    await page.goto("/radar");
    await openArticle(page);
    await page.clock.runFor(23_000);
    await expect.poll(() => mock.records.size).toBe(1);
    expect(mock.records.get(id(1))?.contentVersion).toBe(1);
    expect(mock.unexpected).toEqual([]);
    expect(mock.pageErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});

for (const [width, scheme] of [[1440, "light"], [1280, "light"], [1024, "light"], [768, "light"], [390, "light"], [390, "dark"]] as const) {
  test(`privacy learning controls are usable at ${width}px ${scheme}`, async ({ page }, info) => {
    const mock = await mockReading(page, false);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/radar");
    if (width <= 768) await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "隐私与使用统计", exact: true });
    await expect(dialog.getByRole("heading", { name: "阅读兴趣学习", exact: true })).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "根据我的站内阅读调整推荐" })).not.toBeChecked();
    await page.screenshot({ path: info.outputPath(`reading-privacy-initial-${width}-${scheme}.png`), animations: "disabled" });
    await dialog.getByRole("switch", { name: "根据我的站内阅读调整推荐" }).click();
    await expect(dialog.getByText("已开启，将从新的站内阅读逐步积累兴趣。", { exact: true })).toBeVisible();
    expect(mock.settings().enabled).toBe(true);
    expect(mock.requests.some(r => r.path.endsWith("/telemetry") || r.path.endsWith("/telemetry-consent"))).toBe(false);
    await dialog.getByRole("button", { name: "清空学习记录", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "取消清空", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "取消清空", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "清空学习记录", exact: true })).toBeFocused();
    expect(mock.requests.some(r => r.method === "DELETE")).toBe(false);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`reading-privacy-${width}-${scheme}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "导出我的数据", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "导出我的数据", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`reading-privacy-bottom-${width}-${scheme}.png`), animations: "disabled" });
    await dialog.getByRole("heading", { name: "阅读兴趣学习", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("heading", { name: "阅读兴趣学习", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(mock.unexpected).toEqual([]);
    expect(mock.pageErrors).toEqual([]);
  });
}
