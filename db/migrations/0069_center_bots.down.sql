-- 0069_center_bots (down)
DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    DELETE FROM branch_catalog WHERE table_name = 'telegram_migration_codes';
  END IF;
END $$;

DROP FUNCTION tg_forget_stale_pending(bigint);
-- sign-ins that were locked to a center cannot exist without the lock: end them
DELETE FROM refresh_tokens WHERE org_lock IS NOT NULL;
ALTER TABLE refresh_tokens DROP COLUMN org_lock;
DROP TABLE telegram_migration_codes;
