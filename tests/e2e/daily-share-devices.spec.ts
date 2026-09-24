import { chromium, devices, expect, test, webkit, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import type { Brief, Event, ReaderSession } from "../../apps/web/src/types";

// Mock-only phone and WeChat checks for the daily share image. No physical device runs here:
// WebKit stands in for iOS Safari and Chromium's mobile emulation for Android.
const candidate = "http://127.0.0.1:15175";
const timestamp = "2026-09-21T03:00:00.000Z";
const fileName = "NewsScout-今日分享-2026-09-21.png";
// WeChat does not publish its image rules. Luban 2 (github.com/Curzibn/Luban) reverse-engineered them from about 100 WeChat
// Moments uploads: a 1440 px short-side baseline, and a 1242 × 22080 chat record that came back as 744 × 13129 at 256 KB.
const WECHAT = { shortSide: 1440, longPixels: 744 * 13129, bitsPerPixel: 256 * 1024 * 8 / (744 * 13129) };
// iOS Safari draws nothing on a canvas above 4096 × 4096 px of area.
const IOS_CANVAS_PIXELS = 4096 * 4096;
// The WeChat viewer fits a long image to the screen width: 390 pt at 3× on an iPhone 14.
const PHONE = { width: 1170, height: 2532 };

const session: ReaderSession = {
  user: { id: "c3200000-0000-4000-8000-00000000000a", displayName: "分享设备测试账号" },
  capabilities: { manageReadingSettings: false },
  csrfToken: "mock-share-device-csrf",
  telemetryConsent: false,
};

// Lengths follow real editions: titles up to the 4-line cap, one-sentence summaries that reach the 7-line cap, and long links.
const stories: { title: string; topics: string[]; points: string[]; url: string; source: string }[] = [
  {
    title: "Contoso 实验室发布 Aurora-2 推理模型：面向长时程智能体任务，API 与桌面应用同步开放，企业版支持按任务设置推理强度与预算上限",
    topics: ["模型与多模态"],
    points: ["新模型在多步骤编程、资料检索和表格分析任务上的完成率明显提升，官方同时公开了与上一代模型的对比评测和测试方法。", "标准版侧重复杂推理，轻量版侧重低延迟与成本，两者共用同一套工具调用接口。", "企业版可按任务设置推理强度和预算上限。"],
    url: "https://www.contoso.example/news/aurora-2-reasoning-model-for-long-horizon-agents-now-available-in-api-and-desktop-apps?region=cn&lang=zh-Hans",
    source: "Contoso 官方博客 · RSS",
  },
  {
    title: "Fabrikam 开源 Agent 工具调用框架 2.0：用更少代码构建可审计的多步骤流程",
    topics: ["Agent 与工具"],
    points: ["新版本把工具调用、权限确认和执行日志放进同一个运行时，开发者只需声明工具的输入输出格式，框架就会自动记录每一步调用的参数、耗时与返回结果，并在需要人工确认的高风险操作前暂停等待审批，官方示例展示了如何在十几行代码内搭建一个能够读取代码仓库、运行测试并提交修改建议的编程助手，同时附带了完整的评测脚本"],
    url: "https://github.example.com/fabrikam/agent-runtime/releases/tag/v2.0.0",
    source: "GitHub Releases · fabrikam/agent-runtime",
  },
  {
    title: "研究团队公开长视频理解基准：覆盖 12 类推理任务，最长视频超过三小时",
    topics: ["评测与安全"],
    points: ["基准包含体育解说、课堂录像和监控片段等真实素材，要求模型回答跨越多个片段的时间与因果问题。", "现有多模态模型在超过一小时的视频上准确率明显下降，主要错误来自遗漏早期细节。", "数据集和评测代码以非商业许可公开。"],
    url: "https://research.example.org/zh/论文/长视频理解基准-12类推理任务",
    source: "示例研究院 · 官方研究索引",
  },
  {
    title: "欧盟发布通用人工智能模型行为准则第二版征求意见稿，细化透明度与版权义务",
    topics: ["治理与政策"],
    points: ["第二版把模型提供方的义务拆分为透明度、版权和安全三个章节，并为开源模型设置了部分豁免条件。", "征求意见期持续六周，企业和研究机构可以提交书面反馈。", "正式版本预计在明年生效前完成定稿。"],
    url: "https://digital-strategy.example.eu/en/library/second-draft-general-purpose-ai-code-of-practice-transparency-copyright-and-safety-chapters-published-for-public-consultation-2026",
    source: "欧盟委员会 · 新闻稿 RSS",
  },
  {
    title: "Reddit 用户实测：两张 24GB 显卡本地运行 70B 模型的量化方案、显存占用与生成速度对比",
    topics: ["模型与多模态"],
    points: ["发帖者在两张 24GB 显卡上逐一测试了 4 位到 8 位的多种量化格式，记录了显存占用、首字延迟和每秒生成的词元数量，结论是 5 位量化在速度和质量之间最均衡，而 8 位量化需要把部分层放到内存中运行，速度会下降一半以上，评论区有多位用户补充了不同驱动版本和推理框架下的对比数据，差异最大的是长上下文场景"],
    url: "https://www.reddit.example.com/r/LocalLLaMA/comments/1q2w3e4/benchmarked_every_quantization_of_a_70b_model_on_two_24gb_gpus_here_are_the_numbers/",
    source: "Reddit · r/LocalLLaMA",
  },
  {
    title: "编程助手支持跨仓库重构，并能自动生成迁移计划与回滚步骤",
    topics: ["AI 编程"],
    points: ["新功能可以同时分析多个代码仓库之间的依赖关系，在改名或拆分模块时给出影响范围。", "助手会先生成迁移计划和回滚步骤，经开发者确认后再逐个仓库提交修改。", "目前仅向企业版用户开放预览。"],
    url: "https://devblogs.example.com/engineering/cross-repository-refactoring-with-coding-agents",
    source: "Northwind 开发者博客 · RSS",
  },
  {
    title: "新一代推理服务器发布：单机可部署万亿参数模型，功耗较上一代下降三成",
    topics: ["芯片与硬件"],
    points: ["新服务器采用液冷设计和更大的高带宽内存，单机即可加载万亿参数规模的模型。", "厂商称在相同吞吐下功耗比上一代下降约三成，首批产品将在年底交付云服务商。", "价格尚未公布。"],
    url: "https://news.example.com/2026/09/21/next-generation-inference-server-trillion-parameter-models",
    source: "Tailspin 硬件新闻 · Atom",
  },
  {
    title: "检索增强新方法让长文档问答成本下降约四成，准确率基本持平",
    topics: ["记忆与检索"],
    points: ["研究者先用小模型筛选与问题相关的段落，再把压缩后的上下文交给大模型作答，从而减少输入长度。", "在法律合同和技术手册两个数据集上，推理成本下降约四成，准确率与完整上下文方案基本持平。", "该方法在需要跨章节推理的问题上仍有明显误差。"],
    url: "https://arxiv.example.org/abs/2609.01234v2",
    source: "arXiv · cs.CL",
  },
  {
    title: "播客｜从零搭建企业级智能体平台：权限、评测与成本控制的五个经验",
    topics: ["Agent 与工具"],
    points: ["本期嘉宾回顾了团队用一年时间把内部智能体平台推广到上千名员工的过程，重点讨论权限隔离和审计日志。", "他们建议先建立离线评测集，再逐步放开自动执行的范围，并为每个任务设置成本上限。", "节目时长约 72 分钟。"],
    url: "https://podcasts.example.fm/northwind-ai/episodes/building-an-enterprise-agent-platform-from-scratch",
    source: "Northwind AI 播客 · 节目 RSS",
  },
  {
    title: "多家云厂商下调大模型推理价格，最低降幅超过六成",
    topics: ["产业与商业"],
    points: ["多家云服务商在同一周内宣布下调大模型推理接口价格，其中面向批量任务的离线接口降幅最大，最低价格比此前下降六成以上，业内人士认为价格下降会推动更多企业把客服、文档处理和数据分析等场景迁移到大模型上，但也提醒开发者关注不同接口在速率限制、数据保留和服务等级协议上的差异，避免只看单价"],
    url: "https://tech.example.cn/articles/2026-09-21/cloud-providers-cut-llm-inference-prices",
    source: "示例科技媒体 · RSS",
  },
  {
    title: "城市交通数据开放计划发布，首批开放公交实时到站与路况数据接口",
    topics: ["产业与商业"],
    points: ["首批开放的数据包括公交实时到站、道路拥堵指数和停车场空位信息，开发者注册后即可免费调用。", "主管部门表示将按季度扩充数据范围。"],
    url: "https://data.example.gov.cn/open/traffic/realtime-bus-and-road-apis",
    source: "示例城市数据开放平台",
  },
  {
    title: "半导体设备出口管制细则更新，涉及先进封装与检测设备",
    topics: ["芯片与硬件"],
    points: ["更新后的细则把部分先进封装设备和晶圆检测设备纳入许可管理，出口前需要逐单申请。", "细则设置了三个月的过渡期，已签订的合同可按原规定执行。"],
    url: "https://trade.example.gov/news/2026/09/export-controls-advanced-packaging-inspection-equipment",
    source: "示例商务部门 · 公告",
  },
  {
    title: "新能源车企公布第三季度交付数据，海外市场占比首次超过三成",
    topics: ["产业与商业"],
    points: ["该公司第三季度共交付约 38 万辆，同比增长约四成，其中海外市场交付量占比首次超过三成。", "公司表示第四季度将在欧洲新增两座工厂的产能。"],
    url: "https://ir.example-auto.com/news/q3-2026-deliveries",
    source: "示例汽车投资者关系",
  },
  {
    title: "卫星互联网完成新一轮组网发射，覆盖更多远洋航线",
    topics: ["其他动态"],
    points: ["本次发射把 48 颗卫星送入预定轨道，完成组网后将覆盖更多远洋航线和偏远地区。", "运营方计划明年开放面向船舶和航空的商用服务。"],
    url: "https://space.example.com/launches/2026-09-20-constellation-batch-12",
    source: "示例航天新闻",
  },
  {
    title: "设计团队分享无障碍改版经验：从色彩对比到键盘操作的完整清单",
    topics: ["设计与交互"],
    points: ["团队把改版拆成色彩对比、焦点样式、键盘操作和读屏标注四个部分，每部分都配有可复用的检查清单。", "改版后，使用键盘完成核心任务的时间缩短了一半。"],
    url: "https://design.example.com/blog/accessibility-redesign-checklist",
    source: "示例设计博客 · RSS",
  },
];

// The longest image the layout allows: 15 selected items, 3 of them 补读, each at every clamp (a 4-line title, a 7-line summary
// and a 3-line link). The summary is one long sentence because the share summary keeps at most about 170 characters.
const longest: typeof stories = Array.from({ length: 15 }, (_, index) => ({
  title: `第 ${index + 1} 条｜示例实验室发布面向长时程智能体任务的新一代推理模型，同时开放 API、桌面应用与企业版预算控制，并公布与上一代模型在编程、资料检索和表格分析任务上的完整对比评测结果与测试方法`,
  topics: [index % 2 ? "Agent 与工具" : "模型与多模态"],
  points: ["新模型在多步骤编程、资料检索和表格分析任务上的完成率明显提升，官方同时公开了与上一代模型的对比评测、测试方法和典型失败案例，开发者可以按任务设置推理强度与预算上限，企业版还提供审计日志、权限隔离和数据保留策略，轻量版则面向低延迟场景，两者共用同一套工具调用接口和计费方式，首批合作伙伴已经在客服与文档处理场景中完成试点并公布了成本数据"],
  url: `https://www.contoso.example/news/2026/09/aurora-${index + 1}-reasoning-model-for-long-horizon-agents-now-available-in-api-and-desktop-apps?region=cn&lang=zh-Hans`,
  source: "Contoso 官方博客 · RSS",
}));

// `catchUp` moves the last items into the edition's 补读 section, published three days before the window.
function brief(list = stories, catchUp = 0): Brief {
  const earlier = "2026-09-18T03:00:00.000Z";
  const items = list.map((story, index) => {
    const published = index >= list.length - catchUp ? earlier : timestamp;
    return {
      id: `c3200000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`, contentVersion: 1, title: story.title, displayTitle: null,
      primaryTopic: story.topics[0], topics: story.topics, eventType: "blog", summary: story.points.join(""), summaryPoints: story.points,
      summaryMaterialLimit: null, summaryLimitations: [], importance: "", firstSeenAt: timestamp, updatedAt: timestamp,
      publishedAt: published, freshnessAt: published, publicationPrecision: "time",
      evidence: [{ id: `evidence-${index}`, sourceName: story.source, sourceTier: "T1", title: story.title, url: story.url, isOfficial: true, publishedAt: published, excerpt: "" }],
      saved: false, read: false, later: false, notInterested: false, seen: false, opened: false,
    } as unknown as Event;
  });
  const ids = (events: Event[]) => events.map(item => item.id);
  const current = items.slice(0, items.length - catchUp);
  return {
    localDate: "2026-09-21", generatedAt: timestamp, estimatedMinutes: 30, items, isSnapshot: true,
    windowStart: "2026-09-19T22:00:00.000Z", windowEnd: "2026-09-20T22:00:00.000Z", nextRefreshAt: "2026-09-21T22:00:00.000Z",
    sections: [
      { key: "essential", kind: "essential", title: "今日重点", description: "选文截止前 24 小时内价值最高的内容", eventIds: ids(current.slice(0, 5)) },
      { key: "more", kind: "more", title: "更多值得读", description: "同一时段内其余值得读的内容", eventIds: ids(current.slice(5)) },
      ...(catchUp ? [{ key: "catch_up", kind: "catch_up" as const, title: "值得补读", description: "发布于选文窗口之前、仍值得一读的内容", eventIds: ids(items.slice(-catchUp)) }] : []),
    ],
  };
}

// Every request is answered locally; any other origin, write or unlisted endpoint is recorded as a failure.
async function mockCloud(context: BrowserContext, edition: Brief = brief()): Promise<string[]> {
  const problems: string[] = [];
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
  const listen = (page: Page) => page.on("pageerror", error => problems.push(error.message));
  context.pages().forEach(listen);
  context.on("page", listen);
  const lists = new Set(["/api/v1/sources", "/api/v1/sources/coverage", "/api/v1/source-watchlist", "/api/v1/me/interests", "/api/v1/shares"]);
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== candidate || url.pathname.startsWith("/.auth/")) {
      problems.push(`Blocked network request: ${request.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const json = request.method() !== "GET" ? undefined
      : url.pathname === "/api/v1/session" ? session
      : url.pathname === "/api/v1/runtime" ? { mode: "postgres", version: "share-device-fixture", timeZone: "Asia/Shanghai" }
      : url.pathname === "/api/v1/briefs/latest" ? edition
      : lists.has(url.pathname) ? { items: [] } : undefined;
    if (json === undefined) {
      problems.push(`Unmocked API request: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 501, json: { error: "Unmocked share device API" } });
    }
    return route.fulfill({ json });
  });
  return problems;
}

