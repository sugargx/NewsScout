import { expect, test, type Page } from "@playwright/test";

const eventId="b2000000-0000-4000-8000-000000000001";
const sourceId="c2000000-0000-4000-8000-000000000001";
const registeredPost="https://x.com/newsscout_test/status/1234567890123456789";

const event={
  id:eventId,contentVersion:1,title:"受控测试：选择后才开始深读",summary:"受控阅读队列摘要。",importance:"fixture",
  primaryTopic:"测试",topics:["测试"],eventType:"blog",firstSeenAt:"2026-09-11T00:00:00.000Z",updatedAt:"2026-09-11T00:00:00.000Z",
  publishedAt:"2026-09-11T00:00:00.000Z",freshnessAt:"2026-09-11T00:00:00.000Z",publicationPrecision:"time",
  evidence:[{id:"d2000000-0000-4000-8000-000000000001",sourceName:"受控发布者",sourceTier:"T1",title:"受控来源",
    url:"https://example.com/source",isOfficial:true,publishedAt:"2026-09-11T00:00:00.000Z",excerpt:"受控保留摘录。"}],
  score:{sourceQuality:1,corroboration:1,freshness:1,relevance:1,novelty:1,engagement:1,editorialBoost:0,total:6,explanation:"fixture"},
  personalRelevance:0,personalReason:"fixture",saved:false,read:false,later:false,notInterested:false,seen:false,opened:false,
  summaryKind:"copilot",summaryModel:null,summarizedAt:"2026-09-11T00:00:00.000Z",summaryEvidenceIds:[],summaryPoints:["受控测试要点。"],
};

async function stubReaderApi(page:Page) {
  const opened:string[]=[],savedXPostUrls:string[][]=[],createdSources:Record<string,unknown>[]=[];
  await page.route("**/api/v1/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==="/api/v1/runtime")return route.fulfill({json:{mode:"postgres",timeZone:"Asia/Shanghai",version:"fixture"}});
    if(path==="/api/v1/sources"&&request.method()==="POST") {
      const input=JSON.parse(request.postData()??"{}") as Record<string,unknown>;
      createdSources.push(input);
      return route.fulfill({json:{...input,id:sourceId}});
    }
    if(path==="/api/v1/sources")return route.fulfill({json:{items:[{
      id:sourceId,name:"X preview fixture",publisher:"X",contentType:"blog",adapter:"x_public_preview",endpoint:"https://x.com/newsscout_test",
      tier:"T2",lifecycleStatus:"observing",topics:["测试"],scheduleMinutes:1440,consecutiveFailures:0,lastError:null,lastSuccessAt:"2026-08-02T00:00:00.000Z",
    }]}});
    if(path==="/api/v1/sources/coverage")return route.fulfill({json:{items:[]}});
    if(path==="/api/v1/source-watchlist")return route.fulfill({json:{items:[{
      id:"watch-x",platform:"x",name:"X fixture",handle:"@newsscout_test",profileUrl:"https://x.com/newsscout_test",
      status:"feed_linked",sourceId,note:"登记链接测试",originUrl:"https://directory.example.test",originLabel:"Directory",
    }]}});
    if(path===`/api/v1/sources/${sourceId}/x-posts`) {
      if(request.method()==="PUT") {
        const urls=JSON.parse(request.postData()??"{}").urls as string[];
        savedXPostUrls.push(urls);
        return route.fulfill({json:{urls}});
      }
      return route.fulfill({json:{urls:[registeredPost]}});
    }
    if(path==="/api/v1/me/interests")return route.fulfill({json:{items:[]}});
    if(path==="/api/v1/events")return route.fulfill({json:{items:[event],nextOffset:null}});
    if(path===`/api/v1/events/${eventId}`)return route.fulfill({json:event});
    if(path===`/api/v1/events/${eventId}/state`) {
      if(JSON.parse(request.postData()??"{}").opened===true)opened.push(eventId);
      return route.fulfill({json:{...event,opened:true}});
    }
    if(path==="/api/v1/weekly")return route.fulfill({json:{items:[event]}});
    return route.fulfill({status:404,json:{error:"Unexpected fixture request"}});
  });
  return {opened,savedXPostUrls,createdSources};
}

