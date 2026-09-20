-- Classification uses original publisher metadata/title, never the generated summary.
CREATE FUNCTION news_technical_basis(article_url text,title text,metadata jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT CASE
  WHEN article_url ~ '^https://www[.]anthropic[.]com/(engineering|research)/'
    OR article_url ~ '^https://(alignment[.]anthropic[.]com|transformer-circuits[.]pub)/'
    THEN '原始技术 / 研究栏目'
  WHEN lower(title) ~ '(partnership|partners with|partnering|acquisition|acquires|fundraising|funding round|appoint|journalism|philanthrop|charity|election|policy|legislation|economic index|economic futures|opens.*office|research grants|合作伙伴|融资|募资|公益|人事任命|经济指数)'
    THEN NULL
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'sourceMetadata'->'feedCategories','[]')) category
    WHERE lower(category) IN('research','engineering','publication','safety','security','alignment','interpretability','研究','工程','安全'))
    THEN '发布者标注的技术 / 研究分类'
  WHEN lower(title) ~ '(system card|technical report|safety overview|interpretability|reinforcement learning|context engineering|multi-agent|multiagent|agentic|tool use|tool calling|prompt caching|fine.tuning|embedding|distillation|inference|benchmark|evaluation|sdk|api |api$|model context protocol|模型训练|推理优化|技术报告|系统卡|评测|强化学习|工具调用|上下文工程)'
    OR lower(title) ~ '(^introducing (claude|gpt|codex|mistral|gemini)|^claude (opus|sonnet|haiku) [0-9]|^gpt[- ][0-9]|^codex:|^building .*agent|^how we (built|train|scale))'
    THEN '技术主题标题匹配（规则识别）'
  ELSE NULL END
$$;

-- Re-read categories once without changing publisher dates or saved summaries.
UPDATE sources SET cache_meta=cache_meta-'etag'-'lastModified'
WHERE content_type='blog' AND tier='T1';
