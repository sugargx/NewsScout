-- Additive classification correction for substantive retrospectives and trend
-- roundups. Stored source material, generated summaries, event dates/identity,
-- historical daily editions and share snapshots are not rewritten.
ALTER FUNCTION news_article_policy_v1(text,text,text,jsonb,boolean,text)
  RENAME TO news_article_policy_v1_base_0031;

CREATE FUNCTION news_article_policy_v1(title text,article_url text,event_type text,metadata jsonb,
 first_party boolean,source_entity text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH input AS MATERIALIZED (
 SELECT lower(COALESCE(title,'')) AS headline,
   lower(left(COALESCE(NULLIF(btrim(metadata->'readingContext'->>'body'),''),
     metadata->>'feedSummary',''),16000)) AS body,
   news_article_policy_v1_base_0031(
     title,article_url,event_type,metadata,first_party,source_entity) AS policy
), assessed AS MATERIALIZED (
 SELECT *,COALESCE(source_entity,'') NOT IN('community','index')
   AND char_length(body)>=600
   AND headline ~ '(\mso far\M|\myear in review\M|\mretrospective\M|\mroundup\M|\mtimeline\M|\mkey trends\M|迄今|回顾|盘点|年度总结|时间线|趋势)'
   AS synthesis
 FROM input
), revised AS MATERIALIZED (
 SELECT *,LEAST(100,COALESCE((policy->>'valueScore')::real,0)+12)::real AS synthesis_value
 FROM assessed
)
SELECT CASE WHEN synthesis AND policy->>'contentKind'='news' THEN policy || jsonb_build_object(
    'contentKind','analysis',
    'valueScore',synthesis_value,
    'briefEligible',synthesis_value>=60,
    'reason',left(replace(policy->>'reason','类型=news；基础值=40','类型=analysis；基础值=52')
      ||'；长篇阶段性回顾/趋势梳理按分析处理，不因标题缺少“analysis”字样降为普通快讯。',600))
  ELSE policy END
FROM revised
$$;
