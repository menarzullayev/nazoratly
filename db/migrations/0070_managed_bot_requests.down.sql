-- 0070_managed_bot_requests (down)
DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    DELETE FROM branch_catalog WHERE table_name = 'telegram_managed_requests';
  END IF;
END $$;

DROP FUNCTION tg_managed_bot(bigint);
DROP FUNCTION tg_managed_claim(bigint);
DROP FUNCTION tg_managed_confirm(text, bigint);
DROP TABLE telegram_managed_requests;
