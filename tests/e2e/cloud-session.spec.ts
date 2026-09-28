import { expect, test, type Page } from "@playwright/test";
import type { ReaderSession } from "../../apps/web/src/types";

async function markCloud(page: Page) {
  await page.addInitScript(() => {
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
}
async function trackRecoveryUi(page: Page) {
  await page.addInitScript(() => {
    const track = () => {
      if (document.querySelector(".ns-session-confirmation")) document.documentElement.dataset.testRecoveryOpened = "true";
    };
    const observer = new MutationObserver(track);
    observer.observe(document, { childList: true, subtree: true });
    track();
    document.addEventListener("focusin", event => {
      if (event.target instanceof Element && event.target.closest(".ns-session-confirmation")) document.documentElement.dataset.testRecoveryFocused = "true";
    });
  });
}
async function moveWindowAway(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new FocusEvent("blur"));
  });
}
async function returnToWindow(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

async function mockSession(page: Page, authenticated = true) {
  const requests: { path: string; method: string; csrf: string | undefined; data: unknown }[] = [];
  let consent = false;
  let sessionDelay: Promise<void> | undefined;
  const session: ReaderSession = {
    user: { id: "3e08a7b7-1f2c-4adf-90e4-0e276caa0e55", displayName: "受控试用账号" },
    capabilities: { manageReadingSettings: false }, csrfToken: "controlled-session-csrf", telemetryConsent: false,
  };
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const data: unknown = request.postData() ? request.postDataJSON() : null;
    requests.push({ path, method: request.method(), csrf: request.headers()["x-csrf-token"], data });
    if (!authenticated) return route.fulfill({ status: 401, json: { error: "请登录后使用。" } });
    if (path === "/api/v1/session") {
      const value = { ...session, user: { ...session.user }, telemetryConsent: consent };
      await sessionDelay;
      return route.fulfill({ json: value });
    }
    if (path === "/api/v1/me/telemetry-consent") {
      if (request.headers()["x-csrf-token"] !== session.csrfToken) return route.fulfill({ status: 403, json: { error: "csrf_required" } });
      consent = request.postDataJSON().enabled === true;
      return route.fulfill({ json: { enabled: consent } });
    }
    if (path === "/api/v1/telemetry") return route.fulfill({ status: consent ? 200 : 403, json: consent ? { accepted: 1 } : { error: "consent_required" } });
    if (path === "/api/v1/me/export") return route.fulfill({ json: { userId: session.user.id, interests: [], states: [] } });
    if (path === "/api/v1/runtime") return route.fulfill({ json: { mode: "postgres", version: "fixture", timeZone: "Asia/Shanghai" } });
    return route.fulfill({ json: { items: [] } });
  });
  return {
    requests, session, revoke: () => { authenticated = false; },
    holdSession: () => {
      let release = () => {};
      sessionDelay = new Promise<void>(resolve => { release = resolve; });
      return () => { sessionDelay = undefined; release(); };
    },
  };
}

test("cloud requires login before loading private pages and keeps privacy available", async ({ page }, info) => {
  await markCloud(page);
  const { requests } = await mockSession(page, false);
  await page.goto("/sources");
  const microsoft = page.getByRole("link", { name: "使用 Microsoft 账户登录", exact: true });
  const customer = page.getByRole("link", { name: "使用邮箱注册或登录", exact: true });
  await expect(microsoft).toHaveAttribute("href", "/.auth/login/aad?post_login_redirect_uri=%2Fsources");
  await expect(customer).toHaveAttribute("href", "/.auth/login/newsscout-account?post_login_redirect_uri=%2Fsources");
  await expect(page.getByText("无需再提交申请或等待人工批准", { exact: false })).toBeVisible();
  expect(requests.every(request => request.path === "/api/v1/session")).toBe(true);
  await page.screenshot({ path: info.outputPath("cloud-sign-in.png") });
  await page.getByRole("link", { name: "数据与隐私说明", exact: true }).click();
  await expect(page.getByRole("heading", { name: "数据与隐私", exact: true })).toBeVisible();
});

for (const revokeOn of ["focus", "private-write"] as const) test(`expired authentication discards private data on ${revokeOn}`, async ({ page }) => {
  await markCloud(page);
  await mockSession(page);
  await page.goto("/share");
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await page.route("**/api/v1/session", route => route.fulfill({ status: 401, json: { error: "sign_in_required" } }));
  if (revokeOn === "focus") {
    await moveWindowAway(page);
    await returnToWindow(page);
  } else {
    await page.route("**/api/v1/me/telemetry-consent", route => route.fulfill({ status: 401, json: { error: "sign_in_required" } }));
    await page.getByRole("switch", { name: "允许可选的使用统计", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "把值得读的新闻，留在你的阅读空间。", exact: true })).toBeFocused();
  await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true })).toHaveCount(0);
  await expect(page.getByText("受控试用账号", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
});

