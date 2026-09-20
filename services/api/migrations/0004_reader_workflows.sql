ALTER TABLE events ADD COLUMN summary_kind text NOT NULL DEFAULT 'feed'
  CHECK (summary_kind IN ('feed', 'copilot', 'demo'));
ALTER TABLE events ADD COLUMN summary_model text;
ALTER TABLE events ADD COLUMN summarized_at timestamptz;
ALTER TABLE events ADD COLUMN summary_evidence_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN content_version bigint NOT NULL DEFAULT 0;
ALTER TABLE daily_brief_items ADD COLUMN snapshot jsonb;
ALTER TABLE daily_briefs ADD COLUMN window_start timestamptz;
ALTER TABLE daily_briefs ADD COLUMN window_end timestamptz;
CREATE INDEX fetch_runs_source_latest ON fetch_runs(source_id, started_at DESC);
CREATE INDEX events_recent ON events(updated_at DESC) WHERE status = 'published';
CREATE INDEX admin_audits_action_date ON admin_audits(action, created_at);
