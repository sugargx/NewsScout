const { chromium, request, expect } = require("@playwright/test");
const { mkdir, readdir, writeFile } = require("node:fs/promises");
const { resolve, join, sep } = require("node:path");

const root = resolve(__dirname, "..");
const options = { baseUrl: "http://127.0.0.1:5190", output: "", scope: "full" };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!value || !["--base-url", "--output", "--scope"].includes(key)) throw new Error("Usage: npm run ui:review -- [--base-url URL] [--output tmp\\ui-reviews\\RUN] [--scope full|width-focus|interests]");
  options[key === "--base-url" ? "baseUrl" : key === "--scope" ? "scope" : "output"] = value;
}
if(!["full","width-focus","interests"].includes(options.scope))throw new Error("Review scope must be full, width-focus or interests.");
const origin = new URL(options.baseUrl);
const local = origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname);
const tunnel = origin.protocol === "https:" && origin.hostname.endsWith(".devtunnels.ms");
if ((!local && !tunnel) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("Use a loopback public reader or an HTTPS Dev Tunnel origin.");
const output = resolve(root, options.output || join("tmp", "ui-reviews", new Date().toISOString().replace(/[:.]/g, "-")));
if (!output.startsWith(resolve(root, "tmp", "ui-reviews") + sep)) throw new Error("Review output must be a named directory under tmp\\ui-reviews.");
const headers = tunnel ? { "X-Tunnel-Skip-AntiPhishing-Page": "1" } : {};
const report = { startedAt: new Date().toISOString(), origin: origin.origin, scope: options.scope, content: "live retained public material", captures: [], interactions: [], pageErrors: [], blockedRequests: [] };

async function capture(page, name, width, theme, simulated = false) {
  const filename = `${name}-${theme}-${width}.png`;
  const metrics = await page.evaluate(() => {
    const visible = element => element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const box = element => {
      if (!element) return null;
      const rectangle = element.getBoundingClientRect(), style = getComputedStyle(element);
      return {
        x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
        fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color,
        background: style.backgroundColor, radius: style.borderRadius,
      };
    };
    const navigation = [...document.querySelectorAll('nav[aria-label="公开阅读视图"]')].find(visible);
    const story = document.querySelector(".ns-reader-story");
    const interestDialog = document.querySelector(".ns-public-interest-dialog");
    const titles = [...document.querySelectorAll(".ns-reader-start h2, .ns-beta-feed > article > h3, .ns-beta-feed .ns-reader-row-title, .ns-beta-feed > button > strong, .ns-topic-article > strong")].filter(visible);
    const contentBottom = navigation && getComputedStyle(navigation).position === "fixed" ? navigation.getBoundingClientRect().top : innerHeight;
    return {
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      forcedColors:matchMedia("(forced-colors: active)").matches,
      theme: document.documentElement.dataset.theme, sidebar: box(document.querySelector(".ns-reader-sidebar")),
      main: box(document.getElementById("main-content")), detail: box(document.querySelector(".ns-beta-reader")),
      interestDialog: interestDialog ? {
        surface:box(interestDialog),content:box(interestDialog.querySelector(".ns-interest-content")),
        footer:box(interestDialog.querySelector(".ns-interest-actions")),
        choices:[...interestDialog.querySelectorAll(".ns-interest-option")].map(element=>({
          label:element.querySelector(".fui-Checkbox__label")?.textContent,selected:element.dataset.selected,
          checkbox:box(element.querySelector(".fui-Checkbox")),indicator:box(element.querySelector(".fui-Checkbox__indicator")),
          labelBox:box(element.querySelector(".fui-Checkbox__label")),priority:box(element.querySelector(".fui-Select")),
        })),
      } : null,
      pageHeading: box(document.querySelector("#main-content h1")),
      storyText: box(story?.querySelector(".ns-reader-story-preview")??story?.querySelector(".ns-reader-story-body")),
      firstStory: box(story),
      storyTitle: box(document.querySelector(".ns-reader-story-title")),
      storyActions: box(document.querySelector(".ns-reader-story-actions")),
      readingValue: box(document.querySelector(".ns-reading-value[open] p")),
      focused: document.activeElement instanceof HTMLElement ? {
        tag:document.activeElement.tagName,role:document.activeElement.getAttribute("role"),
        focusVisible:document.activeElement.matches(":focus-visible"),
        outline:getComputedStyle(document.activeElement).outline,
        outlineOffset:getComputedStyle(document.activeElement).outlineOffset,
        boxShadow:getComputedStyle(document.activeElement).boxShadow,
        borderColor:getComputedStyle(document.activeElement).borderColor,
        controlUnderline:document.activeElement.closest(".fui-Select,.fui-Input")
          ?getComputedStyle(document.activeElement.closest(".fui-Select,.fui-Input"),"::after").transform:null,
        controlFocusStroke:document.activeElement.closest(".fui-Select,.fui-Input")
          ?getComputedStyle(document.activeElement.closest(".fui-Select,.fui-Input"),"::after").borderBottomWidth:null,
      }:null,
      readingPosition: document.querySelector(".ns-reader-position")?.textContent.trim() || null,
      radarModes: [...document.querySelectorAll(".ns-radar-viewbar [role=tab]")].map(element=>({label:element.querySelector(".fui-Tab__content")?.textContent.trim(),selected:element.getAttribute("aria-selected")})),
      topicWorkspace: document.querySelector(".ns-topic-workspace") ? {
        sample:document.querySelector(".ns-topic-sample")?.textContent.trim(),
        results:document.querySelector(".ns-topic-results-status")?.textContent.trim(),
        visibleArticles:document.querySelectorAll(".ns-topic-article").length,
        selectedTopic:document.querySelector('[data-topic-id][aria-pressed=true]')?.getAttribute("data-topic-id")??null,
      } : null,
      controls: [...(interestDialog??document).querySelectorAll(".ns-reader-button, .ns-reader-tabs [role=tab], .ns-network-toolbar button, .ns-network-satellites button, select, input:not([type=checkbox])")]
        .filter(element => { const r = element.getBoundingClientRect(); return visible(element) && r.bottom > 0 && r.top < innerHeight; })
        .map(element => ({ label: element.getAttribute("aria-label") || element.textContent.trim(), disabled: element.disabled, ...box(element) })),
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map(element => ({ text: element.innerText, ...box(element) })),
      navigation: navigation ? [...navigation.querySelectorAll("a,button")].filter(visible).map(element => ({
        label: element.getAttribute("aria-label") || element.textContent.trim(), ...box(element),
      })) : [],
      headlinesInViewport: titles.filter(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= contentBottom; }).length,
      firstHeadline: box(titles[0]),
    };
  });
  await page.screenshot({ path: join(output, filename), fullPage: false });
  report.captures.push({ name, filename, width, theme, simulated, url: page.url(), metrics });
}

