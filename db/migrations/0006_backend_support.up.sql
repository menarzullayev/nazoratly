-- 0006_backend_support (up)
-- Why: what the API layer needs on top of the domain schema.
--   (1) public_id (UUID) on every entity the API exposes, so no sequential ids appear in URLs.
--   (2) refresh_tokens (rotation + reuse detection) and login_attempts (lockout): auth role only.
--   (3) idempotency_keys: safe retries of POST requests (tenant-isolated).
--   (4) auth-role policies: the login/registration service must see a user's memberships across centers and
--       create a center together with its first owner; it still sees no student/finance data.
-- Queries supported:
--   Q-tok-1  refresh token lookup by hash                      -> refresh_tokens_hash_key
--   Q-tok-2  revoke a whole token family / all of a user       -> refresh_tokens_family / refresh_tokens_user
--   Q-log-1  recent failed logins of an identifier             -> login_attempts_identifier_time
--   Q-idem-1 replay lookup (org, user, key)                    -> idempotency_keys_key

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','memberships','courses','rooms','enrollments','lessons','expenses',
                           'teacher_payrolls','payroll_items','agent_clients','outbox_messages','data_consents'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN public_id UUID NOT NULL DEFAULT gen_random_uuid()', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (public_id)', t, t || '_public_id_key');
  END LOOP;
END $$;

CREATE TABLE refresh_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  family_id   UUID NOT NULL,                       -- one login session; reuse of a rotated token kills the family
  token_hash  BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                         -- set when rotated
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Q-tok-1
CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
-- Q-tok-2
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires ON refresh_tokens (expires_at);

CREATE TABLE login_attempts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identifier  TEXT NOT NULL,                       -- lower-cased email / phone as typed
  ip          TEXT,
  succeeded   BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Q-log-1
CREATE INDEX login_attempts_identifier_time ON login_attempts (identifier, created_at DESC);
CREATE INDEX login_attempts_time ON login_attempts (created_at);

CREATE TABLE idempotency_keys (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key            TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  request_hash   BYTEA NOT NULL,
  status_code    SMALLINT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  CONSTRAINT idempotency_keys_done_pair CHECK ((status_code IS NULL) = (completed_at IS NULL))
);
-- Q-idem-1
CREATE UNIQUE INDEX idempotency_keys_key ON idempotency_keys (org_id, user_id, key);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);
CREATE INDEX idempotency_keys_user ON idempotency_keys (user_id);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());

-- Auth service policies (it never touches students, money or agents).
CREATE POLICY auth_read   ON memberships   FOR SELECT TO nazoratly_auth USING (true);
CREATE POLICY auth_insert ON memberships   FOR INSERT TO nazoratly_auth WITH CHECK (true);
CREATE POLICY auth_update ON memberships   FOR UPDATE TO nazoratly_auth
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY auth_read   ON organizations FOR SELECT TO nazoratly_auth USING (true);
CREATE POLICY auth_insert ON organizations FOR INSERT TO nazoratly_auth WITH CHECK (true);

GRANT SELECT, INSERT ON organizations TO nazoratly_auth;
GRANT SELECT, INSERT, UPDATE ON memberships TO nazoratly_auth;
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO nazoratly_auth;
GRANT SELECT, INSERT ON login_attempts TO nazoratly_auth;
GRANT DELETE ON login_attempts, refresh_tokens TO nazoratly_auth;     -- housekeeping of expired rows
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO nazoratly_app;
