-- Bound reader coverage discovery by publication time before event RLS and
-- full evidence hydration. event_evidence_content supplies the reverse lookup.
CREATE INDEX content_items_reader_published
ON content_items(published_at,id)
WHERE published_at IS NOT NULL;
