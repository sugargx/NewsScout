-- Capture-boundary correction, not a rewrite/backfill of stored source material,
-- model summaries, original dates/versions, or historical edition/share JSON.
-- The exact publisher marker is not an instruction to fetch paid content.
CREATE FUNCTION news_publisher_material(article_url text,metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  result jsonb := COALESCE(metadata,'{}'::jsonb);
  body text;
  boundary integer;
  context jsonb;
BEGIN
  IF COALESCE(lower(article_url),'') !~ '^https://(www[.])?stratechery[.]com(:443)?(/|[?#]|$)' THEN
    RETURN result;
  END IF;
  body := COALESCE(NULLIF(btrim(result->'readingContext'->>'body'),''),result->>'feedSummary','');
  boundary := strpos(body,'Subscribe to Stratechery Plus for full access.');
  IF boundary=0 THEN RETURN result; END IF;
  body := btrim(left(body,boundary-1));
  context := CASE WHEN jsonb_typeof(result->'readingContext')='object'
    THEN result->'readingContext' ELSE '{}'::jsonb END;
  result := jsonb_set(result,'{readingContext}',context || jsonb_build_object(
    'body',body,'status',CASE WHEN body='' THEN 'unavailable' ELSE 'partial' END,
    'truncated',true,'accessLimit','paywall'),true);
  RETURN jsonb_set(result,'{feedSummary}',to_jsonb(body),true);
END
$$;

CREATE FUNCTION news_publisher_excerpt(article_url text,metadata jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN COALESCE(lower(article_url),'') ~ '^https://(www[.])?stratechery[.]com(:443)?(/|[?#]|$)'
   THEN news_publisher_material(article_url,metadata)->>'feedSummary'
   ELSE metadata->>'feedSummary' END
$$;

ALTER FUNCTION news_article_policy(text,text,text,jsonb,boolean,text) RENAME TO news_article_policy_v1;
CREATE FUNCTION news_stratechery_policy(title text,article_url text,event_type text,metadata jsonb,
 first_party boolean,source_entity text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH material AS MATERIALIZED (
 SELECT news_publisher_material(article_url,metadata) AS cleaned
), evaluated AS MATERIALIZED (
 SELECT cleaned,news_article_policy_v1(title,article_url,event_type,cleaned,first_party,source_entity) AS policy,
   char_length(COALESCE(NULLIF(btrim(cleaned->'readingContext'->>'body'),''),cleaned->>'feedSummary','')) AS material_chars,
   COALESCE(cleaned->'readingContext'->>'accessLimit'='paywall',false) AS paywall,
   COALESCE(cleaned->'readingContext'->>'status'='partial',false) AS partial
 FROM material
), guarded AS MATERIALIZED (
 SELECT *,COALESCE(lower(article_url),'') ~ '^https://(www[.])?stratechery[.]com(:443)?(/|[?#]|$)'
   AND material_chars<600 AND (paywall OR partial) AS short_preview FROM evaluated
)
SELECT CASE WHEN short_preview THEN policy || jsonb_build_object(
    'policyVersion','article-value-v1-paywall-1','briefEligible',false,
    'valueScore',LEAST(45,(policy->>'valueScore')::real),
    'reason',left((policy->>'reason')||'；仅保留不足600字的该来源预览/部分材料，不足以判断完整分析；订阅说明不是论据，留在雷达。',600))
  WHEN paywall THEN policy || jsonb_build_object(
    'policyVersion','article-value-v1-paywall-1',
    'reason',left((policy->>'reason')||'；仅使用明确付费边界之前的原文，已忽略其后订阅/登录目录；未绕过付费访问限制。',600))
  ELSE policy END FROM guarded
$$;

CREATE FUNCTION news_article_policy(title text,article_url text,event_type text,metadata jsonb,
 first_party boolean,source_entity text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN COALESCE(lower(article_url),'') ~ '^https://(www[.])?stratechery[.]com(:443)?(/|[?#]|$)'
   THEN news_stratechery_policy(title,article_url,event_type,metadata,first_party,source_entity)
   ELSE news_article_policy_v1(title,article_url,event_type,metadata,first_party,source_entity) END
$$;

-- Keep the bounded, candidate-scoped implementation from 0022, including
-- materialization and live metadata evaluation. Only original-material cleanup
-- changes; the decay helper and recommendation/feedback functions are untouched.
CREATE OR REPLACE FUNCTION reader_editorial_features(candidate_ids uuid[] DEFAULT NULL)
RETURNS TABLE(id uuid,content_version bigint,freshness_at timestamptz,editorial jsonb,
 facets text[],publisher_keys text[],is_community boolean,confirmed boolean,quality real,coverage real)
LANGUAGE sql STABLE AS $$
WITH source_material AS NOT MATERIALIZED (
 SELECT e.id,e.content_version,e.canonical_title,e.event_type,e.primary_topic,
   ci.title,ci.published_at,ci.original_url,s.publisher_id,s.id AS source_id,s.tier,s.lifecycle_status,
   COALESCE(p.entity_type='community',false) AS community,p.entity_type,ee.is_official,
   CASE WHEN COALESCE(lower(ci.original_url),'') ~ '^https://(www[.])?stratechery[.]com(:443)?(/|[?#]|$)'
     THEN news_publisher_material(ci.original_url,ci.metadata) ELSE ci.metadata END AS metadata
 FROM events e LEFT JOIN event_evidence ee ON ee.event_id=e.id
 LEFT JOIN content_items ci ON ci.id=ee.content_item_id LEFT JOIN sources s ON s.id=ci.source_id
 LEFT JOIN publishers p ON p.id=s.publisher_id WHERE e.status='published'
   AND (candidate_ids IS NULL OR e.id=ANY(candidate_ids))
), material AS MATERIALIZED (
 SELECT id,content_version,canonical_title,event_type,primary_topic,title,published_at,original_url,
   publisher_id,source_id,tier,lifecycle_status,community,entity_type,is_official,
   left(COALESCE(NULLIF(btrim(metadata->'readingContext'->>'body'),''),metadata->>'feedSummary',''),6000) AS original_text,
   news_article_policy(title,original_url,event_type,metadata,is_official,entity_type) AS policy
 FROM source_material
), features AS MATERIALIZED (
 SELECT id,content_version,min(published_at) AS freshness_at,
   (array_agg(policy ORDER BY (policy->>'valueScore')::real DESC,published_at,id))[1] AS editorial,
   news_facets(max(canonical_title),
     left(string_agg(COALESCE(original_url,'')||' '||original_text,' ' ORDER BY published_at DESC),12000),
     max(event_type),max(primary_topic)) AS facets,
   COALESCE(array_agg(DISTINCT COALESCE(publisher_id::text,source_id::text)) FILTER(WHERE source_id IS NOT NULL),'{}') AS publisher_keys,
   COALESCE(bool_and(community),false) AS is_community,
   COALESCE(bool_or(lifecycle_status='stable'),false) AS confirmed,
   COALESCE(max(CASE tier WHEN 'T1' THEN 85 WHEN 'T1.5' THEN 70 ELSE 55 END
     +CASE WHEN is_official THEN 10 ELSE 0 END),0)::real AS quality,
   LEAST(100,GREATEST(count(DISTINCT publisher_id)-1,0)*25)::real AS coverage
 FROM material GROUP BY id,content_version
)
SELECT * FROM features
$$;
