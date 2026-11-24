-- 0020_discounts (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM student_discounts) THEN
    RAISE EXCEPTION 'cannot roll back 0020: discount rules exist (they decide what students are billed)';
  END IF;
  IF EXISTS (SELECT 1 FROM org_settings WHERE family_discount_2nd_percent <> 0 OR family_discount_3rd_percent <> 0) THEN
    RAISE EXCEPTION 'cannot roll back 0020: a center uses the family discount';
  END IF;
END $$;
DROP TABLE student_discounts;
ALTER TABLE org_settings DROP COLUMN family_discount_3rd_percent;
ALTER TABLE org_settings DROP COLUMN family_discount_2nd_percent;
