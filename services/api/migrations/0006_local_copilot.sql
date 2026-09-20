CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (key <> 'copilot_auth_mode' OR value IN ('local', 'oauth', 'disconnected'))
);
INSERT INTO app_settings(key,value) VALUES('copilot_auth_mode','local');
