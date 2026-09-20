INSERT INTO publishers(id,name,entity_type,official_domains) VALUES
 ('10000000-0000-0000-0000-000000000304','新智元','publication','["aiera.com.cn"]'),
 ('10000000-0000-0000-0000-000000000305','Andrej Karpathy','author','["karpathy.bearblog.dev","karpathy.ai"]')
ON CONFLICT DO NOTHING;
WITH catalog(suffix,name,endpoint,adapter,tier,language,topics) AS(
 VALUES
 (304,'新智元 · 官网 RSS','https://aiera.com.cn/feed/','rss','T2','zh',ARRAY['agi','agent','ai-coding']),
 (305,'Andrej Karpathy · 作者博客','https://karpathy.bearblog.dev/feed/','atom','T1.5','en',ARRAY['agi','ai-coding','agent'])
), inserted AS(
 INSERT INTO sources(id,publisher_id,name,endpoint,content_type,adapter_type,tier,lifecycle_status,schedule_minutes,language,compliance)
 SELECT ('20000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
 ('10000000-0000-0000-0000-'||lpad(suffix::text,12,'0'))::uuid,
 name,endpoint,'blog',adapter,tier,'observing',180,language,
 jsonb_build_object('catalogVersion','2026-09-08-reader','verifiedAt','2026-09-08','verificationUrl',endpoint,
 'provenance','direct_publisher','topicIds',to_jsonb(topics),'observationRequired',true,
 'bodyPolicy','Publisher or author feed; not a proxy for their private or social-platform timeline')
 FROM catalog ON CONFLICT DO NOTHING RETURNING id,compliance
)
INSERT INTO source_topics(source_id,taxonomy_id,relevance,origin)
SELECT inserted.id,t.id,CASE WHEN t.ordinality=1 THEN 1.0 ELSE 0.8 END,'verified_catalog'
FROM inserted CROSS JOIN LATERAL jsonb_array_elements_text(inserted.compliance->'topicIds') WITH ORDINALITY t(id,ordinality)
JOIN taxonomy_nodes tn ON tn.id=t.id ON CONFLICT DO NOTHING;

CREATE TABLE source_watchlist(
 id text PRIMARY KEY,platform text NOT NULL CHECK(platform IN('x','wechat')),
 name text NOT NULL,handle text,profile_url text,status text NOT NULL,note text NOT NULL
);
INSERT INTO source_watchlist VALUES
 ('wechat-aiera','wechat','新智元','AI_era','https://aiera.com.cn/','website_feed',
  '已直接订阅其官网 RSS；这不是微信公众号接口，公众号时间线本身仍需授权入口。'),
 ('x-karpathy','x','Andrej Karpathy','karpathy','https://x.com/karpathy','needs_authorization',
  '根据本人官网确认账号；作者博客已直接订阅，X 时间线仍待官方 API 授权。未执行社交账号关注操作。'),
 ('x-tibo','x','Tibo','tibo_maker','https://x.com/tibo_maker','needs_confirmation',
  '按 Builder 语境登记候选 @tibo_maker；需确认具体账号并配置 X 官方 API 授权，尚未监听。');

CREATE TABLE reader_shares(
 id uuid PRIMARY KEY,document jsonb NOT NULL,editor jsonb,published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz
);
CREATE INDEX reader_shares_public ON reader_shares(created_at DESC) WHERE published AND revoked_at IS NULL;
INSERT INTO app_settings(key,value) VALUES('share_settings','{"publicBaseUrl":null}') ON CONFLICT DO NOTHING;
