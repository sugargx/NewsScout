-- Add the verified Engineering feed without replacing AI & ML or reader overrides.
WITH inserted AS (
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT '20000000-0000-0000-0000-000000000308'::uuid,
    '10000000-0000-0000-0000-000000000303'::uuid,
    'GitHub Blog · Engineering','https://github.blog/engineering/feed/','blog','rss','T1',
    'observing',180,'en',
    jsonb_build_object(
      'catalogVersion','2026-10-11-github-engineering','verifiedAt','2026-10-11',
      'verificationMethod','Official public RSS and robots policy',
      'verificationUrl','https://github.blog/engineering/feed/',
      'sampleTitle','Building Git infrastructure for agent-scale development',
      'sampleUrl','https://github.blog/engineering/architecture-optimization/building-git-infrastructure-for-agent-scale-development/',
      'topicIds',jsonb_build_array('ai-coding','agent'),
      'feedCategories',jsonb_build_array('Engineering'),
      'provenance','direct_publisher','publisherScope','https://github.blog',
      'authentication','none','mode','monitor','observationRequired',true,
      'robotsUrl','https://github.blog/robots.txt',
      'bodyPolicy','Original publisher feed and existing bounded article enrichment; no third-party summaries',
      'paginationPolicy','Current bounded feed only; no exhaustive historical archive',
      'datePolicy','Preserve original publication time; never replace it with collection time',
      'coveragePolicy','Engineering category only; AI & ML remains a separate subscription')
  WHERE NOT EXISTS (
    SELECT FROM sources
    WHERE owner_user_id IS NULL AND endpoint='https://github.blog/engineering/feed/'
  )
  RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,topic.id,CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY topic(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=topic.id;
