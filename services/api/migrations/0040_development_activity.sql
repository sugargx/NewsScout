-- Classify the tag, not its appended commit description. Existing data and
-- summary leases remain untouched; automatic workers skip these records.
-- Keep a single inlineable expression: this predicate is used inside ranking.
CREATE OR REPLACE FUNCTION reader_is_opaque_engineering_release(event_type text, title text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT event_type='release' AND (
   lower(btrim(split_part(title,':',1))) ~ '^[0-9a-f]{12,64}$'
   OR lower(btrim(split_part(title,':',1))) ~ '^([a-z0-9]+[-_])*(handoff|runtime|build|ci|nightly)([-_][a-z0-9]+)*[-_][0-9a-f]{12,64}$'
   OR lower(btrim(split_part(title,':',1))) ~ '^(handoff|runtime|build|ci|nightly)[-_][0-9]{5,}$'
   OR lower(btrim(split_part(title,':',1))) ~ '^(viable|strict|main|master|trunk|dev|ci|ciflow)(/[a-z0-9._-]+)*/([0-9]{6,}|[0-9a-f]{12,64})$'
   OR lower(btrim(split_part(title,':',1))) ~ '^[a-z]{1,3}[0-9]{4,}$'
   OR lower(btrim(title)) ~ '^(nightly|last[-_.]green|canary)([-_: ]|$)'
 )
$$;
