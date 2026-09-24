-- 0025 quarantined mixed historical events without changing their IDs or
-- snapshots. Public material may remain evidence for those private events;
-- private material must never become evidence for a different owner's event.
CREATE OR REPLACE FUNCTION scoutnews_evidence_realm() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_owner text; content_owner text;
BEGIN
 SELECT owner_user_id INTO event_owner FROM events WHERE id=NEW.event_id;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'event is unavailable' USING ERRCODE='42501';
 END IF;
 SELECT owner_user_id INTO content_owner FROM content_items WHERE id=NEW.content_item_id;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'evidence is unavailable' USING ERRCODE='42501';
 END IF;
 IF content_owner IS NOT NULL AND content_owner IS DISTINCT FROM event_owner THEN
   RAISE EXCEPTION 'private evidence must remain in its data realm' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;

-- Normalize the legacy relationship invariant, not the historical documents:
-- public -> private is valid; any remaining private -> other-owner link needs
-- explicit operator repair rather than silently relabeling or deleting history.
DO $$
BEGIN
 IF EXISTS(
   SELECT FROM event_evidence ee
   JOIN events e ON e.id=ee.event_id
   JOIN content_items c ON c.id=ee.content_item_id
   WHERE c.owner_user_id IS NOT NULL AND c.owner_user_id IS DISTINCT FROM e.owner_user_id
 ) THEN
   RAISE EXCEPTION 'private evidence crosses event ownership';
 END IF;
END $$;
