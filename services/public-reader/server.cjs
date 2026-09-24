const { createServer } = require("node:http");
const { readFile, realpath, stat } = require("node:fs/promises");
const { resolve, sep, extname } = require("node:path");
const { createHash } = require("node:crypto");
const interestTopics = require("../../shared/reader-interest-topics.json");

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const articleFields = ["id", "contentVersion", "title", "summary", "importance", "primaryTopic", "topics", "eventType", "publishedAt",
  "freshnessAt", "publicationPrecision", "summaryKind", "summaryModel", "summaryFormatVersion", "summaryPoints",
  "summaryMaterialLimit", "summaryLimitations", "summarizedAt"];
const evidenceFields = ["id", "sourceName", "sourceTier", "title", "url", "isOfficial", "publishedAt",
  "originalPublishedAt", "publicationPrecision", "excerpt", "technicalBasis"];
const coverageFields = ["key", "topic", "relation", "method", "windowHours", "materialCount", "newsMaterialCount",
  "editorialSourceCount", "officialSourceCount", "communityMaterialCount", "popularityBoost"];
const memberFields = ["eventId", "contentVersion", "title", "eventType", "publishedAt", "publicationPrecision",
  "summaryKind", "summary", "summaryPoints", "summaryMaterialLimit", "summaryLimitations", "summaryModel",
  "summarizedAt", "relationship", "materialKind", "matchesFilters", "releaseTarget", "releaseVersion"];

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream object");
  return value;
}
function pick(value, fields) {
  value = record(value);
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function boundedText(value, limit) {
  return typeof value === "string" && value.length <= limit * 2 && [...value].length <= limit;
}
function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const time = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function utcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)
    && calendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function projectDisplayTitle(value) {
  if (value == null) return null;
  if (!boundedText(value, 180) || !value.trim()) throw new Error("Invalid reading title");
  return value.trim();
}
function projectEditorial(value) {
  value = record(value);
  if (!boundedText(value.policyVersion, 80)
    || !["news", "release", "research", "analysis", "tutorial", "discussion", "question", "promotion", "metadata"].includes(value.contentKind)
    || !Number.isFinite(value.valueScore) || value.valueScore < 0 || value.valueScore > 100
    || !boundedText(value.reason, 600) || typeof value.briefEligible !== "boolean") {
    throw new Error("Invalid editorial context");
  }
  return pick(value, ["policyVersion", "contentKind", "reason"]);
}
function publicLink(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.startsWith("[") || /^(?:0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
    return url.protocol === "https:" && !url.username && !url.password && !privateHost ? url.href : null;
  } catch { return null; }
}
function projectReadingContext(value) {
  value = record(value);
  const textWithin = (text, limit) => typeof text === "string" && text.length <= limit * 2 && [...text].length <= limit;
  if (value.version !== 1 || !["article", "post", "podcast", "release", "feed"].includes(value.kind)
    || !["feed", "publisher_page", "authorized_api"].includes(value.origin)
    || !["available", "partial", "unavailable", "blocked"].includes(value.status)
    || !textWithin(value.body, 16000) || typeof value.truncated !== "boolean"
    || !Array.isArray(value.chapters) || value.chapters.length > 200
    || !Array.isArray(value.comments) || value.comments.length > 10
    || !["not_applicable", "requires_authorization", "not_fetched", "available"].includes(value.commentsStatus)) {
    throw new Error("Invalid upstream reading context");
  }
  const context = pick(value, ["version", "kind", "origin", "status", "body", "truncated", "commentsStatus"]);
  context.sourceUrl = publicLink(value.sourceUrl) ?? "";
  context.transcriptUrl = publicLink(value.transcriptUrl);
  if (value.durationSeconds != null && (!Number.isFinite(value.durationSeconds) || value.durationSeconds < 0))
    throw new Error("Invalid episode duration");
  context.durationSeconds = value.durationSeconds ?? null;
  if (value.fetchedAt != null && (typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt))))
    throw new Error("Invalid context timestamp");
  context.fetchedAt = value.fetchedAt ?? null;
  context.chapters = value.chapters.map(chapter => {
    chapter = record(chapter);
    if (!Number.isFinite(chapter.startSeconds) || chapter.startSeconds < 0
      || !textWithin(chapter.title, 500)) throw new Error("Invalid episode chapter");
    return { startSeconds: chapter.startSeconds, title: chapter.title, url: publicLink(chapter.url) };
  });
  context.comments = value.comments.map(comment => {
    comment = record(comment);
    if (!textWithin(comment.id, 200) || !textWithin(comment.body, 5000)
      || !(comment.score === null || Number.isSafeInteger(comment.score)))
      throw new Error("Invalid post comment");
    if (comment.author != null && !textWithin(comment.author, 100)
      || comment.publishedAt != null && (typeof comment.publishedAt !== "string" || !Number.isFinite(Date.parse(comment.publishedAt)))
      || comment.truncated != null && typeof comment.truncated !== "boolean")
      throw new Error("Invalid comment attribution");
    return { id: comment.id, body: comment.body, score: comment.score, url: publicLink(comment.url),
      author: comment.author ?? null, publishedAt: comment.publishedAt ?? null, truncated: comment.truncated ?? false };
  });
  return context;
}
function projectEvidence(source) {
  const projected = pick(source, evidenceFields);
  projected.url = publicLink(projected.url);
  if (source.readingContext != null) projected.readingContext = projectReadingContext(source.readingContext);
  return projected;
}
function projectArticle(value) {
  value = record(value);
  if (!uuid.test(value.id) || typeof value.title !== "string" || !Array.isArray(value.evidence)) {
    throw new Error("Invalid upstream article");
  }
  if (value.contentVersion !== undefined
    && (!Number.isSafeInteger(value.contentVersion) || value.contentVersion < 0)) {
    throw new Error("Invalid content version");
  }
  const article = pick(value, articleFields);
  if (value.displayTitle !== undefined) article.displayTitle = projectDisplayTitle(value.displayTitle);
  if (value.editorial != null) article.editorial = projectEditorial(value.editorial);
  article.evidence = value.evidence.map(projectEvidence);
  article.facets = Array.isArray(value.recommendation?.facets)
    ? value.recommendation.facets.filter(facet => typeof facet === "string") : [];
  if (value.coverage) {
    article.coverage = pick(value.coverage, coverageFields);
    article.coverage.members = value.coverage.members.map(member => {
      if (!uuid.test(member.eventId)
        || !Number.isSafeInteger(member.contentVersion) || member.contentVersion < 0
        || !Array.isArray(member.evidence)) throw new Error("Invalid coverage member");
      const projected = { ...pick(member, memberFields), evidence: member.evidence.map(source => {
        const projected = projectEvidence(source);
        projected.url ??= "";
        return projected;
      }) };
      if (member.displayTitle !== undefined) projected.displayTitle = projectDisplayTitle(member.displayTitle);
      return projected;
    });
  }
  return article;
}