async function openFirst(page, reading = false) {
  const direct = reading ? page.getByRole("button",{name:"从第 1 篇开始",exact:true}) : page.locator(".ns-beta-feed > article[data-public-event] > h3 > button, .ns-beta-feed .ns-reader-row-title > button");
  if (await direct.count()) await direct.first().click();
  else {
    const group = page.locator(".ns-beta-feed .cp-coverage").first();
    await group.locator(":scope > summary").click();
    await group.locator(".cp-coverage-member h3 button").first().click();
  }
  const detail = page.getByRole("complementary", { name: "公开文章阅读区", exact: true });
  await expect(detail.locator("h2.ns-preview-title")).toBeVisible();
  await expect(detail.locator("[data-reader-skeleton]")).toHaveCount(0, { timeout: 45_000 });
}

async function reviewPage(browser, width, theme) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme,
    reducedMotion: "reduce", serviceWorkers: "block", extraHTTPHeaders: headers,
  });
  await context.route(/\/(?:api|beta\/api)\//, route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      report.blockedRequests.push(`${req.method()} ${path}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  return { context, page };
}

async function captureRecovery(browser, theme) {
  for (const state of ["loading", "error"]) {
    const { context, page } = await reviewPage(browser, 390, theme);
    const releases = [], pending = [];
    try {
      await context.route(/\/beta\/api\/reading(?:\/sources|\?)/, route => {
        if (route.request().method() !== "GET") return route.fallback();
        if (state === "error") return route.fulfill({ status: 503, json: { error: "UI review: simulated public service unavailable." } });
        const held = new Promise(resolve => releases.push(resolve)).then(() => route.abort("aborted"));
        pending.push(held);
        return held;
      });
      await page.goto(origin.origin + "/reading");
      if (state === "loading") await expect(page.locator('[data-reader-skeleton="queue"]')).toBeVisible();
      else await expect(page.getByRole("alert").filter({ hasText: "阅读队列暂时不可用" })).toBeVisible({ timeout: 30_000 });
      await capture(page, `reading-${state}`, 390, theme, true);
    } finally {
      releases.forEach(release => release());
      await Promise.all(pending);
      await context.close();
    }
  }
  for(const state of ["loading","error","empty"]) {
      const {context,page}=await reviewPage(browser,390,theme);
      const pending=[];
      let release;
      const gate=new Promise(resolve=>{release=resolve;});
      try {
        await context.route(/\/beta\/api\/explore\?/,async route=>{
          if(state==="loading"){const held=gate.then(()=>route.abort("aborted"));pending.push(held);return held;}
          if(state==="error")return route.fulfill({status:503,json:{error:"UI review: simulated topic service unavailable."}});
          return route.fulfill({json:{sampleSize:0,limit:100,meaning:"Simulated empty topic scope",nodes:[],edges:[]}});
        });
        await page.goto(origin.origin+"/radar?view=topics");
        if(state==="loading")await expect(page.locator('[data-reader-skeleton="map"]')).toBeVisible();
        else if(state==="error")await expect(page.getByRole("alert").filter({hasText:"主题探索加载失败"})).toBeVisible({timeout:30_000});
        else await expect(page.getByRole("heading",{name:"这个范围还没有主题",exact:true})).toBeVisible();
        await capture(page,`topics-${state}`,390,theme,true);
      } finally {release();await Promise.all(pending);await context.close();}
  }
}

