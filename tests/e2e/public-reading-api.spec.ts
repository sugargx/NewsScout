import { expect, test as base, type APIResponse } from "@playwright/test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { projectBrief, startPublicReader } from "../../services/public-reader/server.cjs";

const privateValue = "PRIVATE_READING_SENTINEL";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const thirdId = "33333333-3333-4333-8333-333333333333";
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disabledId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const releaseSourceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const communitySourceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const unknownSourceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const cutoff = "2026-09-16T04:00:00.000Z";
const archiveDate = "2026-09-15";
const legacyDate = "2024-02-29";
const note = "共享选文；收藏和阅读记录属于各自浏览器，不改动站主设置。";

const context = {
  version: 1, kind: "article", origin: "publisher_page", status: "available",
  sourceUrl: "https://example.com/engineering", body: "Original publisher reading material.",
  truncated: false, transcriptUrl: null, durationSeconds: null, fetchedAt: "2026-09-15T03:00:00Z",
  chapters: [{ startSeconds: 0, title: "Architecture", url: "https://example.com/engineering#architecture" }],
  comments: [{
    id: "comment-1", body: "A public technical comment.", score: 3,
    url: "https://example.com/engineering#comment-1", author: "Publisher",
    publishedAt: "2026-09-15T03:00:00Z", truncated: false,
  }],
  commentsStatus: "available",
};
const evidence = {
  id: "evidence-1", sourceName: "Original engineering publisher", sourceTier: "T1",
  title: "Original source title", url: "https://example.com/engineering", isOfficial: true,
  publishedAt: "2026-09-15T02:00:00Z", originalPublishedAt: "2026-09-15T02:00:00Z",
  publicationPrecision: "exact", excerpt: "Source excerpt.", technicalBasis: "Original technical article.",
  readingContext: context,
};
const publicArticle = {
  id: firstId, contentVersion: 7, title: "  Original engineering title — unchanged  ",
  displayTitle: "Reader engineering headline", summary: "Technical summary.", eventType: "blog",
  publishedAt: "2026-09-15T02:00:00Z", primaryTopic: "Engineering", topics: ["Engineering"],
  editorial: { policyVersion: "editorial-v1", contentKind: "analysis", reason: "Substantive original analysis." },
  evidence: [evidence], facets: ["Engineering"],
};
const ownerEvidence = {
  ...evidence, config: { token: privateValue }, endpoint: privateValue, lastError: privateValue,
  readingContext: {
    ...context, privateError: privateValue, auth: { token: privateValue },
    chapters: context.chapters.map(chapter => ({ ...chapter, privateNotes: privateValue })),
    comments: context.comments.map(comment => ({ ...comment, privateNotes: privateValue })),
  },
};
const ownerArticle = {
  ...publicArticle, saved: true, opened: true, notInterested: true, notInterestedReason: privateValue,
  personalReason: privateValue, score: { total: 99, explanation: privateValue }, provider: privateValue,
  recommendation: { facets: ["Engineering"], score: 99, affinity: 98, explanation: privateValue },
  editorial: { ...publicArticle.editorial, valueScore: 85, briefEligible: true, privateNotes: privateValue },
  evidence: [ownerEvidence], summaryError: privateValue,
};
const sources = {
  items: [
    { id: sourceId, name: "Original engineering publisher", tier: "T1", contentType: "blog", lifecycleStatus: "stable" },
    { id: disabledId, name: "Archived engineering publisher", tier: "T1", contentType: "blog", lifecycleStatus: "disabled" },
    { id: releaseSourceId, name: privateValue, tier: "T1", contentType: "release", lifecycleStatus: "stable" },
    { id: communitySourceId, name: privateValue, tier: "T2", contentType: "blog", lifecycleStatus: "stable" },
    { id: unknownSourceId, name: privateValue, tier: "T1.5", contentType: "blog", lifecycleStatus: "observing" },
  ].map(source => ({
    ...source, config: { apiKey: privateValue }, endpoint: privateValue, lastError: privateValue,
    notes: privateValue, provider: privateValue, auth: { token: privateValue },
  })),
  settings: privateValue,
};
const historyItems = [
  { localDate: archiveDate, generatedAt: "2026-09-15T22:00:00.123456Z", itemCount: 3 },
  { localDate: legacyDate, generatedAt: "2024-02-29T02:00:00+00:00", itemCount: 1 },
  { localDate: "2026-09-14", generatedAt: "2026-09-14T02:00:00Z", itemCount: 0 },
];
const history = {
  items: historyItems.map(item => ({
    ...item, selectionNote: privateValue, settings: privateValue, items: [ownerArticle],
  })),
  provider: privateValue,
};
const sections = [
  { key: "engineering", kind: "topic", title: "工程实践", description: "原始技术材料。", eventIds: [firstId] },
  { key: "research", kind: "topic", title: "研究回顾", description: "本周值得保留的变化。", eventIds: [secondId] },
];
const weekly = {
  localDate: "2026-09-16", generatedAt: cutoff, windowStart: "2026-09-09T04:00:00.000Z", windowEnd: cutoff,
  primaryWindowStart: null, estimatedMinutes: 9, isSnapshot: false,
  items: [ownerArticle, { ...ownerArticle, id: secondId, title: "Second original title" }],
  sections: sections.map(section => ({ ...section, privateNotes: privateValue })),
  selectionNote: privateValue, eligibility: { awaitingSummary: 7, privateNotes: privateValue },
  settings: privateValue,
};
const expectedWeekly = {
  localDate: weekly.localDate, generatedAt: weekly.generatedAt,
  windowStart: weekly.windowStart, windowEnd: weekly.windowEnd,
  primaryWindowStart: null, estimatedMinutes: 9, isSnapshot: false,
  items: [publicArticle, { ...publicArticle, id: secondId, title: "Second original title" }],
  sections, note,
};
const coverage = {
  key: "archive-family", topic: "Original release", relation: "same_release", method: "verified-release-v1",
  windowHours: 168, materialCount: 2, newsMaterialCount: 1, editorialSourceCount: 1, officialSourceCount: 1,
  communityMaterialCount: 0, popularityBoost: 0,
  members: [{
    eventId: thirdId, contentVersion: 2, title: "  Original archived companion title  ", eventType: "release",
    relationship: "related", materialKind: "official", matchesFilters: false,
    releaseTarget: "Original project", releaseVersion: "v1.0.0", evidence: [evidence],
  }],
};
const archived = {
  ...weekly, localDate: archiveDate, generatedAt: historyItems[0].generatedAt,
  windowStart: "2026-09-14T22:00:00Z", windowEnd: "2026-09-15T22:00:00Z",
  primaryWindowStart: "2026-09-14T22:00:00Z", isSnapshot: true,
  items: [{
    ...ownerArticle,
    coverage: {
      ...coverage, ownerNotes: privateValue,
      members: coverage.members.map(member => ({
        ...member, saved: true, opened: true, notInterested: true, personalReason: privateValue,
        evidence: [ownerEvidence], recommendation: { score: 100, explanation: privateValue },
      })),
    },
  }, weekly.items[1]],
};
const expectedArchive = {
  ...expectedWeekly, localDate: archiveDate, generatedAt: archived.generatedAt,
  windowStart: archived.windowStart, windowEnd: archived.windowEnd, primaryWindowStart: archived.primaryWindowStart,
  isSnapshot: true, items: [{ ...publicArticle, coverage }, expectedWeekly.items[1]],
};
const legacyArticle = { id: thirdId, title: "Original legacy title", evidence: [] };
const legacy = {
  localDate: legacyDate, generatedAt: historyItems[1].generatedAt, isSnapshot: true,
  primaryWindowStart: null, items: [{ ...legacyArticle, saved: true, personalReason: privateValue }],
  selectionNote: privateValue,
};
const expectedLegacy = {
  localDate: legacyDate, generatedAt: legacy.generatedAt, isSnapshot: true, primaryWindowStart: null,
  items: [{ ...legacyArticle, facets: [] }], note,
};