function projectBrief(value) {
  value = record(value);
  if (!Array.isArray(value.items) || value.items.length > 30) throw new Error("Invalid edition");
  if (value.localDate !== undefined && !calendarDate(value.localDate)
    || ["generatedAt", "windowStart", "windowEnd"].some(key => value[key] !== undefined && !utcTimestamp(value[key]))
    || value.primaryWindowStart != null && !utcTimestamp(value.primaryWindowStart)
    || value.nextRefreshAt != null && !utcTimestamp(value.nextRefreshAt)
    || value.estimatedMinutes !== undefined
      && (!Number.isSafeInteger(value.estimatedMinutes) || value.estimatedMinutes < 0 || value.estimatedMinutes > 1440)
    || value.isSnapshot !== undefined && typeof value.isSnapshot !== "boolean"
    || value.refreshPending !== undefined && typeof value.refreshPending !== "boolean") {
    throw new Error("Invalid edition metadata");
  }
  const items = value.items.map(projectArticle);
  const brief = {
    ...pick(value, ["localDate", "generatedAt", "windowStart", "windowEnd", "primaryWindowStart", "estimatedMinutes", "isSnapshot", "nextRefreshAt", "refreshPending"]),
    items, note: "共享选文；收藏和阅读记录属于各自浏览器，不改动站主设置。",
  };
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections) || value.sections.length > 30) throw new Error("Invalid edition sections");
    const seen = new Set(), keys = new Set(), ids = items.map(item => item.id);
    brief.sections = value.sections.map(section => {
      section = record(section);
      if (!boundedText(section.key, 100) || !section.key.trim() || keys.has(section.key)
        || !["essential", "catch_up", "more", "topic"].includes(section.kind)
        || !boundedText(section.title, 120) || !section.title.trim()
        || !boundedText(section.description, 500)
        || !Array.isArray(section.eventIds) || !section.eventIds.length || section.eventIds.length > 30) {
        throw new Error("Invalid edition section");
      }
      keys.add(section.key);
      for (const id of section.eventIds) {
        if (typeof id !== "string" || !uuid.test(id) || !ids.includes(id) || seen.has(id)) {
          throw new Error("Invalid edition membership");
        }
        seen.add(id);
      }
      return { ...pick(section, ["key", "kind", "title", "description"]), eventIds: [...section.eventIds] };
    });
    if (brief.sections.length && (seen.size !== ids.length
      || brief.sections.flatMap(section => section.eventIds).some((id, index) => id !== ids[index]))) {
      throw new Error("Inconsistent edition order");
    }
  }
  return brief;
}

