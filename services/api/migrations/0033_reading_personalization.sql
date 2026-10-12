-- Optional, reader-owned weak feedback. No historical opens are backfilled and
-- no saved edition, source material, explicit interest or summary is rewritten.
CREATE TABLE reader_personalization (
  user_id text PRIMARY KEY DEFAULT scoutnews_actor(),
  enabled boolean NOT NULL DEFAULT false,
  generation uuid NOT NULL,
  enabled_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (enabled = (enabled_since IS NOT NULL))
);
CREATE TABLE reader_reading_signals (
  user_id text NOT NULL DEFAULT scoutnews_actor()
    REFERENCES reader_personalization(user_id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  content_version bigint NOT NULL CHECK(content_version >= 0),
  surface text NOT NULL CHECK(surface IN('radar','brief','reading','weekly','saved','topics','article')),
  active_ms integer NOT NULL CHECK(active_ms BETWEEN 20000 AND 120000),
  facets text[] NOT NULL CHECK(cardinality(facets) <= 40),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,event_id)
);
CREATE INDEX reader_reading_signals_recent ON reader_reading_signals(user_id,recorded_at DESC);
CREATE INDEX reader_reading_signals_retention ON reader_reading_signals(recorded_at);
ALTER TABLE reader_personalization ENABLE ROW LEVEL SECURITY;
ALTER TABLE reader_reading_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY reader_owner ON reader_personalization TO scoutnews_reader
  USING(user_id=scoutnews_actor()) WITH CHECK(user_id=scoutnews_actor());
CREATE POLICY reader_owner ON reader_reading_signals TO scoutnews_reader
  USING(user_id=scoutnews_actor())
  WITH CHECK(user_id=scoutnews_actor() AND scoutnews_event_visible(event_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON reader_personalization,reader_reading_signals TO scoutnews_reader;

-- Keep the established signature, weights and score fields. Reading only adds
-- at most 20 affinity points (one total ranking point), behind explicit feedback.
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
   us.not_interested_reason AS reason,COALESCE(us.not_interested_at<=as_of,false) AS negative,
   CASE WHEN us.not_interested_at<=as_of THEN us.not_interested_at ELSE us.saved_at END AS at
 FROM active_feedback us JOIN features f ON f.id=us.event_id
), preference AS MATERIALIZED (
 SELECT news_topic_alias(p->>'label') AS label,LEAST(100,GREATEST(0,(p->>'weight')::real)) AS weight,
   (p->>'enabled')::boolean AS enabled
 FROM (
   SELECT ip.profile->'topics' AS topics FROM interest_profiles ip
     WHERE ip.user_id=reader_id AND interest_profile IS NULL
   UNION ALL SELECT interest_profile WHERE interest_profile IS NOT NULL
 ) profiles CROSS JOIN LATERAL jsonb_array_elements(profiles.topics) p
), reading AS MATERIALIZED (
 SELECT s.event_id,s.facets,
   2*news_editorial_decay(extract(epoch FROM(as_of-s.recorded_at))/86400/14) AS strength
 FROM reader_reading_signals s JOIN reader_personalization p ON p.user_id=s.user_id
 WHERE reader_id=scoutnews_actor() AND reader_id<>'local' AND interest_profile IS NULL
   AND s.user_id=reader_id AND p.enabled AND s.generation=p.generation
   AND p.enabled_since<=as_of AND s.recorded_at>=p.enabled_since
   AND s.recorded_at BETWEEN as_of-interval '30 days' AND as_of
   AND scoutnews_event_visible(s.event_id)
   -- A bookmark already supplies the stronger signal; never double count it.
   AND NOT EXISTS(SELECT FROM active_feedback b WHERE b.event_id=s.event_id)
 ORDER BY s.recorded_at DESC,s.event_id LIMIT 150
), reading_topics AS MATERIALIZED (
 SELECT facet,count(*) AS support,sum(strength) AS strength
 FROM (SELECT DISTINCT r.event_id,facet,r.strength
   FROM reading r CROSS JOIN LATERAL unnest(r.facets) facet) unique_topics
 GROUP BY facet
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
     FROM feedback b WHERE b.id<>f.id),0)
     + CASE WHEN EXISTS(SELECT FROM feedback b WHERE b.negative AND (
         b.reason='source' AND b.publisher_keys && f.publisher_keys
         OR b.reason='topic' AND b.facets && f.facets
         OR b.reason IS NULL AND b.kind=f.editorial->>'contentKind' AND b.facets && f.facets))
       THEN 0 ELSE COALESCE((SELECT max(LEAST(20,t.strength-
         CASE WHEN t.facet=ANY(own_reading.facets) THEN own_reading.strength ELSE 0 END))
         FROM reading_topics t WHERE t.facet=ANY(f.facets)
           AND t.facet NOT IN('研究论文','播客与访谈','其他动态')
           AND t.support-CASE WHEN t.facet=ANY(own_reading.facets) THEN 1 ELSE 0 END>=2
           AND NOT EXISTS(SELECT FROM preference p WHERE p.label=t.facet AND (NOT p.enabled OR p.weight=0))
       ),0) END)))::real AS affinity,
   COALESCE((SELECT max(p.weight) FROM preference p WHERE p.enabled AND p.label=ANY(f.facets)),35)::real AS interest,
   (CASE WHEN weekly OR COALESCE(us.seen_content_version,0)<f.content_version THEN 0
     WHEN COALESCE(us.opened_at,us.read_at)<=as_of THEN 6*news_editorial_decay(
       GREATEST(0,extract(epoch FROM(as_of-COALESCE(us.opened_at,us.read_at)))/3600)/48)
     WHEN us.last_seen_at<=as_of THEN 3*news_editorial_decay(GREATEST(0,extract(epoch FROM(as_of-us.last_seen_at))/3600)/24)
     ELSE 0 END)::real AS penalty,
   COALESCE(us.not_interested_at<=as_of,false) AS dismissed,
   COALESCE(us.last_seen_at<=as_of AND us.seen_content_version>=f.content_version,false) AS seen,
   COALESCE(us.opened_at<=as_of OR us.read_at<=as_of,false) AS opened
 FROM features f JOIN requested wanted ON wanted.id=f.id
 LEFT JOIN user_event_states us ON us.event_id=f.id AND us.user_id=reader_id
 LEFT JOIN reading own_reading ON own_reading.event_id=f.id
)
SELECT id,((editorial->>'significance')::real*.35+(editorial->>'valueScore')::real*.20+interest*.15+
  recency*.15+quality*.10+affinity*.05-penalty-CASE WHEN dismissed THEN 200 ELSE 0 END)::real,
 recency,affinity,penalty,facets,confirmed,dismissed,seen,opened,editorial,publisher_keys,is_community FROM scored
$$;
