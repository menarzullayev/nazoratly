-- 0061_guardian_sessions
-- Why: G7 guardian cabinet, sign-in. A guardian is not a staff user: he signs in with
--   (a) the Telegram Mini App: the page sends Telegram's signed initData, the API checks the signature, or
--   (b) the web portal: phone number + a 6-digit code that arrives in his own Telegram chat (10 min, 5 attempts).
--   Either way the result is an opaque session token; only its sha256 is stored (guardian_sessions.token_hash).
--   The token is the only thing a request carries, so the lookup that turns it into (center, guardian) is a SECURITY
--   DEFINER function; everything after it runs in a normal tenant session.
-- Branch: guardian-level rows have no branch of their own (catalog kind 'shared'); what a guardian may see is fenced by
--   his linked students (0064).
-- Queries the indexes serve:
--   Q-gs-1  session by token hash (every cabinet request)    -> guardian_sessions_token_key
--   Q-gs-2  live sessions of a guardian (revoke on unlink)   -> guardian_sessions_guardian
--   Q-gs-3  newest login code of a guardian                   -> guardian_login_codes_guardian

CREATE TABLE guardian_login_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  guardian_id BIGINT NOT NULL,
  code_hash   TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT guardian_login_codes_org_fk      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT guardian_login_codes_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE CASCADE
);
CREATE INDEX guardian_login_codes_guardian ON guardian_login_codes (org_id, guardian_id, id DESC);

CREATE TABLE guardian_sessions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL,
  guardian_id      BIGINT NOT NULL,
  token_hash       TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind             TEXT NOT NULL CHECK (kind IN ('miniapp','portal')),
  telegram_user_id BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  CONSTRAINT guardian_sessions_org_fk      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT guardian_sessions_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE CASCADE,
  CONSTRAINT guardian_sessions_token_key   UNIQUE (token_hash)
);
CREATE INDEX guardian_sessions_guardian ON guardian_sessions (org_id, guardian_id) WHERE revoked_at IS NULL;

CREATE FUNCTION guardian_session_find(p_hash text)
RETURNS TABLE (session_id bigint, org_id bigint, guardian_id bigint, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.org_id, s.guardian_id, s.expires_at, s.revoked_at
  FROM guardian_sessions s JOIN guardians g ON g.org_id = s.org_id AND g.id = s.guardian_id
  WHERE s.token_hash = p_hash AND g.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION guardian_session_find(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardian_session_find(text) TO nazoratly_app;

INSERT INTO branch_catalog (table_name, kind, ord) VALUES
  ('guardian_login_codes', 'shared', 90),
  ('guardian_sessions',    'shared', 90);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guardian_login_codes','guardian_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO nazoratly_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
    -- a guardian session sees only its own guardian's rows
    EXECUTE format($p$CREATE POLICY guardian_fence ON %I AS RESTRICTIVE FOR ALL TO nazoratly_app
      USING (app_guardian_id() IS NULL OR guardian_id = app_guardian_id())
      WITH CHECK (app_guardian_id() IS NULL OR guardian_id = app_guardian_id())$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON guardian_login_codes, guardian_sessions TO nazoratly_app;
