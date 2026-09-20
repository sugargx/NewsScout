-- Import time must not turn old Feed articles into today's news.
-- Saved brief JSON remains immutable, as do bookmarks and source evidence.
UPDATE events e
SET first_seen_at=clock.first_publication, updated_at=clock.latest_publication
FROM (
  SELECT ee.event_id,
    LEAST(min(COALESCE(ci.published_at,ci.created_at)),now()) AS first_publication,
    LEAST(max(COALESCE(ci.published_at,ci.created_at)),now()) AS latest_publication
  FROM event_evidence ee JOIN content_items ci ON ci.id=ee.content_item_id
  GROUP BY ee.event_id
) clock
WHERE clock.event_id=e.id;
