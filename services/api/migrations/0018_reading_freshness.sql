-- Earliest evidence is a ranking clock, not an asserted event-occurrence timestamp.
CREATE VIEW event_reading_context AS
SELECT e.id AS event_id,min(ci.published_at) AS freshness_at,
  CASE WHEN e.canonical_title ~* '(刚刚|炸裂|登顶|屠榜|刷屏|震撼|breaking|game.chang)'
    AND COALESCE(max(char_length(ci.metadata->>'feedSummary')),0)<240
    AND NOT COALESCE(bool_or(s.tier='T1'),false)
    THEN 14 ELSE 0 END::real AS material_penalty
FROM events e LEFT JOIN event_evidence ee ON ee.event_id=e.id
LEFT JOIN content_items ci ON ci.id=ee.content_item_id LEFT JOIN sources s ON s.id=ci.source_id
GROUP BY e.id;

CREATE OR REPLACE FUNCTION reader_recommendations(reader_id text,as_of timestamptz)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean)
LANGUAGE sql STABLE AS $$
  SELECT r.event_id,(r.rank_score-r.recency*.45+clock.recency*.45-context.material_penalty
      -CASE WHEN e.event_type='repository' THEN 25 ELSE 0 END)::real,
    clock.recency,r.affinity,r.novelty_penalty,r.facets,r.confirmed,r.not_interested,r.seen,r.opened
  FROM reader_recommendations_core(reader_id,as_of) r JOIN events e ON e.id=r.event_id
  JOIN event_reading_context context ON context.event_id=e.id
  CROSS JOIN LATERAL(SELECT CASE WHEN context.freshness_at IS NULL OR context.freshness_at<as_of-interval '90 days' THEN 0
    ELSE 100*power(0.5,GREATEST(0,extract(epoch FROM(as_of-context.freshness_at))/3600)/24) END::real AS recency) clock
$$;