type Reply = { status?: number; body?: unknown; raw?: string | Buffer; headers?: Record<string, string> };
type Harness = {
  url: string;
  seen: { method: string; path: string }[];
  logs: string[];
  respond: (url: URL) => Reply | Promise<Reply>;
};

function defaultReply(url: URL): Reply {
  switch (url.pathname) {
    case "/api/v1/sources": return { body: sources };
    case "/api/v1/events": return { body: {
      items: [ownerArticle], nextOffset: null, grouping: "events",
      returnedEventCount: 1, returnedMaterialCount: 1, asOf: privateValue, settings: privateValue,
    } };
    case "/api/v1/weekly": return { body: weekly };
    case "/api/v1/briefs": return { body: history };
    case "/api/v1/briefs/latest": return { body: weekly };
    case `/api/v1/briefs/${archiveDate}`: return { body: archived };
    case `/api/v1/briefs/${legacyDate}`: return { body: legacy };
    default: return { status: 404, body: { error: privateValue } };
  }
}

function origin(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a loopback TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server?: Server) {
  if (!server?.listening) return;
  await new Promise<void>((done, fail) => {
    server.close(error => error ? fail(error) : done());
    server.closeAllConnections();
  });
}

const test = base.extend<{ gateway: Harness }>({
  gateway: async ({}, use) => {
    const distRoot = resolve("tests", "e2e", `.public-reading-fixture-${randomUUID()}`);
    const harness: Harness = { url: "", seen: [], logs: [], respond: defaultReply };
    const upstream = createServer(async (request, response) => {
      harness.seen.push({ method: request.method ?? "", path: request.url ?? "" });
      try {
        const reply = await harness.respond(new URL(request.url!, "http://127.0.0.1"));
        if (response.destroyed) return;
        response.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
        response.end(reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body ?? null));
      } catch {
        response.writeHead(500);
        response.end(JSON.stringify({ error: privateValue }));
      }
    });
    let gateway: Server | undefined;
    try {
      await mkdir(distRoot);
      await writeFile(resolve(distRoot, "index.html"),
        "<!doctype html><html><head><title>Public reading fixture</title></head><body>Reading fixture</body></html>");
      await new Promise<void>((done, fail) => {
        upstream.once("error", fail);
        upstream.listen(0, "127.0.0.1", done);
      });
      gateway = await startPublicReader({
        apiOrigin: origin(upstream), distRoot, port: 0, log: (message: string) => harness.logs.push(message),
      });
      harness.url = origin(gateway);
      await use(harness);
      expect(harness.seen.every(request => request.method === "GET")).toBe(true);
      expect(harness.logs.join("\n")).not.toContain(privateValue);
    } finally {
      await Promise.all([closeServer(gateway), closeServer(upstream)]);
      await rm(distRoot, { recursive: true, force: true });
    }
  },
});

async function expectError(response: APIResponse, status = 503) {
  expect(response.status()).toBe(status);
  const body = await response.json();
  expect(body).toEqual({ error: expect.any(String) });
  expect(JSON.stringify(body)).not.toContain(privateValue);
}

function eventRequests(gateway: Harness) {
  return gateway.seen.map(request => new URL(request.path, gateway.url))
    .filter(url => url.pathname === "/api/v1/events");
}

test("visitor interests are canonical, cache-isolated and projected without owner fields",async({gateway,request})=>{
  gateway.respond=url=>{
    if(url.pathname!=="/api/v1/events")return defaultReply(url);
    const selected=url.searchParams.get("interests")?.includes("psychology:100")?secondId:firstId;
    return {body:{readerProfileApplied:true,items:[{...ownerArticle,id:selected}],nextOffset:1}};
  };
  const read=(interests:string,offset="0")=>request.get(`${gateway.url}/beta/api/events?`+
    new URLSearchParams({interests,asOf:cutoff,limit:"1",offset}));
  const first=await read("psychology:100,agents:50");
  expect(first.status()).toBe(200);
  const data=await first.json();
  expect(data.items[0].id).toBe(secondId);
  expect(JSON.stringify(data)).not.toContain(privateValue);
  expect(data).not.toHaveProperty("readerProfileApplied");
  expect((await read("agents:50,psychology:100")).status()).toBe(200);
  expect(eventRequests(gateway)).toHaveLength(1);
  expect(eventRequests(gateway)[0].searchParams.get("interests")).toBe("agents:50,psychology:100");
  expect((await (await read("agents:100")).json()).items[0].id).toBe(firstId);
  await read("agents:50,psychology:100","1");
  expect(eventRequests(gateway)).toHaveLength(3);
  expect(eventRequests(gateway).at(-1)?.searchParams.get("asOf")).toBe(cutoff);
  expect(eventRequests(gateway).at(-1)?.searchParams.get("interests")).toBe("agents:50,psychology:100");
});

