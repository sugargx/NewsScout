ALTER TABLE user_event_states ADD COLUMN not_interested_at timestamptz;
ALTER TABLE user_event_states ADD COLUMN opened_at timestamptz;
ALTER TABLE user_event_states ADD COLUMN last_seen_at timestamptz;
ALTER TABLE user_event_states ADD COLUMN seen_content_version bigint;
UPDATE user_event_states SET saved_at=COALESCE(saved_at,later_at);
UPDATE user_event_states us SET seen_content_version=e.content_version,last_seen_at=us.read_at
FROM events e WHERE e.id=us.event_id AND us.read_at IS NOT NULL;
CREATE TABLE event_exposures (
  user_id text NOT NULL,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  content_version bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,event_id,local_date)
);
UPDATE app_settings SET value=(value::jsonb || '{"includeObserving":true,"briefLimit":20}'::jsonb)::text
WHERE key='reader_settings';

CREATE FUNCTION news_facets(title text,summary text,event_type text,topic text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH content AS (SELECT lower(title || ' ' || left(summary,1800)) AS body),
tags AS (SELECT array_remove(ARRAY[
 CASE WHEN body ~ '(llm|gpt|claude|gemini|deepseek|qwen|kimi|glm|多模态|大模型|语言模型|模型能力)' THEN '模型与多模态' END,
 CASE WHEN body ~ '(agent|mcp|a2a|langgraph|智能体|工具调用|mem0|letta)' THEN 'Agent 与工具' END,
 CASE WHEN body ~ '(memory|retrieval|rag[^a-z]|记忆|检索|知识库|向量)' THEN '记忆与检索' END,
 CASE WHEN body ~ '(rust|python|sdk|debug|deploy|inference|latency|tokio|部署|调试|推理引擎|工程实践)' THEN '工程与开源' END,
 CASE WHEN body ~ '(benchmark|evaluation|evals|safety|security|评测|评估|安全|对齐)' THEN '评测与安全' END,
 CASE WHEN body ~ '(design|interaction|usability|human.computer|界面|交互|人机|可用性)' THEN '设计与交互' END,
 CASE WHEN body ~ '(psychology|cognitive|psychological|心理|认知)' THEN '心理与认知' END,
 CASE WHEN event_type IN ('paper','preprint') OR body ~ '(arxiv|preprint|预印本)' THEN '研究论文' END,
 CASE WHEN event_type='podcast' OR body ~ '(podcast|播客|访谈)' THEN '播客与访谈' END,
 CASE WHEN body ~ '(journalism|philanthrop|charity|regulation|legislation|新闻机构|公益|慈善|立法|政策)' THEN '政策与社会' END
]::text[],NULL) AS facets FROM content)
SELECT CASE WHEN cardinality(facets)=0 THEN ARRAY[COALESCE(topic,'其他动态')] ELSE facets END FROM tags
$$;

CREATE FUNCTION reader_recommendations(reader_id text,as_of timestamptz)
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
), feedback AS (
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
