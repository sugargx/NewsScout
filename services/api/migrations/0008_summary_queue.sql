INSERT INTO app_settings(key,value) VALUES
('summary_settings','{"enabled":true,"model":"gpt-5.6-terra","dailyLimit":20}')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE summary_jobs (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  content_version bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  model text,
  last_error text,
  next_attempt_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX summary_jobs_ready ON summary_jobs(status,next_attempt_at);

CREATE FUNCTION maintain_summary_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.summary_kind='feed' AND NEW.status='published' THEN
    INSERT INTO summary_jobs(event_id,content_version,status,next_attempt_at)
      VALUES(NEW.id,NEW.content_version,'pending',now())
    ON CONFLICT(event_id) DO UPDATE SET
      content_version=EXCLUDED.content_version,status='pending',attempts=0,
      model=NULL,last_error=NULL,next_attempt_at=now(),lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE summary_jobs.content_version<>EXCLUDED.content_version OR summary_jobs.status='completed';
  ELSIF NEW.summary_kind='copilot' THEN
    UPDATE summary_jobs SET status='completed',model=NEW.summary_model,last_error=NULL,
      attempts=attempts+CASE WHEN status='running' THEN 0 ELSE 1 END,
      next_attempt_at=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE event_id=NEW.id AND content_version=NEW.content_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_summary_queue AFTER INSERT OR UPDATE OF summary_kind,content_version,status ON events
  FOR EACH ROW EXECUTE FUNCTION maintain_summary_job();

INSERT INTO summary_jobs(event_id,content_version,status,next_attempt_at)
  SELECT id,content_version,'pending',now() FROM events WHERE status='published' AND summary_kind='feed';
