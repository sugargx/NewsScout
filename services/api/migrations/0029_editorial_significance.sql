-- Editorial significance (editorial-significance-v1). article-value-v1 measures how much
-- usable original material an item carries; it cannot tell a flagship launch from an
-- ordinary paper. Significance is a deterministic, explainable estimate from the
-- publisher's role and the article kind. It is not model judgement or fact-checking.
-- Function-only migration: no stored source material, summary, event identity/date or
-- saved daily_brief_items/share snapshot is rewritten.
CREATE FUNCTION news_editorial_significance(title text,kind text,source_entity text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH input AS MATERIALIZED (
 SELECT lower(translate(COALESCE(title,''),'‐‑‒–—−','------')) AS headline,
   COALESCE(kind,'news') AS kind,
   CASE WHEN source_entity IN('company','lab') THEN 'first_party'
     WHEN source_entity='project' THEN 'project'
     WHEN source_entity IN('publication','author','organization') THEN 'editorial'
     WHEN source_entity='podcast' THEN 'podcast'
     WHEN source_entity='index' THEN 'index'
     WHEN source_entity='community' THEN 'community'
     ELSE 'unknown' END AS role
), signals AS MATERIALIZED (
 SELECT *,
   headline ~ '(introduc|launch|announc|unveil|now available|generally available|general availability|\mreleas|\mdebut|发布|推出|上线|开源|官宣|首发|亮相)' AS launch,
   headline ~ '\m(chatgpt|gpt|claude|opus|sonnet|haiku|gemini|gemma|llama|grok|mistral|mixtral|deepseek|qwen|kimi|glm|minimax|mimo|phi|sora|veo|imagen)[- ]?v?[0-9]' AS flagship,
   headline ~ '(\mjoins\M|\mjoined\M|\mhires\M|\mhired\M|\mappoint|in residence|入职|任命|加盟|转会|跳槽)' AS people,
   substring(headline from '(?:^|[^0-9.])v?([0-9]+[.][0-9]+(?:[.][0-9]+)?)') AS version,
   headline ~ '[^a-z](alpha|beta|rc|dev|nightly|canary)[.-]?[0-9]*(\M|$)' AS prerelease
 FROM input
), scored AS MATERIALIZED (
 SELECT *,
   CASE role
     WHEN 'first_party' THEN CASE kind WHEN 'release' THEN 70 WHEN 'research' THEN 72 WHEN 'analysis' THEN 65 WHEN 'news' THEN 60 ELSE 50 END
     WHEN 'project' THEN CASE kind WHEN 'research' THEN 55 WHEN 'analysis' THEN 55 WHEN 'news' THEN 50 WHEN 'release' THEN 45 WHEN 'tutorial' THEN 45 ELSE 40 END
     WHEN 'editorial' THEN CASE kind WHEN 'analysis' THEN 65 WHEN 'research' THEN 60 WHEN 'news' THEN 55 WHEN 'release' THEN 55 ELSE 50 END
     WHEN 'podcast' THEN CASE kind WHEN 'analysis' THEN 55 WHEN 'research' THEN 55 WHEN 'news' THEN 50 WHEN 'discussion' THEN 50 ELSE 45 END
     WHEN 'index' THEN CASE kind WHEN 'research' THEN 35 ELSE 30 END
     WHEN 'community' THEN CASE kind WHEN 'analysis' THEN 45 WHEN 'research' THEN 45 WHEN 'discussion' THEN 42 ELSE 40 END
     ELSE CASE kind WHEN 'research' THEN 50 WHEN 'analysis' THEN 50 WHEN 'news' THEN 45 WHEN 'release' THEN 45 ELSE 40 END
   END AS base,
   CASE WHEN role='first_party' AND launch THEN CASE kind WHEN 'release' THEN 20 WHEN 'news' THEN 15 WHEN 'research' THEN 5 ELSE 0 END
     -- Secondary media use launch verbs for any product; only a named model launch counts.
     WHEN role IN('editorial','unknown') AND launch AND flagship AND kind IN('news','release') THEN 5 ELSE 0 END AS launch_bonus,
   CASE WHEN flagship AND role NOT IN('community','index') THEN 5 ELSE 0 END AS flagship_bonus,
   CASE WHEN people THEN -10 ELSE 0 END AS people_penalty,
   CASE WHEN kind<>'release' OR role='first_party' THEN 0
     WHEN prerelease OR version ~ '^[0-9]+[.][0-9]+[.][1-9]' THEN -15
     WHEN version ~ '^[1-9][0-9]*[.]0([.]0)?$' THEN 10 ELSE 0 END AS version_grade
 FROM signals
)
SELECT jsonb_build_object(
 'score',GREATEST(0,LEAST(100,base+launch_bonus+flagship_bonus+people_penalty+version_grade)),
 'role',role,
 'basis',concat_ws('；',
   CASE role WHEN 'first_party' THEN '第一方' WHEN 'project' THEN '项目' WHEN 'editorial' THEN '编辑/作者'
     WHEN 'podcast' THEN '播客' WHEN 'index' THEN '论文索引' WHEN 'community' THEN '社区' ELSE '未分类来源' END
     ||'·'||kind||' 基础 '||base,
   CASE WHEN launch_bonus>0 THEN '明确发布动作 +'||launch_bonus END,
   CASE WHEN flagship_bonus>0 THEN '旗舰模型版本 +5' END,
   CASE WHEN people_penalty<0 THEN '人事动态 -10' END,
   CASE WHEN version_grade<0 THEN '补丁/预发布版本 -15' WHEN version_grade>0 THEN '主版本 +10' END))
FROM scored
$$;

-- Same signature and bounded, candidate-scoped shape as 0023. Adds significance,
-- its basis, the source role, and significance-aware brief eligibility to the
-- existing editorial jsonb. article-value-v1 fields keep their meaning.
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
), assessed AS MATERIALIZED (
 SELECT *,news_editorial_significance(title,policy->>'contentKind',entity_type) AS significance,
   policy->>'contentKind' NOT IN('metadata','question','promotion')
     AND NOT (community AND char_length(original_text)<180)
     -- 0023 keeps short paywall previews in the radar only; significance must not relax that.
     AND NOT (policy->>'policyVersion'='article-value-v1-paywall-1'
       AND NOT COALESCE((policy->>'briefEligible')::boolean,false)
       AND COALESCE((policy->>'valueScore')::real,0)<=45) AS selectable
 FROM material
), features AS MATERIALIZED (
 SELECT id,content_version,min(published_at) AS freshness_at,
   (array_agg(policy ORDER BY (policy->>'valueScore')::real DESC,published_at,id))[1] AS policy,
   (array_agg(significance ORDER BY (significance->>'score')::real DESC,published_at,id))[1] AS significance,
   COALESCE(bool_or(selectable),false) AS selectable,
   max(CASE WHEN selectable THEN (policy->>'valueScore')::real END) AS selectable_value,
   LEAST(3,GREATEST(count(DISTINCT publisher_id)-1,0))::integer AS extra_publishers,
   news_facets(max(canonical_title),
     left(string_agg(COALESCE(original_url,'')||' '||original_text,' ' ORDER BY published_at DESC),12000),
     max(event_type),max(primary_topic)) AS facets,
   COALESCE(array_agg(DISTINCT COALESCE(publisher_id::text,source_id::text)) FILTER(WHERE source_id IS NOT NULL),'{}') AS publisher_keys,
   COALESCE(bool_and(community),false) AS is_community,
   COALESCE(bool_or(lifecycle_status='stable'),false) AS confirmed,
   COALESCE(max(CASE tier WHEN 'T1' THEN 85 WHEN 'T1.5' THEN 70 ELSE 55 END
     +CASE WHEN is_official THEN 10 ELSE 0 END),0)::real AS quality,
   LEAST(100,GREATEST(count(DISTINCT publisher_id)-1,0)*25)::real AS coverage
 FROM assessed GROUP BY id,content_version
), ranked AS MATERIALIZED (
 SELECT *,LEAST(100,COALESCE((significance->>'score')::real,0)+extra_publishers*10)::real AS importance
 FROM features
)
SELECT id,content_version,freshness_at,
 policy || jsonb_build_object(
   'significance',importance,
   'significanceVersion','editorial-significance-v1',
   'sourceRole',COALESCE(significance->>'role','unknown'),
   'significanceBasis',concat_ws('；',significance->>'basis',
     CASE WHEN extra_publishers>0 THEN extra_publishers+1||' 家独立发布者 +'||extra_publishers*10 END),
   'briefEligible',selectable AND (importance>=60 OR importance>=45 AND COALESCE(selectable_value,0)>=60)) AS editorial,
 facets,publisher_keys,is_community,confirmed,quality,coverage
