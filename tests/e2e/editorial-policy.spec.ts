import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { databaseQuery } from "./db";

const api = process.env.SCOUTNEWS_E2E_API_URL ?? "http://127.0.0.1:8080";
const literal = (value: unknown) => value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const json = <T>(sql: string): T => JSON.parse(databaseQuery(sql));

test("article-value-v1 is conservative, metadata-only, type-aware and not a source-tier veto", () => {
  const classify = (title: string, type: string, url: string, metadata: object, official = false, entity = "publication") =>
    json<{ contentKind: string; valueScore: number; briefEligible: boolean; policyVersion: string; reason: string }>(
      `SELECT news_article_policy(${literal(title)},${literal(url)},${literal(type)},${literal(JSON.stringify(metadata))}::jsonb,${official},${literal(entity)})`);
  const question = classify("Which GPU should I buy for more memory?", "blog", "https://reddit.com/r/LocalLLaMA/comments/question", {}, false, "community");
  expect(question.contentKind).toBe("question");
  expect(question.briefEligible).toBe(false);
  expect(classify("Any folks mixing nVidia & Intel GPUs (Maybe 3090 + Arc Pro B70 Pro?)",
    "blog", "https://reddit.com/r/LocalLLaMA/comments/setup", {
      readingContext: { body: "My GPU setup has configuration issues; I would love to hear about other people's experience. ".repeat(10) },
    }, false, "community").contentKind).toBe("question");
  const promo = classify("Join us for our AI webinar: register now", "blog", "https://official.example/webinar", { feedSummary: "Our most important announcement." }, true, "organization");
  expect(promo.contentKind).toBe("promotion");
  expect(promo.briefEligible).toBe(false);
  const community = classify("How we built a reproducible inference benchmark", "blog", "https://reddit.com/r/LocalLLaMA/comments/engineering", {
    feedSummary: "Our implementation and source code include the dataset, experiments, latency measurements and limitations.".repeat(5),
  }, false, "community");
  expect(community.contentKind).toBe("analysis");
  expect(community.briefEligible).toBe(true);
  expect(community.valueScore).toBeGreaterThan(question.valueScore);
  expect(community.policyVersion).toBe("article-value-v1");
  expect(community.reason).toContain("非 AI");
  const retrospectiveBody = "A chronological keynote review compares model releases, benchmark results, security incidents and open source changes. ".repeat(12);
  const retrospective = classify("2026 in LLMs (so far)", "blog",
    "https://simonwillison.net/2026/Sep/27/2026-in-llms-so-far/",
    { feedSummary: retrospectiveBody }, false, "author");
  expect(retrospective.contentKind).toBe("analysis");
  expect(retrospective.valueScore).toBe(70);
  expect(retrospective.briefEligible).toBe(true);
  expect(retrospective.reason).toContain("阶段性回顾");
  const shortRetrospective = classify("2026 in LLMs (so far)", "blog",
    "https://example.com/short-retrospective",
    { feedSummary: "A short benchmark roundup." }, false, "author");
  expect(shortRetrospective.contentKind).toBe("news");
  expect(shortRetrospective.briefEligible).toBe(false);
  const communityRetrospective = classify("2026 in LLMs (so far)", "blog",
    "https://reddit.com/r/LocalLLaMA/comments/retrospective",
    { feedSummary: retrospectiveBody }, false, "community");
  expect(communityRetrospective.contentKind).not.toBe("analysis");
  expect(communityRetrospective.briefEligible).toBe(false);
  const release = classify("Introducing Agent SDK v2", "release", "https://github.com/policy/project/releases/tag/v2.0.0", {}, true, "organization");
  expect(release.contentKind).toBe("release");
  expect(release.briefEligible).toBe(true);
  expect(classify("Repository metadata", "repository", "https://github.com/policy/project", { feedSummary: "benchmark research".repeat(100) }, true).briefEligible).toBe(false);
  expect(classify("Research paper: agent memory ablation", "paper", "https://arxiv.org/abs/2609.99999", {}, true).contentKind).toBe("research");
});

test("editorial decay remains finite for archived articles and old feedback", () => {
  const values: number[] = JSON.parse(databaseQuery(`SELECT json_agg(news_editorial_decay(n)::real ORDER BY n)
    FROM unnest(ARRAY[-1,0,1,2,100,10000]::numeric[]) n`));
  expect(values).toEqual([1,1,0.5,0.25,0,0]);
});

