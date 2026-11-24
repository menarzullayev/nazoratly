-- 0023_cash_close (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cash_closes) THEN
    RAISE EXCEPTION 'cannot roll back 0023: cash closes exist (they are part of the books)';
  END IF;
END $$;
DROP TABLE cash_closes;
DROP FUNCTION guard_cash_close_update();
