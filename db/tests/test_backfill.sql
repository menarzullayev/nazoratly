-- After 0050-0055 on top of legacy_seed.sql: every old row got the branch it belongs to. Run as a superuser.
\set ON_ERROR_STOP on

DO $$
BEGIN
  -- default branches: center A keeps its oldest live branch, center B (none) got one
  ASSERT (SELECT is_default FROM branches WHERE id = 1) AND NOT (SELECT is_default FROM branches WHERE id = 2), 'center A: the oldest branch is the default';
  ASSERT (SELECT count(*) FROM branches WHERE org_id = 2 AND is_default AND name = 'Asosiy filial') = 1, 'center B got a default branch';
  ASSERT (SELECT count(*) FROM branches) = 3, 'no other branch appeared';

  -- groups: the explicit branch stays, the empty one becomes the default
  ASSERT (SELECT branch_id FROM study_groups WHERE id = 1) = 2, 'explicit group branch kept';
  ASSERT (SELECT branch_id FROM study_groups WHERE id = 2) = 1, 'a group without a branch gets the default';
  -- people follow their live enrollments
  ASSERT (SELECT branch_id FROM students WHERE id = 1) = 2, 'student of a Chilonzor group -> Chilonzor';
  ASSERT (SELECT branch_id FROM students WHERE id = 2) = 1, 'student of the old group -> default';
  ASSERT (SELECT branch_id FROM students WHERE id = 3) = 1, 'student without enrollment -> default';
  ASSERT (SELECT branch_id FROM students WHERE id = 4) = (SELECT id FROM branches WHERE org_id = 2), 'center B student -> its default branch';
  ASSERT (SELECT branch_id FROM teachers WHERE id = 1) = 1, 'teacher follows his newest group (the old one, now in the default branch)';
  ASSERT (SELECT branch_id FROM guardians WHERE id = 1) = 2 AND (SELECT branch_id FROM student_guardians WHERE student_id = 1) = 2, 'guardian and link follow the student';
  -- chains of parents
  ASSERT (SELECT branch_id FROM enrollments WHERE id = 1) = 2 AND (SELECT branch_id FROM enrollments WHERE id = 2) = 1, 'enrollments follow groups';
  ASSERT (SELECT branch_id FROM lessons WHERE id = 1) = 2 AND (SELECT branch_id FROM attendance WHERE lesson_id = 1) = 2, 'lessons and attendance follow the group';
  ASSERT (SELECT branch_id FROM charges WHERE id = 1) = 2 AND (SELECT branch_id FROM charges WHERE id = 2) = 1, 'charges follow enrollments';
  ASSERT (SELECT branch_id FROM payments WHERE id = 1) = 2 AND (SELECT branch_id FROM payments WHERE id = 2) = 1, 'payments follow their students';
  ASSERT (SELECT branch_id FROM expenses WHERE description = 'eski xarajat') = 1 AND (SELECT branch_id FROM expenses WHERE description LIKE 'Chilonzor%') = 2, 'expenses: filled or kept';
  -- the ledger follows the source row; a reversal follows the entry it reverses; lines follow their entry
  ASSERT (SELECT branch_id FROM journal_entries WHERE entry_no = 1) = 2, 'payment entry -> branch of the payment';
  ASSERT (SELECT branch_id FROM journal_entries WHERE entry_no = 2) = 1, 'second payment entry';
  ASSERT (SELECT branch_id FROM journal_entries WHERE entry_no = 3) = 1, 'manual entry -> default';
  ASSERT (SELECT branch_id FROM journal_entries WHERE entry_no = 4) = 2, 'the void follows the entry it reverses';
  ASSERT (SELECT count(*) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.branch_id <> e.branch_id) = 0, 'lines carry the branch of their entry';
  ASSERT (SELECT count(*) FROM journal_lines) = 8, 'no ledger line was lost';
  -- the backfill wrote no audit rows and tripped no guard
  ASSERT (SELECT count(*) FROM audit_log WHERE entity_type = 'students' AND lower(action) = 'update') = 0, 'the backfill is not audited';
  -- nothing is left unmarked
  ASSERT (SELECT count(*) FROM students WHERE branch_id IS NULL) = 0, 'no unmarked student';
  -- the chain still verifies
  ASSERT (SELECT max(seq) FROM journal_lines) = 8, 'chain head';
END $$;
