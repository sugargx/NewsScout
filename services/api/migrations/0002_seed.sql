INSERT INTO taxonomy_nodes (id, label, group_name) VALUES
  ('agi', 'AGI', 'AI 前沿'), ('agent', 'Agent', 'Agent 工程'),
  ('memory', 'Memory', 'Agent 工程'), ('open-models', '开源模型', '开源模型'),
  ('rust', 'Rust', 'Developer'), ('maf', 'Microsoft Agent Framework', '当前项目'),
  ('hci', 'HCI', '邻接领域'), ('design', 'Design', '邻接领域'),
  ('psychology', '心理学', '邻接领域'), ('context', 'Context', 'Agent 工程'),
  ('mcp-a2a', 'MCP / A2A', 'Agent 工程'), ('ai-coding', 'AI Coding', 'Developer'),
  ('languages', '编程语言', 'Developer'), ('podcast', 'Podcast', '内容形态'),
  ('founder', 'AI 公司创始人访谈', '内容形态')
ON CONFLICT DO NOTHING;

INSERT INTO publishers (id, name, entity_type, official_domains) VALUES
  ('10000000-0000-0000-0000-000000000001', 'OpenAI', 'company', '["openai.com"]'),
  ('10000000-0000-0000-0000-000000000002', 'Google DeepMind', 'lab', '["deepmind.google"]'),
  ('10000000-0000-0000-0000-000000000003', 'Microsoft Agent Framework', 'project', '["github.com", "microsoft.com"]'),
  ('10000000-0000-0000-0000-000000000004', 'Rust Project', 'project', '["rust-lang.org"]')
ON CONFLICT DO NOTHING;

INSERT INTO sources (id, publisher_id, name, endpoint, content_type, adapter_type, tier, lifecycle_status, schedule_minutes) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'OpenAI News', 'https://openai.com/news/rss.xml', 'blog', 'rss', 'T1', 'stable', 30),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Google DeepMind Blog', 'https://deepmind.google/blog/rss.xml', 'blog', 'rss', 'T1', 'stable', 30),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'Agent Framework Releases', 'https://github.com/microsoft/agent-framework/releases.atom', 'release', 'github_release_atom', 'T1', 'stable', 15),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'Rust Blog', 'https://blog.rust-lang.org/feed.xml', 'blog', 'rss', 'T1', 'stable', 60)
ON CONFLICT DO NOTHING;

INSERT INTO source_topics (source_id, taxonomy_id, relevance) VALUES
  ('20000000-0000-0000-0000-000000000001', 'agi', 1),
  ('20000000-0000-0000-0000-000000000001', 'agent', .9),
  ('20000000-0000-0000-0000-000000000002', 'agi', 1),
  ('20000000-0000-0000-0000-000000000003', 'agent', 1),
  ('20000000-0000-0000-0000-000000000003', 'maf', 1),
  ('20000000-0000-0000-0000-000000000004', 'rust', 1)
ON CONFLICT DO NOTHING;

INSERT INTO interest_profiles (user_id, profile) VALUES ('local', '{"topics":[
  {"id":"agent","label":"Agent","group":"长期兴趣","weight":100,"context":"long_term","enabled":true},
  {"id":"memory","label":"Memory","group":"长期兴趣","weight":95,"context":"long_term","enabled":true},
  {"id":"maf","label":"Microsoft Agent Framework","group":"当前项目","weight":100,"context":"current_project","enabled":true},
  {"id":"rust","label":"Rust","group":"工作领域","weight":90,"context":"work","enabled":true},
  {"id":"open-models","label":"开源模型","group":"长期兴趣","weight":90,"context":"long_term","enabled":true},
  {"id":"context","label":"Context","group":"Agent 工程","weight":90,"context":"long_term","enabled":true},
  {"id":"mcp-a2a","label":"MCP / A2A","group":"Agent 工程","weight":90,"context":"long_term","enabled":true},
  {"id":"ai-coding","label":"AI Coding","group":"Developer","weight":90,"context":"work","enabled":true},
  {"id":"languages","label":"编程语言","group":"Developer","weight":75,"context":"work","enabled":true},
  {"id":"hci","label":"HCI","group":"邻接领域","weight":65,"context":"long_term","enabled":true},
  {"id":"design","label":"Design","group":"邻接领域","weight":60,"context":"long_term","enabled":true},
  {"id":"psychology","label":"心理学","group":"邻接领域","weight":55,"context":"long_term","enabled":true},
  {"id":"podcast","label":"中文 / 英文 Podcast","group":"内容形态","weight":75,"context":"long_term","enabled":true},
  {"id":"founder","label":"AI 公司创始人访谈","group":"内容形态","weight":85,"context":"long_term","enabled":true}
]}') ON CONFLICT DO NOTHING;