test("visitor interests reach current selections, topic samples and detail but never saved editions or owner writes",async({gateway,request})=>{
  gateway.respond=url=>{
    if(url.pathname==="/api/v1/explore")return {body:{readerProfileApplied:true,sampleSize:1,limit:100,meaning:"Co-occurrence",nodes:[{id:"心理与认知",count:1}],edges:[]}};
    if(url.pathname===`/api/v1/events/${firstId}`)return {body:{...ownerArticle,readerProfileApplied:true}};
    if(url.pathname==="/api/v1/briefs/latest")return {body:{...weekly,readerProfileApplied:true}};
    return defaultReply(url);
  };
  const profile=new URLSearchParams({interests:"psychology:100"});
  const latest=await request.get(`${gateway.url}/beta/api/brief?${profile}&asOf=${encodeURIComponent(cutoff)}`);
  expect(latest.status()).toBe(200);
  expect(await latest.json()).toMatchObject({isSnapshot:false,note:expect.stringContaining("本浏览器兴趣")});
  for(const route of ["explore",`events/${firstId}`])expect((await request.get(`${gateway.url}/beta/api/${route}?${profile}`)).status()).toBe(200);
  expect(gateway.seen.every(item=>new URL(item.path,gateway.url).searchParams.get("interests")==="psychology:100")).toBe(true);
  const count=gateway.seen.length;
  for(const route of ["briefs",`briefs/${archiveDate}`,"weekly","reading","reading/sources"]) {
    await expectError(await request.get(`${gateway.url}/beta/api/${route}?${profile}`),400);
  }
  expect(gateway.seen).toHaveLength(count);
  expect(await (await request.get(`${gateway.url}/beta/api/briefs/${archiveDate}`)).json()).toEqual(expectedArchive);
  for(const route of ["/beta/api/me/interests","/api/v1/me/interests","/beta/api/brief"])
    await expectError(await request.put(gateway.url+route,{data:{topics:[{id:"psychology",weight:100}]}}),405);
});

test("visitor interests reject malformed or unsupported profiles before upstream access",async({gateway,request})=>{
  for(const interests of ["","owner:100","agents:101","agents:-1","agents:50.0","agents:050",
    "agents:50,agents:100","agents:50,","agents:50:1","心理与认知:100","agents:50&saved=true","x".repeat(513)]) {
    for(const route of ["events","explore","brief",`events/${firstId}`])
      await expectError(await request.get(`${gateway.url}/beta/api/${route}?${new URLSearchParams({interests})}`),400);
  }
  await expectError(await request.get(`${gateway.url}/beta/api/events?interests=agents:50&interests=agents:100`),400);
  await expectError(await request.get(`${gateway.url}/beta/api/brief?${new URLSearchParams({asOf:cutoff})}`),400);
  await expectError(await request.get(`${gateway.url}/beta/api/brief?interests=agents:80&saved=true`),400);
  expect(gateway.seen).toEqual([]);
});

test("visitor interests fail closed when an older upstream silently ignores the profile",async({gateway,request})=>{
  gateway.respond=url=>{
    if(url.pathname===`/api/v1/events/${firstId}`)return {body:ownerArticle};
    if(url.pathname==="/api/v1/explore")return {body:{sampleSize:1,limit:100,meaning:"Shared",nodes:[],edges:[]}};
    return defaultReply(url);
  };
  for(const route of ["events","explore","brief",`events/${firstId}`])
    await expectError(await request.get(`${gateway.url}/beta/api/${route}?interests=agents:80`));
  gateway.respond=()=>({body:{readerProfileApplied:true,items:[ownerArticle],nextOffset:null}});
  expect((await request.get(`${gateway.url}/beta/api/events?interests=agents:80`)).status()).toBe(200);
});

for (const sort of ["recommended", "newest", "score"]) {
  test(`Radar forwards bounded public filters and ${sort} ordering without private fields`, async ({gateway,request}) => {
    const query=new URLSearchParams({q:"engineering",topic:"Engineering",tier:"T1",sort,hours:"168",limit:"40",offset:"0",asOf:cutoff,includeEngineering:"true"});
    const response=await request.get(`${gateway.url}/beta/api/events?${query}`);
    expect(response.status()).toBe(200);
    const data=await response.json();
    expect(data.items).toEqual([publicArticle]);
    expect(JSON.stringify(data)).not.toContain(privateValue);
    expect(Object.fromEntries(eventRequests(gateway)[0].searchParams)).toEqual({...Object.fromEntries(query),coverage:"true"});
    for(const field of ["saved","opened","notInterested","recommendation","personalReason","score"])
      expect(data.items[0]).not.toHaveProperty(field);
  });
}

test("Radar defaults use shared recommendations instead of silently forcing newest",async({gateway,request})=>{
  const response=await request.get(`${gateway.url}/beta/api/events`);
  expect(response.status()).toBe(200);
  expect(Object.fromEntries(eventRequests(gateway)[0].searchParams)).toEqual({sort:"recommended",coverage:"true",hours:"72",limit:"30"});
});

