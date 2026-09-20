INSERT INTO app_settings(key,value) VALUES('reader_settings','{"mode":"daily","hour":6}')
ON CONFLICT(key) DO NOTHING;
CREATE TABLE morning_runs (
  local_date date PRIMARY KEY,
  status text NOT NULL CHECK(status IN ('collecting','summarizing','ready','partial','failed')),
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  window_end timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  lease_until timestamptz,
  source_succeeded integer NOT NULL DEFAULT 0,
  source_failed integer NOT NULL DEFAULT 0,
  message text
);