test("article facets separate GPU memory and retrieval, including industry/governance and interest aliases", () => {
  const facets = (title: string, body = "", kind = "blog", fallback = "AI Coding") =>
    json<string[]>(`SELECT to_json(news_facets(${literal(title)},${literal(body)},${literal(kind)},${literal(fallback)}))`);
  const hardware = facets("GPU HBM memory capacity and graphics card latency", "I need more memory for my setup.");
  expect(hardware).toContain("芯片与硬件");
  expect(hardware).not.toContain("记忆与检索");
  const memory = facets("Agent memory: retrieval with a vector database");
  expect(memory).toContain("记忆与检索");
  expect(memory).toContain("Agent 与工具");
  const industry = facets("Ben Thompson on platform strategy and antitrust regulation", "", "podcast", "");
  expect(industry).toEqual(expect.arrayContaining(["产业与商业", "治理与政策", "播客与访谈"]));
  expect(industry).not.toContain("AI 编程");
  expect(facets("Measuring tactical intelligence targeting and conventional weapons capabilities of AI models",
    "Our inference pipeline provides additional evaluation detail.")[0]).toBe("评测与安全");
  expect(facets("A conversation about the future", "The discussion concerns psychology and cognitive science.", "podcast")[0])
    .toBe("心理与认知");
  expect(databaseQuery("SELECT news_topic_alias('Agent')||'/'||news_topic_alias('Memory')||'/'||news_topic_alias('AI Coding')||'/'||news_topic_alias('Rust')"))
    .toBe("Agent 与工具/记忆与检索/AI 编程/工程与开源");
});