// Stands in for the phone's share sheet so the test sees exactly which file the page hands over.
function stubShareSheet() {
  const calls: { name: string; type: string; size: number; title?: string }[] = [];
  Object.defineProperty(window, "__shareCalls", { value: calls });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: (data?: ShareData) => !!data?.files?.length && data.files.every(file => file.type === "image/png") });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data: ShareData) => { for (const file of data.files ?? []) calls.push({ name: file.name, type: file.type, size: file.size, title: data.title }); },
  });
}

async function attachFile(info: TestInfo, name: string, body: Buffer, contentType: string) {
  const path = info.outputPath(name);
  await writeFile(path, body);
  await info.attach(name, { path, contentType });
}

test.beforeEach(({ baseURL }) => {
  expect(process.env.SCOUTNEWS_E2E_MOCK_ONLY, "Run this file only in mock-only mode").toBe("true");
  expect(baseURL, "Never run against the personal API or development host").toBe(candidate);
});

const phones = [
  { name: "iPhone 14 (WebKit)", slug: "iphone-14", engine: webkit, device: devices["iPhone 14"] },
  { name: "Pixel 7 (Chromium)", slug: "pixel-7", engine: chromium, device: devices["Pixel 7"] },
];

for (const phone of phones) {
  test(`daily share fits the ${phone.name} screen and hands the PNG to the system share sheet`, async ({ baseURL }, info) => {
    const browser = await phone.engine.launch();
    try {
      const context = await browser.newContext({ ...phone.device, baseURL, serviceWorkers: "block" });
      const problems = await mockCloud(context);
      await context.addInitScript(stubShareSheet);
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
      await page.goto("/share");
      await expect(page.getByRole("heading", { name: "今日分享", exact: true })).toBeVisible();
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "The profile must emulate a touch screen").toBe(true);
      const preview = page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true });
      await expect(preview).toBeVisible();
      const natural = await preview.evaluate(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }));
      expect(natural.width).toBe(1080);
      await expect(page.getByText(`长图 · 10 条 · 1080 × ${natural.height}`, { exact: true })).toBeVisible();

      const viewport = page.viewportSize()!;
      expect(await page.evaluate(() => document.documentElement.scrollWidth), "The page never scrolls sideways").toBeLessThanOrEqual(viewport.width);
      const order = page.getByRole("group", { name: "分享排序", exact: true });
      const targets: [string, Locator][] = [
        ...["复制文字版", "下载分享图", "分享图片"].map(name => [name, page.getByRole("button", { name, exact: true })] as [string, Locator]),
        ...["AI 相关优先", "精选顺序"].map(name => [name, order.getByRole("button", { name, exact: true })] as [string, Locator]),
        ["first story option", page.locator(".ns-share-options label").first()],
      ];
      for (const [name, target] of targets) {
        const box = (await target.boundingBox())!;
        expect.soft(box.height, `${name} stays at least 44 px tall`).toBeGreaterThanOrEqual(44);
        expect.soft(box.x, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
        expect.soft(box.x + box.width, `${name} ends on screen`).toBeLessThanOrEqual(viewport.width);
      }
      // Narrow buttons break "复制文字版" into "复制文字 / 版"; every button label keeps a single line.
      for (const [name, target] of targets.slice(0, 5)) {
        const lines = await target.evaluate(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), range = document.createRange(), tops = new Set<number>();
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) if (rect.width) tops.add(Math.round(rect.top));
          }
          return tops.size;
        });
        expect.soft(lines, `${name} keeps its label on one line`).toBe(1);
      }
      expect(info.errors, "Touch targets and labels fit the phone").toHaveLength(0);
      // The preview scrolls inside its frame on a phone; the hint disappears at the end of the image.
      const hint = page.locator(".ns-share-scroll-hint");
      await expect(hint).toHaveText("在预览中滚动查看全部 10 条");
      await page.getByRole("group", { name: "分享图预览区域，可滚动", exact: true }).evaluate(frame => { frame.scrollTop = frame.scrollHeight; });
      await expect(hint).toHaveCount(0);
      const path = info.outputPath(`share-${phone.slug}.png`);
      await page.screenshot({ path, fullPage: true });
      await info.attach(`share-${phone.slug}`, { path, contentType: "image/png" });

      const bytes = await preview.evaluate(async image => (await (await fetch((image as HTMLImageElement).src)).blob()).size);
      await page.getByRole("button", { name: "分享图片", exact: true }).tap();
      await expect(page.getByRole("status").filter({ hasText: "已打开系统分享。" })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __shareCalls: unknown[] }).__shareCalls)).toEqual([
        { name: fileName, type: "image/png", size: bytes, title: "NewsScout · 今日值得分享的 10 条新闻" },
      ]);

      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载分享图", exact: true }).tap();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(fileName);
      const png = await readFile((await download.path())!);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20), png.length]).toEqual([1080, natural.height, bytes]);
      await expect(page.getByRole("status").filter({ hasText: "已下载分享图：10 条新闻，每条附原文链接。" })).toBeVisible();
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}

