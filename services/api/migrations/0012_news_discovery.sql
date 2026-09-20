-- Public personal-reader endpoints inspected on 2026-09-08.
-- AIHOT supplies licensed public aggregate summaries, not independently fetched articles.
INSERT INTO publishers(id,name,entity_type,official_domains)
VALUES('10000000-0000-0000-0000-000000000201','量子位','publication','["qbitai.com"]')
ON CONFLICT DO NOTHING;

WITH catalog(id,publisher_id,name,endpoint,adapter,tier,topics,policy) AS(
  VALUES
  ('20000000-0000-0000-0000-000000000201','10000000-0000-0000-0000-000000000201',
   '量子位 · 官网 RSS','https://www.qbitai.com/feed','rss','T2',ARRAY['agi','ai-coding','agent'],
   'Official publisher RSS excerpts; no WeChat scraping or full-article crawling'),
  ('20000000-0000-0000-0000-000000000202',NULL,
   'AIHOT 精选 · 聚合摘要','https://aihot.virxact.com/api/v1/items?mode=selected&window=7d&by=published&limit=30',
   'aihot_public','T2',ARRAY['agi','agent','ai-coding','open-models'],
   'Personal/internal use under AIHOT terms; retain attribution and original links; no original-body fetch, independent corroboration credit, external mirroring or redistribution')
), inserted AS(
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT id::uuid,publisher_id::uuid,name,endpoint,'blog',adapter,tier,'observing',180,'zh',
    jsonb_build_object('catalogVersion','2026-09-08','verifiedAt','2026-09-08',
      'verificationUrl',endpoint,'topicIds',to_jsonb(topics),'observationRequired',true,
      'bodyPolicy',policy,'mode','monitor','authentication','none',
      'paginationPolicy','Bounded latest entries, not a full archive',
      'termsUrl',CASE WHEN adapter='aihot_public' THEN 'https://aihot.virxact.com/terms' ELSE NULL END)
  FROM catalog ON CONFLICT DO NOTHING RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,topic.id,CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY topic(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=topic.id ON CONFLICT DO NOTHING;

-- A repository creation/update is useful discovery, but not equivalent to a news release.
ALTER FUNCTION reader_recommendations(text,timestamptz) RENAME TO reader_recommendations_core;
CREATE FUNCTION reader_recommendations(reader_id text,as_of timestamptz)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean)
LANGUAGE sql STABLE AS $$
  SELECT r.event_id,(r.rank_score-CASE WHEN e.event_type='repository' THEN 25 ELSE 0 END)::real,
    r.recency,r.affinity,r.novelty_penalty,r.facets,r.confirmed,r.not_interested,r.seen,r.opened
  FROM reader_recommendations_core(reader_id,as_of) r JOIN events e ON e.id=r.event_id
$$;
