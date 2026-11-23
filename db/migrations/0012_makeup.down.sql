-- 0012_makeup (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lessons WHERE kind = 'makeup') THEN
    RAISE EXCEPTION 'cannot roll back 0012: make-up lessons exist (delete or convert them first)';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM charges WHERE amount = 0) THEN
    RAISE EXCEPTION 'cannot roll back 0012: zero-amount charges exist (fully credit-covered tuition)';
  END IF;
END $$;

DROP TABLE absence_entitlements;
ALTER TABLE charges DROP CONSTRAINT charges_amount_check;
ALTER TABLE charges ADD CONSTRAINT charges_amount_check CHECK (amount > 0);
ALTER TABLE lessons DROP COLUMN kind;
ALTER TABLE org_settings DROP COLUMN makeup_lapses;
ALTER TABLE org_settings DROP COLUMN makeup_expiry_days;
ALTER TABLE org_settings DROP COLUMN excused_mode;
