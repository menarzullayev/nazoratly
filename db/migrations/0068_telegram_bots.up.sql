-- 0068_telegram_bots (up)
-- Why: one webhook entry per bot and a dispatcher. (1) The registry of bots: the shared nazoratly bot (org_id NULL) and
--   the bots centers own (at most one live per center). (2) What a person's conversation with a bot looks like: the role and
--   center he chose in the menu, and a counter (epoch) that makes buttons of an earlier choice invalid. A row also means
--   "this person has opened a conversation with this bot", which is what decides which bot may message him. (3) Telegram
--   may deliver an update twice: seen update ids are kept per bot. (4) How a message to a chat is routed.
-- Secrets: the bot token is stored encrypted by the application (column secret_ciphertext: the key is not in the database)
--   and the webhook secret only as its sha256 (token_hash). audit_row() leaves both columns out of the audit log.
-- Branches: a bot belongs to the whole center ('shared' in branch_catalog).
-- Queries the indexes serve:
--   Q-tb-1  the bot behind a webhook address          -> telegram_bots_public_id_key
--   Q-tb-2  the live bot of a center / the shared bot  -> telegram_bots_one_per_org, telegram_bots_one_shared
--   Q-tb-3  is this Telegram bot already connected     -> telegram_bots_one_live_bot
--   Q-tc-1  the conversation of a person with a bot    -> telegram_chats_pkey
--   Q-tc-2  conversations of a Telegram account         -> telegram_chats_user
--   Q-tu-1  old update ids to forget                    -> telegram_updates_received

CREATE TABLE telegram_bots (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id                UUID NOT NULL DEFAULT gen_random_uuid(),
  org_id                   BIGINT REFERENCES organizations(id) ON DELETE RESTRICT,   -- NULL = the shared bot
  bot_user_id              BIGINT NOT NULL CHECK (bot_user_id > 0),
  username                 TEXT NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{3,64}$'),
  secret_ciphertext        BYTEA,                                                     -- the bot token, encrypted
  token_hash               TEXT CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),  -- sha256 of the webhook secret
  method                   TEXT NOT NULL CHECK (method IN ('token','managed')),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  shared_stopped_at        TIMESTAMPTZ,        -- the center stopped the shared bot for its people (center bots only)
  creator_telegram_user_id BIGINT,             -- Managed Bots: the Telegram account that created the bot
  created_by_user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at              TIMESTAMPTZ,
  CONSTRAINT telegram_bots_public_id_key UNIQUE (public_id),
  CONSTRAINT telegram_bots_live_has_secrets CHECK (status = 'disabled' OR (secret_ciphertext IS NOT NULL AND token_hash IS NOT NULL)),
  CONSTRAINT telegram_bots_disabled_forgets CHECK (status <> 'disabled' OR (secret_ciphertext IS NULL AND token_hash IS NULL)),
  CONSTRAINT telegram_bots_stop_center_only CHECK (shared_stopped_at IS NULL OR (org_id IS NOT NULL AND status = 'active')),
  CONSTRAINT telegram_bots_managed_creator CHECK (method <> 'managed' OR creator_telegram_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX telegram_bots_one_per_org ON telegram_bots (org_id) WHERE org_id IS NOT NULL AND status <> 'disabled';
CREATE UNIQUE INDEX telegram_bots_one_shared ON telegram_bots ((TRUE)) WHERE org_id IS NULL AND status <> 'disabled';
CREATE UNIQUE INDEX telegram_bots_one_live_bot ON telegram_bots (bot_user_id) WHERE status <> 'disabled';
CREATE INDEX telegram_bots_org ON telegram_bots (org_id, id DESC);
CREATE TRIGGER trg_telegram_bots_updated_at BEFORE UPDATE ON telegram_bots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_telegram_bots_audit AFTER INSERT OR UPDATE ON telegram_bots
  FOR EACH ROW WHEN (NEW.org_id IS NOT NULL) EXECUTE FUNCTION audit_row();

ALTER TABLE telegram_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_bots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telegram_bots FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY guardian_fence ON telegram_bots AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL) WITH CHECK (app_guardian_id() IS NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_bots TO nazoratly_app;

-- Not tenant rows: a person's Telegram account is the same in every center.
CREATE TABLE telegram_chats (
  bot_id           BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  active_role      TEXT CHECK (active_role IN ('teacher','guardian')),
  active_org_id    BIGINT REFERENCES organizations(id) ON DELETE CASCADE,   -- the chosen center of a teacher
  epoch            INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  unreachable_at   TIMESTAMPTZ,                        -- the bot was refused (blocked): do not send through it
  opened_via       TEXT CHECK (opened_via IN ('direct','code')),
  CONSTRAINT telegram_chats_pkey PRIMARY KEY (bot_id, telegram_user_id),
  CONSTRAINT telegram_chats_teacher_org CHECK ((active_role = 'teacher') = (active_org_id IS NOT NULL) OR active_role IS NULL),
  CONSTRAINT telegram_chats_no_role_no_org CHECK (active_role IS NOT NULL OR active_org_id IS NULL)
);
CREATE INDEX telegram_chats_user ON telegram_chats (telegram_user_id);
CREATE INDEX telegram_chats_org ON telegram_chats (active_org_id) WHERE active_org_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_chats TO nazoratly_app;

CREATE TABLE telegram_updates (
  bot_id      BIGINT NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  update_id   BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, update_id)
);
CREATE INDEX telegram_updates_received ON telegram_updates (received_at);
GRANT SELECT, INSERT, DELETE ON telegram_updates TO nazoratly_app;

