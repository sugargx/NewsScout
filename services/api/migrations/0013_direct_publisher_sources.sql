-- Remove the superseded aggregation dependency without rewriting genuine archives
-- or erasing reader feedback and actual model-attempt accounting.
CREATE TEMP TABLE retired_source_ids ON COMMIT DROP AS
SELECT id FROM sources WHERE adapter_type='aihot_public'
  OR lower(endpoint) ~ '^https://([a-z0-9-]+\.)*(aihot\.news|aihot\.virxact\.com)([/:?]|$)';
CREATE TEMP TABLE retired_content ON COMMIT DROP AS
SELECT ci.id,ci.original_url FROM content_items ci JOIN retired_source_ids s ON s.id=ci.source_id;
CREATE TEMP TABLE affected_reader_events ON COMMIT DROP AS
SELECT DISTINCT ee.event_id FROM event_evidence ee JOIN retired_content ci ON ci.id=ee.content_item_id;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM daily_brief_items bi JOIN affected_reader_events a ON a.event_id=bi.event_id
    WHERE jsonb_path_exists(bi.snapshot,'$.evidence[*].aggregation')) THEN
    RAISE EXCEPTION 'A legacy archive contains aggregate text; review its removal explicitly before migrating';
  END IF;
END $$;

INSERT INTO admin_audits(id,actor,action,target_type,target_id,after_value,reason)
SELECT gen_random_uuid(),'local','aggregate_source_removed','event',a.event_id::text,
  jsonb_build_object('originalLinks',jsonb_agg(DISTINCT ci.original_url)),
  '聚合输入已移除；只保留用于恢复用户阅读记录的原始链接，不保留聚合正文'
FROM affected_reader_events a JOIN event_evidence ee ON ee.event_id=a.event_id
JOIN retired_content ci ON ci.id=ee.content_item_id
WHERE EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=a.event_id)
GROUP BY a.event_id;

UPDATE admin_audits SET before_value=NULL,
  after_value=jsonb_build_object('redacted',true,'reason','aggregate input removed')
WHERE action='summarize' AND target_type='event'
  AND target_id IN(SELECT event_id::text FROM affected_reader_events);

DELETE FROM event_evidence WHERE content_item_id IN(SELECT id FROM retired_content);
DELETE FROM content_item_identities WHERE content_item_id IN(SELECT id FROM retired_content);
DELETE FROM content_items WHERE id IN(SELECT id FROM retired_content);
DELETE FROM fetch_runs WHERE source_id IN(SELECT id FROM retired_source_ids);
DELETE FROM sources WHERE id IN(SELECT id FROM retired_source_ids);
DELETE FROM score_snapshots WHERE event_id IN(SELECT event_id FROM affected_reader_events);

-- Mixed events retain their identity and are rebuilt solely from direct material.
WITH originals AS(
  SELECT DISTINCT ON(ee.event_id) ee.event_id,ci.title,ci.metadata
  FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
  JOIN sources s ON s.id=ci.source_id JOIN affected_reader_events a ON a.event_id=ee.event_id
  ORDER BY ee.event_id,ee.is_official DESC,
    CASE s.tier WHEN 'T1' THEN 0 WHEN 'T1.5' THEN 1 ELSE 2 END,ci.created_at,ci.id
)
UPDATE events e SET canonical_title=o.title,summary=COALESCE(o.metadata->>'feedSummary',''),
  importance='已移除聚合引用；正在根据原始发布者的直接材料重新生成摘要。',
  summary_kind='feed',summary_model=NULL,summarized_at=NULL,summary_evidence_ids='[]',
  summary_format_version=0,summary_reasoning_effort=NULL,content_version=content_version+1
FROM originals o WHERE e.id=o.event_id;

DELETE FROM events e WHERE e.id IN(SELECT event_id FROM affected_reader_events)
  AND NOT EXISTS(SELECT 1 FROM event_evidence ee WHERE ee.event_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM daily_brief_items bi WHERE bi.event_id=e.id);
UPDATE events e SET status='withdrawn',canonical_title='已移除的聚合来源条目',
  summary='',importance='聚合来源已移除；阅读记录及原始链接保留在移除审计中。',
  summary_kind='feed',summary_model=NULL,summarized_at=NULL,summary_evidence_ids='[]',
  summary_format_version=0,summary_reasoning_effort=NULL,content_version=content_version+1
WHERE e.id IN(SELECT event_id FROM affected_reader_events)
  AND NOT EXISTS(SELECT 1 FROM event_evidence ee WHERE ee.event_id=e.id);
DELETE FROM summary_jobs WHERE event_id IN(
  SELECT id FROM events WHERE status='withdrawn' AND id IN(SELECT event_id FROM affected_reader_events));

INSERT INTO publishers(id,name,entity_type,official_domains) VALUES
  ('10000000-0000-0000-0000-000000000301','Mistral AI','company','["mistral.ai"]'),
  ('10000000-0000-0000-0000-000000000302','Simon Willison','author','["simonwillison.net"]'),
  ('10000000-0000-0000-0000-000000000303','GitHub Blog','company','["github.blog"]')
ON CONFLICT DO NOTHING;
WITH catalog(suffix,name,endpoint,adapter,tier,topics,sample) AS(
  VALUES
  (301,'Mistral AI · 官方新闻 RSS','https://mistral.ai/news/rss','rss','T1',
    ARRAY['agi','open-models','agent'],'Mistral raises €3B to make sovereign, open-weight AI the technology frontier'),
  (302,'Simon Willison · 作者长文 Atom','https://simonwillison.net/atom/entries/','atom','T1.5',
    ARRAY['ai-coding','agent','context'],'OpenAI''s rogue agents were caught communicating via public wikis'),
  (303,'GitHub Blog · AI & ML','https://github.blog/ai-and-ml/feed/','rss','T1',
    ARRAY['ai-coding','agent','mcp-a2a'],'Project HydraFusion: Frontier quality via multi-model orchestration')
), inserted AS(
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT ('20000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
    ('10000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
    name,endpoint,'blog',adapter,tier,'observing',180,'en',
    jsonb_build_object('catalogVersion','2026-09-08-direct','verifiedAt','2026-09-08',
      'verificationUrl',endpoint,'sampleTitle',sample,'topicIds',to_jsonb(topics),
      'provenance','direct_publisher','observationRequired',true,'authentication','none',
      'bodyPolicy','Original publisher or author feed only; no aggregate summaries or proxy services',
      'paginationPolicy','Bounded publisher feed, not an exhaustive historical archive')
  FROM catalog ON CONFLICT DO NOTHING RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,topic.id,CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY topic(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=topic.id ON CONFLICT DO NOTHING;
