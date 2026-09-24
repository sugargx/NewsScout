-- Applied migrations are immutable. The application switches role and actor
-- only with SET LOCAL inside a transaction, including when the owner is admin.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='scoutnews_reader') THEN
    CREATE ROLE scoutnews_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='scoutnews_reader'
             AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole)) THEN
    RAISE EXCEPTION 'scoutnews_reader must be an unprivileged NOLOGIN role';
  END IF;
  EXECUTE format('GRANT scoutnews_reader TO %I',current_user);
END $$;

CREATE FUNCTION scoutnews_actor() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('scoutnews.actor',true),''),'local')
$$;
CREATE TABLE app_users(
 id uuid PRIMARY KEY,
 issuer text NOT NULL,
 subject text NOT NULL,
 display_name text NOT NULL,
 telemetry_consent boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(issuer,subject)
);
INSERT INTO app_users(id,issuer,subject,display_name)
 VALUES('00000000-0000-0000-0000-000000000001','local','local','Local reader');
ALTER TABLE sources ADD COLUMN owner_user_id text;
-- Previously user-added subscriptions were identified by their explicit audit.
UPDATE sources s SET owner_user_id='local'
 WHERE EXISTS(SELECT FROM admin_audits a WHERE a.action='source_create' AND a.target_id=s.id::text);
ALTER TABLE sources DROP CONSTRAINT sources_adapter_type_endpoint_key;
ALTER TABLE sources ADD CONSTRAINT sources_owner_adapter_endpoint_key
 UNIQUE NULLS NOT DISTINCT(owner_user_id,adapter_type,endpoint);
CREATE INDEX sources_owner ON sources(owner_user_id,id);
CREATE TABLE user_source_overrides(
 user_id text NOT NULL DEFAULT scoutnews_actor(),
 source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 enabled boolean,
 confirmed boolean,
 schedule_minutes integer CHECK(schedule_minutes BETWEEN 5 AND 10080),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,source_id)
);
ALTER TABLE taxonomy_nodes ADD COLUMN owner_user_id text;
UPDATE taxonomy_nodes SET owner_user_id='local' WHERE id LIKE 'custom-%';
ALTER TABLE events ADD COLUMN owner_user_id text;
ALTER TABLE content_items ADD COLUMN owner_user_id text;
UPDATE content_items c SET owner_user_id=s.owner_user_id FROM sources s WHERE c.source_id=s.id;
-- Do not expose legacy mixed summaries: quarantine any event with private
-- evidence as local, preserving its existing snapshots and identifiers.
UPDATE events e SET owner_user_id='local' WHERE EXISTS(
 SELECT FROM event_evidence ee JOIN content_items c ON c.id=ee.content_item_id
 WHERE ee.event_id=e.id AND c.owner_user_id='local');
CREATE INDEX events_owner ON events(owner_user_id,id);
CREATE INDEX content_items_owner ON content_items(owner_user_id,id);
ALTER TABLE daily_briefs ADD COLUMN owner_user_id text NOT NULL DEFAULT scoutnews_actor();
ALTER TABLE daily_briefs DROP CONSTRAINT daily_briefs_local_date_key;
ALTER TABLE daily_briefs ADD UNIQUE(owner_user_id,local_date);
ALTER TABLE morning_runs ADD COLUMN owner_user_id text NOT NULL DEFAULT scoutnews_actor();
ALTER TABLE morning_runs DROP CONSTRAINT morning_runs_pkey;
ALTER TABLE morning_runs ADD PRIMARY KEY(owner_user_id,local_date);
ALTER TABLE reader_shares ADD COLUMN owner_user_id text NOT NULL DEFAULT scoutnews_actor();
ALTER TABLE reader_shares ADD COLUMN published_document jsonb;
UPDATE reader_shares SET published_document=document WHERE published;
CREATE INDEX reader_shares_owner ON reader_shares(owner_user_id,created_at DESC);

CREATE TABLE ingestion_runs(
 id uuid PRIMARY KEY, user_id text NOT NULL DEFAULT scoutnews_actor(),
 source_ids uuid[] NOT NULL CHECK(cardinality(source_ids) BETWEEN 1 AND 100),
 status text NOT NULL CHECK(status IN('pending','running','succeeded','failed')),
 completed integer NOT NULL DEFAULT 0, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
 finished_at timestamptz, lease_until timestamptz, lease_id uuid,
 error_code text, event_id uuid REFERENCES events(id)
);
CREATE TABLE ingestion_source_claims(
 source_id uuid PRIMARY KEY REFERENCES sources(id), last_submitted_at timestamptz NOT NULL
);
ALTER TABLE ingestion_source_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY reader_source ON ingestion_source_claims TO scoutnews_reader
 USING(EXISTS(SELECT FROM sources s WHERE s.id=source_id))
 WITH CHECK(EXISTS(SELECT FROM sources s WHERE s.id=source_id));
