-- Verified on 2026-09-09 against the official robots policy and public indexes.
-- Additive registrations only: do not change existing News, user settings or history.
WITH catalog(suffix,name,endpoint,adapter,topics,category,sample) AS (
  VALUES
  (306,'Anthropic Research · 官方研究索引','https://www.anthropic.com/research',
    'anthropic_research',ARRAY['agi','agent'],'Research','Formalizing Fermat''s Last Theorem'),
  (307,'Anthropic Engineering · 官方工程索引','https://www.anthropic.com/engineering',
    'anthropic_engineering',ARRAY['agent','context','agi'],'Engineering','How we contain Claude across products')
), inserted AS (
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT ('20000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
    '10000000-0000-0000-0000-000000000114'::uuid,
    name,endpoint,'blog',adapter,'T1','observing',180,'en',
    jsonb_build_object(
      'catalogVersion','2026-09-09-anthropic-technical','verifiedAt','2026-09-09',
      'verificationMethod','Direct public HTTPS index and passive JSON Flight metadata; no script execution',
      'verificationUrl',endpoint,'sampleTitle',sample,'topicIds',to_jsonb(topics),
      'feedCategories',jsonb_build_array(category),'provenance','direct_publisher',
      'publisherScope','https://www.anthropic.com','authentication','none',
      'mode','monitor','observationRequired',true,
      'robotsUrl','https://www.anthropic.com/robots.txt',
      'robotsPolicy','Recheck dynamically before every index fetch; fail closed when policy is unavailable or changed',
      'bodyPolicy','Index metadata only: title, original publication date, subjects and publisher summary; no article bodies',
      'maxResponseBytes',4194304,'maxEntries',200,'maxExcerptChars',3000,
      'paginationPolicy','Current index only; sort newest and deduplicate before max 200; no pagination, article or full-body crawling',
      'datePolicy','Preserve original day/time precision; never replace publication with fetch time',
      'urlPolicy','Preserve validated publisher hrefs; otherwise use the verified first-directory permalink contract, not Research membership alone',
      'coveragePolicy','Current index availability is not proof of complete last-30-day or historical coverage')
  FROM catalog ON CONFLICT DO NOTHING RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,topic.id,CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY topic(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=topic.id ON CONFLICT DO NOTHING;
