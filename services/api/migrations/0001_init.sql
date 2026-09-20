CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE publishers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  entity_type text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]',
  official_domains jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE taxonomy_nodes (
  id text PRIMARY KEY,
  parent_id text REFERENCES taxonomy_nodes(id),
  label text NOT NULL,
  group_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE sources (
  id uuid PRIMARY KEY,
  publisher_id uuid REFERENCES publishers(id),
  name text NOT NULL,
  endpoint text NOT NULL,
  content_type text NOT NULL,
  adapter_type text NOT NULL,
  adapter_version text NOT NULL DEFAULT 'v1',
  tier text NOT NULL CHECK (tier IN ('T1','T1.5','T2')),
  reliability_modifier integer NOT NULL DEFAULT 0,
  language text,
  region text,
  lifecycle_status text NOT NULL DEFAULT 'candidate',
  schedule_minutes integer NOT NULL DEFAULT 60,
  cursor jsonb NOT NULL DEFAULT '{}',
  cache_meta jsonb NOT NULL DEFAULT '{}',
  compliance jsonb NOT NULL DEFAULT '{}',
  last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(adapter_type, endpoint)
);

CREATE TABLE source_topics (
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  taxonomy_id text NOT NULL REFERENCES taxonomy_nodes(id),
  relevance real NOT NULL DEFAULT 1,
  origin text NOT NULL DEFAULT 'manual',
  PRIMARY KEY(source_id, taxonomy_id)
);

CREATE TABLE fetch_runs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL,
  http_meta jsonb NOT NULL DEFAULT '{}',
  error text,
  item_count integer NOT NULL DEFAULT 0
);

CREATE TABLE content_items (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  content_type text NOT NULL,
  external_id text,
  original_url text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  author text,
  published_at timestamptz,
  updated_at timestamptz,
  language text,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  raw_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, content_hash)
);
CREATE INDEX content_items_title_trgm ON content_items USING gin (title gin_trgm_ops);

CREATE TABLE events (
  id uuid PRIMARY KEY,
  canonical_title text NOT NULL,
  summary text NOT NULL,
  importance text NOT NULL,
  primary_topic text,
  event_type text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'published',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_title_trgm ON events USING gin (canonical_title gin_trgm_ops);

CREATE TABLE event_evidence (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  role text NOT NULL DEFAULT 'supporting',
  independence_group text,
  is_official boolean NOT NULL DEFAULT false,
  claim_scope jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY(event_id, content_item_id)
);

CREATE TABLE event_tags (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  taxonomy_id text NOT NULL REFERENCES taxonomy_nodes(id),
  confidence real NOT NULL,
  origin text NOT NULL,
  PRIMARY KEY(event_id, taxonomy_id)
);

CREATE TABLE score_snapshots (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  components jsonb NOT NULL,
  total real NOT NULL,
  rule_version text NOT NULL,
  explanation text NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interest_profiles (
  user_id text PRIMARY KEY,
  profile jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_event_states (
  user_id text NOT NULL,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  read_at timestamptz,
  saved_at timestamptz,
  later_at timestamptz,
  PRIMARY KEY(user_id, event_id)
);

CREATE TABLE knowledge_nodes (
  id uuid PRIMARY KEY,
  node_type text NOT NULL,
  ref_id text,
  canonical_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE knowledge_edges (
  id uuid PRIMARY KEY,
  from_node_id uuid NOT NULL REFERENCES knowledge_nodes(id),
  to_node_id uuid NOT NULL REFERENCES knowledge_nodes(id),
  relation_type text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]',
  confidence real NOT NULL,
  origin text NOT NULL,
  rule_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_briefs (
  id uuid PRIMARY KEY,
  local_date date UNIQUE NOT NULL,
  status text NOT NULL,
  generated_at timestamptz NOT NULL,
  published_at timestamptz,
  rule_version text NOT NULL
);

CREATE TABLE daily_brief_items (
  brief_id uuid NOT NULL REFERENCES daily_briefs(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id),
  rank integer NOT NULL,
  section text NOT NULL,
  selection_reason text NOT NULL,
  PRIMARY KEY(brief_id, event_id),
  UNIQUE(brief_id, rank)
);

CREATE TABLE admin_audits (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
