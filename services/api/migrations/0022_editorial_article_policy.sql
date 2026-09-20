-- Additive reading policy. No source configuration, event identity/version/date,
-- historic summary, or daily_brief_items.snapshot is rewritten.
ALTER TABLE events ADD COLUMN display_title text;
ALTER TABLE events ADD CONSTRAINT bounded_display_title
  CHECK(display_title IS NULL OR char_length(display_title) BETWEEN 2 AND 120);
ALTER TABLE user_event_states ADD COLUMN not_interested_reason text
  CHECK(not_interested_reason IN('topic','source','old','low_value'));
ALTER TABLE daily_briefs ADD COLUMN sections jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE FUNCTION news_topic_alias(label text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT CASE lower(btrim(label))
 WHEN 'agent' THEN 'Agent 与工具' WHEN 'microsoft agent framework' THEN 'Agent 与工具'
 WHEN 'memory' THEN '记忆与检索' WHEN 'rag' THEN '记忆与检索'
 WHEN 'ai coding' THEN 'AI 编程' WHEN 'rust' THEN '工程与开源'
 WHEN '开源模型' THEN '模型与多模态' WHEN '推理' THEN '工程与开源'
 WHEN 'hardware' THEN '芯片与硬件' WHEN 'industry' THEN '产业与商业'
 WHEN 'governance' THEN '治理与政策' ELSE btrim(label) END
$$;

-- The second argument is ORIGINAL publisher material, never generated summary.
CREATE OR REPLACE FUNCTION news_facets(title text,summary text,event_type text,topic text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH content AS MATERIALIZED (
 SELECT 0 AS priority,lower(COALESCE(title,'')) AS body
 UNION ALL SELECT 1,lower(left(COALESCE(summary,''),6000))
), tags AS MATERIALIZED (SELECT priority,array_remove(ARRAY[
 CASE WHEN body ~ '(agent|mcp|a2a|langgraph|智能体|工具调用|mem0|letta)' THEN 'Agent 与工具' END,
 CASE WHEN body ~ '(retrieval|\mrag\M|agent memory|long.term memory|memory (agent|system|retriev)|记忆|检索|知识库|向量数据库|mem0|letta)'
   OR body ~ '\mmemory\M' AND lower(COALESCE(title,'')||' '||left(COALESCE(summary,''),6000))
     !~ '(gpu|vram|dram|hbm|\mram\M|graphics|显存|内存|显卡)' THEN '记忆与检索' END,
 CASE WHEN body ~ '(ai coding|coding agent|code assistant|copilot|codex|claude code|cursor|编程助手|代码生成|辅助编程)' THEN 'AI 编程' END,
 CASE WHEN body ~ '(gpu|nvidia|vram|dram|hbm|semiconductor|chiplet|graphics card|显存|内存|显卡|芯片|半导体)' THEN '芯片与硬件' END,
 CASE WHEN body ~ '(regulation|legislation|antitrust|governance|copyright|competition policy|political control|commissar|监管|治理|立法|政策|版权|反垄断|政治控制)' THEN '治理与政策' END,
 CASE WHEN body ~ '(stratechery|business|strategy|market|revenue|acquisition|funding|partnership|ben thompson|产业|商业|营收|融资|收购|战略|平台竞争)' THEN '产业与商业' END,
 CASE WHEN body ~ '(llm|gpt|claude|gemini|deepseek|qwen|kimi|glm|多模态|大模型|语言模型|模型能力)' THEN '模型与多模态' END,
 CASE WHEN body ~ '(\mrust\M|python|sdk|debug|deploy|inference|latency|tokio|fine.tun|pipeline|\mdpo\M|部署|调试|推理引擎|工程实践|微调|流水线)' THEN '工程与开源' END,
 CASE WHEN body ~ '(benchmark|evaluation|evals|safety|security|\mmeasur(e|ed|ing)\M|weapons capabilit|评测|评估|安全|对齐)' THEN '评测与安全' END,
 CASE WHEN body ~ '(design|interaction|usability|human.computer|界面|交互|人机|可用性)' THEN '设计与交互' END,
 CASE WHEN body ~ '(psychology|cognitive|psychological|心理|认知)' THEN '心理与认知' END,
 CASE WHEN event_type IN('paper','preprint','research') OR body ~ '(arxiv|preprint|预印本)' THEN '研究论文' END,
 CASE WHEN event_type='podcast' OR body ~ '(podcast|播客|访谈)' THEN '播客与访谈' END
]::text[],NULL) AS facets FROM content), ordered AS (
 SELECT label,min(priority) AS priority,min(position) AS position
 FROM tags CROSS JOIN LATERAL unnest(facets) WITH ORDINALITY AS f(label,position) GROUP BY label
), projected AS (
 SELECT COALESCE(array_agg(label ORDER BY CASE WHEN label IN('研究论文','播客与访谈') THEN 1 ELSE 0 END,
   priority,position,label),'{}'::text[]) AS facets FROM ordered
)
SELECT CASE WHEN cardinality(facets)=0
 THEN ARRAY[COALESCE(NULLIF(news_topic_alias(topic),''),'其他动态')] ELSE facets END FROM projected
$$;

CREATE FUNCTION news_article_policy(title text,article_url text,event_type text,metadata jsonb,
  first_party boolean,source_entity text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH input AS MATERIALIZED (
 SELECT lower(COALESCE(title,'')) AS headline,lower(COALESCE(article_url,'')) AS url,
   lower(left(COALESCE(NULLIF(btrim(metadata->'readingContext'->>'body'),''),metadata->>'feedSummary',''),16000)) AS body,
   lower(COALESCE(metadata->'sourceMetadata'->>'flair','')) AS flair,
   news_technical_basis(COALESCE(article_url,''),COALESCE(title,''),COALESCE(metadata,'{}')) AS technical
), signals AS MATERIALIZED (
 SELECT *,
   headline ~ '(how we (built|train|scale)|we (built|measured|evaluated)|technical report|system card|ablation|benchmark|evaluation|architecture|implementation|reproduc|性能测试|技术报告|系统卡|架构|实测|复现|评测|实现原理)' AS substantive,
   headline ~ '(releas|introducing|launch|announc|发布|推出|开放|上线)' AS change,
   body ~ '(benchmark|latency|throughput|ablation|dataset|experiment|measurement|migration|breaking change|changelog|source code|github[.]com|实验|数据集|延迟|吞吐|迁移|开源代码)' AS supporting,
   char_length(body)>=600
     AND body ~ '(pipeline|fine.tun|\mdpo\M|direct preference optimization|routing|architecture|implementation|流水线|微调|架构|路由)'
     AND body ~ '(a/b|a.b test|ablation|benchmark|evaluat|measurement|experiment|latency|error rate|数据集|实验|评测|测试结果|延迟|错误率)' AS engineering_detail
 FROM input
), classified AS MATERIALIZED (
 SELECT *,CASE
   WHEN event_type IN('repository','model') OR reader_is_opaque_engineering_release(event_type,title) THEN 'metadata'
   WHEN headline ~ '(^help|^question|^which |^what (gpu|should|is the best)|^how (do i|can i)|^can (i|anyone)|^is (it|this) |recommend.*(gpu|laptop)|not working|out of memory|求助|请问|求推荐)'
     OR source_entity='community' AND NOT substantive AND (
       headline ~ '[?？][[:space:])]*$' OR headline ~ '^any (folks|one|advice|recommendations)'
       OR flair ~ '(help|question)') THEN 'question'
   WHEN headline ~ '(webinar|register now|join us|sponsor|discount|sale ends|limited.time|giveaway|sign up|subscribe now|sweepstake|优惠|促销|抽奖|报名|限时|赞助)'
     OR NOT engineering_detail AND (
       headline ~ '(meet (our|the) (team|partner)|customer story|success story|客户故事|5a.*认证|认证.*5a|品牌.*(大赛|挑战)|竞赛启动|大赛启动)'
       OR headline ~ '(certification|认证|challenge|competition|挑战赛|大赛|竞赛)'
          AND char_length(body)<180) THEN 'promotion'
   WHEN event_type IN('paper','preprint','research') OR url ~ '(arxiv[.]org|/research/|/papers/|transformer-circuits[.]pub|alignment[.]anthropic[.]com)'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'sourceMetadata'->'feedCategories','[]')) category
       WHERE lower(category) IN('research','publication','研究','论文'))
     OR headline ~ '(research paper|technical report|system card|研究论文|技术报告|系统卡)' THEN 'research'
   WHEN event_type='release' OR change AND (technical IS NOT NULL OR headline ~ '(version|v[0-9]|model|claude|gpt|gemini|模型|版本|sdk|api)') THEN 'release'
   WHEN headline ~ '(^how to|tutorial|getting started|beginner|step.by.step|教程|入门|手把手)' THEN 'tutorial'
   WHEN substantive OR engineering_detail OR url ~ '(/engineering/|stratechery[.]com|/analysis/)'
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'sourceMetadata'->'feedCategories','[]')) category
       WHERE lower(category) IN('engineering','工程'))
     OR headline ~ '(analysis|lessons learned|trade.off|postmortem|分析|复盘|经验教训)' THEN 'analysis'
   WHEN source_entity='community' OR event_type IN('discussion','podcast') THEN 'discussion'
   ELSE 'news' END AS kind
 FROM signals
), valued AS MATERIALIZED (
 SELECT *,LEAST(CASE WHEN COALESCE(source_entity='community',false) AND char_length(body)<180 THEN 45 ELSE 100 END,CASE kind
   WHEN 'metadata' THEN 0 WHEN 'question' THEN 5 WHEN 'promotion' THEN 8
   ELSE (CASE kind WHEN 'research' THEN 70 WHEN 'release' THEN 62 WHEN 'analysis' THEN 52
      WHEN 'tutorial' THEN 35 WHEN 'discussion' THEN 30 ELSE 40 END)
     +CASE WHEN substantive THEN 15 ELSE 0 END
     +CASE WHEN engineering_detail THEN 12 ELSE 0 END
     +CASE WHEN supporting THEN 10 ELSE 0 END
     +CASE WHEN char_length(body)>=600 THEN 8 WHEN char_length(body)>=180 THEN 4 ELSE 0 END
     +CASE WHEN kind='news' AND change THEN 15 ELSE 0 END
     +CASE WHEN kind='news' AND headline ~ '(acqui|funding|regulat|security|vulnerab|收购|融资|监管|漏洞|立法)' THEN 16 ELSE 0 END
     +CASE WHEN kind='analysis' AND url ~ 'stratechery[.]com' THEN 10 ELSE 0 END END)::real AS value
 FROM classified
)
SELECT jsonb_build_object('policyVersion','article-value-v1','contentKind',kind,'valueScore',value,
 'briefEligible',kind NOT IN('metadata','question','promotion') AND value>=60
   AND NOT (COALESCE(source_entity='community',false) AND char_length(body)<180),
 'reason','确定性规则 article-value-v1；非 AI 重要性判断或事实核验。类型='||kind||
   '；基础值='||CASE kind WHEN 'metadata' THEN '0' WHEN 'question' THEN '5' WHEN 'promotion' THEN '8'
     WHEN 'research' THEN '70' WHEN 'release' THEN '62' WHEN 'analysis' THEN '52'
     WHEN 'tutorial' THEN '35' WHEN 'discussion' THEN '30' ELSE '40' END||
   CASE WHEN substantive THEN '；标题含方法/测量/实现线索' ELSE '' END||
   CASE WHEN engineering_detail THEN '；留存原文含实现方法及测量/实验细节（加12），不因客户案例标签一概排除' ELSE '' END||
   CASE WHEN supporting THEN '；原始材料含实验/代码/变更线索' ELSE '' END||
   CASE WHEN kind='news' AND change THEN '；原始标题有明确发布/变化线索' ELSE '' END||
   CASE WHEN kind='news' AND headline ~ '(acqui|funding|regulat|security|vulnerab|收购|融资|监管|漏洞|立法)'
     THEN '；原标题涉及产业/治理/安全变化' ELSE '' END||
   CASE WHEN kind='analysis' AND url ~ 'stratechery[.]com'
     THEN '；作者原始分析栏目（不是独立核验）' ELSE '' END||
   CASE WHEN char_length(body)>=600 THEN '；原始材料至少600字（加8）'
     WHEN char_length(body)>=180 THEN '；原始材料至少180字（加4）' ELSE '；材料较少，保守估计' END||
   CASE WHEN COALESCE(source_entity='community',false) AND char_length(body)<180
     THEN '；社区仅标题/短链接材料，不据此确认实质增量，留在雷达' ELSE '' END||
   CASE WHEN first_party THEN '；第一方自述不等于重要或已核验' ELSE '' END)