for (const width of [1440, 1024, 390]) test(`cloud has the full workbench and collection navigation, with only settings withheld at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  const { requests } = await mockSession(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/share");
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`cloud-workbench-${width}.png`) });
  if (width <= 768) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const navigation = page.locator(width <= 768 ? ".ns-reader-mobile-nav" : ".ns-reader-sidebar");
  const tools = navigation.getByRole("navigation", { name: "工具", exact: true });
  await expect(tools.getByRole("link", { name: "今日分享", exact: true })).toBeVisible();
  await expect(tools.getByRole("link", { name: "来源采集", exact: true })).toBeVisible();
  await expect(tools.getByRole("link", { name: "兴趣权重", exact: true })).toBeVisible();
  await expect(tools.getByRole("link", { name: "设置", exact: true })).toHaveCount(0);
  await expect(navigation.getByText("受控试用账号", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("cloud-full-workbench.png") });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "这项设置由服务维护者管理", exact: true })).toBeVisible();
  expect(requests.some(request => request.path.startsWith("/api/v1/model-providers") || request.path.startsWith("/api/v1/processing"))).toBe(false);
});

test("usage analytics requires consent and its write contains the session CSRF token", async ({ page }) => {
  await markCloud(page);
  const { requests, session } = await mockSession(page);
  await page.goto("/share");
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
  expect(requests.some(request => request.path === "/api/v1/telemetry")).toBe(false);
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await page.getByRole("switch", { name: "允许可选的使用统计", exact: true }).click();
  await expect(page.getByRole("switch", { name: "允许可选的使用统计", exact: true })).toBeChecked();
  await expect.poll(() => requests.filter(request => request.path === "/api/v1/telemetry").length).toBeGreaterThan(0);
  for (const request of requests.filter(request => request.method === "POST" || request.method === "PUT")) expect(request.csrf).toBe(session.csrfToken);
  const telemetry = requests.find(request => request.path === "/api/v1/telemetry")!;
  expect(telemetry.data).toEqual({ events: [{ name: "page_view", page: "share" }] });
});

for (const width of [1440, 1024, 390]) test(`a revoked session removes private content and modal focus locks at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  const { requests, revoke } = await mockSession(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/share");
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
  if (width <= 768) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.route("**/api/v1/me/telemetry-consent", route => {
    revoke();
    return route.fulfill({ status: 401, json: { error: "session_expired" } });
  });
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await page.getByRole("switch", { name: "允许可选的使用统计", exact: true }).click();
  await expect(page.getByRole("link", { name: "使用 Microsoft 账户登录", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "把值得读的新闻，留在你的阅读空间。", exact: true })).toBeFocused();
  expect(requests.filter(request => request.path === "/api/v1/session")).toHaveLength(2);
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText("受控试用账号", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`cloud-expired-session-${width}.png`) });
});

for (const width of [768, 390]) test(`mobile privacy controls stay open and restore focus to navigation at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  await mockSession(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/share");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const trigger = page.getByRole("button", { name: "隐私与使用统计", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "隐私与使用统计", exact: true });
  await dialog.getByRole("switch", { name: "允许可选的使用统计", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "允许可选的使用统计", exact: true })).toBeChecked();
  await page.screenshot({ path: info.outputPath(`cloud-mobile-privacy-${width}.png`) });
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("link", { name: "查看数据说明", exact: true }).click();
  await expect(page.getByRole("heading", { name: "数据与隐私", exact: true })).toBeVisible();
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
});

for (const width of [1440, 1024, 390]) test(`focus revalidates a fresh session without replacing the workbench at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  const { requests, holdSession } = await mockSession(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/share");
  if (width <= 768) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const navigation = page.locator(width <= 768 ? ".ns-reader-mobile-nav" : ".ns-reader-sidebar");
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "允许可选的使用统计", exact: true }).focus();
  await moveWindowAway(page);
  const release = holdSession();
  const before = requests.filter(request => request.path === "/api/v1/session").length;
  try {
    await returnToWindow(page);
    await expect.poll(() => requests.filter(request => request.path === "/api/v1/session").length).toBeGreaterThan(before);
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
    await expect(navigation.getByText("受控试用账号", { exact: true })).toBeAttached();
    await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true })).toBeVisible();
    await expect(page.locator(".ns-session-private h1").filter({ hasText: /^今日分享$/ })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-session-validation", "pending");
    await page.screenshot({ path: info.outputPath(`cloud-verifying-session-${width}.png`) });
  } finally { release(); }
  await expect(page.locator(".ns-session-shield")).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "允许可选的使用统计", exact: true })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "允许可选的使用统计", exact: true })).toBeFocused();
});

