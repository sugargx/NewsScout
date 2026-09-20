-- Separate stable identity from content fingerprints. Preserve historical rows and evidence.
CREATE TABLE content_item_identities (
  source_id uuid NOT NULL REFERENCES sources(id),
  kind text NOT NULL CHECK (kind IN ('external', 'url')),
  value text NOT NULL,
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  PRIMARY KEY(source_id, kind, value)
);

INSERT INTO content_item_identities(source_id, kind, value, content_item_id)
SELECT DISTINCT ON (source_id, external_id) source_id, 'external', external_id, id
FROM content_items WHERE external_id IS NOT NULL AND external_id <> ''
ORDER BY source_id, external_id, created_at, id
ON CONFLICT DO NOTHING;

INSERT INTO content_item_identities(source_id, kind, value, content_item_id)
SELECT DISTINCT ON (source_id, canonical_url) source_id, 'url', canonical_url, id
FROM content_items
ORDER BY source_id, canonical_url, created_at, id
ON CONFLICT DO NOTHING;

CREATE INDEX content_item_identity_lookup ON content_item_identities(kind, value, content_item_id);
CREATE INDEX content_item_identity_content ON content_item_identities(content_item_id);
CREATE INDEX content_items_source_external ON content_items(source_id, external_id);
CREATE INDEX content_items_canonical_url ON content_items(canonical_url);
CREATE INDEX event_evidence_content ON event_evidence(content_item_id);