test("topic graph forwards the same classification and cutoff but not article sort or pagination",async({gateway,request})=>{
  gateway.respond=url=>url.pathname==="/api/v1/explore"?{body:{
    sampleSize:3,limit:100,meaning:"Keyword co-occurrence",privateNotes:privateValue,
    nodes:[{id:"Engineering",count:3,ownerInterest:privateValue}],edges:[],
  }}:defaultReply(url);
  const query=new URLSearchParams({q:"engineering",topic:"Engineering",tier:"T1",hours:"168",asOf:cutoff,sort:"score",limit:"40",offset:"0"});
  const response=await request.get(`${gateway.url}/beta/api/explore?${query}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({sampleSize:3,limit:100,meaning:"Keyword co-occurrence",nodes:[{id:"Engineering",count:3}],edges:[]});
  expect(Object.fromEntries(new URL(gateway.seen[0].path,gateway.url).searchParams)).toEqual({
    q:"engineering",topic:"Engineering",tier:"T1",hours:"168",asOf:cutoff,
  });
});

for(const invalid of ["sort=private","sort=","sort=newest&sort=score","asOf=now","asOf=2026-09-16T04%3A00%3A00Z",
  "asOf=2026-02-30T04%3A00%3A00.000Z","topic="+encodeURIComponent("\u0000"),"topic="+"x".repeat(81),
  "topic=Engineering&topic=Research","saved=true","notInterested=true","source="+sourceId,"limit=41","offset=1001"]) {
  test(`Radar refuses unsupported or ambiguous filters: ${invalid.slice(0,55)}`,async({gateway,request})=>{
    for(const route of ["events","explore"])await expectError(await request.get(`${gateway.url}/beta/api/${route}?${invalid}`),400);
    expect(gateway.seen).toEqual([]);
  });
}

test("source selection exposes only T1 blog IDs and names, including disabled archives", async ({ gateway, request }) => {
  const response = await request.get(`${gateway.url}/beta/api/reading/sources`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ items: [
    { id: sourceId, name: sources.items[0].name },
    { id: disabledId, name: sources.items[1].name },
  ] });
  expect((await request.get(`${gateway.url}/beta/api/reading/sources`)).status()).toBe(200);
  expect(gateway.seen).toEqual([{ method: "GET", path: "/api/v1/sources" }]);
});

test("reading defaults constrain an ungrouped T1 technical blog queue with a canonical cutoff", async ({ gateway, request }) => {
  const before = Date.now();
  const response = await request.get(`${gateway.url}/beta/api/reading`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ items: [publicArticle], nextOffset: null, asOf: expect.any(String) });
  expect(new Date(body.asOf).toISOString()).toBe(body.asOf);
  expect(Date.parse(body.asOf)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(body.asOf)).toBeLessThanOrEqual(Date.now());
  expect(gateway.seen).toHaveLength(1);
  expect(Object.fromEntries(eventRequests(gateway)[0].searchParams)).toEqual({
    tier: "T1", kind: "blog", sort: "newest", hours: "720", limit: "40", offset: "0",
    asOf: body.asOf, technical: "true",
  });
  expect(JSON.stringify(body)).not.toContain(privateValue);
});

test("all-scope archived reading validates a disabled source without adding technical=false", async ({ gateway, request }) => {
  const query = new URLSearchParams({
    source: disabledId.toUpperCase(), scope: "all", hours: "0", limit: "1", offset: "1000", asOf: cutoff,
  });
  const response = await request.get(`${gateway.url}/beta/api/reading?${query}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ items: [publicArticle], nextOffset: null, asOf: cutoff });
  expect(gateway.seen[0]).toEqual({ method: "GET", path: "/api/v1/sources" });
  expect(gateway.seen).toHaveLength(2);
  expect(Object.fromEntries(eventRequests(gateway)[0].searchParams)).toEqual({
    source: disabledId, tier: "T1", kind: "blog", sort: "newest", hours: "0",
    limit: "1", offset: "1000", asOf: cutoff,
  });
});

test("reading preserves upstream article order, page advancement and the same asOf", async ({ gateway, request }) => {
  const ids = [thirdId, firstId, secondId];
  gateway.respond = url => {
    if (url.pathname !== "/api/v1/events") return defaultReply(url);
    const offset = Number(url.searchParams.get("offset"));
    const items = ids.slice(offset, offset + 2).map(id => ({ ...ownerArticle, id }));
    return { body: { items, nextOffset: items.length === 2 ? offset + 2 : null } };
  };
  const query = new URLSearchParams({ source: sourceId, scope: "technical", limit: "2", asOf: cutoff });
  const firstResponse = await request.get(`${gateway.url}/beta/api/reading?${query}`);
  expect(firstResponse.status()).toBe(200);
  const first = await firstResponse.json();
  expect(first).toEqual({
    items: ids.slice(0, 2).map(id => ({ ...publicArticle, id })), nextOffset: 2, asOf: cutoff,
  });
  query.set("offset", String(first.nextOffset));
  const secondResponse = await request.get(`${gateway.url}/beta/api/reading?${query}`);
  expect(secondResponse.status()).toBe(200);
  expect(await secondResponse.json()).toEqual({
    items: [{ ...publicArticle, id: secondId }], nextOffset: null, asOf: cutoff,
  });
  expect(gateway.seen.filter(request => request.path === "/api/v1/sources")).toHaveLength(1);
  expect(eventRequests(gateway).map(url => Object.fromEntries(url.searchParams))).toEqual(
    ["0", "2"].map(offset => ({
      tier: "T1", kind: "blog", sort: "newest", source: sourceId, hours: "720",
      limit: "2", offset, asOf: cutoff, technical: "true",
    })),
  );
});

test("non-null reading offsets cannot stall, move backward or skip pages from a nonzero offset", async ({ gateway, request }) => {
  const items = [ownerArticle, { ...ownerArticle, id: secondId }];
  const invalidOffsets = [0, 39, 40, 41, 43, 1000, 1001, 1040, "42", 42.5, Number.MAX_SAFE_INTEGER];
  const path = `${gateway.url}/beta/api/reading?offset=40&limit=2&asOf=${cutoff}`;
  for (const nextOffset of invalidOffsets) {
    gateway.respond = () => ({ body: { items, nextOffset } });
    await expectError(await request.get(path));
  }
  gateway.respond = () => ({ body: { items, nextOffset: 42 } });
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    items: [publicArticle, { ...publicArticle, id: secondId }], nextOffset: 42, asOf: cutoff,
  });
  expect(body.nextOffset).toBeGreaterThan(40);
  expect(body.nextOffset).toBeLessThanOrEqual(1000);
  expect(eventRequests(gateway)).toHaveLength(invalidOffsets.length + 1);
});