test("a successful account switch discards the previous document before accepting the next identity", async ({ page }) => {
  await markCloud(page);
  const { session, holdSession } = await mockSession(page);
  await page.goto("/share");
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await moveWindowAway(page);
  session.user = { id: "228f163e-0903-4ddc-98cf-3f4b4e15172e", displayName: "另一位试用账号" };
  session.csrfToken = "second-reader-csrf";
  const release = holdSession();
  try {
    await returnToWindow(page);
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
    await expect(page.getByText("受控试用账号", { exact: true })).toBeVisible();
  } finally { release(); }
  await expect(page.getByText("另一位试用账号", { exact: true })).toBeVisible();
  await expect(page.getByText("受控试用账号", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true })).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden", "true");
});

test("a paused mutation from the previous account cannot resume into the new account", async ({ page }) => {
  await markCloud(page);
  const { requests, session } = await mockSession(page);
  await page.goto("/share");
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  try {
    // Pause Query's network queue without blocking the already-authorized session response or reload.
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.getByRole("switch", { name: "允许可选的使用统计", exact: true }).click();
    await expect(page.getByRole("switch", { name: "允许可选的使用统计", exact: true })).toBeDisabled();
    expect(requests.filter(request => request.path === "/api/v1/me/telemetry-consent")).toHaveLength(0);
    await moveWindowAway(page);
    session.user = { id: "228f163e-0903-4ddc-98cf-3f4b4e15172e", displayName: "另一位试用账号" };
    session.csrfToken = "second-reader-csrf";
    await returnToWindow(page);
    await expect(page.getByText("另一位试用账号", { exact: true })).toBeVisible();
  } finally { await page.evaluate(() => window.dispatchEvent(new Event("online"))); }
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
  expect(requests.filter(request => request.path === "/api/v1/me/telemetry-consent")).toHaveLength(0);
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await expect(page.getByRole("switch", { name: "允许可选的使用统计", exact: true })).not.toBeChecked();
});

for (const width of [1440, 390]) test(`failed background verification preserves private content behind recovery at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  await mockSession(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/share");
  if (width <= 768) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const navigation = page.locator(width <= 768 ? ".ns-reader-mobile-nav" : ".ns-reader-sidebar");
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  await page.getByRole("switch", { name: "允许可选的使用统计", exact: true }).focus();
  await moveWindowAway(page);
  await page.route("**/api/v1/session", route => route.fulfill({ status: 503, json: { error: "session_temporarily_unavailable" } }));
  await returnToWindow(page);
  const confirmation = page.locator(".ns-session-confirmation");
  await expect(confirmation.locator('[role="alert"]')).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "重试", exact: true })).toHaveCSS("border-top-style", "solid");
  await expect(confirmation).toContainText("当前页面会保留");
  await expect(navigation.getByText("受控试用账号", { exact: true })).toBeAttached();
  await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true, includeHidden: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "今日分享", exact: true, includeHidden: true })).toHaveCount(1);
  await expect(page.locator(".ns-session-shield")).not.toBeVisible();
  expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`cloud-verification-error-${width}.png`) });
  await page.unroute("**/api/v1/session");
  await confirmation.getByRole("button", { name: "重试", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "允许可选的使用统计", exact: true })).toBeFocused();
});

for (const width of [1440, 390]) test(`fast initial loads and refreshes never open or focus account recovery at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  await trackRecoveryUi(page);
  await mockSession(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/share");
  for (let refresh = 0; refresh < 3; refresh++) {
    await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-test-recovery-opened", "true");
    await expect(page.locator("html")).not.toHaveAttribute("data-test-recovery-focused", "true");
    await expect(page.getByRole("link", { name: "退出并重新登录", exact: true })).toHaveCount(0);
    if (refresh < 2) await page.reload();
  }
  await page.screenshot({ path: info.outputPath(`cloud-fast-refresh-${width}.png`) });
});