// Recompresses the current preview the way WeChat does for a long image, and renders what a recipient sees on an iPhone 14.
async function wechatCopy(page: Page, info: TestInfo, label: string) {
  const result = await page.evaluate(async ({ rules, phone }) => {
    const image = document.querySelector<HTMLImageElement>(".ns-share-frame img")!;
    await image.decode();
    const source = { width: image.naturalWidth, height: image.naturalHeight };
    let scale = Math.min(1, rules.shortSide / Math.min(source.width, source.height));
    if (source.width * source.height * scale * scale > rules.longPixels) scale = Math.sqrt(rules.longPixels / (source.width * source.height));
    const copy = document.createElement("canvas");
    copy.width = Math.round(source.width * scale); copy.height = Math.round(source.height * scale);
    const context = copy.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, copy.width, copy.height);
    const encode = (quality: number) => new Promise<Blob>((resolve, reject) => copy.toBlob(blob => blob ? resolve(blob) : reject(new Error("JPEG encoding failed")), "image/jpeg", quality));
    // The highest JPEG quality within WeChat's measured size per pixel for a long text screenshot; the lowest quality when none fits.
    const budget = rules.bitsPerPixel * copy.width * copy.height / 8;
    let low = 0.05, high = 0.95, quality = low, jpeg = await encode(low);
    for (let step = 0; step < 7; step++) {
      const middle = (low + high) / 2, blob = await encode(middle);
      if (blob.size <= budget) { low = middle; quality = middle; jpeg = blob; } else high = middle;
    }
    const received = await createImageBitmap(jpeg);
    const dataUrl = (blob: Blob) => new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
    // Fitted to the phone width without zooming: one full screen, and the first story at device pixels.
    const view = (bitmap: CanvasImageSource, width: number, top: number, rows: number) => {
      const canvas = document.createElement("canvas"), fit = phone.width / width;
      canvas.width = phone.width; canvas.height = rows;
      const drawing = canvas.getContext("2d")!;
      drawing.imageSmoothingQuality = "high";
      drawing.drawImage(bitmap, 0, top / fit, width, rows / fit, 0, 0, phone.width, rows);
      return canvas.toDataURL("image/png");
    };
    const story = Math.round(300 * phone.width / source.width);
    // The last 1100 device rows: the final story and the footer with the AI disclaimer.
    const footer = (width: number, height: number) => Math.round(height * phone.width / width) - 1100;
    return {
      source,
      copy: { width: copy.width, height: copy.height, scale: Math.round(copy.width / source.width * 1000) / 1000, quality: Math.round(quality * 100) / 100, bytes: jpeg.size, withinBudget: jpeg.size <= budget, bitsPerPixel: Math.round(jpeg.size * 8000 / (copy.width * copy.height)) / 1000 },
      files: {
        png: await dataUrl(await (await fetch(image.src)).blob()),
        jpeg: await dataUrl(jpeg),
        screen: view(received, copy.width, 0, phone.height),
        story: view(received, copy.width, story, 1100),
        storyOriginal: view(image, source.width, story, 1100),
        footer: view(received, copy.width, footer(copy.width, copy.height), 1100),
        footerOriginal: view(image, source.width, footer(source.width, source.height), 1100),
      },
    };
  }, { rules: WECHAT, phone: PHONE });
  const { files, ...measured } = result;
  const body = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  await attachFile(info, `share-${label}.png`, body(files.png), "image/png");
  await attachFile(info, `wechat-${label}.jpg`, body(files.jpeg), "image/jpeg");
  await attachFile(info, `wechat-${label}-phone-screen.png`, body(files.screen), "image/png");
  await attachFile(info, `wechat-${label}-phone-story.png`, body(files.story), "image/png");
  await attachFile(info, `original-${label}-phone-story.png`, body(files.storyOriginal), "image/png");
  await attachFile(info, `wechat-${label}-phone-footer.png`, body(files.footer), "image/png");
  await attachFile(info, `original-${label}-phone-footer.png`, body(files.footerOriginal), "image/png");
  return measured;
}

