-- 0051_branch_columns (down)
-- Tables that had a branch_id before this migration keep it (rooms, study_groups, expenses); the rest lose it.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM branch_catalog WHERE kind IN ('strict','nullable') LOOP
    EXECUTE format('DROP TRIGGER trg_0_branch_stamp ON %I', c.table_name);
    EXECUTE format('DROP FUNCTION %I()', 'branch_stamp_' || c.table_name);
    IF c.table_name NOT IN ('rooms', 'study_groups', 'expenses') THEN
      EXECUTE format('ALTER TABLE %I DROP COLUMN branch_id', c.table_name);
    END IF;
  END LOOP;
END $$;
