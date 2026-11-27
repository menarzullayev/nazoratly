-- 0068_telegram_bots (down)
DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    DELETE FROM branch_catalog WHERE table_name = 'telegram_bots';
  END IF;
END $$;

DROP FUNCTION tg_mark_unreachable(bigint, bigint);
DROP FUNCTION tg_delivery_routes(bigint, bigint);
DROP FUNCTION tg_bot_claim(bigint);
DROP FUNCTION tg_stopped_centers();
DROP FUNCTION tg_center_bots(bigint[]);
DROP FUNCTION tg_shared_register(bigint, text, bytea, text);
DROP FUNCTION tg_shared_bot();
DROP FUNCTION tg_bot_by_public_id(uuid);
DROP TABLE telegram_updates;
DROP TABLE telegram_chats;
DROP TABLE telegram_bots;