test("the default share image keeps its full width through WeChat-style recompression", async ({ page }, info) => {
  const problems = await mockCloud(page.context());
  await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
  await page.goto("/share");
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true })).toBeVisible();
  const ten = await wechatCopy(page, info, "10");
  // Narrower than 1440 px and under the long-image pixel budget, so WeChat only re-encodes the default image.
  expect(ten.source.width).toBe(1080);
  expect(ten.source.width * ten.source.height).toBeLessThanOrEqual(WECHAT.longPixels);
  expect([ten.copy.width, ten.copy.height]).toEqual([ten.source.width, ten.source.height]);

  for (const story of stories.slice(10)) await page.getByRole("checkbox", { name: story.title, exact: true }).check();
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 15 条新闻", exact: true })).toBeVisible();
  const fifteen = await wechatCopy(page, info, "15");
  // The 15-item maximum still fits one iOS Safari canvas; at this length it also stays under WeChat's long-image budget.
  expect(fifteen.source.width * fifteen.source.height).toBeLessThanOrEqual(IOS_CANVAS_PIXELS);
  await attachFile(info, "wechat-simulation.json", Buffer.from(JSON.stringify({ rules: WECHAT, phone: PHONE, ten, fifteen }, null, 2)), "application/json");
  expect(problems).toEqual([]);
});

