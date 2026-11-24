-- 0054_branch_rls (up)
-- Why: separation by branch, enforced by the database. Staff of one branch (memberships.branch_id set) work in a session
--   whose app.branch_id is that branch (the API sets it; center-wide staff may narrow it to look at one branch). A
--   RESTRICTIVE policy on every marked table is ANDed with the tenant policy, so every query of that session - lists,
--   reports, cash balance, the ledger - sees and writes only its branch, whatever the endpoint. NULL = center-wide.
--   Shared rows (branch_id NULL on the 'nullable' tables) stay visible to every branch.
-- Also here: the ledger checks become SECURITY DEFINER (the hash chain is verified over the whole ledger even while a
--   branch session writes), ledger_head() for the same reason, and guards that keep a branch mark from drifting:
--   money rows never change branch, a student changes branch only through the transfer, a group or room that is in
--   use cannot move.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM branch_catalog WHERE kind IN ('strict','nullable') AND table_name NOT IN ('guardians','audit_log','students') LOOP
    IF c.kind = 'strict' THEN
      EXECUTE format($p$CREATE POLICY branch_scope ON %I AS RESTRICTIVE FOR ALL TO nazoratly_app
        USING (app_branch_id() IS NULL OR branch_id = app_branch_id())
        WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id())$p$, c.table_name);
    ELSE
      EXECUTE format($p$CREATE POLICY branch_scope ON %I AS RESTRICTIVE FOR ALL TO nazoratly_app
        USING (app_branch_id() IS NULL OR branch_id IS NULL OR branch_id = app_branch_id())
        WITH CHECK (app_branch_id() IS NULL OR branch_id IS NULL OR branch_id = app_branch_id())$p$, c.table_name);
    END IF;
  END LOOP;
END $$;

-- a student stays READABLE (not writable) for the branch he moved away from: its payments, attendance and history there
-- keep their meaning. Writing needs the row to be in the session's branch (WITH CHECK), which a moved student is not.
CREATE POLICY branch_scope ON students AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id()
         OR EXISTS (SELECT 1 FROM student_branch_moves m WHERE m.org_id = students.org_id AND m.student_id = students.id
                      AND m.from_branch_id = app_branch_id()))
  WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id());

-- a guardian is visible in his own branch and in every branch where one of his children studies
CREATE POLICY branch_scope ON guardians AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id()
         OR EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.org_id = guardians.org_id AND sg.guardian_id = guardians.id))
  WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id());

-- the audit trail: staff of a branch read the entries of their branch only (the app has no write access to it)
CREATE POLICY branch_scope ON audit_log AS RESTRICTIVE FOR SELECT TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id());

-- branches: staff of a branch see only their own branch and cannot create or change branches
CREATE POLICY branch_scope ON branches AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR id = app_branch_id())
  WITH CHECK (app_branch_id() IS NULL);

-- staff: a branch sees its own staff (and the person's own membership), and can only add staff to its own branch
CREATE POLICY branch_scope ON memberships AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id() OR user_id = app_user_id())
  WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id());

CREATE POLICY branch_scope ON branch_settings AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id())
  WITH CHECK (app_branch_id() IS NULL OR branch_id = app_branch_id());
CREATE POLICY branch_scope ON branch_course_prices AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id())
  WITH CHECK (app_branch_id() IS NULL);
-- the move history is visible to the branch left and the branch joined; only center-wide staff write it
CREATE POLICY branch_scope ON student_branch_moves AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_branch_id() IS NULL OR branch_id = app_branch_id() OR from_branch_id = app_branch_id())
  WITH CHECK (app_branch_id() IS NULL);

-- Ledger: the checking triggers read the whole chain (previous line, last entry number, period totals). They must not
-- be narrowed by the session's branch, so they run with the rights of the owner. Same body, same errors.
ALTER FUNCTION check_journal_entry() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION check_journal_line() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION check_entry_complete() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION check_accounting_period() SECURITY DEFINER SET search_path = public, pg_temp;

CREATE FUNCTION ledger_head(p_org bigint) RETURNS TABLE (seq bigint, entry_no bigint, hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.seq, e.entry_no, l.hash FROM journal_lines l JOIN journal_entries e ON e.org_id = l.org_id AND e.id = l.entry_id
  WHERE l.org_id = p_org AND p_org = app_org_id() ORDER BY l.seq DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION ledger_head(bigint) TO nazoratly_app;

-- Guards -------------------------------------------------------------------------------------------------------
CREATE FUNCTION forbid_branch_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    RAISE EXCEPTION 'the branch of a % row cannot change', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments','payment_allocations','charges','charge_installments','discount_lines','expenses',
        'refunds','refund_payments','cash_closes','supplier_bills','bill_payments','teacher_payrolls','payroll_items',
        'lead_source_costs','lesson_packages'] LOOP
    EXECUTE format('CREATE TRIGGER trg_branch_frozen BEFORE UPDATE OF branch_id ON %I FOR EACH ROW EXECUTE FUNCTION forbid_branch_change()', t);
  END LOOP;
END $$;

-- a student changes branch only through the transfer (the API sets app.branch_move = 'on' for that statement)
CREATE FUNCTION guard_student_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND COALESCE(current_setting('app.branch_move', true), '') <> 'on' THEN
    RAISE EXCEPTION 'a student changes branch only through the transfer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_students_branch_guard BEFORE UPDATE OF branch_id ON students
  FOR EACH ROW EXECUTE FUNCTION guard_student_branch();

-- a group with enrollments or lessons, or a room that is in use, cannot move to another branch
CREATE FUNCTION guard_group_branch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND (
       EXISTS (SELECT 1 FROM enrollments WHERE group_id = NEW.id) OR EXISTS (SELECT 1 FROM lessons WHERE group_id = NEW.id)
       OR EXISTS (SELECT 1 FROM group_schedules WHERE group_id = NEW.id)) THEN
    RAISE EXCEPTION 'a group with enrollments or lessons cannot move to another branch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_study_groups_branch_guard BEFORE UPDATE OF branch_id ON study_groups
  FOR EACH ROW EXECUTE FUNCTION guard_group_branch();
CREATE FUNCTION guard_room_branch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND (
       EXISTS (SELECT 1 FROM group_schedules WHERE room_id = NEW.id) OR EXISTS (SELECT 1 FROM lessons WHERE room_id = NEW.id)) THEN
    RAISE EXCEPTION 'a room that is in use cannot move to another branch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rooms_branch_guard BEFORE UPDATE OF branch_id ON rooms
  FOR EACH ROW EXECUTE FUNCTION guard_room_branch();
