-- 0062_guardian_requests (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM guardian_requests) THEN
    RAISE EXCEPTION 'cannot roll back 0062: guardian requests exist';
  END IF;
END $$;
DELETE FROM branch_catalog WHERE table_name = 'guardian_requests';
DROP TABLE guardian_requests;