for (const width of [1440, 390]) test(`fast focus visibility and reconnect checks preserve the editor without recovery UI at ${width}px`, async ({ page }) => {
  await markCloud(page);
  await trackRecoveryUi(page);
  const { requests } = await mockSession(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/topics");
  const editor = page.getByRole("textbox", { name: "新主题名称", exact: true });
  await editor.fill("尚未保存的私人主题");
  await editor.focus();
  const original = await editor.elementHandle();
  const sessionRequests = () => requests.filter(request => request.path === "/api/v1/session").length;
  const beforeChildFocus = sessionRequests();
  await editor.evaluate(element => {
    element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
  });
  await expect(page.locator("html")).not.toHaveAttribute("data-session-validation", "pending");
  expect(sessionRequests()).toBe(beforeChildFocus);
  for (const event of ["activation", "online"]) {
    const before = sessionRequests();
    const gatedWithoutReplacement = await page.evaluate(type => {
      if (type === "activation") {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new FocusEvent("blur"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new FocusEvent("focus"));
      } else window.dispatchEvent(new Event(type));
      return document.documentElement.dataset.sessionValidation === "pending" &&
        getComputedStyle(document.querySelector(".ns-session-private")!).visibility !== "hidden";
    }, event);
    expect(gatedWithoutReplacement).toBe(true);
    await expect.poll(sessionRequests).toBe(before + 1);
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("尚未保存的私人主题");
    await expect(editor).toBeFocused();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await expect(page.locator("html")).not.toHaveAttribute("data-test-recovery-opened", "true");
    await expect(page.locator("html")).not.toHaveAttribute("data-test-recovery-focused", "true");
  }
});

for (const width of [1440, 390]) test(`initial verification shows only public geometry, then delayed status and slow recovery at ${width}px`, async ({ page }, info) => {
  await markCloud(page);
  const { requests, holdSession } = await mockSession(page);
  const release = holdSession();
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: new Date("2026-09-22T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-22T00:01:00Z"));
  try {
    await page.goto("/share");
    await expect(page.locator(".ns-session-shield")).toBeVisible();
    await expect.poll(() => requests.filter(request => request.path === "/api/v1/session").length).toBeGreaterThan(0);
    await expect(page.locator(".ns-session-private")).toHaveCount(0);
    await expect(page.locator(".ns-session-status")).toBeEmpty();
    await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
    expect(requests.every(request => request.path === "/api/v1/session")).toBe(true);
    await page.screenshot({ path: info.outputPath(`cloud-initial-quiet-${width}.png`) });
    await page.clock.runFor(499);
    await expect(page.locator(".ns-session-status")).toBeEmpty();
    await page.clock.runFor(1);
    await expect(page.locator(".ns-session-status")).toHaveText("正在连接阅读空间…");
    await page.screenshot({ path: info.outputPath(`cloud-initial-waiting-${width}.png`) });
    await page.clock.runFor(7_499);
    await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
    await page.clock.runFor(1);
    const recovery = page.getByRole("dialog", { name: "连接时间有些久", exact: true });
    await expect(recovery).toBeVisible();
    await expect(recovery.getByRole("heading", { name: "连接时间有些久", exact: true })).toBeFocused();
    await expect.poll(async () => (await recovery.getByRole("button", { name: "重新连接", exact: true }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await recovery.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`cloud-initial-slow-${width}.png`) });
    await page.clock.resume();
    await page.keyboard.press("Escape");
    await expect(recovery).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(recovery.getByRole("button", { name: "重新连接", exact: true })).toBeFocused();
    if (width === 390) {
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.screenshot({ path: info.outputPath("cloud-initial-slow-dark-390.png") });
      await page.emulateMedia({ forcedColors: "active" });
      await page.screenshot({ path: info.outputPath("cloud-initial-slow-forced-colors-390.png") });
      await page.emulateMedia({ forcedColors: "none" });
      await page.evaluate(() => { delete document.documentElement.dataset.theme; });
    }
    const beforeRetry = requests.filter(request => request.path === "/api/v1/session").length;
    await recovery.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect.poll(() => requests.filter(request => request.path === "/api/v1/session").length).toBe(beforeRetry + 1);
  } finally {
    release();
    await page.clock.resume();
  }
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
  await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
});

