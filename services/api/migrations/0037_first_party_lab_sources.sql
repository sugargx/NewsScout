-- Additive catalog growth only. No existing source, event, summary, snapshot or
-- reader row is rewritten; no classification function changes.
--
-- Found by reading an aggregator's public feed once to see which ORIGINAL
-- publishers it cites, then subscribing to those publishers directly. The
-- aggregator itself stays blocked by validate_adapter_endpoint and is not a source.

INSERT INTO publishers(id,name,entity_type,official_domains) VALUES
  ('10000000-0000-0000-0000-000000000417','Google Research','lab','["research.google"]'),
  ('10000000-0000-0000-0000-000000000418','Ollama','project','["ollama.com","github.com"]'),
  ('10000000-0000-0000-0000-000000000419','LangChain','company','["langchain.com","github.com"]')
ON CONFLICT DO NOTHING;

WITH catalog(suffix,publisher,name,endpoint,adapter,tier,schedule,topics,sample) AS (
  VALUES
  (417,417,'Google Research Blog','https://research.google/blog/rss/','rss','T1',180,
    ARRAY['agi'],'Grounding AI agents in biological reality: Building blocks for autonomous wet labs'),
  (418,418,'Ollama Blog','https://ollama.com/blog/rss.xml','rss','T1',360,
    ARRAY['ai-infra','open-models'],'Clef is available on Ollama''s cloud'),
  (419,419,'LangChain Blog','https://blog.langchain.com/rss.xml','rss','T1',360,
    ARRAY['agent','context'],'How Numan Built an Eval-First AI Health Coach with LangGraph and LangSmith')
), inserted AS (
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT ('20000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
    ('10000000-0000-0000-0000-'||lpad(publisher::text,12,'0'))::uuid,
    name,endpoint,'blog',adapter,tier,'observing',schedule,'en',
    jsonb_build_object('catalogVersion','2026-10-20-first-party','verifiedAt','2026-10-20',
      'verificationMethod','Direct HTTPS fetch of the publisher feed with a sampled first entry and a confirmed publication date',
      'verificationUrl',endpoint,'sampleTitle',sample,'topicIds',to_jsonb(topics),
      'provenance','direct_publisher','observationRequired',true,'authentication','none','mode','monitor',
      'discovery','Named by a public aggregator as the original publisher; subscribed at the publisher, never through the aggregator',
      'bodyPolicy','Original publisher feed only; no aggregate summaries or proxy services',
      'paginationPolicy','Bounded current feed only; not an exhaustive historical archive',
      'datePolicy','Feed carries per-item publication dates; collection time is never substituted',
      'coveragePolicy','First-party posts from this publisher only')
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
