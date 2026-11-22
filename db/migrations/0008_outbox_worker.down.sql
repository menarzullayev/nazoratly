-- 0008_outbox_worker (down)
DROP FUNCTION IF EXISTS outbox_complete(bigint, boolean, text, integer, boolean);
DROP FUNCTION IF EXISTS outbox_claim(integer);
REVOKE USAGE ON SCHEMA public FROM nazoratly_worker;
DO $$ BEGIN
  DROP ROLE IF EXISTS nazoratly_worker;
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'role nazoratly_worker is still used by another database of this cluster; kept';
END $$;
