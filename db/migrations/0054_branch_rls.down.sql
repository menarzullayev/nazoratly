-- 0054_branch_rls (down)
DROP TRIGGER trg_rooms_branch_guard ON rooms;
DROP FUNCTION guard_room_branch();
DROP TRIGGER trg_study_groups_branch_guard ON study_groups;
DROP FUNCTION guard_group_branch();
DROP TRIGGER trg_students_branch_guard ON students;
DROP FUNCTION guard_student_branch();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments','payment_allocations','charges','charge_installments','discount_lines','expenses',
        'refunds','refund_payments','cash_closes','supplier_bills','bill_payments','teacher_payrolls','payroll_items',
        'lead_source_costs','lesson_packages'] LOOP
    EXECUTE format('DROP TRIGGER trg_branch_frozen ON %I', t);
  END LOOP;
END $$;
DROP FUNCTION forbid_branch_change();

DROP FUNCTION ledger_head(bigint);
ALTER FUNCTION check_accounting_period() SECURITY INVOKER RESET search_path;
ALTER FUNCTION check_entry_complete() SECURITY INVOKER RESET search_path;
ALTER FUNCTION check_journal_line() SECURITY INVOKER RESET search_path;
ALTER FUNCTION check_journal_entry() SECURITY INVOKER RESET search_path;

DROP POLICY branch_scope ON student_branch_moves;
DROP POLICY branch_scope ON branch_course_prices;
DROP POLICY branch_scope ON branch_settings;
DROP POLICY branch_scope ON memberships;
DROP POLICY branch_scope ON branches;
DROP POLICY branch_scope ON audit_log;
DROP POLICY branch_scope ON guardians;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT table_name FROM branch_catalog WHERE kind IN ('strict','nullable') AND table_name NOT IN ('guardians','audit_log') LOOP
    EXECUTE format('DROP POLICY branch_scope ON %I', c.table_name);
  END LOOP;
END $$;