test("the longest possible share image fits one iOS canvas and WeChat only scales it down", async ({ page }, info) => {
  const problems = await mockCloud(page.context(), brief(longest, 3));
  await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
  await page.goto("/share");
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true })).toBeVisible();
  for (const story of longest.slice(10)) await page.getByRole("checkbox", { name: story.title, exact: true }).check();
  await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 15 条新闻", exact: true })).toBeVisible();
  const measured = await wechatCopy(page, info, "15-longest");
  // Every block at its clamp: 12 blocks of 754 px, 3 补读 blocks of 796 px, 14 gaps, the header and the footer. Link wrapping is
  // the only font-dependent part, so the image may be up to one 36 px link line per item shorter.
  const ceiling = 330 + 12 * 754 + 3 * 796 + 14 * 88 + 150;
  expect(measured.source.height).toBeLessThanOrEqual(ceiling);
  expect(measured.source.height).toBeGreaterThanOrEqual(ceiling - 15 * 36);
  expect(measured.source.width * measured.source.height).toBeLessThanOrEqual(IOS_CANVAS_PIXELS);
  // WeChat scales the copy down to its long-image budget; 25 px link text keeps at least 20 px.
  expect(measured.copy.scale).toBeLessThan(1);
  expect(measured.copy.width * measured.copy.height).toBeLessThanOrEqual(WECHAT.longPixels * 1.001);
  expect(25 * measured.copy.scale).toBeGreaterThanOrEqual(20);
  await attachFile(info, "wechat-longest.json", Buffer.from(JSON.stringify({ rules: WECHAT, phone: PHONE, ceiling, longest: measured }, null, 2)), "application/json");
  expect(problems).toEqual([]);
});

