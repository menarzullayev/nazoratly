-- 0030_growth_credits (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM absence_entitlements WHERE source <> 'absence') THEN
    RAISE EXCEPTION 'cannot roll back 0030: referral or promo credits exist';
  END IF;
END $$;
DROP INDEX absence_entitlements_source;
ALTER TABLE absence_entitlements DROP CONSTRAINT absence_entitlements_source_shape;
ALTER TABLE absence_entitlements ALTER COLUMN missed_lesson_id SET NOT NULL;
ALTER TABLE absence_entitlements ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE absence_entitlements ALTER COLUMN enrollment_id SET NOT NULL;
ALTER TABLE absence_entitlements DROP COLUMN note;
ALTER TABLE absence_entitlements DROP COLUMN source;
