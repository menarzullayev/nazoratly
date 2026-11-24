-- After rolling back 0055..0050 over the backfilled data: the legacy data is intact, the branch layer is gone.
\set ON_ERROR_STOP on

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM students) = 4 AND (SELECT count(*) FROM payments) = 2 AND (SELECT count(*) FROM journal_lines) = 8, 'business data intact';
  ASSERT (SELECT count(*) FROM branches) = 2, 'the default branch created for center B is gone, the old ones stay';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'branches' AND column_name = 'is_default'), 'is_default is gone';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'branch_id'), 'students lost branch_id again';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'journal_lines' AND column_name = 'branch_id'), 'journal_lines lost branch_id again';
  ASSERT (SELECT branch_id FROM study_groups WHERE id = 1) = 2, 'the explicit group branch stays';
  ASSERT (SELECT branch_id FROM study_groups WHERE id = 2) IS NULL, 'the group that had none has none again';
  ASSERT (SELECT branch_id FROM expenses WHERE description = 'eski xarajat') IS NULL, 'the expense that had none has none again';
  ASSERT (SELECT branch_id FROM expenses WHERE description LIKE 'Chilonzor%') = 2, 'the explicit expense branch stays';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('app_branch_id','default_branch_id','ledger_head','stamp_branch','check_enrollment_branch')), 'helper functions are gone';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'branch_scope'), 'branch policies are gone';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_class WHERE relname IN ('branch_catalog','branch_settings','branch_course_prices','student_branch_moves','branch_migration_log')), 'new tables are gone';
END $$;
