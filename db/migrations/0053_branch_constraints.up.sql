-- 0053_branch_constraints (up)
-- Why: after the backfill every strict table must have its branch mark for good, and every mark must point at a real
--   branch of the same center. Done without long locks: the NOT NULL rule is first added as a CHECK ... NOT VALID (no
--   scan, no lock beyond a catalog change), then VALIDATEd (a scan that only takes a SHARE UPDATE EXCLUSIVE lock, so
--   reads and writes continue), and only then promoted to NOT NULL, which PostgreSQL 12+ does without another scan.
--   The foreign keys added NOT VALID in 0051 are validated the same way. The lookup indexes are plain CREATE INDEX
--   (the tables of one center are small); on a very large install create them CONCURRENTLY beforehand.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM branch_catalog WHERE kind IN ('strict','nullable') ORDER BY ord, table_name LOOP
    IF c.kind = 'strict' AND NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid = c.table_name::regclass AND attname = 'branch_id') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (branch_id IS NOT NULL) NOT VALID', c.table_name, c.table_name || '_branch_nn');
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.table_name, c.table_name || '_branch_nn');
      EXECUTE format('ALTER TABLE %I ALTER COLUMN branch_id SET NOT NULL', c.table_name);
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.table_name, c.table_name || '_branch_nn');
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.table_name, c.table_name || '_branch_fk');
    EXECUTE format('CREATE INDEX %I ON %I (org_id, branch_id)', c.table_name || '_org_branch', c.table_name);
  END LOOP;
END $$;
