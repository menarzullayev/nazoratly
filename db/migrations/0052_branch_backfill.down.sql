-- 0052_branch_backfill (down)
-- Undo only what the up migration filled in tables that had an optional branch before (groups, expenses); the new
-- columns of every other table are dropped by 0051.
ALTER TABLE study_groups DISABLE TRIGGER USER;
ALTER TABLE expenses DISABLE TRIGGER USER;
UPDATE study_groups SET branch_id = NULL WHERE id IN (SELECT row_id FROM branch_migration_log WHERE table_name = 'study_groups');
UPDATE expenses SET branch_id = NULL WHERE id IN (SELECT row_id FROM branch_migration_log WHERE table_name = 'expenses');
ALTER TABLE study_groups ENABLE TRIGGER USER;
ALTER TABLE expenses ENABLE TRIGGER USER;
DELETE FROM branch_migration_log WHERE table_name IN ('study_groups', 'expenses');