function projectReadingSources(value) {
  value = record(value);
  if (!Array.isArray(value.items) || value.items.length > 1000) throw new Error("Invalid source directory");
  const items = [], ids = new Set();
  for (let source of value.items) {
    source = record(source);
    if (typeof source.tier !== "string" || typeof source.contentType !== "string") throw new Error("Invalid source kind");
    if (source.tier !== "T1" || source.contentType !== "blog") continue;
    if (typeof source.id !== "string" || !uuid.test(source.id) || ids.has(source.id.toLowerCase())
      || !boundedText(source.name, 120) || !source.name.trim() || /[\u0000-\u001f\u007f]/.test(source.name)) {
      throw new Error("Invalid public source");
    }
    ids.add(source.id.toLowerCase());
    items.push({ id: source.id, name: source.name });
  }
  return { items };
}

function projectBriefHistory(value) {
  value = record(value);
  if (!Array.isArray(value.items) || value.items.length > 365) throw new Error("Invalid saved edition directory");
  const dates = new Set();
  return { items: value.items.map(item => {
    item = record(item);
    if (!calendarDate(item.localDate) || dates.has(item.localDate) || !utcTimestamp(item.generatedAt)
      || !Number.isSafeInteger(item.itemCount) || item.itemCount < 0 || item.itemCount > 30) {
      throw new Error("Invalid saved edition summary");
    }
    dates.add(item.localDate);
    return pick(item, ["localDate", "generatedAt", "itemCount"]);
  }) };
}

function readingParameters(search) {
  const accepted = new Set(["source", "scope", "hours", "limit", "offset", "asOf"]), seen = new Set();
  for (const [key, value] of search) {
    if (!accepted.has(key) || seen.has(key)) throw new Error("Invalid reading filter");
    seen.add(key);
    if (key === "source" && !uuid.test(value)
      || key === "scope" && !["technical", "all"].includes(value)
      || key === "hours" && !["720", "0"].includes(value)
      || key === "asOf" && (!utcTimestamp(value) || new Date(value).toISOString() !== value)) {
      throw new Error("Invalid reading filter");
    }
    if (key === "limit" || key === "offset") {
      const [minimum, maximum] = key === "limit" ? [1, 40] : [0, 1000];
      if (!/^(?:0|[1-9]\d*)$/.test(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new Error("Invalid reading range");
      }
    }
  }
  const query = new URLSearchParams({
    tier: "T1", kind: "blog", sort: "newest",
    hours: search.get("hours") ?? "720", limit: search.get("limit") ?? "40", offset: search.get("offset") ?? "0",
    asOf: search.get("asOf") ?? new Date().toISOString(),
  });
  if (search.has("source")) query.set("source", search.get("source").toLowerCase());
  if ((search.get("scope") ?? "technical") === "technical") query.set("technical", "true");
  return query;
}

function projectReadingPage(value, query) {
  value = record(value);
  const limit = Number(query.get("limit")), offset = Number(query.get("offset"));
  if (!Array.isArray(value.items) || value.items.length > limit
    || value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset)
      || value.nextOffset <= offset || value.items.length !== limit
      || value.nextOffset !== offset + value.items.length)) {
    throw new Error("Invalid reading pagination");
  }
  const items = value.items.map(projectArticle);
  if (new Set(items.map(item => item.id.toLowerCase())).size !== items.length) throw new Error("Repeated reading article");
  const paginationLimited = value.nextOffset > 1000;
  return { items, nextOffset: paginationLimited ? null : value.nextOffset, asOf: query.get("asOf"),
    ...(paginationLimited ? { paginationLimited: true } : {}) };
}

