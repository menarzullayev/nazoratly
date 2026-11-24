-- 0055_branch_rules (up)
-- Why: rules that only make sense once rows carry a branch.
--   (1) the daily cash close and the monthly lead-source cost are per branch: two branches may close the same day and
--       enter a cost for the same source and month;
--   (2) a live (trial/active/frozen) enrollment joins a student and a group of the SAME branch. A student who moves
--       must first leave the groups of the old branch; the check is in the database so every code path obeys it.

ALTER TABLE cash_closes DROP CONSTRAINT cash_closes_shift_key;
ALTER TABLE cash_closes ADD CONSTRAINT cash_closes_shift_key UNIQUE (org_id, branch_id, close_date, shift_no);

ALTER TABLE lead_source_costs DROP CONSTRAINT lead_source_costs_month_key;
ALTER TABLE lead_source_costs ADD CONSTRAINT lead_source_costs_month_key UNIQUE (org_id, source_id, month, branch_id);

CREATE FUNCTION check_enrollment_branch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  sb BIGINT;
  gb BIGINT;
BEGIN
  IF NEW.status IN ('trial','active','frozen') THEN
    -- a row of another center or a missing parent is the foreign keys' business (they report it), not ours
    SELECT branch_id INTO sb FROM students WHERE id = NEW.student_id AND org_id = NEW.org_id;
    SELECT branch_id INTO gb FROM study_groups WHERE id = NEW.group_id AND org_id = NEW.org_id;
    IF sb IS NOT NULL AND gb IS NOT NULL AND sb <> gb THEN
      RAISE EXCEPTION 'the student and the group belong to different branches' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_enrollments_branch_check BEFORE INSERT OR UPDATE OF status, group_id, student_id ON enrollments
  FOR EACH ROW EXECUTE FUNCTION check_enrollment_branch();