test("keyboard focus stays on the download button while the image is generated", async ({ page }) => {
  const problems = await mockCloud(page.context());
  // Slows PNG encoding so the busy state lasts long enough to observe before the preview is ready.
  await page.addInitScript(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback, type?: string, quality?: unknown) {
      setTimeout(() => encode.call(this, callback, type, quality), 1500);
    };
  });
  await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
  await page.goto("/share");
  const copy = page.getByRole("button", { name: "复制文字版", exact: true });
  await copy.focus();
  await page.keyboard.press("Tab");
  const download = page.getByRole("button", { name: "下载分享图", exact: true });
  await expect(download).toBeFocused();
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const busy = page.getByRole("button", { name: "正在生成…", exact: true });
  await expect(busy).toBeFocused();
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await expect(busy).toHaveAttribute("aria-busy", "true");
  expect((await downloading).suggestedFilename()).toBe(fileName);
  await expect(page.getByRole("status").filter({ hasText: "已下载分享图：10 条新闻，每条附原文链接。" })).toBeVisible();
  await expect(download).toBeFocused();
  expect(problems).toEqual([]);
});

test("a failed system share explains the next step in Chinese instead of the browser's message", async ({ baseURL }) => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices["Pixel 7"], baseURL, serviceWorkers: "block" });
    const problems = await mockCloud(context);
    // Browsers reject with their own English text; the reader cancels once, is refused once, then hits an unsupported file.
    await context.addInitScript(() => {
      const outcomes = [new DOMException("Share canceled", "AbortError"), new DOMException("Permission denied", "NotAllowedError"), new TypeError("Failed to share: unsupported file")];
      let attempts = 0;
      Object.defineProperty(window, "__shareAttempts", { get: () => attempts });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: (data?: ShareData) => !!data?.files?.length });
      Object.defineProperty(navigator, "share", { configurable: true, value: async () => { throw outcomes[attempts++]; } });
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date("2026-09-21T10:00:00+08:00"));
    await page.goto("/share");
    await expect(page.getByRole("img", { name: "分享图预览：今日值得分享的 10 条新闻", exact: true })).toBeVisible();
    const share = page.getByRole("button", { name: "分享图片", exact: true });
    const attempts = () => page.evaluate(() => (window as unknown as { __shareAttempts: number }).__shareAttempts);
    const alert = page.getByRole("alert");

    await share.tap();
    await expect.poll(attempts).toBe(1);
    await page.waitForTimeout(300);
    await expect(alert, "Closing the share sheet is the reader's choice, not a failure").toHaveCount(0);

    await share.tap();
    await expect(alert).toHaveText("没有打开系统分享系统没有允许这次分享。可以改用“下载分享图”，保存后再发送。");
    await share.tap();
    await expect.poll(attempts).toBe(3);
    await expect(alert).toHaveText("没有打开系统分享系统分享暂时不可用。可以改用“下载分享图”，保存后再发送。");
    await expect(page.getByText(/Permission denied|Failed to share|分享图未生成/)).toHaveCount(0);

    // The suggested fallback works and clears the notice.
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载分享图", exact: true }).tap();
    expect((await downloading).suggestedFilename()).toBe(fileName);
    await expect(page.getByRole("status").filter({ hasText: "已下载分享图：10 条新闻，每条附原文链接。" })).toBeVisible();
    await expect(alert).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await browser.close();
  }
});
