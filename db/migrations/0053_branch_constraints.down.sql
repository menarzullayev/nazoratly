-- 0053_branch_constraints (down)
-- The two tables that had an optional branch before go back to nullable; the other columns are dropped by 0051.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM branch_catalog WHERE kind IN ('strict','nullable') LOOP
    EXECUTE format('DROP INDEX %I', c.table_name || '_org_branch');
  END LOOP;
END $$;
ALTER TABLE study_groups ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE expenses ALTER COLUMN branch_id DROP NOT NULL;
