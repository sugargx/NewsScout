ALTER TABLE events ADD COLUMN summary_format_version integer NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN summary_reasoning_effort text;
UPDATE events SET summary_format_version=1 WHERE summary_kind='copilot';
ALTER TABLE summary_jobs ADD COLUMN format_version integer NOT NULL DEFAULT 2;

CREATE OR REPLACE FUNCTION maintain_summary_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='published' AND (NEW.summary_kind='feed' OR NEW.summary_format_version<2) THEN
    INSERT INTO summary_jobs(event_id,content_version,format_version,status,next_attempt_at)
      VALUES(NEW.id,NEW.content_version,2,'pending',now())
    ON CONFLICT(event_id) DO UPDATE SET
      content_version=EXCLUDED.content_version,format_version=2,status='pending',attempts=0,
      model=NULL,last_error=NULL,next_attempt_at=now(),lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE summary_jobs.content_version<>EXCLUDED.content_version
       OR summary_jobs.format_version<>2 OR summary_jobs.status='completed';
  ELSIF NEW.summary_kind='copilot' AND NEW.summary_format_version>=2 THEN
    UPDATE summary_jobs SET status='completed',model=NEW.summary_model,last_error=NULL,
      format_version=NEW.summary_format_version,
      attempts=attempts+CASE WHEN status='running' THEN 0 ELSE 1 END,
      next_attempt_at=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE event_id=NEW.id AND content_version=NEW.content_version;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER events_summary_queue ON events;
CREATE TRIGGER events_summary_queue AFTER INSERT OR UPDATE OF summary_kind,content_version,status,summary_format_version ON events
  FOR EACH ROW EXECUTE FUNCTION maintain_summary_job();

INSERT INTO summary_jobs(event_id,content_version,format_version,status,next_attempt_at)
SELECT id,content_version,2,'pending',now() FROM events WHERE status='published' AND summary_format_version<2
ON CONFLICT(event_id) DO UPDATE SET format_version=2,status='pending',attempts=0,
  next_attempt_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL,updated_at=now();