test("reading can advance exactly to offset 1000 and then terminates within the public pagination budget", async ({ gateway, request }) => {
  gateway.respond = url => {
    const offset = Number(url.searchParams.get("offset"));
    const ids = offset === 998 ? [firstId, secondId] : [thirdId, "44444444-4444-4444-8444-444444444444"];
    return { body: { items: ids.map(id => ({ ...ownerArticle, id })), nextOffset: offset + 2 } };
  };
  const query = new URLSearchParams({ offset: "998", limit: "2", asOf: cutoff });
  const firstResponse = await request.get(`${gateway.url}/beta/api/reading?${query}`);
  expect(firstResponse.status()).toBe(200);
  const first = await firstResponse.json();
  expect(first.nextOffset).toBe(1000);
  expect(first.asOf).toBe(cutoff);
  query.set("offset", String(first.nextOffset));
  const lastResponse = await request.get(`${gateway.url}/beta/api/reading?${query}`);
  expect(lastResponse.status()).toBe(200);
  const last = await lastResponse.json();
  expect(last.nextOffset).toBeNull();
  expect(last.paginationLimited).toBe(true);
  expect(last.asOf).toBe(cutoff);
  expect(last.items.map((item: { id: string }) => item.id)).toEqual([
    thirdId, "44444444-4444-4444-8444-444444444444",
  ]);
  expect(eventRequests(gateway).map(url => url.searchParams.get("offset"))).toEqual(["998", "1000"]);
});

test("a full page at the public offset ceiling cannot advertise an unrequestable next page", async ({ gateway, request }) => {
  const items = Array.from({ length: 40 }, (_, index) => ({
    ...ownerArticle, id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  }));
  gateway.respond = () => ({ body: { items, nextOffset: 1040 } });
  const response = await request.get(`${gateway.url}/beta/api/reading?offset=1000&asOf=${cutoff}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.items.map((item: { id: string }) => item.id)).toEqual(items.map(item => item.id));
  expect(body.nextOffset).toBeNull();
  expect(body.paginationLimited).toBe(true);
  expect(body.asOf).toBe(cutoff);
  expect(JSON.stringify(body)).not.toContain(privateValue);
});

test("empty source, reading and saved-history collections remain genuine empty results", async ({ gateway, request }) => {
  gateway.respond = url => ({ body: url.pathname === "/api/v1/events" ? { items: [], nextOffset: null } : { items: [] } });
  for (const path of ["/beta/api/reading/sources", "/beta/api/briefs"]) {
    const response = await request.get(gateway.url + path);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  }
  const response = await request.get(`${gateway.url}/beta/api/reading?asOf=${cutoff}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ items: [], nextOffset: null, asOf: cutoff });
});

test("unsupported, duplicate or malformed reading filters are rejected before any upstream call", async ({ gateway, request }) => {
  const invalid = [
    "tier=T2", "kind=release", "sort=recommended", "coverage=true", "technical=false", "includeEngineering=true",
    "saved=true", "opened=true", "notInterested=true", "q=secret", "facet=secret", "provider=secret",
    "source=not-a-uuid", "source=", `source=${sourceId}&source=${disabledId}`,
    `source=${sourceId}&%73ource=${sourceId}`, "scope=", "scope=Technical", "scope=technical&scope=all",
    "hours=1", "hours=721", "hours=-1", "hours=0720", "hours=0.0", "hours=720&hours=0",
    "limit=0", "limit=41", "limit=-1", "limit=1.5", "limit=1e1", "limit=%2B1", "limit=01",
    "limit=", "limit=2&limit=2", "offset=-1", "offset=1001", "offset=0.5", "offset=0&offset=1",
    "asOf=garbage", "asOf=", "asOf=2026-02-30T04:00:00.000Z", "asOf=2026-09-16T24:00:00.000Z",
    "asOf=2026-09-16T04:00:60.000Z", "asOf=2026-09-16T04:00:00Z",
    "asOf=2026-09-16T04:00:00.000%2B00:00", "asOf=2026-09-16T04:00:00.0000Z",
    `asOf=${cutoff}&asOf=${cutoff}`, `source=${sourceId}&limit=41`,
  ];
  for (const query of invalid) {
    await expectError(await request.get(`${gateway.url}/beta/api/reading?${query}`), 400);
  }
  expect(gateway.seen).toEqual([]);
});

test("valid UUIDs outside the public T1 blog directory never reach the event endpoint", async ({ gateway, request }) => {
  for (const id of [releaseSourceId, communitySourceId, unknownSourceId, "ffffffff-ffff-4fff-8fff-ffffffffffff"]) {
    await expectError(await request.get(`${gateway.url}/beta/api/reading?source=${id}`), 404);
  }
  expect(gateway.seen).toEqual([{ method: "GET", path: "/api/v1/sources" }]);
});

test("directory, weekly, current and archived brief APIs accept no query parameters", async ({ gateway, request }) => {
  for (const path of [
    "/beta/api/reading/sources", "/beta/api/weekly", "/beta/api/briefs",
    `/beta/api/briefs/${archiveDate}`, "/beta/api/brief",
  ]) {
    for (const query of ["hours=0", `source=${sourceId}`, "date=2026-09-15", "unknown=", "limit=1&limit=1"]) {
      await expectError(await request.get(`${gateway.url}${path}?${query}`), 400);
    }
  }
  expect(gateway.seen).toEqual([]);
});

test("weekly review retains the rolling window, editorial sections, source material and article order", async ({ gateway, request }) => {
  const response = await request.get(`${gateway.url}/beta/api/weekly`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual(expectedWeekly);
  expect(JSON.stringify(body)).not.toContain(privateValue);
  expect(gateway.seen).toEqual([{ method: "GET", path: "/api/v1/weekly" }]);
});

test("saved history exposes only summary metadata without sorting or fetching editions", async ({ gateway, request }) => {
  const response = await request.get(`${gateway.url}/beta/api/briefs`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ items: historyItems });
  expect(gateway.seen).toEqual([{ method: "GET", path: "/api/v1/briefs" }]);
});

