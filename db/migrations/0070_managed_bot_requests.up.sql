-- 0070_managed_bot_requests (up)
-- Why: Telegram Managed Bots. The shared bot is the manager: it is told when somebody creates a bot it manages. Such a
--   bot belongs to a center ONLY when the center's owner asked for it first: (1) the owner asks through the API and gets a
--   one-time confirmation code (only its sha256 is stored, column token_hash); (2) the owner opens the shared bot with
--   it, which binds the request to that Telegram account; (3) the `managed_bot` update is matched by the creator's
--   account against an open, confirmed request. A bot anybody else creates is connected to nothing.
-- Branches: center-wide rows ('shared' in branch_catalog).
-- Queries the indexes serve:
--   Q-mr-1  confirm by the hash of the code                  -> telegram_managed_requests_hash_key
--   Q-mr-2  the open confirmed request of a Telegram account -> telegram_managed_requests_account
--   Q-mr-3  the newest request of a center                    -> telegram_managed_requests_org

CREATE TABLE telegram_managed_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  public_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  created_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  suggested_username TEXT NOT NULL CHECK (suggested_username ~ '^[A-Za-z0-9_]{5,32}$'),
  telegram_user_id   BIGINT,
  expires_at         TIMESTAMPTZ NOT NULL,
  confirmed_at       TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  failure            TEXT CHECK (failure IS NULL OR length(failure) <= 300),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_managed_requests_hash_key UNIQUE (token_hash),
  CONSTRAINT telegram_managed_requests_public_id_key UNIQUE (public_id),
  CONSTRAINT telegram_managed_requests_bound CHECK ((confirmed_at IS NULL) = (telegram_user_id IS NULL))
);
CREATE INDEX telegram_managed_requests_account ON telegram_managed_requests (telegram_user_id)
  WHERE completed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX telegram_managed_requests_org ON telegram_managed_requests (org_id, id DESC);

ALTER TABLE telegram_managed_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_managed_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telegram_managed_requests FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY guardian_fence ON telegram_managed_requests AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL) WITH CHECK (app_guardian_id() IS NULL);
GRANT SELECT, INSERT, UPDATE ON telegram_managed_requests TO nazoratly_app;

-- The shared bot does not know the center before it has matched a code or a creator. ------------------------------------
-- Bind a request to the Telegram account that opened the code. One account has one open request: older ones are cancelled.
CREATE FUNCTION tg_managed_confirm(p_hash text, p_tg bigint)
RETURNS TABLE (out_org_id bigint, org_name text, suggested_username text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r telegram_managed_requests%ROWTYPE;
BEGIN
  UPDATE telegram_managed_requests q
     SET telegram_user_id = p_tg, confirmed_at = now(), expires_at = now() + interval '30 minutes'
   WHERE q.token_hash = p_hash AND q.confirmed_at IS NULL AND q.completed_at IS NULL AND q.cancelled_at IS NULL
     AND q.expires_at > now()
  RETURNING q.* INTO r;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE telegram_managed_requests q SET cancelled_at = now()
   WHERE q.telegram_user_id = p_tg AND q.id <> r.id AND q.completed_at IS NULL AND q.cancelled_at IS NULL;
  RETURN QUERY SELECT r.org_id, o.name, r.suggested_username FROM organizations o WHERE o.id = r.org_id;
END $$;

-- Take the open, confirmed request of this creator (at most once), if the person who asked is still the center's owner.
CREATE FUNCTION tg_managed_claim(p_tg bigint)
RETURNS TABLE (out_id bigint, out_org_id bigint, out_user_id bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE telegram_managed_requests q SET completed_at = now()
   WHERE q.telegram_user_id = p_tg AND q.confirmed_at IS NOT NULL AND q.completed_at IS NULL AND q.cancelled_at IS NULL
     AND q.expires_at > now()
     AND EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id
                 WHERE m.org_id = q.org_id AND m.user_id = q.created_by_user_id AND m.status = 'active' AND m.role = 'owner'
                   AND o.status = 'active' AND o.deleted_at IS NULL)
  RETURNING q.id, q.org_id, q.created_by_user_id
$$;

-- The live managed bot with this Telegram id (for token rotation and owner changes).
CREATE FUNCTION tg_managed_bot(p_bot_user_id bigint)
RETURNS TABLE (out_org_id bigint, creator_telegram_user_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.org_id, b.creator_telegram_user_id FROM telegram_bots b
  WHERE b.bot_user_id = p_bot_user_id AND b.method = 'managed' AND b.status = 'active' AND b.org_id IS NOT NULL
$$;

REVOKE ALL ON FUNCTION tg_managed_confirm(text, bigint), tg_managed_claim(bigint), tg_managed_bot(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tg_managed_confirm(text, bigint), tg_managed_claim(bigint), tg_managed_bot(bigint) TO nazoratly_app;

DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES ('telegram_managed_requests', 'shared', NULL, 90);
  END IF;
END $$;
