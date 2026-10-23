-- Sources eligible for one collection pass.
--
-- $1 force, $2 single source, $3 supported adapters, $4 daily-run start.
--
-- The shared catalog is selected here on the same terms as a reader's own
-- sources: nothing restricts this to owned rows, so a catalog feed follows its
-- own interval instead of waiting for the next daily edition slot. The per
-- adapter floor below is a lower bound on that interval, never an override of a
-- longer one, so a source configured to poll less often keeps its own pace.
SELECT s.id,s.name,s.endpoint,s.content_type,s.adapter_type,s.tier,s.cache_meta,s.compliance,s.publisher_id,s.owner_user_id,
    COALESCE(p.official_domains,'[]'::jsonb) AS official_domains
FROM sources s LEFT JOIN publishers p ON p.id=s.publisher_id
WHERE s.lifecycle_status IN ('stable','observing')
  AND s.adapter_type = ANY($3)
  AND ($2::uuid IS NULL OR s.id=$2)
  AND ($4::timestamptz IS NULL OR NOT EXISTS(SELECT 1 FROM fetch_runs f
      WHERE f.source_id=s.id AND f.started_at>=$4 AND f.status IN ('success','not_modified')))
  AND (s.cache_meta->>'retryAfter' IS NULL OR (s.cache_meta->>'retryAfter')::timestamptz <= now())
  AND ($1::boolean OR s.cache_meta->>'retryAfter' IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM fetch_runs f WHERE f.source_id=s.id
    AND f.started_at + make_interval(mins => GREATEST(s.schedule_minutes,
        CASE s.adapter_type WHEN 'arxiv_atom' THEN 720 WHEN 'github_search' THEN 360
        WHEN 'github_repository' THEN 360 WHEN 'huggingface_models' THEN 60
        WHEN 'anthropic_news' THEN 180 WHEN 'anthropic_research' THEN 180 WHEN 'anthropic_engineering' THEN 180
        WHEN 'x_public_preview' THEN 1440 ELSE 1 END)) > now()))
ORDER BY s.last_success_at ASC NULLS FIRST,s.name,s.id
