ALTER TABLE source_watchlist DROP CONSTRAINT source_watchlist_platform_check;
ALTER TABLE source_watchlist ADD CONSTRAINT source_watchlist_platform_check
 CHECK(platform IN('x','wechat','podcast','blog','youtube','weibo','reddit','bilibili','collection','github','community'));
ALTER TABLE source_watchlist ADD COLUMN source_id uuid REFERENCES sources(id) ON DELETE SET NULL;
ALTER TABLE source_watchlist ADD COLUMN origin_url text;
ALTER TABLE source_watchlist ADD COLUMN origin_label text;
ALTER TABLE source_watchlist ADD COLUMN origin_block text;
ALTER TABLE source_watchlist ADD COLUMN document_urls jsonb NOT NULL DEFAULT '[]';
CREATE INDEX source_watchlist_source_id ON source_watchlist(source_id) WHERE source_id IS NOT NULL;
CREATE TABLE source_directory_imports(
 id text PRIMARY KEY,manifest_hash text NOT NULL,origin_url text NOT NULL,
 entry_count integer NOT NULL,new_source_count integer NOT NULL,imported_at timestamptz NOT NULL DEFAULT now()
);
