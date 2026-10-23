-- Additive catalog growth. Existing sources, events, summaries, snapshots and
-- reader rows are unchanged. Anthropic gains its verified product-blog domain.
--
-- Closes a coverage gap found by comparing a day of an aggregator's picks against
-- what this catalog can see. The aggregator stays blocked by validate_adapter_endpoint
-- and is never a source; only the ORIGINAL publishers it cited are subscribed here.
--
-- Each endpoint was fetched directly over HTTPS before registration and carries a
-- per-item publication date. Collection time is never substituted for one.
--
-- A separate 'DeepSeek' publisher is added rather than editing the existing
-- 'DeepSeek public model account' row, which stays scoped to its Hugging Face
-- model feed. Catalog rows that already exist are left byte-identical.

INSERT INTO publishers(id,name,entity_type,official_domains) VALUES
  ('10000000-0000-0000-0000-000000000420','DeepSeek','lab','["deepseek.com","github.com","huggingface.co"]'),
  ('10000000-0000-0000-0000-000000000421','IBM Research','lab','["research.ibm.com"]'),
  ('10000000-0000-0000-0000-000000000422','Ai2','lab','["allenai.org"]')
ON CONFLICT DO NOTHING;

UPDATE publishers SET official_domains=official_domains || '["claude.com"]'::jsonb
WHERE id='10000000-0000-0000-0000-000000000114'
  AND NOT official_domains @> '["claude.com"]'::jsonb;

WITH catalog(suffix,publisher,name,endpoint,content_type,adapter,tier,schedule,topics,sample) AS (
  VALUES
  -- An account-scoped repository search. DeepSeek publishes frameworks as
  -- repositories and runs no blog feed, so the Hugging Face model feed alone
  -- cannot see a framework release such as DeepInfer.
  (420,420,'DeepSeek GitHub repositories',
    'https://api.github.com/search/repositories?q=org%3Adeepseek-ai+archived%3Afalse&sort=updated&order=desc&per_page=20',
    'repository','github_search','T1',360,
    ARRAY['ai-infra','open-models'],'deepseek-ai/DeepInfer'),
  (421,407,'vLLM Blog','https://vllm.ai/blog/rss.xml','blog','rss','T1',180,
    ARRAY['ai-infra'],'Announcing Humming: Fast, Flexible Kernels for Quantized Inference'),
  (422,421,'IBM Research Blog','https://research.ibm.com/rss','blog','rss','T1',360,
    ARRAY['ai-infra'],'llm-d 1.0 hardens open-source AI inference for production'),
  (423,422,'Ai2 Blog','https://allenai.org/rss.xml','blog','rss','T1',360,
    ARRAY['open-models','agi'],'FairStress: A deeper evaluation of fairness in LLM decision-making'),
  (424,114,'Claude Product Blog','https://claude.com/resources/articles','blog','claude_blog','T1',180,
    ARRAY['agent','ai-coding'],'Introducing Claude Duet')
), inserted AS (
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT ('20000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
    ('10000000-0000-0000-0000-'||lpad(publisher::text,12,'0'))::uuid,
    name,endpoint,content_type,adapter,tier,'observing',schedule,'en',
    jsonb_build_object('catalogVersion','2026-10-21-coverage',
      'verifiedAt',CASE WHEN adapter='claude_blog' THEN '2026-10-22' ELSE '2026-10-21' END,
      'verificationMethod','Direct HTTPS fetch of the publisher endpoint with a sampled first entry and a confirmed per-item date',
      'verificationUrl',endpoint,'sampleTitle',sample,'topicIds',to_jsonb(topics),
      'publisherScope',CASE WHEN adapter='github_search' THEN 'https://github.com/deepseek-ai' END,
      'provenance','direct_publisher','observationRequired',true,'authentication','none','mode','monitor',
      'discovery','Named by a public aggregator as the original publisher; subscribed at the publisher, never through the aggregator',
      'bodyPolicy','Original publisher endpoint only; no aggregate summaries or proxy services',
      'paginationPolicy','Bounded current feed only; not an exhaustive historical archive',
      'datePolicy',CASE WHEN adapter='github_search'
        THEN 'Repository creation date is the publication date; a later push never redates an entry'
        ELSE 'Publisher supplies per-item publication dates; collection time is never substituted' END,
      'coveragePolicy',CASE WHEN adapter='github_search'
        THEN 'Public repositories owned by this account only; popularity is never evidence'
        ELSE 'First-party posts from this publisher only' END)
  FROM catalog
  WHERE NOT EXISTS (
    SELECT FROM sources existing
    WHERE existing.owner_user_id IS NULL AND existing.endpoint=catalog.endpoint
  )
  ON CONFLICT DO NOTHING RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,topic.id,CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY topic(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=topic.id ON CONFLICT DO NOTHING;
