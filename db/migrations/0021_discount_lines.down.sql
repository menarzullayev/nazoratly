-- 0021_discount_lines (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM discount_lines) THEN
    RAISE EXCEPTION 'cannot roll back 0021: discount lines exist (they explain how charges were reduced)';
  END IF;
  IF EXISTS (SELECT 1 FROM charges WHERE early_discount > 0 OR gross_amount IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back 0021: charges carry discount data';
  END IF;
END $$;
DROP TABLE discount_lines;
ALTER TABLE charges DROP CONSTRAINT charges_early_granted;
ALTER TABLE charges DROP CONSTRAINT charges_early_pair;
ALTER TABLE charges DROP CONSTRAINT charges_early_source_fk;
ALTER TABLE charges DROP COLUMN early_source_id;
ALTER TABLE charges DROP COLUMN early_granted_at;
ALTER TABLE charges DROP COLUMN early_pay_by;
ALTER TABLE charges DROP COLUMN early_discount;
ALTER TABLE charges DROP COLUMN gross_amount;