async function captureWidthFocus(browser) {
  for(const theme of ["light","dark"])for(const width of [1440,1920,390]) {
    const {context,page}=await reviewPage(browser,width,theme);
    try {
      await page.goto(origin.origin+"/");
      await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toBeVisible({timeout:45_000});
      const edition=page.getByLabel("晨报版本",{exact:true});
      await edition.click();
      await expect.poll(()=>edition.evaluate(element=>getComputedStyle(element.closest(".fui-Select"),"::after").transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
      await capture(page,"brief-select-pointer",width,theme);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
      await expect(edition).toBeFocused();
      await capture(page,"brief-select-keyboard",width,theme);
      await page.goto(origin.origin+"/radar");
      await expect(page.locator(".ns-beta-feed .ns-reader-row").first()).toBeVisible({timeout:45_000});
      await capture(page,"radar-list-width",width,theme);
      const value=page.locator(".ns-reader-row .ns-reading-value").first();
      await expect(value).toBeVisible({timeout:45_000});
      await value.locator("summary").click();
      await capture(page,"radar-value-width",width,theme);
    } finally {await context.close();}
  }
}

async function captureInterests(browser) {
  const profile="agents:100,psychology:80";
  for(const theme of ["light","dark"])for(const width of theme==="light"?[1280,1024,768,390]:[1280,390]) {
    const {context,page}=await reviewPage(browser,width,theme);
    const dialog=page.getByRole("dialog",{name:"兴趣主题",exact:true});
    try {
      await page.goto(origin.origin+"/radar?hours=720");
      await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toBeVisible({timeout:45_000});
      await capture(page,"interests-entry",width,theme);
      await page.getByRole("button",{name:/^兴趣主题/}).click();
      await dialog.getByRole("checkbox",{name:"Agent 与工具",exact:true}).check();
      await dialog.getByLabel("Agent 与工具关注程度",{exact:true}).selectOption("100");
      await dialog.getByRole("checkbox",{name:"心理与认知",exact:true}).check();
      await dialog.getByLabel("Agent 与工具关注程度",{exact:true}).focus();
      await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
      await capture(page,"interests-editor",width,theme);
      if(width===390) {
        await dialog.getByRole("button",{name:"保存并应用",exact:true}).focus();
        await dialog.locator(".ns-interest-content").evaluate(element=>{element.scrollTop=element.scrollHeight;});
        await capture(page,"interests-editor-bottom",width,theme);
        await page.emulateMedia({forcedColors:"active",colorScheme:theme,reducedMotion:"reduce"});
        await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");
        await capture(page,"interests-save-forced-colors",width,theme);
        await page.emulateMedia({forcedColors:"none",colorScheme:theme,reducedMotion:"reduce"});
      }
      const applied=page.waitForResponse(response=>{
        const url=new URL(response.url());
        return url.pathname==="/beta/api/events"&&url.searchParams.get("interests")===profile&&url.searchParams.get("offset")==="0";
      },{timeout:45_000});
      if(width===390) {
        await dialog.getByRole("button",{name:"保存并应用",exact:true}).hover();
        await page.mouse.down();
        await capture(page,"interests-save-pointer",width,theme);
        await page.mouse.up();
      } else await dialog.getByRole("button",{name:"保存并应用",exact:true}).click();
      const response=await applied;
      expect(response.status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toBeVisible({timeout:45_000});
      await expect(page.getByRole("button",{name:"兴趣主题（已选 2 项）",exact:true})).toBeVisible();
      report.interactions.push({width,theme,profile,status:response.status(),scope:"full-corpus recommended GET"});
      await capture(page,"interests-applied",width,theme);
      if(theme==="light"&&(width===1280||width===390)) {
        await page.getByRole("tab",{name:"主题地图",exact:true}).click();
        await expect(page.getByRole("group",{name:"关键词主题共现图",exact:true})).toBeVisible({timeout:45_000});
        await expect(page.locator(".ns-topic-article").first()).toBeAttached({timeout:45_000});
        await capture(page,"interests-topics",width,theme);
      }
      if(theme==="light"&&width===1280) {
        await page.goto(origin.origin+"/");
        await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toBeVisible({timeout:45_000});
        await expect(page.locator(".ns-beta-section-title")).toContainText("你的兴趣精选");
        await capture(page,"interests-current-selection",width,theme);
        await openFirst(page);
        const active=page.url();
        await page.getByRole("button",{name:/^兴趣主题/}).click();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("complementary",{name:"公开文章阅读区",exact:true})).toBeVisible();
        expect(page.url()).toBe(active);
        report.interactions.push({width,theme,scope:"Escape closes only the interest editor",preservedArticle:true});
      }
      if(theme==="light"&&width===390) {
        await page.evaluate(()=>{
          const original=Storage.prototype.setItem;
          Storage.prototype.setItem=function(key,value){
            if(key==="newsscout-public-interests-v1")throw new DOMException("UI review simulated quota","QuotaExceededError");
            return original.call(this,key,value);
          };
        });
        await page.getByRole("button",{name:/^兴趣主题/}).click();
        await dialog.getByRole("checkbox",{name:"记忆与检索",exact:true}).check();
        await dialog.getByRole("button",{name:"保存并应用",exact:true}).click();
        await expect(dialog.getByRole("alert")).toContainText("此次选择尚未生效");
        await expect.poll(()=>dialog.getByRole("alert").evaluate(element=>{
          const box=element.getBoundingClientRect(),panel=element.closest(".ns-interest-content").getBoundingClientRect();
          return box.top>=panel.top&&box.bottom<=panel.bottom;
        })).toBe(true);
        await capture(page,"interests-storage-error",width,theme,true);
      }
    } finally {await context.close();}
  }
}

async function main() {
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Use an empty review directory; captures are never overwritten.");
  const client = await request.newContext({ extraHTTPHeaders: headers, timeout: 45_000 });
  let browser;
  try {
    const healthResponse = await client.get(origin.origin + "/health");
    if (!healthResponse.ok() || (await healthResponse.json()).readOnly !== true)
      throw new Error("The capture target must identify itself as a read-only public reader.");
    browser = await chromium.launch({ headless: true });
    if(options.scope==="width-focus")await captureWidthFocus(browser);
    else if(options.scope==="interests")await captureInterests(browser);
    else {
    for (const theme of ["light", "dark"]) for (const width of theme === "light" ? [1280, 1024, 768, 390] : [1280, 390]) {
      const { context, page } = await reviewPage(browser, width, theme);
      try {
        for (const [name, path] of [["brief", "/"], ["radar", "/radar"], ["reading", "/reading"], ["weekly", "/weekly"], ["saved", "/saved"]]) {
          await page.goto(origin.origin + path);
          await expect(page.locator("html")).toHaveAttribute("data-public-reader", "true");
          if (name === "saved") await expect(page.locator(".ns-beta-empty")).toBeVisible();
          else if(name==="reading")await expect(page.locator(".ns-reader-start")).toBeVisible({timeout:45_000});
          else if(name==="weekly") {
            await expect(page.getByRole("heading",{name:"选择一个主题开始回顾",exact:true})).toBeVisible({timeout:45_000});
            await capture(page,"weekly-topics",width,theme);
            await page.getByRole("navigation",{name:"本周主题导航",exact:true}).getByRole("button").first().click();
            await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toBeVisible({timeout:45_000});
          }
          else await expect(page.locator(".ns-beta-feed [data-public-event]").first()).toBeVisible({ timeout: 45_000 });
          await capture(page, name, width, theme);
          if(name==="brief"&&width<=1024) {
            await page.getByRole("button",{name:"打开导航",exact:true}).click();
            const drawer=page.locator(".ns-reader-mobile-nav");
            await expect(drawer.getByRole("navigation",{name:"公开阅读视图",exact:true}).getByRole("button")).toHaveCount(5);
            await expect(drawer.getByRole("navigation",{name:"公开阅读视图",exact:true}).getByRole("button").first()).toBeInViewport({ratio:1});
            await capture(page,"navigation",width,theme);
            await page.keyboard.press("Escape");
            await expect(drawer).toBeHidden();
          }
          if(name==="radar") {
            const modes=page.getByRole("tablist",{name:"新闻排列方式",exact:true}).getByRole("tab");
            await expect(modes).toHaveCount(2);
            for(const [index,label] of ["列表","主题地图"].entries())await expect(modes.nth(index)).toHaveAccessibleName(label);
          }
          if (name === "brief" || name === "reading") {
            await openFirst(page, name === "reading");
            await capture(page, name === "reading" ? "reading-detail" : "detail", width, theme);
            if (name === "reading" && (width === 1280 || width === 390)) {
              const detail = page.getByRole("complementary", { name: "公开文章阅读区", exact: true });
              const sourceTab = page.getByRole("tab", { name: "已收录原文 / 来源内容", exact: true });
              for (let attempt = 0; attempt < 3 && !(await sourceTab.count()); attempt++) {
                const next = detail.getByRole("button", { name: "下一篇", exact: true });
                if (await next.isDisabled()) break;
                const previous = new URL(page.url()).searchParams.get("article");
                await next.click();
                await expect.poll(() => new URL(page.url()).searchParams.get("article"), { timeout: 45_000 }).not.toBe(previous);
                await expect(detail.locator("[data-reader-skeleton]")).toHaveCount(0, { timeout: 45_000 });
              }
              if (await sourceTab.count()) {
                await sourceTab.click();
                await capture(page, "reading-source", width, theme);
              }
            }
          }
        }
        if (width === 1280 || width === 390) {
          await page.goto(origin.origin + "/?tab=radar&view=topics");
          await expect(page.getByRole("group", { name: "关键词主题共现图", exact: true })).toBeVisible({ timeout: 45_000 });
          await expect(page.locator(".ns-topic-article").first()).toBeAttached({ timeout: 45_000 });
          await capture(page, "topics", width, theme);
          await page.getByRole("group",{name:"关键词主题共现图",exact:true}).getByRole("button",{name:/查看匹配文章/}).first().click();
          await expect(page.locator(".ns-topic-article").first()).toBeVisible({timeout:45_000});
          await capture(page,"topics-selected",width,theme);
          await page.locator(".ns-topic-article").first().click();
          const detail=page.getByRole("complementary",{name:"公开文章阅读区",exact:true});
          await expect(detail.locator("h2.ns-preview-title")).toBeVisible({timeout:45_000});
          await expect(detail.locator("[data-reader-skeleton]")).toHaveCount(0,{timeout:45_000});
          await capture(page,"topics-reading",width,theme);
          await page.keyboard.press("Escape");
          await expect(detail).toHaveCount(0);
        }
      } finally { await context.close(); }
    }
    for (const theme of ["light", "dark"]) await captureRecovery(browser, theme);
    }
    report.completedAt = new Date().toISOString();
    report.safe = !report.pageErrors.length && !report.blockedRequests.length;
    await writeFile(join(output, "review.json"), JSON.stringify(report, null, 2));
    if (!report.safe) throw new Error("Capture encountered browser errors or an unsafe request; inspect review.json.");
    console.log(`Captured ${report.captures.length} states in ${output}`);
    console.log("This is review evidence, not automatic visual approval. Have the independent UI critic inspect it.");
  } finally {
    if (browser) await browser.close();
    await client.dispose();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
