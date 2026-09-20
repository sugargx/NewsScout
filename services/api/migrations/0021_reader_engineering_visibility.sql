-- Opaque CI/build artifacts remain searchable by explicit opt-in, but are not reader news.
CREATE OR REPLACE FUNCTION reader_is_opaque_engineering_release(event_type text, title text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT event_type='release' AND (
    lower(trim(title)) ~ '^[0-9a-f]{12,64}$'
    OR lower(trim(title)) ~ '^([a-z0-9]+[-_])*(handoff|runtime|build|ci|nightly)([-_][a-z0-9]+)*[-_][0-9a-f]{12,64}$'
    OR lower(trim(title)) ~ '^(handoff|runtime|build|ci|nightly)[-_][0-9]{5,}$'
  )
$$;