FROM ranked
$$;

-- Same signature as 0024. Significance replaces the separate coverage term (coverage
-- now lifts significance) and source quality is a tie-break rather than a driver.
CREATE OR REPLACE FUNCTION reader_editorial_recommendations_for_profile(reader_id text,as_of timestamptz,
 weekly boolean,candidate_ids uuid[],interest_profile jsonb)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean,
 editorial jsonb,publisher_keys text[],is_community boolean)
LANGUAGE sql STABLE AS $$
WITH requested AS MATERIALIZED (
 SELECT e.id FROM events e WHERE e.status='published' AND (candidate_ids IS NULL OR e.id=ANY(candidate_ids))
), active_feedback AS MATERIALIZED (
 SELECT * FROM user_event_states us WHERE us.user_id=reader_id
   AND (us.saved_at<=as_of OR us.not_interested_at<=as_of)
), features AS MATERIALIZED (
 SELECT * FROM reader_editorial_features(ARRAY(
   SELECT id FROM requested UNION SELECT event_id FROM active_feedback))
), feedback AS MATERIALIZED (
 SELECT f.id,f.facets,f.publisher_keys,f.editorial->>'contentKind' AS kind,
   us.not_interested_reason AS reason,us.not_interested_at IS NOT NULL AS negative,
   CASE WHEN us.not_interested_at IS NOT NULL THEN us.not_interested_at ELSE us.saved_at END AS at
 FROM active_feedback us JOIN features f ON f.id=us.event_id
), preference AS (
 SELECT news_topic_alias(p->>'label') AS label,LEAST(100,GREATEST(0,(p->>'weight')::real)) AS weight
 FROM (
   SELECT ip.profile->'topics' AS topics FROM interest_profiles ip
     WHERE ip.user_id=reader_id AND interest_profile IS NULL
   UNION ALL SELECT interest_profile WHERE interest_profile IS NOT NULL
 ) profiles CROSS JOIN LATERAL jsonb_array_elements(profiles.topics) p
 WHERE (p->>'enabled')::boolean
), scored AS MATERIALIZED (
 SELECT f.*,
   (CASE WHEN f.freshness_at IS NULL THEN 0 ELSE 100*news_editorial_decay(
     GREATEST(0,extract(epoch FROM(as_of-f.freshness_at))/3600)/
       CASE WHEN weekly THEN 168 WHEN f.editorial->>'contentKind' IN('research','analysis','tutorial') THEN 96
       WHEN f.editorial->>'contentKind'='release' THEN 48 ELSE 30 END) END)::real AS recency,
   (50+LEAST(40,GREATEST(-40,COALESCE((SELECT sum(
     CASE WHEN NOT b.negative AND b.facets && f.facets THEN 8
       WHEN b.negative AND b.reason='source' AND b.publisher_keys && f.publisher_keys THEN -10
       WHEN b.negative AND b.reason='topic' AND b.facets && f.facets THEN -12
       WHEN b.negative AND b.reason IS NULL AND b.kind=f.editorial->>'contentKind' AND b.facets && f.facets THEN -2
       ELSE 0 END * news_editorial_decay(GREATEST(0,extract(epoch FROM(as_of-b.at))/86400)/30))
     FROM feedback b WHERE b.id<>f.id),0))))::real AS affinity,
   COALESCE((SELECT max(p.weight) FROM preference p WHERE p.label=ANY(f.facets)),35)::real AS interest,
   (CASE WHEN weekly OR COALESCE(us.seen_content_version,0)<f.content_version THEN 0
     WHEN COALESCE(us.opened_at,us.read_at)<=as_of THEN 6*news_editorial_decay(
       GREATEST(0,extract(epoch FROM(as_of-COALESCE(us.opened_at,us.read_at)))/3600)/48)
     WHEN us.last_seen_at<=as_of THEN 3*news_editorial_decay(GREATEST(0,extract(epoch FROM(as_of-us.last_seen_at))/3600)/24)
     ELSE 0 END)::real AS penalty,
   us.not_interested_at IS NOT NULL AS dismissed,
   COALESCE(us.last_seen_at<=as_of AND us.seen_content_version>=f.content_version,false) AS seen,
   COALESCE(us.opened_at<=as_of OR us.read_at<=as_of,false) AS opened
 FROM features f JOIN requested wanted ON wanted.id=f.id
 LEFT JOIN user_event_states us ON us.event_id=f.id AND us.user_id=reader_id
)
SELECT id,((editorial->>'significance')::real*.35+(editorial->>'valueScore')::real*.20+interest*.15+
  recency*.15+quality*.10+affinity*.05-penalty-CASE WHEN dismissed THEN 200 ELSE 0 END)::real,
 recency,affinity,penalty,facets,confirmed,dismissed,seen,opened,editorial,publisher_keys,is_community FROM scored
$$;
