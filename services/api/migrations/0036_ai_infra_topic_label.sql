-- Keep the reading topic named "AI Infra" everywhere, and give profiles that were
-- created before 0035 the same topic. Only the new topic is backfilled: a public
-- topic a reader removed on purpose must not reappear.

CREATE OR REPLACE FUNCTION news_topic_alias(label text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT CASE lower(btrim(label))
 WHEN 'agent' THEN 'Agent 与工具' WHEN 'microsoft agent framework' THEN 'Agent 与工具'
 WHEN 'memory' THEN '记忆与检索' WHEN 'rag' THEN '记忆与检索'
 WHEN 'ai coding' THEN 'AI 编程' WHEN 'rust' THEN '工程与开源'
 WHEN '开源模型' THEN '模型与多模态' WHEN '推理' THEN '工程与开源'
 WHEN 'hardware' THEN '芯片与硬件' WHEN 'industry' THEN '产业与商业'
 WHEN 'governance' THEN '治理与政策'
 WHEN 'ai infra' THEN 'AI Infra' WHEN 'ai-infra' THEN 'AI Infra'
 WHEN 'ai 基础设施' THEN 'AI Infra'
 ELSE btrim(label) END
$$;

-- The second argument is ORIGINAL publisher material, never generated summary.
-- "AI Infra" covers the serving, training and scheduling systems layer. Bare GPU
-- or vendor mentions stay with 芯片与硬件 so hardware news is not absorbed.
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
 CASE WHEN body ~ '(vllm|sglang|tensorrt|llama[.]cpp|deepspeed|megatron|cutlass|torch[.]compile|\mfsdp\M|\mvllm\M|tensor parallel|pipeline parallel|expert parallel|sequence parallel|kv ?cache|paged ?attention|continuous batching|speculative decoding|\mprefill\M|inference (engine|server|serving|runtime)|model serving|cuda kernel|gpu kernel|kernel fusion|\mnccl\M|infiniband|nvlink|\mrdma\M|distributed training|training cluster|gpu cluster|quantization|\mgguf\M|推理引擎|推理服务|推理框架|分布式训练|张量并行|流水线并行|并行训练|算子优化|内核优化|集群调度|量化推理|吞吐量|算力调度)' THEN 'AI Infra' END,
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

-- Profiles created before 0035 never received the new topic, because the
-- first-request seed only fills an absent profile. Add it once, at the same
-- default weight a new reader would get, preserving every existing entry.
WITH added AS (
  SELECT ip.user_id,
    jsonb_build_object('id',tn.id,'label',tn.label,'group',tn.group_name,
      'weight',50,'context','long_term','enabled',true) AS entry
  FROM interest_profiles ip
  JOIN taxonomy_nodes tn ON tn.id='ai-infra' AND tn.owner_user_id IS NULL AND tn.enabled
  WHERE jsonb_typeof(ip.profile->'topics')='array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(ip.profile->'topics') existing
      WHERE existing->>'id'='ai-infra')
), merged AS (
  SELECT added.user_id,
    jsonb_agg(combined.profile_topic ORDER BY combined.profile_topic->>'id') AS topics
  FROM added CROSS JOIN LATERAL (
    SELECT existing
    FROM interest_profiles source
    CROSS JOIN LATERAL jsonb_array_elements(source.profile->'topics') existing
    WHERE source.user_id=added.user_id
    UNION ALL SELECT added.entry
  ) combined(profile_topic)
  GROUP BY added.user_id
)
UPDATE interest_profiles ip SET profile=jsonb_set(ip.profile,'{topics}',merged.topics),updated_at=now()
FROM merged WHERE ip.user_id=merged.user_id;
