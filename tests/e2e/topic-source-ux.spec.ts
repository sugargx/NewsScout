import { expect,test } from "@playwright/test";
import { layoutTopics } from "../../apps/web/src/topic-layout";
import type { Exploration,Source } from "../../apps/web/src/types";

const api=process.env.SCOUTNEWS_E2E_API_URL??"http://127.0.0.1:8080";
test.beforeAll(()=>{
  if(process.env.SCOUTNEWS_DISABLE_COPILOT_RESTORE!=="true")throw new Error("Use the isolated E2E runner.");
});

test("source filters keep every displayed subscription in scope, separate the watchlist and survive reload",async({page,request},info)=>{
  const {items:sources}:{items:Source[]}=await(await request.get(`${api}/api/v1/sources`)).json();
  await page.goto("/sources");
  const results=page.getByRole("region",{name:"来源筛选结果",exact:true});
  const ids=()=>results.locator("[data-source-id]").evaluateAll(elements=>elements.map(element=>element.getAttribute("data-source-id")).sort());
  for(const tier of ["T1","T1.5","T2"]) {
    await page.getByLabel("来源等级",{exact:true}).selectOption(tier);
    await expect.poll(ids).toEqual(sources.filter(source=>source.tier===tier).map(source=>source.id).sort());
    await expect(page.getByRole("region",{name:"待接入名单",exact:true})).toHaveCount(0);
    await expect(page.getByRole("status").filter({hasText:`仅 ${tier}`})).toBeVisible();
  }
  const source=sources.find(item=>item.tier==="T2"&&item.adapter==="rss")!;
  expect(source).toBeTruthy();
  await page.getByLabel("适配器筛选",{exact:true}).selectOption(source.adapter);
  await page.getByLabel("采集状态筛选",{exact:true}).selectOption(source.lifecycleStatus);
  const matching=sources.filter(item=>item.tier==="T2"&&item.adapter===source.adapter&&item.lifecycleStatus===source.lifecycleStatus);
  await expect.poll(ids).toEqual(matching.map(item=>item.id).sort());
  await page.getByLabel("搜索来源",{exact:true}).fill(source.name);
  const searched=matching.filter(item=>[item.name,item.publisher,item.endpoint,item.contentType,...item.topics].join(" ").toLocaleLowerCase().includes(source.name.toLocaleLowerCase()));
  await expect.poll(ids).toEqual(searched.map(item=>item.id).sort());
  await page.reload();
  await expect(page.getByLabel("来源等级",{exact:true})).toHaveValue("T2");
  await expect(page.getByLabel("搜索来源",{exact:true})).toHaveValue(source.name);
  await expect.poll(ids).toEqual(searched.map(item=>item.id).sort());
  await page.getByRole("tab",{name:/^关注名单/}).click();
  await expect(page.getByRole("heading",{name:"关注名单与接入状态",exact:true})).toBeVisible();
  await expect(results).toHaveCount(0);
  await expect(page.getByLabel("来源等级",{exact:true})).toHaveCount(0);
  await page.getByRole("tab",{name:/^已接入来源/}).click();
  await expect.poll(ids).toEqual(searched.map(item=>item.id).sort());
  await page.getByLabel("搜索来源",{exact:true}).fill("__no_matching_source__");
  await expect(results.locator("[data-source-id]")).toHaveCount(0);
  await expect(results.getByText("没有匹配的来源。可清除搜索或筛选条件。",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"清除筛选",exact:true}).click();
  await expect.poll(ids).toEqual(sources.map(item=>item.id).sort());
  await page.getByLabel("来源等级",{exact:true}).selectOption("T1");
  await expect(page.getByLabel("来源等级",{exact:true})).toHaveValue("T1");
  await expect.poll(ids).toEqual(sources.filter(source=>source.tier==="T1").map(source=>source.id).sort());
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`sources-t1-${width}.png`)});
  }
  await page.getByRole("tab",{name:/^覆盖盲区/}).click();
  await expect(page.getByRole("region",{name:"来源与领域覆盖",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"新增来源",exact:true}).click();
  await expect(page.getByRole("heading",{name:"添加订阅来源",exact:true})).toBeVisible();
});

