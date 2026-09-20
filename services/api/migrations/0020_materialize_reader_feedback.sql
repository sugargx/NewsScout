-- Keep the small active-feedback set separate from the per-event correlated
-- affinity calculation. Inlining it rescans the full catalog for every event.
CREATE OR REPLACE FUNCTION reader_recommendations_core(reader_id text,as_of timestamptz)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean)
LANGUAGE sql STABLE AS $$
WITH features AS (
 SELECT e.id,e.content_version,news_facets(e.canonical_title,e.summary,e.event_type,e.primary_topic) AS facets,
   max(ci.published_at) AS published,
   COALESCE(max(CASE s.tier WHEN 'T1' THEN 85 WHEN 'T1.5' THEN 70 ELSE 55 END
      +CASE WHEN ee.is_official THEN 10 ELSE 0 END),0)::real AS quality,
   LEAST(100,GREATEST(count(DISTINCT s.publisher_id)-1,0)*25)::real AS corroboration,
   COALESCE(bool_or(s.lifecycle_status='stable'),false) AS confirmed
 FROM events e LEFT JOIN event_evidence ee ON ee.event_id=e.id
 LEFT JOIN content_items ci ON ci.id=ee.content_item_id LEFT JOIN sources s ON s.id=ci.source_id
 WHERE e.status='published' GROUP BY e.id
), feedback AS MATERIALIZED (
 SELECT f.facets,CASE WHEN us.not_interested_at IS NOT NULL THEN -3 ELSE 2 END AS signal
 FROM user_event_states us JOIN features f ON f.id=us.event_id
 WHERE us.user_id=reader_id AND (us.saved_at IS NOT NULL OR us.not_interested_at IS NOT NULL)
), preference AS (
 SELECT p->>'label' AS label,LEAST(100,GREATEST(0,(p->>'weight')::real)) AS weight
 FROM interest_profiles ip CROSS JOIN LATERAL jsonb_array_elements(ip.profile->'topics') p
 WHERE ip.user_id=reader_id AND (p->>'enabled')::boolean
), scored AS (
 SELECT f.*,
   CASE WHEN f.published IS NULL OR f.published<as_of-interval '90 days' THEN 0
     ELSE 100*power(0.5,GREATEST(0,extract(epoch FROM(as_of-f.published))/3600)/24) END::real AS recency,
   (50+LEAST(40,GREATEST(-40,COALESCE((SELECT sum(b.signal*8.0
      *(SELECT count(*) FROM unnest(f.facets) k WHERE k=ANY(b.facets))
      /GREATEST(cardinality(f.facets),cardinality(b.facets))) FROM feedback b
      WHERE b.facets && f.facets),0))))::real AS affinity,
   COALESCE((SELECT max(p.weight) FROM event_tags et JOIN taxonomy_nodes tn ON tn.id=et.taxonomy_id
      JOIN preference p ON lower(p.label)=lower(tn.label) WHERE et.event_id=f.id),35)::real AS interest,
   (CASE WHEN (us.opened_at<=as_of OR us.read_at<=as_of) AND COALESCE(us.seen_content_version,f.content_version)>=f.content_version THEN 28
       WHEN us.last_seen_at<=as_of AND us.seen_content_version>=f.content_version THEN 18 ELSE 0 END
       +CASE WHEN us.saved_at IS NOT NULL THEN 6 ELSE 0 END)::real AS penalty,
   us.not_interested_at IS NOT NULL AS dismissed,
   (us.last_seen_at IS NOT NULL AND us.seen_content_version>=f.content_version) AS seen,
   (us.opened_at IS NOT NULL OR us.read_at IS NOT NULL) AS opened
 FROM features f LEFT JOIN user_event_states us ON us.event_id=f.id AND us.user_id=reader_id
)
SELECT id,(quality*.15+corroboration*.05+recency*.45+interest*.20+affinity*.15-penalty
  -CASE WHEN dismissed THEN 200 ELSE 0 END)::real,
 recency,affinity,penalty,facets,confirmed,dismissed,seen,opened FROM scored
$$;