CREATE INDEX ingestion_runs_owner ON ingestion_runs(user_id,created_at DESC);
CREATE UNIQUE INDEX ingestion_runs_active ON ingestion_runs(user_id)
 WHERE status IN('pending','running');
CREATE TABLE reader_rate_limits(
 user_id text NOT NULL, operation text NOT NULL, bucket timestamptz NOT NULL,
 count integer NOT NULL, PRIMARY KEY(user_id,operation,bucket)
);
CREATE TABLE reader_telemetry(
 id uuid PRIMARY KEY, user_id text NOT NULL DEFAULT scoutnews_actor(),
 name text NOT NULL CHECK(name IN('page_view','action')),
 page text NOT NULL CHECK(page IN('brief','radar','reading','weekly','saved','topics','sources','shares','share','other')),
 outcome text CHECK(outcome IN('success','failure','cancelled')),
 duration_ms integer CHECK(duration_ms BETWEEN 0 AND 300000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reader_telemetry_retention ON reader_telemetry(created_at);

CREATE FUNCTION scoutnews_source_enabled(source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT FROM sources s LEFT JOIN user_source_overrides o
   ON o.source_id=s.id AND o.user_id=scoutnews_actor()
   WHERE s.id=source AND (s.owner_user_id IS NULL OR s.owner_user_id=scoutnews_actor())
     AND (scoutnews_actor()='local' OR COALESCE(o.enabled,s.lifecycle_status<>'paused')))
$$;
CREATE FUNCTION scoutnews_source_status(source uuid, status text) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN o.enabled=false THEN 'paused' WHEN o.confirmed=true THEN 'stable'
   WHEN o.enabled=true AND status='paused' THEN 'observing' ELSE status END
 FROM (SELECT 1) singleton LEFT JOIN user_source_overrides o
   ON o.source_id=source AND o.user_id=scoutnews_actor()
$$;
CREATE FUNCTION scoutnews_event_visible(event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT FROM events e WHERE e.id=event
   AND (e.owner_user_id IS NULL OR e.owner_user_id=scoutnews_actor())
   AND (NOT EXISTS(SELECT FROM event_evidence ee WHERE ee.event_id=e.id)
     OR EXISTS(SELECT FROM event_evidence ee JOIN content_items c ON c.id=ee.content_item_id
       WHERE ee.event_id=e.id AND (c.owner_user_id IS NULL OR c.owner_user_id=scoutnews_actor())
         AND scoutnews_source_enabled(c.source_id))))
$$;
CREATE FUNCTION scoutnews_content_realm() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT owner_user_id INTO NEW.owner_user_id FROM sources WHERE id=NEW.source_id;
 RETURN NEW;
END $$;
CREATE TRIGGER content_realm BEFORE INSERT OR UPDATE OF source_id,owner_user_id
 ON content_items FOR EACH ROW EXECUTE FUNCTION scoutnews_content_realm();
CREATE FUNCTION scoutnews_evidence_realm() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_owner text; content_owner text;
BEGIN
 SELECT owner_user_id INTO event_owner FROM events WHERE id=NEW.event_id;
 SELECT owner_user_id INTO content_owner FROM content_items WHERE id=NEW.content_item_id;
 IF event_owner IS DISTINCT FROM content_owner THEN
   RAISE EXCEPTION 'evidence must remain in its data realm' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence_realm BEFORE INSERT OR UPDATE ON event_evidence
 FOR EACH ROW EXECUTE FUNCTION scoutnews_evidence_realm();

DO $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['app_users','sources','taxonomy_nodes','events','content_items',
   'source_topics','fetch_runs','content_item_identities','event_evidence','event_tags',
   'score_snapshots','interest_profiles','user_event_states','event_exposures','daily_briefs',
   'daily_brief_items','reader_shares','admin_audits','summary_jobs','user_source_overrides',
   'ingestion_runs','reader_telemetry','reader_rate_limits','knowledge_nodes','knowledge_edges',
   'morning_runs','app_settings'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['interest_profiles','user_event_states','event_exposures',
    'user_source_overrides','ingestion_runs','reader_telemetry','reader_rate_limits'] LOOP
   EXECUTE format('CREATE POLICY reader_owner ON %I TO scoutnews_reader USING(user_id=scoutnews_actor()) WITH CHECK(user_id=scoutnews_actor())',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['daily_briefs','reader_shares'] LOOP
   EXECUTE format('CREATE POLICY reader_owner ON %I TO scoutnews_reader USING(owner_user_id=scoutnews_actor()) WITH CHECK(owner_user_id=scoutnews_actor())',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['source_topics','fetch_runs','content_item_identities'] LOOP
   EXECUTE format('CREATE POLICY reader_source ON %I TO scoutnews_reader USING(EXISTS(SELECT FROM sources s WHERE s.id=source_id)) WITH CHECK(EXISTS(SELECT FROM sources s WHERE s.id=source_id))',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['event_evidence','event_tags','score_snapshots','summary_jobs'] LOOP
   EXECUTE format('CREATE POLICY reader_event ON %I TO scoutnews_reader USING(scoutnews_event_visible(event_id)) WITH CHECK(scoutnews_event_visible(event_id))',tab);
 END LOOP;
END $$;
CREATE POLICY reader_user ON app_users TO scoutnews_reader
 USING(id::text=scoutnews_actor() OR scoutnews_actor()='local' AND id='00000000-0000-0000-0000-000000000001')
 WITH CHECK(id::text=scoutnews_actor() OR scoutnews_actor()='local' AND id='00000000-0000-0000-0000-000000000001');
CREATE POLICY reader_source_read ON sources FOR SELECT TO scoutnews_reader
 USING(owner_user_id IS NULL OR owner_user_id=scoutnews_actor());
CREATE POLICY reader_source_insert ON sources FOR INSERT TO scoutnews_reader
 WITH CHECK(owner_user_id=scoutnews_actor());
CREATE POLICY reader_source_update ON sources FOR UPDATE TO scoutnews_reader
 USING(owner_user_id=scoutnews_actor() OR scoutnews_actor()='local')
 WITH CHECK(owner_user_id=scoutnews_actor() OR scoutnews_actor()='local');
CREATE POLICY reader_taxonomy ON taxonomy_nodes TO scoutnews_reader
 USING(owner_user_id IS NULL OR owner_user_id=scoutnews_actor())
 WITH CHECK(owner_user_id=scoutnews_actor());
CREATE POLICY reader_events ON events TO scoutnews_reader
 USING(scoutnews_event_visible(id))
 WITH CHECK(owner_user_id IS NULL OR owner_user_id=scoutnews_actor());
CREATE POLICY reader_content ON content_items TO scoutnews_reader
 USING((owner_user_id IS NULL OR owner_user_id=scoutnews_actor()) AND scoutnews_source_enabled(source_id))
 WITH CHECK(owner_user_id IS NULL OR owner_user_id=scoutnews_actor());
CREATE POLICY reader_brief_items ON daily_brief_items TO scoutnews_reader
 USING(EXISTS(SELECT FROM daily_briefs b WHERE b.id=brief_id))
 WITH CHECK(EXISTS(SELECT FROM daily_briefs b WHERE b.id=brief_id) AND scoutnews_event_visible(event_id));
CREATE POLICY reader_audit ON admin_audits TO scoutnews_reader
 USING(actor=scoutnews_actor()) WITH CHECK(actor=scoutnews_actor());
CREATE POLICY reader_settings_read ON app_settings FOR SELECT TO scoutnews_reader
 USING(key IN('summary_settings','reader_settings','share_settings') OR scoutnews_actor()='local');
CREATE POLICY reader_settings_write ON app_settings FOR ALL TO scoutnews_reader
 USING(scoutnews_actor()='local') WITH CHECK(scoutnews_actor()='local');
CREATE POLICY reader_morning ON morning_runs TO scoutnews_reader
 USING(owner_user_id=scoutnews_actor()) WITH CHECK(owner_user_id=scoutnews_actor());
-- Graph endpoints derive their scoped graph from visible events, never these
-- old global materializations.
ALTER VIEW event_reading_context SET (security_invoker=true);
ALTER VIEW event_editorial_features SET (security_invoker=true);
ALTER TABLE source_watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY reader_watchlist ON source_watchlist FOR SELECT TO scoutnews_reader
 USING(source_id IS NULL OR EXISTS(SELECT FROM sources s WHERE s.id=source_id));
-- Keep the original material/ranking implementation, changing only the source
-- status expression so confirmation and pause are reader-specific.
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('reader_editorial_features(uuid[])'::regprocedure) INTO definition;
 IF position('s.tier,s.lifecycle_status,' IN definition)=0 THEN
   RAISE EXCEPTION 'editorial source-status expression changed unexpectedly';
 END IF;
 EXECUTE replace(definition,'s.tier,s.lifecycle_status,',
   's.tier,scoutnews_source_status(s.id,s.lifecycle_status) AS lifecycle_status,');
END $$;
GRANT USAGE ON SCHEMA public TO scoutnews_reader;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO scoutnews_reader;
REVOKE ALL ON _sqlx_migrations,source_directory_imports FROM scoutnews_reader;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO scoutnews_reader;