function canonicalInterests(value) {
  if (!value || value.length > 512) throw new Error("Invalid visitor interests");
  const ids = new Set(), entries = value.split(",");
  if (entries.length > interestTopics.length) throw new Error("Too many visitor interests");
  const normalized = entries.map(entry => {
    const match = /^([a-z]+):(0|[1-9]\d?|100)$/.exec(entry);
    if (!match || ids.has(match[1]) || !interestTopics.some(topic => topic.id === match[1])) {
      throw new Error("Invalid visitor interest");
    }
    ids.add(match[1]);
    return `${match[1]}:${Number(match[2])}`;
  });
  return normalized.sort().join(",");
}

function preferenceParameters(search, allowCutoff = false) {
  for (const key of search.keys()) {
    if (key !== "interests" && !(allowCutoff && key === "asOf")) throw new Error("Invalid preference request");
  }
  const query = parameters(search);
  if (query.has("asOf") && !query.has("interests")) throw new Error("Cutoff requires visitor interests");
  return query;
}

function checkedProfile(value, query) {
  if (query?.has("interests") && record(value).readerProfileApplied !== true) {
    throw new Error("Upstream did not apply visitor interests");
  }
  return value;
}

function parameters(search) {
  const result = new URLSearchParams();
  const accepted = new Set(["q", "tier", "hours", "limit", "offset", "facet", "topic", "sort", "asOf", "includeEngineering", "interests"]);
  for (const [key, value] of search) {
    if (!accepted.has(key) || result.has(key)) throw new Error("Invalid filter");
    if (key === "interests") {
      result.set(key, canonicalInterests(value));
      continue;
    } else if (key === "q" || key === "facet" || key === "topic") {
      if (value.length > (key === "q" ? 200 : 80) || /[\u0000-\u001f]/.test(value)) throw new Error("Invalid text filter");
    } else if (key === "sort") {
      if (!["recommended", "newest", "score"].includes(value)) throw new Error("Invalid sort");
    } else if (key === "asOf") {
      if (!utcTimestamp(value) || new Date(value).toISOString() !== value) throw new Error("Invalid cutoff");
    } else if (key === "includeEngineering") {
      if (!["true", "false"].includes(value)) throw new Error("Invalid engineering filter");
    } else if (key === "tier") {
      if (!["T1", "T1.5", "T2"].includes(value)) throw new Error("Invalid tier");
    } else {
      const [minimum, maximum] = key === "limit" ? [1, 40] : key === "offset" ? [0, 1000] : [0, 720];
      if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error("Invalid range");
    }
    result.set(key, value);
  }
  return result;
}