test("reader chrome keeps controls aligned and waits for an explicit T1 selection",async({page})=>{
  const {opened}=await stubReaderApi(page);
  await page.setViewportSize({width:1440,height:1000});
  await page.goto("/radar");
  await expect(page.getByText("上海时区 · 上次采集",{exact:false})).toHaveCount(0);
  const toolbar=page.locator("[data-ui='radar-filters']");
  const box=(await toolbar.boundingBox())!;
  const controlCenters=await toolbar.locator("input, select").evaluateAll(fields=>fields.map(field=>{
    const r=field.getBoundingClientRect();return r.top+r.height/2;
  }));
  expect(controlCenters).toHaveLength(3);
  expect(Math.max(...controlCenters)-Math.min(...controlCenters)).toBeLessThanOrEqual(1);
  expect(await toolbar.locator("input, select").evaluateAll((fields,bounds)=>fields.every(field=>{
    const r=field.getBoundingClientRect();return r.left>=bounds.x&&r.right<=bounds.x+bounds.width+1;
  }),box)).toBe(true);
  await page.getByLabel("来源筛选",{exact:true}).selectOption("T1");
  await expect(page.getByLabel("当前筛选")).toContainText("T1");
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();
  await expect(page.getByLabel("来源筛选",{exact:true})).toHaveValue("");

  await page.goto("/reading");
  await expect(page.getByRole("complementary",{name:"选择文章开始深读",exact:true})).toBeVisible();
  expect(opened).toEqual([]);
  await page.getByRole("button",{name:"从第 1 篇开始",exact:true}).click();
  await expect(page.getByRole("article",{name:"文章就地阅读",exact:true})).toBeVisible();
  await expect.poll(()=>opened).toEqual([eventId]);

  await page.goto("/weekly");
  const weeklyToolbar=page.locator(".ns-weekly-toolbar");
  expect(await weeklyToolbar.evaluate(element=>getComputedStyle(element).alignItems)).toBe("center");
  await expect(page.getByRole("heading",{name:"选择一个主题开始回顾",exact:true})).toBeVisible();
  await page.getByRole("navigation",{name:"本周主题导航",exact:true}).getByRole("button",{name:"全部主题",exact:true}).click();
  await page.getByRole("heading",{name:event.title,exact:true}).getByRole("button").click();
  const reader=page.getByRole("article",{name:"文章就地阅读",exact:true});
  await expect(reader.getByRole("button",{name:/^收藏：/})).toBeVisible();
  await expect(reader.getByRole("button",{name:/^不感兴趣：/})).toBeVisible();
  const centers=(items:(HTMLElement|SVGElement)[])=>items.map(item=>{const r=item.getBoundingClientRect();return Math.round(r.top+r.height/2);});
  const toolCenters=await reader.locator(".ns-preview-tools button").evaluateAll(centers);
  expect(toolCenters.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...toolCenters)-Math.min(...toolCenters)).toBeLessThanOrEqual(1);
  const footer=reader.locator(".ns-preview-actions").locator("a, button");
  await expect(footer).toHaveCount(2);
  const footerCenters=await footer.evaluateAll(centers);
  expect(Math.max(...footerCenters)-Math.min(...footerCenters)).toBeLessThanOrEqual(1);
});

test("source management presents finite X registration and hides directory provenance",async({page})=>{
  const {savedXPostUrls,createdSources}=await stubReaderApi(page);
  await page.goto("/sources");
  const source=page.getByRole("region",{name:"X preview fixture",exact:true});
  await source.getByText("登记的 X 原帖预览",{exact:true}).click();
  const registeredInput=source.getByRole("textbox",{name:"X 原帖预览（登记链接）",exact:true});
  await expect(registeredInput).toHaveValue(registeredPost);
  await registeredInput.fill(`${registeredPost}?s=20&t=share&ref_src=twsrc%5Etfw`);
  await source.getByRole("button",{name:"保存登记链接",exact:true}).click();
  await expect.poll(()=>savedXPostUrls).toEqual([[registeredPost]]);
  await registeredInput.fill("https://x.com/other/status/1234567890123456789");
  await source.getByRole("button",{name:"保存登记链接",exact:true}).click();
  await expect(source.getByText("登记链接必须属于来源主页指定的 X 账号。",{exact:true})).toBeVisible();
  await registeredInput.fill(`${registeredPost}?token=not-supported`);
  await source.getByRole("button",{name:"保存登记链接",exact:true}).click();
  await expect(source.getByText("原帖链接包含不支持的参数；请保留原始帖子地址。",{exact:true})).toBeVisible();
  expect(savedXPostUrls).toHaveLength(1);
  await expect(source.getByText("不会自动发现主页新帖或完整时间线。",{exact:false})).toBeVisible();

  await page.getByRole("tab",{name:/^关注名单/}).click();
  await expect(page.getByText("X · 原帖预览 · 登记链接测试",{exact:true})).toBeVisible();
  await expect(page.getByText("清单出处",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"公开主页 / 入口 ↗",exact:true})).toBeVisible();

  await page.getByRole("button",{name:"新增来源",exact:true}).click();
  await page.getByLabel("采集适配器",{exact:true}).selectOption("x_public_preview");
  await expect(page.getByRole("textbox",{name:"X 主页（仅作身份识别）",exact:true})).toBeVisible();
  await expect(page.getByRole("textbox",{name:"X 原帖预览（登记链接）",exact:true})).toBeVisible();
  await expect(page.getByRole("spinbutton",{name:"采集间隔（分钟）",exact:true})).toHaveValue("1440");
  await page.getByRole("textbox",{name:"来源名称",exact:true}).fill("Registered X source");
  await page.getByRole("textbox",{name:"X 主页（仅作身份识别）",exact:true}).fill("https://x.com/newsscout_test");
  await page.getByRole("textbox",{name:"X 原帖预览（登记链接）",exact:true}).fill(registeredPost);
  await page.getByRole("button",{name:"添加来源",exact:true}).click();
  await expect.poll(()=>createdSources.length).toBe(1);
  expect(createdSources[0]).toMatchObject({adapter:"x_public_preview",contentType:"blog",scheduleMinutes:1440,originalPostUrls:[registeredPost]});
  await page.getByLabel("采集适配器",{exact:true}).selectOption("rss");
  await expect(page.getByRole("textbox",{name:"X 原帖预览（登记链接）",exact:true})).toHaveCount(0);
  await page.getByRole("textbox",{name:"来源名称",exact:true}).fill("Original RSS source");
  await page.getByRole("textbox",{name:"HTTPS 订阅地址",exact:true}).fill("https://example.com/feed.xml");
  await page.getByRole("button",{name:"添加来源",exact:true}).click();
  await expect.poll(()=>createdSources.length).toBe(2);
  expect(createdSources[1]).not.toHaveProperty("originalPostUrls");
});