test("archive access checks saved history first and preserves snapshot titles, coverage and sections", async ({ gateway, request }) => {
  const original = JSON.stringify(archived);
  const response = await request.get(`${gateway.url}/beta/api/briefs/${archiveDate}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual(expectedArchive);
  expect(JSON.stringify(body)).not.toContain(privateValue);
  expect(body.items[0].coverage.members.map((member: { eventId: string }) => member.eventId)).toEqual([thirdId]);
  expect(gateway.seen).toEqual([
    { method: "GET", path: "/api/v1/briefs" },
    { method: "GET", path: `/api/v1/briefs/${archiveDate}` },
  ]);
  expect(projectBrief(archived)).toEqual(expectedArchive);
  expect(JSON.stringify(archived)).toBe(original);
});

test("legacy saved snapshots keep absent optional reading fields absent and retain nullable old metadata", async ({ gateway, request }) => {
  const response = await request.get(`${gateway.url}/beta/api/briefs/${legacyDate}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toEqual(expectedLegacy);
  expect(body).not.toHaveProperty("sections");
  expect(body).not.toHaveProperty("windowStart");
  expect(body.items[0]).not.toHaveProperty("displayTitle");
  expect(body.items[0]).not.toHaveProperty("editorial");
  expect(gateway.seen.map(request => request.path)).toEqual(["/api/v1/briefs", `/api/v1/briefs/${legacyDate}`]);
});

test("current-selection brief remains compatible and isSnapshot is a validated optional flag", async ({ gateway, request }) => {
  const oldBrief = { items: [legacyArticle], localDate: legacyDate };
  gateway.respond = url => url.pathname === "/api/v1/briefs/latest" ? { body: oldBrief } : defaultReply(url);
  const response = await request.get(`${gateway.url}/beta/api/brief`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ items: [{ ...legacyArticle, facets: [] }], localDate: legacyDate, note });
  expect(gateway.seen).toEqual([{ method: "GET", path: "/api/v1/briefs/latest" }]);
  expect(projectBrief(oldBrief)).not.toHaveProperty("isSnapshot");
  for (const isSnapshot of [true, false]) expect(projectBrief({ ...oldBrief, isSnapshot }).isSnapshot).toBe(isSnapshot);
  for (const isSnapshot of ["true", 1, null, {}, []]) expect(() => projectBrief({ ...oldBrief, isSnapshot })).toThrow();
});

test("radar, article detail and exploration preserve projections with the shared recommendation default", async ({ gateway, request }) => {
  const explore = {
    sampleSize: 1, limit: 100, meaning: "Topic co-occurrence only.",
    nodes: [{ id: "Engineering", count: 1 }], edges: [{ source: "Engineering", target: "Research", count: 1 }],
  };
  gateway.respond = url => {
    if (url.pathname === `/api/v1/events/${firstId}`) return { body: ownerArticle };
    if (url.pathname === "/api/v1/explore") return { body: {
      ...explore, settings: privateValue,
      nodes: explore.nodes.map(node => ({ ...node, privateNotes: privateValue })),
      edges: explore.edges.map(edge => ({ ...edge, privateNotes: privateValue })),
    } };
    return defaultReply(url);
  };
  const radar = await request.get(`${gateway.url}/beta/api/events?hours=0&limit=1`);
  expect(radar.status()).toBe(200);
  expect(await radar.json()).toEqual({
    items: [publicArticle], nextOffset: null, returnedEventCount: 1, returnedMaterialCount: 1,
  });
  expect(Object.fromEntries(eventRequests(gateway)[0].searchParams)).toEqual({
    hours: "0", limit: "1", sort: "recommended", coverage: "true",
  });
  const detail = await request.get(`${gateway.url}/beta/api/events/${firstId}`);
  expect(detail.status()).toBe(200);
  expect(await detail.json()).toEqual(publicArticle);
  const graph = await request.get(`${gateway.url}/beta/api/explore?tier=T1&limit=2&offset=3`);
  expect(graph.status()).toBe(200);
  expect(await graph.json()).toEqual(explore);
  expect(gateway.seen[2].path).toBe("/api/v1/explore?tier=T1");
  for (const query of ["source=" + sourceId, "kind=blog", "asOf=invalid", "saved=true"]) {
    await expectError(await request.get(`${gateway.url}/beta/api/events?${query}`), 400);
  }
  expect(gateway.seen).toHaveLength(3);
});

test("unsaved dates, including today, return 404 without requesting a dated fallback or generator", async ({ gateway, request }) => {
  gateway.respond = url => url.pathname === "/api/v1/briefs" ? { body: { items: [] } } : defaultReply(url);
  const shanghaiToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const date of [archiveDate, shanghaiToday, "2000-02-29"]) {
    await expectError(await request.get(`${gateway.url}/beta/api/briefs/${date}`), 404);
  }
  expect(gateway.seen).toEqual([{ method: "GET", path: "/api/v1/briefs" }]);
});