test("retained engineering case studies differ from short endorsements, link-only claims and brand promotions", () => {
  const policy = (title: string, url: string, metadata: object, entity = "organization") =>
    json<{ contentKind: string; briefEligible: boolean; valueScore: number; reason: string }>(
      `SELECT news_article_policy(${literal(title)},${literal(url)},'blog',${literal(JSON.stringify(metadata))}::jsonb,true,${literal(entity)})`);
  // Synthetic material tests the supplied counterexample's distinction, not the
  // actual article's contents; no fetching or model generation is involved.
  const engineering = "The retained pipeline implementation uses fine-tuning and DPO, with A/B experiments and evaluation of error rate. ".repeat(12);
  const fyxerTitle = "How Fyxer built an AI executive assistant people trust";
  const fyxer = policy(fyxerTitle, "https://openai.com/index/fyxer/", {
    feedSummary: "A short customer introduction.",
    readingContext: { body: engineering },
  });
  expect(fyxer.contentKind).toBe("analysis");
  expect(fyxer.briefEligible).toBe(true);
  expect(fyxer.reason).toContain("留存原文");
  const customerLabel = policy("Customer story: Fyxer's assistant engineering", "https://openai.com/index/fyxer/", {
    readingContext: { body: engineering },
  });
  expect(customerLabel.contentKind).toBe("analysis");
  expect(customerLabel.briefEligible).toBe(true);
  const assertion = policy("Perplexity trusts GPT-6 Astra with end-to-end systems", "https://openai.com/index/perplexity/", {
    feedSummary: "Perplexity trusts GPT-6 Astra with end-to-end systems.",
  });
  expect(assertion.briefEligible).toBe(false);
  expect(fyxer.valueScore).toBeGreaterThan(assertion.valueScore);
  const gpu = policy("NVIDIA releases an 84GB GPU model", "https://reddit.com/r/LocalLLaMA/comments/hardware", {
    feedSummary: "[link] [comments]",
  }, "community");
  expect(gpu.briefEligible).toBe(false);
  expect(gpu.valueScore).toBeLessThan(60);
  for (const title of ["业界首个5A算电协同认证", "品牌AI挑战赛正式启动"]) {
    const promotion = policy(title, "https://www.qbitai.com/promotion", { feedSummary: title }, "publication");
    expect(promotion.contentKind).toBe("promotion");
    expect(promotion.briefEligible).toBe(false);
  }
  const benTitle = "Pacing the Frontier, AI's Digital Limits, AI Commissars";
  const benText = "Dario Amodei wants to pace the frontier; political control of AI.";
  const benFacets = json<string[]>(`SELECT to_json(news_facets(${literal(benTitle)},
    ${literal(`https://stratechery.com/2026/pacing-the-frontier/ ${benText}`)},'blog','AI Coding'))`);
  expect(benFacets).toEqual(expect.arrayContaining(["产业与商业", "治理与政策"]));
  expect(benFacets).not.toContain("AI 编程");
  const shortBen = policy(benTitle, "https://stratechery.com/2026/pacing-the-frontier/", { feedSummary: benText }, "author");
  const fullBen = policy(benTitle, "https://stratechery.com/2026/pacing-the-frontier/", { readingContext: { body: benText.repeat(12) } }, "author");
  expect(shortBen.valueScore).toBeLessThan(fullBen.valueScore);
  const generatedOnly = policy(fyxerTitle, "https://openai.com/index/fyxer/", { generatedSummary: engineering, feedSummary: "Customer introduction." });
  expect(generatedOnly.briefEligible).toBe(false);
  expect(fyxer.reason.length).toBeLessThanOrEqual(600);
});

test("Stratechery paid previews cannot gain article value or topics from the subscription catalogue", () => {
  const url = "https://stratechery.com/2026/pacing-the-frontier/";
  const title = "Pacing the Frontier, AI's Digital Limits, AI Commissars";
  const intro = "Dario Amodei wants to pace the frontier; this introduction concerns political control of AI, not the full argument.";
  const marker = "Subscribe to Stratechery Plus for full access.";
  const polluted = { feedSummary: intro, readingContext: { status: "available",
    body: `${title}\nSeptember 15, 2026\nListen to Podcast\n${intro}\n${marker}\n${"Login Pricing Rust agent memory coding assistant benchmark podcast subscriptions and advertising. ".repeat(60)}` } };
  const clean = (metadata: object, source = url) =>
    json<{ feedSummary: string; readingContext: { body: string; status: string; truncated: boolean; accessLimit?: string } }>(
      `SELECT news_publisher_material(${literal(source)},${literal(JSON.stringify(metadata))}::jsonb)`);
  const classify = (metadata: object) =>
    json<{ contentKind: string; briefEligible: boolean; valueScore: number; policyVersion: string; reason: string }>(
      `SELECT news_article_policy(${literal(title)},${literal(url)},'blog',${literal(JSON.stringify(metadata))}::jsonb,true,'author')`);
  const cleaned = clean(polluted);
  expect(cleaned.readingContext.body).toContain(intro);
  expect(cleaned.readingContext.body).not.toContain("Pricing");
  expect(cleaned.readingContext.status).toBe("partial");
  expect(cleaned.readingContext.accessLimit).toBe("paywall");
  expect(cleaned.readingContext.truncated).toBe(true);
  expect(clean(cleaned)).toEqual(cleaned);
  for (const metadata of [polluted, cleaned, { feedSummary: intro, readingContext: { body: intro, status: "partial" } }]) {
    const policy = classify(metadata);
    expect(policy.contentKind).toBe("analysis");
    expect(policy.briefEligible).toBe(false);
    expect(policy.valueScore).toBeLessThan(60);
    expect(policy.policyVersion).toBe("article-value-v1-paywall-1");
    expect(policy.reason.length).toBeLessThanOrEqual(600);
  }
  const facets = json<string[]>(`SELECT to_json(news_facets(${literal(title)},
    ${literal(`${url} ${cleaned.readingContext.body}`)},'blog','AI Coding'))`);
  expect(facets).toEqual(expect.arrayContaining(["治理与政策", "产业与商业"]));
  expect(facets).not.toContain("记忆与检索");
  expect(facets).not.toContain("Agent 与工具");
  expect(facets).not.toContain("工程与开源");
  const full = "This free analysis explains platform economics and political control, with its argument and supporting detail. ".repeat(30);
  const generic = { readingContext: { body: `${full}\nYou can subscribe to future articles.`, status: "available" } };
  expect(clean(generic).readingContext.body).toBe(generic.readingContext.body);
  expect(classify(generic).briefEligible).toBe(true);
  expect(classify({ readingContext: { body: `${full}\n${marker}\nLogin Pricing`, status: "available" } }).briefEligible).toBe(true);
  expect(clean(polluted, "https://stratechery.com.other.example/article")).toEqual(polluted);
  expect(clean(polluted, "https://stratechery.com:443@other.example/article")).toEqual(polluted);
});

test("SQL-backed selection keeps questions in Radar, caps floods, offers seen weekly articles and preserves stored snapshots", async ({ request }) => {
  test.setTimeout(120_000);
  const tag = `editorial-policy-${randomUUID()}`;
  const sourceIds: string[] = [], publisherIds: string[] = [], eventIds: string[] = [], contentIds: string[] = [];
  const preserved = databaseQuery("SELECT md5(COALESCE(string_agg(snapshot::text,'' ORDER BY brief_id,rank),'')) FROM daily_brief_items");
  const sources = ["research", "flood", "community", "industry"].map((name, index) => {
    const id = randomUUID(), publisher = randomUUID();
    sourceIds.push(id); publisherIds.push(publisher);
    databaseQuery(`INSERT INTO publishers(id,name,entity_type) VALUES(${literal(publisher)},${literal(`${tag}-${name}`)},${literal(index === 2 ? "community" : "publication")});
      INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,last_success_at)
      VALUES(${literal(id)},${literal(publisher)},${literal(`${tag}-${name}`)},${literal(`https://${tag}-${name}.example/feed`)},'blog','rss',${literal(index === 2 ? "T2" : "T1")},'stable',now())`);
    return id;
  });
  const add = (title: string, sourceIndex: number, hours: number, type = "blog", originalUrl?: string) => {
    const id = randomUUID(), content = randomUUID();
    eventIds.push(id); contentIds.push(content);
    const url = originalUrl ?? `https://${tag}-${sourceIndex}.example/article/${id}`;
    const metadata = { feedSummary: "Original engineering material: implementation, benchmark dataset, experiment, latency measurement and source code. ".repeat(8) };
    databaseQuery(`INSERT INTO events(id,canonical_title,summary,importance,primary_topic,event_type,first_seen_at,updated_at,
        summary_kind,summary_format_version,summary_points,summary_model,summary_reasoning_effort)
      VALUES(${literal(id)},${literal(title)},'隔离测试摘要，不代表新闻内容。','','AI Coding',${literal(type)},now()-interval '${hours} hours',now(),
        'copilot',3,'["隔离测试摘要，不代表新闻内容。"]','gpt-5.6-terra','low');
      INSERT INTO content_items(id,source_id,content_type,original_url,canonical_url,title,published_at,content_hash,metadata)
      VALUES(${literal(content)},${literal(sources[sourceIndex])},${literal(type)},${literal(url)},${literal(url)},${literal(title)},now()-interval '${hours} hours',${literal(content)},${literal(JSON.stringify(metadata))}::jsonb);
      INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES(${literal(id)},${literal(content)},${sourceIndex !== 2})`);
    return id;
  };
  try {
    const older = add(`${tag}: Research paper on agent memory retrieval ablation`, 0, 48, "paper");
    const readingTitle = "隔离语料中的独立中文阅读标题";
    databaseQuery(`UPDATE events SET display_title=${literal(readingTitle)} WHERE id=${literal(older)}`);
    const question = add(`Which GPU should I buy for more memory? ${tag}?`, 2, 1);
    const promotion = add(`Join us for our webinar: register now ${tag}`, 0, 1);
    const industry = add(`Ben Thompson analysis: platform strategy, antitrust regulation ${tag}`, 3, 3);
    const previewUrl = `https://stratechery.com/2026/${tag}/`;
    const paidPreview = add(`Pacing the Frontier, AI Commissars ${tag}`, 3, 1, "blog", previewUrl);
    const previewIntro = "A genuine short introduction about political control of AI; no full article argument is retained.";
    const previewMetadata = { feedSummary: previewIntro, readingContext: {
      version: 1, kind: "article", origin: "publisher_page", status: "available", sourceUrl: previewUrl,
      body: `${previewIntro}\nSubscribe to Stratechery Plus for full access.\n${"Login Pricing Rust memory coding agent subscription catalogue. ".repeat(80)}`,
      truncated: false, durationSeconds: null, chapters: [], transcriptUrl: null, comments: [],
      commentsStatus: "not_applicable", fetchedAt: new Date().toISOString(),
    } };
    databaseQuery(`UPDATE content_items SET metadata=${literal(JSON.stringify(previewMetadata))}::jsonb
      WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id=${literal(paidPreview)})`);
    const substantiveCommunity = add(`How we built a reproducible inference benchmark ${tag}`, 2, 2);
    for (let i = 0; i < 8; i++) add(`How we built a reproducible SDK benchmark ${tag} ${i}`, 1, 2);
    for (let i = 0; i < 5; i++) add(`How we built a reproducible inference benchmark ${tag} community ${i}`, 2, 2);
    const releaseUrl = `https://github.com/${tag}/project/releases/tag/v1.2.3`;
    const release1 = add(`${tag} Agent SDK v1.2.3`, 0, 2, "release", releaseUrl);
    const release2 = add(`${tag} Agent SDK v1.2.3`, 0, 2, "release", releaseUrl);
    const get = (id: string) => request.get(`${api}/api/v1/events/${id}`).then(r => r.json());
    const byReadingTitle = await (await request.get(`${api}/api/v1/events?q=${encodeURIComponent(readingTitle)}`)).json();
    expect(byReadingTitle.items.some((e: { id: string }) => e.id === older)).toBe(true);
    expect((await get(older)).title).toContain(tag);
    const radar = await (await request.get(`${api}/api/v1/events?q=${encodeURIComponent(tag)}&limit=100`)).json();
    expect(radar.items.some((e: { id: string }) => e.id === question)).toBe(true);
    const hardware = await get(question);
    expect((await get(older)).recommendation.score).toBeGreaterThan(hardware.recommendation.score);
    expect(hardware.editorial.contentKind).toBe("question");
    expect(hardware.editorial.briefEligible).toBe(false);
    expect(hardware.topics).toEqual(hardware.recommendation.facets);
    expect(hardware.primaryTopic).toBe(hardware.topics[0]);
    expect(hardware.topics).not.toContain("记忆与检索");
    const industryEvent = await get(industry);
    expect(industryEvent.topics).toEqual(expect.arrayContaining(["产业与商业", "治理与政策"]));
    for (const topic of industryEvent.topics) {
      const filtered = await (await request.get(`${api}/api/v1/events?q=${encodeURIComponent(tag)}&topic=${encodeURIComponent(topic)}`)).json();
      expect(filtered.items.some((e: { id: string }) => e.id === industry)).toBe(true);
    }
    expect((await get(substantiveCommunity)).editorial.briefEligible).toBe(true);
    const previewEvent = await get(paidPreview);
    expect(previewEvent.editorial.briefEligible).toBe(false);
    expect(previewEvent.topics).not.toContain("记忆与检索");
    expect(previewEvent.evidence[0].readingContext.body).toBe(previewIntro);
    expect(previewEvent.evidence[0].readingContext.status).toBe("partial");
    expect(previewEvent.evidence[0].readingContext.accessLimit).toBe("paywall");
    expect(databaseQuery(`SELECT metadata->'readingContext'->>'status' FROM content_items
      WHERE id IN(SELECT content_item_id FROM event_evidence WHERE event_id=${literal(paidPreview)})`)).toBe("available");
    const latest = await (await request.get(`${api}/api/v1/briefs/latest`)).json();
    expect(latest.items.some((e: { id: string }) => [question, promotion, paidPreview].includes(e.id))).toBe(false);
    expect(latest.items.some((e: { id: string }) => e.id === older)).toBe(true);
    expect(latest.sections.find((s: { kind: string }) => s.kind === "catch_up").eventIds).toContain(older);
    const selectedFixtures = latest.items.filter((e: { id: string }) => eventIds.includes(e.id));
    expect(selectedFixtures.filter((e: { evidence: { sourceName: string }[] }) =>
      e.evidence.some(s => s.sourceName === `${tag}-flood`)).length).toBeLessThanOrEqual(3);
    expect(selectedFixtures.filter((e: { evidence: { sourceName: string }[] }) =>
      e.evidence.some(s => s.sourceName === `${tag}-community`)).length).toBeLessThanOrEqual(2);
    expect(selectedFixtures.some((e: { evidence: { sourceName: string }[] }) =>
      e.evidence.some(s => s.sourceName === `${tag}-community`))).toBe(true);
    expect(latest.items.filter((e: { id: string }) => [release1, release2].includes(e.id)).length).toBeLessThanOrEqual(1);
    expect(latest.sections.flatMap((s: { eventIds: string[] }) => s.eventIds)).toEqual(latest.items.map((e: { id: string }) => e.id));

    const relatedBefore = await get(substantiveCommunity);
    expect((await request.put(`${api}/api/v1/events/${question}/state`, { data: { notInterested: true, notInterestedReason: "old" } })).ok()).toBe(true);
    expect((await get(question)).notInterestedReason).toBe("old");
    expect((await get(substantiveCommunity)).recommendation.affinity).toBeCloseTo(relatedBefore.recommendation.affinity, 3);
    await request.put(`${api}/api/v1/events/${question}/state`, { data: { notInterested: false } });
    expect((await get(question)).notInterestedReason).toBeNull();

    await request.put(`${api}/api/v1/events/${older}/state`, { data: { opened: true } });
    const rank = json<{ daily: number; weekly: number; difference: number }>(`SELECT json_build_object(
      'daily',d.novelty_penalty,'weekly',w.novelty_penalty,'difference',w.rank_score-d.rank_score)
      FROM reader_editorial_recommendations('local',now()) d JOIN reader_editorial_recommendations('local',now(),true) w USING(event_id)
      WHERE d.event_id=${literal(older)}`);
    expect(rank.daily).toBeGreaterThan(0);
    expect(rank.daily).toBeLessThanOrEqual(6);
    expect(rank.weekly).toBe(0);
    expect(rank.difference).toBeGreaterThan(0);
    const affinityBeforeSave = (await get(substantiveCommunity)).recommendation.affinity;
    await request.put(`${api}/api/v1/events/${older}/state`, { data: { saved: true } });
    expect((await get(substantiveCommunity)).recommendation.affinity).toBeGreaterThan(affinityBeforeSave);
    const scoped = json<{ count: number; same: boolean }>(`WITH full_rank AS MATERIALIZED (
        SELECT * FROM reader_editorial_recommendations('local',now())),
      scoped_rank AS MATERIALIZED (
        SELECT * FROM reader_editorial_recommendations('local',now(),false,ARRAY[${literal(substantiveCommunity)}::uuid]))
      SELECT json_build_object('count',(SELECT count(*) FROM scoped_rank),
        'same',(SELECT s.rank_score=f.rank_score AND s.affinity=f.affinity AND s.facets=f.facets
          FROM scoped_rank s JOIN full_rank f USING(event_id)))`);
    expect(scoped).toEqual({ count: 1, same: true });
    const weekly = await (await request.get(`${api}/api/v1/weekly`)).json();
    // Route availability is asserted rather than silently accepting a fallback feed.
    expect(weekly.items.some((e: { id: string }) => e.id === older)).toBe(true);
    expect(weekly.items.some((e: { id: string }) => e.id === paidPreview)).toBe(false);
    expect(weekly.sections.every((s: { kind: string }) => s.kind === "topic")).toBe(true);
    expect(weekly.sections.flatMap((s: { eventIds: string[] }) => s.eventIds)).toEqual(weekly.items.map((e: { id: string }) => e.id));
    expect(databaseQuery("SELECT md5(COALESCE(string_agg(snapshot::text,'' ORDER BY brief_id,rank),'')) FROM daily_brief_items")).toBe(preserved);
  } finally {
    const ids = eventIds.map(literal).join(",");
    if (ids) databaseQuery(`DELETE FROM event_exposures WHERE event_id IN(${ids});
      DELETE FROM user_event_states WHERE event_id IN(${ids}); DELETE FROM event_evidence WHERE event_id IN(${ids});
      DELETE FROM events WHERE id IN(${ids})`);
    if (contentIds.length) databaseQuery(`DELETE FROM content_items WHERE id IN(${contentIds.map(literal).join(",")})`);
    databaseQuery(`DELETE FROM sources WHERE id IN(${sourceIds.map(literal).join(",")});
      DELETE FROM publishers WHERE id IN(${publisherIds.map(literal).join(",")})`);
  }
});
