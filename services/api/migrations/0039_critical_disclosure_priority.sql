-- A first-party critical vulnerability disclosure is not a generic company post.
-- This is a bounded significance correction, not a change to source quotas,
-- personalization, publication dates, or saved editions.
ALTER FUNCTION news_editorial_significance(text,text,text)
  RENAME TO news_editorial_significance_base_0039;

CREATE FUNCTION news_editorial_significance(title text,kind text,source_entity text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH input AS MATERIALIZED (
 SELECT news_editorial_significance_base_0039(title,kind,source_entity) AS policy,
   lower(translate(COALESCE(title,''),'‐‑‒–—−','------')) AS headline
), assessed AS MATERIALIZED (
 SELECT *,COALESCE(source_entity,'') IN('company','lab','project')
   AND COALESCE(kind,'') IN('news','research','analysis','release')
   AND headline ~ '(\mcritical (security )?(vulnerabilit|flaw)|\mzero-day\M|严重漏洞|关键漏洞|零日漏洞)'
   AND headline ~ '(\muncover|\mdiscover|\mdisclos|\mpatch|\mfix|\mremediat|披露|发现|修复)'
   AND headline !~ '(\mhow to\M|\mtutorial\M|\mwebinar\M|\mcan [[:alpha:]]+ discover|教程|如何|研讨会)'
   AS critical_disclosure
 FROM input
)
SELECT CASE WHEN critical_disclosure THEN policy || jsonb_build_object(
   'score',LEAST(100,(policy->>'score')::integer+25),
   'basis',policy->>'basis'||'；一手严重漏洞发现/披露/修复 +25',
   'criticalDisclosure',true)
 ELSE policy END
FROM assessed
$$;