-- Lookups that happen before a center is known (a webhook call carries only the bot's public id). --------------------------
CREATE FUNCTION tg_bot_by_public_id(p_public uuid)
RETURNS TABLE (id bigint, public_id uuid, org_id bigint, bot_user_id bigint, username text, secret_ciphertext bytea,
               token_hash text, method text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.id, b.public_id, b.org_id, b.bot_user_id, b.username, b.secret_ciphertext, b.token_hash, b.method
  FROM telegram_bots b LEFT JOIN organizations o ON o.id = b.org_id
  WHERE b.public_id = p_public AND b.status = 'active'
    AND (b.org_id IS NULL OR (o.status = 'active' AND o.deleted_at IS NULL))
$$;

CREATE FUNCTION tg_shared_bot()
RETURNS TABLE (id bigint, public_id uuid, bot_user_id bigint, username text, secret_ciphertext bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.id, b.public_id, b.bot_user_id, b.username, b.secret_ciphertext
  FROM telegram_bots b WHERE b.org_id IS NULL AND b.status = 'active'
$$;

-- Register (or refresh) the shared bot. The same Telegram bot keeps its row, so conversations stay known; a different
-- bot replaces it (the old row is disabled and forgets its secrets).
CREATE FUNCTION tg_shared_register(p_bot_user_id bigint, p_username text, p_cipher bytea, p_secret_hash text)
RETURNS TABLE (out_id bigint, out_public_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM telegram_bots WHERE bot_user_id = p_bot_user_id AND org_id IS NOT NULL AND status <> 'disabled') THEN
    RAISE EXCEPTION 'bot_belongs_to_a_center' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE telegram_bots SET status = 'disabled', secret_ciphertext = NULL, token_hash = NULL, disabled_at = now()
   WHERE org_id IS NULL AND status <> 'disabled' AND bot_user_id <> p_bot_user_id;
  RETURN QUERY
    UPDATE telegram_bots b SET username = p_username, secret_ciphertext = p_cipher, token_hash = p_secret_hash, status = 'active'
     WHERE b.org_id IS NULL AND b.status <> 'disabled' AND b.bot_user_id = p_bot_user_id
    RETURNING b.id, b.public_id;
  IF NOT FOUND THEN
    RETURN QUERY
      INSERT INTO telegram_bots AS b (org_id, bot_user_id, username, secret_ciphertext, token_hash, method, status)
      VALUES (NULL, p_bot_user_id, p_username, p_cipher, p_secret_hash, 'token', 'active')
      RETURNING b.id, b.public_id;
  END IF;
END $$;

-- Live center bots (of every center): what the shared bot needs to say "your center has its own bot" and to leave out
-- the centers that stopped the shared bot.
CREATE FUNCTION tg_center_bots(p_orgs bigint[])
RETURNS TABLE (org_id bigint, org_public_id uuid, org_name text, bot_id bigint, username text, shared_stopped boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.org_id, o.public_id, o.name, b.id, b.username, b.shared_stopped_at IS NOT NULL
  FROM telegram_bots b JOIN organizations o ON o.id = b.org_id
  WHERE b.status = 'active' AND b.org_id = ANY(p_orgs) AND o.status = 'active' AND o.deleted_at IS NULL
$$;

-- Centers that stopped the shared bot: the shared bot sends their people to the center's own bot.
CREATE FUNCTION tg_stopped_centers()
RETURNS TABLE (org_id bigint, username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.org_id, b.username FROM telegram_bots b
  WHERE b.status = 'active' AND b.org_id IS NOT NULL AND b.shared_stopped_at IS NOT NULL
$$;

-- Is this Telegram bot already connected somewhere? (a center must not take over another center's webhook)
CREATE FUNCTION tg_bot_claim(p_bot_user_id bigint)
RETURNS TABLE (id bigint, org_id bigint, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.id, b.org_id, b.status, b.created_at FROM telegram_bots b WHERE b.bot_user_id = p_bot_user_id AND b.status <> 'disabled'
$$;

-- Which bots may message this chat on behalf of this center, best first. The center's own bot only after the person
-- opened it; the shared bot unless the center stopped it. The last row with bot_id NULL stands for "the shared bot of the
-- environment" while it is not registered yet.
CREATE FUNCTION tg_delivery_routes(p_org bigint, p_chat bigint)
RETURNS TABLE (route_order integer, bot_id bigint, secret_ciphertext bytea, is_center boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 1, b.id, b.secret_ciphertext, true
  FROM telegram_bots b JOIN telegram_chats c ON c.bot_id = b.id AND c.telegram_user_id = p_chat AND c.unreachable_at IS NULL
  WHERE b.org_id = p_org AND b.status = 'active'
  UNION ALL
  SELECT 2, s.id, s.secret_ciphertext, false
  FROM (SELECT 1) one
  LEFT JOIN telegram_bots s ON s.org_id IS NULL AND s.status = 'active'
  WHERE NOT EXISTS (SELECT 1 FROM telegram_bots x WHERE x.org_id = p_org AND x.status = 'active' AND x.shared_stopped_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM telegram_chats c WHERE c.bot_id = s.id AND c.telegram_user_id = p_chat AND c.unreachable_at IS NOT NULL)
  ORDER BY 1
$$;

CREATE FUNCTION tg_mark_unreachable(p_bot bigint, p_chat bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO telegram_chats (bot_id, telegram_user_id, unreachable_at)
  SELECT p_bot, p_chat, now() WHERE p_bot IS NOT NULL
  ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET unreachable_at = now()
$$;

REVOKE ALL ON FUNCTION tg_bot_by_public_id(uuid), tg_shared_bot(), tg_shared_register(bigint, text, bytea, text),
  tg_center_bots(bigint[]), tg_stopped_centers(), tg_bot_claim(bigint), tg_delivery_routes(bigint, bigint),
  tg_mark_unreachable(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tg_bot_by_public_id(uuid), tg_shared_bot(), tg_shared_register(bigint, text, bytea, text),
  tg_center_bots(bigint[]), tg_stopped_centers(), tg_bot_claim(bigint), tg_delivery_routes(bigint, bigint),
  tg_mark_unreachable(bigint, bigint) TO nazoratly_app;
GRANT EXECUTE ON FUNCTION tg_delivery_routes(bigint, bigint), tg_mark_unreachable(bigint, bigint), tg_shared_bot()
  TO nazoratly_worker;

DO $$ BEGIN
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES ('telegram_bots', 'shared', NULL, 90);
  END IF;
END $$;