async function startPublicReader({
  apiOrigin = "http://127.0.0.1:8080",
  distRoot = resolve(__dirname, "..", "..", "apps", "web", "dist"),
  port = 5190,
  log = message => console.error(message),
} = {}) {
  const upstream = new URL(apiOrigin);
  if (upstream.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("The public reader upstream must be a loopback HTTP origin.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid public reader port.");
  const root = await realpath(distRoot);
  const original = await readFile(resolve(root, "index.html"), "utf8");
  if (original.includes('src="/src/')) throw new Error("Build the production frontend before starting the public reader.");
  const html = original.replace(/\r\n/g, "\n").replace("<head>", '<head><script>document.documentElement.dataset.publicReader="true";</script><meta name="robots" content="noindex,nofollow">');
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1].trim()).map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`).join(" ");
  const policy = `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  const cache = new Map();
  let inFlight = 0, windowStart = Date.now(), requests = 0;

  async function fetchJson(path) {
    const found = cache.get(path);
    if (found && found.until > Date.now()) return found.value;
    if (inFlight >= 4) throw new Error("Upstream concurrency limit");
    inFlight++;
    try {
      const response = await fetch(new URL(path, upstream), { signal: AbortSignal.timeout(20_000), redirect: "error" });
      if (!response.ok || !response.body) {
        const error = new Error("Upstream unavailable");
        error.status = response.status;
        throw error;
      }
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("Upstream response too large"); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { inFlight--; }
  }
  function remember(path, value) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(path, { value, until: Date.now() + 30_000 });
    return value;
  }
  async function publicData(path, transform) {
    const cached = cache.get(path);
    if (cached && cached.until > Date.now()) return cached.value;
    return remember(path, transform(await fetchJson(path)));
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", policy);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("Cache-Control", "no-store");
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (!request.url?.startsWith("/") || request.url.length > 4096) return send(400, { error: "无效的请求。" });
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Connection", "close");
      return send(405, { error: "公开测试入口不开放服务器写操作。" });
    }
    if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] || 0) > 0) {
      response.setHeader("Connection", "close");
      return send(400, { error: "不接受请求正文。" });
    }
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/health") return send(200, { status: "ok", service: "newsscout-public-reader", readOnly: true });
    if (url.pathname.startsWith("/beta/api/")) {
      if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 600) { response.setHeader("Retry-After", "60"); return send(429, { error: "访问较多，请稍后重试。" }); }
      const match = url.pathname.match(/^\/beta\/api\/events\/([0-9a-f-]+)$/i);
      const archive = url.pathname.match(/^\/beta\/api\/briefs\/(\d{4}-\d{2}-\d{2})$/);
      const known = ["/beta/api/events", "/beta/api/brief", "/beta/api/explore", "/beta/api/reading",
        "/beta/api/reading/sources", "/beta/api/weekly", "/beta/api/briefs"].includes(url.pathname);
      if (!known && !archive && !(match && uuid.test(match[1]))) return send(404, { error: "未开放的测试接口。" });
      let query;
      try {
        if (url.pathname === "/beta/api/reading") query = readingParameters(url.searchParams);
        else if (["/beta/api/events", "/beta/api/explore"].includes(url.pathname)) query = parameters(url.searchParams);
        else if (url.pathname === "/beta/api/brief" || match) query = preferenceParameters(url.searchParams, !match);
        else {
          if (url.searchParams.size || archive && !calendarDate(archive[1])) throw new Error("Invalid edition request");
        }
      } catch { return send(400, { error: "不支持的筛选条件。" }); }
      try {
        let data;
        if (match) {
          data = await publicData(`/api/v1/events/${match[1]}${query.size ? "?" + query : ""}`,
            value => projectArticle(checkedProfile(value, query)));
        } else if (url.pathname === "/beta/api/reading/sources") {
          data = await publicData("/api/v1/sources", projectReadingSources);
        } else if (url.pathname === "/beta/api/reading") {
          if (query.has("source")) {
            const directory = await publicData("/api/v1/sources", projectReadingSources);
            if (!directory.items.some(source => source.id.toLowerCase() === query.get("source"))) {
              return send(404, { error: "此来源不在公开深读目录内。" });
            }
          }
          data = await publicData("/api/v1/events?" + query, value => projectReadingPage(value, query));
        } else if (url.pathname === "/beta/api/weekly") {
          data = await publicData("/api/v1/weekly", projectBrief);
        } else if (url.pathname === "/beta/api/briefs" || archive) {
          const history = await publicData("/api/v1/briefs", projectBriefHistory);
          if (archive) {
            const date = archive[1];
            // Never call the dated backend route for an unsaved day: today can build a live selection.
            if (!history.items.some(item => item.localDate === date)) return send(404, { error: "这一天没有已保存的简报。" });
            data = await publicData(`/api/v1/briefs/${date}`, value => {
              value = record(value);
              if (value.isSnapshot !== true || value.localDate !== date) throw new Error("Invalid saved edition");
              return projectBrief(value);
            });
          } else data = history;
        } else if (url.pathname === "/beta/api/brief") {
          data = await publicData("/api/v1/briefs/latest" + (query.size ? "?" + query : ""), value => {
            const brief = projectBrief(checkedProfile(value, query));
            if (query.has("interests")) {
              if (brief.isSnapshot !== false) throw new Error("Visitor selection must not be a saved edition");
              brief.note = "按本浏览器兴趣选出；只调整当前推荐，不改写已保存晨报。";
            }
            return brief;
          });
        } else if (url.pathname.endsWith("/explore")) {
          query.delete("limit"); query.delete("offset"); query.delete("sort");
          data = await publicData("/api/v1/explore?" + query, value => {
            value = checkedProfile(value, query);
            return {
              sampleSize: value.sampleSize, limit: value.limit, meaning: value.meaning,
              nodes: value.nodes.map(node => pick(node, ["id", "count"])),
              edges: value.edges.map(edge => pick(edge, ["source", "target", "count"])),
            };
          });
        } else {
          if (!query.has("sort")) query.set("sort", "recommended");
          query.set("coverage", "true");
          if (!query.has("hours")) query.set("hours", "72");
          if (!query.has("limit")) query.set("limit", "30");
          data = await publicData("/api/v1/events?" + query, value => {
            value = checkedProfile(value, query);
            return {
              items: value.items.map(projectArticle), nextOffset: value.nextOffset,
              returnedEventCount: value.returnedEventCount,
              returnedMaterialCount: value.returnedMaterialCount,
            };
          });
        }
        return send(200, data);
      } catch (error) {
        if (query?.has("interests") && error?.status === 400) return send(400, { error: "兴趣主题或阅读时间无效，请重新选择后重试。" });
        if (error?.status === 404) return send(404, { error: "这篇文章已不可用或尚未公开收录。" });
        log(`Public reader upstream request failed: ${error instanceof Error ? error.name : "unknown"}`);
        return send(503, { error: "内容服务暂不可用，请稍后重试。不会展示过期缓存来掩盖连接失败。" });
      }
    }
    if (url.pathname === "/" || /^\/(?:radar|saved|reading|weekly|events\/[0-9a-f-]{36})$/i.test(url.pathname)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(request.method === "HEAD" ? undefined : html);
    }
    if (/^\/assets\/[a-zA-Z0-9_-]+\.(?:js|css|woff2|png|svg|ico)$/.test(url.pathname)) {
      try {
        const path = await realpath(resolve(root, "." + url.pathname));
        if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) return send(404, { error: "未找到文件。" });
        const content = await readFile(path);
        const type = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" }[extname(path)];
        response.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400, immutable" });
        return response.end(request.method === "HEAD" ? undefined : content);
      } catch (error) {
        if (error?.code !== "ENOENT") log("Public reader asset unavailable");
        return send(404, { error: "未找到文件。" });
      }
    }
    return send(404, { error: "此页面不在公开测试范围内。" });
  });
  server.requestTimeout = 25_000; server.headersTimeout = 10_000; server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}

module.exports = { startPublicReader, projectArticle, projectBrief };

if (require.main === module) {
  startPublicReader({
    port: Number(process.env.SCOUTNEWS_PUBLIC_PORT || "5190"),
    apiOrigin: process.env.SCOUTNEWS_PUBLIC_API_ORIGIN || "http://127.0.0.1:8080",
    ...(process.env.SCOUTNEWS_PUBLIC_DIST ? { distRoot: process.env.SCOUTNEWS_PUBLIC_DIST } : {}),
  }).then(server => console.log(`NewsScout public reader listening on http://127.0.0.1:${server.address().port}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
