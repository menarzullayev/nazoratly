-- 0052_branch_backfill (up)
-- Why: give every row that existed before the branch mark its branch. Rows written after 0051 are already stamped by the
--   trigger, so this only touches rows WHERE branch_id IS NULL and can be re-run safely.
-- Rules (the same chain the stamping trigger follows, so old and new data agree):
--   groups/expenses without a branch -> the center's default branch (logged, so the down migration can undo it)
--   students  -> the branch of the group of his newest live enrollment, else the default branch
--   teachers  -> the branch of his newest group, else the default branch;  guardians -> the branch of the first student
--   everything else follows its parent (enrollment -> group, charge -> enrollment, journal entry -> its source, ...)
-- The user triggers of the touched tables (audit, guards, the append-only journal) are switched off for the duration of
--   this transaction only: a backfill is not a business change and must not write audit rows or trip a guard. Each ALTER
--   takes a short SHARE ROW EXCLUSIVE lock held until this migration commits; the data of a single center is small, so
--   this is milliseconds. For a very large install run the UPDATEs below by hand in batches before applying.

DO $$
DECLARE
  c record;
  pb text;
BEGIN
  FOR c IN SELECT table_name FROM branch_catalog WHERE kind IN ('strict','nullable') LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', c.table_name);
  END LOOP;

  -- groups and expenses had an optional branch before: log what we fill
  INSERT INTO branch_migration_log (table_name, row_id) SELECT 'study_groups', id FROM study_groups WHERE branch_id IS NULL ON CONFLICT DO NOTHING;
  UPDATE study_groups SET branch_id = default_branch_id(org_id) WHERE branch_id IS NULL;
  INSERT INTO branch_migration_log (table_name, row_id) SELECT 'expenses', id FROM expenses WHERE branch_id IS NULL ON CONFLICT DO NOTHING;
  UPDATE expenses SET branch_id = default_branch_id(org_id) WHERE branch_id IS NULL;

  UPDATE students s SET branch_id = COALESCE(
      (SELECT g.branch_id FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id
        WHERE e.org_id = s.org_id AND e.student_id = s.id AND e.status IN ('trial','active','frozen')
        ORDER BY e.id DESC LIMIT 1),
      default_branch_id(s.org_id))
    WHERE s.branch_id IS NULL;
  UPDATE teachers t SET branch_id = COALESCE(
      (SELECT g.branch_id FROM study_groups g WHERE g.org_id = t.org_id AND g.teacher_id = t.id AND g.deleted_at IS NULL
        ORDER BY g.id DESC LIMIT 1),
      default_branch_id(t.org_id))
    WHERE t.branch_id IS NULL;
  UPDATE guardians gd SET branch_id = COALESCE(
      (SELECT s.branch_id FROM student_guardians sg JOIN students s ON s.org_id = sg.org_id AND s.id = sg.student_id
        WHERE sg.org_id = gd.org_id AND sg.guardian_id = gd.id ORDER BY sg.is_primary DESC, sg.id LIMIT 1),
      default_branch_id(gd.org_id))
    WHERE gd.branch_id IS NULL;

  -- the ledger: an entry belongs to the branch of its source row; a reversal to the entry it reverses
  -- (order matters: payments, expenses, ... are filled by the generic loop below, so run the journal last)
  FOR c IN SELECT * FROM branch_catalog
           WHERE kind = 'strict' AND table_name NOT IN ('students','teachers','guardians','study_groups','rooms','expenses','journal_entries')
             AND table_name <> 'journal_lines'
           ORDER BY ord, table_name LOOP
    pb := 'NULL::bigint';
    IF c.p1_table IS NOT NULL THEN
      pb := format('(SELECT p.branch_id FROM %I p WHERE p.id = t.%I)', c.p1_table, c.p1_col);
    END IF;
    IF c.p2_table IS NOT NULL THEN
      pb := format('COALESCE(%s, (SELECT p.branch_id FROM %I p WHERE p.id = t.%I))', pb, c.p2_table, c.p2_col);
    END IF;
    EXECUTE format('UPDATE %I t SET branch_id = COALESCE(%s, default_branch_id(t.org_id)) WHERE t.branch_id IS NULL', c.table_name, pb);
  END LOOP;

  UPDATE journal_entries e SET branch_id = COALESCE(
      CASE e.source_type
        WHEN 'payment'         THEN (SELECT p.branch_id FROM payments p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
        WHEN 'expense'         THEN (SELECT p.branch_id FROM expenses p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
        WHEN 'refund'          THEN (SELECT p.branch_id FROM refunds p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
        WHEN 'cash_close'      THEN (SELECT p.branch_id FROM cash_closes p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
        WHEN 'bill_payment'    THEN (SELECT p.branch_id FROM bill_payments p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
        WHEN 'payroll_accrual' THEN (SELECT p.branch_id FROM teacher_payrolls p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
        WHEN 'payroll_payment' THEN (SELECT p.branch_id FROM teacher_payrolls p WHERE p.id::text = e.source_key AND p.org_id = e.org_id)
      END,
      (SELECT r.branch_id FROM journal_entries r WHERE r.id = e.reverses_entry_id),
      default_branch_id(e.org_id))
    WHERE e.branch_id IS NULL AND e.reverses_entry_id IS NULL;
  -- reversals and voids (they follow the entry they reverse; that entry was filled just above)
  UPDATE journal_entries e SET branch_id = COALESCE(
      (SELECT r.branch_id FROM journal_entries r WHERE r.id = e.reverses_entry_id), default_branch_id(e.org_id))
    WHERE e.branch_id IS NULL;
  UPDATE journal_lines l SET branch_id = COALESCE(
      (SELECT e.branch_id FROM journal_entries e WHERE e.id = l.entry_id), default_branch_id(l.org_id))
    WHERE l.branch_id IS NULL;

  FOR c IN SELECT table_name FROM branch_catalog WHERE kind IN ('strict','nullable') LOOP
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', c.table_name);
  END LOOP;
END $$;
