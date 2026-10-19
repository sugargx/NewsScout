-- Additive AI Infra registration. No existing source, event, summary, snapshot or
-- reader state is rewritten; only classification helpers and the catalog grow.

-- Machine tags published alongside real releases (CI branch tags, bare build
-- numbers, nightly markers) stay behind the existing development-build toggle.
CREATE OR REPLACE FUNCTION reader_is_opaque_engineering_release(event_type text, title text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT event_type='release' AND (
    lower(trim(title)) ~ '^[0-9a-f]{12,64}$'
    OR lower(trim(title)) ~ '^([a-z0-9]+[-_])*(handoff|runtime|build|ci|nightly)([-_][a-z0-9]+)*[-_][0-9a-f]{12,64}$'
    OR lower(trim(title)) ~ '^(handoff|runtime|build|ci|nightly)[-_][0-9]{5,}$'
    -- "viable/strict/1792399349": a continuous-integration branch tag, not a version.
    OR lower(trim(title)) ~ '^(viable|strict|main|master|trunk|dev|ci)(/[a-z0-9._-]+)*/[0-9]{6,}$'
    -- "b11727": a bare build counter with no version structure.
    OR lower(trim(title)) ~ '^[a-z]{1,3}[0-9]{4,}$'
    -- "nightly-last-green: ...": a moving pointer that is republished continuously.
    OR lower(trim(title)) ~ '^(nightly|last.green|canary)([-_: ]|$)'
  )
$$;

INSERT INTO taxonomy_nodes (id, label, group_name) VALUES
  ('ai-infra', 'AI Infra', 'Developer')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION news_topic_alias(label text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT CASE lower(btrim(label))
 WHEN 'agent' THEN 'Agent 与工具' WHEN 'microsoft agent framework' THEN 'Agent 与工具'
 WHEN 'memory' THEN '记忆与检索' WHEN 'rag' THEN '记忆与检索'
 WHEN 'ai coding' THEN 'AI 编程' WHEN 'rust' THEN '工程与开源'
 WHEN '开源模型' THEN '模型与多模态' WHEN '推理' THEN '工程与开源'
 WHEN 'hardware' THEN '芯片与硬件' WHEN 'industry' THEN '产业与商业'
 WHEN 'governance' THEN '治理与政策'
 WHEN 'ai infra' THEN 'AI 基础设施' WHEN 'ai-infra' THEN 'AI 基础设施'
 ELSE btrim(label) END
$$;

-- The second argument is ORIGINAL publisher material, never generated summary.
-- "AI 基础设施" covers the serving, training and scheduling systems layer. Bare
-- GPU or vendor mentions stay with 芯片与硬件 so hardware news is not absorbed.
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
 CASE WHEN body ~ '(vllm|sglang|tensorrt|llama[.]cpp|deepspeed|megatron|cutlass|torch[.]compile|\mfsdp\M|\mvllm\M|tensor parallel|pipeline parallel|expert parallel|sequence parallel|kv ?cache|paged ?attention|continuous batching|speculative decoding|\mprefill\M|inference (engine|server|serving|runtime)|model serving|cuda kernel|gpu kernel|kernel fusion|\mnccl\M|infiniband|nvlink|\mrdma\M|distributed training|training cluster|gpu cluster|quantization|\mgguf\M|推理引擎|推理服务|推理框架|分布式训练|张量并行|流水线并行|并行训练|算子优化|内核优化|集群调度|量化推理|吞吐量|算力调度)' THEN 'AI 基础设施' END,
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

INSERT INTO publishers(id,name,entity_type,official_domains) VALUES
  ('10000000-0000-0000-0000-000000000401','PyTorch','project','["pytorch.org","github.com"]'),
  ('10000000-0000-0000-0000-000000000402','NVIDIA','company','["nvidia.com","developer.nvidia.com","github.com"]'),
  ('10000000-0000-0000-0000-000000000403','Meta Engineering','company','["engineering.fb.com"]'),
  ('10000000-0000-0000-0000-000000000404','The Chip Letter','author','["thechipletter.substack.com"]'),
  ('10000000-0000-0000-0000-000000000405','Interconnects','author','["interconnects.ai"]'),
  ('10000000-0000-0000-0000-000000000407','vLLM','project','["vllm.ai","github.com"]'),
  ('10000000-0000-0000-0000-000000000408','SGLang','project','["github.com"]'),
  ('10000000-0000-0000-0000-000000000411','DeepSpeed','project','["deepspeed.ai","github.com"]'),
  ('10000000-0000-0000-0000-000000000412','Ray','project','["ray.io","github.com"]'),
  ('10000000-0000-0000-0000-000000000413','Triton','project','["github.com"]'),
  ('10000000-0000-0000-0000-000000000415','ggml','project','["ggml.ai","github.com"]'),
  ('10000000-0000-0000-0000-000000000416','JAX','project','["jax.dev","github.com"]')
ON CONFLICT DO NOTHING;

WITH catalog(suffix,publisher,name,endpoint,content_type,adapter,tier,schedule,topics,sample) AS (
  VALUES
  (401,401,'PyTorch Blog','https://pytorch.org/blog/feed.xml','blog','rss','T1',180,
    ARRAY['ai-infra','open-models'],'Bringing Elastically Deterministic Data Loading to TorchTitan with Zephon'),
  (402,402,'NVIDIA Developer Blog','https://developer.nvidia.com/blog/feed/','blog','atom','T1',180,
    ARRAY['ai-infra','hardware'],'Code, Test, and Deploy on One Machine with NVIDIA RTX Spark'),
  (403,403,'Meta Engineering','https://engineering.fb.com/feed/','blog','rss','T1',360,
    ARRAY['ai-infra','rust'],'How Meta Built Forum With AI-Native Engineering'),
  (404,404,'The Chip Letter','https://thechipletter.substack.com/feed','blog','rss','T2',360,
    ARRAY['ai-infra','hardware'],'Pat Gelsinger : Why This is the Best Time to Build Hardware'),
  (405,405,'Interconnects','https://www.interconnects.ai/feed','blog','rss','T2',360,
    ARRAY['ai-infra','open-models'],'Meta shakes up the frontiers, open and closed'),
  (406,111,'arXiv Distributed Computing (cs.DC)',
    'https://export.arxiv.org/api/query?search_query=cat:cs.DC&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending',
    'paper','arxiv_atom','T1.5',720,
    ARRAY['ai-infra'],'Agentic AI for Heterogeneous System Design Across Chip, Scale-Up, and Scale-Out Domains'),
  (407,407,'vLLM Releases','https://github.com/vllm-project/vllm/releases.atom','release','github_release_atom','T1',180,
    ARRAY['ai-infra'],'v0.32.1rc0'),
  (408,408,'SGLang Releases','https://github.com/sgl-project/sglang/releases.atom','release','github_release_atom','T1',180,
    ARRAY['ai-infra'],'v0.5.22'),
  (409,402,'TensorRT-LLM Releases','https://github.com/NVIDIA/TensorRT-LLM/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra','hardware'],'v1.4.0rc0'),
  (410,401,'PyTorch Releases','https://github.com/pytorch/pytorch/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra'],'viable/strict/1792399349'),
  (411,411,'DeepSpeed Releases','https://github.com/deepspeedai/DeepSpeed/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra'],'nightly-last-green: Release process-group caches before CPU/Gloo worker shutdown (#8846)'),
  (412,412,'Ray Releases','https://github.com/ray-project/ray/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra'],'Ray-2.59.0'),
  (413,413,'Triton Releases','https://github.com/triton-lang/triton/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra'],'gfx950-tutorial-v3.1'),
  (414,402,'CUTLASS Releases','https://github.com/NVIDIA/cutlass/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra','hardware'],'CUTLASS 4.8.0'),
  (415,415,'llama.cpp Releases','https://github.com/ggml-org/llama.cpp/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra','open-models'],'b11727'),
  (416,416,'JAX Releases','https://github.com/jax-ml/jax/releases.atom','release','github_release_atom','T1',360,
    ARRAY['ai-infra'],'JAX v0.11.2')
), inserted AS (
  INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,
    lifecycle_status,schedule_minutes,language,compliance)
  SELECT ('20000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
    ('10000000-0000-0000-0000-'||lpad(publisher::text,12,'0'))::uuid,
    name,endpoint,content_type,adapter,tier,'observing',schedule,'en',
    jsonb_build_object('catalogVersion','2026-10-19-ai-infra','verifiedAt','2026-10-19',
      'verificationMethod','Direct HTTPS fetch of the publisher feed with a sampled first entry',
      'verificationUrl',endpoint,'sampleTitle',sample,'topicIds',to_jsonb(topics),
      'provenance','direct_publisher','observationRequired',true,'authentication','none',
      'mode',CASE WHEN adapter='arxiv_atom' THEN 'discover' ELSE 'monitor' END,
      'bodyPolicy','Original publisher, project or author feed only; no aggregate summaries or proxy services',
      'paginationPolicy','Bounded current feed only; not an exhaustive historical archive',
      'datePolicy','Preserve original publication time; never replace it with collection time',
      'releaseTagPolicy',CASE WHEN content_type='release'
        THEN 'Upstream tag feeds also carry continuous-integration, nightly and build counters; those stay behind the development-build toggle'
        ELSE 'Not a tag feed' END,
      'coveragePolicy','AI infrastructure layer: serving, training, kernels and scheduling; hardware product news stays with its own topic')
  FROM catalog
  WHERE NOT EXISTS (
    SELECT FROM sources existing
    WHERE existing.owner_user_id IS NULL AND existing.endpoint=catalog.endpoint
  )
  ON CONFLICT DO NOTHING RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,topic.id,CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY topic(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=topic.id ON CONFLICT DO NOTHING;