test("activation bursts share one verification and time away never opens slow recovery", async ({ page }) => {
  await markCloud(page);
  await trackRecoveryUi(page);
  const { requests, holdSession } = await mockSession(page);
  await page.clock.install({ time: new Date("2026-09-22T00:00:00Z") });
  await page.goto("/topics");
  const editor = page.getByRole("textbox", { name: "新主题名称", exact: true });
  await editor.fill("保留未保存的输入");
  await page.clock.pauseAt(new Date("2026-09-22T00:01:00Z"));
  const before = requests.filter(request => request.path === "/api/v1/session").length;
  const release = holdSession();
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new FocusEvent("blur"));
    });
    await page.clock.runFor(60_000);
    await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
    await expect(page.locator(".ns-session-status")).toBeEmpty();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("保留未保存的输入");
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new FocusEvent("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await page.clock.runFor(49);
    expect(requests.filter(request => request.path === "/api/v1/session")).toHaveLength(before);
    await expect(page.locator("html")).toHaveAttribute("data-session-validation", "pending");
    await page.clock.runFor(1);
    await expect.poll(() => requests.filter(request => request.path === "/api/v1/session").length).toBe(before + 1);
    await page.evaluate(() => {
      window.dispatchEvent(new FocusEvent("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
    });
    await page.clock.runFor(499);
    await expect(page.locator(".ns-session-status")).toBeEmpty();
    await page.clock.runFor(1);
    await expect(editor).toBeVisible();
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    expect(requests.filter(request => request.path === "/api/v1/session")).toHaveLength(before + 1);
    await expect(page.locator("html")).not.toHaveAttribute("data-test-recovery-opened", "true");
  } finally {
    release();
    await page.clock.resume();
  }
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("保留未保存的输入");
  await expect(editor).toBeFocused();
  expect(requests.filter(request => request.path === "/api/v1/session")).toHaveLength(before + 1);
});

test("initial verification errors provide accessible recovery without mounting private pages", async ({ page }) => {
  await markCloud(page);
  const { requests } = await mockSession(page);
  await page.route("**/api/v1/session", route => route.fulfill({ status: 503, json: { error: "session_temporarily_unavailable" } }));
  await page.goto("/share");
  const recovery = page.getByRole("dialog", { name: "阅读空间暂时无法连接", exact: true });
  await expect(recovery.getByRole("alert")).toBeVisible();
  await expect(recovery.getByRole("heading", { name: "阅读空间暂时无法连接", exact: true })).toBeFocused();
  await expect(page.locator(".ns-session-private")).toHaveCount(0);
  expect(requests.every(request => request.path === "/api/v1/session")).toBe(true);
  await page.unroute("**/api/v1/session");
  await recovery.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
});

test("slow background verification restores nested private dialogs and unsaved edits at 390px", async ({ page }, info) => {
  await markCloud(page);
  const { requests, holdSession } = await mockSession(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.clock.install({ time: new Date("2026-09-22T00:00:00Z") });
  await page.goto("/topics");
  const editor = page.locator(".ns-add-topic input").first();
  await editor.fill("慢连接也不能丢失的草稿");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "隐私与使用统计", exact: true }).click();
  const consent = page.getByRole("switch", { name: "允许可选的使用统计", exact: true });
  await consent.focus();
  await page.clock.pauseAt(new Date("2026-09-22T00:01:00Z"));
  await moveWindowAway(page);
  const before = requests.filter(request => request.path === "/api/v1/session").length;
  const release = holdSession();
  try {
    await returnToWindow(page);
    await page.clock.runFor(50);
    await expect.poll(() => requests.filter(request => request.path === "/api/v1/session").length).toBe(before + 1);
    await page.clock.runFor(500);
    await expect(page.locator(".ns-session-shield")).not.toBeVisible();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("慢连接也不能丢失的草稿");
    await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
    await page.clock.runFor(7_500);
    const recovery = page.getByRole("dialog", { name: "连接时间有些久", exact: true });
    await expect(recovery).toBeVisible();
    await expect(page.getByRole("dialog", { name: "隐私与使用统计", exact: true, includeHidden: true })).toHaveCount(1);
    const accounts = page.getByText("受控试用账号", { exact: true });
    await expect(accounts).toHaveCount(2);
    expect(await accounts.evaluateAll(elements => elements.filter(element => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    }).length)).toBe(1);
    await page.screenshot({ path: info.outputPath("cloud-background-slow-390.png") });
  } finally {
    release();
    await page.clock.resume();
  }
  await expect(page.locator(".ns-session-confirmation")).not.toBeVisible();
  await expect(consent).toBeFocused();
  await expect(consent).not.toBeChecked();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator('.ns-reader-mobile-nav button[aria-label="关闭导航"]').click();
  await expect(editor).toHaveValue("慢连接也不能丢失的草稿");
});