test("topic network layout is deterministic, bounded and collision-free across sparse and dense topologies",()=>{
  const labels=["模型与多模态","Agent 与工具","评测与安全","政策与社会","设计与交互","心理与认知","工程与开源","记忆与检索","AGI","MCP / A2A","研究论文","播客与访谈"];
  for(const width of [254,294,390,440,480,720])for(const count of [0,1,4,8,12])for(const mode of ["none","chain","dense"]) {
    const nodes=labels.slice(0,count).map((id,index)=>({id,count:20-index}));
    const edges:Exploration["edges"]=[];
    nodes.forEach((node,a)=>nodes.slice(a+1).forEach((other,b)=>{if(mode==="dense"||(mode==="chain"&&b===0))edges.push({source:node.id,target:other.id,count:3});}));
    const layout=layoutTopics(nodes,edges,width);
    expect(layoutTopics(nodes,edges,width)).toEqual(layout);
    for(const point of layout.points) {
      expect(point.x-point.width/2).toBeGreaterThanOrEqual(0);
      expect(point.x+point.width/2).toBeLessThanOrEqual(width);
      expect(point.y-60).toBeGreaterThanOrEqual(0);
      expect(point.y+66).toBeLessThanOrEqual(layout.height);
      expect(point.lines.length).toBeLessThanOrEqual(2);
      for(const other of layout.points.filter(item=>item.id!==point.id)) {
        const overlap=Math.abs(point.x-other.x)<(point.width+other.width)/2&&Math.abs(point.y-other.y)<126;
        expect(overlap,`${width}px / ${count} / ${mode}: ${point.id} overlaps ${other.id}`).toBe(false);
      }
    }
  }
});

