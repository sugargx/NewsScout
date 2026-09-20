-- Public endpoints and sample records verified on 2026-09-07. This is an additive
-- registry expansion: existing identities, user edits, health, content and clocks
-- are never overwritten. New sources remain observing until explicitly confirmed.
INSERT INTO publishers (id, name, entity_type, official_domains) VALUES
  ('10000000-0000-0000-0000-000000000101', 'Hugging Face', 'company', '["huggingface.co"]'),
  ('10000000-0000-0000-0000-000000000102', 'Microsoft Research', 'lab', '["microsoft.com"]'),
  ('10000000-0000-0000-0000-000000000103', 'Microsoft Foundry', 'project', '["devblogs.microsoft.com"]'),
  ('10000000-0000-0000-0000-000000000104', 'Association for Psychological Science', 'organization', '["psychologicalscience.org"]'),
  ('10000000-0000-0000-0000-000000000105', 'Smashing Magazine', 'publication', '["smashingmagazine.com"]'),
  ('10000000-0000-0000-0000-000000000106', 'Apple Developer', 'company', '["developer.apple.com"]'),
  ('10000000-0000-0000-0000-000000000107', 'LangGraph', 'project', '["github.com"]'),
  ('10000000-0000-0000-0000-000000000108', 'Model Context Protocol', 'project', '["github.com","modelcontextprotocol.io"]'),
  ('10000000-0000-0000-0000-000000000109', 'Mem0', 'project', '["github.com","mem0.ai"]'),
  ('10000000-0000-0000-0000-000000000110', 'Letta', 'project', '["github.com","letta.com"]'),
  -- Platform hosting is not an endorsement of individual papers or models.
  ('10000000-0000-0000-0000-000000000111', 'arXiv public queries', 'index', '[]'),
  ('10000000-0000-0000-0000-000000000112', 'Qwen public model account', 'project', '[]'),
  ('10000000-0000-0000-0000-000000000113', 'DeepSeek public model account', 'project', '[]'),
  ('10000000-0000-0000-0000-000000000114', 'Anthropic', 'company', '["anthropic.com"]'),
  ('10000000-0000-0000-0000-000000000115', '张小珺', 'podcast', '["xiaoyuzhoufm.com"]'),
  ('10000000-0000-0000-0000-000000000116', 'Lex Fridman', 'podcast', '["lexfridman.com"]'),
  ('10000000-0000-0000-0000-000000000117', 'Tokio Project', 'project', '["github.com","tokio.rs"]')
ON CONFLICT DO NOTHING;

