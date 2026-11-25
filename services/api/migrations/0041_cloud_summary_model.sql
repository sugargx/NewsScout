-- Copilot stopped offering gpt-5.6-terra on 2026-11-17. The owner approved
-- gpt-6.1-terra as its replacement: still low reasoning, same daily limit and
-- enabled state, and never an automatic fallback. Only a saved selection of the
-- withdrawn model moves; any other explicit choice is left unchanged.
UPDATE app_settings
SET value=jsonb_set(value::jsonb,'{model}',to_jsonb('gpt-6.1-terra'::text))::text,updated_at=now()
WHERE key='summary_settings' AND value::jsonb->>'model'='gpt-5.6-terra';