test.describe("topic network real-publisher interactions",()=>{
  test.beforeAll(async({request})=>{
    test.setTimeout(220_000);
    for(const suffix of ["001","304"]) {
      const response=await request.post(`${api}/api/v1/sources/20000000-0000-0000-0000-000000000${suffix}/refresh`,{timeout:90_000});
      expect(response.ok(),await response.text()).toBe(true);
      expect((await response.json()).succeeded).toBe(1);
    }
  });
  test("topic network preserves actual edges, stable selection and in-place reading on desktop and mobile",async({page},info)=>{
    test.setTimeout(180_000);
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    for(const theme of ["light","dark"])for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1100});
      await page.goto(`/radar?view=topics&clawpilotTheme=${theme}`);
      await page.locator("[data-topic-id]").first().waitFor();
      const response=page.waitForResponse(response=>response.url().includes("/api/v1/explore?")&&new URL(response.url()).searchParams.get("hours")==="0");
      await page.getByText("更多筛选 · 时间与排序",{exact:true}).click();
      await page.getByLabel("时间范围",{exact:true}).selectOption("0");
      const exploration:Exploration=await(await response).json();
      const graph=page.getByRole("group",{name:"关键词主题共现图",exact:true,includeHidden:true});
      const expectedNodes=[...exploration.nodes].sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)).slice(0,12).map(node=>node.id);
      await expect.poll(()=>graph.locator("[data-topic-id]").evaluateAll(elements=>elements.map(element=>element.getAttribute("data-topic-id")).sort())).toEqual([...expectedNodes].sort());
      const expectedEdges=exploration.edges.filter(edge=>expectedNodes.includes(edge.source)&&expectedNodes.includes(edge.target));
      expect(expectedEdges.length).toBeGreaterThan(0);
      const initialTopic=expectedNodes[0];
      await expect(graph).toHaveAttribute("data-focused-topic",initialTopic);
      const rendered=await graph.locator("[data-edge-source]").evaluateAll(elements=>elements.map(element=>`${element.getAttribute("data-edge-source")}|${element.getAttribute("data-edge-target")}`).sort());
      expect(rendered).toEqual(expectedEdges.filter(edge=>edge.source===initialTopic||edge.target===initialTopic).map(edge=>`${edge.source}|${edge.target}`).sort());
      await expect.poll(()=>graph.locator(".ns-network-stage svg").evaluate(element=>Math.abs((element as SVGSVGElement).viewBox.baseVal.width-element.getBoundingClientRect().width))).toBeLessThanOrEqual(3);
      const positions=()=>graph.locator(".ns-network-node").evaluateAll(elements=>elements.map(element=>[element.getAttribute("data-topic-id"),element.getAttribute("transform")]));
      const linked=expectedEdges[0].source;
      const node=graph.getByRole("button",{name:new RegExp(`^${linked}，样本中`)});
      await node.focus();await node.press("Enter");
      const results=page.getByRole("group",{name:"关联文章",exact:true});
      await expect(results).toBeVisible();
      await expect(page.getByRole("article",{name:"文章就地阅读"})).toHaveCount(0);
      await expect(graph).toHaveAttribute("data-focused-topic",linked);
      const before=await positions();
      await results.getByRole("button").first().click();
      await expect(page.locator(".ns-preview-title")).toBeVisible();
      await expect(page.locator(".ns-topic-article").first()).toHaveAttribute("aria-current","true");
      await expect(graph).toHaveAttribute("data-focused-topic",linked);
      expect((await positions()).map(point=>point[0]).sort()).toEqual(before.map(point=>point[0]).sort());
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.locator(".ns-topic-workspace").screenshot({path:info.outputPath(`network-reading-${theme}-${width}.png`)});
      await page.getByRole("button",{name:"返回主题结果",exact:true}).click();
      await expect(results.getByRole("button").first()).toBeFocused();
      await expect.poll(positions).toEqual(before);
      if(width<1000)await page.getByRole("button",{name:"主题地图",exact:true}).click();
      const isolated=expectedNodes.find(id=>!expectedEdges.some(edge=>edge.source===id||edge.target===id));
      expect(isolated,"A real fallback topic exercises the zero-edge state").toBeTruthy();
      await graph.getByRole("button",{name:new RegExp(`^${isolated}，样本中`)}).click();
      await expect(results).toBeVisible();
      expect(await graph.locator("[data-edge-source]").count()).toBe(0);
      expect((await positions()).map(point=>point[0])).toEqual([isolated]);
      if(width<1000)await page.getByRole("button",{name:"主题地图",exact:true}).click();
      await expect(graph.locator(".ns-network-focus")).toContainText("这是独立主题");
      await page.locator(".ns-topic-map-scroll").evaluate(element=>{element.scrollTop=0;});
      await page.locator(".ns-topic-workspace").screenshot({path:info.outputPath(`network-isolated-${theme}-${width}.png`)});
      const camera=graph.locator(".ns-network-stage svg > g");
      const beforeCamera=await camera.getAttribute("transform");
      await graph.getByRole("button",{name:"放大图谱",exact:true}).click();
      await expect(graph.getByRole("button",{name:"还原图谱视图",exact:true})).toHaveText("120%");
      const zoomedCamera=await camera.getAttribute("transform");
      const surface=(await graph.locator(".ns-network-stage").boundingBox())!;
      await page.mouse.move(surface.x+10,surface.y+10);await page.mouse.down();
      await page.mouse.move(surface.x+40,surface.y+30,{steps:3});await page.mouse.up();
      await expect(camera).not.toHaveAttribute("transform",zoomedCamera!);
      await graph.getByRole("button",{name:"缩小图谱",exact:true}).click();
      await expect(camera).toHaveAttribute("transform",beforeCamera!);
      await expect(graph.getByRole("button",{name:"还原图谱视图",exact:true})).toHaveText("100%");
      await graph.getByRole("button",{name:"放大图谱",exact:true}).click();
      await graph.getByRole("button",{name:"还原图谱视图",exact:true}).click();
      await expect(camera).toHaveAttribute("transform",beforeCamera!);
    }
    expect(errors).toEqual([]);
  });
});
