-- 0050_branches_core (down)
DROP TABLE student_branch_moves;
DROP TABLE branch_course_prices;
DROP TABLE branch_settings;
DROP TABLE branch_catalog;

DROP TRIGGER trg_branches_default_check ON branches;
DROP FUNCTION check_default_branch();
DROP TRIGGER trg_organizations_default_branch ON organizations;
DROP FUNCTION create_default_branch();
DROP FUNCTION default_branch_id(bigint);
DROP FUNCTION app_branch_id();

-- remove the default branches this migration created, unless something now refers to them (then they stay)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT row_id FROM branch_migration_log WHERE table_name = 'branches' LOOP
    BEGIN
      DELETE FROM branches WHERE id = r.row_id;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END LOOP;
END $$;
DROP TABLE branch_migration_log;
DROP INDEX branches_one_default;
ALTER TABLE branches DROP COLUMN is_default;