WITH catalog (suffix, publisher_id, name, endpoint, content_type, adapter_type, tier, schedule_minutes, language, mode, topics, sample_title, verification_url) AS (
  VALUES
  (101, '10000000-0000-0000-0000-000000000101', 'Hugging Face Blog',
   'https://huggingface.co/blog/feed.xml', 'blog', 'rss', 'T1', 120, 'en', 'monitor',
   ARRAY['open-models','agi','ai-coding'], 'NeoMME: an efficient Multimodal-native and Multilingual Encoder',
   'https://huggingface.co/blog/feed.xml'),
  (102, '10000000-0000-0000-0000-000000000102', 'Microsoft Research Blog',
   'https://www.microsoft.com/en-us/research/feed/', 'blog', 'rss', 'T1', 180, 'en', 'monitor',
   ARRAY['agi','hci'], 'GigaPath-Flash and GigaTIME-Flash: Toward population-scale discovery with efficient pathology foundation models',
   'https://www.microsoft.com/en-us/research/feed/'),
  (103, '10000000-0000-0000-0000-000000000103', 'Microsoft Foundry Blog',
   'https://devblogs.microsoft.com/foundry/feed/', 'blog', 'rss', 'T1', 120, 'en', 'monitor',
   ARRAY['agent','ai-coding'], 'From single call to agents: five new Claude capabilities now available in Microsoft Foundry',
   'https://devblogs.microsoft.com/foundry/feed/'),
  (104, '10000000-0000-0000-0000-000000000003', 'Microsoft Agent Framework Blog',
   'https://devblogs.microsoft.com/agent-framework/feed/', 'blog', 'rss', 'T1', 120, 'en', 'monitor',
   ARRAY['maf','agent','memory','context'], 'Native memory for Microsoft Agent Framework with Azure Cosmos DB',
   'https://devblogs.microsoft.com/agent-framework/feed/'),
  (105, '10000000-0000-0000-0000-000000000104', 'Association for Psychological Science',
   'https://www.psychologicalscience.org/feed', 'blog', 'rss', 'T1.5', 360, 'en', 'monitor',
   ARRAY['psychology'], 'Study A.I. Consciousness? The Bots Would Like a Word With You',
   'https://www.psychologicalscience.org/feed'),
  (106, '10000000-0000-0000-0000-000000000105', 'Smashing Magazine',
   'https://www.smashingmagazine.com/feed/', 'blog', 'rss', 'T2', 360, 'en', 'monitor',
   ARRAY['design','hci'], 'The Many Faces Of September (2026 Wallpapers Edition)',
   'https://www.smashingmagazine.com/feed/'),
  (107, '10000000-0000-0000-0000-000000000106', 'Apple Developer News',
   'https://developer.apple.com/news/rss/news.rss', 'blog', 'rss', 'T1', 360, 'en', 'monitor',
   ARRAY['design','ai-coding'], 'Hello Developer: September 2026',
   'https://developer.apple.com/news/rss/news.rss'),
  (108, '10000000-0000-0000-0000-000000000107', 'LangGraph Releases',
   'https://github.com/langchain-ai/langgraph/releases.atom', 'release', 'github_release_atom', 'T1', 120, 'en', 'monitor',
   ARRAY['agent','context'], 'langgraph-sdk==0.4.4',
   'https://github.com/langchain-ai/langgraph/releases.atom'),
  (109, '10000000-0000-0000-0000-000000000108', 'MCP TypeScript SDK Releases',
   'https://github.com/modelcontextprotocol/typescript-sdk/releases.atom', 'release', 'github_release_atom', 'T1', 120, 'en', 'monitor',
   ARRAY['mcp-a2a','agent'], '1.30.0',
   'https://github.com/modelcontextprotocol/typescript-sdk/releases.atom'),
  (110, '10000000-0000-0000-0000-000000000109', 'Mem0 Releases',
   'https://github.com/mem0ai/mem0/releases.atom', 'release', 'github_release_atom', 'T1', 180, 'en', 'monitor',
   ARRAY['memory','agent'], 'Mem0 Python SDK (v2.0.20)',
   'https://github.com/mem0ai/mem0/releases.atom'),
  (111, '10000000-0000-0000-0000-000000000110', 'Letta Releases',
   'https://github.com/letta-ai/letta/releases.atom', 'release', 'github_release_atom', 'T1', 180, 'en', 'monitor',
   ARRAY['memory','agent'], 'v0.16.8',
   'https://github.com/letta-ai/letta/releases.atom'),
  (112, '10000000-0000-0000-0000-000000000111', 'arXiv Artificial Intelligence (cs.AI)',
   'https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending',
   'paper', 'arxiv_atom', 'T1.5', 720, 'en', 'discover',
   ARRAY['agi','agent'], 'Diffusion TV: Experiencing Diffusion Models through Tangible, Embodied Interaction',
   'https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending'),
  (113, '10000000-0000-0000-0000-000000000111', 'arXiv Human-Computer Interaction (cs.HC)',
   'https://export.arxiv.org/api/query?search_query=cat:cs.HC&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending',
   'paper', 'arxiv_atom', 'T1.5', 720, 'en', 'discover',
   ARRAY['hci','design'], 'From Interpretability Methods to Interpretable Models',
   'https://export.arxiv.org/api/query?search_query=cat:cs.HC&start=0&max_results=40&sortBy=submittedDate&sortOrder=descending'),
  (114, '10000000-0000-0000-0000-000000000112', 'Hugging Face — Qwen public models',
   'https://huggingface.co/api/models?author=Qwen&sort=lastModified&direction=-1&limit=20&expand[]=sha&expand[]=createdAt&expand[]=lastModified&expand[]=tags&expand[]=pipeline_tag&expand[]=private&expand[]=gated',
   'model', 'huggingface_models', 'T1.5', 120, 'en', 'monitor',
   ARRAY['open-models','agi'], 'Qwen/Qwen-Drive-1.0-4B',
   'https://huggingface.co/Qwen'),
  (115, '10000000-0000-0000-0000-000000000113', 'Hugging Face — DeepSeek public models',
   'https://huggingface.co/api/models?author=deepseek-ai&sort=lastModified&direction=-1&limit=20&expand[]=sha&expand[]=createdAt&expand[]=lastModified&expand[]=tags&expand[]=pipeline_tag&expand[]=private&expand[]=gated',
   'model', 'huggingface_models', 'T1.5', 120, 'en', 'monitor',
   ARRAY['open-models','agi'], 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
   'https://huggingface.co/deepseek-ai'),
  (116, '10000000-0000-0000-0000-000000000003', 'Agent Framework Repository Metadata',
   'https://api.github.com/repos/microsoft/agent-framework', 'repository', 'github_repository', 'T1', 360, 'en', 'monitor',
   ARRAY['maf','agent'], 'microsoft/agent-framework (repository ID 974445592)',
   'https://api.github.com/repos/microsoft/agent-framework'),
  (117, NULL, 'GitHub MCP Search — unconfirmed candidates',
   'https://api.github.com/search/repositories?q=topic%3Amcp+archived%3Afalse&sort=updated&order=desc&per_page=20',
   'repository', 'github_search', 'T2', 1440, 'en', 'discover',
   ARRAY['mcp-a2a','agent'], 'Public repository search returned complete results; candidates are not vetted publishers',
   'https://api.github.com/search/repositories?q=topic%3Amcp+archived%3Afalse&sort=updated&order=desc&per_page=20'),
  (118, '10000000-0000-0000-0000-000000000114', 'Anthropic News — public index',
   'https://www.anthropic.com/news', 'blog', 'anthropic_news', 'T1', 180, 'en', 'monitor',
   ARRAY['agi','agent'], 'Previewing the Model Hardware Standard',
   'https://www.anthropic.com/robots.txt'),
  (119, '10000000-0000-0000-0000-000000000115', '张小珺Jùn｜商业访谈录',
   'https://feed.xyzfm.space/dk4yh3pkpjp3', 'podcast', 'podcast_rss', 'T1.5', 360, 'zh', 'monitor',
   ARRAY['podcast','founder','agi'], '152. 领读Kimi K3技术报告：从架构创新聊起，注意力美学、多教师蒸馏和开源MoE',
   'https://itunes.apple.com/lookup?id=1634356920&entity=podcast'),
  (120, '10000000-0000-0000-0000-000000000116', 'Lex Fridman Podcast',
   'https://lexfridman.com/feed/podcast/', 'podcast', 'podcast_rss', 'T1.5', 360, 'en', 'monitor',
   ARRAY['podcast','founder','agi'], '#501 – DHH: Future of Programming, AI, Agentic Engineering, Vibe Coding & Linux',
   'https://lexfridman.com/feed/podcast/'),
  (121, '10000000-0000-0000-0000-000000000004', 'Rust Releases',
   'https://github.com/rust-lang/rust/releases.atom', 'release', 'github_release_atom', 'T1', 180, 'en', 'monitor',
   ARRAY['rust','languages'], 'Rust 1.98.1',
   'https://github.com/rust-lang/rust/releases.atom'),
  (122, '10000000-0000-0000-0000-000000000117', 'Tokio Releases',
   'https://github.com/tokio-rs/tokio/releases.atom', 'release', 'github_release_atom', 'T1', 180, 'en', 'monitor',
   ARRAY['rust','languages'], 'tokio-stream-0.1.19',
   'https://github.com/tokio-rs/tokio/releases.atom')
), inserted AS (
  INSERT INTO sources (id, publisher_id, name, endpoint, content_type, adapter_type, tier,
    lifecycle_status, schedule_minutes, language, compliance)
  SELECT ('20000000-0000-0000-0000-' || lpad(suffix::text,12,'0'))::uuid,
    publisher_id::uuid, name, endpoint, content_type, adapter_type, tier,
    'observing', schedule_minutes, language,
    jsonb_build_object(
      'catalogVersion','2026-09-07','verifiedAt','2026-09-07','verificationMethod','public HTTPS response and publisher/feed sample',
      'verificationUrl',CASE WHEN adapter_type='huggingface_models' THEN endpoint ELSE verification_url END,
      'sampleTitle',sample_title,'mode',mode,
      'topicIds',to_jsonb(topics),'observationRequired',true,'authentication','none',
      'bodyPolicy','public feed excerpt or metadata only; no audio, weights, private pages or third-party transcripts',
      'discoveryPolicy','candidate discovery is not an endorsement; no popularity score is trusted evidence',
      'paginationPolicy','bounded first page; no claim of exhaustive or historical coverage',
      'publisherScope', CASE
        WHEN adapter_type='github_release_atom' THEN replace(endpoint,'/releases.atom','')
        WHEN adapter_type='github_repository' THEN replace(endpoint,'https://api.github.com/repos/','https://github.com/')
        WHEN suffix=119 THEN 'https://www.xiaoyuzhoufm.com/podcast/626b46ea9cbbf0451cf5a962'
        ELSE verification_url END)
  FROM catalog
  ON CONFLICT DO NOTHING
  RETURNING id, compliance
)
INSERT INTO source_topics (source_id, taxonomy_id, relevance, origin)
SELECT inserted.id, topic.id, CASE WHEN topic.ordinality=1 THEN 1.0 ELSE 0.8 END, 'verified_catalog'
FROM inserted CROSS JOIN LATERAL
  jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY AS topic(id, ordinality)
JOIN taxonomy_nodes taxonomy ON taxonomy.id=topic.id
ON CONFLICT DO NOTHING;

-- Deliberately not seeded: devblogs.microsoft.com/ai/feed/ is an empty comments
-- feed, not AI news. X lacks authorized API credentials and a concrete watchlist.
-- WeChat lacks author-approved endpoints; neither is represented as a fake Source.
