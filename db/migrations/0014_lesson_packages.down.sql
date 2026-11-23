-- 0014_lesson_packages (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lesson_packages) THEN
    RAISE EXCEPTION 'cannot roll back 0014: lesson packages exist (void their charges and delete them first)';
  END IF;
  IF EXISTS (SELECT 1 FROM charges WHERE kind = 'package') THEN
    RAISE EXCEPTION 'cannot roll back 0014: package charges exist';
  END IF;
  IF EXISTS (SELECT 1 FROM study_groups WHERE billing_mode = 'package') THEN
    RAISE EXCEPTION 'cannot roll back 0014: package-billed groups exist (switch them to monthly first)';
  END IF;
END $$;

DROP VIEW agent_v_package_consumption;
DROP VIEW agent_v_package_enrollments;
DROP VIEW agent_v_package_packages;
DROP VIEW v_package_consumption;
DROP VIEW v_lesson_packages;
DROP TABLE lesson_packages;
DROP FUNCTION check_lesson_package();
ALTER TABLE charges DROP CONSTRAINT charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('tuition','registration','materials','other'));
ALTER TABLE org_settings DROP COLUMN package_low_lessons;
ALTER TABLE org_settings DROP COLUMN package_expiry_days;
ALTER TABLE study_groups DROP CONSTRAINT study_groups_billing_shape;
ALTER TABLE study_groups DROP COLUMN package_price;
ALTER TABLE study_groups DROP COLUMN package_lessons;
ALTER TABLE study_groups DROP COLUMN billing_mode;