test("saved-history authorization is checked even before returning an already cached archive", async ({ gateway, request }) => {
  expect((await request.get(`${gateway.url}/beta/api/briefs`)).status()).toBe(200);
  const now = Date.now;
  let elapsed = 15_000;
  try {
    Date.now = () => now() + elapsed;
    const response = await request.get(`${gateway.url}/beta/api/briefs/${archiveDate}`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(expectedArchive);
    gateway.respond = url => url.pathname === "/api/v1/briefs" ? { body: { items: [] } } : defaultReply(url);
    elapsed = 31_000;
    await expectError(await request.get(`${gateway.url}/beta/api/briefs/${archiveDate}`), 404);
    expect(gateway.seen.map(request => request.path)).toEqual([
      "/api/v1/briefs", `/api/v1/briefs/${archiveDate}`, "/api/v1/briefs",
    ]);
  } finally {
    Date.now = now;
  }
});

test("invalid calendar dates and non-date archive paths are rejected before history lookup", async ({ gateway, request }) => {
  for (const date of ["2026-02-30", "2025-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "0000-01-01"]) {
    await expectError(await request.get(`${gateway.url}/beta/api/briefs/${date}`), 400);
  }
  for (const date of ["not-a-date", "today", "latest", "2026-9-15", "2026-09-15T00:00:00Z"]) {
    await expectError(await request.get(`${gateway.url}/beta/api/briefs/${date}`), 404);
  }
  expect(gateway.seen).toEqual([]);
});

test("an archive must be an actual saved snapshot for the exact requested date", async ({ gateway, request }) => {
  const { isSnapshot: _snapshot, ...missingFlag } = archived;
  for (const body of [
    { ...archived, isSnapshot: false }, missingFlag, { ...archived, isSnapshot: "true" },
    { ...archived, localDate: "2026-09-14" }, { ...archived, localDate: { privateValue } },
    { ...archived, items: null }, null,
  ]) {
    gateway.respond = url => url.pathname === `/api/v1/briefs/${archiveDate}` ? { body } : defaultReply(url);
    await expectError(await request.get(`${gateway.url}/beta/api/briefs/${archiveDate}`));
  }
  expect(gateway.seen.filter(request => request.path === "/api/v1/briefs")).toHaveLength(1);
  expect(gateway.seen.filter(request => request.path === `/api/v1/briefs/${archiveDate}`)).toHaveLength(7);
  expect(gateway.seen.every(request => ["/api/v1/briefs", `/api/v1/briefs/${archiveDate}`].includes(request.path))).toBe(true);
});

test("malformed source directories fail closed rather than silently becoming empty selectors", async ({ gateway, request }) => {
  const source = sources.items[0];
  for (const body of [
    null, { error: privateValue }, { items: {} }, { items: [null] }, { items: [{ id: sourceId, name: "Missing type" }] },
    { items: [{ ...source, id: "bad-id" }] }, { items: [{ ...source, name: { privateValue } }] },
    { items: [{ ...source, name: " " }] }, { items: [{ ...source, name: "x".repeat(121) }] },
    { items: [{ ...source, name: "\u0000" }] },
    { items: [source, { ...source, id: sourceId.toUpperCase() }] },
    { items: Array.from({ length: 1001 }, () => source) },
  ]) {
    gateway.respond = () => ({ body });
    await expectError(await request.get(`${gateway.url}/beta/api/reading/sources`));
    await expectError(await request.get(`${gateway.url}/beta/api/reading?source=${sourceId}`));
  }
  expect(gateway.seen.every(request => request.path === "/api/v1/sources")).toBe(true);
});

test("source names are bounded by characters rather than truncating legitimate Unicode names", async ({ gateway, request }) => {
  gateway.respond = () => ({ body: { items: [{ ...sources.items[0], name: "📰".repeat(120) }] } });
  const response = await request.get(`${gateway.url}/beta/api/reading/sources`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ items: [{ id: sourceId, name: "📰".repeat(120) }] });
});

test("malformed saved-history metadata fails before any archive read", async ({ gateway, request }) => {
  const item = historyItems[0];
  for (const body of [
    null, { error: privateValue }, { items: {} }, { items: [null] },
    { items: [{ ...item, localDate: "2026-02-30" }] }, { items: [{ ...item, localDate: "2026-9-15" }] },
    { items: [{ ...item, generatedAt: "yesterday" }] }, { items: [{ ...item, generatedAt: "2026-02-30T00:00:00Z" }] },
    { items: [{ ...item, generatedAt: "2026-09-15T24:00:00Z" }] },
    { items: [{ ...item, generatedAt: { privateValue } }] },
    ...[-1, 31, 0.5, "3", null, Number.MAX_SAFE_INTEGER + 1].map(itemCount => ({ items: [{ ...item, itemCount }] })),
    { items: [item, item] }, { items: Array.from({ length: 366 }, () => item) },
  ]) {
    gateway.respond = () => ({ body });
    await expectError(await request.get(`${gateway.url}/beta/api/briefs/${archiveDate}`));
  }
  expect(gateway.seen.every(request => request.path === "/api/v1/briefs")).toBe(true);
});

test("reading pagination and malformed article projections fail closed without success-shaped fallbacks", async ({ gateway, request }) => {
  for (const body of [
    null, { error: privateValue }, { items: {} }, { items: [] },
    { items: [], nextOffset: 0 }, { items: [ownerArticle], nextOffset: "1" },
    { items: [ownerArticle], nextOffset: -1 }, { items: [ownerArticle], nextOffset: 2 },
    { items: [ownerArticle], nextOffset: 0.5 }, { items: [ownerArticle], nextOffset: Number.MAX_SAFE_INTEGER },
    { items: [{ ...ownerArticle, id: "invalid" }], nextOffset: null },
    { items: [{ ...ownerArticle, title: null }], nextOffset: null },
    { items: [{ ...ownerArticle, evidence: {} }], nextOffset: null },
    { items: [{ ...ownerArticle, editorial: { ...ownerArticle.editorial, reason: { privateValue } } }], nextOffset: null },
    { items: [{ ...ownerArticle, evidence: [{ ...ownerEvidence, readingContext: { ...context, body: "x".repeat(16001) } }] }], nextOffset: null },
    { items: [ownerArticle, ownerArticle], nextOffset: null },
    { items: Array.from({ length: 41 }, () => ownerArticle), nextOffset: null },
  ]) {
    gateway.respond = () => ({ body });
    await expectError(await request.get(`${gateway.url}/beta/api/reading?asOf=${cutoff}`));
  }
  expect(eventRequests(gateway)).toHaveLength(17);
});

test("weekly and snapshot projection rejects malformed public metadata and membership", async ({ gateway, request }) => {
  for (const body of [
    { ...weekly, localDate: "2026-02-30" }, { ...weekly, generatedAt: { privateValue } },
    { ...weekly, windowStart: "not-a-time" }, { ...weekly, windowEnd: "2026-09-16T25:00:00Z" },
    { ...weekly, primaryWindowStart: { privateValue } }, { ...weekly, estimatedMinutes: -1 },
    { ...weekly, estimatedMinutes: 1.5 }, { ...weekly, isSnapshot: privateValue },
    { ...weekly, items: Array.from({ length: 31 }, () => ownerArticle) },
    { ...weekly, sections: [{ ...sections[0], eventIds: [thirdId] }, sections[1]] },
    { ...weekly, sections: [...sections].reverse() },
    { ...weekly, items: [{ ...ownerArticle, coverage: { ...coverage, members: null } }] },
  ]) {
    gateway.respond = () => ({ body });
    await expectError(await request.get(`${gateway.url}/beta/api/weekly`));
  }
  expect(gateway.seen.every(request => request.path === "/api/v1/weekly")).toBe(true);
});

for (const [publicPath, upstreamPath] of [
  ["/beta/api/reading/sources", "/api/v1/sources"],
  [`/beta/api/reading?asOf=${cutoff}`, "/api/v1/events"],
  [`/beta/api/reading?source=${sourceId}&asOf=${cutoff}`, "/api/v1/sources"],
  ["/beta/api/weekly", "/api/v1/weekly"],
  ["/beta/api/briefs", "/api/v1/briefs"],
  [`/beta/api/briefs/${archiveDate}`, "/api/v1/briefs"],
  [`/beta/api/briefs/${archiveDate}`, `/api/v1/briefs/${archiveDate}`],
]) {
  test(`upstream errors stay errors for ${publicPath} via ${upstreamPath}`, async ({ gateway, request }) => {
    for (const reply of [
      { status: 500, body: { error: privateValue } },
      { status: 503, body: { error: privateValue } },
      { status: 404, body: { error: privateValue } },
      { status: 302, headers: { Location: "/api/v1/processing" }, body: { error: privateValue } },
      { status: 204 },
      { raw: `invalid-json-${privateValue}` },
      { body: { error: privateValue } },
    ]) {
      gateway.respond = url => url.pathname === upstreamPath ? reply : defaultReply(url);
      await expectError(await request.get(gateway.url + publicPath), reply.status === 404 ? 404 : 503);
    }
    expect(gateway.seen.some(request => request.path.includes("processing"))).toBe(false);
  });
}

test("projected caches last 30 seconds but expired or failed upstream data never masks an error", async ({ gateway, request }) => {
  const path = `${gateway.url}/beta/api/weekly`;
  expect(await (await request.get(path)).json()).toEqual(expectedWeekly);
  gateway.respond = () => ({ status: 500, body: { error: privateValue } });
  expect(await (await request.get(path)).json()).toEqual(expectedWeekly);
  expect(gateway.seen).toHaveLength(1);
  const now = Date.now;
  try {
    Date.now = () => now() + 31_000;
    await expectError(await request.get(path));
    await expectError(await request.get(path));
    expect(gateway.seen).toHaveLength(3);
    gateway.respond = defaultReply;
    const recovered = await request.get(path);
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual(expectedWeekly);
    expect(gateway.seen).toHaveLength(4);
  } finally {
    Date.now = now;
  }
});

test("upstream JSON remains bounded to eight MiB", async ({ gateway, request }) => {
  gateway.respond = () => ({ raw: `"${"x".repeat(8 * 1024 * 1024)}"` });
  await expectError(await request.get(`${gateway.url}/beta/api/weekly`));
  expect(gateway.seen).toHaveLength(1);
});

test("new routes share the existing four-slot upstream concurrency bound", async ({ gateway, request }) => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  gateway.respond = async () => {
    await held;
    return { body: { items: [], nextOffset: null } };
  };
  const pending = Array.from({ length: 4 }, (_, offset) =>
    request.get(`${gateway.url}/beta/api/reading?offset=${offset}&asOf=${cutoff}`));
  try {
    await expect.poll(() => gateway.seen.length).toBe(4);
    await expectError(await request.get(`${gateway.url}/beta/api/reading?offset=4&asOf=${cutoff}`));
    expect(gateway.seen).toHaveLength(4);
  } finally {
    release();
    for (const response of await Promise.all(pending)) expect(response.status()).toBe(200);
  }
});

