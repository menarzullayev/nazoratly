-- 0055_branch_rules (down)
-- Note: restoring the per-center uniqueness fails if two branches already closed the same day or entered a cost for
-- the same source and month; merge or remove those rows first.
DROP TRIGGER trg_enrollments_branch_check ON enrollments;
DROP FUNCTION check_enrollment_branch();
ALTER TABLE lead_source_costs DROP CONSTRAINT lead_source_costs_month_key;
ALTER TABLE lead_source_costs ADD CONSTRAINT lead_source_costs_month_key UNIQUE (org_id, source_id, month);
ALTER TABLE cash_closes DROP CONSTRAINT cash_closes_shift_key;
ALTER TABLE cash_closes ADD CONSTRAINT cash_closes_shift_key UNIQUE (org_id, close_date, shift_no);
