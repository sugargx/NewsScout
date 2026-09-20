-- Request-scoped preferences reuse the editorial ranker. A NULL reader_id has
-- no stored feedback or interests; no visitor profile is written to a table.
CREATE FUNCTION reader_editorial_recommendations_for_profile(reader_id text,as_of timestamptz,
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
SELECT id,((editorial->>'valueScore')::real*.30+quality*.25+interest*.20+
  recency*.15+affinity*.05+coverage*.05-penalty-CASE WHEN dismissed THEN 200 ELSE 0 END)::real,
 recency,affinity,penalty,facets,confirmed,dismissed,seen,opened,editorial,publisher_keys,is_community FROM scored
$$;

-- Keep the original signature and behavior for owner readers and saved-edition workers.
CREATE OR REPLACE FUNCTION reader_editorial_recommendations(reader_id text,as_of timestamptz,
 weekly boolean DEFAULT false,candidate_ids uuid[] DEFAULT NULL)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean,
 editorial jsonb,publisher_keys text[],is_community boolean)
LANGUAGE sql STABLE AS $$
 SELECT * FROM reader_editorial_recommendations_for_profile(reader_id,as_of,weekly,candidate_ids,NULL)
$$;
