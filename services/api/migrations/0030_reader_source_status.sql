-- 0029 redefined reader_editorial_features from its 0023 text and so dropped the
-- reader-scoped source status that 0025 patched in: a reader's own confirmation or
-- resume of a source stopped counting towards "confirmed". Reapply exactly that
-- expression. Function-only: no stored material, edition or snapshot changes.
DO $$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('reader_editorial_features(uuid[])'::regprocedure) INTO definition;
 IF position('scoutnews_source_status(' IN definition)>0 THEN
   RETURN;
 END IF;
 IF position('s.tier,s.lifecycle_status,' IN definition)=0 THEN
   RAISE EXCEPTION 'editorial source-status expression changed unexpectedly';
 END IF;
 EXECUTE replace(definition,'s.tier,s.lifecycle_status,',
   's.tier,scoutnews_source_status(s.id,s.lifecycle_status) AS lifecycle_status,');
END $$;
