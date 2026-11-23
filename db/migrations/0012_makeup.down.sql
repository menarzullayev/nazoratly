-- 0012_makeup (down)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM lessons WHERE kind = 'makeup') THEN
    RAISE EXCEPTION 'cannot roll back 0012: make-up lessons exist (delete or convert them first)';
  END IF;
END $$;

DROP TABLE absence_entitlements;
ALTER TABLE lessons DROP COLUMN kind;
ALTER TABLE org_settings DROP COLUMN makeup_lapses;
ALTER TABLE org_settings DROP COLUMN makeup_expiry_days;
ALTER TABLE org_settings DROP COLUMN excused_mode;
