-- 0069_center_bots (up)
-- Why: centers' own bots. (1) Staged migration: a person who uses the shared bot gets a one-time, short-lived transition
--   code that only the SAME Telegram account can use in the center's bot. Only its sha256 is stored (column token_hash:
--   audit_row() leaves it out). (2) A sign-in that came through a center's own bot is locked to that center: the center
--   holds that bot's token, so what the token signs must never open anything outside the center. The lock travels with
--   the refresh-token family (refresh_tokens.org_lock). (3) A half-made connection of a bot (pending) that was never
--   finished must not block the bot for ever.
-- Branches: center-wide rows ('shared' in branch_catalog).
-- Queries the indexes serve:
--   Q-tm-1  a transition code by its hash               -> telegram_migration_codes_hash_key
--   Q-tm-2  open codes of one person in a center        -> telegram_migration_codes_user

CREATE TABLE telegram_migration_codes (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  telegram_user_id BIGINT NOT NULL,
  token_hash       TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_migration_codes_hash_key UNIQUE (token_hash)
);
CREATE INDEX telegram_migration_codes_user ON telegram_migration_codes (org_id, telegram_user_id) WHERE used_at IS NULL;

ALTER TABLE telegram_migration_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_migration_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telegram_migration_codes FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY guardian_fence ON telegram_migration_codes AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL) WITH CHECK (app_guardian_id() IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_migration_codes TO nazoratly_app;

ALTER TABLE refresh_tokens ADD COLUMN org_lock BIGINT REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX refresh_tokens_org_lock ON refresh_tokens (org_lock) WHERE org_lock IS NOT NULL;

CREATE FUNCTION tg_forget_stale_pending(p_bot_user_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM telegram_bots WHERE bot_user_id = p_bot_user_id AND status = 'pending' AND created_at < now() - interval '2 minutes'
$$;
REVOKE ALL ON FUNCTION tg_forget_stale_pending(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tg_forget_stale_pending(bigint) TO nazoratly_app;

DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES ('telegram_migration_codes', 'shared', NULL, 90);
  END IF;
END $$;
