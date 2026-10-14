-- Daily selection has a source gate independent of its quality/interest score.
-- Related coverage cannot make a T2 article eligible as the selected article.
CREATE FUNCTION reader_daily_source_eligible(event_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(bool_and(s.tier IN ('T1','T1.5')),false)
 FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
 JOIN sources s ON s.id=ci.source_id WHERE ee.event_id=$1
$$;

ALTER TABLE events ADD COLUMN summary_visual jsonb
  CHECK (summary_visual IS NULL OR jsonb_typeof(summary_visual)='object');
ALTER TABLE summary_jobs ALTER COLUMN format_version SET DEFAULT 4;

CREATE OR REPLACE FUNCTION maintain_summary_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='published' AND (NEW.summary_kind='feed' OR NEW.summary_format_version<4) THEN
    INSERT INTO summary_jobs(event_id,content_version,format_version,status,next_attempt_at)
      VALUES(NEW.id,NEW.content_version,4,'pending',now())
    ON CONFLICT(event_id) DO UPDATE SET
      content_version=EXCLUDED.content_version,format_version=4,status='pending',attempts=0,
      model=NULL,last_error=NULL,next_attempt_at=now(),lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE summary_jobs.content_version<>EXCLUDED.content_version
       OR summary_jobs.format_version<>4 OR summary_jobs.status='completed';
  ELSIF NEW.summary_kind='copilot' AND NEW.summary_format_version>=4 THEN
    UPDATE summary_jobs SET status='completed',model=NEW.summary_model,last_error=NULL,
      format_version=NEW.summary_format_version,
      attempts=attempts+CASE WHEN status='running' THEN 0 ELSE 1 END,
      next_attempt_at=NULL,lease_id=NULL,lease_until=NULL,updated_at=now()
    WHERE event_id=NEW.id AND content_version=NEW.content_version;
  END IF;
  RETURN NEW;
END $$;

-- Move unfinished work to the new contract; do not resume failures automatically.
UPDATE summary_jobs SET format_version=4,updated_at=now()
WHERE format_version<4 AND status IN ('pending','failed','running');

-- A one-time, bounded upgrade, prioritising articles in the current saved edition.
-- Keep existing summaries readable and do not rewrite saved editions or interests.
WITH recent AS (
 SELECT e.id,e.content_version,
   EXISTS(SELECT 1 FROM daily_brief_items bi JOIN daily_briefs b ON b.id=bi.brief_id
     WHERE bi.event_id=e.id AND b.status='published'
       AND b.local_date=(now() AT TIME ZONE 'Asia/Shanghai')::date) AS selected,
   max(ci.published_at) AS published_at
 FROM events e JOIN event_evidence ee ON ee.event_id=e.id
 JOIN content_items ci ON ci.id=ee.content_item_id
 WHERE e.status='published' AND e.summary_kind='copilot' AND e.summary_format_version<4
   AND ci.published_at BETWEEN now()-interval '7 days' AND now()
   AND NOT EXISTS(SELECT 1 FROM summary_jobs j WHERE j.event_id=e.id AND j.status='failed')
 GROUP BY e.id
 ORDER BY selected DESC,published_at DESC,e.id LIMIT 100
)
INSERT INTO summary_jobs(event_id,content_version,format_version,status,next_attempt_at)
SELECT id,content_version,4,'pending',now() FROM recent
ON CONFLICT(event_id) DO UPDATE SET format_version=4,content_version=EXCLUDED.content_version,
  status='pending',attempts=0,next_attempt_at=now(),lease_id=NULL,lease_until=NULL,
  model=NULL,last_error=NULL,updated_at=now()
WHERE summary_jobs.status<>'running';
