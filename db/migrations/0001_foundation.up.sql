-- 0001_foundation (up)
-- Why: tenancy root + identity + RBAC + helpers shared by all later migrations.
--   organizations = an education center (the tenant). users are global (one person may work in several
--   centers); memberships carry the role per center.
-- Queries supported:
--   Q-auth-1  "which centers does this user belong to"           -> memberships_by_user
--   Q-auth-2  "list active staff of a center by role"            -> memberships_org_role
-- Notes: money/ids conventions: BIGINT identity internal ids, UUID public_id for anything user-facing,
--   TIMESTAMPTZ everywhere, soft delete via deleted_at, explicit CHECK enums, composite (org_id, id) uniques so
--   child tables can reference parents WITH the tenant (cross-tenant references become impossible).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Session context helpers. The application sets these per transaction (SET LOCAL app.org_id = '42').
CREATE FUNCTION app_org_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::bigint $$;

CREATE FUNCTION app_user_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::bigint $$;

CREATE FUNCTION app_agent_client_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.agent_client_id', true), '')::bigint $$;

CREATE FUNCTION app_actor_type() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT COALESCE(NULLIF(current_setting('app.actor_type', true), ''),
                      CASE WHEN app_user_id() IS NULL THEN 'system' ELSE 'user' END) $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql
AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE DOMAIN phone_e164 AS text
  CONSTRAINT phone_e164_format CHECK (VALUE ~ '^\+[1-9][0-9]{7,14}$');

CREATE TABLE organizations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  legal_name  TEXT,
  tin         TEXT CHECK (tin ~ '^([0-9]{9}|[0-9]{14})$'),        -- STIR (9) or PINFL (14)
  timezone    TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  currency    CHAR(3) NOT NULL DEFAULT 'UZS' CHECK (currency ~ '^[A-Z]{3}$'),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT organizations_public_id_key UNIQUE (public_id)
);

CREATE TABLE users (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  email            CITEXT,
  phone            phone_e164,
  telegram_user_id BIGINT,
  full_name        TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  password_hash    TEXT,                                  -- readable only by the auth role (column grants in 0005)
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_public_id_key UNIQUE (public_id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_phone_key UNIQUE (phone),
  CONSTRAINT users_telegram_key UNIQUE (telegram_user_id),
  CONSTRAINT users_has_login_identity CHECK (email IS NOT NULL OR phone IS NOT NULL OR telegram_user_id IS NOT NULL)
);

CREATE TABLE branches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  address     TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT branches_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT branches_org_id_key UNIQUE (org_id, id)
);
-- branch name unique among live branches of a center
CREATE UNIQUE INDEX branches_org_name_live ON branches (org_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE memberships (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  user_id     BIGINT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','manager','accountant','teacher','viewer')),
  branch_id   BIGINT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memberships_org_fk    FOREIGN KEY (org_id)  REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT memberships_user_fk   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT memberships_branch_fk FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT memberships_org_user_key UNIQUE (org_id, user_id),
  CONSTRAINT memberships_org_id_key UNIQUE (org_id, id)
);
-- Q-auth-1: centers of a user
CREATE INDEX memberships_by_user ON memberships (user_id);
-- Q-auth-2: staff by role (also covers FK org_id)
CREATE INDEX memberships_org_role ON memberships (org_id, role) WHERE status = 'active';
-- FK lookup branch -> memberships
CREATE INDEX memberships_branch ON memberships (org_id, branch_id) WHERE branch_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','users','branches','memberships'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   'trg_' || t || '_updated_at', t);
  END LOOP;
END $$;