test("all mutation methods are denied before routing, even on otherwise valid public APIs", async ({ gateway, request }) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    for (const path of [
      "/beta/api/reading", "/beta/api/reading/sources", "/beta/api/weekly", "/beta/api/briefs",
      `/beta/api/briefs/${archiveDate}`, "/api/v1/events/exposures", "/beta/api/briefs/today/generate", "/shares",
    ]) {
      await expectError(await request.fetch(gateway.url + path, { method, data: { saved: true } }), 405);
    }
  }
  expect(gateway.seen).toEqual([]);
});

test("GET requests with bodies cannot reach upstream", async ({ gateway }) => {
  for (const headers of [{ "Content-Length": "1" }, { "Transfer-Encoding": "chunked" }]) {
    const status = await new Promise<number | undefined>((done, fail) => {
      const request = httpRequest(`${gateway.url}/beta/api/reading`, { method: "GET", headers }, response => {
        response.resume();
        response.on("end", () => done(response.statusCode));
      });
      request.on("error", fail);
      request.end("x");
    });
    expect(status).toBe(400);
  }
  expect(gateway.seen).toEqual([]);
});

test("owner routes, management APIs and archive generators remain inaccessible", async ({ gateway, request }) => {
  for (const path of [
    "/sources", "/settings", "/topics", "/shares", "/api/v1/sources", "/api/v1/weekly", "/api/v1/briefs",
    "/api/v1/processing", "/api/v1/model-providers", "/api/v1/events?saved=true", "/api/v1/events/exposures",
    "/beta/api/sources", `/beta/api/reading/sources/${sourceId}`, `/beta/api/reading/sources/${sourceId}/refresh`,
    "/beta/api/briefs/today/generate", `/beta/api/briefs/${archiveDate}/save`, "/beta/api/shares",
    "/beta/api/weekly/generate", "/beta/api/settings", "/beta/api/reading/refresh", "/src/main.tsx",
  ]) {
    await expectError(await request.get(gateway.url + path), 404);
  }
  expect(gateway.seen).toEqual([]);
});

test("reading and weekly SPA navigation serves only the public entry point with security headers", async ({ gateway, request }) => {
  for (const path of ["/", "/reading", "/weekly", "/radar", "/saved", `/events/${firstId}`]) {
    const response = await request.get(gateway.url + path);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    expect(response.headers()["content-security-policy"]).toContain("connect-src 'self'");
    expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers()["content-security-policy"]).toContain("sha256-");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.text()).toContain('dataset.publicReader="true"');
    const head = await request.head(gateway.url + path);
    expect(head.status()).toBe(200);
    expect(await head.body()).toHaveLength(0);
  }
  expect(gateway.seen).toEqual([]);
});

test("public HEAD API requests use only GET upstream and never return response bodies", async ({ gateway, request }) => {
  for (const path of [
    "/beta/api/reading/sources", `/beta/api/reading?asOf=${cutoff}`, "/beta/api/weekly",
    "/beta/api/briefs", `/beta/api/briefs/${archiveDate}`,
  ]) {
    const response = await request.head(gateway.url + path);
    expect(response.status()).toBe(200);
    expect(await response.body()).toHaveLength(0);
  }
  expect(gateway.seen.map(request => new URL(request.path, gateway.url).pathname)).toEqual([
    "/api/v1/sources", "/api/v1/events", "/api/v1/weekly", "/api/v1/briefs", `/api/v1/briefs/${archiveDate}`,
  ]);
});