FROM valued
$$;

-- Scope before reading/decompressing original material or classifying it.
-- MATERIALIZED boundaries prevent immutable SQL expressions being expanded
-- repeatedly in aggregation, scoring, filtering, and the JSON reason.
CREATE FUNCTION reader_editorial_features(candidate_ids uuid[] DEFAULT NULL)
RETURNS TABLE(id uuid,content_version bigint,freshness_at timestamptz,editorial jsonb,
 facets text[],publisher_keys text[],is_community boolean,confirmed boolean,quality real,coverage real)
LANGUAGE sql STABLE AS $$
WITH material AS MATERIALIZED (
 SELECT e.id,e.content_version,e.canonical_title,e.event_type,e.primary_topic,
   ci.published_at,ci.original_url,s.publisher_id,s.id AS source_id,s.tier,s.lifecycle_status,
   COALESCE(p.entity_type='community',false) AS community,ee.is_official,
   left(COALESCE(NULLIF(btrim(ci.metadata->'readingContext'->>'body'),''),ci.metadata->>'feedSummary',''),6000) AS original_text,
   news_article_policy(ci.title,ci.original_url,e.event_type,ci.metadata,ee.is_official,p.entity_type) AS policy
 FROM events e LEFT JOIN event_evidence ee ON ee.event_id=e.id
 LEFT JOIN content_items ci ON ci.id=ee.content_item_id LEFT JOIN sources s ON s.id=ci.source_id
 LEFT JOIN publishers p ON p.id=s.publisher_id WHERE e.status='published'
   AND (candidate_ids IS NULL OR e.id=ANY(candidate_ids))
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

CREATE VIEW event_editorial_features AS SELECT * FROM reader_editorial_features();

-- PostgreSQL rejects tiny numeric-to-real casts; archive dates must decay to zero, not fail the whole feed.
CREATE FUNCTION news_editorial_decay(half_lives numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT CASE WHEN half_lives>=100 THEN 0 ELSE power(0.5,GREATEST(0,half_lives)) END
$$;

CREATE FUNCTION reader_editorial_recommendations(reader_id text,as_of timestamptz,weekly boolean DEFAULT false,
 candidate_ids uuid[] DEFAULT NULL)
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
),
feedback AS MATERIALIZED (
 SELECT f.id,f.facets,f.publisher_keys,f.editorial->>'contentKind' AS kind,
   us.not_interested_reason AS reason,us.not_interested_at IS NOT NULL AS negative,
   CASE WHEN us.not_interested_at IS NOT NULL THEN us.not_interested_at ELSE us.saved_at END AS at
 FROM active_feedback us JOIN features f ON f.id=us.event_id
), preference AS (
 SELECT news_topic_alias(p->>'label') AS label,LEAST(100,GREATEST(0,(p->>'weight')::real)) AS weight
 FROM interest_profiles ip CROSS JOIN LATERAL jsonb_array_elements(ip.profile->'topics') p
 WHERE ip.user_id=reader_id AND (p->>'enabled')::boolean
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

-- Retain the old SQL signatures for local callers; only the implementation changes.
CREATE OR REPLACE FUNCTION reader_recommendations_core(reader_id text,as_of timestamptz)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean)
LANGUAGE sql STABLE AS $$
 SELECT event_id,rank_score,recency,affinity,novelty_penalty,facets,confirmed,not_interested,seen,opened
 FROM reader_editorial_recommendations(reader_id,as_of)
$$;
CREATE OR REPLACE FUNCTION reader_recommendations(reader_id text,as_of timestamptz)
RETURNS TABLE(event_id uuid,rank_score real,recency real,affinity real,novelty_penalty real,
 facets text[],confirmed boolean,not_interested boolean,seen boolean,opened boolean)
LANGUAGE sql STABLE AS $$
 SELECT * FROM reader_recommendations_core(reader_id,as_of)
$$;
