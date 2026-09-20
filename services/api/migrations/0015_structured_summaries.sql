ALTER TABLE events ADD COLUMN summary_points jsonb NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN summary_material_limit text;
ALTER TABLE events ADD COLUMN summary_limitations jsonb NOT NULL DEFAULT '[]';
ALTER TABLE summary_jobs ALTER COLUMN format_version SET DEFAULT 3;

CREATE OR REPLACE FUNCTION maintain_summary_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='published' AND (NEW.summary_kind='feed' OR NEW.summary_format_version<3) THEN
    INSERT INTO summary_jobs(event_id,content_version,format_version,status,next_attempt_at)
      VALUES(NEW.id,NEW.content_version,3,'pending',now())
    ON CONFLICT(event_id) DO UPDATE SET
      content_version=EXCLUDED.content_version,format_version=3,status='pending',attempts=0,
      model=NULL,last_error=NULL,next_attempt_at=now(),lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE summary_jobs.content_version<>EXCLUDED.content_version
       OR summary_jobs.format_version<>3 OR summary_jobs.status='completed';
  ELSIF NEW.summary_kind='copilot' AND NEW.summary_format_version>=3 THEN
    UPDATE summary_jobs SET status='completed',model=NEW.summary_model,last_error=NULL,
      format_version=NEW.summary_format_version,
      attempts=attempts+CASE WHEN status='running' THEN 0 ELSE 1 END,
      next_attempt_at=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE event_id=NEW.id AND content_version=NEW.content_version;
  END IF;
  RETURN NEW;
END $$;

-- Existing valid summaries remain readable while recent/saved articles are upgraded.
INSERT INTO summary_jobs(event_id,content_version,format_version,status,next_attempt_at)
SELECT e.id,e.content_version,3,'pending',now() FROM events e
WHERE e.status='published' AND e.summary_format_version<3 AND
  (e.summary_kind='feed'
   OR EXISTS(SELECT 1 FROM summary_jobs j WHERE j.event_id=e.id AND j.status<>'completed')
   OR EXISTS(SELECT 1 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
      WHERE ee.event_id=e.id AND ci.published_at>=now()-interval '30 days')
   OR EXISTS(SELECT 1 FROM user_event_states us WHERE us.event_id=e.id AND us.saved_at IS NOT NULL))
ON CONFLICT(event_id) DO UPDATE SET format_version=3,status='pending',attempts=0,
  next_attempt_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL,updated_at=now();
