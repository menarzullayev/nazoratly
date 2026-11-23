-- 0011_admission_lifecycle (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM enrollments WHERE status = 'trial') THEN
    RAISE EXCEPTION 'cannot roll back 0011: trial enrollments exist (accept or drop them first)';
  END IF;
END $$;

DROP TABLE lead_interactions;
DROP TABLE leads;
DROP TABLE lead_sources;
DROP TABLE org_settings;

DROP INDEX enrollments_trial;
DROP INDEX enrollments_open_pair;
CREATE UNIQUE INDEX enrollments_open_pair ON enrollments (student_id, group_id) WHERE status IN ('active','frozen');
ALTER TABLE enrollments DROP CONSTRAINT enrollments_mode_needs_acceptance;
ALTER TABLE enrollments DROP CONSTRAINT enrollments_trial_not_accepted;
ALTER TABLE enrollments DROP COLUMN dropped_reason;
ALTER TABLE enrollments DROP COLUMN first_month_mode;
ALTER TABLE enrollments DROP COLUMN accepted_on;
ALTER TABLE enrollments DROP CONSTRAINT enrollments_status_check;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_status_check CHECK (status IN ('active','frozen','finished'));
